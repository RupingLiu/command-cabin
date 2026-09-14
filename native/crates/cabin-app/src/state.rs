//! cabin-app 编排层的纯逻辑部分（Task 9）。把 TS 主进程的行为决策抽成可单测函数，
//! 与 Slint / Win32 的粘合留在 main.rs：
//!
//! - 设置更新决策表（TS
//!   `apps/desktop/src/main/settings/updateSettingsWithHotkeyRegistration.ts`
//!   的顺序语义：normalize → assertUnique → 先注册后持久化、失败逆序回滚）；
//! - 执行历史记录条件（TS `launcherCommandService.executeCommand`：
//!   执行成功 且 （收藏命令 或 app 命令））；
//! - RankingContext 构造（TS `createRankingContext`：history +
//!   history_weight + app/file/plugin 来源权重覆盖）；
//! - ISO 8601 → unix 毫秒（cabin-storage 只校验时间戳形态、不解析；
//!   本转换服务于 `HistoryEntry.last_used_at_ms`，归 app 层所有）；
//! - 空查询首页合成（组合 cabin-core `compose_home_list`）；
//! - 图标候选计划（TS `getAppIconCandidates` / `isInvalidIconLocationCandidate`）；
//! - 图标缓存 flush 时机（调用方驱动：500ms 去抖 / 1500ms 最长等待）；
//! - hideOnBlur 轮询单步决策（TS blur-transition 语义：仅在“已聚焦 → 失焦”
//!   转移沿隐藏）；
//! - 设置 patch 的 JSON 解析（M2 桥接层，camelCase、拒绝未知键）。

use std::collections::HashSet;
use std::time::{Duration, Instant};

use cabin_core::command::types::{Command, CommandSource};
use cabin_core::favorites::{
    FavoriteKind, LAUNCHER_PINNED_APP_EXECUTABLE_PATH_METADATA_KEY,
    LAUNCHER_PINNED_APP_ICON_PATH_METADATA_KEY, LAUNCHER_PINNED_APP_METADATA_KEY,
};
use cabin_core::home::{compose_home_sections, is_app_command, HomeRecentEntry};
use cabin_core::icons::{ICON_CACHE_FLUSH_DELAY_MS, ICON_CACHE_FLUSH_MAX_WAIT_MS};
use cabin_core::search::ranking::{default_source_weight, HistoryEntry, RankingContext};
use cabin_core::settings::{Language, SearchSettings, Settings, SettingsPatch, Theme};
use cabin_platform::{assert_unique_hotkeys, normalize_hotkey};
use cabin_storage::favorites::AddFavorite;

// ---------------------------------------------------------------------------
// ISO 8601 → unix 毫秒
// ---------------------------------------------------------------------------

/// 把 cabin-storage 存储的 ISO 8601 时间戳（`timestamp.rs` 校验过的形态：
/// `YYYY-MM-DDTHH:MM:SS(.f+)?(Z|±HH:MM)`）解析为 unix 毫秒。
///
/// - 小数秒超出 3 位时截断（对齐 JS `Date` 的毫秒精度）；
/// - `±HH:MM` 偏移换算为 UTC；
/// - 形态非法（理论上不会出现：写入边界已校验）防御性返回 `None`。
pub fn iso_to_unix_ms(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 20 {
        return None;
    }
    let year = parse_digits(bytes, 0, 4)? as i64;
    let month = parse_digits(bytes, 5, 7)?;
    let day = parse_digits(bytes, 8, 10)?;
    let hour = parse_digits(bytes, 11, 13)?;
    let minute = parse_digits(bytes, 14, 16)?;
    let second = parse_digits(bytes, 17, 19)?;
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }

    let mut index = 19;
    let mut millisecond = 0i64;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fraction_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == fraction_start {
            return None;
        }
        // 前 3 位为毫秒，多余位数截断（JS Date 语义）。
        let millisecond_digits = &bytes[fraction_start..(fraction_start + 3).min(index)];
        for &digit in millisecond_digits {
            millisecond = millisecond * 10 + i64::from(digit - b'0');
        }
        millisecond *= 10_i64.pow(3 - millisecond_digits.len().min(3) as u32);
    }

    let offset_minutes = match bytes.get(index) {
        Some(b'Z') if index + 1 == bytes.len() => 0,
        Some(sign @ (b'+' | b'-')) if bytes.len() == index + 6 => {
            let offset_hour = parse_digits(bytes, index + 1, index + 3)?;
            let offset_minute = parse_digits(bytes, index + 4, index + 6)?;
            if bytes[index + 3] != b':' || offset_hour > 23 || offset_minute > 59 {
                return None;
            }
            let magnitude = (offset_hour * 60 + offset_minute) as i64;
            if *sign == b'+' {
                -magnitude
            } else {
                magnitude
            }
        }
        _ => return None,
    };

    let days = days_from_civil(year, month, day);
    let millis = days * 86_400_000
        + i64::from(hour) * 3_600_000
        + i64::from(minute) * 60_000
        + i64::from(second) * 1_000
        + millisecond;
    Some(millis + offset_minutes * 60_000)
}

fn parse_digits(bytes: &[u8], from: usize, to: usize) -> Option<u32> {
    if bytes.len() < to {
        return None;
    }
    let mut value = 0u32;
    for &byte in &bytes[from..to] {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + u32::from(byte - b'0');
    }
    Some(value)
}

/// Howard Hinnant `days_from_civil`：公历日期 → 自 unix 纪元天数。
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let month = month as i64;
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year =
        (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day as i64 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

// ---------------------------------------------------------------------------
// 执行历史记录条件
// ---------------------------------------------------------------------------

/// 收藏命令 id 形态（cabin-core `favorite_command_id`：`favorite.<sha256 前 12 hex>`）。
/// M2 编排按前缀判定，等价于 TS `favoriteCommandIds.has(command.id)`
/// （前缀由 cabin-core 生成，插件/系统命令不会使用该前缀）。
pub fn is_favorite_command_id(command_id: &str) -> bool {
    command_id.starts_with("favorite.")
}

/// TS `executeCommand` 的记录条件：执行成功 且
/// （收藏命令 或 app 命令）。app 命令 = source==app 且 action==open-app
/// （TS `isAppCommand`；索引产出的 open-path 条目虽 source==app 也不记录）。
pub fn should_record_execution(execution_success: bool, command: &Command) -> bool {
    execution_success && (is_favorite_command_id(&command.id) || is_app_command(command))
}

// ---------------------------------------------------------------------------
// RankingContext 构造
// ---------------------------------------------------------------------------

/// `HistoryRepository::list_recent_for_ranking` 输出行
/// （command_id, source, execution_count, executed_at），按 executed_at DESC 排序。
pub type HistoryRows = Vec<(String, CommandSource, u64, String)>;

/// TS `createRankingContext` 的 history 部分：command_id →
/// （execution_count, last_used_at_ms=ISO→unix 毫秒）。
pub fn build_history_entries(
    rows: &HistoryRows,
) -> std::collections::HashMap<String, HistoryEntry> {
    rows.iter()
        .map(|(command_id, _, execution_count, executed_at)| {
            (
                command_id.clone(),
                HistoryEntry {
                    execution_count: *execution_count,
                    last_used_at_ms: iso_to_unix_ms(executed_at),
                },
            )
        })
        .collect()
}

/// TS `createRankingContext`：history + `history_weight = search.historyBoost`
/// + 来源权重覆盖 app/file/plugin（基数 × boost；system/url 不覆盖，走默认值）。
///
/// `pinned_command_ids` 与 TS 相同保持为空（TS 通用搜索的 RankingContext 不带
/// pinned 集合；首页 pinned 顺序由 `compose_home_list` 保证）。
pub fn build_ranking_context(
    rows: &HistoryRows,
    search: &SearchSettings,
    now_ms: i64,
) -> RankingContext {
    let mut source_weights = std::collections::HashMap::new();
    source_weights.insert(
        CommandSource::App,
        default_source_weight(CommandSource::App) * search.app_boost,
    );
    source_weights.insert(
        CommandSource::File,
        default_source_weight(CommandSource::File) * search.file_boost,
    );
    source_weights.insert(
        CommandSource::Plugin,
        default_source_weight(CommandSource::Plugin) * search.plugin_boost,
    );
    RankingContext {
        pinned_command_ids: HashSet::new(),
        history: build_history_entries(rows),
        source_weights: Some(source_weights),
        history_weight: Some(search.history_boost),
        now_ms: Some(now_ms),
    }
}

/// TS：`Math.min(100, Math.max(0, searchSettings.maxResults))`（u32 已保证 >= 0）。
pub fn search_limit(max_results: u32) -> usize {
    max_results.min(100) as usize
}

// ---------------------------------------------------------------------------
// 查询管线：动态即时命令槽 + 剪贴板历史降级（M4 Task 7，TS launcherCommandService）
// ---------------------------------------------------------------------------

/// TS `MAX_INDEXED_CLIPBOARD_HISTORY_RESULTS`（索引进搜索引擎的剪贴板条目数；
/// 与 cabin-storage 的 200 行修剪上限一致）。
pub const MAX_INDEXED_CLIPBOARD_HISTORY_RESULTS: usize = 200;
/// TS `MAX_GENERAL_SEARCH_CLIPBOARD_HISTORY_RESULTS`（非剪贴板查询的降级上限）。
const MAX_GENERAL_SEARCH_CLIPBOARD_HISTORY_RESULTS: usize = 2;

/// TS `EXPLICIT_CLIPBOARD_HISTORY_QUERY_WORDS` / `..._PHRASES`。
const EXPLICIT_CLIPBOARD_WORDS: &[&str] = &["clip", "clipboard", "history"];
const EXPLICIT_CLIPBOARD_PHRASES: &[&str] = &["剪贴板", "粘贴板", "剪切板"];

/// TS `isExplicitClipboardHistoryQuery`：trim + 小写归一后，含任一中文短语，或
/// 按 `[a-z0-9]+` 分词后命中任一英文词（整词相等，非子串）。
pub fn is_explicit_clipboard_history_query(query: &str) -> bool {
    let normalized = query.trim().to_lowercase();
    if normalized.is_empty() {
        return false;
    }
    if EXPLICIT_CLIPBOARD_PHRASES
        .iter()
        .any(|phrase| normalized.contains(phrase))
    {
        return true;
    }
    // TS `normalizedQuery.match(/[a-z0-9]+/g)`：小写字母与数字的连续游程；
    // 其余字符（含非 ASCII）均为分隔符。命中即提前收敛。
    let mut word = String::new();
    for character in normalized.chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() {
            word.push(character);
            continue;
        }
        if EXPLICIT_CLIPBOARD_WORDS.contains(&word.as_str()) {
            return true;
        }
        word.clear();
    }
    EXPLICIT_CLIPBOARD_WORDS.contains(&word.as_str())
}

/// TS `searchOptions.limit`：显式剪贴板查询按结果上限搜索；其余查询先以
/// `limit + 200` 扩容搜索（让剪贴板条目有完整候选集），由
/// [`demote_clipboard_history_results`] 降级后再截断。
pub fn engine_search_limit(query: &str, max_results: u32) -> usize {
    let limit = search_limit(max_results);
    if is_explicit_clipboard_history_query(query) {
        limit
    } else {
        limit + MAX_INDEXED_CLIPBOARD_HISTORY_RESULTS
    }
}

/// TS `demoteClipboardHistorySearchResults`：非剪贴板查询把剪贴板历史条目
/// （命令 id 前缀 `clipboard-history.entry.`）移到主结果之后、至多 2 条；
/// 显式剪贴板查询原样返回（仅按 limit 截断）。空查询不经过本函数（TS 空查询
/// 直接返回首页 app 合成，不走搜索）。
pub fn demote_clipboard_history_results(
    query: &str,
    results: Vec<Command>,
    limit: usize,
) -> Vec<Command> {
    if is_explicit_clipboard_history_query(query) {
        return results.into_iter().take(limit).collect();
    }

    let mut primary = Vec::new();
    let mut clipboard = Vec::new();
    for command in results {
        if cabin_core::features::clipboard_history::is_clipboard_history_command_id(&command.id) {
            if clipboard.len() < MAX_GENERAL_SEARCH_CLIPBOARD_HISTORY_RESULTS {
                clipboard.push(command);
            }
            continue;
        }
        primary.push(command);
    }
    primary.extend(clipboard);
    primary.into_iter().take(limit).collect()
}

/// 每次查询的动态即时命令槽（TS `refreshCalculatorCommand` +
/// `refreshQuickConverterCommand` 的同步部分；calculator → quick-converter
/// 顺序即 TS 插件顺序）。命令为 `None` 时调用方须把对应保留 id 从引擎移除。
#[derive(Debug, Clone, PartialEq)]
pub struct DynamicSlotPlan {
    /// TS `createCalculatorResultCommand(query)`：表达式非法 → `None`。
    pub calculator: Option<Command>,
    /// TS `createQuickConverterCommand(query, { exchangeRateProvider })`：
    /// 静态换算优先；货币查询按注入的汇率构造（TS provider 抛错折叠 undefined
    /// → 注入 `None` 汇率即等价）。
    pub converter: Option<Command>,
    /// 货币查询且需要后台取数：过期缓存（旧缓存本次立即出命令，TS `void
    /// refreshRate()`）或无缓存（TS 同步刷新路径的异步化——本次无命令，
    /// 取数完成后由调用方重跑当前查询补上，invoke_from_event_loop 对齐 TS 的
    /// await 恢复）。
    pub needs_rate_refresh: bool,
}

/// 构造当次查询的动态命令槽。`rate`：非阻塞 peek 出的缓存读结果——新鲜缓存
/// 立即出命令；过期缓存同样立即出命令、subtitle 标"缓存汇率"，同时置
/// `needs_rate_refresh`（TS 立即返回旧缓存 + `void refreshRate()`）；
/// `Missing` = 无缓存可用。
pub fn dynamic_slot_plan(
    query: &str,
    rate: cabin_core::features::exchange_rate::ExchangeRatePeek,
) -> DynamicSlotPlan {
    use cabin_core::features::calculator::create_calculator_result_command;
    use cabin_core::features::exchange_rate::ExchangeRatePeek;
    use cabin_core::features::quick_converter::{
        create_quick_converter_command, create_static_conversion_command, parse_conversion_query,
        ParsedConversionKind,
    };

    let calculator = create_calculator_result_command(query);

    // TS：静态换算（长度/重量/体积）同步返回，不触达汇率 provider。
    if let Some(converter) = create_static_conversion_command(query) {
        return DynamicSlotPlan {
            calculator,
            converter: Some(converter),
            needs_rate_refresh: false,
        };
    }

    // 货币查询：新鲜缓存 → 立即出命令、无需刷新；过期缓存 → 旧缓存立即出
    // 命令 + 请求后台刷新；无缓存 → 本次无命令 + 请求后台刷新。
    let is_currency = parse_conversion_query(query)
        .is_some_and(|parsed| parsed.kind == ParsedConversionKind::Currency);
    if is_currency {
        let (rate, needs_refresh) = match rate {
            ExchangeRatePeek::Fresh(rate) => (Some(rate), false),
            ExchangeRatePeek::Stale(rate) => (Some(rate), true),
            ExchangeRatePeek::Missing => (None, true),
        };
        return DynamicSlotPlan {
            calculator,
            converter: create_quick_converter_command(query, rate.as_ref()),
            needs_rate_refresh: needs_refresh,
        };
    }

    DynamicSlotPlan {
        calculator,
        converter: None,
        needs_rate_refresh: false,
    }
}

// ---------------------------------------------------------------------------
// 空查询首页合成
// ---------------------------------------------------------------------------

/// recent 子列表（TS `listRecentAppSearchResults`）：按行序（executed_at DESC）
/// 过滤 source==app 且注册表中存在且为 app 命令的条目，score = execution_count。
pub fn home_recent_entries(
    rows: &HistoryRows,
    lookup: &dyn Fn(&str) -> Option<Command>,
) -> Vec<HomeRecentEntry> {
    rows.iter()
        .filter(|(_, source, _, _)| *source == CommandSource::App)
        .filter_map(|(command_id, _, execution_count, _)| {
            let command = lookup(command_id)?;
            is_app_command(&command).then_some(HomeRecentEntry {
                command,
                execution_count: *execution_count,
            })
        })
        .collect()
}

/// 空查询首页的两个分组（M2 Task 10 分组头）：recent + pinned app 命令，
/// 语义与 cabin-core `compose_home_sections` 相同（recent 在前、按身份键去重、
/// 总上限 10）；扁平拼接即 TS `listHomeAppSearchResults` 的合成结果（core 侧
/// parity 测试保证与 `compose_home_list` 逐项一致）。
pub fn home_sections(
    rows: &HistoryRows,
    lookup: &dyn Fn(&str) -> Option<Command>,
    pinned_app_commands: &[Command],
) -> (Vec<Command>, Vec<Command>) {
    let sections = compose_home_sections(&home_recent_entries(rows, lookup), pinned_app_commands);
    (sections.recent, sections.pinned)
}

/// 首页固定磁贴上限（UI 修复 1，用户需求：横向图标网格每行 5 个、至多 2 行）。
pub const HOME_TILE_LIMIT: usize = 10;

/// 首页固定磁贴命令（UI 修复 1，用户需求；native-only 展示形态——TS 首页是
/// 单列表，无网格对应物，故不进 cabin-core 的 TS-parity 合成）。
///
/// 语义：pinned 命令按收藏顺序、组内按身份键（`app_result_identity_key`）去重
/// （先到先得），截断到 [`HOME_TILE_LIMIT`]（5×2）。注意**不做 recent 跨组
/// 去重**：磁贴网格与"最近使用"列表是两个独立分区（对齐启动器首页惯例，
/// 如开始菜单的"已固定/推荐"并存），用户要求"现在能看到固定行"整体变网格，
/// 若按 recent 排除会把同时近期用过的固定应用从网格里隐没，违背需求。
pub fn home_pinned_tiles(pinned: &[Command]) -> Vec<Command> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut tiles: Vec<Command> = Vec::with_capacity(HOME_TILE_LIMIT.min(pinned.len()));
    for command in pinned {
        if tiles.len() >= HOME_TILE_LIMIT {
            break;
        }
        if !seen.insert(cabin_core::home::app_result_identity_key(command)) {
            continue;
        }
        tiles.push(command.clone());
    }
    tiles
}

/// 磁贴网格列数（UI 修复 1：每行 5 个；UI 修复 2 的导航决策表与 main.rs 的
/// 切行模型共用同一常量，保证两侧行/列语义一致）。
pub const HOME_TILE_COLUMNS: usize = 5;

/// 首页磁贴网格四向键盘导航决策表（UI 修复 2）：`(dx, dy, 当前下标, 磁贴总数)`
/// → 移动后的下标；`None` = 撞边界不动。
///
/// 网格不回绕：
/// - 横向（dy==0, dx!=0）：目标 = 下标 + dx；第 0 列左移、最后一列右移、
///   最后一个磁贴右移都被挡住（不允许换行）；
/// - 纵向（dx==0, dy!=0）：目标 = 下标 + dy×[`HOME_TILE_COLUMNS`]；首行上移、
///   末行下移（下标 + 5 ≥ 总数）不动——不满 5 的尾行按下标判定（3+5=8 ≥ 8）；
/// - 零位移返回原下标；空网格 / 越界下标防御性返回 `None`。
pub fn move_tile_selection(dx: isize, dy: isize, index: usize, count: usize) -> Option<usize> {
    if count == 0 || index >= count {
        return None;
    }
    let columns = HOME_TILE_COLUMNS as isize;
    let index = index as isize;
    let column = index % columns;
    if dy != 0 {
        let target = index + dy * columns;
        return usize::try_from(target)
            .ok()
            .filter(|target| *target < count);
    }
    if dx != 0 {
        let blocked = (dx < 0 && column == 0)
            || (dx > 0 && (column == columns - 1 || index + dx >= count as isize));
        if blocked {
            return None;
        }
        return Some((index + dx) as usize);
    }
    Some(index as usize)
}

/// 首页磁贴初始选中（UI 修复 2）：呼出 / 回到首页且网格非空 → 选中第 0 个
/// （高亮可见、Enter 即启动第一个固定应用）；搜索态或空网格 → `None`
/// （调用方 push -1，磁贴不显示高亮）。
pub fn initial_tile_selection(is_home: bool, tile_count: usize) -> Option<usize> {
    (is_home && tile_count > 0).then_some(0)
}

/// Enter 执行路由决策（UI 修复 2）：首页磁贴模式（网格非空，磁贴模型仅在
/// 空查询时由 Rust push）且选中磁贴有效 → `Some(磁贴下标)`（走
/// `run-command-id` 同一条 commands_by_id 查询路径）；无选中 / 越界 / 空网格
/// → `None`（调用方回落到平铺列表选中行路径）。
pub fn execute_tile_route(selected_tile: i32, tile_count: usize) -> Option<usize> {
    if tile_count == 0 {
        return None;
    }
    usize::try_from(selected_tile)
        .ok()
        .filter(|index| *index < tile_count)
}

// ---------------------------------------------------------------------------
// 设置更新决策表（TS updateSettingsWithHotkeyRegistration）
// ---------------------------------------------------------------------------

/// TS 的热键字段展示名（错误消息逐字使用）。
pub const HOTKEY_FIELD_LAUNCHER: &str = "launcher";
pub const HOTKEY_FIELD_SCREENSHOT: &str = "screenshot";
pub const HOTKEY_FIELD_DELAYED_SCREENSHOT: &str = "delayed screenshot";

/// 一条需要重注册的热键：字段、规范化后的新值、回滚目标（当前生效值）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HotkeyRegistration {
    pub field: &'static str,
    pub new_hotkey: String,
    pub rollback_hotkey: String,
}

/// 注册失败时的错误文案（逐字 TS / 任务简报 2c）。
pub fn hotkey_registration_error(hotkey: &str) -> String {
    format!(
        "CommandCabin could not register {hotkey}. Another application or the operating system may already be using this shortcut."
    )
}

/// 简报 2a：`normalize_hotkey` 规范化 patch 中出现的三个热键字段。
/// 规范化失败时保留其余字段不动并返回错误。
pub fn normalize_patch_hotkeys(patch: &mut SettingsPatch) -> Result<(), String> {
    fn normalize_field(field: &mut Option<String>) -> Result<(), String> {
        if let Some(value) = field {
            *value = normalize_hotkey(value).map_err(|error| error.to_string())?;
        }
        Ok(())
    }
    normalize_field(&mut patch.hotkey)?;
    normalize_field(&mut patch.screenshot_hotkey)?;
    normalize_field(&mut patch.delayed_screenshot_hotkey)?;
    Ok(())
}

/// TS `assertUniqueHotkeys`：对 patch 与当前设置合并后的三个热键查重。
pub fn assert_merged_hotkeys_unique(
    current: &Settings,
    patch: &SettingsPatch,
) -> Result<(), String> {
    let entries = [
        (
            HOTKEY_FIELD_LAUNCHER,
            patch.hotkey.as_deref().unwrap_or(&current.hotkey),
        ),
        (
            HOTKEY_FIELD_SCREENSHOT,
            patch
                .screenshot_hotkey
                .as_deref()
                .unwrap_or(&current.screenshot_hotkey),
        ),
        (
            HOTKEY_FIELD_DELAYED_SCREENSHOT,
            patch
                .delayed_screenshot_hotkey
                .as_deref()
                .unwrap_or(&current.delayed_screenshot_hotkey),
        ),
    ];
    assert_unique_hotkeys(&entries).map_err(|error| error.to_string())
}

/// TS `registerChangedHotkey` 的决策表：仅收集“patch 中出现且与当前值不同”的
/// 字段，保持 hotkey → screenshot → delayed screenshot 顺序。
pub fn hotkey_registrations(current: &Settings, patch: &SettingsPatch) -> Vec<HotkeyRegistration> {
    let mut registrations = Vec::new();
    for (field, next, current_hotkey) in [
        (&HOTKEY_FIELD_LAUNCHER, &patch.hotkey, &current.hotkey),
        (
            &HOTKEY_FIELD_SCREENSHOT,
            &patch.screenshot_hotkey,
            &current.screenshot_hotkey,
        ),
        (
            &HOTKEY_FIELD_DELAYED_SCREENSHOT,
            &patch.delayed_screenshot_hotkey,
            &current.delayed_screenshot_hotkey,
        ),
    ] {
        if let Some(next) = next {
            if *next != *current_hotkey {
                registrations.push(HotkeyRegistration {
                    field,
                    new_hotkey: next.clone(),
                    rollback_hotkey: current_hotkey.clone(),
                });
            }
        }
    }
    registrations
}

/// TS 顺序语义的完整编排：
/// 1. 逐字段（按决策表顺序）调用 `register_replacement`（注册新值并完成替换）；
///    失败 → 逆序回滚已注册字段并返回逐字错误文案；
/// 2. 全部注册成功后调用 `persist`；失败 → 回滚全部注册并返回持久化错误
///    （对齐 TS：注册与 `updateSettings` 在同一 try 块内，任何失败都回滚）。
///
/// 回滚通过 `restore` 恢复旧值；TS 忽略回滚中的注册失败，此处一致。
pub fn register_hotkeys_with_rollback<E: std::fmt::Display>(
    registrations: &[HotkeyRegistration],
    mut register_replacement: impl FnMut(&HotkeyRegistration) -> Result<(), ()>,
    mut restore: impl FnMut(&HotkeyRegistration),
    mut persist: impl FnMut() -> Result<(), E>,
) -> Result<(), String> {
    let mut applied: Vec<&HotkeyRegistration> = Vec::new();
    for registration in registrations {
        if register_replacement(registration).is_err() {
            rollback_registrations(&mut applied, &mut restore);
            return Err(hotkey_registration_error(&registration.new_hotkey));
        }
        applied.push(registration);
    }
    if let Err(error) = persist() {
        rollback_registrations(&mut applied, &mut restore);
        return Err(error.to_string());
    }
    Ok(())
}

fn rollback_registrations(
    applied: &mut Vec<&HotkeyRegistration>,
    restore: &mut impl FnMut(&HotkeyRegistration),
) {
    for registration in applied.drain(..).rev() {
        restore(registration);
    }
}

// ---------------------------------------------------------------------------
// 截图热键位移注册（TS screenshotShortcutController.tryRegisterGlobalHotkey）
// ---------------------------------------------------------------------------

/// 截图热键字段（TS `ScreenshotHotkeyRegistrationField` 的两个成员）。
/// 启动器热键不参与位移（TS 位移只在 screenshotShortcutController 内部的
/// 两个字段之间发生；跨 launcher 冲突由 assertUniqueHotkeys 拒绝）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenshotHotkeyField {
    Screenshot,
    DelayedScreenshot,
}

impl ScreenshotHotkeyField {
    /// 位移对象：另一个截图热键字段（TS `findRegisteredField` 的遍历全集）。
    pub fn other(self) -> Self {
        match self {
            Self::Screenshot => Self::DelayedScreenshot,
            Self::DelayedScreenshot => Self::Screenshot,
        }
    }

    /// TS `modeByField`：字段 → 启动模式。
    pub fn mode_name(self) -> &'static str {
        match self {
            Self::Screenshot => "capture",
            Self::DelayedScreenshot => "capture-delay-3",
        }
    }
}

/// 截图模式名（[`ScreenshotHotkeyField::mode_name`] 输出）→ 热键处理器按字段名
/// 分发时使用的字段名（`HOTKEY_FIELD_*`，main.rs `hotkey_handler_for` 的匹配键）。
/// 评审 Finding 1：此前调用方把模式名直接喂给字段名消费者，`capture` /
/// `capture-delay-3` 均落入 no-op 回退分支，截图热键完全失效。纯函数集中映射，
/// 单测锁定 `mode_name()` 全部输出必须映射到非回退分支。
pub fn screenshot_mode_to_field(mode: &str) -> Option<&'static str> {
    match mode {
        "capture" => Some(HOTKEY_FIELD_SCREENSHOT),
        "capture-delay-3" => Some(HOTKEY_FIELD_DELAYED_SCREENSHOT),
        _ => None,
    }
}

/// 截图热键注册表快照（TS `hotkeyRegistrations` Map；None = 未注册，
/// 对齐 TS 中 registration.registered=false 不参与位移/释放的语义）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScreenshotHotkeyRegistrations {
    pub screenshot: Option<String>,
    pub delayed_screenshot: Option<String>,
}

impl ScreenshotHotkeyRegistrations {
    pub fn get(&self, field: ScreenshotHotkeyField) -> Option<&String> {
        match field {
            ScreenshotHotkeyField::Screenshot => self.screenshot.as_ref(),
            ScreenshotHotkeyField::DelayedScreenshot => self.delayed_screenshot.as_ref(),
        }
    }

    pub fn set(&mut self, field: ScreenshotHotkeyField, value: Option<String>) {
        match field {
            ScreenshotHotkeyField::Screenshot => self.screenshot = value,
            ScreenshotHotkeyField::DelayedScreenshot => self.delayed_screenshot = value,
        }
    }
}

/// [`plan_screenshot_hotkey_change`] 的决策输出（TS tryRegisterGlobalHotkey 的
/// 执行序列拆解，逐条对齐）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScreenshotHotkeyPlan {
    /// 与该字段当前已注册加速键相同 → 无操作成功（TS tryRegister 提前返回 true，
    /// 不触发 register/unregister）。
    pub noop: bool,
    /// 新加速键被另一字段占用 → 先注销它（TS displacedRegistration.dispose()）。
    pub displace: Option<(ScreenshotHotkeyField, String)>,
    /// 需注册的新加速键（noop 时 None）。
    pub register_new: Option<String>,
    /// 新注册失败 → 还原位移注册（TS register(displacedField, 其旧加速键)）。
    pub restore_on_failure: Option<(ScreenshotHotkeyField, String)>,
    /// 新注册成功 → 注销目标字段的旧加速键（TS hotkeyRegistration.dispose()）。
    pub release_old: Option<String>,
}

/// TS `tryRegisterGlobalHotkey`（screenshotShortcutController.ts:70-105）的
/// 纯决策表。执行器按序消费 displace → register_new →（失败：restore_on_failure /
/// 成功：release_old）并同步 [`ScreenshotHotkeyRegistrations`]。
pub fn plan_screenshot_hotkey_change(
    registrations: &ScreenshotHotkeyRegistrations,
    field: ScreenshotHotkeyField,
    accelerator: &str,
) -> ScreenshotHotkeyPlan {
    let own = registrations.get(field).cloned();
    if own.as_deref() == Some(accelerator) {
        return ScreenshotHotkeyPlan {
            noop: true,
            ..ScreenshotHotkeyPlan::default()
        };
    }
    let other_field = field.other();
    let displaced = registrations
        .get(other_field)
        .filter(|other| other.as_str() == accelerator)
        .cloned();
    let displace = displaced.map(|other| (other_field, other));
    ScreenshotHotkeyPlan {
        noop: false,
        displace: displace.clone(),
        register_new: Some(accelerator.to_string()),
        restore_on_failure: displace,
        release_old: own,
    }
}

// ---------------------------------------------------------------------------
// 截图保存：默认文件名 + 扩展名格式判定（TS screenshotController.ts:214-229）
// ---------------------------------------------------------------------------

/// TS `deriveSaveFormatFromPath`：按扩展名定格式（png / jpg），其余回退到
/// 请求的 fallback（渲染端固定 'png'）。
pub fn derive_save_format_from_path(path: &str, fallback: &str) -> &'static str {
    // TS `filePath.split('.').at(-1)`：无 '.' 时整串即"扩展名"。
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "png" => "png",
        "jpg" | "jpeg" => "jpg",
        _ if fallback == "jpg" => "jpg",
        _ => "png",
    }
}

/// 保存默认文件名（FSP：`CommandCabin-YYYYMMDD-HHMMSS.png`）。
pub fn save_file_name(
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
) -> String {
    format!("CommandCabin-{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}.png")
}

/// 当前 UTC 时间的 (year, month, day, hour, minute, second)。文件名默认值用途，
/// UTC 足够（TS 未定制默认文件名；本地时区转换需 Win32 调用，违反分层规则）。
pub fn save_file_name_now() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs()) as i64;
    let (year, month, day) = civil_from_unix_days(seconds.div_euclid(86_400));
    let remain = seconds.rem_euclid(86_400);
    save_file_name(
        year,
        month,
        day,
        (remain / 3600) as u32,
        ((remain % 3600) / 60) as u32,
        (remain % 60) as u32,
    )
}

/// 儒略日数 → (年, 月, 日)（Howard Hinnant civil_from_days，公有领域算法）。
fn civil_from_unix_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

// ---------------------------------------------------------------------------
// 截图 OCR/翻译语言映射（TS ScreenshotOverlay.tsx:195-203 + screenshotTranslation.ts）
// ---------------------------------------------------------------------------

/// TS `getScreenshotOcrLanguageForUi`（逐字）：en-US UI 读 zh-CN，zh 系 UI 读
/// en-US（OCR 语言 = UI 语言的反向）。**仅翻译路径使用**（ScreenshotOverlay
/// `runTranslation`）；plain OCR（`runOcr`）传 UI 语言原样（见
/// [`ui_language_tag`]）。
pub fn ocr_language_for_ui(language: Language) -> &'static str {
    if language == Language::EnUs {
        "zh-CN"
    } else {
        "en-US"
    }
}

/// UI 语言 → BCP-47 tag（"en-US" / "zh-CN" / "zh-TW"）。plain OCR 的请求语言
/// （TS `runOcr` 把 UI 语言原样传给主进程，无反向翻转、无备选表——评审
/// Finding 2）；与翻译目标语言同值（`getScreenshotTranslationTargetLanguage`）。
pub fn ui_language_tag(language: Language) -> &'static str {
    translation_target_language(language)
}

/// TS `getScreenshotTranslationTargetLanguage`（逐字）：目标语言 = UI 语言。
pub fn translation_target_language(language: Language) -> &'static str {
    match language {
        Language::EnUs => "en-US",
        Language::ZhCn => "zh-CN",
        Language::ZhTw => "zh-TW",
    }
}

/// TS `getScreenshotTranslationOcrLanguageCandidates`（逐字）：主语言 = 请求的
/// ocrLanguage，次选 = targetLanguage；target 为 zh-CN/zh-TW 时互为备选。
pub fn translation_ocr_candidates(ocr_language: &str, target_language: &str) -> Vec<String> {
    let mut candidates = vec![ocr_language.to_string()];
    if !candidates
        .iter()
        .any(|candidate| candidate == target_language)
    {
        candidates.push(target_language.to_string());
    }
    let sibling = match target_language {
        "zh-CN" => Some("zh-TW"),
        "zh-TW" => Some("zh-CN"),
        _ => None,
    };
    if let Some(sibling) = sibling {
        if !candidates.iter().any(|candidate| candidate == sibling) {
            candidates.push(sibling.to_string());
        }
    }
    candidates
}

/// TS `getScreenshotTranslationSourceLanguage`（逐字）：请求的 ocrLanguage 与
/// target 不同 → 用 ocrLanguage；相同 → 用 OCR 实际解析语言。
pub fn translation_source_language<'a>(
    ocr_language: &'a str,
    target_language: &str,
    actual_ocr_language: &'a str,
) -> &'a str {
    if ocr_language != target_language {
        ocr_language
    } else {
        actual_ocr_language
    }
}

// ---------------------------------------------------------------------------
// 托盘文案
// ---------------------------------------------------------------------------

/// 托盘菜单文案（对齐 TS `trayController.ts` 的 `trayMenuLabels` 三项结构；
/// M2 Task 10 加"设置"项打开设置窗口）。返回 (show, settings, quit)。
pub fn tray_texts(language: Language) -> (&'static str, &'static str, &'static str) {
    match language {
        Language::EnUs => ("Show CommandCabin", "Settings", "Quit"),
        Language::ZhCn => ("显示 CommandCabin", "设置", "退出"),
        Language::ZhTw => ("顯示 CommandCabin", "設定", "結束"),
    }
}

// ---------------------------------------------------------------------------
// 设置 UI 视图层（M2 Task 10）：字段 → patch JSON 桥 + 固定应用收藏映射。
// 纯函数部分放这里单测；slint 粘合在 main.rs。
// ---------------------------------------------------------------------------

/// 数字展示文本（Rust `Display` 最短表示：1.4 → "1.4"、1.0 → "1"）。
pub fn format_decimal(value: f64) -> String {
    format!("{value}")
}

/// 主题三值 → 设置窗口 ComboBox 下标（0 system / 1 light / 2 dark）。
pub fn theme_index(theme: Theme) -> u32 {
    match theme {
        Theme::System => 0,
        Theme::Light => 1,
        Theme::Dark => 2,
    }
}

/// 语言三值 → 设置窗口 ComboBox 下标（0 zh-CN / 1 zh-TW / 2 en-US）。
pub fn language_index(language: Language) -> u32 {
    match language {
        Language::ZhCn => 0,
        Language::ZhTw => 1,
        Language::EnUs => 2,
    }
}

/// ComboBox 下标 → `{theme:"system"|"light"|"dark"}` patch JSON。
/// 越界下标返回错误文案（UI 不会产生；防御性，与 parse_settings_patch_json
/// 的 theme 错误措辞一致）。
pub fn theme_patch_json(index: u32) -> Result<String, String> {
    let value = match index {
        0 => "system",
        1 => "light",
        2 => "dark",
        _ => {
            return Err("theme must be \"system\", \"light\", or \"dark\"".to_string());
        }
    };
    Ok(serde_json::json!({ "theme": value }).to_string())
}

/// 语言下标 → `{language:"zh-CN"|"zh-TW"|"en-US"}` patch JSON。
pub fn language_patch_json(index: u32) -> Result<String, String> {
    let value = match index {
        0 => "zh-CN",
        1 => "zh-TW",
        2 => "en-US",
        _ => {
            return Err("language must be \"zh-CN\", \"zh-TW\", or \"en-US\"".to_string());
        }
    };
    Ok(serde_json::json!({ "language": value }).to_string())
}

/// 启动器数字字段（设置窗口 commit-number 的 section 编码，与 .slint 约定：
/// 0 maxResults / 1 historyBoost / 2 pluginBoost / 3 appBoost / 4 fileBoost）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NumericField {
    MaxResults,
    HistoryBoost,
    PluginBoost,
    AppBoost,
    FileBoost,
}

impl NumericField {
    pub fn from_index(index: u32) -> Option<NumericField> {
        match index {
            0 => Some(Self::MaxResults),
            1 => Some(Self::HistoryBoost),
            2 => Some(Self::PluginBoost),
            3 => Some(Self::AppBoost),
            4 => Some(Self::FileBoost),
            _ => None,
        }
    }

    /// patch JSON 键（TS `search.*` camelCase）。
    fn json_key(self) -> &'static str {
        match self {
            Self::MaxResults => "maxResults",
            Self::HistoryBoost => "historyBoost",
            Self::PluginBoost => "pluginBoost",
            Self::AppBoost => "appBoost",
            Self::FileBoost => "fileBoost",
        }
    }
}

/// 数字输入提交：raw 文本 → `{search:{key:value}}` patch JSON。
/// 解析失败报错文案与 `parse_settings_patch_json` / core `apply_patch`
/// 的逐字校验文案一致（TS settingsRepository 措辞）。
pub fn numeric_field_patch_json(field: NumericField, raw: &str) -> Result<String, String> {
    let key = field.json_key();
    let value = match field {
        NumericField::MaxResults => {
            let parsed = raw
                .trim()
                .parse::<u32>()
                .map_err(|_| "search.maxResults must be a safe integer >= 0".to_string())?;
            if parsed > i32::MAX as u32 {
                return Err("search.maxResults must be a safe integer >= 0".to_string());
            }
            serde_json::Value::Number(parsed.into())
        }
        NumericField::HistoryBoost
        | NumericField::PluginBoost
        | NumericField::AppBoost
        | NumericField::FileBoost => {
            let parsed = raw
                .trim()
                .parse::<f64>()
                .map_err(|_| format!("search.{key} must be a finite number"))?;
            if !parsed.is_finite() {
                return Err(format!("search.{key} must be a finite number"));
            }
            serde_json::Number::from_f64(parsed)
                .map(serde_json::Value::Number)
                .ok_or_else(|| format!("search.{key} must be a finite number"))?
        }
    };
    Ok(serde_json::json!({ "search": { key: value } }).to_string())
}

/// Windows 快捷方式路径的收藏身份键：trim + `/` 归一为 `\` + 小写
/// （对齐 cabin-core `app_result_identity_key` 的归一化；区分大小写不敏感）。
pub fn shortcut_identity_key(path: &str) -> String {
    path.trim().replace('/', "\\").to_lowercase()
}

/// app 命令 → 固定应用收藏输入（TS `addLauncherPinnedApp` 的收藏形态：
/// kind=file、path=快捷方式、metadata 带 launcherPinnedApp / executable /
/// icon 三个键）。缺 shortcutPath（无法构成可启动收藏）时返回错误。
pub fn pinned_app_favorite_input(command: &Command) -> Result<AddFavorite, String> {
    let payload_string = |key: &str| -> Option<String> {
        command
            .action
            .payload
            .get(key)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
    };
    let shortcut_path = payload_string("shortcutPath")
        .ok_or_else(|| "pinned app command is missing shortcutPath".to_string())?;
    // TS `createPinnedAppInput`：executable 缺失时以 path 兜底（.lnk 也可启动）。
    let executable_path = payload_string("executablePath").unwrap_or_else(|| shortcut_path.clone());
    let icon_path = command
        .icon
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| app_icon_candidates(command).first().cloned())
        .unwrap_or_else(|| executable_path.clone());

    let mut metadata = serde_json::Map::new();
    metadata.insert(
        LAUNCHER_PINNED_APP_METADATA_KEY.to_string(),
        serde_json::Value::Bool(true),
    );
    metadata.insert(
        LAUNCHER_PINNED_APP_EXECUTABLE_PATH_METADATA_KEY.to_string(),
        executable_path.into(),
    );
    metadata.insert(
        LAUNCHER_PINNED_APP_ICON_PATH_METADATA_KEY.to_string(),
        icon_path.into(),
    );
    Ok(AddFavorite {
        id: None,
        kind: FavoriteKind::File,
        title: command.title.clone(),
        path: Some(shortcut_path),
        url: None,
        keywords: Vec::new(),
        metadata: Some(metadata),
        created_at: None,
        updated_at: None,
    })
}

/// 行级"已固定"判定：收藏命令 id 命中 或 （app 命令 且 其 shortcutPath 命中
/// 固定收藏的 path 身份键）。后者覆盖"索引命令与收藏命令 id 不同"的形态
/// （固定动作后索引命令行不再显示固定按钮）。
pub fn command_is_pinned_app(
    command: &Command,
    pinned_command_ids: &std::collections::HashSet<String>,
    pinned_shortcut_keys: &std::collections::HashSet<String>,
) -> bool {
    if pinned_command_ids.contains(&command.id) {
        return true;
    }
    if !is_app_command(command) {
        return false;
    }
    let Some(shortcut_path) = command
        .action
        .payload
        .get("shortcutPath")
        .and_then(serde_json::Value::as_str)
    else {
        return false;
    };
    pinned_shortcut_keys.contains(&shortcut_identity_key(shortcut_path))
}

// ---------------------------------------------------------------------------
// 图标候选计划
// ---------------------------------------------------------------------------

/// TS `getAppIconCandidates`：仅 app 命令（source==app 且 open-app）；
/// 顺序 icon → appUserModelId → executablePath → subtitle → shortcutPath，
/// 去空、去重保序。
pub fn app_icon_candidates(command: &Command) -> Vec<String> {
    if !is_app_command(command) {
        return Vec::new();
    }
    let payload_string = |key: &str| -> Option<String> {
        command
            .action
            .payload
            .get(key)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
    };
    let mut candidates: Vec<String> = Vec::new();
    let raw_candidates = [
        command.icon.clone(),
        payload_string("appUserModelId"),
        payload_string("executablePath"),
        command.subtitle.clone(),
        payload_string("shortcutPath"),
    ];
    for candidate in raw_candidates.into_iter().flatten() {
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

/// TS `isInvalidIconLocationCandidate`：trim 后匹配 `/^,\d+$/` 的孤立图标索引。
pub fn is_invalid_icon_location_candidate(candidate: &str) -> bool {
    let trimmed = candidate.trim();
    let Some(rest) = trimmed.strip_prefix(',') else {
        return false;
    };
    !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit())
}

/// 图标解析计划：TS `expandShortcutCandidates` 的 `hasInvalidIconLocationCandidate`
/// 标志 + 过滤后的候选清单。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IconResolutionPlan {
    /// 有效候选（按 TS 顺序）；孤立 `,N` 候选被剔除。
    pub candidates: Vec<String>,
    /// 出现过孤立 `,N` 候选（TS `hasInvalidIconLocationCandidate`）。
    pub invalid_icon_location_seen: bool,
}

/// 从命令构造图标解析计划。孤立 `,N` 候选（无效 IconLocation）被剔除并记录在
/// `invalid_icon_location_seen`；目标 exe/com（payload executablePath / subtitle）
/// 天然位于候选清单中，提取线程按序尝试 —— 这是 TS associated-icon 回退在
/// 原生管线中的对应路径：无效 IconLocation 不中止解析，改为提取目标可执行文件。
pub fn plan_icon_resolution(command: &Command) -> IconResolutionPlan {
    let candidates = app_icon_candidates(command);
    let invalid_icon_location_seen = candidates
        .iter()
        .any(|c| is_invalid_icon_location_candidate(c));
    let candidates: Vec<String> = candidates
        .into_iter()
        .filter(|candidate| !is_invalid_icon_location_candidate(candidate))
        .collect();
    IconResolutionPlan {
        candidates,
        invalid_icon_location_seen,
    }
}

// ---------------------------------------------------------------------------
// 图标缓存 flush 时机（调用方驱动）
// ---------------------------------------------------------------------------

/// TS `write` 后的去抖语义：每次写入后 `ICON_CACHE_FLUSH_DELAY_MS` 触发，
/// 但不得晚于首次脏起 `ICON_CACHE_FLUSH_MAX_WAIT_MS`。返回下一次 flush 的时刻。
pub fn next_flush_deadline(first_dirty: Instant, latest_write: Instant) -> Instant {
    (latest_write + Duration::from_millis(ICON_CACHE_FLUSH_DELAY_MS))
        .min(first_dirty + Duration::from_millis(ICON_CACHE_FLUSH_MAX_WAIT_MS))
}

// ---------------------------------------------------------------------------
// hideOnBlur 轮询决策（winit has_focus 采样，UI 线程 200ms 一拍）
// ---------------------------------------------------------------------------

/// hideOnBlur 轮询单步：输入开关、自最近一次呼出以来是否观测到焦点、当前
/// winit `has_focus` 采样；输出（是否隐藏，下一拍的“已聚焦”标记）。
///
/// 对齐 TS 的 blur-transition 语义：Electron `BrowserWindow` 的 blur 只在
/// 焦点转移沿（曾获得焦点 → 失去焦点）触发，从未获得焦点的窗口不触发 blur、
/// 保持可见。winit 的 `has_focus` 在 WM_SETFOCUS 到达前为 false，且
/// `focus_window`（SetForegroundWindow）可能被前台锁 / 提权或全屏前台应用
/// 延迟甚至拒绝——呼出后必须先观测到焦点，失焦沿才允许隐藏，否则轮询会把
/// 刚呼出（默认开启 hideOnBlur）的窗口闪隐。标记由调用方在呼出时复位。
pub fn hide_on_blur_poll_step(
    hide_on_blur_enabled: bool,
    focused_since_shown: bool,
    has_focus: bool,
) -> (bool, bool) {
    if !hide_on_blur_enabled {
        return (false, focused_since_shown);
    }
    if has_focus {
        return (false, true);
    }
    (focused_since_shown, focused_since_shown)
}

// ---------------------------------------------------------------------------
// 设置 patch JSON 解析（M2 桥接层）
// ---------------------------------------------------------------------------

/// 解析设置 patch JSON（camelCase，TS `CommandCabinSettingsPatch` 形状）。
/// 拒绝：非对象、未知顶层/搜索键、类型不符、maxResults 越界、boost 非有限数。
pub fn parse_settings_patch_json(json: &str) -> Result<SettingsPatch, String> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|error| format!("invalid settings patch JSON: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "settings patch must be a JSON object".to_string())?;

    const KEYS: &[&str] = &[
        "hotkey",
        "screenshotHotkey",
        "delayedScreenshotHotkey",
        "hideOnBlur",
        "launchAtLogin",
        "preserveSearchQuery",
        "theme",
        "language",
        "search",
    ];
    for key in object.keys() {
        if !KEYS.contains(&key.as_str()) {
            return Err(format!("unknown setting \"{key}\""));
        }
    }

    let mut patch = SettingsPatch::default();
    for (key, field) in [
        ("hotkey", &mut patch.hotkey),
        ("screenshotHotkey", &mut patch.screenshot_hotkey),
        (
            "delayedScreenshotHotkey",
            &mut patch.delayed_screenshot_hotkey,
        ),
    ] {
        if let Some(value) = object.get(key) {
            *field = Some(
                value
                    .as_str()
                    .ok_or_else(|| format!("{key} must be a string"))?
                    .to_string(),
            );
        }
    }
    for (key, field) in [
        ("hideOnBlur", &mut patch.hide_on_blur),
        ("launchAtLogin", &mut patch.launch_at_login),
        ("preserveSearchQuery", &mut patch.preserve_search_query),
    ] {
        if let Some(value) = object.get(key) {
            *field = Some(
                value
                    .as_bool()
                    .ok_or_else(|| format!("{key} must be a boolean"))?,
            );
        }
    }
    if let Some(value) = object.get("theme") {
        patch.theme = Some(match value.as_str() {
            Some("system") => cabin_core::settings::Theme::System,
            Some("light") => cabin_core::settings::Theme::Light,
            Some("dark") => cabin_core::settings::Theme::Dark,
            _ => return Err("theme must be \"system\", \"light\", or \"dark\"".to_string()),
        });
    }
    if let Some(value) = object.get("language") {
        patch.language = Some(match value.as_str() {
            Some("zh-CN") => Language::ZhCn,
            Some("zh-TW") => Language::ZhTw,
            Some("en-US") => Language::EnUs,
            _ => {
                return Err("language must be \"zh-CN\", \"zh-TW\", or \"en-US\"".to_string());
            }
        });
    }
    if let Some(value) = object.get("search") {
        let search = value
            .as_object()
            .ok_or_else(|| "search must be an object".to_string())?;
        const SEARCH_KEYS: &[&str] = &[
            "maxResults",
            "historyBoost",
            "pluginBoost",
            "appBoost",
            "fileBoost",
        ];
        for key in search.keys() {
            if !SEARCH_KEYS.contains(&key.as_str()) {
                return Err(format!("unknown search setting \"{key}\""));
            }
        }
        let mut search_patch = cabin_core::settings::SearchSettingsPatch::default();
        if let Some(value) = search.get("maxResults") {
            let parsed = value
                .as_u64()
                .filter(|value| *value <= i32::MAX as u64)
                .ok_or_else(|| "search.maxResults must be a safe integer >= 0".to_string())?;
            search_patch.max_results = Some(parsed as u32);
        }
        for (key, field) in [
            ("historyBoost", &mut search_patch.history_boost),
            ("pluginBoost", &mut search_patch.plugin_boost),
            ("appBoost", &mut search_patch.app_boost),
            ("fileBoost", &mut search_patch.file_boost),
        ] {
            if let Some(value) = search.get(key) {
                let parsed = value
                    .as_f64()
                    .filter(|value| value.is_finite())
                    .ok_or_else(|| format!("search.{key} must be a finite number"))?;
                *field = Some(parsed);
            }
        }
        patch.search = Some(search_patch);
    }
    Ok(patch)
}

// ---------------------------------------------------------------------------
// 窗口居中（M5 收口项）
// ---------------------------------------------------------------------------

/// 呼出窗口屏幕居中的原点计算（物理像素）：窗口中心与显示器中心重合。
/// `monitor_position` 为显示器原点（物理像素，多显示器/负坐标安全），
/// `monitor_size` / `window_size` 为物理宽高。窗口大于显示器时取显示器
/// 原点（钳制，避免负偏移把窗口推离屏幕）。
pub fn centered_origin(
    monitor_position: (i32, i32),
    monitor_size: (u32, u32),
    window_size: (u32, u32),
) -> (i32, i32) {
    let center = |monitor_origin: i32, monitor_len: u32, window_len: u32| -> i32 {
        let slack = monitor_len as i64 - window_len as i64;
        if slack <= 0 {
            monitor_origin
        } else {
            monitor_origin + (slack / 2) as i32
        }
    };
    (
        center(monitor_position.0, monitor_size.0, window_size.0),
        center(monitor_position.1, monitor_size.1, window_size.1),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use cabin_core::command::types::{CommandAction, CommandActionType, CommandPayload};
    use cabin_core::features::exchange_rate::ExchangeRatePeek;
    use std::rc::Rc;

    #[test]
    fn centered_origin_centers_window_on_monitor() {
        // 单屏 2560x1707 @ (0,0)，窗口 644x447：中心重合。
        assert_eq!(
            centered_origin((0, 0), (2560, 1707), (644, 447)),
            ((2560 - 644) / 2, (1707 - 447) / 2)
        );
    }

    #[test]
    fn centered_origin_honors_monitor_offset_and_clamps_oversize() {
        // 副屏偏移（含负坐标原点）被加进结果。
        assert_eq!(
            centered_origin((-1920, 100), (1920, 1080), (640, 480)),
            (-1280, 400)
        );
        // 窗口不小于显示器：钳到显示器原点。
        assert_eq!(centered_origin((0, 0), (1260, 840), (1260, 840)), (0, 0));
        assert_eq!(centered_origin((50, 60), (800, 600), (1000, 900)), (50, 60));
    }

    fn app_command(id: &str) -> Command {
        Command {
            id: id.into(),
            source: CommandSource::App,
            title: "App".into(),
            subtitle: None,
            keywords: vec![],
            icon: None,
            plugin_id: None,
            action: CommandAction {
                action_type: CommandActionType::OpenApp,
                payload: CommandPayload::new(),
            },
        }
    }

    fn app_command_with_payload(
        id: &str,
        title: &str,
        fill: impl FnOnce(&mut CommandPayload),
    ) -> Command {
        let mut payload = CommandPayload::new();
        fill(&mut payload);
        Command {
            id: id.into(),
            source: CommandSource::App,
            title: title.into(),
            subtitle: None,
            keywords: vec![],
            icon: None,
            plugin_id: None,
            action: CommandAction {
                action_type: CommandActionType::OpenApp,
                payload,
            },
        }
    }

    // ---- iso_to_unix_ms ---------------------------------------------------

    #[test]
    fn iso_to_unix_ms_matches_known_vectors() {
        assert_eq!(iso_to_unix_ms("1970-01-01T00:00:00.000Z"), Some(0));
        // 与 cabin-core disk_cache 的 iso8601_utc 互为逆变换。
        assert_eq!(
            iso_to_unix_ms("2026-09-03T00:00:00.123Z"),
            Some(1_788_393_600_123)
        );
        assert_eq!(
            iso_to_unix_ms("2024-02-29T23:59:59.999Z"),
            Some(1_709_251_199_999)
        );
        assert_eq!(
            iso_to_unix_ms("2026-05-15T10:00:00.000Z"),
            Some(1_778_839_200_000)
        );
    }

    #[test]
    fn iso_to_unix_ms_converts_offsets_to_utc() {
        // 2024-02-29T12:30:00+02:00 == 2024-02-29T10:30:00Z
        assert_eq!(
            iso_to_unix_ms("2024-02-29T12:30:00+02:00"),
            iso_to_unix_ms("2024-02-29T10:30:00.000Z")
        );
        // 2026-05-15T10:00:00-01:30 == 2026-05-15T11:30:00Z
        assert_eq!(
            iso_to_unix_ms("2026-05-15T10:00:00-01:30"),
            iso_to_unix_ms("2026-05-15T11:30:00.000Z")
        );
    }

    #[test]
    fn iso_to_unix_ms_truncates_sub_millisecond_fraction() {
        assert_eq!(
            iso_to_unix_ms("2026-05-15T10:00:00.123456Z"),
            iso_to_unix_ms("2026-05-15T10:00:00.123Z")
        );
        assert_eq!(
            iso_to_unix_ms("2026-05-15T10:00:00.5Z"),
            iso_to_unix_ms("2026-05-15T10:00:00.500Z")
        );
    }

    #[test]
    fn iso_to_unix_ms_accepts_plain_seconds() {
        assert_eq!(
            iso_to_unix_ms("2026-05-15T10:00:00Z"),
            Some(1_778_839_200_000)
        );
    }

    #[test]
    fn iso_to_unix_ms_rejects_malformed_shapes() {
        for value in [
            "",
            "not-a-date",
            "2026-05-15",
            "2026-05-15T10:00",
            "2026-05-15T10:00:00",
            "2026-13-01T00:00:00Z",
            "2026-05-15T10:00:00+25:00",
            "2026-05-15T10:00:00Zx",
            "2026-05-15T10:00:00.+02:00",
        ] {
            assert_eq!(iso_to_unix_ms(value), None, "input: {value:?}");
        }
    }

    // ---- record condition --------------------------------------------------

    #[test]
    fn favorite_prefix_commands_are_recorded_on_success() {
        let mut command = app_command("favorite.ba7816bf8f01");
        command.source = CommandSource::Url;
        command.action.action_type = CommandActionType::OpenUrl;
        assert!(should_record_execution(true, &command));
        assert!(!should_record_execution(false, &command));
    }

    #[test]
    fn app_commands_are_recorded_and_non_app_are_not() {
        let mut command = app_command("app.abc");
        assert!(should_record_execution(true, &command));

        command.source = CommandSource::Plugin;
        command.plugin_id = Some("com.example".into());
        assert!(!should_record_execution(true, &command));

        // source==app 但 open-path（索引的非可执行目标）不算 app 命令。
        command.source = CommandSource::App;
        command.action.action_type = CommandActionType::OpenPath;
        assert!(!should_record_execution(true, &command));

        command.action.action_type = CommandActionType::CopyText;
        assert!(!should_record_execution(true, &command));
    }

    #[test]
    fn system_commands_are_never_recorded() {
        // M3 Task 9：截图系统命令（source=system / run-system）执行成功不进
        // 历史（TS 历史仅收藏/app 命令；首页 recent 亦不受系统命令影响）。
        let mut command = app_command("system.screenshot.capture");
        command.source = CommandSource::System;
        command.action.action_type = CommandActionType::RunSystem;
        assert!(!should_record_execution(true, &command));
    }

    #[test]
    fn favorite_prefix_requires_the_literal_prefix() {
        assert!(is_favorite_command_id("favorite.abc123"));
        assert!(is_favorite_command_id("favorite."));
        assert!(!is_favorite_command_id("xfavorite.abc"));
        assert!(!is_favorite_command_id("app.abc"));
    }

    // ---- ranking context ---------------------------------------------------

    #[test]
    fn build_ranking_context_overrides_only_app_file_plugin_weights() {
        let search = SearchSettings {
            history_boost: 2.0,
            app_boost: 1.5,
            file_boost: 0.5,
            plugin_boost: 3.0,
            max_results: 20,
        };
        let context = build_ranking_context(&Vec::new(), &search, 42);

        let weights = context.source_weights.as_ref().expect("weights");
        assert_eq!(
            weights.get(&CommandSource::App),
            Some(&(default_source_weight(CommandSource::App) * 1.5))
        );
        assert_eq!(
            weights.get(&CommandSource::File),
            Some(&(default_source_weight(CommandSource::File) * 0.5))
        );
        assert_eq!(
            weights.get(&CommandSource::Plugin),
            Some(&(default_source_weight(CommandSource::Plugin) * 3.0))
        );
        // system/url 不覆盖：走 rank 层的 default_source_weight。
        assert!(!weights.contains_key(&CommandSource::System));
        assert!(!weights.contains_key(&CommandSource::Url));
        assert_eq!(context.history_weight, Some(2.0));
        assert_eq!(context.now_ms, Some(42));
        assert!(context.pinned_command_ids.is_empty());
    }

    #[test]
    fn build_history_entries_maps_rows_to_unix_millis() {
        let rows: HistoryRows = vec![
            (
                "app.a".into(),
                CommandSource::App,
                3,
                "2026-05-15T10:00:00.000Z".into(),
            ),
            (
                "app.b".into(),
                CommandSource::App,
                1,
                "2024-02-29T12:30:00+02:00".into(),
            ),
        ];
        let entries = build_history_entries(&rows);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries["app.a"].execution_count, 3);
        assert_eq!(entries["app.a"].last_used_at_ms, Some(1_778_839_200_000));
        // 偏移时间戳换算为 UTC 毫秒。
        assert_eq!(
            entries["app.b"].last_used_at_ms,
            iso_to_unix_ms("2024-02-29T10:30:00.000Z")
        );
    }

    #[test]
    fn search_limit_clamps_to_ts_domain() {
        assert_eq!(search_limit(0), 0);
        assert_eq!(search_limit(20), 20);
        assert_eq!(search_limit(500), 100);
    }

    // ---- M4 Task 7：显式剪贴板查询 / 搜索扩容 / 剪贴板降级 ----

    fn plugin_command(id: &str, title: &str) -> Command {
        Command {
            id: id.into(),
            source: CommandSource::Plugin,
            title: title.into(),
            subtitle: None,
            keywords: vec![],
            icon: None,
            plugin_id: None,
            action: cabin_core::command::types::CommandAction {
                action_type: cabin_core::command::types::CommandActionType::CopyText,
                payload: cabin_core::command::types::CommandPayload::new(),
            },
        }
    }

    fn clipboard_command(entry_id: i64) -> Command {
        let entry = cabin_core::features::clipboard_history::ClipboardHistoryEntry {
            id: entry_id,
            text: format!("entry {entry_id}"),
            copied_at: "2026-09-04T00:00:00.000Z".into(),
        };
        cabin_core::features::clipboard_history::create_clipboard_history_commands(&[entry])
            .remove(0)
    }

    #[test]
    fn explicit_clipboard_query_matches_words_and_phrases() {
        // TS isExplicitClipboardHistoryQuery：整词命中（大小写不敏感）+ 中文短语。
        for query in [
            "clip",
            "  CLIP ",
            "clipboard",
            "my history",
            "clip2 history", // 至少一个词命中即可
            "clip-board",    // 连字符分词出独立的 "clip"
            "剪贴板",
            "粘贴板",
            "剪切板",
            "清空剪贴板历史",
        ] {
            assert!(is_explicit_clipboard_history_query(query), "{query:?}");
        }
        // 非显式：整词相等才命中（前缀/粘连/子串不算）。
        for query in ["", "   ", "cli", "clipping", "clip2", "eclipse"] {
            assert!(!is_explicit_clipboard_history_query(query), "{query:?}");
        }
    }

    #[test]
    fn engine_search_limit_expands_only_for_non_explicit_queries() {
        // TS：显式剪贴板查询 → limit；其余 → limit + 200。
        assert_eq!(engine_search_limit("clip", 10), 10);
        assert_eq!(engine_search_limit("剪贴板", 10), 10);
        assert_eq!(engine_search_limit("hello", 10), 210);
        assert_eq!(engine_search_limit("", 10), 210);
        // maxResults 已 clamp 到 100。
        assert_eq!(engine_search_limit("hello", 500), 300);
    }

    #[test]
    fn demote_moves_clipboard_entries_after_primary_with_cap() {
        let results = vec![
            app_command("app.a"),
            clipboard_command(1),
            app_command("app.b"),
            clipboard_command(2),
            clipboard_command(3),
            plugin_command("calculator.result", "2"),
        ];
        let demoted = demote_clipboard_history_results("hello", results, 10);
        let ids: Vec<&str> = demoted.iter().map(|command| command.id.as_str()).collect();
        // 剪贴板条目移到主结果之后、至多 2 条（第三条被丢弃）。
        assert_eq!(
            ids,
            vec![
                "app.a",
                "app.b",
                "calculator.result",
                "clipboard-history.entry.1",
                "clipboard-history.entry.2"
            ]
        );
    }

    #[test]
    fn demote_truncates_to_limit_and_explicit_query_keeps_inline_order() {
        let results = vec![
            app_command("app.a"),
            clipboard_command(1),
            app_command("app.b"),
        ];
        // 非显式：截断到 limit。
        let demoted = demote_clipboard_history_results("hello", results.clone(), 2);
        assert_eq!(demoted.len(), 2);
        // 显式剪贴板查询：原序保留（仅截断），剪贴板条目不降级。
        let kept = demote_clipboard_history_results("clip", results, 10);
        let ids: Vec<&str> = kept.iter().map(|command| command.id.as_str()).collect();
        assert_eq!(ids, vec!["app.a", "clipboard-history.entry.1", "app.b"]);
    }

    // ---- M4 Task 7：动态即时命令槽（calculator → quick-converter） ----

    fn live_rate(rate: f64) -> cabin_core::features::quick_converter::ExchangeRateResult {
        cabin_core::features::quick_converter::ExchangeRateResult {
            fetched_at: "2026-05-18T00:00:00.000Z".into(),
            provider: "Frankfurter".into(),
            rate,
            source: cabin_core::features::quick_converter::ExchangeRateResultSource::Cache,
            updated_at: "2026-05-18".into(),
        }
    }

    #[test]
    fn dynamic_slot_produces_calculator_only_for_math_queries() {
        let plan = dynamic_slot_plan("1+1", ExchangeRatePeek::Missing);
        assert_eq!(plan.calculator.expect("calculator command").title, "2");
        assert_eq!(plan.converter, None);
        assert!(!plan.needs_rate_refresh);

        // 非表达式查询无 calculator 命令。
        let plan = dynamic_slot_plan("hello world", ExchangeRatePeek::Missing);
        assert_eq!(plan.calculator, None);
        assert_eq!(plan.converter, None);
        assert!(!plan.needs_rate_refresh);
    }

    #[test]
    fn dynamic_slot_produces_static_conversion_without_rate() {
        for query in ["1厘米", "2.5kg", "1cm x 2cm x 3cm"] {
            let plan = dynamic_slot_plan(query, ExchangeRatePeek::Missing);
            assert!(plan.calculator.is_none(), "{query}");
            assert!(plan.converter.is_some(), "{query}");
            assert!(!plan.needs_rate_refresh, "{query}");
        }
    }

    #[test]
    fn dynamic_slot_currency_uses_rate_and_requests_refresh_for_stale_or_missing() {
        // 新鲜缓存：立即出命令，无需刷新。
        let plan = dynamic_slot_plan("1美元", ExchangeRatePeek::Fresh(live_rate(7.1)));
        let converter = plan.converter.expect("currency command");
        assert_eq!(converter.id, "quick-converter.result");
        assert_eq!(converter.title, "1 美元 ≈ 7.10 人民币");
        assert_eq!(
            converter.subtitle.as_deref(),
            Some("缓存汇率 · 更新时间 2026-05-18")
        );
        assert!(!plan.needs_rate_refresh);
        assert!(plan.calculator.is_none());

        // 过期缓存：旧缓存立即出命令（TS 立即返回旧缓存）+ 请求后台刷新
        // （TS `void refreshRate()`）；否则缓存一旦建立就永不刷新。旧汇率值
        // 须嵌入标题（本拍展示的就是旧值，非 Fresh 分支的占位）。
        let plan = dynamic_slot_plan("1美元", ExchangeRatePeek::Stale(live_rate(7.1)));
        let converter = plan.converter.expect("currency command");
        assert_eq!(converter.id, "quick-converter.result");
        assert_eq!(converter.title, "1 美元 ≈ 7.10 人民币");
        assert_eq!(
            converter.subtitle.as_deref(),
            Some("缓存汇率 · 更新时间 2026-05-18")
        );
        assert!(plan.needs_rate_refresh);
        assert!(plan.calculator.is_none());

        // 无缓存 → 本次无命令 + 请求后台刷新（TS await 的异步化）。
        let plan = dynamic_slot_plan("1美元", ExchangeRatePeek::Missing);
        assert_eq!(plan.converter, None);
        assert!(plan.needs_rate_refresh);
    }

    #[test]
    fn dynamic_slot_is_empty_for_unrelated_queries() {
        let plan = dynamic_slot_plan("visual studio", ExchangeRatePeek::Missing);
        assert_eq!(
            plan,
            super::DynamicSlotPlan {
                calculator: None,
                converter: None,
                needs_rate_refresh: false,
            }
        );
    }

    // ---- home list ---------------------------------------------------------

    fn stored_lookup(
        map: std::collections::HashMap<String, Command>,
    ) -> impl Fn(&str) -> Option<Command> {
        move |id: &str| map.get(id).cloned()
    }

    #[test]
    fn home_recent_entries_filter_to_registered_app_commands() {
        let mut registered = app_command("app.a");
        registered.subtitle = Some(r"C:\apps\a.exe".into());
        let mut map = std::collections::HashMap::new();
        map.insert("app.a".to_string(), registered);
        let mut non_app = app_command("app.b");
        non_app.action.action_type = CommandActionType::OpenPath;
        map.insert("app.b".to_string(), non_app);

        let rows: HistoryRows = vec![
            (
                "app.missing".into(),
                CommandSource::App,
                9,
                "2026-05-16T10:00:00.000Z".into(),
            ),
            (
                "app.b".into(),
                CommandSource::App,
                5,
                "2026-05-15T10:00:00.000Z".into(),
            ),
            (
                "app.a".into(),
                CommandSource::App,
                3,
                "2026-05-14T10:00:00.000Z".into(),
            ),
            (
                "app.history-source".into(),
                CommandSource::Plugin,
                7,
                "2026-05-13T10:00:00.000Z".into(),
            ),
        ];
        let entries = home_recent_entries(&rows, &stored_lookup(map));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].command.id, "app.a");
        assert_eq!(entries[0].execution_count, 3);
    }

    #[test]
    fn home_sections_split_recent_and_pinned() {
        let mut registered = app_command("app.a");
        registered.subtitle = Some(r"C:\apps\a.exe".into());
        let mut map = std::collections::HashMap::new();
        map.insert("app.a".to_string(), registered);
        let rows: HistoryRows = vec![(
            "app.a".into(),
            CommandSource::App,
            3,
            "2026-05-14T10:00:00.000Z".into(),
        )];
        let pinned = vec![app_command("favorite.p1")];

        let (recent, pinned_home) = home_sections(&rows, &stored_lookup(map), &pinned);
        let recent_ids: Vec<&str> = recent.iter().map(|command| command.id.as_str()).collect();
        let pinned_ids: Vec<&str> = pinned_home
            .iter()
            .map(|command| command.id.as_str())
            .collect();
        assert_eq!(recent_ids, vec!["app.a"]);
        assert_eq!(pinned_ids, vec!["favorite.p1"]);
    }

    // ---- 首页固定磁贴（UI 修复 1：5×2 横向网格的纯逻辑部分）----------------

    fn app_command_with_subtitle(id: &str, subtitle: &str) -> Command {
        let mut command = app_command(id);
        command.subtitle = Some(subtitle.to_string());
        command
    }

    #[test]
    fn home_pinned_tiles_caps_at_ten_in_favorite_order() {
        let pinned: Vec<Command> = (0..12)
            .map(|i| {
                app_command_with_subtitle(&format!("favorite.p{i}"), &format!(r"C:\apps\p{i}.exe"))
            })
            .collect();

        let tiles = home_pinned_tiles(&pinned);
        assert_eq!(tiles.len(), HOME_TILE_LIMIT);
        let ids: Vec<&str> = tiles.iter().map(|command| command.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "favorite.p0",
                "favorite.p1",
                "favorite.p2",
                "favorite.p3",
                "favorite.p4",
                "favorite.p5",
                "favorite.p6",
                "favorite.p7",
                "favorite.p8",
                "favorite.p9"
            ]
        );
    }

    #[test]
    fn home_pinned_tiles_keeps_apps_that_are_also_recent() {
        // 网格与"最近使用"是独立分区：同一应用同时出现在两侧是有意行为
        // （用户要求"现有固定行整体变网格"，按 recent 排除会让固定应用隐没）。
        let pinned = vec![
            app_command_with_subtitle("favorite.wps", r"C:\Program Files\WPS\wps.exe"),
            app_command_with_subtitle("favorite.other", r"C:\apps\other.exe"),
        ];

        let tiles = home_pinned_tiles(&pinned);
        let ids: Vec<&str> = tiles.iter().map(|command| command.id.as_str()).collect();
        assert_eq!(ids, vec!["favorite.wps", "favorite.other"]);
    }

    #[test]
    fn home_pinned_tiles_dedups_within_pinned_first_wins() {
        let pinned = vec![
            app_command_with_subtitle("favorite.a", r"C:\apps\one.exe"),
            app_command_with_subtitle("favorite.a2", r"c:\apps\one.exe"),
            app_command_with_subtitle("favorite.b", r"C:\apps\two.exe"),
        ];

        let tiles = home_pinned_tiles(&pinned);
        let ids: Vec<&str> = tiles.iter().map(|command| command.id.as_str()).collect();
        assert_eq!(ids, vec!["favorite.a", "favorite.b"]);
    }

    #[test]
    fn home_pinned_tiles_empty_inputs_yield_empty() {
        assert!(home_pinned_tiles(&[]).is_empty());
    }

    // ---- UI 修复 2：磁贴网格键盘导航 / 初始选中 / Enter 执行路由 ----

    #[test]
    fn move_tile_selection_moves_within_row_and_column() {
        // 横向：右/左各一步（网格 5 列）。
        assert_eq!(move_tile_selection(1, 0, 0, 10), Some(1));
        assert_eq!(move_tile_selection(-1, 0, 1, 10), Some(0));
        // 纵向：下/上各一行（±5）。
        assert_eq!(move_tile_selection(0, 1, 0, 10), Some(5));
        assert_eq!(move_tile_selection(0, -1, 5, 10), Some(0));
    }

    #[test]
    fn move_tile_selection_blocks_at_column_edges_without_wrapping() {
        // 第 0 列左移不动（不回绕到上一行末尾）。
        assert_eq!(move_tile_selection(-1, 0, 0, 10), None);
        assert_eq!(move_tile_selection(-1, 0, 5, 10), None);
        // 第 4 列右移不动（不回绕到下一行行首）。
        assert_eq!(move_tile_selection(1, 0, 4, 10), None);
        assert_eq!(move_tile_selection(1, 0, 9, 10), None);
    }

    #[test]
    fn move_tile_selection_blocks_at_grid_edges() {
        // 首行上移不动。
        for index in 0..HOME_TILE_COLUMNS {
            assert_eq!(move_tile_selection(0, -1, index, 10), None, "index {index}");
        }
        // 末行下移不动（满 5 的第二行）。
        assert_eq!(move_tile_selection(0, 1, 5, 10), None);
        assert_eq!(move_tile_selection(0, 1, 9, 10), None);
    }

    #[test]
    fn move_tile_selection_clamps_to_partial_last_row() {
        // 8 个磁贴：第二行只有 3 个（5..8），列边界按下标算。
        assert_eq!(move_tile_selection(0, 1, 2, 8), Some(7));
        // 3+5=8 越过末尾：下移不动（不回绕）。
        assert_eq!(move_tile_selection(0, 1, 3, 8), None);
        // 尾行最后一个右移不动（最后一个磁贴）。
        assert_eq!(move_tile_selection(1, 0, 7, 8), None);
        assert_eq!(move_tile_selection(1, 0, 6, 8), Some(7));
        assert_eq!(move_tile_selection(0, -1, 7, 8), Some(2));
    }

    #[test]
    fn move_tile_selection_degenerate_inputs() {
        // 空网格 / 越界下标 → None（防御）；零位移 → 原地不动。
        assert_eq!(move_tile_selection(1, 0, 0, 0), None);
        assert_eq!(move_tile_selection(0, 1, 10, 10), None);
        assert_eq!(move_tile_selection(0, 0, 3, 10), Some(3));
        // 单磁贴四向皆不动。
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            assert_eq!(move_tile_selection(dx, dy, 0, 1), None, "({dx},{dy})");
        }
    }

    #[test]
    fn initial_tile_selection_homes_to_first_tile_only_with_tiles() {
        assert_eq!(initial_tile_selection(true, 0), None);
        assert_eq!(initial_tile_selection(true, 3), Some(0));
        assert_eq!(initial_tile_selection(false, 3), None);
    }

    #[test]
    fn execute_tile_route_validates_selected_tile() {
        assert_eq!(execute_tile_route(2, 5), Some(2));
        assert_eq!(execute_tile_route(0, 5), Some(0));
        // 无选中（-1）/ 越界 / 空网格 → 不路由磁贴（走平铺列表路径）。
        assert_eq!(execute_tile_route(-1, 5), None);
        assert_eq!(execute_tile_route(5, 5), None);
        assert_eq!(execute_tile_route(0, 0), None);
    }

    // ---- settings decision table -------------------------------------------

    fn patch_with_hotkey(hotkey: Option<&str>) -> SettingsPatch {
        SettingsPatch {
            hotkey: hotkey.map(str::to_string),
            ..SettingsPatch::default()
        }
    }

    #[test]
    fn normalize_patch_hotkeys_normalizes_present_fields_only() {
        // 注意：normalize_hotkey 的修饰键表大小写敏感（TS hotkeyModifiers 逐字），
        // 故输入用规范大小写；trim 与单字符键大写仍被验证。
        let mut patch = SettingsPatch {
            hotkey: Some("Ctrl + k".into()),
            screenshot_hotkey: Some("Shift+Alt+s".into()),
            ..SettingsPatch::default()
        };
        normalize_patch_hotkeys(&mut patch).expect("normalize");
        assert_eq!(patch.hotkey.as_deref(), Some("Ctrl+K"));
        assert_eq!(patch.screenshot_hotkey.as_deref(), Some("Alt+Shift+S"));
        assert_eq!(patch.delayed_screenshot_hotkey, None);
    }

    #[test]
    fn normalize_patch_hotkeys_reports_invalid_input() {
        // 小写 "ctrl" 不在 TS 修饰键表内。
        let mut patch = patch_with_hotkey(Some("ctrl+k"));
        let error = normalize_patch_hotkeys(&mut patch).expect_err("case-sensitive table");
        assert_eq!(error, "Hotkey contains unsupported modifier \"ctrl\".");

        let mut patch = patch_with_hotkey(Some("K"));
        let error = normalize_patch_hotkeys(&mut patch).expect_err("missing modifier");
        assert_eq!(error, "Hotkey must include at least one modifier.");
        // 失败时字段原样保留（不产出半规范化值）。
        assert_eq!(patch.hotkey.as_deref(), Some("K"));
    }

    #[test]
    fn assert_merged_hotkeys_unique_uses_patch_overrides() {
        let current = Settings::default();
        // patch 与当前 screenshot 冲突：后写字段（screenshot）被报告为冲突方。
        let patch = patch_with_hotkey(Some("Ctrl+Alt+A"));
        let error = assert_merged_hotkeys_unique(&current, &patch).expect_err("conflict");
        assert_eq!(
            error,
            "CommandCabin shortcuts must be unique. screenshot conflicts with launcher: Ctrl+Alt+A."
        );

        // patch 同时改两个字段且互不相同。
        let mut both = patch_with_hotkey(Some("Ctrl+Alt+A"));
        both.screenshot_hotkey = Some("Ctrl+Alt+B".into());
        assert!(assert_merged_hotkeys_unique(&current, &both).is_ok());

        // 别名等价（control == ctrl）也冲突。
        let mut alias = patch_with_hotkey(Some("Control+Alt+A"));
        alias.screenshot_hotkey = Some("Ctrl+Alt+A".into());
        assert!(assert_merged_hotkeys_unique(&current, &alias).is_err());
    }

    #[test]
    fn hotkey_registrations_decision_table() {
        let current = Settings::default();
        // 无热键字段 → 空。
        assert!(hotkey_registrations(&current, &SettingsPatch::default()).is_empty());
        // 与当前相同 → 跳过。
        assert!(hotkey_registrations(&current, &patch_with_hotkey(Some("Alt+Space"))).is_empty());
        // 变更 → 记录回滚目标为当前值。
        let plan = hotkey_registrations(&current, &patch_with_hotkey(Some("Ctrl+Space")));
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].field, HOTKEY_FIELD_LAUNCHER);
        assert_eq!(plan[0].new_hotkey, "Ctrl+Space");
        assert_eq!(plan[0].rollback_hotkey, "Alt+Space");

        // 三个字段全部变更时保持固定顺序。
        let mut all = patch_with_hotkey(Some("Ctrl+1"));
        all.screenshot_hotkey = Some("Ctrl+2".into());
        all.delayed_screenshot_hotkey = Some("Ctrl+3".into());
        let plan = hotkey_registrations(&current, &all);
        let fields: Vec<&str> = plan.iter().map(|entry| entry.field).collect();
        assert_eq!(
            fields,
            vec![
                HOTKEY_FIELD_LAUNCHER,
                HOTKEY_FIELD_SCREENSHOT,
                HOTKEY_FIELD_DELAYED_SCREENSHOT
            ]
        );
    }

    #[test]
    fn register_hotkeys_with_rollback_follows_ts_order_semantics() {
        let current = Settings::default();
        let mut patch = patch_with_hotkey(Some("Ctrl+1"));
        patch.screenshot_hotkey = Some("Ctrl+2".into());
        patch.delayed_screenshot_hotkey = Some("Ctrl+3".into());
        let registrations = hotkey_registrations(&current, &patch);
        assert_eq!(registrations.len(), 3);

        // 全部成功：注册顺序 = 决策表顺序，persist 恰好一次。
        // 两个闭包共享调用日志 → Rc<RefCell>。
        type Log = std::rc::Rc<std::cell::RefCell<Vec<String>>>;
        fn log_call(log: &Log, message: String) {
            log.borrow_mut().push(message);
        }

        let calls: Log = Log::default();
        register_hotkeys_with_rollback::<&'static str>(
            &registrations,
            {
                let calls = Rc::clone(&calls);
                move |registration| {
                    log_call(&calls, format!("register {}", registration.new_hotkey));
                    Ok(())
                }
            },
            {
                let calls = Rc::clone(&calls);
                move |registration| {
                    log_call(&calls, format!("restore {}", registration.rollback_hotkey))
                }
            },
            {
                let calls = Rc::clone(&calls);
                move || {
                    log_call(&calls, "persist".into());
                    Ok(())
                }
            },
        )
        .expect("all registrations succeed");
        assert_eq!(
            calls.borrow().clone(),
            vec![
                "register Ctrl+1",
                "register Ctrl+2",
                "register Ctrl+3",
                "persist"
            ]
        );

        // 第二个注册失败：逆序回滚已注册者（仅第一个），错误文案逐字 TS。
        let calls: Log = Log::default();
        let error = register_hotkeys_with_rollback::<&'static str>(
            &registrations,
            {
                let calls = Rc::clone(&calls);
                move |registration| {
                    if registration.new_hotkey == "Ctrl+2" {
                        return Err(());
                    }
                    log_call(&calls, format!("register {}", registration.new_hotkey));
                    Ok(())
                }
            },
            {
                let calls = Rc::clone(&calls);
                move |registration| {
                    log_call(&calls, format!("restore {}", registration.rollback_hotkey))
                }
            },
            || unreachable!("persist must not run after registration failure"),
        )
        .expect_err("second registration fails");
        assert_eq!(error, hotkey_registration_error("Ctrl+2"));
        assert_eq!(
            error,
            "CommandCabin could not register Ctrl+2. Another application or the operating system may already be using this shortcut."
        );
        assert_eq!(
            calls.borrow().clone(),
            vec!["register Ctrl+1", "restore Alt+Space"]
        );

        // persist 失败：全部注册被逆序回滚（恢复值为各字段旧值）。
        let calls: Log = Log::default();
        let error = register_hotkeys_with_rollback(
            &registrations,
            {
                let calls = Rc::clone(&calls);
                move |registration| {
                    log_call(&calls, format!("register {}", registration.new_hotkey));
                    Ok(())
                }
            },
            {
                let calls = Rc::clone(&calls);
                move |registration| {
                    log_call(&calls, format!("restore {}", registration.rollback_hotkey))
                }
            },
            || Err("db broken"),
        )
        .expect_err("persist fails");
        assert_eq!(error, "db broken");
        assert_eq!(
            calls.borrow().clone(),
            vec![
                "register Ctrl+1",
                "register Ctrl+2",
                "register Ctrl+3",
                "restore Ctrl+Alt+D",
                "restore Ctrl+Alt+A",
                "restore Alt+Space"
            ]
        );
    }

    #[test]
    fn register_hotkeys_with_rollback_tolerates_failing_restore() {
        let current = Settings::default();
        let patch = patch_with_hotkey(Some("Ctrl+1"));
        let registrations = hotkey_registrations(&current, &patch);
        // persist 失败触发回滚；恢复（re-register 旧值）失败被忽略，错误仍按
        // persist 结果返回（TS 忽略回滚动作的结果）。
        let error = register_hotkeys_with_rollback::<&'static str>(
            &registrations,
            |_| Ok(()),
            |_| { /* 模拟恢复失败：什么都不做 */ },
            || Err("persist failed"),
        );
        assert_eq!(error.expect_err("persist fails"), "persist failed");
    }

    // ---- tray texts ---------------------------------------------------------

    #[test]
    fn tray_texts_match_ts_labels() {
        assert_eq!(
            tray_texts(Language::ZhCn),
            ("显示 CommandCabin", "设置", "退出")
        );
        assert_eq!(
            tray_texts(Language::ZhTw),
            ("顯示 CommandCabin", "設定", "結束")
        );
        assert_eq!(
            tray_texts(Language::EnUs),
            ("Show CommandCabin", "Settings", "Quit")
        );
    }

    // ---- icon candidates -----------------------------------------------------

    #[test]
    fn app_icon_candidates_follow_ts_order_and_dedup() {
        let mut command = app_command("app.a");
        command.icon = Some(r"C:\app\icon.ico".into());
        command.subtitle = Some(r"C:\app\app.exe".into());
        command
            .action
            .payload
            .insert("appUserModelId".into(), "A!B".into());
        command
            .action
            .payload
            .insert("executablePath".into(), r"C:\app\app.exe".into());
        command
            .action
            .payload
            .insert("shortcutPath".into(), r"C:\app\app.lnk".into());

        assert_eq!(
            app_icon_candidates(&command),
            vec![
                r"C:\app\icon.ico".to_string(),
                "A!B".to_string(),
                r"C:\app\app.exe".to_string(),
                // subtitle 与 executablePath 重复被去重。
                r"C:\app\app.lnk".to_string(),
            ]
        );
    }

    #[test]
    fn app_icon_candidates_empty_for_non_app_commands() {
        let mut command = app_command("favorite.x");
        command.source = CommandSource::File;
        command.action.action_type = CommandActionType::OpenPath;
        command.icon = Some(r"C:\x.png".into());
        assert!(app_icon_candidates(&command).is_empty());
    }

    #[test]
    fn invalid_icon_location_candidates_are_index_only() {
        assert!(is_invalid_icon_location_candidate(",0"));
        assert!(is_invalid_icon_location_candidate(" ,12 "));
        assert!(!is_invalid_icon_location_candidate(r"C:\a.exe,0"));
        assert!(!is_invalid_icon_location_candidate(r"C:\a.exe"));
        assert!(!is_invalid_icon_location_candidate(",x"));
        assert!(!is_invalid_icon_location_candidate(","));
    }

    #[test]
    fn plan_icon_resolution_drops_invalid_and_flags_it() {
        let mut command = app_command("app.a");
        command.icon = Some(",0".into());
        command
            .action
            .payload
            .insert("executablePath".into(), r"C:\app\app.exe".into());

        let plan = plan_icon_resolution(&command);
        assert!(plan.invalid_icon_location_seen);
        // 无效候选被剔除，目标 exe 保留（提取线程按序尝试 → 对应 TS
        // hasInvalidIconLocationCandidate 时的 associated-icon 回退目标）。
        assert_eq!(plan.candidates, vec![r"C:\app\app.exe".to_string()]);

        let mut clean = app_command("app.b");
        clean.icon = Some(r"C:\app\icon.ico".into());
        let plan = plan_icon_resolution(&clean);
        assert!(!plan.invalid_icon_location_seen);
        assert_eq!(plan.candidates, vec![r"C:\app\icon.ico".to_string()]);
    }

    // ---- flush deadline --------------------------------------------------------

    #[test]
    fn flush_deadline_is_debounce_capped_by_max_wait() {
        let first = Instant::now();
        // 写入较晚：去抖到期晚于最长等待 → 取最长等待。
        let latest = first + Duration::from_millis(1_400);
        assert_eq!(
            next_flush_deadline(first, latest),
            first + Duration::from_millis(ICON_CACHE_FLUSH_MAX_WAIT_MS)
        );
        // 写入紧跟首次脏：去抖 500ms 先到。
        let latest = first + Duration::from_millis(10);
        assert_eq!(
            next_flush_deadline(first, latest),
            latest + Duration::from_millis(ICON_CACHE_FLUSH_DELAY_MS)
        );
    }

    // ---- hide-on-blur poll step ---------------------------------------------

    #[test]
    fn hide_on_blur_poll_hides_only_on_focus_loss_after_observed_focus() {
        // 呼出后从未获得焦点（WM_SETFOCUS 未到 / SetForegroundWindow 被拒）：
        // 不隐藏、标记保持 false —— 对齐 TS blur-transition 语义。
        assert_eq!(hide_on_blur_poll_step(true, false, false), (false, false));
        // 焦点到达：不隐藏，记录已聚焦。
        assert_eq!(hide_on_blur_poll_step(true, false, true), (false, true));
        // 已聚焦后失焦：隐藏（焦点转移沿），标记保持。
        assert_eq!(hide_on_blur_poll_step(true, true, false), (true, true));
        // 持续聚焦：不隐藏。
        assert_eq!(hide_on_blur_poll_step(true, true, true), (false, true));
    }

    #[test]
    fn hide_on_blur_poll_disabled_never_hides_and_keeps_flag() {
        assert_eq!(hide_on_blur_poll_step(false, true, false), (false, true));
        assert_eq!(hide_on_blur_poll_step(false, false, true), (false, false));
    }

    #[test]
    fn hide_on_blur_poll_sequence_survives_delayed_focus_after_show() {
        // 评审场景：呼出后 focus_window 被前台锁延迟，轮询在前两拍采到未聚焦 ——
        // 不得闪隐；焦点到达后再失焦才隐藏。呼出复位由调用方负责（此处从 false 起）。
        let mut focused_since_shown = false;
        let mut step = |has_focus: bool| {
            let (should_hide, next) = hide_on_blur_poll_step(true, focused_since_shown, has_focus);
            focused_since_shown = next;
            should_hide
        };
        assert!(!step(false), "summon tick before WM_SETFOCUS");
        assert!(!step(false), "foreground lock still delaying focus");
        assert!(!step(true), "focus arrives");
        assert!(step(false), "user clicks elsewhere");
    }

    // ---- settings patch JSON -----------------------------------------------------

    #[test]
    fn parse_settings_patch_json_accepts_ts_shaped_patches() {
        let patch = parse_settings_patch_json(
            r#"{"hotkey":"ctrl+space","hideOnBlur":false,"theme":"dark","language":"en-US",
                "search":{"maxResults":30,"historyBoost":2.5}}"#,
        )
        .expect("valid patch");
        assert_eq!(patch.hotkey.as_deref(), Some("ctrl+space"));
        assert_eq!(patch.hide_on_blur, Some(false));
        assert_eq!(patch.language, Some(Language::EnUs));
        assert_eq!(patch.theme, Some(cabin_core::settings::Theme::Dark));
        let search = patch.search.expect("search");
        assert_eq!(search.max_results, Some(30));
        assert_eq!(search.history_boost, Some(2.5));
        assert_eq!(patch.screenshot_hotkey, None);
    }

    #[test]
    fn parse_settings_patch_json_rejects_malformed_input() {
        assert!(parse_settings_patch_json("{bad").is_err());
        assert!(parse_settings_patch_json("[]").is_err());
        assert!(parse_settings_patch_json(r#"{"surprise":1}"#)
            .expect_err("unknown key")
            .contains("unknown setting \"surprise\""));
        assert!(parse_settings_patch_json(r#"{"search":{"nope":1}}"#).is_err());
        assert!(parse_settings_patch_json(r#"{"hotkey":42}"#).is_err());
        assert!(parse_settings_patch_json(r#"{"hideOnBlur":"yes"}"#).is_err());
        assert!(parse_settings_patch_json(r#"{"theme":"neon"}"#).is_err());
        assert!(parse_settings_patch_json(r#"{"language":"fr-FR"}"#).is_err());
        assert!(parse_settings_patch_json(r#"{"search":{"maxResults":-1}}"#).is_err());
        assert!(parse_settings_patch_json(r#"{"search":{"historyBoost":"x"}}"#).is_err());
        assert!(parse_settings_patch_json(r#"{"search":{"pluginBoost":1e999}}"#).is_err());
    }

    #[test]
    fn parse_settings_patch_json_round_trips_through_apply_patch() {
        let current = Settings::default();
        let patch =
            parse_settings_patch_json(r#"{"search":{"maxResults":50},"launchAtLogin":true}"#)
                .expect("valid");
        let next = current.apply_patch(&patch).expect("apply");
        assert_eq!(next.search.max_results, 50);
        assert!(next.launch_at_login);
        assert_eq!(next.hotkey, "Alt+Space");
    }

    // ---- settings UI view helpers (Task 10) -------------------------------

    #[test]
    fn format_decimal_uses_shortest_display() {
        assert_eq!(format_decimal(1.0), "1");
        assert_eq!(format_decimal(1.4), "1.4");
        assert_eq!(format_decimal(0.9), "0.9");
        assert_eq!(format_decimal(3.25), "3.25");
    }

    #[test]
    fn theme_and_language_index_round_trip_through_patch_json() {
        let defaults = Settings::default();
        assert_eq!(theme_index(defaults.theme), 0);
        assert_eq!(language_index(defaults.language), 0);
        assert_eq!(theme_index(Theme::Light), 1);
        assert_eq!(theme_index(Theme::Dark), 2);
        assert_eq!(language_index(Language::ZhTw), 1);
        assert_eq!(language_index(Language::EnUs), 2);

        let patch = parse_settings_patch_json(&theme_patch_json(2).expect("theme")).expect("patch");
        assert_eq!(patch.theme, Some(Theme::Dark));
        let patch =
            parse_settings_patch_json(&language_patch_json(1).expect("language")).expect("patch");
        assert_eq!(patch.language, Some(Language::ZhTw));
        assert!(theme_patch_json(3).is_err());
        assert!(language_patch_json(9).is_err());
    }

    #[test]
    fn numeric_field_indexes_map_to_search_fields() {
        assert_eq!(NumericField::from_index(0), Some(NumericField::MaxResults));
        assert_eq!(NumericField::from_index(4), Some(NumericField::FileBoost));
        assert_eq!(NumericField::from_index(5), None);
    }

    #[test]
    fn numeric_field_patch_json_builds_valid_patches() {
        let patch = parse_settings_patch_json(
            &numeric_field_patch_json(NumericField::MaxResults, " 42 ").expect("max"),
        )
        .expect("patch");
        let search = patch.search.expect("search");
        assert_eq!(search.max_results, Some(42));

        let patch = parse_settings_patch_json(
            &numeric_field_patch_json(NumericField::HistoryBoost, "2.5").expect("boost"),
        )
        .expect("patch");
        assert_eq!(patch.search.expect("search").history_boost, Some(2.5));
        // f64 → serde_json → 再解析的往返不丢精度（有限数原样保留）。
        let patch = parse_settings_patch_json(
            &numeric_field_patch_json(NumericField::FileBoost, "0.125").expect("boost"),
        )
        .expect("patch");
        assert_eq!(patch.search.expect("search").file_boost, Some(0.125));
    }

    #[test]
    fn numeric_field_patch_json_rejects_with_ts_validation_messages() {
        let max_error =
            numeric_field_patch_json(NumericField::MaxResults, "abc").expect_err("parse");
        assert_eq!(max_error, "search.maxResults must be a safe integer >= 0");
        assert_eq!(
            numeric_field_patch_json(NumericField::MaxResults, "3000000000").expect_err("bound"),
            "search.maxResults must be a safe integer >= 0"
        );
        let boost_error =
            numeric_field_patch_json(NumericField::PluginBoost, "1e999").expect_err("finite");
        assert_eq!(boost_error, "search.pluginBoost must be a finite number");
        assert_eq!(
            numeric_field_patch_json(NumericField::AppBoost, "x").expect_err("parse"),
            "search.appBoost must be a finite number"
        );
    }

    #[test]
    fn shortcut_identity_key_normalizes_case_and_slashes() {
        assert_eq!(
            shortcut_identity_key(r"C:\Program Files\X\App.exe"),
            r"c:\program files\x\app.exe"
        );
        assert_eq!(
            shortcut_identity_key("C:/Program Files/X/App.EXE"),
            shortcut_identity_key(r"C:\Program Files\X\App.exe")
        );
        assert_eq!(shortcut_identity_key("  a.lnk  "), "a.lnk");
    }

    #[test]
    fn pinned_app_favorite_input_maps_app_command() {
        let command = app_command_with_payload("app.1", "Visual Studio Code", |payload| {
            payload.insert(
                "shortcutPath".into(),
                r"C:\Users\Ada\Desktop\Code.lnk".into(),
            );
            payload.insert(
                "executablePath".into(),
                r"C:\Program Files\Code\Code.exe".into(),
            );
        });
        let input = pinned_app_favorite_input(&command).expect("favorite input");

        assert_eq!(input.kind, FavoriteKind::File);
        assert_eq!(input.title, "Visual Studio Code");
        assert_eq!(
            input.path.as_deref(),
            Some(r"C:\Users\Ada\Desktop\Code.lnk")
        );
        let metadata = input.metadata.expect("metadata");
        assert_eq!(
            metadata.get(LAUNCHER_PINNED_APP_METADATA_KEY),
            Some(&serde_json::Value::Bool(true))
        );
        assert_eq!(
            metadata
                .get(LAUNCHER_PINNED_APP_EXECUTABLE_PATH_METADATA_KEY)
                .and_then(serde_json::Value::as_str),
            Some(r"C:\Program Files\Code\Code.exe")
        );
    }

    #[test]
    fn pinned_app_favorite_input_falls_back_to_shortcut_and_rejects_missing() {
        // 无 executablePath / icon → 全部回退到 shortcutPath（可启动的 .lnk）。
        let bare = app_command_with_payload("app.2", "Notes", |payload| {
            payload.insert("shortcutPath".into(), r"C:\Start Menu\Notes.lnk".into());
        });
        let input = pinned_app_favorite_input(&bare).expect("favorite input");
        assert_eq!(input.path.as_deref(), Some(r"C:\Start Menu\Notes.lnk"));
        let metadata = input.metadata.expect("metadata");
        assert_eq!(
            metadata
                .get(LAUNCHER_PINNED_APP_EXECUTABLE_PATH_METADATA_KEY)
                .and_then(serde_json::Value::as_str),
            Some(r"C:\Start Menu\Notes.lnk")
        );

        // 缺 shortcutPath（如插件命令）→ 明确报错，不产出畸形收藏。
        let plugin_command = Command {
            source: CommandSource::Plugin,
            ..app_command_with_payload("plugin.1", "Calc", |_| {})
        };
        assert!(pinned_app_favorite_input(&plugin_command).is_err());
    }

    #[test]
    fn command_is_pinned_app_detects_favorite_ids_and_shortcut_keys() {
        let indexed = app_command_with_payload("app.9", "WPS", |payload| {
            payload.insert("shortcutPath".into(), r"C:\Menu\WPS.lnk".into());
        });
        let mut pinned_ids = std::collections::HashSet::new();
        let mut pinned_keys = std::collections::HashSet::new();
        assert!(!command_is_pinned_app(&indexed, &pinned_ids, &pinned_keys));

        pinned_keys.insert(shortcut_identity_key(r"C:\MENU\wps.lnk"));
        assert!(command_is_pinned_app(&indexed, &pinned_ids, &pinned_keys));

        pinned_keys.clear();
        pinned_ids.insert("favorite.123".to_string());
        assert!(!command_is_pinned_app(&indexed, &pinned_ids, &pinned_keys));

        let favorite_command = Command {
            id: "favorite.123".into(),
            ..indexed.clone()
        };
        assert!(command_is_pinned_app(
            &favorite_command,
            &pinned_ids,
            &pinned_keys
        ));
    }
    // ---- M3 Task 8：截图热键位移决策表（移植 screenshotShortcutController.test.ts） ----

    use super::{
        plan_screenshot_hotkey_change, save_file_name, save_file_name_now,
        ScreenshotHotkeyField as Field, ScreenshotHotkeyPlan,
        ScreenshotHotkeyRegistrations as Regs,
    };

    fn field_name(field: Field) -> &'static str {
        match field {
            Field::Screenshot => "screenshot",
            Field::DelayedScreenshot => "delayed",
        }
    }

    /// 决策表断言辅助：注册表 + 目标字段 + 新加速键 → 执行序列快照。
    #[track_caller]
    fn plan_of(
        regs: &Regs,
        field: Field,
        accelerator: &str,
    ) -> (bool, Option<&'static str>, Option<String>, Option<String>) {
        let plan = plan_screenshot_hotkey_change(regs, field, accelerator);
        assert_eq!(
            plan.register_new.as_deref(),
            if plan.noop { None } else { Some(accelerator) }
        );
        (
            plan.noop,
            plan.displace.as_ref().map(|(field, _)| field_name(*field)),
            plan.displace.as_ref().map(|(_, a)| a.clone()),
            plan.release_old,
        )
    }

    #[test]
    fn displacement_noops_when_same_accelerator_already_registered() {
        // TS "keeps the existing registration when re-registering the same accelerator"：
        // 第二次 tryRegister 不应再触发 register（决策 = noop）。
        let mut regs = Regs::default();
        let plan = plan_screenshot_hotkey_change(&regs, Field::Screenshot, "Ctrl+Alt+A");
        assert!(!plan.noop);
        regs.set(Field::Screenshot, Some("Ctrl+Alt+A".into()));
        let plan = plan_screenshot_hotkey_change(&regs, Field::Screenshot, "Ctrl+Alt+A");
        assert!(plan.noop);
        assert_eq!(plan.displace, None);
        assert_eq!(plan.register_new, None);
        assert_eq!(plan.release_old, None);
    }

    #[test]
    fn displacement_changes_field_without_touching_the_other() {
        // TS "re-registers the delayed screenshot hotkey without replacing capture
        // hotkey registration"：目标字段旧值进 release_old，另一字段不受影响。
        let regs = Regs {
            screenshot: Some("Ctrl+Alt+A".into()),
            delayed_screenshot: Some("Ctrl+Alt+D".into()),
        };
        let (noop, displace_field, displace_accelerator, release_old) =
            plan_of(&regs, Field::DelayedScreenshot, "Ctrl+Alt+E");
        assert!(!noop);
        assert_eq!(displace_field, None);
        assert_eq!(displace_accelerator, None);
        assert_eq!(release_old.as_deref(), Some("Ctrl+Alt+D"));
    }

    #[test]
    fn displacement_of_conflicting_other_field_is_planned() {
        // 新加速键被另一字段占用 → displace + restore_on_failure 同值；
        // 成功后还需释放目标字段旧值。
        let regs = Regs {
            screenshot: Some("Ctrl+Alt+A".into()),
            delayed_screenshot: Some("Ctrl+Alt+D".into()),
        };
        let plan = plan_screenshot_hotkey_change(&regs, Field::Screenshot, "Ctrl+Alt+D");
        assert!(!plan.noop);
        assert_eq!(
            plan.displace,
            Some((Field::DelayedScreenshot, "Ctrl+Alt+D".to_string()))
        );
        assert_eq!(
            plan.restore_on_failure,
            Some((Field::DelayedScreenshot, "Ctrl+Alt+D".to_string()))
        );
        assert_eq!(plan.release_old.as_deref(), Some("Ctrl+Alt+A"));
    }

    #[test]
    fn displacement_allows_full_swap_sequence() {
        // TS "allows screenshot and delayed screenshot hotkeys to swap accelerators"：
        // 两步互换，每一步都位移另一字段（注册表随执行器同步）。
        let mut regs = Regs {
            screenshot: Some("Ctrl+Alt+A".into()),
            delayed_screenshot: Some("Ctrl+Alt+D".into()),
        };
        // 步骤 1：screenshot → Ctrl+Alt+D（位移 delayed）。
        let plan = plan_screenshot_hotkey_change(&regs, Field::Screenshot, "Ctrl+Alt+D");
        assert_eq!(
            plan.displace.as_ref().map(|(field, _)| *field),
            Some(Field::DelayedScreenshot)
        );
        regs.set(Field::DelayedScreenshot, None);
        regs.set(Field::Screenshot, Some("Ctrl+Alt+D".into()));
        // 步骤 2：delayed → Ctrl+Alt+A。Ctrl+Alt+A 已在步骤 1 的位移中被释放，
        // 无第二次数位移（TS swap 测试的注册表轨迹一致）；目标字段旧值为空，
        // 无释放。
        let plan = plan_screenshot_hotkey_change(&regs, Field::DelayedScreenshot, "Ctrl+Alt+A");
        assert_eq!(plan.displace, None);
        assert_eq!(plan.release_old, None);
        regs.set(Field::DelayedScreenshot, Some("Ctrl+Alt+A".into()));
        assert_eq!(
            regs,
            Regs {
                screenshot: Some("Ctrl+Alt+D".into()),
                delayed_screenshot: Some("Ctrl+Alt+A".into())
            }
        );
    }

    #[test]
    fn displacement_failure_keeps_target_field_registration() {
        // TS "does not dispose the existing hotkey when the replacement conflicts"：
        // 无位移 + 新注册失败 → restore_on_failure 为 None（执行器不会先注销旧值，
        // 目标字段注册原样保留）。
        let regs = Regs {
            screenshot: Some("Ctrl+Alt+A".into()),
            delayed_screenshot: None,
        };
        let plan = plan_screenshot_hotkey_change(&regs, Field::Screenshot, "Ctrl+Shift+S");
        assert!(!plan.noop);
        assert_eq!(plan.displace, None);
        assert_eq!(plan.restore_on_failure, None);
        assert_eq!(plan.release_old.as_deref(), Some("Ctrl+Alt+A"));
    }

    #[test]
    fn unregistered_fields_never_release_or_displace() {
        // 启动期两字段均未注册：纯注册，无位移/释放（TS start() 首注册路径）。
        let regs = Regs::default();
        let (noop, displace_field, displace_accelerator, release_old) =
            plan_of(&regs, Field::Screenshot, "Ctrl+Alt+A");
        assert!(!noop);
        assert_eq!(displace_field, None);
        assert_eq!(displace_accelerator, None);
        assert_eq!(release_old, None);
        let (noop, displace_field, displace_accelerator, release_old) =
            plan_of(&regs, Field::DelayedScreenshot, "Ctrl+Alt+D");
        assert!(!noop);
        assert_eq!(displace_field, None);
        assert_eq!(displace_accelerator, None);
        assert_eq!(release_old, None);
    }

    #[test]
    fn field_mode_mapping_matches_ts_mode_by_field() {
        // TS modeByField：screenshotHotkey → capture、delayed → capture-delay-3。
        assert_eq!(Field::Screenshot.mode_name(), "capture");
        assert_eq!(Field::DelayedScreenshot.mode_name(), "capture-delay-3");
        // 位移对象互逆。
        assert_eq!(Field::Screenshot.other(), Field::DelayedScreenshot);
        assert_eq!(Field::DelayedScreenshot.other(), Field::Screenshot);
    }

    #[test]
    fn screenshot_modes_map_to_non_fallback_handler_fields() {
        // Finding 1 回归：mode_name() 的全部输出必须经 screenshot_mode_to_field
        // 映射到 hotkey_handler_for 的非回退分支字段名（此前模式名直传导致两个
        // 截图热键注册 no-op 处理器，Ctrl+Alt+A/D 完全失效）。
        assert_eq!(
            screenshot_mode_to_field(Field::Screenshot.mode_name()),
            Some(HOTKEY_FIELD_SCREENSHOT)
        );
        assert_eq!(
            screenshot_mode_to_field(Field::DelayedScreenshot.mode_name()),
            Some(HOTKEY_FIELD_DELAYED_SCREENSHOT)
        );
        // 字段名本身不经该函数映射（消费者是字段名分发的另一入口）。
        assert_eq!(screenshot_mode_to_field(HOTKEY_FIELD_LAUNCHER), None);
        assert_eq!(screenshot_mode_to_field(""), None);
    }

    // ---- M3 Task 8：保存文件名 / 扩展名格式判定 ----

    #[test]
    fn derive_save_format_matches_ts() {
        // TS deriveSaveFormatFromPath：png / jpg|jpeg / 其余回退 fallback。
        assert_eq!(super::derive_save_format_from_path("a/b.png", "png"), "png");
        // TS 对扩展名 toLowerCase：.JPG → jpg。
        assert_eq!(super::derive_save_format_from_path("a/b.JPG", "png"), "jpg");
        assert_eq!(super::derive_save_format_from_path("a/b.jpg", "png"), "jpg");
        assert_eq!(
            super::derive_save_format_from_path("a/b.jpeg", "png"),
            "jpg"
        );
        assert_eq!(super::derive_save_format_from_path("noext", "png"), "png");
        assert_eq!(super::derive_save_format_from_path("noext", "jpg"), "jpg");
        assert_eq!(
            super::derive_save_format_from_path("a/b.webp", "png"),
            "png"
        );
        assert_eq!(
            super::derive_save_format_from_path("a/b.webp", "jpg"),
            "jpg"
        );
    }

    #[test]
    fn save_file_name_uses_fsp_shape() {
        // FSP：CommandCabin-YYYYMMDD-HHMMSS.png。
        assert_eq!(
            save_file_name(2026, 9, 4, 7, 8, 9),
            "CommandCabin-20260904-070809.png"
        );
        // now() 只断言形状（时间源不可注入）。
        let name = save_file_name_now();
        assert!(name.starts_with("CommandCabin-") && name.ends_with(".png"));
        let stamp = name
            .trim_start_matches("CommandCabin-")
            .trim_end_matches(".png");
        assert_eq!(stamp.len(), 15);
        assert_eq!(stamp.as_bytes()[8], b'-');
        assert!(stamp
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-'));
    }

    // ---- M3 Task 8：OCR/翻译语言映射（TS ScreenshotOverlay + screenshotTranslation） ----

    use super::{
        ocr_language_for_ui, screenshot_mode_to_field, translation_ocr_candidates,
        translation_source_language, translation_target_language, ui_language_tag,
    };

    #[test]
    fn ocr_language_flips_ui_language() {
        // TS getScreenshotOcrLanguageForUi：en-US → zh-CN，zh 系 → en-US。
        assert_eq!(ocr_language_for_ui(super::Language::EnUs), "zh-CN");
        assert_eq!(ocr_language_for_ui(super::Language::ZhCn), "en-US");
        assert_eq!(ocr_language_for_ui(super::Language::ZhTw), "en-US");
    }

    #[test]
    fn plain_ocr_uses_ui_language_verbatim() {
        // 评审 Finding 2：plain OCR 请求语言 = UI 语言原样（TS runOcr 直接传
        // `language`），与翻译路径的反向翻转（ocr_language_for_ui）互为对照。
        assert_eq!(ui_language_tag(super::Language::EnUs), "en-US");
        assert_eq!(ui_language_tag(super::Language::ZhCn), "zh-CN");
        assert_eq!(ui_language_tag(super::Language::ZhTw), "zh-TW");
        assert_ne!(
            ui_language_tag(super::Language::EnUs),
            ocr_language_for_ui(super::Language::EnUs)
        );
    }

    #[test]
    fn translation_target_is_ui_language() {
        assert_eq!(translation_target_language(super::Language::EnUs), "en-US");
        assert_eq!(translation_target_language(super::Language::ZhCn), "zh-CN");
        assert_eq!(translation_target_language(super::Language::ZhTw), "zh-TW");
    }

    #[test]
    fn translation_ocr_candidates_match_ts() {
        // TS getScreenshotTranslationOcrLanguageCandidates：主语言、目标语言、
        // zh 兄弟语言去重补齐。
        assert_eq!(
            translation_ocr_candidates("en-US", "zh-CN"),
            vec!["en-US", "zh-CN", "zh-TW"]
        );
        assert_eq!(
            translation_ocr_candidates("en-US", "zh-TW"),
            vec!["en-US", "zh-TW", "zh-CN"]
        );
        assert_eq!(
            translation_ocr_candidates("zh-CN", "en-US"),
            vec!["zh-CN", "en-US"]
        );
    }

    #[test]
    fn translation_source_prefers_request_language() {
        // TS getScreenshotTranslationSourceLanguage：不同 → ocrLanguage；相同 → 实际。
        assert_eq!(
            translation_source_language("en-US", "zh-CN", "zh-CN"),
            "en-US"
        );
        assert_eq!(
            translation_source_language("zh-CN", "zh-CN", "zh-TW"),
            "zh-TW"
        );
    }

    // ---- M3 Task 8：计划结构回归（ScreenshotHotkeyPlan 字段守卫）。 ----

    #[test]
    fn plan_carries_restore_only_with_displacement() {
        let regs = Regs {
            screenshot: None,
            delayed_screenshot: Some("Ctrl+Alt+D".into()),
        };
        let plan = plan_screenshot_hotkey_change(&regs, Field::Screenshot, "Ctrl+Alt+D");
        assert_eq!(
            plan,
            ScreenshotHotkeyPlan {
                noop: false,
                displace: Some((Field::DelayedScreenshot, "Ctrl+Alt+D".into())),
                register_new: Some("Ctrl+Alt+D".into()),
                restore_on_failure: Some((Field::DelayedScreenshot, "Ctrl+Alt+D".into())),
                release_old: None,
            }
        );
    }
}
