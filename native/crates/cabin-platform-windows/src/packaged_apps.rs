//! MSIX/APPX 打包应用（商店应用）枚举：WinRT
//! `Windows.Management.Deployment.PackageManager.FindPackages()` 进程内直调。
//!
//! 背景（UI 修复 4，Issue A）：TS 时代与 M1-M5 的开始菜单索引只扫描 `.lnk`，
//! 而 MSIX 打包应用（如 1Password 商店版）在开始菜单目录下**没有 .lnk**——
//! `Get-StartApps` 显示其 AUMID（`包族名!应用 Id`），因此对索引完全不可见。
//! 本模块经 PackageManager 枚举当前用户已注册的包，取每个包的
//! `GetAppListEntriesAsync()` 启动项（AUMID + 展示名），交给
//! `cabin_core::indexer::app_commands::commands_from_packaged_apps` 映射成命令
//! （open-app + `shell:AppsFolder\{AUMID}`，TS 语义下打包应用的等价"快捷方式"）。
//!
//! # 过滤与容错
//!
//! - framework / resource / bundle 包不产生启动项，跳过（非失败）。
//! - 单个包的任何错误（属性读取、异步超时、WinRT 失败）记入
//!   [`PackagedAppScanResult::failures`] 后继续，**绝不中断整体枚举**
//!   （对齐 startMenuScanner 的"单条失败不中断"行为）。
//! - AUMID 去重：同一 AUMID 只保留首个条目（防框架包/多版本注册的意外重复）。
//!
//! # WinRT 异步等待策略
//!
//! 复用 ocr.rs 的轮询模式：[`wait_for_operation`] 每 10ms 读一次 `Status()`，
//! `Completed` 时 `GetResults()`，`Error`/`Canceled` 时以底层 HRESULT 报错；
//! 每个异步操作独立 deadline（[`APP_ENTRIES_TIMEOUT_MS`]，本地调用通常毫秒级）。
//! 刻意不引入 windows-future 的 async runtime——调用方（索引扫描线程）是同步线程。
//!
//! # 套间选择
//!
//! 与 ocr.rs 相同：`CoInitializeEx(MTA)`。PackageManager 与 IAsyncOperation 均
//! 为 agile（默认聚合自由线程封送器），从 MTA 线程轮询无需消息泵；线程已按
//! 其他套间初始化时复用现有套间、不做配对反初始化。
//!
//! 与 TS 的差异：TS（Electron 版）从未实现打包应用索引（用户报告的缺口本身）；
//! 本模块是用户指向的范围新增，不存在 TS 参照实现。

use std::time::{Duration, Instant};

use windows::core::RuntimeType;
use windows::ApplicationModel::Package;
use windows::Management::Deployment::PackageManager;
use windows_future::{AsyncStatus, IAsyncOperation};

use cabin_core::indexer::PackagedAppEntry;

/// 单个启动项异步完成的超时（本地 WinRT 调用通常毫秒级；10s 仅作兜底）。
const APP_ENTRIES_TIMEOUT_MS: u64 = 10_000;

/// `Status()` 轮询间隔（与 ocr.rs 一致，CPU 开销可忽略）。
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// 打包应用枚举结果：成功条目 + 单包失败记录（均不中断整体）。
#[derive(Debug, Default, Clone)]
pub struct PackagedAppScanResult {
    pub apps: Vec<PackagedAppEntry>,
    /// 单个包级别的失败描述（诊断用；不影响其余包的枚举）。
    pub failures: Vec<String>,
}

/// 枚举当前用户已注册包的全部启动项。失败策略见模块注释：整体枚举只会在
/// PackageManager 构造 / FindPackages 失败时提前返回（此时 failures 恰有一条
/// 顶层错误），单包错误逐条跳过。
pub fn enumerate_packaged_apps() -> PackagedAppScanResult {
    let mut result = PackagedAppScanResult::default();
    // 每次枚举在当前线程初始化一次 COM 套间（MTA；agile WinRT 对象无需消息泵）。
    let _com = ComApartment::init();
    let manager = match PackageManager::new() {
        Ok(manager) => manager,
        Err(error) => {
            result
                .failures
                .push(format!("PackageManager::new failed: {error}"));
            return result;
        }
    };
    // FindPackages()（无参）枚举**所有用户**的包，需要管理员权限（本机实测
    // 0x80070005 拒绝访问）；FindPackagesByUserSecurityId("") 枚举**当前用户**
    // 已注册包，普通权限即可——索引器只需要当前用户能启动的应用，走后者。
    let packages = match manager.FindPackagesByUserSecurityId(&windows::core::HSTRING::from("")) {
        Ok(packages) => packages,
        Err(error) => {
            result
                .failures
                .push(format!("PackageManager.FindPackages failed: {error}"));
            return result;
        }
    };
    // 已见 AUMID 集合：跨包去重（框架包的重复启动项等意外重复在此收口）。
    let mut seen_aumids = std::collections::HashSet::new();
    for package in packages {
        collect_package_entries(&package, &mut seen_aumids, &mut result);
    }
    result
}

/// 单包处理：过滤 framework/resource/bundle，取启动项并写入 result。
/// 任何错误只记 failures，不上抛、不中断。
fn collect_package_entries(
    package: &Package,
    seen_aumids: &mut std::collections::HashSet<String>,
    result: &mut PackagedAppScanResult,
) {
    // framework（如 VCLibs）/resource（语言包）/bundle（主体包的安装器）不产
    // 生可启动的应用入口；读取失败按失败记录跳过该包。
    let (is_framework, is_resource, is_bundle) = match (
        package.IsFramework(),
        package.IsResourcePackage(),
        package.IsBundle(),
    ) {
        (Ok(f), Ok(r), Ok(b)) => (f, r, b),
        (error, _, _) => {
            result
                .failures
                .push(format!("package flags unreadable, skipped: {error:?}"));
            return;
        }
    };
    if is_framework || is_resource || is_bundle {
        return;
    }
    let package_display_name = package
        .DisplayName()
        .ok()
        .map(|name| name.to_string())
        .filter(|name| !name.trim().is_empty());
    let operation = match package.GetAppListEntriesAsync() {
        Ok(operation) => operation,
        Err(error) => {
            result
                .failures
                .push(format!("GetAppListEntriesAsync failed, skipped: {error}"));
            return;
        }
    };
    let deadline = Instant::now() + Duration::from_millis(APP_ENTRIES_TIMEOUT_MS);
    let entries = match wait_for_operation(&operation, deadline, "Package.GetAppListEntriesAsync") {
        Ok(entries) => entries,
        Err(error) => {
            result.failures.push(format!("{error} (skipped)"));
            return;
        }
    };
    for entry in &entries {
        let Ok(aumid) = entry.AppUserModelId() else {
            continue;
        };
        let aumid = aumid.to_string();
        if aumid.trim().is_empty() || !seen_aumids.insert(aumid.clone()) {
            continue;
        }
        let display_name = resolve_display_name(
            entry
                .DisplayInfo()
                .ok()
                .and_then(|info| info.DisplayName().ok())
                .map(|name| name.to_string())
                .as_deref(),
            package_display_name.as_deref(),
            &aumid,
        );
        result.apps.push(PackagedAppEntry {
            display_name,
            app_user_model_id: aumid,
        });
    }
}

/// 展示名回退链：AppListEntry DisplayInfo.DisplayName → 包 DisplayName → AUMID。
/// 各级 trim 后非空才采用；与 Command 层的空名兜底互补（此处保证结果总是非空）。
fn resolve_display_name(
    entry_display: Option<&str>,
    package_display: Option<&str>,
    aumid: &str,
) -> String {
    [entry_display, package_display]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|name| !name.is_empty())
        .map_or_else(|| aumid.to_string(), str::to_string)
}

/// 轮询等待 `IAsyncOperation` 完成（等待策略与错误语义见模块注释；与 ocr.rs
/// 的同名函数同构，crate 内各自私有）。
fn wait_for_operation<T>(
    operation: &IAsyncOperation<T>,
    deadline: Instant,
    context: &str,
) -> Result<T, String>
where
    T: RuntimeType + 'static,
{
    loop {
        let status = operation
            .Status()
            .map_err(|error| format!("{context}::Status failed: {error}"))?;
        if status == AsyncStatus::Completed {
            return operation
                .GetResults()
                .map_err(|error| format!("{context} failed: {error}"));
        }
        if status == AsyncStatus::Error || status == AsyncStatus::Canceled {
            // Error/Canceled 时 GetResults 返回底层 HRESULT 失败。
            return operation
                .GetResults()
                .map_err(|error| format!("{context} failed: {error}"));
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "{context} timed out after {APP_ENTRIES_TIMEOUT_MS} ms"
            ));
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// COM 套间守卫（MTA）。与 ocr.rs 的同名守卫一致：`RPC_E_CHANGED_MODE`（线程已
/// 按其他套间初始化）时复用现有套间、返回 None 且不做配对反初始化。
struct ComApartment;

impl ComApartment {
    fn init() -> Option<Self> {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        // SAFETY: COM 多线程套间初始化；S_OK/S_FALSE 均为 is_ok()，成功时
        // 需在 Drop 中配对 CoUninitialize。
        if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok() {
            Some(Self)
        } else {
            None
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        use windows::Win32::System::Com::CoUninitialize;
        // SAFETY: 与 init 中成功的 CoInitializeEx 配对。
        unsafe { CoUninitialize() };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- 纯逻辑：展示名回退链 ----

    #[test]
    fn display_name_prefers_entry_then_package_then_aumid() {
        assert_eq!(
            resolve_display_name(Some("Entry"), Some("Package"), "a!id"),
            "Entry"
        );
        // AppListEntry 展示名缺失/空白时回退包名。
        assert_eq!(
            resolve_display_name(None, Some("Package"), "a!id"),
            "Package"
        );
        assert_eq!(
            resolve_display_name(Some("   "), Some("Package"), "a!id"),
            "Package"
        );
        // 两级都缺失时回退 AUMID（结果恒非空）。
        assert_eq!(resolve_display_name(None, None, "a!id"), "a!id");
        assert_eq!(resolve_display_name(Some(""), Some("  "), "a!id"), "a!id");
    }

    // ---- 真机枚举（本机已验证：1Password 商店版为 MSIX 打包应用，仅在
    // Windows.Management.Deployment 可见，开始菜单无 .lnk）。只读枚举，
    // 不启动任何应用。 ----

    /// 本机已安装 1Password（MSIX）的包族名前缀（Get-StartApps 实证：
    /// `DC5C6510.2032887045529_2v019pwa6amcg!Agilebits.OnePassword`）。
    const ONEPASSWORD_FAMILY_PREFIX: &str = "dc5c6510";

    #[test]
    fn enumerates_real_packages_and_finds_packaged_onepassword() {
        let result = enumerate_packaged_apps();
        assert!(
            !result.apps.is_empty(),
            "expected registered packages on a real machine; failures: {:?}",
            result.failures
        );
        let onepassword = result.apps.iter().find(|app| {
            app.app_user_model_id
                .to_lowercase()
                .starts_with(ONEPASSWORD_FAMILY_PREFIX)
        });
        let onepassword = onepassword.expect(
            "1Password (MSIX) is installed on this machine and must be enumerated; \
             if it was uninstalled, update this machine-specific assertion",
        );
        assert!(onepassword.app_user_model_id.contains('!'));
        assert!(onepassword
            .app_user_model_id
            .to_lowercase()
            .ends_with("!agilebits.onepassword"));
        // 展示名回退链保证非空。
        assert!(!onepassword.display_name.trim().is_empty());
    }

    #[test]
    fn enumerated_aumids_are_unique() {
        let result = enumerate_packaged_apps();
        let mut seen = std::collections::HashSet::new();
        for app in &result.apps {
            assert!(seen.insert(app.app_user_model_id.clone()));
        }
    }
}
