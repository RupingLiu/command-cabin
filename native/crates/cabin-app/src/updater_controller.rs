//! M5 Task 3：应用侧更新编排的纯逻辑部分（TS
//! `apps/desktop/src/main/updater/updateController.ts` 的状态机 + 决策函数移植）。
//!
//! 与 Slint / 线程 / 进程的粘合留在 main.rs（house style：state.rs 同款分界）：
//! - 状态机 `UpdateOrchestration`（idle → checking → up-to-date | available →
//!   downloading(percent) → downloaded | error；转移函数全纯、只在 UI 线程调用）；
//! - 手动检查冷却 10min / 自动检查间隔 6h（TS `defaultManualCheckCooldownMs` /
//!   `defaultAutomaticCheckIntervalMs` 逐字）；
//! - 安装命令构造（`Setup.exe /S` NSIS 静默；测试不 spawn——只构造不执行）；
//! - 下载目标路径（`%TEMP%\command-cabin-update\CommandCabin-Setup-{version}.exe`）
//!   与进程中途退出遗留 `.tmp` 的启动清扫（Task 1-2 交接项）；
//! - 状态 → 设置 About 状态行 / 启动器横幅的展示决策（TS AboutSettings
//!   `getStatusText` 与 LauncherPage `updateBanner` useMemo 的移植）。
//!
//! 与 TS 的有意差异（均在任务简报/计划授权范围内）：
//! 1. ~~TS 在 `update-available` 事件里立即 `autoUpdater.downloadUpdate()`（自动
//!    下载）；M5 计划要求"发现新版本 → [下载] 按钮"~~ v1.0.1 已消除：用户需求
//!    "自动下载更新包，提示更新"——检查发现新版本即由 main.rs 自动触发
//!    `start_update_download`（对齐 TS electron-updater 默认 autoDownload），
//!    `Available` 回归瞬态；设置页手动 [下载] 按钮保留（重复触发被相位机拒绝）。
//! 2. TS 自动检查失败会 publish `phase=error`（启动器横幅显示"无法连接 GitHub
//!    检查更新"）；M5 计划全局约束"检查失败 = 静默跳过 + 下次自动重试"，自动
//!    失败仅回落 Idle（stderr 诊断），手动失败才直出可读错误。
//! 3. TS 以 `app.isPackaged` 禁用 dev 更新；native 等价判定 `!cfg!(debug_assertions)`
//!    （debug = dev，release = 已安装形态；`COMMAND_CABIN_ENABLE_UPDATES=1` 供
//!    调试逃生），见 main.rs `updates_enabled`。
//! 4. 中途下载无取消（TS electron-updater 亦无取消 API，简报按 M5 最小化确认）。

use std::path::{Path, PathBuf};

use cabin_core::updater::{find_installer_asset, installer_asset_name, ReleaseAsset, UpdateInfo};

use crate::i18n::UpdateUiTexts;

/// TS `defaultAutomaticCheckIntervalMs = 6 * 60 * 60 * 1000`（updateController.ts:62）逐字。
pub const AUTOMATIC_CHECK_INTERVAL_MS: u64 = 6 * 60 * 60 * 1000;
/// TS `defaultManualCheckCooldownMs = 10 * 60 * 1000`（updateController.ts:63）逐字。
pub const MANUAL_CHECK_COOLDOWN_MS: i64 = 10 * 60 * 1000;
/// TS `installUpdate` 的 guard 失败文案（updateController.ts:320）逐字。
pub const INSTALL_NOT_READY_ERROR: &str = "Update is not ready to install.";
/// 下载暂存目录名（挂在 `std::env::temp_dir()` 下；计划 Task 3 约定）。
pub const UPDATE_DOWNLOAD_DIR_NAME: &str = "command-cabin-update";
/// NSIS 静默安装参数（计划 Task 3：`安装包.exe /S`）。
pub const NSIS_SILENT_ARG: &str = "/S";

/// TS `UpdateStatusPhase`（shared/updateApi.ts）的移植。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdatePhase {
    Idle,
    Checking,
    Available,
    Downloading,
    Downloaded,
    UpToDate,
    Error,
    Unavailable,
}

/// TS `UpdateStatus` 的移植子集（activeDownloadVersion/downloadedVersion 合并为
/// `version`：native 一次只有一个在飞版本，TS 的双字段只为 electron-updater 的
/// 异步事件竞态服务）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateStatus {
    pub phase: UpdatePhase,
    /// 当前关注的版本（发现/下载中/已下载/最新已核实的版本）。
    pub version: Option<String>,
    /// 已核实的服务端最新版本（TS `versionKnowledge.latestVersion`）。
    pub latest_version: Option<String>,
    /// 下载进度百分比 0-100（四舍五入；TS percent 为小数、显示时 round）。
    pub percent: Option<u8>,
    pub error: Option<String>,
    /// TS `canCheck`：启用 && 非忙 && 非已就绪待安装。
    pub can_check: bool,
    /// TS `canInstall`：downloaded 且 已下载版本 == 最新版本。
    pub can_install: bool,
}

/// 更新编排状态（TS updateController 闭包变量的结构化）。决策方法全纯、只在
/// UI 线程调用；`pending` 持有最近一次检查的发布清单，供 [下载] 取资产。
#[derive(Debug)]
pub struct UpdateOrchestration {
    pub status: UpdateStatus,
    pending: Option<UpdateInfo>,
    /// TS `lastManualCheckAt`：只在非 bypass 的检查发起时记录。
    last_manual_check_at_ms: Option<i64>,
    updates_enabled: bool,
}

impl UpdateOrchestration {
    /// TS 构造期初值：启用 → idle；禁用 → unavailable + TS 逐字错误
    /// （updateController.ts:114-119）。
    pub fn new(updates_enabled: bool) -> Self {
        let status = if updates_enabled {
            UpdateStatus {
                phase: UpdatePhase::Idle,
                version: None,
                latest_version: None,
                percent: None,
                error: None,
                can_check: true,
                can_install: false,
            }
        } else {
            UpdateStatus {
                phase: UpdatePhase::Unavailable,
                version: None,
                latest_version: None,
                percent: None,
                error: Some(
                    "Automatic updates are available only in installed builds.".to_string(),
                ),
                can_check: false,
                can_install: false,
            }
        };
        Self {
            status,
            pending: None,
            last_manual_check_at_ms: None,
            updates_enabled,
        }
    }

    /// TS `mergeStatus` 尾部的标志位重算（updateController.ts:154-161）。
    fn refresh_flags(&mut self) {
        let status = &mut self.status;
        let busy = matches!(
            status.phase,
            UpdatePhase::Checking | UpdatePhase::Available | UpdatePhase::Downloading
        );
        let ready = status.phase == UpdatePhase::Downloaded
            && status.version.is_some()
            && status.version == status.latest_version;
        status.can_install = ready;
        status.can_check = self.updates_enabled && !busy && !ready;
    }

    /// TS `checkForUpdates` 的准入判定（updateController.ts:264-286）：忙态
    /// （checking / available / downloading / 已就绪待安装）拒绝；`manual=true`
    /// 时施加冷却并在准入后记录时间戳（bypass 的自动检查不记录——TS 逐字）。
    /// 拒绝返回 false 且状态不变（TS 静默返回当前 status）。
    pub fn admit_check(&mut self, manual: bool, now_ms: i64, cooldown_ms: i64) -> bool {
        if !self.updates_enabled {
            return false;
        }
        let phase = self.status.phase;
        if matches!(
            phase,
            UpdatePhase::Checking | UpdatePhase::Available | UpdatePhase::Downloading
        ) || (phase == UpdatePhase::Downloaded && self.status.can_install)
        {
            return false;
        }
        if manual {
            if let Some(last) = self.last_manual_check_at_ms {
                if now_ms.saturating_sub(last) < cooldown_ms {
                    return false;
                }
            }
            self.last_manual_check_at_ms = Some(now_ms);
        }
        self.status.phase = UpdatePhase::Checking;
        self.status.error = None;
        self.status.percent = None;
        self.refresh_flags();
        true
    }

    /// 手动检查准入（带 TS 逐字冷却）。
    pub fn admit_manual_check(&mut self, now_ms: i64) -> bool {
        self.admit_check(true, now_ms, MANUAL_CHECK_COOLDOWN_MS)
    }

    /// 自动检查准入（TS `performCheck` = `checkForUpdates(true)`：bypass 冷却、
    /// 不写时间戳）。
    pub fn admit_automatic_check(&mut self, now_ms: i64) -> bool {
        self.admit_check(false, now_ms, MANUAL_CHECK_COOLDOWN_MS)
    }

    /// TS `update-not-available` → up-to-date（守卫"仍在 checking"——TS
    /// `.then` 回调同款：update-available 事件先行时让位）。
    /// 返回是否发生转移（main 据此决定是否推进后续动作）。
    pub fn finish_check_up_to_date(&mut self, latest_version: Option<&str>) -> bool {
        if self.status.phase != UpdatePhase::Checking {
            return false;
        }
        self.status.phase = UpdatePhase::UpToDate;
        self.status.version = latest_version.map(str::to_string);
        self.status.latest_version = latest_version.map(str::to_string);
        self.refresh_flags();
        true
    }

    /// TS `update-available`：记录版本知识并停在 Available。
    /// v1.0.1 起调用方立即自动触发下载（对齐 TS electron-updater 默认
    /// autoDownload——原"差异 1：不自动下载"已消除，Available 成为瞬态）。
    /// 返回是否转移成功（守卫失败=并发让位，不触发自动下载）。
    pub fn finish_check_available(&mut self, info: UpdateInfo) -> bool {
        if self.status.phase != UpdatePhase::Checking {
            return false;
        }
        self.status.latest_version = Some(info.version.clone());
        self.status.version = Some(info.version.clone());
        self.status.phase = UpdatePhase::Available;
        self.status.error = None;
        self.pending = Some(info);
        self.refresh_flags();
        true
    }

    /// 手动检查失败：可读错误直出（TS `checkForUpdates` catch → phase=error）。
    pub fn finish_check_failed(&mut self, message: String) -> bool {
        if self.status.phase != UpdatePhase::Checking {
            return false;
        }
        self.status.phase = UpdatePhase::Error;
        self.status.error = Some(message);
        self.refresh_flags();
        true
    }

    /// 自动检查失败静默（差异 2）：Checking → Idle，不显示错误（stderr 诊断在
    /// 调用方）。
    pub fn recover_silent_check(&mut self) -> bool {
        if self.status.phase != UpdatePhase::Checking {
            return false;
        }
        self.status.phase = UpdatePhase::Idle;
        self.status.percent = None;
        self.refresh_flags();
        true
    }

    /// [下载]：从 pending 清单取安装包资产并进入 Downloading(0%)。清单缺
    /// `CommandCabin-Setup-{version}.exe` 资产 → Err（可读消息，调用方转
    /// [`Self::fail_download`]；现存 0.9.0 发布即此形态）。
    pub fn begin_download(&mut self) -> Result<ReleaseAsset, String> {
        if self.status.phase != UpdatePhase::Available {
            return Err(INSTALL_NOT_READY_ERROR.to_string());
        }
        let Some(info) = &self.pending else {
            return Err(INSTALL_NOT_READY_ERROR.to_string());
        };
        let Some(asset) = find_installer_asset(info).cloned() else {
            return Err(format!(
                "release {} has no {} asset",
                info.version,
                installer_asset_name(&info.version)
            ));
        };
        self.status.phase = UpdatePhase::Downloading;
        self.status.percent = Some(0);
        self.status.error = None;
        self.refresh_flags();
        Ok(asset)
    }

    /// TS `download-progress` → downloading(percent)。
    pub fn download_progress(&mut self, received_bytes: u64, total_bytes: u64) {
        if self.status.phase != UpdatePhase::Downloading {
            return;
        }
        self.status.percent = Some(download_percent(received_bytes, total_bytes));
    }

    /// TS `update-downloaded`（下载版本恒等于检查到的最新版本 → canInstall）。
    pub fn finish_download(&mut self) {
        if self.status.phase != UpdatePhase::Downloading {
            return;
        }
        self.status.phase = UpdatePhase::Downloaded;
        self.status.percent = None;
        self.refresh_flags();
    }

    /// 下载/校验失败（Task 1-2 的 `PlatformError::UpdateDownload` 消息可读直出）；
    /// 保留版本知识，can_check 恢复 → 可重试（简报：失败 → 可读错误 + 允许重试）。
    pub fn fail_download(&mut self, message: String) {
        if !matches!(
            self.status.phase,
            UpdatePhase::Downloading | UpdatePhase::Available
        ) {
            return;
        }
        self.status.phase = UpdatePhase::Error;
        self.status.error = Some(message);
        self.status.percent = None;
        self.refresh_flags();
    }

    /// TS `installUpdate` 的 guard（updateController.ts:318）。
    pub fn install_ready(&self) -> bool {
        self.status.phase == UpdatePhase::Downloaded && self.status.can_install
    }

    /// 最近一次检查到的发布说明（available 状态行摘要的来源；借用避免整包克隆）。
    pub fn pending_notes(&self) -> Option<&str> {
        self.pending.as_ref().and_then(|info| info.notes.as_deref())
    }

    /// 安装命令构造（纯，不 spawn）：`<temp>/command-cabin-update/
    /// CommandCabin-Setup-{version}.exe` + `/S`。未就绪 → None（调用方以
    /// [`INSTALL_NOT_READY_ERROR`] 提示）。
    pub fn install_command(&self, temp_root: &Path) -> Option<InstallSpawn> {
        if !self.install_ready() {
            return None;
        }
        let version = self.status.version.as_deref()?;
        Some(InstallSpawn {
            program: installer_download_path(temp_root, version),
            args: vec![NSIS_SILENT_ARG.to_string()],
        })
    }

    /// 安装 spawn 失败（安装包文件丢失 / 进程创建失败）：错误直出，回 Error
    /// （重试须重新检查/下载）。
    pub fn install_spawn_failed(&mut self, message: String) {
        if self.status.phase != UpdatePhase::Downloaded {
            return;
        }
        self.status.phase = UpdatePhase::Error;
        self.status.error = Some(message);
        self.refresh_flags();
    }
}

/// 安装 spawn 计划（main.rs 据此 `Command::new(program).args(args).spawn()`；
/// 独立结构使测试不必触及进程 API）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallSpawn {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// 下载百分比：received/total 四舍五入、夹取 0-100（TS `getPercent` 的夹取 +
/// 显示侧 `Math.round` 合并）；total 未知（0）→ 0。
pub fn download_percent(received_bytes: u64, total_bytes: u64) -> u8 {
    if total_bytes == 0 {
        return 0;
    }
    let percent = (received_bytes as u128 * 100 + total_bytes as u128 / 2) / total_bytes as u128;
    percent.min(100) as u8
}

/// 下载暂存目录（`<temp>/command-cabin-update/`）。
pub fn update_download_dir(temp_root: &Path) -> PathBuf {
    temp_root.join(UPDATE_DOWNLOAD_DIR_NAME)
}

/// `%TEMP%\command-cabin-update\CommandCabin-Setup-{version}.exe`（计划 Task 3
/// 约定的下载落点；文件名 = 发布安装包资产名）。
pub fn installer_download_path(temp_root: &Path, version: &str) -> PathBuf {
    update_download_dir(temp_root).join(installer_asset_name(version))
}

/// 下载临时文件名（Task 1-2 写 `<to>.<pid>.<seq>.tmp`，icons/exchange-rate
/// 原子写同款）。
fn is_partial_download(file_name: &str) -> bool {
    file_name.ends_with(".tmp")
}

/// 启动清扫：删除下载目录内遗留的 `.tmp` 半成品（进程中途退出路径，Task 1-2
/// 交接项）。目录不存在 / 不可读 → 0（首装/清理目录皆合法）。
pub fn sweep_stale_partials(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let is_partial = entry.file_name().to_str().is_some_and(is_partial_download);
        if is_partial && entry.path().is_file() && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// 发布说明摘要：取首个非空行、剥 Markdown 标题记号，超长按字符边界截断加 `…`
/// （native 新增展示：available 状态行下的 changelog 摘要）。
pub fn notes_summary(notes: Option<&str>, max_chars: usize) -> Option<String> {
    let first_line = notes?
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?
        .trim_start_matches('#')
        .trim();
    if first_line.is_empty() {
        return None;
    }
    if first_line.chars().count() <= max_chars {
        return Some(first_line.to_string());
    }
    let mut truncated: String = first_line
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect();
    truncated.push('…');
    Some(truncated)
}

/// 启动器横幅展示决策（TS LauncherPage `updateBanner` useMemo 逐语义）：
/// downloading → 纯文本；downloaded+canInstall → 文本 + 安装钮；error →
/// checkFailed 文本 + 详情 + "查看设置"钮；其余（idle/checking/available/
/// up-to-date/unavailable）无横幅。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BannerAction {
    None,
    Install,
    OpenSettings,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BannerView {
    pub text: String,
    pub detail: Option<String>,
    pub action: BannerAction,
}

pub fn banner_view(texts: &UpdateUiTexts, status: &UpdateStatus) -> Option<BannerView> {
    let version = status.version.as_deref().unwrap_or("");
    match status.phase {
        UpdatePhase::Downloading => Some(BannerView {
            text: crate::i18n::format_template(
                texts.banner_downloading,
                &[
                    ("version", version),
                    ("percent", &status.percent.unwrap_or(0).to_string()),
                ],
            ),
            detail: None,
            action: BannerAction::None,
        }),
        UpdatePhase::Downloaded if status.can_install => Some(BannerView {
            text: crate::i18n::format_template(texts.banner_ready, &[("version", version)]),
            detail: None,
            action: BannerAction::Install,
        }),
        UpdatePhase::Error => Some(BannerView {
            text: texts.banner_check_failed.to_string(),
            detail: Some(
                status
                    .error
                    .clone()
                    .unwrap_or_else(|| texts.banner_error.to_string()),
            ),
            action: BannerAction::OpenSettings,
        }),
        _ => None,
    }
}

/// 设置 About 状态行文本（TS AboutSettings `getStatusText` 逐语义；available
/// 追加发布说明摘要行）。`status.error` 优先于通用文案（error/unavailable 同 TS）。
pub fn status_text(texts: &UpdateUiTexts, status: &UpdateStatus, summary: Option<&str>) -> String {
    let version = status.version.as_deref().unwrap_or("");
    match status.phase {
        UpdatePhase::Idle => texts.about_idle.to_string(),
        UpdatePhase::Checking => texts.about_checking.to_string(),
        UpdatePhase::Available => {
            let mut text =
                crate::i18n::format_template(texts.about_available, &[("version", version)]);
            if let Some(summary) = summary {
                text.push('\n');
                text.push_str(summary);
            }
            text
        }
        UpdatePhase::Downloading => crate::i18n::format_template(
            texts.about_downloading,
            &[
                ("version", version),
                ("percent", &status.percent.unwrap_or(0).to_string()),
            ],
        ),
        UpdatePhase::Downloaded => {
            crate::i18n::format_template(texts.about_downloaded, &[("version", version)])
        }
        UpdatePhase::UpToDate => texts.about_up_to_date.to_string(),
        UpdatePhase::Error => status
            .error
            .clone()
            .unwrap_or_else(|| texts.about_error.to_string()),
        UpdatePhase::Unavailable => status
            .error
            .clone()
            .unwrap_or_else(|| texts.about_unavailable.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn orchestration(enabled: bool) -> UpdateOrchestration {
        UpdateOrchestration::new(enabled)
    }

    fn info(version: &str, installer: bool) -> UpdateInfo {
        UpdateInfo {
            version: version.to_string(),
            notes: Some("## What's Changed\n\nFix things.".to_string()),
            assets: if installer {
                vec![ReleaseAsset {
                    name: installer_asset_name(version),
                    url: format!("https://example.test/{version}.exe"),
                    size: 1024,
                }]
            } else {
                Vec::new()
            },
        }
    }

    // ---- 初值 / 禁用形态 ----

    #[test]
    fn disabled_starts_unavailable_and_never_admits() {
        // TS isPackaged=false 初值：unavailable + 逐字错误。
        let mut update = orchestration(false);
        assert_eq!(update.status.phase, UpdatePhase::Unavailable);
        assert_eq!(
            update.status.error.as_deref(),
            Some("Automatic updates are available only in installed builds.")
        );
        assert!(!update.status.can_check);
        assert!(!update.admit_manual_check(1_000));
        assert!(!update.admit_automatic_check(1_000));
    }

    #[test]
    fn enabled_starts_idle_and_admits_checks() {
        let mut update = orchestration(true);
        assert_eq!(update.status.phase, UpdatePhase::Idle);
        assert!(update.status.can_check);
        assert!(!update.status.can_install);
        assert!(update.admit_manual_check(1_000));
        assert_eq!(update.status.phase, UpdatePhase::Checking);
    }

    // ---- 冷却（TS 逐字语义）----

    #[test]
    fn manual_check_within_cooldown_is_blocked_silently() {
        let mut update = orchestration(true);
        assert!(update.admit_manual_check(1_000));
        update.recover_silent_check();
        // 10min 内：拒绝且状态/时间戳不变（TS 静默返回当前 status）。
        assert!(!update.admit_manual_check(1_000 + MANUAL_CHECK_COOLDOWN_MS - 1));
        assert_eq!(update.status.phase, UpdatePhase::Idle);
        // 冷却恰好期满：准入。
        assert!(update.admit_manual_check(1_000 + MANUAL_CHECK_COOLDOWN_MS));
    }

    #[test]
    fn automatic_check_bypasses_cooldown_and_does_not_record_timestamp() {
        let mut update = orchestration(true);
        assert!(update.admit_automatic_check(1_000));
        update.recover_silent_check();
        // bypass：冷却窗口内也准入；且不写 lastManualCheckAt（随后的手动检查
        // 立即准入，证明时间戳未被记录）。
        assert!(update.admit_automatic_check(1_001));
        update.recover_silent_check();
        assert!(update.admit_manual_check(1_002));
    }

    // ---- 检查结果转移 ----

    #[test]
    fn up_to_date_transition_sets_version_and_allows_recheck() {
        let mut update = orchestration(true);
        assert!(update.admit_manual_check(0));
        update.finish_check_up_to_date(Some("1.2.3"));
        assert_eq!(update.status.phase, UpdatePhase::UpToDate);
        assert_eq!(update.status.version.as_deref(), Some("1.2.3"));
        assert_eq!(update.status.latest_version.as_deref(), Some("1.2.3"));
        assert!(update.status.can_check);
    }

    #[test]
    fn late_up_to_date_result_is_ignored_when_not_checking() {
        // TS `.then` 守卫：非 checking 期间的结果让位（update-available 先行）。
        let mut update = orchestration(true);
        update.finish_check_up_to_date(Some("1.0.0"));
        assert_eq!(update.status.phase, UpdatePhase::Idle);
    }

    #[test]
    fn available_transition_parks_pending_info_and_blocks_recheck() {
        let mut update = orchestration(true);
        assert!(update.admit_manual_check(0));
        update.finish_check_available(info("1.2.3", true));
        assert_eq!(update.status.phase, UpdatePhase::Available);
        assert_eq!(update.status.version.as_deref(), Some("1.2.3"));
        assert!(update.pending.is_some());
        // TS isBusy 含 available：冷却期内外的再次检查都被拒。
        assert!(!update.admit_manual_check(MANUAL_CHECK_COOLDOWN_MS * 10));
        assert!(!update.admit_automatic_check(MANUAL_CHECK_COOLDOWN_MS * 10));
    }

    #[test]
    fn manual_failure_surfaces_error_and_allows_retry() {
        let mut update = orchestration(true);
        assert!(update.admit_manual_check(0));
        update.finish_check_failed("update check failed: HTTP 500".to_string());
        assert_eq!(update.status.phase, UpdatePhase::Error);
        assert_eq!(
            update.status.error.as_deref(),
            Some("update check failed: HTTP 500")
        );
        // 错误态可再检查（重试路径）。
        assert!(update.admit_manual_check(MANUAL_CHECK_COOLDOWN_MS));
    }

    #[test]
    fn automatic_failure_recovers_silently_to_idle() {
        let mut update = orchestration(true);
        assert!(update.admit_automatic_check(0));
        update.recover_silent_check();
        assert_eq!(update.status.phase, UpdatePhase::Idle);
        assert!(update.status.error.is_none());
    }

    // ---- 下载 ----

    #[test]
    fn begin_download_returns_installer_asset_and_enters_downloading() {
        let mut update = orchestration(true);
        assert!(update.admit_manual_check(0));
        update.finish_check_available(info("1.2.3", true));
        let asset = update.begin_download().expect("installer asset");
        assert_eq!(asset.name, "CommandCabin-Setup-1.2.3.exe");
        assert_eq!(update.status.phase, UpdatePhase::Downloading);
        assert_eq!(update.status.percent, Some(0));
        assert!(!update.status.can_check);
    }

    #[test]
    fn begin_download_without_installer_asset_fails_readably() {
        // 现存 0.9.0 发布（TS 时代命名）无新约定资产：可读错误。
        let mut update = orchestration(true);
        assert!(update.admit_manual_check(0));
        update.finish_check_available(info("0.9.0", false));
        let error = update.begin_download().unwrap_err();
        assert!(error.contains("CommandCabin-Setup-0.9.0.exe"), "{error}");
        update.fail_download(error);
        assert_eq!(update.status.phase, UpdatePhase::Error);
        assert!(update.status.can_check);
    }

    #[test]
    fn download_progress_tracks_percent_and_finish_sets_can_install() {
        let mut update = orchestration(true);
        assert!(update.admit_manual_check(0));
        update.finish_check_available(info("1.2.3", true));
        update.begin_download().unwrap();
        update.download_progress(50, 200);
        assert_eq!(update.status.percent, Some(25));
        update.download_progress(500, 200);
        assert_eq!(update.status.percent, Some(100));
        update.finish_download();
        assert_eq!(update.status.phase, UpdatePhase::Downloaded);
        assert!(update.status.can_install);
        assert!(!update.status.can_check);
    }

    #[test]
    fn download_failure_keeps_version_and_recovers_can_check() {
        let mut update = orchestration(true);
        assert!(update.admit_manual_check(0));
        update.finish_check_available(info("1.2.3", true));
        update.begin_download().unwrap();
        update.fail_download("update download failed: checksum mismatch".to_string());
        assert_eq!(update.status.phase, UpdatePhase::Error);
        assert_eq!(update.status.version.as_deref(), Some("1.2.3"));
        assert!(update.status.can_check);
        assert!(!update.status.can_install);
    }

    // ---- 安装命令构造（不 spawn）----

    #[test]
    fn install_command_builds_silent_spawn_only_when_ready() {
        let temp = std::env::temp_dir();
        let mut update = orchestration(true);
        assert!(update.install_command(&temp).is_none());

        assert!(update.admit_manual_check(0));
        update.finish_check_available(info("1.2.3", true));
        assert!(update.install_command(&temp).is_none());

        update.begin_download().unwrap();
        assert!(update.install_command(&temp).is_none());

        update.finish_download();
        let plan = update.install_command(&temp).expect("ready to install");
        assert_eq!(
            plan.program,
            temp.join("command-cabin-update")
                .join("CommandCabin-Setup-1.2.3.exe")
        );
        assert_eq!(plan.args, vec!["/S"]);
    }

    #[test]
    fn install_spawn_failure_surfaces_error() {
        let mut update = orchestration(true);
        assert!(update.admit_manual_check(0));
        update.finish_check_available(info("1.2.3", true));
        update.begin_download().unwrap();
        update.finish_download();
        update.install_spawn_failed("installer file is missing".to_string());
        assert_eq!(update.status.phase, UpdatePhase::Error);
        assert_eq!(
            update.status.error.as_deref(),
            Some("installer file is missing")
        );
        assert!(!update.status.can_install);
    }

    // ---- 纯工具函数 ----

    #[test]
    fn download_percent_math() {
        assert_eq!(download_percent(0, 100), 0);
        assert_eq!(download_percent(50, 200), 25);
        assert_eq!(download_percent(1, 3), 33); // 四舍五入
        assert_eq!(download_percent(2, 3), 67);
        assert_eq!(download_percent(100, 100), 100);
        assert_eq!(download_percent(1000, 100), 100); // 夹取
        assert_eq!(download_percent(10, 0), 0); // 总量未知
    }

    #[test]
    fn installer_download_path_layout() {
        let path = installer_download_path(Path::new("/tmp"), "1.0.0");
        assert_eq!(
            path,
            Path::new("/tmp")
                .join("command-cabin-update")
                .join("CommandCabin-Setup-1.0.0.exe")
        );
    }

    #[test]
    fn sweep_removes_only_tmp_partials() {
        let dir = std::env::temp_dir().join(format!(
            "command-cabin-update-sweep-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("CommandCabin-Setup-1.0.0.exe.123.1.tmp"),
            b"partial",
        )
        .unwrap();
        std::fs::write(dir.join("CommandCabin-Setup-1.0.0.exe"), b"done").unwrap();
        std::fs::write(dir.join("keep.sha512"), b"checksum").unwrap();
        assert_eq!(sweep_stale_partials(&dir), 1);
        assert!(dir.join("CommandCabin-Setup-1.0.0.exe").is_file());
        assert!(dir.join("keep.sha512").is_file());
        assert!(!dir.join("CommandCabin-Setup-1.0.0.exe.123.1.tmp").exists());
        // 幂等：目录空 / 不存在均返回 0。
        assert_eq!(sweep_stale_partials(&dir), 0);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(sweep_stale_partials(&dir), 0);
    }

    #[test]
    fn notes_summary_picks_first_non_empty_line_and_truncates() {
        assert_eq!(
            notes_summary(Some("## What's Changed\n\nFix things."), 40).as_deref(),
            Some("What's Changed")
        );
        let long = notes_summary(Some("x".repeat(80).as_str()), 10).unwrap();
        assert_eq!(long.chars().count(), 10);
        assert!(long.ends_with('…'));
        assert_eq!(notes_summary(Some("\n  \n"), 10), None);
        assert_eq!(notes_summary(None, 10), None);
    }

    // ---- 展示决策 ----

    #[test]
    fn banner_appears_only_for_downloading_ready_and_error() {
        let texts = crate::i18n::update_texts(cabin_core::settings::Language::ZhCn);
        let mut update = orchestration(true);
        assert_eq!(banner_view(&texts, &update.status), None);

        update.status.phase = UpdatePhase::Downloading;
        update.status.version = Some("1.2.3".to_string());
        update.status.percent = Some(42);
        let banner = banner_view(&texts, &update.status).unwrap();
        assert_eq!(banner.text, "正在从 GitHub 下载版本 1.2.3 · 42%");
        assert_eq!(banner.action, BannerAction::None);

        update.status.phase = UpdatePhase::Downloaded;
        update.status.can_install = true;
        let banner = banner_view(&texts, &update.status).unwrap();
        assert_eq!(banner.text, "新版本 1.2.3 已下载");
        assert_eq!(banner.action, BannerAction::Install);

        update.status.phase = UpdatePhase::Error;
        update.status.error = Some("update check failed: HTTP 403".to_string());
        update.status.can_install = false;
        let banner = banner_view(&texts, &update.status).unwrap();
        assert_eq!(banner.text, "无法连接 GitHub 检查更新");
        assert_eq!(
            banner.detail.as_deref(),
            Some("update check failed: HTTP 403")
        );
        assert_eq!(banner.action, BannerAction::OpenSettings);

        // downloaded 但 canInstall=false（版本知识不一致的防御路径）→ 无横幅。
        update.status.phase = UpdatePhase::Downloaded;
        update.status.error = None;
        assert_eq!(banner_view(&texts, &update.status), None);
    }

    #[test]
    fn status_text_covers_every_phase_with_templates() {
        let texts = crate::i18n::update_texts(cabin_core::settings::Language::ZhCn);
        let mut status = UpdateStatus {
            phase: UpdatePhase::Idle,
            version: None,
            latest_version: None,
            percent: None,
            error: None,
            can_check: true,
            can_install: false,
        };
        assert_eq!(status_text(&texts, &status, None), texts.about_idle);
        status.phase = UpdatePhase::Checking;
        assert_eq!(status_text(&texts, &status, None), texts.about_checking);
        status.phase = UpdatePhase::Available;
        status.version = Some("1.2.3".to_string());
        assert_eq!(
            status_text(&texts, &status, Some("What's Changed")),
            "发现新版本 1.2.3。\nWhat's Changed"
        );
        status.phase = UpdatePhase::Downloading;
        status.percent = Some(7);
        assert_eq!(
            status_text(&texts, &status, None),
            "正在从 GitHub 下载版本 1.2.3 · 7%"
        );
        status.phase = UpdatePhase::Downloaded;
        assert_eq!(
            status_text(&texts, &status, None),
            "版本 1.2.3 已下载，重启后安装。"
        );
        status.phase = UpdatePhase::UpToDate;
        assert_eq!(status_text(&texts, &status, None), texts.about_up_to_date);
        status.phase = UpdatePhase::Error;
        status.error = Some("boom".to_string());
        assert_eq!(status_text(&texts, &status, None), "boom");
        status.error = None;
        assert_eq!(status_text(&texts, &status, None), texts.about_error);
        status.phase = UpdatePhase::Unavailable;
        assert_eq!(status_text(&texts, &status, None), texts.about_unavailable);
    }
}
