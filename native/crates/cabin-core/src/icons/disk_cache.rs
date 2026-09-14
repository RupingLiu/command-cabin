//! 磁盘 dataUrl 图标缓存。移植自
//! `apps/desktop/src/main/icons/iconDataUrlCache.ts`（225 行）。
//!
//! 文件形状：`{ "entries": { <key>: { "cachedAt": ISO, "dataUrl" } }, "version": 2 }`，
//! pretty JSON（2 空格缩进）+ 结尾换行，键按插入序写出。
//!
//! 载入规则（对齐 TS `parseCacheFile`）：文件缺失 / JSON 损坏 / 非 JSON 对象 /
//! `version` 不匹配 → 整体空缓存；单条目缺字段、`dataUrl` 非 `data:image/`
//! 前缀 → 仅丢弃该条目。
//!
//! 写入规则：`dataUrl` 非 `data:image/` 前缀的条目直接忽略；超
//! [`super::ICON_CACHE_MAX_ENTRIES`] 时逐最旧 `cachedAt`（并列时按插入序，
//! 对齐 TS 稳定排序语义）；改写已存在键保持插入位（对齐 JS `Map.set`）。
//!
//! 与 TS 版的有意差异：本 crate 不内置去抖定时器，`flush` 由调用方驱动；
//! 原子写 = 临时文件（`<path>.<pid>.<seq>.tmp`）+ rename，失败时清理临时文件。

use std::fs::File;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::ser::SerializeMap;
use serde::Serialize;

use super::{is_image_data_url, ICON_CACHE_MAX_ENTRIES, ICON_CACHE_VERSION};

/// 单个缓存条目（文件字段为 camelCase，对齐 TS 形状）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct CachedIconEntry {
    #[serde(rename = "cachedAt")]
    cached_at: String,
    #[serde(rename = "dataUrl")]
    data_url: String,
}

/// 磁盘图标缓存。通过 [`IconDiskCache::load`]（或
/// [`IconDiskCache::load_with_clock`]）载入，`write` / `read` 操作内存条目，
/// `flush` 由调用方在合适时机落盘。
pub struct IconDiskCache {
    path: PathBuf,
    entries: Vec<(String, CachedIconEntry)>,
    max_entries: usize,
    clock: Box<dyn Fn() -> u64 + Send>,
}

static TEMPORARY_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

impl IconDiskCache {
    /// 从磁盘载入缓存。文件缺失 / 损坏 / 版本不符 → 空缓存（不报错）。
    pub fn load(path: &Path) -> Self {
        Self::load_with_clock(path, system_unix_millis)
    }

    /// [`IconDiskCache::load`] 的可注入时钟版本（unix 毫秒），供测试与
    /// 需要自定义时间源的场景使用。
    pub fn load_with_clock<F>(path: &Path, clock: F) -> Self
    where
        F: Fn() -> u64 + Send + 'static,
    {
        let entries = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .map(|value| parse_cache_file(&value))
            .unwrap_or_default();
        Self {
            path: path.to_path_buf(),
            entries,
            max_entries: ICON_CACHE_MAX_ENTRIES,
            clock: Box::new(clock),
        }
    }

    /// 覆盖默认最大条目数（对齐 TS `maxEntries` 选项；默认
    /// [`super::ICON_CACHE_MAX_ENTRIES`]）。
    pub fn with_max_entries(mut self, max_entries: usize) -> Self {
        self.max_entries = max_entries.max(1);
        self
    }

    /// 读取指定键的 dataUrl。
    pub fn read(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, entry)| entry.data_url.as_str())
    }

    /// 写入条目。非 `data:image/` 前缀的 dataUrl 被忽略（对齐 TS `write`）；
    /// 改写已存在键保持插入位；超限逐最旧 `cachedAt`。
    pub fn write(&mut self, key: String, data_url: String) {
        if !is_image_data_url(&data_url) {
            return;
        }
        let entry = CachedIconEntry {
            cached_at: iso8601_utc((self.clock)()),
            data_url,
        };
        match self
            .entries
            .iter_mut()
            .find(|(existing, _)| *existing == key)
        {
            // 对齐 JS Map.set：改写值但保持原插入位。
            Some((_, slot)) => *slot = entry,
            None => self.entries.push((key, entry)),
        }
        self.trim();
    }

    /// 当前条目数。
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 落盘：pretty JSON + 结尾换行，临时文件 + rename 原子写，
    /// 失败时清理临时文件并返回错误。
    pub fn flush(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let snapshot = Snapshot {
            entries: EntriesInOrder(&self.entries),
            version: ICON_CACHE_VERSION,
        };
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(&snapshot)
                .expect("icon cache snapshot serialization cannot fail")
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

    /// 超限时按 `cachedAt` 升序逐出（并列时按插入序，对齐 TS 稳定排序）。
    fn trim(&mut self) {
        if self.entries.len() <= self.max_entries {
            return;
        }
        let to_delete = self.entries.len() - self.max_entries;
        let mut oldest: Vec<usize> = (0..self.entries.len()).collect();
        oldest.sort_by(|&left, &right| {
            self.entries[left]
                .1
                .cached_at
                .cmp(&self.entries[right].1.cached_at)
        });
        oldest.truncate(to_delete);
        oldest.sort_unstable();
        for index in oldest.into_iter().rev() {
            self.entries.remove(index);
        }
    }
}

fn write_atomic(temporary_path: &Path, target_path: &Path, text: &str) -> std::io::Result<()> {
    let mut file = File::create(temporary_path)?;
    file.write_all(text.as_bytes())?;
    drop(file);
    std::fs::rename(temporary_path, target_path)
}

/// 解析缓存文件 JSON 值；版本不符 → 空，单条目非法 → 逐条丢弃。
fn parse_cache_file(value: &serde_json::Value) -> Vec<(String, CachedIconEntry)> {
    let Some(object) = value.as_object() else {
        return Vec::new();
    };
    if object.get("version").and_then(serde_json::Value::as_u64)
        != Some(u64::from(ICON_CACHE_VERSION))
    {
        return Vec::new();
    }
    let Some(entries) = object.get("entries").and_then(serde_json::Value::as_object) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|(key, entry)| {
            let entry_object = entry.as_object()?;
            let cached_at = entry_object.get("cachedAt")?.as_str()?;
            let data_url = entry_object.get("dataUrl")?.as_str()?;
            if !is_image_data_url(data_url) {
                return None;
            }
            Some((
                key.clone(),
                CachedIconEntry {
                    cached_at: cached_at.to_string(),
                    data_url: data_url.to_string(),
                },
            ))
        })
        .collect()
}

/// unix 毫秒 → `YYYY-MM-DDTHH:MM:SS.mmmZ`（对齐 TS `Date.toISOString()`）。
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

/// 天数（自 unix 纪元）→ (年, 月, 日)。Howard Hinnant `civil_from_days` 算法。
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

fn system_unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

/// 快照顶层结构：`{ entries, version }`，entries 保持插入序。
#[derive(Serialize)]
struct Snapshot<'a> {
    entries: EntriesInOrder<'a>,
    version: u32,
}

struct EntriesInOrder<'a>(&'a [(String, CachedIconEntry)]);

impl Serialize for EntriesInOrder<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, entry) in self.0 {
            map.serialize_entry(key, entry)?;
        }
        map.end()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;

    use super::super::{ICON_CACHE_MAX_ENTRIES, ICON_CACHE_VERSION};
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

    fn png_data_url(payload: &str) -> String {
        format!("data:image/png;base64,{payload}")
    }

    fn temp_cache_path(dir: &TempDir) -> PathBuf {
        dir.0.join("app-icons.json")
    }

    #[test]
    fn load_missing_file_starts_empty() {
        let dir = TempDir::create("cabin-core-icons-missing");
        let cache = IconDiskCache::load(&temp_cache_path(&dir));
        assert!(cache.is_empty());
        assert_eq!(cache.read("anything"), None);
    }

    #[test]
    fn load_rejects_wrong_version() {
        let dir = TempDir::create("cabin-core-icons-version");
        let path = temp_cache_path(&dir);
        std::fs::write(
            &path,
            format!(
                r#"{{"entries":{{"k":{{"cachedAt":"2026-01-01T00:00:00.000Z","dataUrl":"{}"}}}},"version":3}}"#,
                png_data_url("AAA")
            ),
        )
        .unwrap();
        let cache = IconDiskCache::load(&path);
        assert!(cache.is_empty());
        assert_eq!(cache.read("k"), None);
    }

    #[test]
    fn load_rejects_string_version() {
        // TS 严格相等：version 为字符串 "2" 也不算匹配。
        let dir = TempDir::create("cabin-core-icons-version-str");
        let path = temp_cache_path(&dir);
        std::fs::write(
            &path,
            format!(
                r#"{{"entries":{{"k":{{"cachedAt":"2026-01-01T00:00:00.000Z","dataUrl":"{}"}}}},"version":"2"}}"#,
                png_data_url("AAA")
            ),
        )
        .unwrap();
        assert!(IconDiskCache::load(&path).is_empty());
    }

    #[test]
    fn load_drops_non_image_entries_and_keeps_valid_siblings() {
        let dir = TempDir::create("cabin-core-icons-nonimage");
        let path = temp_cache_path(&dir);
        std::fs::write(
            &path,
            format!(
                r#"{{"entries":{{"bad":{{"cachedAt":"2026-01-01T00:00:00.000Z","dataUrl":"https://example.com/x.png"}},"good":{{"cachedAt":"2026-01-02T00:00:00.000Z","dataUrl":"{}"}}}},"version":{ICON_CACHE_VERSION}}}"#,
                png_data_url("BBB")
            ),
        )
        .unwrap();
        let cache = IconDiskCache::load(&path);
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.read("bad"), None);
        assert_eq!(cache.read("good"), Some(png_data_url("BBB").as_str()));
    }

    #[test]
    fn load_drops_entries_missing_fields() {
        let dir = TempDir::create("cabin-core-icons-missing-fields");
        let path = temp_cache_path(&dir);
        std::fs::write(
            &path,
            format!(
                r#"{{"entries":{{"no-time":{{"dataUrl":"{}"}},"no-url":{{"cachedAt":"2026-01-01T00:00:00.000Z"}}}},"version":{ICON_CACHE_VERSION}}}"#,
                png_data_url("AAA")
            ),
        )
        .unwrap();
        assert!(IconDiskCache::load(&path).is_empty());
    }

    #[test]
    fn load_rejects_corrupted_or_non_object_files() {
        let dir = TempDir::create("cabin-core-icons-corrupt");
        let path = temp_cache_path(&dir);
        std::fs::write(&path, "{not json").unwrap();
        assert!(IconDiskCache::load(&path).is_empty());
        std::fs::write(&path, "[1,2,3]").unwrap();
        assert!(IconDiskCache::load(&path).is_empty());
        std::fs::write(&path, r#""just a string""#).unwrap();
        assert!(IconDiskCache::load(&path).is_empty());
    }

    #[test]
    fn flush_then_load_round_trips_entries() {
        let dir = TempDir::create("cabin-core-icons-roundtrip");
        let path = temp_cache_path(&dir);
        let mut cache = IconDiskCache::load(&path);
        cache.write("k1".into(), png_data_url("AA"));
        cache.write("k2".into(), png_data_url("BB"));
        cache.flush().unwrap();

        let reloaded = IconDiskCache::load(&path);
        assert_eq!(reloaded.len(), 2);
        assert_eq!(reloaded.read("k1"), Some(png_data_url("AA").as_str()));
        assert_eq!(reloaded.read("k2"), Some(png_data_url("BB").as_str()));
    }

    #[test]
    fn write_ignores_non_image_data_urls() {
        let dir = TempDir::create("cabin-core-icons-write-guard");
        let path = temp_cache_path(&dir);
        let mut cache = IconDiskCache::load(&path);
        cache.write("k".into(), "data:text/plain;base64,AAA".into());
        cache.write("k".into(), "https://example.com/x.png".into());
        assert!(cache.is_empty());
    }

    #[test]
    fn write_evicts_oldest_cached_at() {
        let dir = TempDir::create("cabin-core-icons-evict");
        let path = temp_cache_path(&dir);
        let clock = Arc::new(AtomicU64::new(1));
        let clock_clone = clock.clone();
        let mut cache = IconDiskCache::load_with_clock(&path, move || {
            clock_clone.fetch_add(1, Ordering::SeqCst)
        });
        for index in 0..(ICON_CACHE_MAX_ENTRIES + 1) {
            cache.write(format!("key-{index}"), png_data_url("AA"));
        }
        assert_eq!(cache.len(), ICON_CACHE_MAX_ENTRIES);
        assert_eq!(cache.read("key-0"), None);
        assert_eq!(cache.read("key-1"), Some(png_data_url("AA").as_str()));
        assert_eq!(
            cache.read(&format!("key-{ICON_CACHE_MAX_ENTRIES}")),
            Some(png_data_url("AA").as_str())
        );
        // 驱逐结果落盘后依然成立。
        cache.flush().unwrap();
        let reloaded = IconDiskCache::load(&path);
        assert_eq!(reloaded.len(), ICON_CACHE_MAX_ENTRIES);
        assert_eq!(reloaded.read("key-0"), None);
    }

    #[test]
    fn write_evicts_by_insertion_order_when_cached_at_ties() {
        let dir = TempDir::create("cabin-core-icons-evict-ties");
        let path = temp_cache_path(&dir);
        let mut cache = IconDiskCache::load_with_clock(&path, || 42).with_max_entries(3);
        cache.write("a".into(), png_data_url("AA"));
        cache.write("b".into(), png_data_url("BB"));
        cache.write("c".into(), png_data_url("CC"));
        cache.write("d".into(), png_data_url("DD"));
        assert_eq!(cache.len(), 3);
        assert_eq!(cache.read("a"), None);
        assert_eq!(cache.read("b"), Some(png_data_url("BB").as_str()));
        assert_eq!(cache.read("d"), Some(png_data_url("DD").as_str()));
    }

    #[test]
    fn rewriting_existing_key_keeps_insertion_position() {
        // 对齐 JS Map.set：改写已存在键不改变插入位。
        let dir = TempDir::create("cabin-core-icons-rewrite");
        let path = temp_cache_path(&dir);
        let mut cache = IconDiskCache::load_with_clock(&path, || 7);
        cache.write("a".into(), png_data_url("AA"));
        cache.write("b".into(), png_data_url("BB"));
        cache.write("a".into(), png_data_url("CC"));
        cache.flush().unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let a_index = text.find("\"a\"").unwrap();
        let b_index = text.find("\"b\"").unwrap();
        assert!(a_index < b_index);
        assert_eq!(cache.read("a"), Some(png_data_url("CC").as_str()));
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn flush_writes_pretty_json_with_trailing_newline() {
        let dir = TempDir::create("cabin-core-icons-format");
        let path = temp_cache_path(&dir);
        let cache = IconDiskCache::load_with_clock(&path, || 0);
        // 空 entries 也要是合法形状：`"entries": {}`。
        cache.flush().unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\n  \"entries\": {},\n  \"version\": 2\n}\n"
        );
    }

    #[test]
    fn flush_file_shape_matches_ts_format() {
        let dir = TempDir::create("cabin-core-icons-format2");
        let path = temp_cache_path(&dir);
        let mut cache = IconDiskCache::load_with_clock(&path, || 0);
        cache.write("key-1".into(), png_data_url("AAAA"));
        cache.flush().unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!(
                "{}\n",
                r#"{
  "entries": {
    "key-1": {
      "cachedAt": "1970-01-01T00:00:00.000Z",
      "dataUrl": "data:image/png;base64,AAAA"
    }
  },
  "version": 2
}"#
            )
        );
    }

    #[test]
    fn flush_leaves_no_temporary_files() {
        let dir = TempDir::create("cabin-core-icons-no-tmp");
        let path = temp_cache_path(&dir);
        let mut cache = IconDiskCache::load(&path);
        cache.write("k".into(), png_data_url("AA"));
        cache.flush().unwrap();
        let leftovers: Vec<String> = std::fs::read_dir(&dir.0)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec!["app-icons.json".to_string()]);
    }

    #[test]
    fn flush_failure_removes_temporary_file() {
        let dir = TempDir::create("cabin-core-icons-fail-tmp");
        // 目标路径被目录占位 → rename 失败，临时文件应被清理。
        let path = temp_cache_path(&dir);
        std::fs::create_dir_all(&path).unwrap();
        let mut cache = IconDiskCache::load(&path);
        cache.write("k".into(), png_data_url("AA"));
        assert!(cache.flush().is_err());
        let leftovers: Vec<String> = std::fs::read_dir(&dir.0)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec!["app-icons.json".to_string()]);
    }

    #[test]
    fn flush_creates_missing_parent_directories() {
        let dir = TempDir::create("cabin-core-icons-mkdir");
        let path = dir.0.join("nested").join("deeper").join("app-icons.json");
        let mut cache = IconDiskCache::load(&path);
        cache.write("k".into(), png_data_url("AA"));
        cache.flush().unwrap();
        assert_eq!(
            IconDiskCache::load(&path).read("k"),
            Some(png_data_url("AA").as_str())
        );
    }

    #[test]
    fn iso8601_matches_ts_to_string_format() {
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00.000Z");
        // 2026-09-03T00:00:00Z = 1788393600 秒
        assert_eq!(iso8601_utc(1_788_393_600_123), "2026-09-03T00:00:00.123Z");
        // 闰年边界：2024-02-29T23:59:59.999Z = 1709251199.999
        assert_eq!(iso8601_utc(1_709_251_199_999), "2024-02-29T23:59:59.999Z");
    }

    #[test]
    fn default_clock_is_wall_time() {
        assert!(system_unix_millis() > 1_700_000_000_000);
    }
}
