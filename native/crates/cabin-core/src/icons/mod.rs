//! 图标缓存：磁盘 dataUrl 缓存 + 内存有界缓存。移植自
//! `apps/desktop/src/main/icons/iconDataUrlCache.ts` 与 `boundedMemoryCache.ts`。
//!
//! 与 TS 版的有意差异：TS 版在 `write` 后自带去抖定时器（500ms 延迟 / 首次
//! dirty 起 1500ms 最长等待）。本 crate 不做定时器，`flush` 由调用方驱动。
//! 两个时序常量（[`ICON_CACHE_FLUSH_DELAY_MS`] / [`ICON_CACHE_FLUSH_MAX_WAIT_MS`]）
//! 保留在此并附带文档，供 app 层接线（Task 9）用定时器 / 滑出时机调度 flush，
//! 使定时行为归属应用层、本 crate 保持可测。

mod cache_key;
mod data_url;
mod disk_cache;
mod memory_cache;

pub use cache_key::result_icon_cache_key;
pub use data_url::{
    data_url_to_bytes, icon_bytes_to_data_url, is_image_data_url, png_bytes_to_data_url,
};
pub use disk_cache::IconDiskCache;
pub use memory_cache::{BoundedMemoryCache, BoundedMemorySet};

/// 磁盘缓存文件格式版本（顶层 `version` 字段）。载入时不匹配即整体视为空缓存。
pub const ICON_CACHE_VERSION: u32 = 2;

/// 磁盘缓存最大条目数；超出时逐最旧 `cachedAt`（并列时按插入序）。
pub const ICON_CACHE_MAX_ENTRIES: usize = 256;

/// 结果级图标缓存键的版本前缀。UI 修复 4：v4 → v5——提取尺寸 32px → 96px；
/// UI 修复 8：v5 → v6——HBITMAP 管线 alpha 修复（黑底/颠倒），强制重提取
/// （见 cabin-app `ICON_EXTRACT_SIZE_PX`），旧 v4 键不再被读取，随 256 条目
/// 上限自然逐出。注意：此改动**有意打破**与 Electron 实现共享缓存文件时的键
/// 一致（TS `appIconResolver.ts` 仍是 app-result-v4 且按其自身尺寸提取）——
/// 共存期间两栈各自重提取各自的键，行为正确但缓存条目会短暂翻倍。
pub const RESULT_ICON_CACHE_VERSION: &str = "app-result-v6";

/// 结果级图标缓存键中指纹（sha256 hex）截取长度。
pub const RESULT_ICON_CACHE_HASH_LENGTH: usize = 16;

/// 内存图标缓存默认最大条目数（对齐 TS DEFAULT_MEMORY_CACHE_MAX_ENTRIES）。
pub const MEMORY_CACHE_MAX_ENTRIES: usize = 96;

/// 关联图标回退 PNG 的字节阈值（对齐 TS ASSOCIATED_ICON_FALLBACK_PNG_BYTE_THRESHOLD）。
pub const PNG_FALLBACK_BYTE_THRESHOLD: usize = 1200;

/// TS 版 `write` 后的去抖延迟（毫秒）。本 crate 不做定时器；由调用方（Task 9 接线）
/// 用该值调度 flush，使定时行为归属应用层。
pub const ICON_CACHE_FLUSH_DELAY_MS: u64 = 500;

/// TS 版首次 dirty 起的最长等待（毫秒）。本 crate 不做定时器；由调用方
/// （Task 9 接线）用该值强制及时 flush。
pub const ICON_CACHE_FLUSH_MAX_WAIT_MS: u64 = 1500;
