//! cabin-app：Slint 启动器接线（M2 Task 9：DB + 设置 + 历史 + 自启动 + 热键重注册 + 图标）。
//!
//! 启动序列（任务简报 1）：单实例守卫 → `%APPDATA%\CommandCabin\`（缺则创建）→
//! 打开 `command-cabin.sqlite` → `run_migrations` → 读设置（失败=数据损坏，走统一
//! 错误通道并以非零码退出）→ 按设置热键注册全局热键（失败=退出并诊断）→
//! `is_login_startup(args)` 决定是否呼出窗口 → `WindowsAutostart::set_enabled`
//! 与设置同步（对齐 TS index.ts:300 启动同步）→ 托盘菜单文案按语言。
//!
//! 线程亲和约定（T8 评审硬性要求，M1 延续）：WindowsTray / WindowsHotkeys 均在
//! main 线程（Slint UI 线程）构造并析构；跨线程交互一律经
//! `slint::invoke_from_event_loop` 回到 UI 线程。应用状态（搜索引擎、命令表、
//! SQLite 连接、设置）只在事件循环闭包内加锁访问；图标提取与缓存落盘分别在
//! 专职工作线程上执行，通过锁共享 `IconDiskCache`。

// 发布形态为窗口应用：从资源管理器/Start-Process 启动时不附带控制台窗口。
#![windows_subsystem = "windows"]

mod controller;
mod i18n;
mod screenshot_controller;
mod state;
mod updater_controller;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use cabin_core::command::executor::{CommandExecutionResult, CommandExecutor};
use cabin_core::command::types::{Command, CommandActionType};
use cabin_core::favorites::commands_from_favorites;
use cabin_core::favorites::is_launcher_pinned_app;
use cabin_core::features::calculator::CALCULATOR_RESULT_COMMAND_ID;
use cabin_core::features::clipboard_history::create_clipboard_history_commands;
use cabin_core::features::clipboard_history::watcher::{
    poll_step, PollState, DEFAULT_CLIPBOARD_WATCH_INTERVAL_MS,
};
use cabin_core::features::clipboard_history::ClipboardHistoryEntry;
use cabin_core::features::exchange_rate::ExchangeRateCache;
use cabin_core::features::quick_converter::QUICK_CONVERTER_RESULT_COMMAND_ID;
use cabin_core::features::text_tools::{
    apply_text_transform, create_text_tool_commands, get_text_tool_transform_kind,
    TEXT_TOOLS_PLUGIN_ID,
};
use cabin_core::home::is_app_command;
use cabin_core::icons::{
    data_url_to_bytes, png_bytes_to_data_url, result_icon_cache_key, BoundedMemorySet,
    IconDiskCache, MEMORY_CACHE_MAX_ENTRIES,
};
use cabin_core::indexer::app_commands::{
    commands_from_packaged_apps, commands_from_shortcuts, merge_app_commands,
};
use cabin_core::search::engine::{SearchEngine, SearchOptions};
use cabin_core::settings::{Settings, Theme};
use cabin_platform::traits::{
    AppIndexer, AutostartManager, ClipboardReader, GlobalHotkeyProvider, ImageClipboard, Launcher,
    SingleInstance, TrayEvent, TrayProvider, UpdateService,
};
use cabin_platform::{is_login_startup, parse_accelerator};
use cabin_platform_windows::autostart::WindowsAutostart;
use cabin_platform_windows::clipboard::{ArboardClipboard, ArboardClipboardReader};
use cabin_platform_windows::exchange_rate::fetch_frankfurter_body;
use cabin_platform_windows::hotkey::WindowsHotkeys;
use cabin_platform_windows::icons::extract_icon_png;
use cabin_platform_windows::indexer::WindowsStartMenuIndexer;
use cabin_platform_windows::launcher::WindowsLauncher;
use cabin_platform_windows::packaged_apps::enumerate_packaged_apps;
use cabin_platform_windows::single_instance::WindowsSingleInstance;
use cabin_platform_windows::tray::WindowsTray;
use cabin_platform_windows::updater::GitHubUpdateService;
use cabin_storage::clipboard::{ClipboardHistoryRepository, MAX_CLIPBOARD_HISTORY_LIMIT};
use cabin_storage::favorites::FavoritesRepository;
use cabin_storage::history::{HistoryRepository, RecordExecution};
use cabin_storage::migrations::run_migrations;
use cabin_storage::settings::SettingsRepository;
use screenshot_controller::{
    screenshot_mode_for_system_command, screenshot_system_commands, ScreenshotController,
    ScreenshotMode,
};
use slint::winit_030::WinitWindowAccessor;
use slint::{ComponentHandle, Model, ModelRc, SharedString, VecModel};

// 多文件注意：`slint::include_modules!()` 的 env 展开只保留最后一次 compile()
// 的生成文件（SLINT_INCLUDE_GENERATED 覆盖式写入），故两个窗口文件分别 include
// 到独立子模块再按需引用（vendored slint-build lib.rs 确认）。
mod ui_launcher {
    include!(concat!(env!("OUT_DIR"), "/launcher.rs"));
}
mod ui_settings {
    include!(concat!(env!("OUT_DIR"), "/settings.rs"));
}
mod ui_screenshot {
    include!(concat!(env!("OUT_DIR"), "/screenshot.rs"));
}
mod ui_pin {
    include!(concat!(env!("OUT_DIR"), "/pin-window.rs"));
}
mod ui_translate {
    include!(concat!(env!("OUT_DIR"), "/translate-window.rs"));
}
use ui_launcher::{LauncherWindow, PinnedTile, ResultItem};
use ui_screenshot::{ScreenshotTexts, ScreenshotWindow};
use ui_settings::{FavoriteRowView, SettingsTexts, SettingsWindow};

const APP_DATA_DIR_NAME: &str = "CommandCabin";
const DATABASE_FILE_NAME: &str = "command-cabin.sqlite";
const ICON_CACHE_FILE_NAME: &str = "app-icons.json";
/// TS exchangeRateCache 的缓存文件名（join(userDataPath, 'exchange-rates.json')，
/// M4 Task 6 移植时的路径契约，Task 7 接线）。
const EXCHANGE_RATE_CACHE_FILE_NAME: &str = "exchange-rates.json";
/// TS `createRankingContext` / `listRecentAppSearchResults` 的历史窗口。
const HISTORY_RANKING_LIMIT: u32 = 100;
/// 图标提取尺寸（设备像素，UI 修复 4：32 → 96）。显示端为 48 逻辑 px（首页磁贴
/// 图标）/ 32 逻辑 px（结果行图标），用户屏 ~150% DPI 下 48 逻辑 px = 72、200% 下
/// = 96 设备像素——旧值 32px 的源在 150%+ DPI 下被放大 1.5–3 倍，直接导致图标
/// 发糊（用户报告）。`GetImage(SIIGBF_BIGGERSIZEOK)` 请求 96px 时 shell 允许返回
/// 更大的原生位图，渲染端缩小显示（downscale 保锐利）。M2 评审曾指出旧注释
/// "48px 行高的 2x 余量 = 32px" 算术不成立，此处一并更正。内存注意：96px PNG
/// 源约为 32px 的 9 倍，磁盘缓存条目上限（ICON_CACHE_MAX_ENTRIES = 256）约束
/// 总体积，可接受。
const ICON_EXTRACT_SIZE_PX: u32 = 96;
/// hideOnBlur 轮询间隔（winit `has_focus`；Slint Window 无失焦回调）。
const HIDE_ON_BLUR_POLL_MS: u64 = 200;
/// 首页固定磁贴网格列数（UI 修复 1：每行 5 个、至多 2 行；上限见
/// `state::HOME_TILE_LIMIT`。与 UI 修复 2 的键盘导航决策表共用
/// `state::HOME_TILE_COLUMNS`，保证切行模型与导航列语义一致）。
const HOME_TILE_COLUMNS: usize = state::HOME_TILE_COLUMNS;
/// flush 调度线程无信号时的最大阻塞等待（任意长即可，信号到达即醒）。
const FLUSH_SCHEDULER_MAX_IDLE: Duration = Duration::from_secs(3600);

/// 统一错误通道：M2 无 GUI 错误面板，启动期数据损坏 / 热键注册失败经 stderr
/// 输出诊断并以非零码退出（`windows_subsystem=windows` 下无控制台时 stderr 丢弃，
/// 退出码仍可见；GUI 错误通道随设置 UI 任务补齐——启动期出口仅此一处）。
fn fatal(message: &str) -> ! {
    eprintln!("CommandCabin: {message}");
    append_diag_log(&format!("fatal: {message}"));
    std::process::exit(1);
}

// ---------------------------------------------------------------------------
// 极简文件日志（M5 收口项：windows_subsystem 吞掉 stderr 后的诊断出口）
//
// 裁决：引入"错误级文件日志"——只记录 panic 与 fatal 退出两条路径，普通运行
// 日志不落盘。文件 `%APPDATA%\CommandCabin\logs\command-cabin.log`，超过
// [`DIAG_LOG_MAX_BYTES`] 轮转为 `.old`（保留一代）。所有 IO 失败静默忽略
// （日志永不致崩）；路径未解析前（app_dir 之前）的 fatal 仅走 stderr。
// ---------------------------------------------------------------------------

/// 诊断日志单文件上限（超过即轮转为 `.old`，保留一代）。
const DIAG_LOG_MAX_BYTES: u64 = 1024 * 1024;

static DIAG_LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// app_dir 解析成功后立即调用；此后 fatal / panic 才有落盘目的地。
fn enable_diag_log(app_dir: &std::path::Path) {
    let _ = DIAG_LOG_PATH.set(app_dir.join("logs").join("command-cabin.log"));
}

/// 追加一条诊断记录（时间戳前缀）。先按大小轮转；任何 IO 失败静默忽略。
fn append_diag_log(message: &str) {
    let Some(path) = DIAG_LOG_PATH.get() else {
        return;
    };
    if rotate_log_if_needed(path, DIAG_LOG_MAX_BYTES).is_err() {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let stamped = format!("{} CommandCabin: {message}\n", chrono_like_iso_now());
    use std::io::Write as _;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = file.write_all(stamped.as_bytes());
    }
}

/// 尺寸超限即把当前日志改名 `.old`（先删旧 `.old`）。旋转失败不阻断追加。
fn rotate_log_if_needed(path: &std::path::Path, max_bytes: u64) -> std::io::Result<()> {
    let size = match std::fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        // 不存在 = 无需轮转。
        Err(_) => return Ok(()),
    };
    if size <= max_bytes {
        return Ok(());
    }
    let mut old = path.to_path_buf();
    old.as_mut_os_string().push(".old");
    let _ = std::fs::remove_file(&old);
    std::fs::rename(path, &old)
}

/// 秒级 ISO 8601 UTC（诊断时间戳用；仓储已有毫秒级 `iso_now`，此处避免跨
/// crate 依赖只取秒级）。
fn chrono_like_iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs()) as i64;
    // civil_from_days（Howard Hinnant 算法）：unix 天 → (y, m, d)。
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let (hh, mm, ss) = (
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
    );
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// panic 钩子：默认 stderr 行为照旧（dev/debug 可见），release 侧补一条文件
/// 记录（windows_subsystem 下 stderr 不可见，这是 M5 收口前唯一的诊断出口）。
fn install_panic_logger() {
    let original = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        append_diag_log(&format!("panic: {info}"));
        original(info);
    }));
}

fn unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as i64)
}

/// `%APPDATA%\CommandCabin\`，不存在则创建。
fn app_data_dir() -> Result<PathBuf, String> {
    let base = std::env::var("APPDATA")
        .map_err(|_| "APPDATA environment variable is not set".to_string())?;
    let dir = PathBuf::from(base).join(APP_DATA_DIR_NAME);
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create {}: {error}", dir.display()))?;
    Ok(dir)
}

fn open_database(app_dir: &std::path::Path) -> Result<rusqlite::Connection, String> {
    let path = app_dir.join(DATABASE_FILE_NAME);
    rusqlite::Connection::open(&path)
        .map_err(|error| format!("could not open {}: {error}", path.display()))
}

/// UI 线程独占的应用状态。Mutex 只为跨闭包共享；所有锁都在事件循环闭包内获取
/// （M1 约定）。`Connection` 非 Sync，由 Mutex 保证跨线程共享安全。
struct AppState {
    settings: Settings,
    engine: SearchEngine,
    commands_by_id: HashMap<String, Command>,
    app_command_ids: HashSet<String>,
    /// 收藏中的 app 命令（pinned），保持收藏列表顺序（TS `favoriteCommandIds`）。
    pinned_app_commands: Vec<Command>,
    /// 固定应用收藏的命令 id（含 URL/file 收藏导出的 app 之外的集合 —— 只收
    /// pinned app 命令 id）与固定快捷方式路径身份键（大小写/斜杠归一），
    /// 供结果行"已固定"判定（索引命令与收藏命令 id 不同）。
    pinned_app_command_ids: HashSet<String>,
    pinned_shortcut_keys: HashSet<String>,
    /// 汇率缓存（M4 Task 7 接线，Task 6 移植）：查询管线只做非阻塞 peek；
    /// 后台取数经 [`ensure_rate_fetch`] 的 worker 完成、ingest 回 UI 线程。
    rate_cache: ExchangeRateCache,
    /// 汇率后台取数在飞标记（TS refreshRate 的 refreshInFlight 去重等价）。
    rate_fetch_in_flight: bool,
    /// 剪贴板历史命令 id（TS clipboardHistoryCommandIds，整组替换维护）。
    clipboard_command_ids: HashSet<String>,
    /// 剪贴板命令表脏标记（TS clipboardHistoryVersion 相等比较的等价实现；
    /// watcher 落库 / 启动置位，装载后复位）。
    clipboard_commands_dirty: bool,
    /// 剪贴板轮询状态（watcher.rs 契约：决策在 poll_step，定时器所有权在本层，
    /// UI 线程专属）。
    clipboard_poll_state: PollState,
    /// 剪贴板读取连续失败标记（轮询日志只在错误状态翻转沿打印——首次失败、
    /// 首次恢复——避免读取持续失败时每 1s 刷屏）。
    clipboard_read_failed: bool,
    /// 更新编排（M5 Task 3）：TS updateController 的 status + versionKnowledge
    /// 结构化。决策全在 updater_controller 纯函数；本字段只在 UI 线程（事件
    /// 循环闭包 / invoke_from_event_loop 回灌）读写，Mutex 仅为跨闭包共享。
    update: updater_controller::UpdateOrchestration,
    /// 首页磁贴键盘选中（UI 修复 2）：网格下标；None = 无选中（搜索态/空网格）。
    /// 与 Slint `selected-tile` 属性同步（Rust push），只在 UI 线程读写。
    selected_tile: Option<usize>,
    conn: rusqlite::Connection,
}

impl AppState {
    fn rebuild_engine(&mut self) {
        let commands: Vec<Command> = self.commands_by_id.values().cloned().collect();
        self.engine.update(commands);
    }

    fn history_rows(&self) -> state::HistoryRows {
        HistoryRepository::new(&self.conn)
            .list_recent_for_ranking(HISTORY_RANKING_LIMIT)
            .unwrap_or_default()
    }

    /// 收藏 → 命令装载/重载（启动与固定/取消固定后）：以收藏为准整体替换
    /// `favorite.*` 命令与 pinned 集合。失败返回错误（调用方决定启动降级或
    /// 提交错误提示），状态不变。
    fn reload_favorites(&mut self) -> Result<(), String> {
        let favorites = FavoritesRepository::new(&self.conn)
            .list()
            .map_err(|error| error.to_string())?;
        let commands = commands_from_favorites(&favorites);
        self.commands_by_id
            .retain(|command_id, _| !state::is_favorite_command_id(command_id));
        let mut pinned_app_commands = Vec::new();
        let mut pinned_app_command_ids = HashSet::new();
        for command in commands {
            if is_app_command(&command) {
                pinned_app_command_ids.insert(command.id.clone());
                pinned_app_commands.push(command.clone());
            }
            self.commands_by_id.insert(command.id.clone(), command);
        }
        self.pinned_app_commands = pinned_app_commands;
        self.pinned_app_command_ids = pinned_app_command_ids;
        self.pinned_shortcut_keys = favorites
            .iter()
            .filter(|favorite| is_launcher_pinned_app(favorite))
            .filter_map(|favorite| favorite.path.as_deref())
            .map(state::shortcut_identity_key)
            .collect();
        self.rebuild_engine();
        Ok(())
    }

    /// 空查询首页的两个分组（recent / pinned，各自含分组内的截断与去重语义；
    /// 与 `search_results` 的合并输出同源，见 `state::home_sections`）。
    fn home_rows(&self) -> (Vec<Command>, Vec<Command>) {
        let lookup = |command_id: &str| self.commands_by_id.get(command_id).cloned();
        state::home_sections(&self.history_rows(), &lookup, &self.pinned_app_commands)
    }

    /// 查询解析：空查询走首页合成（recent + pinned，简报 4），否则走 M4 Task 7
    /// 的完整管线——剪贴板命令脏重载 → 动态即时命令槽（calculator →
    /// quick-converter，TS refreshCalculatorCommand / refreshQuickConverterCommand）
    /// → 引擎一次合并搜索（TS 合并语义：动态命令经 upsert 进同一引擎、与静态
    /// 池按同一评分公式排序，无独立置顶）→ 剪贴板历史降级
    /// （TS demoteClipboardHistorySearchResults）。返回（结果命令, 是否需要
    /// 后台汇率取数）。
    fn query_results(&mut self, query: &str) -> (Vec<Command>, bool) {
        if query.trim().is_empty() {
            // TS 空查询：直接返回首页 app 合成（不注入剪贴板历史、不生成动态命令
            // ——TS searchCommands 空查询提前 return listHomeAppSearchResults）。
            let (recent, pinned) = self.home_rows();
            let commands: Vec<Command> = recent.into_iter().chain(pinned).collect();
            return (commands, false);
        }

        // TS refreshClipboardHistoryCommands 的每查询调用（version 相等跳过 →
        // 脏标记跳过）。
        if self.clipboard_commands_dirty {
            self.reload_clipboard_commands();
        }

        // 非阻塞 peek：新鲜/过期缓存都立即出命令（过期 subtitle 标"缓存汇率"），
        // 过期或无缓存 → needs_rate_refresh，由调用方后台取数后重跑查询
        // （TS 立即返回旧缓存 + `void refreshRate()` 的异步化）。
        let peek = self.rate_cache.peek_usd_to_cny_rate();
        let plan = state::dynamic_slot_plan(query, peek);
        match plan.calculator {
            Some(command) => self.upsert_dynamic(command),
            None => {
                self.commands_by_id.remove(CALCULATOR_RESULT_COMMAND_ID);
                self.engine.remove(CALCULATOR_RESULT_COMMAND_ID);
            }
        }
        match plan.converter {
            Some(command) => self.upsert_dynamic(command),
            None => {
                self.commands_by_id
                    .remove(QUICK_CONVERTER_RESULT_COMMAND_ID);
                self.engine.remove(QUICK_CONVERTER_RESULT_COMMAND_ID);
            }
        }

        let now_ms = unix_millis();
        let context =
            state::build_ranking_context(&self.history_rows(), &self.settings.search, now_ms);
        let results = self
            .engine
            .search(
                query,
                SearchOptions {
                    // TS：非剪贴板查询以 limit + 200 扩容搜索（显式剪贴板查询按
                    // limit），降级后再截断（state::demote_…）。
                    limit: Some(state::engine_search_limit(
                        query,
                        self.settings.search.max_results,
                    )),
                    include_all_on_empty_query: Some(false),
                    ranking: Some(&context),
                },
            )
            .into_iter()
            .map(|item| item.command)
            .collect();
        let limit = state::search_limit(self.settings.search.max_results);
        (
            state::demote_clipboard_history_results(query, results, limit),
            plan.needs_rate_refresh,
        )
    }

    /// TS 动态命令的 registry.register + searchEngine.upsert 同步对（保留 id
    /// 固定：calculator.result / quick-converter.result，每次查询覆盖）。
    fn upsert_dynamic(&mut self, command: Command) {
        self.commands_by_id
            .insert(command.id.clone(), command.clone());
        self.engine.upsert(command);
    }

    /// TS refreshClipboardHistoryCommands：仓储最近 200 条 → 剪贴板命令整组
    /// 替换 → 全量重建（TS flushSearchIndex 同语义；动态/收藏/索引命令保留在
    /// commands_by_id，重建后不丢）。读失败保留脏标记，下次查询重试。
    fn reload_clipboard_commands(&mut self) {
        let entries = match ClipboardHistoryRepository::new(&self.conn)
            .list_recent(MAX_CLIPBOARD_HISTORY_LIMIT)
        {
            Ok(entries) => entries,
            Err(error) => {
                eprintln!("CommandCabin: clipboard history is unreadable: {error}");
                return;
            }
        };
        for command_id in &self.clipboard_command_ids {
            self.commands_by_id.remove(command_id);
        }
        self.clipboard_command_ids.clear();
        let entries = entries
            .into_iter()
            .map(|entry| ClipboardHistoryEntry {
                id: entry.id,
                text: entry.text,
                copied_at: entry.copied_at,
            })
            .collect::<Vec<_>>();
        for command in create_clipboard_history_commands(&entries) {
            self.clipboard_command_ids.insert(command.id.clone());
            self.commands_by_id.insert(command.id.clone(), command);
        }
        self.clipboard_commands_dirty = false;
        self.rebuild_engine();
    }

    /// TS clearClipboardHistory：仓储清空 + 剪贴板命令组下线（错误向上传播，
    /// 由设置窗口状态位显示 TS clearError 文案）。
    fn clear_clipboard_history(&mut self) -> Result<usize, String> {
        let removed = ClipboardHistoryRepository::new(&self.conn)
            .clear()
            .map_err(|error| error.to_string())?;
        for command_id in &self.clipboard_command_ids {
            self.commands_by_id.remove(command_id);
        }
        self.clipboard_command_ids.clear();
        self.clipboard_commands_dirty = false;
        self.rebuild_engine();
        Ok(removed)
    }

    /// 后台索引扫描完成后整体替换 app 命令并重建引擎。
    fn replace_app_commands(&mut self, commands: Vec<Command>) {
        for command_id in &self.app_command_ids {
            self.commands_by_id.remove(command_id);
        }
        self.app_command_ids.clear();
        for command in commands {
            self.app_command_ids.insert(command.id.clone());
            self.commands_by_id.insert(command.id.clone(), command);
        }
        self.rebuild_engine();
    }
}

/// 待后台提取的图标任务。
struct IconJob {
    cache_key: String,
    candidates: Vec<String>,
    invalid_icon_location_seen: bool,
}

/// 后台图标提取器：UI 线程投递缓存未命中的任务；工作线程按候选序
/// `extract_icon_png`，命中即写入磁盘缓存并请求 flush 调度（内存
/// `BoundedMemorySet` 记录本进程内失败的键，避免每次刷新重复提取）。
struct IconExtractor {
    sender: std::sync::mpsc::Sender<IconJob>,
}

impl IconExtractor {
    /// `icon_cache` 由工作线程持有（与 UI 线程经锁共享）；`on_extracted` 在
    /// 成功写入新图标后被调用（工作线程），用于唤醒 UI 重放缓存内容。
    fn spawn(
        icon_cache: Arc<Mutex<IconDiskCache>>,
        flush_signal: std::sync::mpsc::Sender<()>,
        on_extracted: Box<dyn Fn() + Send + 'static>,
    ) -> Self {
        let (sender, receiver) = std::sync::mpsc::channel::<IconJob>();
        std::thread::spawn(move || {
            let mut failed_keys: BoundedMemorySet<String> =
                BoundedMemorySet::new(MEMORY_CACHE_MAX_ENTRIES);
            while let Ok(first) = receiver.recv() {
                let mut jobs = vec![first];
                while let Ok(job) = receiver.try_recv() {
                    jobs.push(job);
                }
                let mut wrote_any = false;
                for job in jobs {
                    if failed_keys.contains(&job.cache_key) {
                        continue;
                    }
                    if icon_cache.lock().unwrap().read(&job.cache_key).is_some() {
                        continue;
                    }
                    let mut succeeded = false;
                    for candidate in &job.candidates {
                        match extract_icon_png(candidate, ICON_EXTRACT_SIZE_PX) {
                            Ok(bytes) => {
                                icon_cache
                                    .lock()
                                    .unwrap()
                                    .write(job.cache_key.clone(), png_bytes_to_data_url(&bytes));
                                let _ = flush_signal.send(());
                                succeeded = true;
                                wrote_any = true;
                                break;
                            }
                            Err(error) => {
                                if job.invalid_icon_location_seen {
                                    // T7 评审挂账的关联图标回退：孤立 IconLocation
                                    //（",N"）已剔除、目标 exe 按序尝试后仍失败，记录
                                    // 诊断。TS 对应路径还会尝试 PowerShell
                                    // ExtractAssociatedIcon，M2 明确接受该差异（见
                                    // 模块尾注与任务报告）。
                                    eprintln!(
                                        "CommandCabin: icon extraction failed for {candidate:?} \
                                         (invalid icon location seen): {error}"
                                    );
                                }
                            }
                        }
                    }
                    if !succeeded {
                        failed_keys.add(job.cache_key);
                    }
                }
                if wrote_any {
                    on_extracted();
                }
            }
        });
        Self { sender }
    }

    fn request(&self, jobs: Vec<IconJob>) {
        for job in jobs {
            let _ = self.sender.send(job);
        }
    }
}

/// 调用方驱动的图标缓存 flush 调度（M2 T8 评审）：500ms 去抖 / 首次脏起
/// 1500ms 最长等待，决策函数在 `state::next_flush_deadline`（可单测）。
/// 通道断开（应用退出丢弃 sender）时做最后一次 flush。
fn spawn_flush_scheduler(icon_cache: Arc<Mutex<IconDiskCache>>) -> std::sync::mpsc::Sender<()> {
    let (sender, receiver) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        let mut first_dirty: Option<std::time::Instant> = None;
        let mut deadline: Option<std::time::Instant> = None;
        loop {
            let wait = deadline
                .map(|deadline| deadline.saturating_duration_since(std::time::Instant::now()));
            match receiver.recv_timeout(wait.unwrap_or(FLUSH_SCHEDULER_MAX_IDLE)) {
                Ok(()) => {
                    let now = std::time::Instant::now();
                    let first = *first_dirty.get_or_insert(now);
                    deadline = Some(state::next_flush_deadline(first, now));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    let _ = icon_cache.lock().unwrap().flush();
                    first_dirty = None;
                    deadline = None;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    let _ = icon_cache.lock().unwrap().flush();
                    break;
                }
            }
        }
    });
    sender
}

/// 呼出窗口屏幕居中（M5 收口项，winit 通道）：取当前显示器矩形与窗口外框
/// 尺寸，用 [`state::centered_origin`] 计算原点后 `set_outer_position`。
/// Slint 稳定 API 无屏幕几何，`unstable-winit-030` 句柄是既有的安全通道
/// （focus_window / has_focus 已在用）。显示器未知（尚未映射等）时静默跳过，
/// 保持 Slint 默认摆放。
fn center_window_on_monitor(window: &LauncherWindow) {
    use slint::winit_030::winit::dpi::PhysicalPosition;
    window.window().with_winit_window(|winit_window| {
        let Some(monitor) = winit_window.current_monitor() else {
            return;
        };
        let (x, y) = state::centered_origin(
            (monitor.position().x, monitor.position().y),
            (monitor.size().width, monitor.size().height),
            (
                winit_window.outer_size().width,
                winit_window.outer_size().height,
            ),
        );
        winit_window.set_outer_position(PhysicalPosition::new(x, y));
    });
}

/// 事件循环闭包共享的应用上下文（Send + Sync）。
struct AppContext {
    window: slint::Weak<LauncherWindow>,
    settings_window: slint::Weak<SettingsWindow>,
    /// 截图覆盖窗口（M3 Task 7）：i18n 文案随语言推送；控制器独立持有自己的
    /// Weak（回调捕获 Arc<ScreenshotController>，不经本上下文，避免 Arc 环）。
    screenshot_window: slint::Weak<ScreenshotWindow>,
    state: Arc<Mutex<AppState>>,
    icon_cache: Arc<Mutex<IconDiskCache>>,
    extractor: IconExtractor,
    hide_on_blur: Arc<AtomicBool>,
    /// 自最近一次呼出以来是否观测到焦点（hideOnBlur 决策输入，见
    /// `state::hide_on_blur_poll_step`；读写均在 UI 线程，无并发交错）。
    focused_since_shown: AtomicBool,
    /// 截图热键注册表（M3 Task 8 位移语义的状态侧；与热键操作同在 UI 线程
    /// 的设置流闭包内触达，Mutex 仅满足 Send+Sync）。
    screenshot_registrations: Mutex<state::ScreenshotHotkeyRegistrations>,
    executor: CommandExecutor,
}

impl AppContext {
    fn refresh_results(&self) {
        let needs_rate_refresh = render_results(
            &self.window,
            &self.state,
            &self.icon_cache,
            Some(&self.extractor),
            true,
        );
        // 货币查询且无缓存（TS await 挂起）：后台取数，完成后重跑当前查询。
        if needs_rate_refresh {
            ensure_rate_fetch(&self.state, &self.window, &self.icon_cache);
        }
    }

    fn hide_window(&self) {
        let Some(window) = self.window.upgrade() else {
            return;
        };
        window.hide().expect("hide launcher");
    }

    fn show_window(&self) {
        Self::show_launcher_window(self);
    }

    /// TS `toggleLauncherWindow` 语义：可见则隐藏，否则呼出。
    ///
    /// 呼出实现抽成自由函数：截图控制器（M3 Task 7）的会话收束钩子以
    /// `Weak<AppContext>` 调用同一行为（Weak 打破 controller ↔ context 的 Arc 环）。
    fn show_launcher_window(context: &AppContext) {
        let Some(window) = context.window.upgrade() else {
            return;
        };
        // 复位“已聚焦”标记：每次呼出后须重新观测到焦点，hideOnBlur 才会在失焦
        // 沿隐藏（TS blur-transition 语义：从未获得焦点的窗口保持可见，不因
        // focus_window 被前台锁延迟/拒绝而被轮询闪隐）。复位须先于 show——
        // 本函数与轮询同在 UI 线程的事件循环内，语句间无并发交错。
        context.focused_since_shown.store(false, Ordering::SeqCst);
        // preserveSearchQuery=false 时清空上次查询（M2 Task 10 接线）；
        // true 时保留查询与结果（不重置、不重搜）。
        let preserve_query = context.state.lock().unwrap().settings.preserve_search_query;
        if !preserve_query {
            window.set_current_query("".into());
            // set_current_query 不触发 edited 回调，必须显式重跑搜索填充结果；
            // 空查询走首页合成（分组头见 render_results）。
            context.refresh_results();
        }
        window.show().expect("show launcher");
        // M5 收口（窗口居中）：稳定 Slint 无屏幕几何 API，经 winit 通道取当前
        // 显示器矩形把窗口摆到屏幕中心（M1/M2 连续两轮验收不通过项）。
        center_window_on_monitor(&window);
        // show 只映射窗口，不保证前台/焦点：经 winit 句柄做 SetForegroundWindow 级激活，
        // 再把 Slint 焦点显式交给输入框（forward-focus 仅首次隐式生效，后续呼出需重置）。
        window
            .window()
            .with_winit_window(|winit_window| winit_window.focus_window());
        window.invoke_focus_input();
        window.window().request_redraw();
    }

    /// TS `toggleLauncherWindow` 语义：可见则隐藏，否则呼出。
    fn toggle_window(&self) {
        let Some(window) = self.window.upgrade() else {
            return;
        };
        if window.window().is_visible() {
            self.hide_window();
        } else {
            self.show_window();
        }
    }

    /// 托盘"设置"：先整包推送当前快照（设置可能在启动后从未打开过窗口时已变），
    /// 再显示设置窗口。
    fn show_settings_window(&self) {
        let Some(window) = self.settings_window.upgrade() else {
            return;
        };
        push_settings_view(self);
        window.set_error_text("".into());
        window.show().expect("show settings");
        window.window().request_redraw();
    }

    fn hide_settings_window(&self) {
        let Some(window) = self.settings_window.upgrade() else {
            return;
        };
        window.hide().expect("hide settings");
    }

    fn execute_selected(&self) {
        let Some(window) = self.window.upgrade() else {
            return;
        };
        // UI 修复 2：首页磁贴模式（磁贴模型非空——仅空查询时由 Rust push）且
        // selected-tile 有效 → 执行选中磁贴，与磁贴点击同一条
        // execute_command_by_id（commands_by_id 直查 + miss 重渲染重试）路径。
        // 路由决策见 state::execute_tile_route（-1 / 越界 / 空网格 → 列表路径）。
        let tile_count =
            window.get_pinned_tiles().row_count() + window.get_pinned_tiles_row_2().row_count();
        let tile_command = state::execute_tile_route(window.get_selected_tile(), tile_count)
            .and_then(|tile_index| {
                let row_1 = window.get_pinned_tiles();
                let tile = if tile_index < row_1.row_count() {
                    row_1.row_data(tile_index)
                } else {
                    window
                        .get_pinned_tiles_row_2()
                        .row_data(tile_index - row_1.row_count())
                };
                tile.map(|tile| tile.command_id)
                    .filter(|command_id| !command_id.is_empty())
            });
        if let Some(command_id) = tile_command {
            self.execute_command_by_id(command_id.as_str());
            return;
        }
        // 平铺列表路径（搜索态）：分组头/越界行防御——只执行带命令 id 的行。
        let index = window.get_selected_index() as usize;
        let Some(row) = window.get_results().row_data(index) else {
            return;
        };
        if row.command_id.is_empty() {
            return;
        }
        let query = window.get_current_query();
        // TS executeCommand 从 registry 取命令（保留上一次 search 装入的动态
        // 命令）；等价实现：重跑同一条查询管线再按 id 匹配。
        let commands = self.state.lock().unwrap().query_results(query.as_str()).0;
        let Some(command) = commands
            .into_iter()
            .find(|command| command.id == row.command_id.as_str())
        else {
            return;
        };
        self.execute_and_record(&command);
    }

    /// 执行命令：成功且（收藏命令 或 app 命令）→ 记录执行历史并隐藏窗口
    /// （execute_selected 与磁贴点击共用的收尾路径）。
    fn execute_and_record(&self, command: &Command) {
        let result = self.executor.execute(command);
        if matches!(result, CommandExecutionResult::Success { .. }) {
            // 简报 3：成功且（收藏命令 或 app 命令）→ 记录执行历史。
            // executed_at=None → 仓储侧 iso_now() 生成规范 UTC（T5 评审的
            // executed_at 混排字典序风险在写入侧的缓解）。
            if state::should_record_execution(true, command) {
                let guard = self.state.lock().unwrap();
                let repository = HistoryRepository::new(&guard.conn);
                if let Err(error) = repository.record_execution(RecordExecution {
                    command_id: &command.id,
                    title: &command.title,
                    source: command.source,
                    subtitle: command.subtitle.as_deref(),
                    executed_at: None,
                    metadata: None,
                }) {
                    eprintln!("CommandCabin: recording execution failed: {error}");
                }
            }
            self.hide_window();
        } else {
            eprintln!("command execution failed: {result:?}");
        }
    }

    /// 首页固定磁贴点击执行（UI 修复 1）。直接查 `commands_by_id`（TS
    /// executeCommand 走 registry 的等价物；不复用 execute_selected 的"重跑查询
    /// 管线"路径——那是 M4 T7 已挂账的 mutation 重跑问题，磁贴不应放大它）。
    /// id 未命中（索引刷新后收藏命令 id 变动等）→ 先重渲染再查一次；仍未命中
    /// 则诊断后忽略。
    fn execute_command_by_id(&self, command_id: &str) {
        let command = self
            .state
            .lock()
            .unwrap()
            .commands_by_id
            .get(command_id)
            .cloned();
        let command = match command {
            Some(command) => Some(command),
            None => {
                self.refresh_results();
                self.state
                    .lock()
                    .unwrap()
                    .commands_by_id
                    .get(command_id)
                    .cloned()
            }
        };
        let Some(command) = command else {
            eprintln!("CommandCabin: run-command-id: unknown command {command_id}");
            return;
        };
        self.execute_and_record(&command);
    }
    /// 结果行 "固定到首页"（M2 Task 10）：收藏写库 → 重载 favorites →
    /// 刷新启动器与设置窗口收藏列表。参数为模型行携带的命令 id。
    fn pin_app(&self, command_id: &str) {
        let mut guard = self.state.lock().unwrap();
        let Some(command) = guard.commands_by_id.get(command_id).cloned() else {
            eprintln!("CommandCabin: pin-app: unknown command {command_id}");
            return;
        };
        if !is_app_command(&command) {
            return;
        }
        let input = match state::pinned_app_favorite_input(&command) {
            Ok(input) => input,
            Err(error) => {
                eprintln!("CommandCabin: pin-app: {error}");
                return;
            }
        };
        if let Err(error) = FavoritesRepository::new(&guard.conn).add(input) {
            eprintln!("CommandCabin: pin-app: adding favorite failed: {error}");
            return;
        }
        if let Err(error) = guard.reload_favorites() {
            eprintln!("CommandCabin: pin-app: reloading favorites failed: {error}");
            return;
        }
        drop(guard);
        self.refresh_results();
        push_settings_view(self);
    }

    /// 设置窗口收藏管理：删除指定行（模型下标）并刷新两处视图。
    fn remove_favorite(&self, index: usize) {
        let Some(window) = self.settings_window.upgrade() else {
            return;
        };
        let Some(row) = window.get_favorites().row_data(index) else {
            return;
        };
        if row.id.is_empty() {
            return;
        }
        {
            let mut guard = self.state.lock().unwrap();
            if let Err(error) = FavoritesRepository::new(&guard.conn).remove(&row.id) {
                eprintln!("CommandCabin: remove-favorite failed: {error}");
                return;
            }
            if let Err(error) = guard.reload_favorites() {
                eprintln!("CommandCabin: remove-favorite: reloading favorites failed: {error}");
                return;
            }
        }
        self.refresh_results();
        push_settings_view(self);
    }
}

/// 汇率后台取数（M4 Task 7，T6 评审结论"查询路径不做阻塞刷新"）：
/// TS exchangeRateCache `void refreshRate()` 的异步形 + TS
/// refreshQuickConverterCommand 的 await 恢复。占用在飞标记 → 工作线程 HTTP
/// （≤DEFAULT_EXCHANGE_RATE_TIMEOUT_MS=1200ms）→ invoke_from_event_loop 回
/// UI 线程 ingest 回灌缓存；取数成功即重跑当前查询（render_results 读窗口
/// 实时查询，天然承担 TS generation guard 的角色）；失败仅释放在飞标记
/// （缓存不变，下次货币查询重试，与 TS 一致）。
fn ensure_rate_fetch(
    state: &Arc<Mutex<AppState>>,
    window: &slint::Weak<LauncherWindow>,
    icon_cache: &Arc<Mutex<IconDiskCache>>,
) {
    {
        let mut guard = state.lock().unwrap();
        if guard.rate_fetch_in_flight {
            return;
        }
        guard.rate_fetch_in_flight = true;
    }
    let state = Arc::clone(state);
    let window = window.clone();
    let icon_cache = Arc::clone(icon_cache);
    std::thread::spawn(move || {
        let body = fetch_frankfurter_body(None);
        let _ = slint::invoke_from_event_loop(move || {
            let ingested = {
                let mut guard = state.lock().unwrap();
                guard.rate_fetch_in_flight = false;
                guard.rate_cache.ingest_fetched_body(body)
            };
            if ingested.is_some() {
                // 图标复用缓存即可（动态/货币命令无图标），不重复投递提取任务。
                render_results(&window, &state, &icon_cache, None, false);
            }
        });
    });
}

/// 剪贴板轮询单拍（M4 Task 7；watcher.rs 契约的定时器所有者侧）：读剪贴板 →
/// poll_step 决策（空/重复/非文本跳过）→ 产出原文即 save_text 落库并置脏
/// （下次非空查询重载剪贴板命令，TS clipboardHistoryVersion 自增）。UI 线程
/// 调用（Slint Timer）；read_text 同步返回，TS activePoll 的在飞串行化天然
/// 成立。
fn clipboard_poll_once(state: &Arc<Mutex<AppState>>) {
    let current = match ArboardClipboardReader::new().read_text() {
        Ok(current) => {
            let recovered = {
                let mut guard = state.lock().unwrap();
                std::mem::take(&mut guard.clipboard_read_failed)
            };
            // 错误状态翻转沿：恢复只提示一次。
            if recovered {
                eprintln!("CommandCabin: clipboard read recovered");
            }
            current
        }
        Err(error) => {
            let first_failure = {
                let mut guard = state.lock().unwrap();
                let first = !guard.clipboard_read_failed;
                guard.clipboard_read_failed = true;
                first
            };
            // TS onError：读失败仅诊断，不改写轮询状态（下拍重试）；日志降为
            // 翻转沿触发（仅首次失败打印），避免读取持续失败时每秒刷屏。
            if first_failure {
                eprintln!("CommandCabin: clipboard read failed: {error}");
            }
            return;
        }
    };
    let mut guard = state.lock().unwrap();
    let previous_last = guard.clipboard_poll_state.last_text.clone();
    if let Some(text) = poll_step(&mut guard.clipboard_poll_state, current) {
        match ClipboardHistoryRepository::new(&guard.conn).save_text(&text, None) {
            Ok(_) => guard.clipboard_commands_dirty = true,
            Err(error) => {
                // TS onText 失败不更新 lastNormalizedText：回滚，下拍重试。
                guard.clipboard_poll_state.last_text = previous_last;
                eprintln!("CommandCabin: clipboard history save failed: {error}");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 更新编排（M5 Task 3）：TS updateController 的线程化移植。决策在
// updater_controller 纯函数（UI 线程）；UpdateService（GitHub 检查 / 下载）
// 一律在工作线程执行，结果经 invoke_from_event_loop 回 UI 线程转移状态并推送
// 视图。更新走同厂商 TLS（GitHub Releases），不需要 M3 截图翻译那种同意门。
// ---------------------------------------------------------------------------

/// TS `app.isPackaged` 的 native 等价：release 构建视为已安装形态、启用更新；
/// debug 构建（cargo dev / build.ps1 冒烟）禁用（TS dev 同样禁用，状态
/// unavailable）。`COMMAND_CABIN_ENABLE_UPDATES=1` 为调试逃生门（真机链路
/// 人工验证用）。
fn updates_enabled() -> bool {
    if std::env::var("COMMAND_CABIN_ENABLE_UPDATES").as_deref() == Ok("1") {
        return true;
    }
    !cfg!(debug_assertions)
}

/// 发布说明摘要的最大字符数（available 状态行的第二行）。
const UPDATE_NOTES_SUMMARY_MAX_CHARS: usize = 80;

/// 应用当前版本（与设置 About 的版本文本同源：workspace version）。
const CURRENT_APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 把更新状态推送到设置窗口（About 状态行 + 按钮可用性）与启动器横幅
/// （TS publish → UPDATE_STATUS_CHANGED 的两处订阅者）。UI 线程调用。
fn push_update_views(context: &AppContext) {
    let (language, status, summary) = {
        let guard = context.state.lock().unwrap();
        let summary = guard.update.pending_notes().and_then(|notes| {
            updater_controller::notes_summary(Some(notes), UPDATE_NOTES_SUMMARY_MAX_CHARS)
        });
        (
            guard.settings.language,
            guard.update.status.clone(),
            summary,
        )
    };
    let texts = i18n::update_texts(language);
    if let Some(window) = context.settings_window.upgrade() {
        window.set_about_update_status(
            updater_controller::status_text(&texts, &status, summary.as_deref()).into(),
        );
        window.set_can_check_update(status.can_check);
        window.set_can_download_update(status.phase == updater_controller::UpdatePhase::Available);
        window.set_can_install_update(status.can_install);
    }
    if let Some(launcher) = context.window.upgrade() {
        match updater_controller::banner_view(&texts, &status) {
            Some(banner) => {
                launcher.set_update_banner_text(banner.text.into());
                launcher.set_update_banner_detail(banner.detail.unwrap_or_default().into());
                launcher.set_update_banner_install(
                    banner.action == updater_controller::BannerAction::Install,
                );
                launcher.set_update_banner_settings(
                    banner.action == updater_controller::BannerAction::OpenSettings,
                );
                launcher.set_update_banner_install_label(texts.banner_install.into());
                launcher.set_update_banner_settings_label(texts.banner_open_settings.into());
            }
            None => {
                launcher.set_update_banner_text(SharedString::default());
                launcher.set_update_banner_detail(SharedString::default());
                launcher.set_update_banner_install(false);
                launcher.set_update_banner_settings(false);
            }
        }
    }
}

/// 发起一次更新检查（TS `checkForUpdates(bypassCooldown)`：manual=false 即
/// bypass 的自动检查）。准入被拒（忙态 / 冷却 / 禁用）静默返回（TS 返回当前
/// status）。准入后：checking 推送 → 工作线程 `latest()` → 回 UI 线程转移。
/// 自动检查失败静默回 Idle（计划全局约束），手动失败直出可读错误。
fn start_update_check(context: &Arc<AppContext>, manual: bool) {
    let admitted = {
        let mut guard = context.state.lock().unwrap();
        let now_ms = unix_millis();
        if manual {
            guard.update.admit_manual_check(now_ms)
        } else {
            guard.update.admit_automatic_check(now_ms)
        }
    };
    if !admitted {
        return;
    }
    push_update_views(context);
    let context = Arc::clone(context);
    std::thread::spawn(move || {
        let result = GitHubUpdateService::new().latest(CURRENT_APP_VERSION);
        let _ = slint::invoke_from_event_loop(move || {
            let became_available = {
                let mut guard = context.state.lock().unwrap();
                match result {
                    Ok(None) => {
                        guard.update.finish_check_up_to_date(None);
                        false
                    }
                    Ok(Some(info)) => guard.update.finish_check_available(info),
                    Err(error) if manual => {
                        guard.update.finish_check_failed(error.to_string());
                        false
                    }
                    Err(error) => {
                        eprintln!("CommandCabin: automatic update check failed: {error}");
                        guard.update.recover_silent_check();
                        false
                    }
                }
            };
            if became_available {
                // v1.0.1（用户需求"自动下载更新包，提示更新"）：发现新版本即
                // 自动开始下载（对齐 TS electron-updater 默认 autoDownload——
                // 检查→下载→"已下载+立即安装"横幅全程无手动步骤；下载失败进
                // Error 相位由横幅/设置页呈现，不会循环重试）。设置页的手动
                // [下载] 按钮保留（重复触发被 begin_download 相位机拒绝）。
                start_update_download(&context);
                return;
            }
            push_update_views(&context);
        });
    });
}

/// [下载]：从 pending 清单取安装包资产 → 工作线程流式下载到
/// `%TEMP%\command-cabin-update\`（Task 1-2 的边车校验在 download 内部）→ 进度
/// 按百分比变化回灌 UI（避免每个读块都排队一次事件循环）→ 完成 / 失败转移。
fn start_update_download(context: &Arc<AppContext>) {
    let (asset, version) = {
        let mut guard = context.state.lock().unwrap();
        let version = guard.update.status.version.clone().unwrap_or_default();
        match guard.update.begin_download() {
            Ok(asset) => (asset, version),
            Err(message) => {
                eprintln!("CommandCabin: update download cannot start: {message}");
                guard.update.fail_download(message);
                drop(guard);
                push_update_views(context);
                return;
            }
        }
    };
    push_update_views(context);
    let target = updater_controller::installer_download_path(&std::env::temp_dir(), &version);
    let context = Arc::clone(context);
    std::thread::spawn(move || {
        let result = match target.parent().map(std::fs::create_dir_all) {
            Some(Err(error)) => Err(format!(
                "could not create {}: {error}",
                target
                    .parent()
                    .map(|dir| dir.display().to_string())
                    .unwrap_or_default()
            )),
            _ => {
                let progress_context = Arc::clone(&context);
                let last_percent = Arc::new(AtomicU8::new(u8::MAX));
                let progress: Box<dyn Fn(u64, u64) + Send> = Box::new(move |received, total| {
                    let percent = updater_controller::download_percent(received, total);
                    if last_percent.swap(percent, Ordering::SeqCst) == percent {
                        return;
                    }
                    let context = Arc::clone(&progress_context);
                    let _ = slint::invoke_from_event_loop(move || {
                        context
                            .state
                            .lock()
                            .unwrap()
                            .update
                            .download_progress(received, total);
                        push_update_views(&context);
                    });
                });
                GitHubUpdateService::new()
                    .download(&asset, &target, Some(progress))
                    .map_err(|error| error.to_string())
            }
        };
        let _ = slint::invoke_from_event_loop(move || {
            {
                let mut guard = context.state.lock().unwrap();
                match result {
                    Ok(()) => guard.update.finish_download(),
                    Err(message) => {
                        eprintln!("CommandCabin: update download failed: {message}");
                        guard.update.fail_download(message);
                    }
                }
            }
            push_update_views(&context);
        });
    });
}

/// [重启安装] / 横幅 [立即安装]（TS `installUpdate` → `quitAndInstall`）：
/// 构造 `Setup.exe /S`（纯函数）→ 校验安装包文件在位 → spawn → 立即退出事件
/// 循环（安装器负责等待旧进程退出，Task 4）。spawn 失败 / 文件丢失 → 可读错误。
fn install_downloaded_update(context: &Arc<AppContext>) {
    let plan = {
        let guard = context.state.lock().unwrap();
        guard.update.install_command(&std::env::temp_dir())
    };
    let Some(plan) = plan else {
        eprintln!(
            "CommandCabin: {}",
            updater_controller::INSTALL_NOT_READY_ERROR
        );
        return;
    };
    // 安全注记（安全扫描误报说明）：此处为 std 参数化进程 API（程序路径 +
    // 参数向量），直达 CreateProcessW，不经任何 shell，无拼接字符串可注入。
    // program 为固定目录 + 固定文件名（version 经 parse_version 严格数字
    // 校验后才可能进入路径），spawn 前有 is_file 检查，文件本身经
    // sha512 sidecar 校验落地（见 updater.rs）。
    let spawned = if plan.program.is_file() {
        std::process::Command::new(&plan.program)
            .args(&plan.args)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("could not start {}: {error}", plan.program.display()))
    } else {
        Err(format!(
            "{} (missing {})",
            updater_controller::INSTALL_NOT_READY_ERROR,
            plan.program.display()
        ))
    };
    match spawned {
        Ok(()) => {
            // 安装器已启动：立即退出，让安装器等待本进程消失后覆盖安装。
            let _ = slint::quit_event_loop();
        }
        Err(message) => {
            eprintln!("CommandCabin: update install failed: {message}");
            context
                .state
                .lock()
                .unwrap()
                .update
                .install_spawn_failed(message);
            push_update_views(context);
        }
    }
}

/// 搜索/首页 → 结果模型：图标命中磁盘缓存则内嵌位图，未命中投递后台提取
/// （`extractor=None` 时只读缓存，用于提取完成后的重放）。`reset_selection`
/// 为 false（图标到达后的重放）时保留用户当前的选择行。返回是否需要后台
/// 汇率取数（调用方决定是否触发 [`ensure_rate_fetch`]；图标重放路径忽略）。
///
/// M2 Task 10：空查询首页平铺模型带 "最近使用" 分组头行（`ResultItem.group`
/// 非空）；分组头不可选中/执行。
///
/// UI 修复 1：pinned 改走横向磁贴网格（`state::home_pinned_tiles` 截断 10 个 +
/// 身份键去重），由 `pinned-tiles` 模型单独渲染，不再进入平铺模型。
///
/// UI 修复 2（用户需求迭代）：首页（空查询）平铺结果恒为空——"最近使用"列表
/// 整体移除，磁贴网格是首页唯一命令入口（执行历史仍经 search ranking 作用于
/// 搜索排序；`home_rows` 语义保留给 `query_results` 的 TS-parity 合成）。
/// 搜索态平铺行不变。reset_selection 时同步复位磁贴选中：首页有磁贴 →
/// 第 0 个（高亮可见、Enter 即启动首个固定应用），否则 -1。
fn render_results(
    window: &slint::Weak<LauncherWindow>,
    state: &Arc<Mutex<AppState>>,
    icon_cache: &Mutex<IconDiskCache>,
    extractor: Option<&IconExtractor>,
    reset_selection: bool,
) -> bool {
    let Some(window) = window.upgrade() else {
        return false;
    };
    let query = window.get_current_query();
    let mut guard = state.lock().unwrap();
    let (commands, needs_rate_refresh) = guard.query_results(query.as_str());
    let is_home = query.trim().is_empty();

    let mut jobs: Vec<IconJob> = Vec::new();
    let mut items: Vec<ResultItem> = Vec::new();
    if !is_home {
        items.reserve(commands.len());
        for command in &commands {
            push_command_row(
                &mut items,
                &mut jobs,
                command,
                icon_cache,
                extractor,
                &guard.pinned_app_command_ids,
                &guard.pinned_shortcut_keys,
            );
        }
    }
    window.set_results(ModelRc::new(VecModel::from(items)));
    // UI 修复 1：磁贴模型（仅空查询首页；图标与平铺行走同一条水合/后台提取
    // 管线）。数据源是 `pinned_app_commands` 全量收藏而非 home_sections 的
    // pinned 分组——后者受 TS 总上限 10 约束（recent 满员时恒空，磁贴会隐没）；
    // 网格自带 5×2=10 上限。网格每行 5 个 → Rust 侧切分两行模型（Slint 的 for
    // 委托不支持条件元素，无法按下标分槽）。
    let all_tiles: Vec<PinnedTile> = if is_home {
        state::home_pinned_tiles(&guard.pinned_app_commands)
            .iter()
            .map(|command| PinnedTile {
                title: controller::view_item(&command.title, &command.subtitle)
                    .title
                    .into(),
                icon: hydrate_icon(command, icon_cache, extractor.map(|_| jobs.as_mut())),
                command_id: command.id.clone().into(),
            })
            .collect()
    } else {
        Vec::new()
    };
    // 网格总磁贴数（切行前计数；选中复位与导航决策共用）。
    let tile_count = all_tiles.len();
    let mut tiles_row_2 = all_tiles;
    let tiles_row_1: Vec<PinnedTile> = if tiles_row_2.len() > HOME_TILE_COLUMNS {
        tiles_row_2.drain(..HOME_TILE_COLUMNS).collect()
    } else {
        std::mem::take(&mut tiles_row_2)
    };
    window.set_pinned_tiles(ModelRc::new(VecModel::from(tiles_row_1)));
    window.set_pinned_tiles_row_2(ModelRc::new(VecModel::from(tiles_row_2)));
    if reset_selection {
        // UI 修复 2：新模型从顶部展示。滚动复位必须显式做——若新旧
        // selected-index 相同，下方 changed 回调不会触发。
        window.set_results_viewport_y(0.0);
        // 首个可选中行（跳过分组头；首页列表恒为空，无可选行）。
        let mut first = 0usize;
        for (index, item) in window.get_results().iter().enumerate() {
            if !item.command_id.is_empty() {
                first = index;
                break;
            }
        }
        window.set_selected_index(first as i32);
        // 磁贴选中复位（UI 修复 2）：首页有磁贴 → 选中第 0 个（高亮可见、
        // Enter 即启动首个固定应用）；搜索态 / 空网格 → -1（无高亮）。
        // 决策见 state::initial_tile_selection。
        let tile_selection = state::initial_tile_selection(is_home, tile_count);
        guard.selected_tile = tile_selection;
        window.set_selected_tile(tile_selection.map_or(-1, |index| index as i32));
    }
    if let Some(extractor) = extractor {
        extractor.request(jobs);
    }
    needs_rate_refresh
}

/// 命令内容行：标题/副标题/图标水合 + 固定按钮标记（pinned 判定见
/// `state::command_is_pinned_app`）。
fn push_command_row(
    items: &mut Vec<ResultItem>,
    jobs: &mut Vec<IconJob>,
    command: &Command,
    icon_cache: &Mutex<IconDiskCache>,
    extractor: Option<&IconExtractor>,
    pinned_command_ids: &HashSet<String>,
    pinned_shortcut_keys: &HashSet<String>,
) {
    let view = controller::view_item(&command.title, &command.subtitle);
    let icon = hydrate_icon(command, icon_cache, extractor.map(|_| jobs));
    let pinned = state::command_is_pinned_app(command, pinned_command_ids, pinned_shortcut_keys);
    // 无图标行的芯片字符（UI 复刻轮，对齐 TS getResultIconGlyph：标题首字符
    // 大写，空标题兜底 "?"；to_uppercase 可能展开多字符，按整串入芯片）。
    let glyph: String = command
        .title
        .trim()
        .chars()
        .next()
        .map(|first| first.to_uppercase().collect::<String>())
        .unwrap_or_else(|| "?".to_string());
    items.push(ResultItem {
        title: view.title.into(),
        subtitle: view.subtitle.into(),
        icon,
        glyph: glyph.into(),
        group: SharedString::default(),
        command_id: command.id.clone().into(),
        app: is_app_command(command),
        pinned,
    });
}

/// 按设置语言推送启动器新增文案（搜索区文案 / 固定按钮 / 截图入口 / 设置齿轮）。
fn push_launcher_texts(window: &LauncherWindow, language: cabin_core::settings::Language) {
    let texts = i18n::home_texts(language);
    window.set_recent_group(texts.recent_group.into());
    window.set_pinned_group(texts.pinned_group.into());
    window.set_pin_label(texts.pin_app.into());
    window.set_home_actions_label(texts.home_actions_label.into());
    window.set_home_action_screenshot(texts.home_action_screenshot.into());
    window.set_search_label(texts.search_label.into());
    window.set_search_placeholder(texts.search_placeholder.into());
    window.set_open_settings_label(texts.open_settings.into());
}

/// 按设置语言推送截图覆盖窗口文案（M3 Task 7/8/9；键名对齐 TS screenshot.*）。
fn push_screenshot_texts(window: &ScreenshotWindow, language: cabin_core::settings::Language) {
    let texts = i18n::screenshot_texts(language);
    window.set_texts(ScreenshotTexts {
        tool_rectangle: texts.tool_rectangle.into(),
        tool_ellipse: texts.tool_ellipse.into(),
        tool_arrow: texts.tool_arrow.into(),
        tool_pen: texts.tool_pen.into(),
        tool_mosaic: texts.tool_mosaic.into(),
        tool_text: texts.tool_text.into(),
        undo: texts.undo.into(),
        redo: texts.redo.into(),
        ocr: texts.ocr.into(),
        translate: texts.translate.into(),
        pin: texts.pin.into(),
        save: texts.save.into(),
        cancel: texts.cancel.into(),
        done: texts.done.into(),
        prompt_placeholder: texts.prompt_placeholder.into(),
        ocr_running: texts.ocr_recognizing.into(),
        ocr_copy_all: texts.ocr_copy_all.into(),
    });
}

/// 把主题（0 system / 1 light / 2 dark）应用到两个窗口（theme-mode 属性）。
fn apply_theme_to_windows(launcher: &LauncherWindow, settings: &SettingsWindow, theme: Theme) {
    let mode = state::theme_index(theme) as i32;
    launcher.set_theme_mode(mode);
    settings.set_theme_mode(mode);
}

/// 设置窗口视图整包推送（M2 Task 10）：值 + 文案 + 收藏列表 + 主题。
/// 任何设置提交（成功或失败回滚）后调用，把输入框/选择收敛到生效值；
/// 语言变更同时刷新设置窗口文案与启动器首页文案。收藏列表每次从仓储重读
/// （固定/删除后也经本函数刷新）。窗口未创建/已销毁时安全跳过。
fn push_settings_view(context: &AppContext) {
    let Some(settings_window) = context.settings_window.upgrade() else {
        return;
    };
    let guard = context.state.lock().unwrap();
    let settings = &guard.settings;
    let texts = i18n::settings_texts(settings.language);

    settings_window.set_texts(SettingsTexts {
        window_title: texts.window_title.into(),
        hotkeys_title: texts.hotkeys_title.into(),
        launcher_hotkey_label: texts.launcher_hotkey_label.into(),
        screenshot_hotkey_label: texts.screenshot_hotkey_label.into(),
        delayed_hotkey_label: texts.delayed_hotkey_label.into(),
        appearance_title: texts.appearance_title.into(),
        theme_label: texts.theme_label.into(),
        theme_system: texts.theme_system.into(),
        theme_light: texts.theme_light.into(),
        theme_dark: texts.theme_dark.into(),
        language_title: texts.language_title.into(),
        language_label: texts.language_label.into(),
        language_zh_cn: texts.language_zh_cn.into(),
        language_zh_tw: texts.language_zh_tw.into(),
        language_en_us: texts.language_en_us.into(),
        startup_title: texts.startup_title.into(),
        launch_at_login: texts.launch_at_login.into(),
        launcher_title: texts.launcher_title.into(),
        hide_on_blur: texts.hide_on_blur.into(),
        preserve_search_query: texts.preserve_search_query.into(),
        max_results: texts.max_results.into(),
        history_boost: texts.history_boost.into(),
        plugin_boost: texts.plugin_boost.into(),
        app_boost: texts.app_boost.into(),
        file_boost: texts.file_boost.into(),
        favorites_title: texts.favorites_title.into(),
        favorites_empty: texts.favorites_empty.into(),
        favorites_remove: texts.favorites_remove.into(),
        clipboard_history_title: texts.clipboard_history_title.into(),
        clipboard_history_clear: texts.clipboard_history_clear.into(),
        about_title: texts.about_title.into(),
        about_version_text: format!("CommandCabin v{}", env!("CARGO_PKG_VERSION")).into(),
        about_license: texts.about_license.into(),
        about_check: texts.about_check.into(),
        about_download: texts.about_download.into(),
        about_install: texts.about_install.into(),
        back: texts.back.into(),
    });
    settings_window.set_hotkey_launcher(settings.hotkey.clone().into());
    settings_window.set_hotkey_screenshot(settings.screenshot_hotkey.clone().into());
    settings_window.set_hotkey_delayed(settings.delayed_screenshot_hotkey.clone().into());
    settings_window.set_hide_on_blur(settings.hide_on_blur);
    settings_window.set_launch_at_login(settings.launch_at_login);
    settings_window.set_preserve_search_query(settings.preserve_search_query);
    settings_window.set_theme_choice(state::theme_index(settings.theme) as i32);
    settings_window.set_language_choice(state::language_index(settings.language) as i32);
    settings_window
        .set_max_results(state::format_decimal(settings.search.max_results as f64).into());
    settings_window.set_history_boost(state::format_decimal(settings.search.history_boost).into());
    settings_window.set_plugin_boost(state::format_decimal(settings.search.plugin_boost).into());
    settings_window.set_app_boost(state::format_decimal(settings.search.app_boost).into());
    settings_window.set_file_boost(state::format_decimal(settings.search.file_boost).into());

    // 收藏列表（kind 文案按当前语言；pinned app 显示"应用"）。
    let favorite_rows: Vec<FavoriteRowView> = match FavoritesRepository::new(&guard.conn).list() {
        Ok(favorites) => favorites
            .iter()
            .map(|favorite| {
                let pinned_app = is_launcher_pinned_app(favorite);
                let kind_label =
                    i18n::favorite_kind_label(settings.language, pinned_app, favorite.kind);
                let detail = favorite
                    .path
                    .as_deref()
                    .or(favorite.url.as_deref())
                    .unwrap_or_default();
                FavoriteRowView {
                    id: favorite.id.clone().into(),
                    title: favorite.title.clone().into(),
                    detail: format!("{kind_label} · {detail}").into(),
                }
            })
            .collect(),
        Err(error) => {
            eprintln!("CommandCabin: favorites are unreadable: {error}");
            Vec::new()
        }
    };
    settings_window.set_favorites(ModelRc::new(VecModel::from(favorite_rows)));

    if let Some(launcher) = context.window.upgrade() {
        push_launcher_texts(&launcher, settings.language);
        apply_theme_to_windows(&launcher, &settings_window, settings.theme);
    }
    // 截图覆盖窗口文案随语言热切换（窗口可能未创建会话，推送无副作用）。
    if let Some(screenshot) = context.screenshot_window.upgrade() {
        push_screenshot_texts(&screenshot, settings.language);
    }
    // 窗口不可见时也把主题收口到两个窗口上（独立分支，launcher 必在）。
    drop(guard);
    // 更新状态行 / 横幅随语言重推（M5 Task 3；含文本模板与按钮文案）。
    push_update_views(context);
}

/// 结果图标水合：缓存键对齐 TS —— 使用未过滤的原始候选列表（与 Electron 共享
/// `%APPDATA%\CommandCabin\app-icons.json`，键必须一致）；提取用候选则剔除孤立
/// IconLocation（T7 评审回退语义见 `state::plan_icon_resolution`）。
fn hydrate_icon(
    command: &Command,
    icon_cache: &Mutex<IconDiskCache>,
    mut jobs: Option<&mut Vec<IconJob>>,
) -> slint::Image {
    let raw_candidates = state::app_icon_candidates(command);
    if raw_candidates.is_empty() {
        return slint::Image::default();
    }
    let cache_key = result_icon_cache_key(&command.id, Some(&raw_candidates), None, None);
    if let Some(data_url) = icon_cache.lock().unwrap().read(&cache_key) {
        if let Some(image) = image_from_data_url(data_url) {
            return image;
        }
    }
    if let Some(jobs) = jobs.take() {
        let plan = state::plan_icon_resolution(command);
        if !plan.candidates.is_empty() {
            jobs.push(IconJob {
                cache_key,
                candidates: plan.candidates,
                invalid_icon_location_seen: plan.invalid_icon_location_seen,
            });
        }
    }
    slint::Image::default()
}

/// dataUrl（image/png / image/x-icon）→ Slint 位图；解码失败返回 `None`。
fn image_from_data_url(data_url: &str) -> Option<slint::Image> {
    let bytes = data_url_to_bytes(data_url)?;
    let decoded = image::load_from_memory(&bytes).ok()?;
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();
    let buffer = slint::SharedPixelBuffer::clone_from_slice(rgba.as_raw(), width, height);
    Some(slint::Image::from_rgba8(buffer))
}

fn hotkey_handler_for(
    field: &'static str,
    context: &Arc<AppContext>,
    screenshot: &Arc<ScreenshotController>,
) -> Box<dyn Fn() + Send> {
    match field {
        state::HOTKEY_FIELD_LAUNCHER => {
            let context = Arc::clone(context);
            Box::new(move || {
                let context = Arc::clone(&context);
                let _ = slint::invoke_from_event_loop(move || context.toggle_window());
            })
        }
        // M3 Task 7/8：截图热键 → 覆盖窗口会话（对齐 TS screenshotShortcutController
        // 的 modeByField：screenshotHotkey → capture、delayedScreenshotHotkey →
        // capture-delay-3）。
        state::HOTKEY_FIELD_SCREENSHOT => {
            let screenshot = Arc::clone(screenshot);
            Box::new(move || {
                let screenshot = Arc::clone(&screenshot);
                let _ = slint::invoke_from_event_loop(move || {
                    screenshot.start_capture(ScreenshotMode::Capture)
                });
            })
        }
        state::HOTKEY_FIELD_DELAYED_SCREENSHOT => {
            let screenshot = Arc::clone(screenshot);
            Box::new(move || {
                let screenshot = Arc::clone(&screenshot);
                let _ = slint::invoke_from_event_loop(move || {
                    screenshot.start_capture(ScreenshotMode::CaptureDelay3)
                });
            })
        }
        _ => Box::new(|| {}),
    }
}

/// 注册替换（TS `tryRegisterLauncherHotkey` / registerChangedHotkey 语义）：
/// 仅启动器字段——先注册新值，成功后注销旧值。新值解析/注册失败返回
/// `Err(())`，由纯编排层统一报错与回滚。截图字段走位移语义（见下）。
fn register_hotkey_replacement(
    hotkeys: &WindowsHotkeys,
    context: &Arc<AppContext>,
    screenshot: &Arc<ScreenshotController>,
    registrations: &Mutex<state::ScreenshotHotkeyRegistrations>,
    registration: &state::HotkeyRegistration,
) -> Result<(), ()> {
    if let Some(field) = screenshot_field_from_name(registration.field) {
        return try_register_screenshot_hotkey(
            hotkeys,
            registrations,
            context,
            screenshot,
            field,
            &registration.new_hotkey,
        )
        .then_some(())
        .ok_or(());
    }
    let accelerator = parse_accelerator(&registration.new_hotkey).map_err(|error| {
        eprintln!(
            "CommandCabin: hotkey {:?} is not registrable: {error}",
            registration.new_hotkey
        );
    })?;
    let handler = hotkey_handler_for(registration.field, context, screenshot);
    hotkeys.register(&accelerator, handler).map_err(|error| {
        eprintln!(
            "CommandCabin: hotkey registration failed for {}: {error}",
            registration.new_hotkey
        );
    })?;
    if let Ok(previous) = parse_accelerator(&registration.rollback_hotkey) {
        if previous != accelerator {
            if let Err(error) = hotkeys.unregister(&previous) {
                eprintln!("CommandCabin: unregistering replaced hotkey failed: {error}");
            }
        }
    }
    Ok(())
}

/// 回滚（TS rollbackActions：re-register 旧值，失败仅诊断）。截图字段经
/// 位移语义还原（TS 回滚动作即 tryRegisterScreenshotHotkey(field, 旧值)）。
fn restore_hotkey(
    hotkeys: &WindowsHotkeys,
    context: &Arc<AppContext>,
    screenshot: &Arc<ScreenshotController>,
    registrations: &Mutex<state::ScreenshotHotkeyRegistrations>,
    registration: &state::HotkeyRegistration,
) {
    if let Some(field) = screenshot_field_from_name(registration.field) {
        if !try_register_screenshot_hotkey(
            hotkeys,
            registrations,
            context,
            screenshot,
            field,
            &registration.rollback_hotkey,
        ) {
            eprintln!(
                "CommandCabin: restoring {} hotkey {} failed",
                registration.field, registration.rollback_hotkey
            );
        }
        return;
    }
    match parse_accelerator(&registration.rollback_hotkey) {
        Ok(accelerator) => {
            let handler = hotkey_handler_for(registration.field, context, screenshot);
            if let Err(error) = hotkeys.register(&accelerator, handler) {
                eprintln!(
                    "CommandCabin: restoring hotkey {} failed: {error}",
                    registration.rollback_hotkey
                );
            }
        }
        Err(error) => eprintln!("CommandCabin: cannot restore hotkey: {error}"),
    }
}

/// 设置字段名 → 截图热键字段（位移语义的作用域：仅两个截图字段）。
fn screenshot_field_from_name(field: &str) -> Option<state::ScreenshotHotkeyField> {
    match field {
        state::HOTKEY_FIELD_SCREENSHOT => Some(state::ScreenshotHotkeyField::Screenshot),
        state::HOTKEY_FIELD_DELAYED_SCREENSHOT => {
            Some(state::ScreenshotHotkeyField::DelayedScreenshot)
        }
        _ => None,
    }
}

/// TS `screenshotShortcutController.tryRegisterGlobalHotkey` 的执行器：决策表
/// （`state::plan_screenshot_hotkey_change`）→ WindowsHotkeys 操作 + 注册表同步。
/// 返回 false = 新注册失败（已尽力还原位移注册，目标字段保持旧值）。
///
/// 冲突文案逐字（TS registerGlobalHotkey）：warn 行 + notify 消息（设置流经
/// `hotkey_registration_error` 显示在设置窗口错误位；启动期打印 stderr）。
fn try_register_screenshot_hotkey(
    hotkeys: &WindowsHotkeys,
    registrations: &Mutex<state::ScreenshotHotkeyRegistrations>,
    context: &Arc<AppContext>,
    screenshot: &Arc<ScreenshotController>,
    field: state::ScreenshotHotkeyField,
    accelerator: &str,
) -> bool {
    let plan =
        state::plan_screenshot_hotkey_change(&registrations.lock().unwrap(), field, accelerator);
    if plan.noop {
        return true;
    }
    let new_accelerator = plan
        .register_new
        .expect("non-noop plan always registers a new accelerator");
    // 先解析新加速键：不可注册的输入不做位移（设置流 normalize 已拦截，
    // 此处为启动/直调路径的防御，语义对齐 TS register 直接失败不触及其他字段）。
    let Ok(parsed) = parse_accelerator(&new_accelerator) else {
        eprintln!(
            "CommandCabin: hotkey {new_accelerator:?} is not registrable (invalid accelerator)"
        );
        return false;
    };
    // 位移：注销另一字段的同值注册（TS displacedRegistration.dispose()）。
    if let Some((displaced_field, displaced_accelerator)) = &plan.displace {
        if let Ok(previous) = parse_accelerator(displaced_accelerator) {
            if let Err(error) = hotkeys.unregister(&previous) {
                eprintln!("CommandCabin: unregistering displaced hotkey failed: {error}");
            }
        }
        registrations.lock().unwrap().set(*displaced_field, None);
    }
    // 模式名 → 处理器字段名（Finding 1：直接传 mode_name() 会落入 no-op 回退）。
    let handler = hotkey_handler_for(
        state::screenshot_mode_to_field(field.mode_name())
            .expect("every screenshot hotkey field has a handler"),
        context,
        screenshot,
    );
    match hotkeys.register(&parsed, handler) {
        Ok(()) => {
            // 成功：注销目标字段旧值（TS hotkeyRegistration.dispose()）。
            if let Some(old) = &plan.release_old {
                if old != &new_accelerator {
                    if let Ok(previous) = parse_accelerator(old) {
                        if let Err(error) = hotkeys.unregister(&previous) {
                            eprintln!(
                                "CommandCabin: unregistering replaced hotkey failed: {error}"
                            );
                        }
                    }
                }
            }
            let mut registrations = registrations.lock().unwrap();
            if let Some((displaced_field, _)) = &plan.displace {
                registrations.set(*displaced_field, None);
            }
            registrations.set(field, Some(new_accelerator));
            true
        }
        Err(error) => {
            eprintln!("CommandCabin global hotkey conflict: failed to register {new_accelerator}.");
            eprintln!("CommandCabin: hotkey registration failed: {error}");
            eprintln!(
                "CommandCabin: {}",
                state::hotkey_registration_error(&new_accelerator)
            );
            // 还原位移注册（TS register(displacedField, 其旧加速键)）。
            if let Some((displaced_field, displaced_accelerator)) = &plan.restore_on_failure {
                if let Ok(previous) = parse_accelerator(displaced_accelerator) {
                    let handler = hotkey_handler_for(
                        state::screenshot_mode_to_field(displaced_field.mode_name())
                            .expect("every screenshot hotkey field has a handler"),
                        context,
                        screenshot,
                    );
                    if let Err(restore_error) = hotkeys.register(&previous, handler) {
                        eprintln!(
                            "CommandCabin: restoring displaced hotkey failed: {restore_error}"
                        );
                    } else {
                        registrations
                            .lock()
                            .unwrap()
                            .set(*displaced_field, Some(displaced_accelerator.clone()));
                    }
                }
            }
            false
        }
    }
}

/// 简报 2：设置更新流。顺序语义对齐 TS
/// `updateSettingsWithHotkeyRegistration`：normalize → assertUnique →
/// 先注册变更热键（失败逆序回滚并报 TS 错误文案）→ 持久化（失败同样回滚）→
/// launchAtLogin → 自启动同步；language → 托盘文案；hideOnBlur → 轮询开关。
fn apply_settings_patch(
    patch_json: &str,
    hotkeys: &WindowsHotkeys,
    context: &Arc<AppContext>,
    screenshot: &Arc<ScreenshotController>,
    autostart: &WindowsAutostart,
    tray: &WindowsTray,
) -> Result<Settings, String> {
    let mut patch = state::parse_settings_patch_json(patch_json)?;
    state::normalize_patch_hotkeys(&mut patch)?;

    let mut guard = context.state.lock().unwrap();
    state::assert_merged_hotkeys_unique(&guard.settings, &patch)?;
    let registrations = state::hotkey_registrations(&guard.settings, &patch);

    let mut persisted: Option<Result<Settings, String>> = None;
    let outcome = {
        let mut repository = SettingsRepository::new(&guard.conn);
        state::register_hotkeys_with_rollback(
            &registrations,
            |registration| {
                register_hotkey_replacement(
                    hotkeys,
                    context,
                    screenshot,
                    &context.screenshot_registrations,
                    registration,
                )
            },
            |registration| {
                restore_hotkey(
                    hotkeys,
                    context,
                    screenshot,
                    &context.screenshot_registrations,
                    registration,
                )
            },
            || {
                let result = repository.update(&patch).map_err(|error| error.to_string());
                persisted = Some(result.clone());
                result.map(|_| ())
            },
        )
    };
    outcome?;
    let updated = persisted.expect("persist ran on success")?;

    if patch.launch_at_login.is_some() {
        if let Err(error) = autostart.set_enabled(updated.launch_at_login) {
            // 设置已持久化，同步失败仅诊断（对齐 TS：不回滚已保存的设置）。
            eprintln!("CommandCabin: autostart sync failed: {error}");
        }
    }
    if patch.language.is_some() {
        let (show_text, settings_text, quit_text) = state::tray_texts(updated.language);
        tray.set_menu_texts(show_text, settings_text, quit_text);
        // 截图输出窗文案随语言热切换（M3 Task 8；OCR/翻译语言映射同步更新）。
        screenshot.set_language(updated.language);
        // 启动器首页分组头 / 固定按钮文案同受语言影响（终审 Minor：原仅
        // 启动时推送一次，会话内切语言后停留旧文案直至重启）。
        if let Some(launcher) = context.window.upgrade() {
            push_launcher_texts(&launcher, updated.language);
        }
    }
    context
        .hide_on_blur
        .store(updated.hide_on_blur, Ordering::SeqCst);
    guard.settings = updated.clone();
    drop(guard);
    // 排序权重 / 结果条数 / 首页合成可能已变化。
    context.refresh_results();
    Ok(updated)
}

/// 构造单键 JSON patch（`{"<key>": <value>}`，值经 serde_json 转义）。
fn single_key_patch(key: &str, value: serde_json::Value) -> String {
    let mut object = serde_json::Map::new();
    object.insert(key.to_string(), value);
    serde_json::Value::Object(object).to_string()
}

/// 设置窗口 / 启动器桥共用的提交入口（M2 Task 10）：走 `apply_settings_patch`
/// 完整设置流（热键注册回滚 / 持久化 / 自启动同步 / 托盘文案 / hideOnBlur /
/// 结果刷新）；无论成败都整包推送设置窗口视图（含主题与收藏），把输入框与
/// 选择收敛回生效值。返回空串语义的错误由调用方（error-text / 桥返回值）显示。
fn commit_settings_patch(
    patch_json: &str,
    hotkeys: &WindowsHotkeys,
    context: &Arc<AppContext>,
    screenshot: &Arc<ScreenshotController>,
    autostart: &WindowsAutostart,
    tray: &WindowsTray,
) -> Result<(), String> {
    let outcome = apply_settings_patch(patch_json, hotkeys, context, screenshot, autostart, tray);
    push_settings_view(context);
    outcome.map(|_| ())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let instance = WindowsSingleInstance::acquire("CommandCabin-Native")?;
    if !instance.is_primary() {
        return Ok(()); // 已有实例运行，静默退出
    }
    let login_startup = is_login_startup(&std::env::args().collect::<Vec<String>>());

    // ---- 启动序列：数据目录 → DB → 迁移 → 设置（失败即退，简报 1） ----
    let app_dir = app_data_dir().unwrap_or_else(|error| fatal(&error));
    enable_diag_log(&app_dir);
    install_panic_logger();
    let conn = open_database(&app_dir).unwrap_or_else(|error| fatal(&error));
    run_migrations(&conn)
        .unwrap_or_else(|error| fatal(&format!("database migration failed: {error}")));
    let settings = SettingsRepository::new(&conn)
        .get()
        .unwrap_or_else(|error| fatal(&format!("settings are unreadable: {error}")));

    // ---- 图标磁盘缓存 + flush 调度 ----
    let icon_cache = Arc::new(Mutex::new(IconDiskCache::load(
        &app_dir.join(ICON_CACHE_FILE_NAME),
    )));
    let flush_signal = spawn_flush_scheduler(Arc::clone(&icon_cache));

    let state = Arc::new(Mutex::new(AppState {
        settings: settings.clone(),
        engine: SearchEngine::new(Vec::new()),
        commands_by_id: HashMap::new(),
        app_command_ids: HashSet::new(),
        pinned_app_commands: Vec::new(),
        pinned_app_command_ids: HashSet::new(),
        pinned_shortcut_keys: HashSet::new(),
        // 汇率缓存（TS join(userDataPath, 'exchange-rates.json')）：惰性读盘。
        rate_cache: ExchangeRateCache::load(&app_dir.join(EXCHANGE_RATE_CACHE_FILE_NAME)),
        rate_fetch_in_flight: false,
        // 剪贴板历史命令在首个非空查询时装载（TS 服务创建即装载 + 每查询
        // version 检查；脏标记初值 true 承担首次装载）。
        clipboard_command_ids: HashSet::new(),
        clipboard_commands_dirty: true,
        clipboard_poll_state: PollState::default(),
        clipboard_read_failed: false,
        // 更新编排（M5 Task 3）：debug 构建禁用（TS isPackaged 等价，见
        // updates_enabled 注释）。
        update: updater_controller::UpdateOrchestration::new(updates_enabled()),
        // 首页磁贴选中（UI 修复 2）：随 render_results 复位/钳制。
        selected_tile: None,
        conn,
    }));

    // ---- 收藏命令装载（pinned app 命令保持收藏顺序；M2 Task 10 起经统一的
    // reload_favorites，固定/取消固定后复用同一路径重载） ----
    {
        let mut guard = state.lock().unwrap();
        if let Err(error) = guard.reload_favorites() {
            eprintln!("CommandCabin: favorites are unreadable, starting without them: {error}")
        }
    }

    // ---- 截图系统命令（M3 Task 9；TS createScreenshotCommands）：启动器搜索
    // 的四个截图入口（capture / delay-3 / delay-5 / ocr，source=system）。
    // reload_favorites / replace_app_commands 的整体替换只按各自 id 集合增删，
    // 系统命令常驻 commands_by_id，随其后的 rebuild_engine 进入搜索索引；
    // 历史记录不含系统命令（state::should_record_execution 仅收藏/app 命令）。
    {
        let mut guard = state.lock().unwrap();
        for command in screenshot_system_commands() {
            guard.commands_by_id.insert(command.id.clone(), command);
        }
        guard.rebuild_engine();
    }

    // ---- 文本工具静态命令（M4 Task 7；TS createTextToolCommands）：六个静态
    // 表命令在服务创建时一次性注册进 registry（TS launcherCommandService 构造
    // 期调用），与截图系统命令同属静态池——text-tools 非"每次查询生成"的动态
    // 命令，calculator/quick-converter 才是（见 state::dynamic_slot_plan）。
    // 执行分支在 RunSystem handler 的 text-tools 段（读剪贴板 → 变换 → 回写）。
    {
        let mut guard = state.lock().unwrap();
        for command in create_text_tool_commands() {
            guard.commands_by_id.insert(command.id.clone(), command);
        }
        guard.rebuild_engine();
    }

    // ---- 自启动与设置同步（对齐 TS index.ts:300 启动同步） ----
    // Rc 包装：设置更新桥闭包要求 'static（Slint 回调，不要求 Send），所有权经
    // Rc 共享；三者在整个生命周期内只在 main（UI）线程构造、使用与析构。
    let exe_path = std::env::current_exe()
        .unwrap_or_else(|error| fatal(&format!("cannot locate running executable: {error}")));
    let autostart = Rc::new(WindowsAutostart::new(exe_path));
    if let Err(error) = autostart.set_enabled(settings.launch_at_login) {
        // 同步失败不阻断启动（设置未被改动），仅诊断。
        eprintln!("CommandCabin: autostart sync failed: {error}");
    }

    // ---- 托盘（主线程构造；文案按设置语言，含"设置"菜单项打开设置窗口） ----
    let icon_png: &[u8] = include_bytes!("../../../assets/icon.png");
    let (show_text, settings_text, quit_text) = state::tray_texts(settings.language);
    let tray = Rc::new(WindowsTray::new(
        icon_png,
        "CommandCabin",
        show_text,
        settings_text,
        quit_text,
    )?);
    let tray_events = tray.take_events();

    // ---- 窗口（启动器 + 设置 + 截图覆盖；设置窗口隐藏，经托盘"设置"打开）/
    // 执行器 / 提取器 / 上下文 ----
    let window = LauncherWindow::new()?;
    let weak = window.as_weak();
    let settings_window = SettingsWindow::new()?;
    let settings_weak = settings_window.as_weak();
    let screenshot_window = ScreenshotWindow::new()?;
    let screenshot_weak = screenshot_window.as_weak();
    push_screenshot_texts(&screenshot_window, settings.language);

    // 截图系统命令的执行器绑定槽（M3 Task 9）：执行器在此处构造，而截图
    // 控制器在其后创建（restore 钩子需要 AppContext），经 OnceLock 延迟绑定。
    // 执行只发生在 UI 线程（execute_selected 为 Slint 回调），start_capture
    // 直接调用即可（热键路径才需要 invoke_from_event_loop 回 UI 线程）。
    let screenshot_entry: Arc<OnceLock<Arc<ScreenshotController>>> = Arc::new(OnceLock::new());
    let executor = {
        let mut executor = CommandExecutor::new();
        for action_type in [
            CommandActionType::OpenApp,
            CommandActionType::OpenPath,
            CommandActionType::OpenUrl,
        ] {
            executor.register_handler(
                action_type,
                // 参数类型必须显式标注：Box<dyn CommandActionHandler> 经 blanket impl
                // 由 Fn 闭包实现，类型推导无法穿过自定义 trait 对象得到闭包签名。
                Box::new(move |command: &Command| {
                    let target = controller::launch_target_for(
                        &command.action.action_type,
                        &command.action.payload,
                    )
                    .map_err(Box::<dyn std::error::Error + Send + Sync>::from)?;
                    // WindowsLauncher 是零大小单元结构，按调用构造；捕获 Rc 会让闭包
                    // 失去 Send + Sync，无法满足 CommandActionHandler 的 bound。
                    WindowsLauncher::new().open(&target).map_err(|error| {
                        Box::<dyn std::error::Error + Send + Sync>::from(error.to_string())
                    })?;
                    Ok(None)
                }),
            );
        }
        // copy-text → 写剪贴板（对齐 TS：payload.text，缺省空串）。
        executor.register_handler(
            CommandActionType::CopyText,
            Box::new(|command: &Command| {
                let text = command
                    .action
                    .payload
                    .get("text")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string();
                let mut clipboard = arboard::Clipboard::new().map_err(|error| {
                    Box::<dyn std::error::Error + Send + Sync>::from(error.to_string())
                })?;
                clipboard.set_text(text).map_err(|error| {
                    Box::<dyn std::error::Error + Send + Sync>::from(error.to_string())
                })?;
                Ok(None)
            }),
        );
        // run-system → 文本工具（M4 Task 7，TS 'run-system' handler 的
        // getTextToolTransformKind 分支：读剪贴板 → applyTextTransform →
        // 回写剪贴板；pluginId 校验逐字）与截图系统命令（M3 Task 9，TS
        // index.ts runScreenshotSystemCommand：payload.command → mode → start）。
        // 未知 payload 与 TS 一样以执行失败告终（Unsupported screenshot command）。
        {
            let screenshot_entry = Arc::clone(&screenshot_entry);
            executor.register_handler(
                CommandActionType::RunSystem,
                Box::new(move |command: &Command| {
                    if let Some(kind) = get_text_tool_transform_kind(&command.id) {
                        if command.plugin_id.as_deref() != Some(TEXT_TOOLS_PLUGIN_ID) {
                            return Err("Invalid text tools command registration.".into());
                        }
                        // TS clipboard.readText() 对非文本返回 ''；读侧 Ok(None)
                        // 等价折叠为空串参与变换。
                        let input = ArboardClipboardReader::new()
                            .read_text()
                            .map_err(|error| {
                                Box::<dyn std::error::Error + Send + Sync>::from(error.to_string())
                            })?
                            .unwrap_or_default();
                        let output = apply_text_transform(kind, &input).map_err(|error| {
                            Box::<dyn std::error::Error + Send + Sync>::from(
                                error.message().to_string(),
                            )
                        })?;
                        ArboardClipboard::new().copy_text(output).map_err(|error| {
                            Box::<dyn std::error::Error + Send + Sync>::from(error.to_string())
                        })?;
                        return Ok(None);
                    }
                    let payload = command
                        .action
                        .payload
                        .get("command")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default();
                    let Some(mode) = screenshot_mode_for_system_command(payload) else {
                        return Err(format!("Unsupported screenshot command: {payload}").into());
                    };
                    let Some(controller) = screenshot_entry.get() else {
                        return Err("Screenshot controller is not initialized.".into());
                    };
                    controller.start_capture(mode);
                    Ok(None)
                }),
            );
        }
        executor
    };

    // 提取完成 → 唤醒 UI 重放缓存（只读，不重复投递）。
    let replay_state = Arc::clone(&state);
    let replay_cache = Arc::clone(&icon_cache);
    let replay_window = weak.clone();
    let on_extracted: Box<dyn Fn() + Send + 'static> = Box::new(move || {
        let state = Arc::clone(&replay_state);
        let icon_cache = Arc::clone(&replay_cache);
        let window = replay_window.clone();
        let _ = slint::invoke_from_event_loop(move || {
            render_results(&window, &state, &icon_cache, None, false);
        });
    });
    let extractor =
        IconExtractor::spawn(Arc::clone(&icon_cache), flush_signal.clone(), on_extracted);

    let hide_on_blur = Arc::new(AtomicBool::new(settings.hide_on_blur));
    // 截图控制器钩子的窗口句柄（context 会按值收走 weak，先克隆给 hide 钩子）。
    let hide_launcher_weak = weak.clone();
    let hide_settings_weak = settings_weak.clone();
    let context = Arc::new(AppContext {
        window: weak,
        settings_window: settings_weak,
        screenshot_window: screenshot_weak,
        state: Arc::clone(&state),
        icon_cache: Arc::clone(&icon_cache),
        extractor,
        hide_on_blur: Arc::clone(&hide_on_blur),
        focused_since_shown: AtomicBool::new(false),
        screenshot_registrations: Mutex::new(state::ScreenshotHotkeyRegistrations::default()),
        executor,
    });

    // ---- 截图覆盖窗口控制器（M3 Task 7/8）：捕获前隐藏自身窗口（返回是否
    // 确有窗口被隐藏，决定 16ms 捕获面稳定延迟）、会话收束后恢复启动器
    //（Weak<AppContext> 打破 controller ↔ context 的 Arc 环）。
    // 回调各自捕获 Arc<ScreenshotController>（Send，供热键线程 invoke）。 ----
    let screenshot_controller = {
        let context = Arc::downgrade(&context);
        ScreenshotController::new(
            screenshot_window.as_weak(),
            Box::new(move || {
                let mut hidden_any = false;
                if let Some(window) = hide_launcher_weak.upgrade() {
                    // TS shouldHideWindowForScreenshot：仅可见窗口参与隐藏判定。
                    if window.window().is_visible() {
                        let _ = window.hide();
                        hidden_any = true;
                    }
                }
                if let Some(window) = hide_settings_weak.upgrade() {
                    if window.window().is_visible() {
                        let _ = window.hide();
                        hidden_any = true;
                    }
                }
                hidden_any
            }),
            Box::new(move || {
                if let Some(context) = context.upgrade() {
                    AppContext::show_launcher_window(&context);
                }
            }),
        )
    };
    screenshot_controller.set_language(settings.language);
    // 绑定截图系统命令的执行目标（构造序注释见 screenshot_entry 声明处）。
    // unwrap_or_else 而非 expect：OnceLock::set 的 Err 载有原值，expect 会要求
    // Arc<ScreenshotController> 实现 Debug（控制器有意未派生）。
    screenshot_entry
        .set(Arc::clone(&screenshot_controller))
        .unwrap_or_else(|_| panic!("screenshot entry should bind exactly once"));
    {
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window.on_pointer_down(move |x, y| controller.on_pointer_down(x, y));
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window.on_pointer_move(move |x, y| controller.on_pointer_move(x, y));
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window.on_pointer_up(move |x, y| controller.on_pointer_up(x, y));
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window.on_pointer_cancel(move || controller.on_pointer_cancel());
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window.on_tool_selected(move |index| controller.on_tool_selected(index));
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window.on_color_selected(move |color| controller.on_color_selected(color));
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window
            .on_line_width_selected(move |width| controller.on_line_width_selected(width));
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window.on_font_size_selected(move |size| controller.on_font_size_selected(size));
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window.on_undo_requested(move || controller.on_undo());
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window.on_redo_requested(move || controller.on_redo());
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window.on_ocr_requested(move || controller.on_ocr());
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window.on_translate_requested(move || controller.on_translate());
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window.on_pin_requested(move || controller.on_pin());
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window.on_save_requested(move || controller.on_save());
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window.on_finish_requested(move || controller.on_finish());
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window.on_cancel_requested(move || controller.on_cancel());
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window.on_commit_text(move |value| controller.on_commit_text(value.to_string()));
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window.on_cancel_prompt(move || controller.on_cancel_prompt());
        let controller = Arc::clone(&screenshot_controller);
        screenshot_window.on_ocr_copy_all_requested(move || controller.on_ocr_copy_all());
    }

    // 设置窗口标题栏关闭 → 隐藏（不销毁：后续托盘"设置"再次 show）。
    {
        let settings_weak = context.settings_window.clone();
        settings_window.window().on_close_requested(move || {
            if let Some(window) = settings_weak.upgrade() {
                let _ = window.hide();
            }
            slint::CloseRequestResponse::KeepWindowShown
        });
    }
    // 首屏视图推送：文案（按设置语言）+ 值快照 + 收藏 + 主题（两个窗口）。
    push_settings_view(&context);

    // ---- 启动期热键（简报 1 + M3 Task 8 项 1）：launcher 热键（失败=退出并
    // 诊断）+ 两个截图热键（screenshotHotkey → capture、delayedScreenshotHotkey
    // → capture-delay-3；失败=非致命，仅 warn + 冲突提示消息——对齐 TS
    // screenshotShortcutController.start()：注册不上的字段保持未注册，应用继续）。
    let hotkeys = Rc::new(WindowsHotkeys::new()?);
    let launcher_accelerator = parse_accelerator(&settings.hotkey).unwrap_or_else(|error| {
        fatal(&format!(
            "stored launcher hotkey {:?} is invalid: {error}",
            settings.hotkey
        ))
    });
    {
        let context = Arc::clone(&context);
        if let Err(error) = hotkeys.register(
            &launcher_accelerator,
            Box::new(move || {
                let context = Arc::clone(&context);
                let _ = slint::invoke_from_event_loop(move || context.toggle_window());
            }),
        ) {
            fatal(&format!(
                "could not register launcher hotkey {}: {error}",
                settings.hotkey
            ));
        }
    }
    {
        for (field, accelerator) in [
            (
                state::ScreenshotHotkeyField::Screenshot,
                settings.screenshot_hotkey.clone(),
            ),
            (
                state::ScreenshotHotkeyField::DelayedScreenshot,
                settings.delayed_screenshot_hotkey.clone(),
            ),
        ] {
            let registered = try_register_screenshot_hotkey(
                &hotkeys,
                &context.screenshot_registrations,
                &context,
                &screenshot_controller,
                field,
                &accelerator,
            );
            if !registered {
                // TS notifyHotkeyConflict（showErrorBox）在 M3 的等价出口：
                // 统一诊断通道；应用照常运行（字段保持未注册，设置流可重试）。
                eprintln!(
                    "CommandCabin: screenshot shortcut conflict at startup: {}",
                    state::hotkey_registration_error(&accelerator)
                );
            }
        }
    }

    // ---- 输入变更 → 搜索 → 更新结果列表。 ----
    {
        let context = Arc::clone(&context);
        window.on_query_changed(move |query| {
            let Some(window) = context.window.upgrade() else {
                return;
            };
            window.set_current_query(query);
            context.refresh_results();
        });
    }
    // ↑/↓ 循环移动选择（跳过首页分组头行，M2 Task 10）。
    {
        let context = Arc::clone(&context);
        window.on_move_selection(move |delta| {
            let Some(window) = context.window.upgrade() else {
                return;
            };
            let count = window.get_results().row_count() as i32;
            let start = window.get_selected_index();
            if count == 0 {
                return;
            }
            // 最多绕一圈找下一个可执行（command-id 非空）的行。
            for step in 1..=count {
                let candidate = (start + delta * step).rem_euclid(count);
                let Some(row) = window.get_results().row_data(candidate as usize) else {
                    continue;
                };
                if !row.command_id.is_empty() {
                    window.set_selected_index(candidate);
                    return;
                }
            }
        });
    }
    // Enter / 点击 → 执行选中命令；成功（且满足记录条件）后写历史并隐藏窗口。
    {
        let context = Arc::clone(&context);
        window.on_execute_selected(move || context.execute_selected());
    }
    // 首页磁贴网格四向键盘导航（UI 修复 2）：dx/dy ∈ {-1,0,1}（单轴）。
    // 边界钳制（列边界/首末行不回绕）在决策表 state::move_tile_selection；
    // 撞边界保持原选中（不回推属性，高亮不动）。
    {
        let context = Arc::clone(&context);
        window.on_move_tile_selection(move |dx, dy| {
            let Some(window) = context.window.upgrade() else {
                return;
            };
            let count =
                window.get_pinned_tiles().row_count() + window.get_pinned_tiles_row_2().row_count();
            let mut guard = context.state.lock().unwrap();
            let current = guard.selected_tile.unwrap_or(0);
            if let Some(next) = state::move_tile_selection(dx as isize, dy as isize, current, count)
            {
                guard.selected_tile = Some(next);
                window.set_selected_tile(next as i32);
            }
        });
    }
    // Esc → 隐藏窗口。
    {
        let context = Arc::clone(&context);
        window.on_dismissed(move || context.hide_window());
    }
    // 设置更新桥（M2 Task 9/10）：JSON patch → 完整 TS 顺序语义；返回错误文案
    // （空串=成功）。启动器与设置窗口共用 commit_settings_patch。
    {
        let context = Arc::clone(&context);
        let hotkeys = Rc::clone(&hotkeys);
        let autostart = Rc::clone(&autostart);
        let tray = Rc::clone(&tray);
        let screenshot = Arc::clone(&screenshot_controller);
        window.on_apply_settings(move |patch_json| {
            match commit_settings_patch(
                patch_json.as_str(),
                &hotkeys,
                &context,
                &screenshot,
                &autostart,
                &tray,
            ) {
                Ok(()) => "".into(),
                Err(message) => message.into(),
            }
        });
    }
    // "固定到首页"（M2 Task 10）：写 favorites 并刷新首页。
    {
        let context = Arc::clone(&context);
        window.on_pin_app(move |command_id| context.pin_app(command_id.as_str()));
    }
    // 首页固定磁贴点击执行（UI 修复 1）：commands_by_id 直查（见
    // execute_command_by_id 的 radar 注）。
    {
        let context = Arc::clone(&context);
        window.on_run_command_id(move |command_id| {
            context.execute_command_by_id(command_id.as_str());
        });
    }
    // 首页功能截图入口（UI 修复 3）：与截图热键同一条 start_capture(Capture)
    // 路径（回调在 UI 线程，无需 invoke_from_event_loop）。
    {
        let screenshot = Arc::clone(&screenshot_controller);
        window.on_run_screenshot(move || screenshot.start_capture(ScreenshotMode::Capture));
    }

    // ---- 设置窗口提交回调（M2 Task 10）。提交语义见 settings.slint 头注：
    // 字段经 JSON patch 走完整设置流；回调返回错误文案（空串=成功）。 ----
    {
        let context = Arc::clone(&context);
        let hotkeys = Rc::clone(&hotkeys);
        let autostart = Rc::clone(&autostart);
        let tray = Rc::clone(&tray);
        let screenshot = Arc::clone(&screenshot_controller);
        settings_window.on_commit_hotkey(move |section| {
            let Some(window) = context.settings_window.upgrade() else {
                return "".into();
            };
            let (key, value) = match section {
                0 => ("hotkey", window.get_hotkey_launcher().to_string()),
                1 => (
                    "screenshotHotkey",
                    window.get_hotkey_screenshot().to_string(),
                ),
                _ => (
                    "delayedScreenshotHotkey",
                    window.get_hotkey_delayed().to_string(),
                ),
            };
            let patch = single_key_patch(key, value.into());
            match commit_settings_patch(&patch, &hotkeys, &context, &screenshot, &autostart, &tray)
            {
                Ok(()) => "".into(),
                Err(message) => message.into(),
            }
        });
    }
    {
        let context = Arc::clone(&context);
        let hotkeys = Rc::clone(&hotkeys);
        let autostart = Rc::clone(&autostart);
        let tray = Rc::clone(&tray);
        let screenshot = Arc::clone(&screenshot_controller);
        settings_window.on_commit_number(move |section| {
            let Some(window) = context.settings_window.upgrade() else {
                return "".into();
            };
            let Some(field) = state::NumericField::from_index(section as u32) else {
                return "".into();
            };
            let value = match section {
                0 => window.get_max_results().to_string(),
                1 => window.get_history_boost().to_string(),
                2 => window.get_plugin_boost().to_string(),
                3 => window.get_app_boost().to_string(),
                _ => window.get_file_boost().to_string(),
            };
            let patch = match state::numeric_field_patch_json(field, &value) {
                Ok(patch) => patch,
                Err(message) => return message.into(),
            };
            match commit_settings_patch(&patch, &hotkeys, &context, &screenshot, &autostart, &tray)
            {
                Ok(()) => "".into(),
                Err(message) => message.into(),
            }
        });
    }
    {
        let context = Arc::clone(&context);
        let hotkeys = Rc::clone(&hotkeys);
        let autostart = Rc::clone(&autostart);
        let tray = Rc::clone(&tray);
        let screenshot = Arc::clone(&screenshot_controller);
        settings_window.on_set_switch(move |kind, enabled| {
            let key = match kind {
                0 => "hideOnBlur",
                1 => "launchAtLogin",
                _ => "preserveSearchQuery",
            };
            let patch = single_key_patch(key, enabled.into());
            match commit_settings_patch(&patch, &hotkeys, &context, &screenshot, &autostart, &tray)
            {
                Ok(()) => "".into(),
                Err(message) => message.into(),
            }
        });
    }
    {
        let context = Arc::clone(&context);
        let hotkeys = Rc::clone(&hotkeys);
        let autostart = Rc::clone(&autostart);
        let tray = Rc::clone(&tray);
        let screenshot = Arc::clone(&screenshot_controller);
        settings_window.on_set_choice(move |kind, index| {
            let patch = if kind == 0 {
                state::theme_patch_json(index as u32)
            } else {
                state::language_patch_json(index as u32)
            };
            let patch = match patch {
                Ok(patch) => patch,
                Err(message) => return message.into(),
            };
            match commit_settings_patch(&patch, &hotkeys, &context, &screenshot, &autostart, &tray)
            {
                Ok(()) => "".into(),
                Err(message) => message.into(),
            }
        });
    }
    {
        let context = Arc::clone(&context);
        settings_window.on_remove_favorite(move |index| {
            context.remove_favorite(index as usize);
        });
    }
    {
        // 清空剪贴板历史（M4 Task 7；TS CLEAR_CLIPBOARD_HISTORY_CHANNEL +
        // ClipboardHistorySettings 交互：成功无消息、失败显示 clearError 文案）。
        let context = Arc::clone(&context);
        settings_window.on_clear_clipboard_history(move || {
            // 先绑定结果再 match：MutexGuard 临时值在 match 审查表达式中会存活
            // 到整个 match 结束，而 Ok 臂 refresh_results → render_results 与
            // Err 臂的错误文案都要重取 state 锁——直接 match 会自死锁。
            let result = {
                let mut guard = context.state.lock().unwrap();
                guard.clear_clipboard_history()
            };
            let status = match result {
                Ok(_) => {
                    // 剪贴板命令已从引擎下线，刷新当前结果列表。
                    context.refresh_results();
                    SharedString::default()
                }
                Err(error) => {
                    eprintln!("CommandCabin: clearing clipboard history failed: {error}");
                    let guard = context.state.lock().unwrap();
                    SharedString::from(i18n::clipboard_clear_error(guard.settings.language))
                }
            };
            if let Some(window) = context.settings_window.upgrade() {
                window.set_clipboard_clear_status(status);
            }
        });
    }
    {
        let context = Arc::clone(&context);
        settings_window.on_dismissed(move || context.hide_settings_window());
    }
    // ---- 更新编排入口（M5 Task 3）：设置 About 的检查/下载/重启安装与启动器
    // 横幅的立即安装/查看设置，全部汇入同一组编排函数。 ----
    {
        let context = Arc::clone(&context);
        settings_window.on_check_updates(move || start_update_check(&context, true));
    }
    {
        let context = Arc::clone(&context);
        settings_window.on_download_update(move || start_update_download(&context));
    }
    {
        let context = Arc::clone(&context);
        settings_window.on_install_update(move || install_downloaded_update(&context));
    }
    {
        let context = Arc::clone(&context);
        window.on_install_update(move || install_downloaded_update(&context));
    }
    {
        let context = Arc::clone(&context);
        window.on_open_update_settings(move || context.show_settings_window());
    }
    // 标题栏设置齿轮（UI 复刻轮）：与托盘"设置"/横幅"查看设置"同一条
    // show_settings_window 路径（整包推送快照后显示设置窗口）。
    {
        let context = Arc::clone(&context);
        window.on_open_settings(move || context.show_settings_window());
    }

    // ---- 后台索引扫描，完成后回 UI 线程替换 app 命令并刷新。 ----
    {
        let context = Arc::clone(&context);
        std::thread::spawn(move || {
            let scan = WindowsStartMenuIndexer::new().scan();
            let shortcut_commands = commands_from_shortcuts(&scan.shortcuts);
            // UI 修复 4（Issue A）：MSIX/APPX 打包应用（商店应用，开始菜单无
            // .lnk）经 PackageManager 枚举为命令（open-app +
            // shell:AppsFolder\{AUMID}）；UI 修复 7（用户实测飞书重复）：
            // merge_app_commands 补齐 TS dedupeAppCommands 的 identity 键去重
            //（title+exe/aumid+args+workdir），桌面与开始菜单指向同一 exe 的
            // 双 .lnk 合并为一条。单包失败只记诊断，不中断其余应用。
            let packaged = enumerate_packaged_apps();
            for failure in &packaged.failures {
                eprintln!("CommandCabin: packaged app entry skipped: {failure}");
            }
            let packaged_commands = commands_from_packaged_apps(&packaged.apps);
            let commands = merge_app_commands(shortcut_commands, packaged_commands);
            let _ = slint::invoke_from_event_loop(move || {
                context.state.lock().unwrap().replace_app_commands(commands);
                context.refresh_results();
            });
        });
    }

    // ---- 托盘事件："显示" → 呼出窗口；"设置" → 打开设置窗口（M2 Task 10）；
    // "退出" → 退出事件循环。 ----
    {
        let context = Arc::clone(&context);
        std::thread::spawn(move || {
            let Some(events) = tray_events else {
                return;
            };
            for event in events {
                match event {
                    TrayEvent::Show => {
                        let context = Arc::clone(&context);
                        let _ = slint::invoke_from_event_loop(move || context.show_window());
                    }
                    TrayEvent::Settings => {
                        let context = Arc::clone(&context);
                        let _ =
                            slint::invoke_from_event_loop(move || context.show_settings_window());
                    }
                    TrayEvent::Quit => {
                        let _ = slint::quit_event_loop();
                        break;
                    }
                }
            }
        });
    }

    // ---- hideOnBlur（简报 5）：Slint 无失焦回调，经 winit `has_focus` 以
    // 200ms 轮询为最近等价实现；开关由设置（启动 + patch 流）驱动。隐藏决策
    // 在 `state::hide_on_blur_poll_step`（可单测）：仅在“呼出后已观测到焦点 →
    // 失焦”的转移沿隐藏，与 TS BrowserWindow blur 只在焦点转移沿触发对齐，
    // 避免 focus_window 被前台锁延迟/拒绝时闪隐刚呼出的窗口。
    // M3 Task 7 门控：轮询只检查启动器窗口（截图覆盖窗口合法地长期失焦，
    // TS hideLauncherWindowsForScreenshot 语义下覆盖会话期间不参与轮询，
    // 会话活跃标记直接短路，防止恢复呼出后的轮询与截图流程交错）。 ----
    let hide_on_blur_timer = slint::Timer::default();
    {
        let context = Arc::clone(&context);
        let screenshot = Arc::clone(&screenshot_controller);
        hide_on_blur_timer.start(
            slint::TimerMode::Repeated,
            Duration::from_millis(HIDE_ON_BLUR_POLL_MS),
            move || {
                // 截图会话活跃（含捕获 worker 进行中）：跳过本轮轮询。
                if screenshot.is_session_active() {
                    return;
                }
                let Some(window) = context.window.upgrade() else {
                    return;
                };
                if !window.window().is_visible() {
                    return;
                }
                // winit 句柄不可用时按“仍聚焦”处理（不隐藏）。
                let focused = window
                    .window()
                    .with_winit_window(|winit_window| winit_window.has_focus())
                    .unwrap_or(true);
                let (should_hide, focused_since_shown) = state::hide_on_blur_poll_step(
                    context.hide_on_blur.load(Ordering::SeqCst),
                    context.focused_since_shown.load(Ordering::SeqCst),
                    focused,
                );
                context
                    .focused_since_shown
                    .store(focused_since_shown, Ordering::SeqCst);
                if should_hide {
                    window.hide().expect("hide launcher");
                }
            },
        );
    }

    // ---- 剪贴板历史轮询（M4 Task 7）：watcher.rs 契约的定时器所有者——
    // Slint Timer 在 UI 线程以 DEFAULT_CLIPBOARD_WATCH_INTERVAL_MS（1000ms，
    // TS DEFAULT_CLIPBOARD_WATCH_INTERVAL_MS）驱动 poll_step；决策/去重语义在
    // core 单测锁定。TS start() 的注册即拍由 single_shot 补齐。 ----
    let clipboard_watch_timer = slint::Timer::default();
    {
        let poll_state = Arc::clone(&state);
        clipboard_watch_timer.start(
            slint::TimerMode::Repeated,
            Duration::from_millis(DEFAULT_CLIPBOARD_WATCH_INTERVAL_MS),
            move || clipboard_poll_once(&poll_state),
        );
        let first_poll_state = Arc::clone(&state);
        slint::Timer::single_shot(Duration::ZERO, move || {
            clipboard_poll_once(&first_poll_state)
        });
    }

    // ---- 更新自动检查（M5 Task 3；TS startAutomaticCheck 逐语义）：启动后
    // 立即一次 + 6h 间隔（TS defaultAutomaticCheckIntervalMs 逐字；TS 无启动
    // 延迟，事件循环内 ZERO 拍等价其 createApplicationWindow 尾部直调）。检查
    // 本体在工作线程，准入/转移决策在 UI 线程纯函数。 ----
    {
        // 进程中途退出遗留的下载半成品清理（Task 1-2 交接；目录不存在为合法首装态）。
        let stale = updater_controller::sweep_stale_partials(
            &updater_controller::update_download_dir(&std::env::temp_dir()),
        );
        if stale > 0 {
            eprintln!("CommandCabin: removed {stale} stale update download temp file(s)");
        }
    }
    let update_check_timer = slint::Timer::default();
    {
        let interval_context = Arc::clone(&context);
        update_check_timer.start(
            slint::TimerMode::Repeated,
            Duration::from_millis(updater_controller::AUTOMATIC_CHECK_INTERVAL_MS),
            move || start_update_check(&interval_context, false),
        );
        let first_check_context = Arc::clone(&context);
        slint::Timer::single_shot(Duration::ZERO, move || {
            start_update_check(&first_check_context, false)
        });
    }

    // ---- 正常启动（非登录启动）直接呼出，对齐 TS showWindow 语义。 ----
    if !login_startup {
        let context = Arc::clone(&context);
        slint::Timer::single_shot(Duration::ZERO, move || {
            context.show_window();
        });
    }

    // ---- 调试冒烟入口（M3 Task 7）：COMMAND_CABIN_DEBUG_SCREENSHOT=1 时，
    // 启动 1.5s 后程序化触发一次即时截图会话（Task 8 落地热键编排前的
    // 可验证路径；常规入口仍为设置流注册的截图热键）。 ----
    if std::env::var("COMMAND_CABIN_DEBUG_SCREENSHOT").as_deref() == Ok("1") {
        let screenshot = Arc::clone(&screenshot_controller);
        slint::Timer::single_shot(Duration::from_millis(1500), move || {
            screenshot.start_capture(ScreenshotMode::Capture);
        });
    }

    // 窗口初始可能隐藏，故不能用 window.run()（它会先 show 窗口）；
    // run_event_loop_until_quit 不依赖可见窗口保活，直到托盘“退出”调 quit_event_loop。
    // 返回后在本（UI）线程注销热键并析构 tray/hotkeys，满足线程亲和约定。
    slint::run_event_loop_until_quit()?;
    hotkeys.unregister_all()?;
    // 收尾：丢弃调度信号通道（调度线程断开后补一次 flush），再显式兜底 flush。
    drop(flush_signal);
    let _ = icon_cache.lock().unwrap().flush();
    // 两个 Timer 均须存活至事件循环结束。
    let _ = hide_on_blur_timer;
    let _ = clipboard_watch_timer;
    let _ = update_check_timer;
    Ok(())
}

/// 查询管线集成测试（M4 Task 7）：动态槽 × 静态池的引擎合并、剪贴板降级与
/// watcher → 仓储落库链路（main.rs 是 bin crate，`#[cfg(test)]` 模块随
/// `cargo test -p cabin-app` 运行；Slint 粘合层不可实例化，此处只覆盖纯逻辑
/// 与仓储组合，UI 冒烟走 build.ps1 + 人工路径）。
#[cfg(test)]
mod query_pipeline_tests {
    use super::*;
    use cabin_core::command::types::{
        CommandAction, CommandActionType, CommandPayload, CommandSource,
    };
    use cabin_core::features::exchange_rate::ExchangeRatePeek;
    fn app_command(id: &str, title: &str, keywords: &[&str]) -> Command {
        Command {
            id: id.into(),
            source: CommandSource::App,
            title: title.into(),
            subtitle: None,
            keywords: keywords.iter().map(|k| k.to_string()).collect(),
            icon: None,
            plugin_id: None,
            action: CommandAction {
                action_type: CommandActionType::OpenApp,
                payload: CommandPayload::new(),
            },
        }
    }

    /// 静态池（TS 服务创建期装载的等价物）：text-tools 六命令 + 一条 app 命令。
    fn static_pool() -> SearchEngine {
        let mut engine = SearchEngine::new(Vec::new());
        engine.upsert(app_command(
            "app.editor",
            "Alpha Editor",
            &["alpha", "编辑器"],
        ));
        for command in create_text_tool_commands() {
            engine.upsert(command);
        }
        engine
    }

    /// AppState::query_results 的引擎层等价（不含仓储/汇率 IO；rate = Missing）。
    fn run_query(mut engine: SearchEngine, query: &str, limit: usize) -> Vec<String> {
        let plan = state::dynamic_slot_plan(query, ExchangeRatePeek::Missing);
        match plan.calculator {
            Some(command) => engine.upsert(command),
            None => {
                engine.remove(CALCULATOR_RESULT_COMMAND_ID);
            }
        }
        match plan.converter {
            Some(command) => engine.upsert(command),
            None => {
                engine.remove(QUICK_CONVERTER_RESULT_COMMAND_ID);
            }
        }
        let results = engine
            .search(
                query,
                SearchOptions {
                    limit: Some(limit),
                    include_all_on_empty_query: Some(false),
                    ranking: None,
                },
            )
            .into_iter()
            .map(|item| item.command)
            .collect::<Vec<_>>();
        state::demote_clipboard_history_results(query, results, limit)
            .into_iter()
            .map(|command| command.id)
            .collect()
    }

    fn clipboard_engine(entries: &[i64]) -> SearchEngine {
        let mut engine = static_pool();
        let entries = entries
            .iter()
            .map(|&id| ClipboardHistoryEntry {
                id,
                text: format!("alpha paste {id}"),
                copied_at: "2026-09-04T00:00:00.000Z".into(),
            })
            .collect::<Vec<_>>();
        for command in create_clipboard_history_commands(&entries) {
            engine.upsert(command);
        }
        engine
    }

    #[test]
    fn math_query_surfaces_calculator_above_static_pool() {
        let ids = run_query(static_pool(), "1+1", 10);
        assert_eq!(ids.first().map(String::as_str), Some("calculator.result"));
        // 静态池命令不因 "1+1" 入榜。
        assert!(!ids.iter().any(|id| id.starts_with("text-tools.")));
    }

    #[test]
    fn static_conversion_query_surfaces_converter_only() {
        let ids = run_query(static_pool(), "1厘米", 10);
        assert_eq!(
            ids.first().map(String::as_str),
            Some("quick-converter.result")
        );
        assert!(!ids.iter().any(|id| id == "calculator.result"));
    }

    #[test]
    fn unrelated_query_keeps_static_pool_without_dynamic_commands() {
        let ids = run_query(static_pool(), "alpha", 10);
        assert!(ids.contains(&"app.editor".to_string()));
        assert!(!ids.iter().any(|id| id == "calculator.result"));
        assert!(!ids.iter().any(|id| id == "quick-converter.result"));
        // text-tools 静态命令可按关键词搜到（静态池语义，非每查询生成）。
        let ids = run_query(static_pool(), "uppercase", 10);
        assert!(ids.contains(&"text-tools.uppercase".to_string()));
    }

    #[test]
    fn general_query_demotes_clipboard_entries_below_primary() {
        // 查询 "alpha" 命中主结果与 3 条剪贴板条目：降级 = 主结果在前、
        // 剪贴板至多 2 条（TS MAX_GENERAL_SEARCH_CLIPBOARD_HISTORY_RESULTS）。
        let ids = run_query(clipboard_engine(&[1, 2, 3]), "alpha", 10);
        assert_eq!(ids.first().map(String::as_str), Some("app.editor"));
        let clipboard: Vec<&String> = ids
            .iter()
            .filter(|id| id.starts_with("clipboard-history.entry."))
            .collect();
        assert_eq!(clipboard.len(), 2);
        // 主结果全部位于剪贴板条目之前。
        let first_clipboard = ids
            .iter()
            .position(|id| id.starts_with("clipboard-history.entry."))
            .unwrap();
        assert!(ids[..first_clipboard]
            .iter()
            .all(|id| !id.starts_with("clipboard-history.entry.")));
    }

    #[test]
    fn explicit_clipboard_query_surfaces_entries_inline() {
        // "clip" 命中剪贴板关键词（显式查询）：原序保留、不降级截断。
        let ids = run_query(clipboard_engine(&[1, 2, 3]), "clip", 10);
        let clipboard: Vec<&String> = ids
            .iter()
            .filter(|id| id.starts_with("clipboard-history.entry."))
            .collect();
        assert_eq!(clipboard.len(), 3);
    }

    #[test]
    fn empty_query_runs_home_composition_without_dynamic_commands() {
        // 空查询不经引擎（query_results 提前分支）；此处锁定语义：
        // include_all_on_empty_query=false 时引擎不产出，动态槽对空查询不生成。
        let engine = static_pool();
        let results = engine.search(
            "",
            SearchOptions {
                limit: Some(10),
                include_all_on_empty_query: Some(false),
                ranking: None,
            },
        );
        assert!(results.is_empty());
        let plan = state::dynamic_slot_plan("", ExchangeRatePeek::Missing);
        assert_eq!(plan.calculator, None);
        assert_eq!(plan.converter, None);
        assert!(!plan.needs_rate_refresh);
    }

    /// 诊断日志轮转：未超限保留、超限改名 `.old`、二次追加重建新文件。
    #[test]
    fn diag_log_rotates_when_over_cap() {
        let dir = std::env::temp_dir().join(format!("cc-diag-log-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("command-cabin.log");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(dir.join("command-cabin.log.old"));

        std::fs::write(&path, "x".repeat(64)).unwrap();
        rotate_log_if_needed(&path, 32).unwrap();
        // 超限 → 已改名 .old，主文件消失（下次追加重建）。
        assert!(!path.exists());
        assert!(dir.join("command-cabin.log.old").exists());

        // 未超限 → 原样保留。
        std::fs::write(&path, "y".repeat(8)).unwrap();
        rotate_log_if_needed(&path, 32).unwrap();
        assert!(path.exists());
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 8);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// watcher → 仓储集成（内存 DB）：poll_step 产出原文 → save_text 落库 →
    /// 重复 tick 不再产出 → 变更文本再落库；list_recent 序与命令 id 对应。
    #[test]
    fn clipboard_watch_poll_saves_new_texts_to_repository() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        cabin_storage::migrations::run_migrations(&conn).unwrap();
        let repository = ClipboardHistoryRepository::new(&conn);
        let mut poll_state = PollState::default();

        // tick 1：新文本 → 产出原文（未 trim）→ 落库。
        let emitted = poll_step(&mut poll_state, Some("  first entry \n".to_string()));
        assert_eq!(emitted.as_deref(), Some("  first entry \n"));
        let saved = repository
            .save_text(&emitted.unwrap(), None)
            .unwrap()
            .expect("non-empty text saves");
        assert_eq!(saved.text, "  first entry \n");

        // tick 2：同文本（含仅空白差异）→ 跳过、不落库。
        assert_eq!(
            poll_step(&mut poll_state, Some("first entry".to_string())),
            None
        );
        // tick 3：空读 → 跳过、不改写状态。
        assert_eq!(poll_step(&mut poll_state, Some(String::new())), None);
        // tick 4：变更文本 → 再落库。
        let emitted = poll_step(&mut poll_state, Some("second entry".to_string())).unwrap();
        repository.save_text(&emitted, None).unwrap().unwrap();

        let recent = repository.list_recent(10).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].text, "second entry");
        // 命令构造（storage 条目 → core 条目 → 命令 id 与仓储 id 对应）。
        let commands = create_clipboard_history_commands(
            &recent
                .iter()
                .map(|entry| ClipboardHistoryEntry {
                    id: entry.id,
                    text: entry.text.clone(),
                    copied_at: entry.copied_at.clone(),
                })
                .collect::<Vec<_>>(),
        );
        assert_eq!(commands.len(), 2);
        assert_eq!(
            commands[0].id,
            format!("clipboard-history.entry.{}", recent[0].id)
        );
        assert!(
            cabin_core::features::clipboard_history::is_clipboard_history_command_id(
                &commands[1].id
            )
        );
        // 清空后归零（设置窗口"清空历史"的仓储半步）。
        assert_eq!(repository.clear().unwrap(), 2);
        assert!(repository.list_recent(10).unwrap().is_empty());
    }
}
