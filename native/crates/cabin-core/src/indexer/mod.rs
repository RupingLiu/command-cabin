//! 应用索引数据模型。移植自 packages/core 的索引结果结构。
//! 纯数据类型放在 core，平台 crate（cabin-platform / cabin-platform-windows）引用之，
//! 保持“core 不依赖平台”的分层。

use std::path::PathBuf;

pub mod app_commands;

/// 一个已解析的快捷方式条目。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedShortcut {
    pub shortcut_path: PathBuf,
    pub name: String,
    pub target_path: Option<PathBuf>,
    pub arguments: Option<String>,
    pub working_directory: Option<PathBuf>,
    pub app_user_model_id: Option<String>,
    pub icon_path: Option<String>,
}

/// 一个 MSIX/APPX 打包应用的启动项（UI 修复 4 新增；TS 时代开始菜单扫描只认
/// .lnk，商店/MSIX 应用因此不可见）。display_name 已按展示名回退链解析完毕
/// （AppListEntry → 包 DisplayName → AUMID，见 cabin-platform-windows 的
/// packaged_apps）；app_user_model_id 为 `包族名!应用 Id` 形式的 AUMID。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackagedAppEntry {
    pub display_name: String,
    pub app_user_model_id: String,
}

/// 单个条目扫描失败记录；不中断整体扫描（对齐 TS 行为）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexScanFailure {
    pub path: PathBuf,
    pub message: String,
}

/// 全量扫描结果：成功条目 + 失败条目。
#[derive(Debug, Default)]
pub struct IndexScanResult {
    pub shortcuts: Vec<IndexedShortcut>,
    pub failures: Vec<IndexScanFailure>,
}
