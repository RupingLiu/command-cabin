//! USD→CNY 汇率缓存。移植自
//! `apps/desktop/src/main/launcher/exchangeRateCache.ts`（247 行，M4 Task 6，
//! 以工作区当前版本为准）。
//!
//! 端点与形状逐字 TS：
//! - [`FRANKFURTER_USD_CNY_ENDPOINT`] = `https://api.frankfurter.dev/v2/rate/USD/CNY`
//!   （免费无 key；响应 `{ base, quote, date, rate }`，亦兼容 v1 的
//!   `{ base, date, rates: { CNY } }` 嵌套形状，与 TS `parseFrankfurterRate` 一致）。
//! - 缓存文件 = userData/exchange-rates.json，单对象
//!   `{ fetchedAt, provider, rate, updatedAt }`，pretty JSON（2 空格缩进）+
//!   结尾换行，字段序即 TS `JSON.stringify` 的键插入序。
//! - TTL 默认 1 小时（`DEFAULT_TTL_MS = 60 * 60 * 1000`）；HTTP 超时默认
//!   1200ms（`DEFAULT_TIMEOUT_MS`，常量随本模块导出，供平台层使用）。
//!
//! 查询决策树逐字 TS `getUsdToCnyRate`：
//! 缓存新鲜 → `('cache')`；缓存过期 → 立即返回旧缓存（`'cache'`）并触发刷新，
//! 新值自下次查询可见；无缓存 → 同步刷新 → 成功 `('live')`、失败 `undefined`
//! （货币转换不可用）。
//!
//! 与 TS 版的有意差异（同步移植）：
//! - TS 过期路径 `void refreshRate()` 为后台火忘刷新；Rust 无异步运行时，
//!   改为**内联**刷新后再返回旧值——单次调用的返回值与 TS 完全一致
//!   （旧值 + `'cache'`），差异仅是该次调用阻塞至多一个 HTTP 超时。TS 的
//!   `refreshInFlight` 并发去重在同步单调用下不存在；刷新失败时下次查询
//!   重试，与 TS 行为一致。
//! - TS `writeFile` 非原子；按任务要求改用 icons disk_cache 的原子写
//!   （临时文件 + rename，失败清理临时文件）。
//! - TS 对非 ENOENT 的读取失败 `logger.warn`；Rust 无 logger，静默按无缓存。
//! - TS 刷新路径的 `try/catch`：写文件失败 → 整次刷新折叠为 `undefined`
//!   （fetch 已成功也丢弃）；Rust `store(...).ok()?` 同语义。
//! - 新鲜度判定 TS 用宽松的 `Date.parse`；Rust 仅接受我们写出的 ISO-8601
//!   子集（`YYYY-MM-DD[THH:MM:SS[.fff]][Z|±HH:MM|±HHMM|±HH]`），其余按
//!   不可解析 → 视为过期（保守降级，与 NaN 分支一致）。
//!
//! IO 分界：HTTP 由平台层（cabin-platform-windows）执行，以
//! `FnOnce() -> Option<String>`（响应体；非 2xx/超时/网络失败 → `None`）注入
//! ——与 `screenshot::translate` 的 fetch 注入同构；响应解析（严格校验）留在
//! 本模块（[`parse_frankfurter_response`]）。

use std::fs::File;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::quick_converter::{ExchangeRateResult, ExchangeRateResultSource};

/// TS `FRANKFURTER_USD_CNY_ENDPOINT`（exchangeRateCache.ts:4）。
pub const FRANKFURTER_USD_CNY_ENDPOINT: &str = "https://api.frankfurter.dev/v2/rate/USD/CNY";
/// TS `DEFAULT_TIMEOUT_MS`（exchangeRateCache.ts:5）。
pub const DEFAULT_EXCHANGE_RATE_TIMEOUT_MS: u64 = 1_200;
/// TS `DEFAULT_TTL_MS` = `60 * 60 * 1000`（exchangeRateCache.ts:6）。
pub const DEFAULT_EXCHANGE_RATE_TTL_MS: u64 = 60 * 60 * 1_000;

/// TS `CachedUsdToCnyExchangeRate`（缓存文件形状，字段序即 TS 键插入序）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CachedUsdToCnyExchangeRate {
    #[serde(rename = "fetchedAt")]
    pub fetched_at: String,
    pub provider: String,
    pub rate: f64,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

impl CachedUsdToCnyExchangeRate {
    /// TS `toResult`：附上来源即查询结果（`ExchangeRateResult`）。
    fn into_result(self, source: ExchangeRateResultSource) -> ExchangeRateResult {
        ExchangeRateResult {
            fetched_at: self.fetched_at,
            provider: self.provider,
            rate: self.rate,
            source,
            updated_at: self.updated_at,
        }
    }
}

/// TS `parseCachedRate`：对象 + `rate` 正有限 + 三个字符串字段 trim 后非空。
pub fn parse_cached_rate(value: &serde_json::Value) -> Option<CachedUsdToCnyExchangeRate> {
    let object = value.as_object()?;
    let rate = object.get("rate").and_then(as_positive_finite)?;
    Some(CachedUsdToCnyExchangeRate {
        rate,
        fetched_at: read_string_field(object, "fetchedAt")?,
        provider: read_string_field(object, "provider")?,
        updated_at: read_string_field(object, "updatedAt")?,
    })
}

/// TS `parseFrankfurterRate`：`base` 必须 USD（trim + 大写归一后），`updatedAt`
/// 取 `date` 字段，`rate` 优先取顶层 `rate`（`quote` 为 CNY 且正有限时），否则
/// 回退 `rates.CNY`（正有限）；`fetchedAt` 取当前时刻（TS `new Date().toISOString()`）。
pub fn parse_frankfurter_rate(
    value: &serde_json::Value,
    now_unix_millis: u64,
) -> Option<CachedUsdToCnyExchangeRate> {
    let object = value.as_object()?;

    let base = read_string_field(object, "base").map(|base| base.to_uppercase());
    let quote = read_string_field(object, "quote").map(|quote| quote.to_uppercase());
    let top_level_rate = object.get("rate").and_then(as_positive_finite);
    let rate = match quote.as_deref() {
        // TS：quote === 'CNY' && isPositiveFiniteNumber(value.rate) ? value.rate
        //     : readNestedCnyRate(value)。
        Some("CNY") if top_level_rate.is_some() => top_level_rate,
        _ => read_nested_cny_rate(object),
    };

    if base.as_deref() != Some("USD") {
        return None;
    }
    let updated_at = read_string_field(object, "date")?;
    let rate = rate?;

    Some(CachedUsdToCnyExchangeRate {
        fetched_at: iso8601_utc(now_unix_millis),
        provider: "Frankfurter".to_string(),
        rate,
        updated_at,
    })
}

/// HTTP 响应体 → 汇率（严格校验）：JSON 解析失败 / 形状不符 → `None`（TS
/// `response.json()` 抛错或 `parseFrankfurterRate` 返回 undefined 的折叠）。
pub fn parse_frankfurter_response(
    body: &str,
    now_unix_millis: u64,
) -> Option<CachedUsdToCnyExchangeRate> {
    let value = serde_json::from_str::<serde_json::Value>(body).ok()?;
    parse_frankfurter_rate(&value, now_unix_millis)
}

/// TS `readNestedCnyRate`：`rates` 为对象且 `rates.CNY` 正有限。
fn read_nested_cny_rate(object: &serde_json::Map<String, serde_json::Value>) -> Option<f64> {
    object
        .get("rates")?
        .as_object()?
        .get("CNY")
        .and_then(as_positive_finite)
}

/// TS `readStringField`：字符串且 trim 后非空 → trim 后的值。
fn read_string_field(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<String> {
    let value = object.get(key)?.as_str()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

/// TS `isPositiveFiniteNumber`。
fn as_positive_finite(value: &serde_json::Value) -> Option<f64> {
    let rate = value.as_f64()?;
    if rate.is_finite() && rate > 0.0 {
        Some(rate)
    } else {
        None
    }
}

/// TS `isFresh`：`Date.parse(fetchedAt)` 有效且 `now - fetchedAt < ttl`
///（未来时刻为负 → 新鲜，与 TS 一致）；解析失败 → 过期。
fn is_fresh(rate: &CachedUsdToCnyExchangeRate, ttl_ms: u64, now_unix_millis: u64) -> bool {
    match parse_iso8601_to_unix_millis(&rate.fetched_at) {
        Some(fetched_at) => now_unix_millis as i64 - fetched_at < ttl_ms as i64,
        None => false,
    }
}

/// 查询管线（M4 Task 7）的非阻塞读结果：TS `getUsdToCnyRate` 决策树的三路
/// 输出，刷新动作从读取中拆出（启动器把 HTTP 取数放到工作线程，完成后经
/// [`ExchangeRateCache::ingest_fetched_body`] 回灌），使查询路径永不阻塞网络 IO。
#[derive(Debug, Clone, PartialEq)]
pub enum ExchangeRatePeek {
    /// 新鲜缓存：直接可用，无需刷新（TS 返回 `('cache')`）。
    Fresh(ExchangeRateResult),
    /// 过期缓存：本次立即采用旧值（TS 立即返回旧缓存），需要后台刷新
    /// （TS `void refreshRate()`）；新值自下次查询可见。
    Stale(ExchangeRateResult),
    /// 无缓存：本次查询无汇率可用（TS 的同步刷新路径被异步化——先返回
    /// "无命令"，取数完成后由调用方重跑查询补上货币命令）。
    Missing,
}

/// 汇率缓存。文件路径由调用方注入（cabin-app 层传入
/// `userData/exchange-rates.json`）；首次查询时惰性读盘（对齐 TS 的
/// `cachedRatePromise` 记忆化），刷新成功后更新内存并原子落盘。
pub struct ExchangeRateCache {
    path: PathBuf,
    ttl_ms: u64,
    clock: Box<dyn Fn() -> u64 + Send>,
    cached: Option<CachedUsdToCnyExchangeRate>,
}

static TEMPORARY_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

impl ExchangeRateCache {
    /// 从磁盘载入缓存（惰性；文件缺失 / 损坏 / 字段非法 → 无缓存，不报错）。
    pub fn load(path: &Path) -> Self {
        Self::load_with_clock(path, system_unix_millis)
    }

    /// [`ExchangeRateCache::load`] 的可注入时钟版本（unix 毫秒），供测试与
    /// 需要自定义时间源的场景使用。
    pub fn load_with_clock<F>(path: &Path, clock: F) -> Self
    where
        F: Fn() -> u64 + Send + 'static,
    {
        Self {
            path: path.to_path_buf(),
            ttl_ms: DEFAULT_EXCHANGE_RATE_TTL_MS,
            clock: Box::new(clock),
            cached: None,
        }
    }

    /// 覆盖默认 TTL（对齐 TS `ttlMs` 选项）。
    pub fn with_ttl_ms(mut self, ttl_ms: u64) -> Self {
        self.ttl_ms = ttl_ms;
        self
    }

    /// [`ExchangeRateCache::get_usd_to_cny_rate`] 的非阻塞读半步（M4 Task 7
    /// 查询管线）：只读缓存、不触发网络。三路决策与 TS `getUsdToCnyRate` 逐条
    /// 对齐（新鲜/过期/缺失）；需要刷新的两个分支（`Stale`/`Missing`）由调用方
    /// 在后台完成取数后经 [`ExchangeRateCache::ingest_fetched_body`] 回灌。
    pub fn peek_usd_to_cny_rate(&mut self) -> ExchangeRatePeek {
        if self.cached.is_none() {
            self.cached = read_cache_file(&self.path);
        }

        match self.cached.clone() {
            Some(cached) if is_fresh(&cached, self.ttl_ms, (self.clock)()) => {
                ExchangeRatePeek::Fresh(cached.into_result(ExchangeRateResultSource::Cache))
            }
            Some(cached) => {
                ExchangeRatePeek::Stale(cached.into_result(ExchangeRateResultSource::Cache))
            }
            None => ExchangeRatePeek::Missing,
        }
    }

    /// 后台取数的回灌半步（TS `refreshRate` 在 fetch 完成后的部分：解析 →
    /// 落盘 → 更新内存）。`body = None`（传输失败/超时）与解析失败 → `None`
    /// （缓存不变，下次需要刷新的查询重试，与 TS 一致）；写盘失败同样折叠
    /// （TS catch 语义：fetch 成功也丢弃）。
    pub fn ingest_fetched_body(
        &mut self,
        body: Option<String>,
    ) -> Option<CachedUsdToCnyExchangeRate> {
        self.refresh(|| body)
    }

    /// TS `getUsdToCnyRate`。`fetch_body` 为注入的 HTTP 取数闭包：返回响应体
    /// 文本；非 2xx / 超时 / 网络失败 → `None`（TS `!response.ok` / 抛错的折叠）。
    /// 返回 `None` 表示 live 与缓存均不可用（货币转换不可用）。
    pub fn get_usd_to_cny_rate(
        &mut self,
        fetch_body: impl FnOnce() -> Option<String>,
    ) -> Option<ExchangeRateResult> {
        if self.cached.is_none() {
            self.cached = read_cache_file(&self.path);
        }

        if let Some(cached) = self.cached.clone() {
            if is_fresh(&cached, self.ttl_ms, (self.clock)()) {
                return Some(cached.into_result(ExchangeRateResultSource::Cache));
            }

            // TS：`void refreshRate()` 后台刷新、立即返回旧缓存。同步移植为
            // 内联刷新 + 返回旧值（见模块注释；刷新失败静默，仍返回旧缓存）。
            self.refresh(fetch_body);
            return Some(cached.into_result(ExchangeRateResultSource::Cache));
        }

        let live = self.refresh(fetch_body)?;
        Some(live.into_result(ExchangeRateResultSource::Live))
    }

    /// TS `refreshRate`：fetch → 严格解析 → 落盘 → 更新内存。任一步失败 →
    /// `None`（解析失败 / 传输失败；写盘失败对齐 TS catch 折叠，即使 fetch
    /// 已成功也丢弃）。
    fn refresh(
        &mut self,
        fetch_body: impl FnOnce() -> Option<String>,
    ) -> Option<CachedUsdToCnyExchangeRate> {
        let body = fetch_body()?;
        let live = parse_frankfurter_response(&body, (self.clock)())?;
        self.store(&live).ok()?;
        self.cached = Some(live.clone());
        Some(live)
    }

    /// 原子落盘：pretty JSON + 结尾换行，临时文件 + rename
    /// （复用 icons disk_cache 模式；失败时清理临时文件）。
    pub fn store(&mut self, rate: &CachedUsdToCnyExchangeRate) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(rate).expect("cached rate serialization cannot fail")
        );
        let temporary_path = self.temporary_file_path();
        let result = write_atomic(&temporary_path, &self.path, &text);
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary_path);
        }
        result
    }

    fn temporary_file_path(&self) -> PathBuf {
        let mut name = self.path.as_os_str().to_os_string();
        name.push(format!(
            ".{}.{}.tmp",
            std::process::id(),
            TEMPORARY_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        PathBuf::from(name)
    }
}

/// TS `readCacheFile`：文件缺失 / JSON 损坏 / 字段非法 → `None`（TS 对
/// 非 ENOENT 会 `logger.warn`，Rust 静默）。
fn read_cache_file(path: &Path) -> Option<CachedUsdToCnyExchangeRate> {
    let text = std::fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    parse_cached_rate(&value)
}

fn write_atomic(temporary_path: &Path, target_path: &Path, text: &str) -> std::io::Result<()> {
    let mut file = File::create(temporary_path)?;
    file.write_all(text.as_bytes())?;
    drop(file);
    std::fs::rename(temporary_path, target_path)
}

fn system_unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

/// unix 毫秒 → `YYYY-MM-DDTHH:MM:SS.mmmZ`（对齐 TS `Date.toISOString()`；
/// icons disk_cache 同款私有副本，跨模块不互引）。
fn iso8601_utc(millis: u64) -> String {
    let seconds = millis / 1000;
    let second_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days((seconds / 86_400) as i64);
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milliseconds:03}Z",
        hour = second_of_day / 3_600,
        minute = (second_of_day % 3_600) / 60,
        second = second_of_day % 60,
        milliseconds = millis % 1000,
    )
}

/// 天数（自 unix 纪元）→ (年, 月, 日)。Howard Hinnant `civil_from_days` 算法
/// （icons disk_cache 同款私有副本）。
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (
        if month <= 2 { year + 1 } else { year },
        month as u32,
        day as u32,
    )
}

/// (年, 月, 日) → 天数（自 unix 纪元）。Howard Hinnant `days_from_civil`
/// 算法（`civil_from_days` 的逆变换，供 ISO 解析使用）。
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let year_of_era = y - era * 400;
    let month_period = (i64::from(month) + 9) % 12;
    let day_of_year = (153 * month_period + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// ISO-8601 子集 → unix 毫秒（支持 `YYYY-MM-DD`、`YYYY-MM-DDTHH:MM:SS`、
/// 可选 `.fff…` 小数（多余位截断）与 `Z`/`±HH:MM`/`±HHMM`/`±HH` 时区）；
/// 其余（无时区的本地时间形态、非法字段等）→ `None`（见模块注释）。
fn parse_iso8601_to_unix_millis(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    let digit = |byte: u8| byte.is_ascii_digit();
    let date_digits = bytes[..4].iter().all(|&b| digit(b))
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(|&b| digit(b))
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(|&b| digit(b));
    if !date_digits {
        return None;
    }
    let year: i64 = text[0..4].parse().ok()?;
    let month: u32 = text[5..7].parse().ok()?;
    let day: u32 = text[8..10].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let mut total_millis = days_from_civil(year, month, day) * 86_400_000;

    // 仅日期形态（TS Date.parse('YYYY-MM-DD') = UTC 午夜）。
    if bytes.len() == 10 {
        return Some(total_millis);
    }

    if bytes[10] != b'T' && bytes[10] != b't' {
        return None;
    }
    if bytes.len() < 19 {
        return None;
    }
    let time_digits = bytes[11..13].iter().all(|&b| digit(b))
        && bytes[13] == b':'
        && bytes[14..16].iter().all(|&b| digit(b))
        && bytes[16] == b':'
        && bytes[17..19].iter().all(|&b| digit(b));
    if !time_digits {
        return None;
    }
    let hour: i64 = text[11..13].parse().ok()?;
    let minute: i64 = text[14..16].parse().ok()?;
    let second: i64 = text[17..19].parse().ok()?;
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    total_millis += hour * 3_600_000 + minute * 60_000 + second * 1_000;

    let mut index = 19;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fraction_start = index;
        while index < bytes.len() && digit(bytes[index]) {
            index += 1;
        }
        if index == fraction_start {
            return None;
        }
        // Date.parse 语义：小数超过 3 位截断，不足 3 位右补零。
        let take = (index - fraction_start).min(3);
        let mut millis_text = text[fraction_start..fraction_start + take].to_string();
        while millis_text.len() < 3 {
            millis_text.push('0');
        }
        total_millis += millis_text.parse::<i64>().ok()?;
    }

    // 时区必填（本地时间形态不支持 → None → 视为过期）。
    let suffix = &text[index..];
    let offset_minutes: i64 = match suffix {
        "Z" | "z" => 0,
        _ if suffix.len() >= 3 && (suffix.starts_with('+') || suffix.starts_with('-')) => {
            let sign = if suffix.starts_with('-') { -1 } else { 1 };
            let body = &suffix[1..];
            let (hour_text, minute_text) = match body.len() {
                5 if body.as_bytes()[2] == b':' => (&body[0..2], Some(&body[3..5])),
                4 => (&body[0..2], Some(&body[2..4])),
                2 => (&body[0..2], None),
                _ => return None,
            };
            let hour: i64 = hour_text.parse().ok()?;
            let minute: i64 = match minute_text {
                Some(minute_text) => minute_text.parse().ok()?,
                None => 0,
            };
            if hour > 23 || minute > 59 {
                return None;
            }
            sign * (hour * 60 + minute)
        }
        _ => return None,
    };
    total_millis -= offset_minutes * 60_000;

    Some(total_millis)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;

    use super::*;

    /// 目录守卫：断言失败 panic 时也清理临时目录；追加 pid 避免并行冲突。
    struct TempDir(PathBuf);

    impl TempDir {
        fn create(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    fn temp_cache_path(dir: &TempDir) -> PathBuf {
        dir.0.join("exchange-rates.json")
    }

    fn cached(fetched_at: &str, rate: f64, updated_at: &str) -> CachedUsdToCnyExchangeRate {
        CachedUsdToCnyExchangeRate {
            fetched_at: fetched_at.to_string(),
            provider: "Frankfurter".to_string(),
            rate,
            updated_at: updated_at.to_string(),
        }
    }

    fn write_cache_file(path: &Path, fetched_at: &str, rate: f64, updated_at: &str) {
        std::fs::write(
            path,
            serde_json::to_string_pretty(&cached(fetched_at, rate, updated_at)).unwrap(),
        )
        .unwrap();
    }

    fn frankfurter_body(rate: f64, date: &str) -> String {
        serde_json::json!({ "base": "USD", "date": date, "quote": "CNY", "rate": rate }).to_string()
    }

    /// 计数 fetch：记录调用次数并返回预设响应体。
    struct CountingFetch {
        calls: Arc<AtomicU64>,
        body: Option<String>,
    }

    impl CountingFetch {
        fn live(body: String) -> (Self, Arc<AtomicU64>) {
            let calls = Arc::new(AtomicU64::new(0));
            (
                Self {
                    calls: calls.clone(),
                    body: Some(body),
                },
                calls,
            )
        }

        fn failing() -> (Self, Arc<AtomicU64>) {
            let calls = Arc::new(AtomicU64::new(0));
            (
                Self {
                    calls: calls.clone(),
                    body: None,
                },
                calls,
            )
        }

        fn closure(&self) -> impl FnOnce() -> Option<String> {
            let calls = self.calls.clone();
            let body = self.body.clone();
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                body
            }
        }
    }

    // ---- TS 测试逐项移植（exchangeRateCache.test.ts） ----

    #[test]
    fn fetches_the_live_rate_and_writes_it_to_cache() {
        let dir = TempDir::create("cabin-core-rate-live");
        let path = temp_cache_path(&dir);
        let (fetch, calls) = CountingFetch::live(frankfurter_body(7.1234, "2026-05-18"));
        let mut cache = ExchangeRateCache::load_with_clock(&path, || 0);

        let rate = cache
            .get_usd_to_cny_rate(fetch.closure())
            .expect("live rate should resolve");
        assert_eq!(rate.provider, "Frankfurter");
        assert_eq!(rate.rate, 7.1234);
        assert_eq!(rate.source, ExchangeRateResultSource::Live);
        assert_eq!(rate.updated_at, "2026-05-18");
        // fetchedAt = 注入时钟（0ms）的 ISO 形式。
        assert_eq!(rate.fetched_at, "1970-01-01T00:00:00.000Z");
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"rate\": 7.1234"));
        assert!(text.contains("\"updatedAt\": \"2026-05-18\""));
    }

    #[test]
    fn returns_the_cached_rate_when_the_live_request_fails() {
        let dir = TempDir::create("cabin-core-rate-cached-fallback");
        let path = temp_cache_path(&dir);
        write_cache_file(&path, "2026-05-17T12:00:00.000Z", 7.1, "2026-05-17");
        // 时钟远在 fetchedAt 之后 → 过期 → 刷新失败 → 仍返回旧缓存。
        let (fetch, calls) = CountingFetch::failing();
        let mut cache = ExchangeRateCache::load_with_clock(&path, || u64::MAX / 2);

        let rate = cache
            .get_usd_to_cny_rate(fetch.closure())
            .expect("cached fallback");
        assert_eq!(
            rate,
            ExchangeRateResult {
                fetched_at: "2026-05-17T12:00:00.000Z".to_string(),
                provider: "Frankfurter".to_string(),
                rate: 7.1,
                source: ExchangeRateResultSource::Cache,
                updated_at: "2026-05-17".to_string(),
            }
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn returns_undefined_when_neither_live_nor_cached_rates_are_available() {
        let dir = TempDir::create("cabin-core-rate-none");
        let path = temp_cache_path(&dir);
        let (fetch, _) = CountingFetch::failing();
        let mut cache = ExchangeRateCache::load_with_clock(&path, || 0);
        assert_eq!(cache.get_usd_to_cny_rate(fetch.closure()), None);
    }

    #[test]
    fn uses_the_cached_rate_when_the_live_request_times_out() {
        // TS 用例：fetch 超时 reject → 折叠 undefined → 返回缓存。
        let dir = TempDir::create("cabin-core-rate-timeout");
        let path = temp_cache_path(&dir);
        write_cache_file(&path, "2026-05-17T12:00:00.000Z", 7.1, "2026-05-17");
        let (fetch, _) = CountingFetch::failing();
        let mut cache = ExchangeRateCache::load_with_clock(&path, || u64::MAX / 2);
        let rate = cache
            .get_usd_to_cny_rate(fetch.closure())
            .expect("cached fallback after timeout");
        assert_eq!(rate.rate, 7.1);
        assert_eq!(rate.source, ExchangeRateResultSource::Cache);
    }

    #[test]
    fn returns_a_fresh_cached_rate_without_fetching() {
        let dir = TempDir::create("cabin-core-rate-fresh");
        let path = temp_cache_path(&dir);
        write_cache_file(&path, "1970-01-01T00:00:00.000Z", 7.1, "2026-05-17");
        // 时钟停在 fetchedAt 附近（< TTL）→ 新鲜 → 不发请求。
        let (fetch, calls) = CountingFetch::live(frankfurter_body(7.5, "2026-05-18"));
        let mut cache = ExchangeRateCache::load_with_clock(&path, || 1_000);

        let rate = cache
            .get_usd_to_cny_rate(fetch.closure())
            .expect("fresh cached rate");
        assert_eq!(rate.rate, 7.1);
        assert_eq!(rate.source, ExchangeRateResultSource::Cache);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn returns_the_stale_cached_rate_while_refreshing() {
        let dir = TempDir::create("cabin-core-rate-stale");
        let path = temp_cache_path(&dir);
        write_cache_file(&path, "2026-05-17T12:00:00.000Z", 7.1, "2026-05-17");
        let (fetch, calls) = CountingFetch::live(frankfurter_body(7.5, "2026-05-18"));
        let mut cache = ExchangeRateCache::load_with_clock(&path, || u64::MAX / 2);

        // 第一次：返回旧缓存（即使刷新已内联完成）。
        let rate = cache
            .get_usd_to_cny_rate(fetch.closure())
            .expect("stale cached rate");
        assert_eq!(rate.rate, 7.1);
        assert_eq!(rate.source, ExchangeRateResultSource::Cache);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // 刷新结果已落盘，且对下次查询可见（新缓存、来源仍为 'cache'）。
        let rate = cache
            .get_usd_to_cny_rate(|| None)
            .expect("refreshed cached rate");
        assert_eq!(rate.rate, 7.5);
        assert_eq!(rate.source, ExchangeRateResultSource::Cache);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn honors_ttl_option_when_deciding_freshness() {
        let dir = TempDir::create("cabin-core-rate-ttl");
        let path = temp_cache_path(&dir);
        // fetchedAt = 1970-01-01T00:00:00.000Z，时钟 30 分钟后。
        let fixed_clock = 30 * 60 * 1_000;
        let (fetch, calls) = CountingFetch::live(frankfurter_body(7.5, "2026-05-18"));

        // 30 分钟 < 1 小时 TTL → 新鲜 → 无网络请求。
        let mut fresh_cache = ExchangeRateCache::load_with_clock(&path, move || fixed_clock)
            .with_ttl_ms(60 * 60 * 1_000);
        write_cache_file(&path, "1970-01-01T00:00:00.000Z", 7.1, "2026-05-17");
        let rate = fresh_cache
            .get_usd_to_cny_rate(fetch.closure())
            .expect("fresh within 1h ttl");
        assert_eq!(rate.rate, 7.1);
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        // 同样的 30 分钟对 10 分钟 TTL 已过期 → 刷新（返回旧值，落盘新值）。
        let mut stale_cache = ExchangeRateCache::load_with_clock(&path, move || fixed_clock)
            .with_ttl_ms(10 * 60 * 1_000);
        let rate = stale_cache
            .get_usd_to_cny_rate(fetch.closure())
            .expect("stale within 10m ttl");
        assert_eq!(rate.rate, 7.1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("\"rate\": 7.5"));
    }

    // ---- 缓存文件读取（损坏 / 非法字段） ----

    #[test]
    fn corrupted_cache_files_are_treated_as_no_cache() {
        let dir = TempDir::create("cabin-core-rate-corrupt");
        let path = temp_cache_path(&dir);
        for corrupt in [
            "{not json",
            "[1,2,3]",
            "\"just a string\"",
            "null",
            "123",
            "{}",
        ] {
            std::fs::write(&path, corrupt).unwrap();
            let (fetch, calls) = CountingFetch::live(frankfurter_body(7.5, "2026-05-18"));
            let mut cache = ExchangeRateCache::load_with_clock(&path, || u64::MAX / 2);
            let rate = cache
                .get_usd_to_cny_rate(fetch.closure())
                .expect("live fallback after corrupt cache");
            assert_eq!(rate.rate, 7.5, "corrupt input: {corrupt}");
            assert_eq!(rate.source, ExchangeRateResultSource::Live);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn cache_files_with_invalid_fields_are_rejected() {
        let dir = TempDir::create("cabin-core-rate-invalid-fields");
        let path = temp_cache_path(&dir);
        let cases = [
            // rate 非正 / 非有限 / 缺失。
            r#"{"fetchedAt":"2026-05-17T12:00:00.000Z","provider":"Frankfurter","rate":0,"updatedAt":"2026-05-17"}"#,
            r#"{"fetchedAt":"2026-05-17T12:00:00.000Z","provider":"Frankfurter","rate":-7.1,"updatedAt":"2026-05-17"}"#,
            r#"{"fetchedAt":"2026-05-17T12:00:00.000Z","provider":"Frankfurter","updatedAt":"2026-05-17"}"#,
            // 字符串字段缺失 / 空白。
            r#"{"provider":"Frankfurter","rate":7.1,"updatedAt":"2026-05-17"}"#,
            r#"{"fetchedAt":"2026-05-17T12:00:00.000Z","rate":7.1,"updatedAt":"2026-05-17"}"#,
            r#"{"fetchedAt":"2026-05-17T12:00:00.000Z","provider":"Frankfurter","rate":7.1}"#,
            r#"{"fetchedAt":"   ","provider":"Frankfurter","rate":7.1,"updatedAt":"2026-05-17"}"#,
            r#"{"fetchedAt":"2026-05-17T12:00:00.000Z","provider":"  ","rate":7.1,"updatedAt":"2026-05-17"}"#,
            // 字段类型错误。
            r#"{"fetchedAt":123,"provider":"Frankfurter","rate":7.1,"updatedAt":"2026-05-17"}"#,
            r#"{"fetchedAt":"2026-05-17T12:00:00.000Z","provider":"Frankfurter","rate":"7.1","updatedAt":"2026-05-17"}"#,
        ];
        for text in cases {
            std::fs::write(&path, text).unwrap();
            assert_eq!(
                read_cache_file(&path),
                None,
                "expected rejection for {text}"
            );
        }
        // 合法样例通过，且字符串字段被 trim。
        std::fs::write(
            &path,
            r#"{"fetchedAt":" 2026-05-17T12:00:00.000Z ","provider":" Frankfurter ","rate":7.1,"updatedAt":" 2026-05-17 "}"#,
        )
        .unwrap();
        assert_eq!(
            read_cache_file(&path),
            Some(cached("2026-05-17T12:00:00.000Z", 7.1, "2026-05-17"))
        );
    }

    #[test]
    fn store_writes_ts_shape_pretty_json_with_trailing_newline() {
        let dir = TempDir::create("cabin-core-rate-shape");
        let path = temp_cache_path(&dir);
        let mut cache = ExchangeRateCache::load_with_clock(&path, || 0);
        cache
            .store(&cached("2026-05-18T00:00:00.000Z", 7.1234, "2026-05-18"))
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"{
  "fetchedAt": "2026-05-18T00:00:00.000Z",
  "provider": "Frankfurter",
  "rate": 7.1234,
  "updatedAt": "2026-05-18"
}
"#
        );
    }

    #[test]
    fn store_is_atomic_and_leaves_no_temporary_files() {
        let dir = TempDir::create("cabin-core-rate-atomic");
        let path = temp_cache_path(&dir);
        let mut cache = ExchangeRateCache::load_with_clock(&path, || 0);
        cache
            .store(&cached("2026-05-18T00:00:00.000Z", 7.1, "2026-05-18"))
            .unwrap();
        cache
            .store(&cached("2026-05-19T00:00:00.000Z", 7.2, "2026-05-19"))
            .unwrap();
        let leftovers: Vec<String> = std::fs::read_dir(&dir.0)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec!["exchange-rates.json".to_string()]);
        // 覆盖写后仍是合法形状。
        assert_eq!(
            read_cache_file(&path),
            Some(cached("2026-05-19T00:00:00.000Z", 7.2, "2026-05-19"))
        );
    }

    #[test]
    fn store_failure_removes_temporary_file() {
        let dir = TempDir::create("cabin-core-rate-fail-tmp");
        // 目标路径被目录占位 → rename 失败，临时文件应被清理。
        let path = temp_cache_path(&dir);
        std::fs::create_dir_all(&path).unwrap();
        let mut cache = ExchangeRateCache::load_with_clock(&path, || 0);
        assert!(cache
            .store(&cached("2026-05-18T00:00:00.000Z", 7.1, "2026-05-18"))
            .is_err());
        let leftovers: Vec<String> = std::fs::read_dir(&dir.0)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec!["exchange-rates.json".to_string()]);
    }

    #[test]
    fn store_creates_missing_parent_directories() {
        let dir = TempDir::create("cabin-core-rate-mkdir");
        let path = dir.0.join("nested").join("exchange-rates.json");
        let mut cache = ExchangeRateCache::load_with_clock(&path, || 0);
        cache
            .store(&cached("2026-05-18T00:00:00.000Z", 7.1, "2026-05-18"))
            .unwrap();
        assert_eq!(
            read_cache_file(&path),
            Some(cached("2026-05-18T00:00:00.000Z", 7.1, "2026-05-18"))
        );
    }

    #[test]
    fn write_failure_discards_the_fetched_live_rate() {
        // TS：refreshRate 的 catch 捕获写盘异常 → 即使 fetch 成功也返回 undefined。
        let dir = TempDir::create("cabin-core-rate-write-fail");
        let path = temp_cache_path(&dir);
        std::fs::create_dir_all(&path).unwrap();
        let (fetch, calls) = CountingFetch::live(frankfurter_body(7.5, "2026-05-18"));
        let mut cache = ExchangeRateCache::load_with_clock(&path, || u64::MAX / 2);
        assert_eq!(cache.get_usd_to_cny_rate(fetch.closure()), None);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    // ---- Frankfurter 响应解析（严格校验） ----

    #[test]
    fn parses_frankfurter_top_level_quote_shape() {
        let value = serde_json::json!({
            "base": "usd", "date": "2026-05-18", "quote": "cny", "rate": 7.1234
        });
        let rate = parse_frankfurter_rate(&value, 0).expect("top-level shape");
        assert_eq!(rate.rate, 7.1234);
        assert_eq!(rate.updated_at, "2026-05-18");
        assert_eq!(rate.provider, "Frankfurter");
        assert_eq!(rate.fetched_at, "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn parses_frankfurter_nested_rates_shape() {
        // v1 形状：无 quote，rates.CNY 兜底。
        let value =
            serde_json::json!({ "base": "USD", "date": "2026-05-18", "rates": { "CNY": 7.1 } });
        let rate = parse_frankfurter_rate(&value, 0).expect("nested shape");
        assert_eq!(rate.rate, 7.1);
    }

    #[test]
    fn falls_back_to_nested_rate_when_top_level_rate_is_invalid() {
        // TS：quote === 'CNY' 但 value.rate 非正有限 → 回退 rates.CNY。
        let value = serde_json::json!({
            "base": "USD", "date": "2026-05-18", "quote": "CNY", "rate": 0, "rates": { "CNY": 7.2 }
        });
        assert_eq!(
            parse_frankfurter_rate(&value, 0).map(|rate| rate.rate),
            Some(7.2)
        );
    }

    #[test]
    fn rejects_frankfurter_responses_failing_validation() {
        let cases = [
            serde_json::json!({ "base": "EUR", "date": "2026-05-18", "quote": "CNY", "rate": 7.9 }),
            serde_json::json!({ "date": "2026-05-18", "quote": "CNY", "rate": 7.9 }),
            serde_json::json!({ "base": "USD", "quote": "CNY", "rate": 7.9 }),
            serde_json::json!({ "base": "USD", "date": "  ", "quote": "CNY", "rate": 7.9 }),
            serde_json::json!({ "base": "USD", "date": "2026-05-18", "quote": "CNY", "rate": -7.9 }),
            serde_json::json!({ "base": "USD", "date": "2026-05-18", "quote": "JPY", "rate": 150.0 }),
            serde_json::json!({ "base": "USD", "date": "2026-05-18", "quote": "CNY", "rates": {} }),
            serde_json::json!({ "base": "USD", "date": "2026-05-18", "rates": { "CNY": "7.1" } }),
            serde_json::json!("not an object"),
            serde_json::json!(42),
        ];
        for value in cases {
            assert_eq!(
                parse_frankfurter_rate(&value, 0),
                None,
                "expected rejection for {value}"
            );
        }
        // 非 JSON 文本。
        assert_eq!(parse_frankfurter_response("not json at all", 0), None);
        assert_eq!(parse_frankfurter_response("", 0), None);
    }

    // ---- 新鲜度（ISO 解析子集） ----

    #[test]
    fn freshness_uses_iso_parsing_and_treats_unparseable_as_stale() {
        let rate = cached("2026-05-17T12:00:00.000Z", 7.1, "2026-05-17");
        let fetched_at = parse_iso8601_to_unix_millis("2026-05-17T12:00:00.000Z").unwrap();
        // 恰好等于 TTL → 过期（TS 严格 <）。
        assert!(!is_fresh(
            &rate,
            60 * 60 * 1_000,
            (fetched_at + 60 * 60 * 1_000) as u64
        ));
        // TTL - 1ms → 新鲜。
        assert!(is_fresh(
            &rate,
            60 * 60 * 1_000,
            (fetched_at + 60 * 60 * 1_000 - 1) as u64
        ));
        // 未来时刻（now < fetchedAt）→ 负差 → 新鲜（TS 一致）。
        assert!(is_fresh(
            &rate,
            60 * 60 * 1_000,
            (fetched_at - 1_000) as u64
        ));
        // 不可解析 fetchedAt → 过期。
        assert!(!is_fresh(
            &cached("not a date", 7.1, "2026-05-17"),
            60 * 60 * 1_000,
            0
        ));
        assert!(!is_fresh(
            &cached("", 7.1, "2026-05-17"),
            60 * 60 * 1_000,
            0
        ));
    }

    #[test]
    fn iso_parser_supports_the_written_format_and_common_variants() {
        assert_eq!(
            parse_iso8601_to_unix_millis("1970-01-01T00:00:00.000Z"),
            Some(0)
        );
        assert_eq!(
            parse_iso8601_to_unix_millis("2026-05-17T12:00:00.000Z"),
            Some(1_779_019_200_000)
        );
        // 无毫秒。
        assert_eq!(
            parse_iso8601_to_unix_millis("2026-05-17T12:00:00Z"),
            Some(1_779_019_200_000)
        );
        // 仅日期（UTC 午夜）：2026-05-17 = 20590 天 × 86400000ms。
        assert_eq!(
            parse_iso8601_to_unix_millis("2026-05-17"),
            Some(1_778_976_000_000)
        );
        // 时区偏移：+08:00 的本地 20:00 = UTC 12:00。
        assert_eq!(
            parse_iso8601_to_unix_millis("2026-05-17T20:00:00.000+08:00"),
            Some(1_779_019_200_000)
        );
        assert_eq!(
            parse_iso8601_to_unix_millis("2026-05-17T04:00:00-0800"),
            Some(1_779_019_200_000)
        );
        // 小数截断：.1234 → 123ms。
        assert_eq!(
            parse_iso8601_to_unix_millis("1970-01-01T00:00:00.1234Z"),
            Some(123)
        );
        // 拒绝：无时区、越界字段、残缺形态。
        for invalid in [
            "2026-05-17T12:00:00.000",
            "2026-05-17T12:00:00",
            "2026-05-17T25:00:00Z",
            "2026-05-17T12:61:00Z",
            "2026-13-01",
            "2026-00-01",
            "not a date",
            "",
            "2026-05-17T12",
            "2026-05-17 12:00:00Z",
            "2026-05-17T12:00:00+24:00Z",
        ] {
            assert_eq!(
                parse_iso8601_to_unix_millis(invalid),
                None,
                "expected None for {invalid:?}"
            );
        }
    }

    #[test]
    fn iso8601_utc_matches_ts_to_string_format() {
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601_utc(1_788_393_600_123), "2026-09-03T00:00:00.123Z");
        assert_eq!(iso8601_utc(1_709_251_199_999), "2024-02-29T23:59:59.999Z");
    }

    #[test]
    fn days_and_civil_from_are_inverse_transforms() {
        for days in [-1i64, 0, 1, 10_000, 20_591, 100_000] {
            let (year, month, day) = civil_from_days(days);
            assert_eq!(days_from_civil(year, month, day), days, "round trip {days}");
        }
    }

    // ---- M4 Task 7：peek + ingest（查询管线的非阻塞两半） ----

    #[test]
    fn peek_reports_fresh_cache_without_fetch() {
        let dir = TempDir::create("cabin-core-rate-peek-fresh");
        let path = temp_cache_path(&dir);
        write_cache_file(&path, "2026-05-17T12:00:00.000Z", 7.1, "2026-05-17");
        // now == fetchedAt → 新鲜（TTL 1h）。
        let mut cache = ExchangeRateCache::load_with_clock(&path, || 1_779_019_200_000);

        match cache.peek_usd_to_cny_rate() {
            ExchangeRatePeek::Fresh(rate) => {
                assert_eq!(rate.rate, 7.1);
                assert_eq!(rate.source, ExchangeRateResultSource::Cache);
            }
            other => panic!("expected fresh peek, got {other:?}"),
        }
    }

    #[test]
    fn peek_reports_stale_cache_for_expired_entry() {
        let dir = TempDir::create("cabin-core-rate-peek-stale");
        let path = temp_cache_path(&dir);
        write_cache_file(&path, "2026-05-17T12:00:00.000Z", 7.1, "2026-05-17");
        // now = fetchedAt + 2h > TTL → 过期。
        let mut cache =
            ExchangeRateCache::load_with_clock(&path, || 1_779_019_200_000 + 2 * 3_600_000);

        match cache.peek_usd_to_cny_rate() {
            ExchangeRatePeek::Stale(rate) => {
                assert_eq!(rate.rate, 7.1);
                assert_eq!(rate.source, ExchangeRateResultSource::Cache);
            }
            other => panic!("expected stale peek, got {other:?}"),
        }
        // 过期 peek 不写盘、不改内存：再次 peek 仍报告同一过期值。
        assert!(matches!(
            cache.peek_usd_to_cny_rate(),
            ExchangeRatePeek::Stale(_)
        ));
    }

    #[test]
    fn peek_reports_missing_without_cache_file() {
        let dir = TempDir::create("cabin-core-rate-peek-missing");
        let mut cache = ExchangeRateCache::load_with_clock(&temp_cache_path(&dir), || 0);
        assert_eq!(cache.peek_usd_to_cny_rate(), ExchangeRatePeek::Missing);
    }

    #[test]
    fn ingest_stores_fetched_body_and_updates_memory() {
        let dir = TempDir::create("cabin-core-rate-ingest");
        let path = temp_cache_path(&dir);
        let mut cache = ExchangeRateCache::load_with_clock(&path, || 1_788_393_600_000);

        let stored = cache
            .ingest_fetched_body(Some(frankfurter_body(7.1234, "2026-05-18")))
            .expect("ingest should store");
        assert_eq!(stored.rate, 7.1234);
        // 回灌后内存可见：peek 直接命中新鲜缓存（clock 未动）。
        assert!(matches!(
            cache.peek_usd_to_cny_rate(),
            ExchangeRatePeek::Fresh(_)
        ));
        // 落盘文件与 TS 形状一致。
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("cache file exists"))
                .unwrap();
        assert_eq!(value["rate"], 7.1234);
        assert_eq!(value["provider"], "Frankfurter");
    }

    #[test]
    fn ingest_folds_missing_and_invalid_bodies() {
        let dir = TempDir::create("cabin-core-rate-ingest-fail");
        let mut cache = ExchangeRateCache::load_with_clock(&temp_cache_path(&dir), || 0);

        // 传输失败（None）→ None；缓存仍缺失。
        assert_eq!(cache.ingest_fetched_body(None), None);
        assert_eq!(cache.peek_usd_to_cny_rate(), ExchangeRatePeek::Missing);
        // 解析失败（形状不符）→ None。
        assert_eq!(
            cache.ingest_fetched_body(Some("{\"base\":\"EUR\"}".to_string())),
            None
        );
        assert_eq!(cache.peek_usd_to_cny_rate(), ExchangeRatePeek::Missing);
    }

    #[test]
    fn peek_and_ingest_match_sync_get_usd_to_cny_rate_outcomes() {
        // 组合等价性：fresh peek 值 == 同步路径返回值（旧缓存 + 'cache'）；
        // missing + ingest == 同步 no-cache 路径的 live 结果。
        let dir = TempDir::create("cabin-core-rate-equivalence");
        let path = temp_cache_path(&dir);
        let body = frankfurter_body(7.25, "2026-05-18");
        let mut cache = ExchangeRateCache::load_with_clock(&path, || 0);

        let sync = ExchangeRateCache::load_with_clock(&path, || 0)
            .get_usd_to_cny_rate(|| Some(body.clone()))
            .expect("sync live path");
        cache
            .ingest_fetched_body(Some(body))
            .expect("ingest stores");
        let async_shaped = match cache.peek_usd_to_cny_rate() {
            ExchangeRatePeek::Fresh(rate) => rate,
            other => panic!("expected fresh peek, got {other:?}"),
        };
        assert_eq!(sync.rate, async_shaped.rate);
        assert_eq!(sync.fetched_at, async_shaped.fetched_at);
    }
}
