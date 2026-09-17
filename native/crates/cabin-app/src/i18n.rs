//! M2 Task 10 UI 文案表（zh-CN 规范 + zh-TW + en-US）。
//!
//! 对齐 TS `apps/desktop/src/renderer/src/i18n.ts` 的键名：凡 TS 已有文案
//! （`settings.*` / `launcher.pinnedAppMenu.*`）一律逐字复用，键名保持 TS
//! 小写点路径的语义（结构体字段名可读化）；TS 尚无文案的 M2 新增控件
//! （hideOnBlur、maxResults、四个 boost、首页分组头、固定按钮）用自然语言
//! 新建，任务报告已注明为 TS 未覆盖的新键。

use cabin_core::favorites::FavoriteKind;
use cabin_core::settings::Language;

/// 设置窗口界面文案（字段对应 settings.slint 的 `SettingsTexts`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsUiTexts {
    pub shortcuts_nav: &'static str,
    pub general_title: &'static str,
    pub data_title: &'static str,
    pub advanced_title: &'static str,
    pub general_description: &'static str,
    pub hotkeys_description: &'static str,
    pub favorites_description: &'static str,
    pub data_description: &'static str,
    pub about_description: &'static str,
    pub saved_hint: &'static str,

    pub window_title: &'static str,
    pub hotkeys_title: &'static str,
    pub launcher_hotkey_label: &'static str,
    pub screenshot_hotkey_label: &'static str,
    pub delayed_hotkey_label: &'static str,
    pub appearance_title: &'static str,
    pub theme_label: &'static str,
    pub theme_system: &'static str,
    pub theme_light: &'static str,
    pub theme_dark: &'static str,
    pub language_title: &'static str,
    pub language_label: &'static str,
    pub language_zh_cn: &'static str,
    pub language_zh_tw: &'static str,
    pub language_en_us: &'static str,
    pub startup_title: &'static str,
    pub launch_at_login: &'static str,
    pub launcher_title: &'static str,
    pub hide_on_blur: &'static str,
    pub preserve_search_query: &'static str,
    pub max_results: &'static str,
    pub history_boost: &'static str,
    pub plugin_boost: &'static str,
    pub app_boost: &'static str,
    pub file_boost: &'static str,
    pub favorites_title: &'static str,
    pub favorites_empty: &'static str,
    pub favorites_remove: &'static str,
    /// settings.clipboardHistory.title（M4 Task 7）。
    pub clipboard_history_title: &'static str,
    /// settings.clipboardHistory.clear。
    pub clipboard_history_clear: &'static str,
    pub about_title: &'static str,
    pub about_license: &'static str,
    /// settings.about.check（M5 Task 3 更新检查钮）。
    pub about_check: &'static str,
    /// 新键（TS 无此键：TS 发现新版本即自动下载，无下载钮；M5 native 手动下载）。
    pub about_download: &'static str,
    /// settings.about.install。
    pub about_install: &'static str,
    pub back: &'static str,
}

/// 启动器新增界面文案（首页分组头 + 固定按钮）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HomeUiTexts {
    pub keyboard_hint: &'static str,
    pub empty_hint: &'static str,
    pub no_results_hint: &'static str,
    pub home_action_ocr: &'static str,

    /// 空查询首页 "最近使用" 分组头。
    pub recent_group: &'static str,
    /// 空查询首页 "固定" 分组头。
    pub pinned_group: &'static str,
    /// 搜索结果 app 行的 "固定到首页" 按钮。
    pub pin_app: &'static str,
    pub unpin_app: &'static str,
    /// 空查询首页 "首页功能" 分区头（UI 修复 3；TS `launcher.homeActionsLabel`）。
    pub home_actions_label: &'static str,
    /// "首页功能" 分区里的截图入口（UI 修复 3；TS `launcher.homeActions.screenshot`）。
    pub home_action_screenshot: &'static str,
    /// 搜索区标签（UI 复刻轮；TS `launcher.search.label`）。
    pub search_label: &'static str,
    /// 搜索输入占位文案（UI 复刻轮；TS `launcher.search.placeholder`）。
    pub search_placeholder: &'static str,
    /// 标题栏设置齿轮无障碍文案（UI 复刻轮；TS `launcher.openSettings`）。
    pub open_settings: &'static str,
}

/// 截图覆盖窗口界面文案（M3 Task 7/8/9；键名对齐 TS `screenshot.*`，逐字复用；
/// Task 8 补齐 ocr/translation/status 段与输出窗所需的其余键）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenshotUiTexts {
    /// screenshot.tools.rectangle 等（TS toolOrder 序）。
    pub tool_rectangle: &'static str,
    pub tool_ellipse: &'static str,
    pub tool_arrow: &'static str,
    pub tool_pen: &'static str,
    pub tool_mosaic: &'static str,
    pub tool_text: &'static str,
    /// screenshot.toolbar.undo / redo。
    pub undo: &'static str,
    pub redo: &'static str,
    /// screenshot.toolbar.ocr / translate / pin / save / cancel / done。
    pub ocr: &'static str,
    pub translate: &'static str,
    pub pin: &'static str,
    pub save: &'static str,
    pub cancel: &'static str,
    pub done: &'static str,
    /// screenshot.textPrompt.defaultText（文本提示占位）。
    pub prompt_placeholder: &'static str,
    // ---- M3 Task 8：输出面板 / 输出窗（键名对齐 TS screenshot.ocr.* /
    // screenshot.translation.* / screenshot.status.*；image_copy 为 TS 未覆盖
    // 的新键——TS 置顶图窗只有关闭按钮，M3 简化授权新增复制钮）。----
    /// screenshot.actionFailed。
    pub action_failed: &'static str,
    /// screenshot.ocr.recognizing / noText / copyAll / failed。
    pub ocr_recognizing: &'static str,
    pub ocr_no_text: &'static str,
    pub ocr_copy_all: &'static str,
    pub ocr_failed: &'static str,
    /// screenshot.translation.source / result / translating / noText / failed / copy。
    pub translation_source: &'static str,
    pub translation_result: &'static str,
    pub translation_translating: &'static str,
    pub translation_no_text: &'static str,
    pub translation_failed: &'static str,
    pub translation_copy: &'static str,
    /// screenshot.translation.onlineConsent（评审 Finding 3：M3 无对话框组件，
    /// 在线翻译同意门 fail-closed 时把该文案作为"不可用"结果窗消息；同意 UI /
    /// 设置开关随 M5 落地）。
    pub translation_online_consent: &'static str,
    /// screenshot.status.imageSaved / saveCanceled / pinned。
    pub status_image_saved: &'static str,
    pub status_save_canceled: &'static str,
    pub status_pinned: &'static str,
    /// 置顶图窗图片复制按钮（TS 无此键，M3 新增）。
    pub image_copy: &'static str,
}

/// 收藏列表行的类别文案（对齐 TS `settings.favorites.kinds`；固定应用走
/// `launcher.sources.app` 的展示词，TS 收藏列表与固定应用列表分属两处 UI）。
pub fn favorite_kind_label(
    language: Language,
    is_pinned_app: bool,
    kind: FavoriteKind,
) -> &'static str {
    if is_pinned_app {
        return match language {
            Language::EnUs => "App",
            Language::ZhCn => "应用",
            Language::ZhTw => "應用程式",
        };
    }
    match (language, kind) {
        (Language::EnUs, FavoriteKind::File) => "File",
        (Language::EnUs, FavoriteKind::Folder) => "Folder",
        (Language::EnUs, FavoriteKind::Url) => "URL",
        (Language::ZhCn, FavoriteKind::File) => "文件",
        (Language::ZhCn, FavoriteKind::Folder) => "文件夹",
        (Language::ZhCn, FavoriteKind::Url) => "URL",
        (Language::ZhTw, FavoriteKind::File) => "檔案",
        (Language::ZhTw, FavoriteKind::Folder) => "資料夾",
        (Language::ZhTw, FavoriteKind::Url) => "URL",
    }
}

/// TS `settings.title` 等键逐字复用的设置窗口文案。键名对齐 TS 的地方已在
/// 各字段注释标注；`ts` 键不存在的 M2 新控件标注 “TS 无此键”。
pub fn settings_texts(language: Language) -> SettingsUiTexts {
    let zh_cn = SettingsUiTexts {
        shortcuts_nav: "快捷键",
        general_title: "通用",
        data_title: "数据",
        advanced_title: "高级搜索设置",
        general_description: "让启动器更符合你的使用习惯。",
        hotkeys_description: "随时呼出启动器和截图工具。修改后按回车或移开焦点保存。",
        favorites_description: "管理固定应用和收藏内容。",
        data_description: "管理保存在本机的剪贴板历史。",
        about_description: "版本信息、更新与许可。",
        saved_hint: "设置在修改后自动保存",

        window_title: "设置",                   // settings.title
        hotkeys_title: "全局快捷键",            // settings.shortcutsTitle
        launcher_hotkey_label: "启动器快捷键",  // settings.hotkey.title
        screenshot_hotkey_label: "截图快捷键",  // settings.screenshotHotkey.title
        delayed_hotkey_label: "延时截图快捷键", // settings.delayedScreenshotHotkey.title
        appearance_title: "主题",               // settings.theme.title
        theme_label: "主题模式",                // settings.theme.mode
        theme_system: "跟随系统",               // settings.theme.options.system
        theme_light: "浅色",                    // settings.theme.options.light
        theme_dark: "深色",                     // settings.theme.options.dark
        language_title: "语言",                 // settings.language.title
        language_label: "显示语言",             // settings.language.displayLanguage
        language_zh_cn: "简体中文",
        language_zh_tw: "繁體中文",
        language_en_us: "English",
        startup_title: "启动",                     // settings.startup.title
        launch_at_login: "开机自启动",             // settings.startup.launchAtLogin
        launcher_title: "启动器",                  // settings.launcher.title
        hide_on_blur: "失焦时自动隐藏",            // TS 无此键
        preserve_search_query: "保留上次搜索内容", // settings.launcher.preserveSearchQuery
        max_results: "最多显示结果数",             // TS 无此键
        history_boost: "历史记录权重",             // TS 无此键
        plugin_boost: "插件权重",                  // TS 无此键
        app_boost: "应用权重",                     // TS 无此键
        file_boost: "文件权重",                    // TS 无此键
        favorites_title: "收藏",                   // settings.favorites.title
        favorites_empty: "暂无收藏",               // settings.favorites.empty
        favorites_remove: "移除",                  // launcher.pinnedAppMenu.remove
        clipboard_history_title: "剪贴板历史",     // settings.clipboardHistory.title
        clipboard_history_clear: "清空历史",       // settings.clipboardHistory.clear
        about_title: "关于",                       // TS settings.about.title（含更新，M2 未含）
        about_license: "界面框架：Slint（Royalty-free 许可，https://slint.dev）",
        about_check: "检查更新",   // settings.about.check
        about_download: "下载",    // TS 无此键（M5 手动下载钮）
        about_install: "重启安装", // settings.about.install
        back: "返回",              // settings.back
    };
    let zh_tw = SettingsUiTexts {
        shortcuts_nav: "快捷鍵",
        general_title: "一般",
        data_title: "資料",
        advanced_title: "進階搜尋設定",
        general_description: "讓啟動器更符合你的使用習慣。",
        hotkeys_description: "隨時叫出啟動器和截圖工具。修改後按 Enter 或移開焦點儲存。",
        favorites_description: "管理固定應用程式與收藏內容。",
        data_description: "管理儲存在本機的剪貼簿歷史。",
        about_description: "版本資訊、更新與授權。",
        saved_hint: "設定於修改後自動儲存",

        window_title: "設定",
        hotkeys_title: "全域快捷鍵",
        launcher_hotkey_label: "啟動器快捷鍵",
        screenshot_hotkey_label: "截圖快捷鍵",
        delayed_hotkey_label: "延遲截圖快捷鍵",
        appearance_title: "主題",
        theme_label: "主題模式",
        theme_system: "跟隨系統",
        theme_light: "淺色",
        theme_dark: "深色",
        language_title: "語言",
        language_label: "顯示語言",
        language_zh_cn: "简体中文",
        language_zh_tw: "繁體中文",
        language_en_us: "English",
        startup_title: "啟動",
        launch_at_login: "開機自動啟動",
        launcher_title: "啟動器",
        hide_on_blur: "失焦時自動隱藏",
        preserve_search_query: "保留上次搜尋內容",
        max_results: "最多顯示結果數",
        history_boost: "歷史記錄權重",
        plugin_boost: "外掛權重",
        app_boost: "應用程式權重",
        file_boost: "檔案權重",
        favorites_title: "收藏",
        favorites_empty: "尚無收藏",
        favorites_remove: "移除",
        clipboard_history_title: "剪貼簿歷史",
        clipboard_history_clear: "清除歷史",
        about_title: "關於",
        about_license: "介面框架：Slint（Royalty-free 授權，https://slint.dev）",
        about_check: "檢查更新",       // settings.about.check
        about_download: "下載",        // TS 无此键（M5 手动下载钮）
        about_install: "重新啟動安裝", // settings.about.install
        back: "返回",
    };
    let en_us = SettingsUiTexts {
        shortcuts_nav: "Shortcuts",
        general_title: "General",
        data_title: "Data",
        advanced_title: "Advanced search",
        general_description: "Make the launcher work the way you do.",
        hotkeys_description:
            "Open your tools from anywhere. Press Enter or leave the field to save.",
        favorites_description: "Manage pinned apps and favorites in one place.",
        data_description: "Manage clipboard history stored on this device.",
        about_description: "Version, updates and license.",
        saved_hint: "Changes are saved automatically",

        window_title: "Settings",
        hotkeys_title: "Global shortcuts",
        launcher_hotkey_label: "Launcher shortcut",
        screenshot_hotkey_label: "Screenshot shortcut",
        delayed_hotkey_label: "Delayed screenshot shortcut",
        appearance_title: "Theme",
        theme_label: "Theme mode",
        theme_system: "System",
        theme_light: "Light",
        theme_dark: "Dark",
        language_title: "Language",
        language_label: "Display language",
        language_zh_cn: "Simplified Chinese",
        language_zh_tw: "Traditional Chinese",
        language_en_us: "English",
        startup_title: "Startup",
        launch_at_login: "Launch at login",
        launcher_title: "Launcher",
        hide_on_blur: "Hide on focus loss",
        preserve_search_query: "Keep last search text",
        max_results: "Maximum results",
        history_boost: "History weight",
        plugin_boost: "Plugin weight",
        app_boost: "App weight",
        file_boost: "File weight",
        favorites_title: "Favorites",
        favorites_empty: "No favorites",
        favorites_remove: "Remove",
        clipboard_history_title: "Clipboard History",
        clipboard_history_clear: "Clear history",
        about_title: "About",
        about_license: "UI toolkit: Slint (Royalty-free license, https://slint.dev)",
        about_check: "Check for updates",    // settings.about.check
        about_download: "Download",          // TS 无此键（M5 手动下载钮）
        about_install: "Restart to install", // settings.about.install
        back: "Back",
    };
    match language {
        Language::ZhCn => zh_cn,
        Language::ZhTw => zh_tw,
        Language::EnUs => en_us,
    }
}

/// TS `settings.clipboardHistory.clearError` 逐字复用（M4 Task 7 清除历史
/// 失败提示；成功态 TS 不显示任何消息，无需成功文案）。
pub fn clipboard_clear_error(language: Language) -> &'static str {
    match language {
        Language::ZhCn => "无法清空剪贴板历史。",
        Language::ZhTw => "無法清除剪貼簿歷史。",
        Language::EnUs => "Could not clear clipboard history.",
    }
}

/// M5 Task 3 更新文案：`settings.about` 的状态行模板 + `launcher.updateBanner`
/// 的横幅模板（逐字移植；动态 {version}/{percent} 由 Rust
/// `updater_controller::status_text` / `banner_view` 填充）。
///
/// 与 TS 的键差异（均已注明）：TS 发现新版本即自动下载，无"下载"钮与
/// "发现新版本"停留态——`about_available` 为 M5 新键；`about_idle` 的 TS zh
/// 文案提"打开主页后"（en-US 即 "after startup"），按 native 启动即检的语义
/// 取 en-US 语义重写 zh 文案。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateUiTexts {
    /// settings.about.idle。
    pub about_idle: &'static str,
    /// settings.about.checking。
    pub about_checking: &'static str,
    /// 新键：发现新版本 {version}（M5 手动下载停留态）。
    pub about_available: &'static str,
    /// settings.about.downloading（{version} {percent}）。
    pub about_downloading: &'static str,
    /// settings.about.downloaded（{version}）。
    pub about_downloaded: &'static str,
    /// settings.about.upToDate。
    pub about_up_to_date: &'static str,
    /// settings.about.error。
    pub about_error: &'static str,
    /// settings.about.unavailable。
    pub about_unavailable: &'static str,
    /// launcher.updateBanner.checkFailed。
    pub banner_check_failed: &'static str,
    /// launcher.updateBanner.downloading（{version} {percent}）。
    pub banner_downloading: &'static str,
    /// launcher.updateBanner.ready（{version}）。
    pub banner_ready: &'static str,
    /// launcher.updateBanner.error。
    pub banner_error: &'static str,
    /// launcher.updateBanner.install（横幅安装钮）。
    pub banner_install: &'static str,
    /// launcher.updateBanner.openSettings（横幅"查看设置"钮）。
    pub banner_open_settings: &'static str,
}

/// 更新文案表（zh-CN 规范 + zh-TW + en-US；TS i18n.ts settings.about /
/// launcher.updateBanner 逐字，差异键见结构体注释）。
pub fn update_texts(language: Language) -> UpdateUiTexts {
    match language {
        Language::ZhCn => UpdateUiTexts {
            about_idle: "启动后会自动连接 GitHub 检查更新。",
            about_checking: "正在连接 GitHub 检查更新...",
            about_available: "发现新版本 {version}。",
            about_downloading: "正在从 GitHub 下载版本 {version} · {percent}%",
            about_downloaded: "版本 {version} 已下载，重启后安装。",
            about_up_to_date: "已连接 GitHub，当前是最新版本",
            about_error: "无法连接 GitHub 或检查更新失败。",
            about_unavailable: "自动更新仅适用于已安装版本。",
            banner_check_failed: "无法连接 GitHub 检查更新",
            banner_downloading: "正在从 GitHub 下载版本 {version} · {percent}%",
            banner_ready: "新版本 {version} 已下载",
            banner_error: "无法安装更新。",
            banner_install: "立即安装",
            banner_open_settings: "查看设置",
        },
        Language::ZhTw => UpdateUiTexts {
            about_idle: "啟動後會自動連接 GitHub 檢查更新。",
            about_checking: "正在連接 GitHub 檢查更新...",
            about_available: "發現新版本 {version}。",
            about_downloading: "正在從 GitHub 下載版本 {version} · {percent}%",
            about_downloaded: "版本 {version} 已下載，重新啟動後安裝。",
            about_up_to_date: "已連接 GitHub，目前是最新版本",
            about_error: "無法連接 GitHub 或檢查更新失敗。",
            about_unavailable: "自動更新僅適用於已安裝版本。",
            banner_check_failed: "無法連接 GitHub 檢查更新",
            banner_downloading: "正在從 GitHub 下載版本 {version} · {percent}%",
            banner_ready: "新版本 {version} 已下載",
            banner_error: "無法安裝更新。",
            banner_install: "立即安裝",
            banner_open_settings: "查看設定",
        },
        Language::EnUs => UpdateUiTexts {
            about_idle: "The launcher checks GitHub for updates after startup.",
            about_checking: "Connecting to GitHub for updates...",
            about_available: "Version {version} is available.",
            about_downloading: "Downloading version {version} from GitHub · {percent}%",
            about_downloaded: "Version {version} is downloaded. Restart to install.",
            about_up_to_date: "Connected to GitHub. You are up to date",
            about_error: "Could not connect to GitHub or check for updates.",
            about_unavailable: "Automatic updates are available only in installed builds.",
            banner_check_failed: "Could not connect to GitHub for updates",
            banner_downloading: "Downloading version {version} from GitHub · {percent}%",
            banner_ready: "Version {version} is ready",
            banner_error: "Update could not be installed.",
            banner_install: "Install now",
            banner_open_settings: "Open settings",
        },
    }
}

/// TS `formatTemplate` 的等价实现：把 `{key}` 占位符全量替换（未知占位符
/// 原样保留，与 TS reduce-replaceAll 一致）。
pub fn format_template(template: &str, values: &[(&str, &str)]) -> String {
    let mut formatted = template.to_string();
    for (key, value) in values {
        formatted = formatted.replace(&format!("{{{key}}}"), value);
    }
    formatted
}

pub fn home_texts(language: Language) -> HomeUiTexts {
    match language {
        Language::ZhCn => HomeUiTexts {
            keyboard_hint: "方向键 选择    Enter 打开    Esc 隐藏",
            empty_hint: "搜索应用并固定到首页，常用工具将在这里显示。",
            no_results_hint: "未找到匹配项，试试其他关键词。",
            home_action_ocr: "识别文字",

            recent_group: "最近使用",
            pinned_group: "固定",
            pin_app: "固定到首页",
            unpin_app: "取消固定",
            home_actions_label: "首页功能",
            home_action_screenshot: "截图",
            search_label: "搜索",
            search_placeholder: "搜索应用、命令，或输入算式…",
            open_settings: "打开设置",
        },
        Language::ZhTw => HomeUiTexts {
            keyboard_hint: "方向鍵 選取    Enter 開啟    Esc 隱藏",
            empty_hint: "搜尋應用程式並固定到首頁，常用工具將顯示於此。",
            no_results_hint: "未找到符合項目，試試其他關鍵字。",
            home_action_ocr: "辨識文字",

            recent_group: "最近使用",
            pinned_group: "固定",
            pin_app: "固定到首頁",
            unpin_app: "取消固定",
            home_actions_label: "首頁功能",
            home_action_screenshot: "截圖",
            search_label: "搜尋",
            search_placeholder: "搜尋應用程式、指令，或輸入算式…",
            open_settings: "開啟設定",
        },
        Language::EnUs => HomeUiTexts {
            keyboard_hint: "Arrows Select    Enter Open    Esc Hide",
            empty_hint: "Search for an app and pin it here for quick access.",
            no_results_hint: "No matches. Try another search.",
            home_action_ocr: "Recognize text",

            recent_group: "Recent",
            pinned_group: "Pinned",
            pin_app: "Pin to home",
            unpin_app: "Unpin from home",
            home_actions_label: "Home actions",
            home_action_screenshot: "Screenshot",
            search_label: "Search",
            search_placeholder: "Search apps, commands, or calculate…",
            open_settings: "Open settings",
        },
    }
}

/// TS `screenshot.tools` / `screenshot.toolbar` / `screenshot.textPrompt`
/// 逐字复用（zh-CN 规范 + zh-TW + en-US，i18n.ts:104-160 / 432-488 / 752-808）。
pub fn screenshot_texts(language: Language) -> ScreenshotUiTexts {
    let zh_cn = ScreenshotUiTexts {
        tool_rectangle: "矩形",                 // screenshot.tools.rectangle
        tool_ellipse: "椭圆",                   // screenshot.tools.ellipse
        tool_arrow: "箭头",                     // screenshot.tools.arrow
        tool_pen: "画笔",                       // screenshot.tools.pen
        tool_mosaic: "马赛克",                  // screenshot.tools.mosaic
        tool_text: "文字",                      // screenshot.tools.text
        undo: "撤销",                           // screenshot.toolbar.undo
        redo: "重做",                           // screenshot.toolbar.redo
        ocr: "OCR",                             // screenshot.toolbar.ocr
        translate: "翻译",                      // screenshot.toolbar.translate
        pin: "置顶",                            // screenshot.toolbar.pin
        save: "保存",                           // screenshot.toolbar.save
        cancel: "取消",                         // screenshot.toolbar.cancel
        done: "完成",                           // screenshot.toolbar.done
        prompt_placeholder: "文字",             // screenshot.textPrompt.defaultText
        action_failed: "截图操作失败。",        // screenshot.actionFailed
        ocr_recognizing: "正在识别文字...",     // screenshot.ocr.recognizing
        ocr_no_text: "未识别到文字。",          // screenshot.ocr.noText
        ocr_copy_all: "复制全部",               // screenshot.ocr.copyAll
        ocr_failed: "OCR 失败。",               // screenshot.ocr.failed
        translation_source: "原文",             // screenshot.translation.source
        translation_result: "译文",             // screenshot.translation.result
        translation_translating: "正在翻译...", // screenshot.translation.translating
        translation_no_text: "未翻译出文字。",  // screenshot.translation.noText
        translation_failed: "翻译失败。",       // screenshot.translation.failed
        translation_copy: "复制译文",           // screenshot.translation.copy
        translation_online_consent:            // screenshot.translation.onlineConsent
        "翻译会将本次本地 OCR 文字发送到 Google 在线翻译服务（最多 2000 个字符）。是否继续？",
        status_image_saved: "图片已保存。",     // screenshot.status.imageSaved
        status_save_canceled: "已取消保存。",   // screenshot.status.saveCanceled
        status_pinned: "已置顶选区。",          // screenshot.status.pinned
        image_copy: "复制",                     // TS 无此键（M3 置顶窗复制钮）
    };
    let zh_tw = ScreenshotUiTexts {
        tool_rectangle: "矩形",
        tool_ellipse: "橢圓",
        tool_arrow: "箭頭",
        tool_pen: "畫筆",
        tool_mosaic: "馬賽克",
        tool_text: "文字",
        undo: "復原",
        redo: "重做",
        ocr: "OCR",
        translate: "翻譯",
        pin: "置頂",
        save: "儲存",
        cancel: "取消",
        done: "完成",
        prompt_placeholder: "文字",
        action_failed: "截圖操作失敗。",
        ocr_recognizing: "正在辨識文字...",
        ocr_no_text: "未辨識到文字。",
        ocr_copy_all: "複製全部",
        ocr_failed: "OCR 失敗。",
        translation_source: "原文",
        translation_result: "譯文",
        translation_translating: "正在翻譯...",
        translation_no_text: "未翻譯出文字。",
        translation_failed: "翻譯失敗。",
        translation_copy: "複製譯文",
        translation_online_consent: // screenshot.translation.onlineConsent
        "翻譯會將本次本地 OCR 文字傳送到 Google 線上翻譯服務（最多 2000 個字元）。是否繼續？",
        status_image_saved: "圖片已儲存。",
        status_save_canceled: "已取消儲存。",
        status_pinned: "已置頂選取區域。",
        image_copy: "複製",
    };
    let en_us = ScreenshotUiTexts {
        tool_rectangle: "Rectangle",
        tool_ellipse: "Ellipse",
        tool_arrow: "Arrow",
        tool_pen: "Pen",
        tool_mosaic: "Mosaic",
        tool_text: "Text",
        undo: "Undo",
        redo: "Redo",
        ocr: "OCR",
        translate: "Translate",
        pin: "Pin",
        save: "Save",
        cancel: "Cancel",
        done: "Done",
        prompt_placeholder: "Text",
        action_failed: "Screenshot action failed.",
        ocr_recognizing: "Recognizing text...",
        ocr_no_text: "No OCR text found.",
        ocr_copy_all: "Copy All",
        ocr_failed: "OCR failed.",
        translation_source: "Original",
        translation_result: "Translation",
        translation_translating: "Translating...",
        translation_no_text: "No translated text found.",
        translation_failed: "Translation failed.",
        translation_copy: "Copy translation",
        translation_online_consent: // screenshot.translation.onlineConsent
        "Translation sends this locally recognized OCR text to the Google online translation service (up to 2,000 characters). Continue?",
        status_image_saved: "Image saved.",
        status_save_canceled: "Save canceled.",
        status_pinned: "Pinned selection.",
        image_copy: "Copy",
    };
    match language {
        Language::ZhCn => zh_cn,
        Language::ZhTw => zh_tw,
        Language::EnUs => en_us,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zh_cn_settings_title_and_back_match_ts_defaults() {
        // TS zh-CN settings.title / settings.back 逐字复用。
        let texts = settings_texts(Language::ZhCn);
        assert_eq!(texts.window_title, "设置");
        assert_eq!(texts.back, "返回");
        assert_eq!(texts.hotkeys_title, "全局快捷键");
        assert_eq!(texts.launcher_hotkey_label, "启动器快捷键");
        assert_eq!(texts.launch_at_login, "开机自启动");
        assert_eq!(texts.preserve_search_query, "保留上次搜索内容");
        assert_eq!(texts.favorites_empty, "暂无收藏");
        assert_eq!(texts.favorites_remove, "移除");
        assert_eq!(texts.theme_system, "跟随系统");
        assert_eq!(texts.theme_light, "浅色");
        assert_eq!(texts.theme_dark, "深色");
    }

    #[test]
    fn zh_tw_uses_traditional_chinese_from_ts() {
        let texts = settings_texts(Language::ZhTw);
        assert_eq!(texts.window_title, "設定");
        assert_eq!(texts.hotkeys_title, "全域快捷鍵");
        assert_eq!(texts.launch_at_login, "開機自動啟動");
        assert_eq!(texts.theme_system, "跟隨系統");
        assert_eq!(texts.favorites_empty, "尚無收藏");
        assert_eq!(texts.theme_dark, "深色");
    }

    #[test]
    fn en_us_matches_ts_english() {
        let texts = settings_texts(Language::EnUs);
        assert_eq!(texts.window_title, "Settings");
        assert_eq!(texts.hotkeys_title, "Global shortcuts");
        assert_eq!(texts.launch_at_login, "Launch at login");
        assert_eq!(texts.preserve_search_query, "Keep last search text");
        assert_eq!(texts.favorites_remove, "Remove");
    }

    #[test]
    fn every_language_defines_every_field_non_empty() {
        for language in [Language::ZhCn, Language::ZhTw, Language::EnUs] {
            let texts = settings_texts(language);
            let mut values: Vec<&str> = Vec::new();
            // 显式列出字段，确保新增字段不会漏翻译（编译期也保证数量一致）。
            let SettingsUiTexts {
                shortcuts_nav,
                general_title,
                data_title,
                advanced_title,
                general_description,
                hotkeys_description,
                favorites_description,
                data_description,
                about_description,
                saved_hint,
                window_title,
                hotkeys_title,
                launcher_hotkey_label,
                screenshot_hotkey_label,
                delayed_hotkey_label,
                appearance_title,
                theme_label,
                theme_system,
                theme_light,
                theme_dark,
                language_title,
                language_label,
                language_zh_cn,
                language_zh_tw,
                language_en_us,
                startup_title,
                launch_at_login,
                launcher_title,
                hide_on_blur,
                preserve_search_query,
                max_results,
                history_boost,
                plugin_boost,
                app_boost,
                file_boost,
                favorites_title,
                favorites_empty,
                favorites_remove,
                clipboard_history_title,
                clipboard_history_clear,
                about_title,
                about_license,
                about_check,
                about_download,
                about_install,
                back,
            } = texts;
            values.extend([
                shortcuts_nav,
                general_title,
                data_title,
                advanced_title,
                general_description,
                hotkeys_description,
                favorites_description,
                data_description,
                about_description,
                saved_hint,
                window_title,
                hotkeys_title,
                launcher_hotkey_label,
                screenshot_hotkey_label,
                delayed_hotkey_label,
                appearance_title,
                theme_label,
                theme_system,
                theme_light,
                theme_dark,
                language_title,
                language_label,
                language_zh_cn,
                language_zh_tw,
                language_en_us,
                startup_title,
                launch_at_login,
                launcher_title,
                hide_on_blur,
                preserve_search_query,
                max_results,
                history_boost,
                plugin_boost,
                app_boost,
                file_boost,
                favorites_title,
                favorites_empty,
                favorites_remove,
                clipboard_history_title,
                clipboard_history_clear,
                about_title,
                about_license,
                about_check,
                about_download,
                about_install,
                back,
            ]);
            assert!(
                values.iter().all(|value| !value.is_empty()),
                "language {language:?} has an empty string"
            );
        }
    }

    #[test]
    fn home_texts_present_for_all_languages() {
        let zh_cn = home_texts(Language::ZhCn);
        assert_eq!(zh_cn.recent_group, "最近使用");
        assert_eq!(zh_cn.pinned_group, "固定");
        assert_eq!(zh_cn.pin_app, "固定到首页");
        // UI 修复 3：TS i18n.ts:35-39 逐字（homeActionsLabel / homeActions.screenshot）。
        assert_eq!(zh_cn.home_actions_label, "首页功能");
        assert_eq!(zh_cn.home_action_screenshot, "截图");
        // A 方案扩展占位文案，让应用、命令和计算功能更易发现。
        assert_eq!(zh_cn.search_label, "搜索");
        assert_eq!(zh_cn.search_placeholder, "搜索应用、命令，或输入算式…");
        assert_eq!(zh_cn.open_settings, "打开设置");
        let zh_tw = home_texts(Language::ZhTw);
        assert_eq!(zh_tw.recent_group, "最近使用");
        assert_eq!(zh_tw.pin_app, "固定到首頁");
        assert_eq!(zh_tw.home_actions_label, "首頁功能");
        assert_eq!(zh_tw.home_action_screenshot, "截圖");
        assert_eq!(zh_tw.search_label, "搜尋");
        assert_eq!(zh_tw.search_placeholder, "搜尋應用程式、指令，或輸入算式…");
        assert_eq!(zh_tw.open_settings, "開啟設定");
        let en_us = home_texts(Language::EnUs);
        assert_eq!(en_us.recent_group, "Recent");
        assert_eq!(en_us.pinned_group, "Pinned");
        assert_eq!(en_us.pin_app, "Pin to home");
        assert_eq!(en_us.home_actions_label, "Home actions");
        assert_eq!(en_us.home_action_screenshot, "Screenshot");
        assert_eq!(en_us.search_label, "Search");
        assert_eq!(
            en_us.search_placeholder,
            "Search apps, commands, or calculate…"
        );
        assert_eq!(en_us.open_settings, "Open settings");
    }

    #[test]
    fn favorite_kind_labels_match_ts_favorites_kinds() {
        for (language, file, folder) in [
            (Language::ZhCn, "文件", "文件夹"),
            (Language::ZhTw, "檔案", "資料夾"),
            (Language::EnUs, "File", "Folder"),
        ] {
            assert_eq!(
                favorite_kind_label(language, false, FavoriteKind::File),
                file
            );
            assert_eq!(
                favorite_kind_label(language, false, FavoriteKind::Folder),
                folder
            );
            assert_eq!(
                favorite_kind_label(language, false, FavoriteKind::Url),
                "URL"
            );
        }
        assert_eq!(
            favorite_kind_label(Language::ZhCn, true, FavoriteKind::File),
            "应用"
        );
        assert_eq!(
            favorite_kind_label(Language::ZhTw, true, FavoriteKind::File),
            "應用程式"
        );
        assert_eq!(
            favorite_kind_label(Language::EnUs, true, FavoriteKind::File),
            "App"
        );
    }

    #[test]
    fn zh_cn_screenshot_texts_match_ts_verbatim() {
        // TS zh-CN screenshot.tools / toolbar / textPrompt 逐字。
        let texts = screenshot_texts(Language::ZhCn);
        assert_eq!(texts.tool_rectangle, "矩形");
        assert_eq!(texts.tool_ellipse, "椭圆");
        assert_eq!(texts.tool_arrow, "箭头");
        assert_eq!(texts.tool_pen, "画笔");
        assert_eq!(texts.tool_mosaic, "马赛克");
        assert_eq!(texts.tool_text, "文字");
        assert_eq!(texts.undo, "撤销");
        assert_eq!(texts.redo, "重做");
        assert_eq!(texts.ocr, "OCR");
        assert_eq!(texts.translate, "翻译");
        assert_eq!(texts.pin, "置顶");
        assert_eq!(texts.save, "保存");
        assert_eq!(texts.cancel, "取消");
        assert_eq!(texts.done, "完成");
        assert_eq!(texts.prompt_placeholder, "文字");
    }

    #[test]
    fn zh_tw_screenshot_texts_match_ts_verbatim() {
        let texts = screenshot_texts(Language::ZhTw);
        assert_eq!(texts.tool_ellipse, "橢圓");
        assert_eq!(texts.tool_mosaic, "馬賽克");
        assert_eq!(texts.undo, "復原");
        assert_eq!(texts.save, "儲存");
        assert_eq!(texts.pin, "置頂");
        assert_eq!(texts.translate, "翻譯");
        assert_eq!(texts.prompt_placeholder, "文字");
    }

    #[test]
    fn en_us_screenshot_texts_match_ts_verbatim() {
        let texts = screenshot_texts(Language::EnUs);
        assert_eq!(texts.tool_rectangle, "Rectangle");
        assert_eq!(texts.tool_ellipse, "Ellipse");
        assert_eq!(texts.tool_arrow, "Arrow");
        assert_eq!(texts.tool_pen, "Pen");
        assert_eq!(texts.tool_mosaic, "Mosaic");
        assert_eq!(texts.tool_text, "Text");
        assert_eq!(texts.undo, "Undo");
        assert_eq!(texts.redo, "Redo");
        assert_eq!(texts.translate, "Translate");
        assert_eq!(texts.pin, "Pin");
        assert_eq!(texts.save, "Save");
        assert_eq!(texts.cancel, "Cancel");
        assert_eq!(texts.done, "Done");
        assert_eq!(texts.prompt_placeholder, "Text");
    }

    /// M3 Task 8 新增的输出面板/输出窗文案：三语齐备且 TS 键逐字。
    #[test]
    fn screenshot_output_texts_match_ts_sections() {
        for (language, ocr_recognizing, translation_source, status_pinned) in [
            (Language::ZhCn, "正在识别文字...", "原文", "已置顶选区。"),
            (
                Language::ZhTw,
                "正在辨識文字...",
                "原文",
                "已置頂選取區域。",
            ),
            (
                Language::EnUs,
                "Recognizing text...",
                "Original",
                "Pinned selection.",
            ),
        ] {
            let texts = screenshot_texts(language);
            assert_eq!(texts.ocr_recognizing, ocr_recognizing);
            assert_eq!(texts.translation_source, translation_source);
            assert_eq!(texts.status_pinned, status_pinned);
            // 新键全部非空（防新增语言漏译）。
            for value in [
                texts.action_failed,
                texts.ocr_recognizing,
                texts.ocr_no_text,
                texts.ocr_copy_all,
                texts.ocr_failed,
                texts.translation_source,
                texts.translation_result,
                texts.translation_translating,
                texts.translation_no_text,
                texts.translation_failed,
                texts.translation_copy,
                texts.status_image_saved,
                texts.status_save_canceled,
                texts.status_pinned,
                texts.image_copy,
                texts.translation_online_consent,
            ] {
                assert!(!value.is_empty(), "{language:?} has an empty output string");
            }
        }
    }

    /// 评审 Finding 3：在线翻译同意文案逐字移植 TS i18n.ts
    /// `screenshot.translation.onlineConsent`（M3 fail-closed 同意门的消息）。
    #[test]
    fn screenshot_translation_online_consent_matches_ts() {
        let texts = screenshot_texts(Language::ZhCn);
        assert_eq!(
            texts.translation_online_consent,
            "翻译会将本次本地 OCR 文字发送到 Google 在线翻译服务（最多 2000 个字符）。是否继续？"
        );
        let texts = screenshot_texts(Language::ZhTw);
        assert_eq!(
            texts.translation_online_consent,
            "翻譯會將本次本地 OCR 文字傳送到 Google 線上翻譯服務（最多 2000 個字元）。是否繼續？"
        );
        let texts = screenshot_texts(Language::EnUs);
        assert_eq!(
            texts.translation_online_consent,
            "Translation sends this locally recognized OCR text to the Google online translation service (up to 2,000 characters). Continue?"
        );
    }

    /// M5 Task 3：设置 About 分区的更新按钮文案（settings.about.check / install
    /// 逐字；download 为 M5 新键）。
    #[test]
    fn settings_about_update_buttons_match_ts() {
        let (zh_cn, zh_tw, en_us) = (
            settings_texts(Language::ZhCn),
            settings_texts(Language::ZhTw),
            settings_texts(Language::EnUs),
        );
        assert_eq!(zh_cn.about_check, "检查更新");
        assert_eq!(zh_cn.about_install, "重启安装");
        assert_eq!(zh_cn.about_download, "下载");
        assert_eq!(zh_tw.about_check, "檢查更新");
        assert_eq!(zh_tw.about_install, "重新啟動安裝");
        assert_eq!(zh_tw.about_download, "下載");
        assert_eq!(en_us.about_check, "Check for updates");
        assert_eq!(en_us.about_install, "Restart to install");
        assert_eq!(en_us.about_download, "Download");
    }

    /// M5 Task 3：更新状态行 / 横幅文案三语齐备，且 TS settings.about /
    /// launcher.updateBanner 逐字（差异键见 `update_texts` 注释）。
    #[test]
    fn update_texts_cover_all_languages_with_ts_verbatim_strings() {
        for language in [Language::ZhCn, Language::ZhTw, Language::EnUs] {
            let texts = update_texts(language);
            for value in [
                texts.about_idle,
                texts.about_checking,
                texts.about_available,
                texts.about_downloading,
                texts.about_downloaded,
                texts.about_up_to_date,
                texts.about_error,
                texts.about_unavailable,
                texts.banner_check_failed,
                texts.banner_downloading,
                texts.banner_ready,
                texts.banner_error,
                texts.banner_install,
                texts.banner_open_settings,
            ] {
                assert!(!value.is_empty(), "{language:?} has an empty update string");
            }
            // 模板占位符齐备。
            assert!(texts.about_available.contains("{version}"));
            assert!(texts.about_downloading.contains("{version}"));
            assert!(texts.about_downloading.contains("{percent}"));
            assert!(texts.about_downloaded.contains("{version}"));
            assert!(texts.banner_downloading.contains("{version}"));
            assert!(texts.banner_downloading.contains("{percent}"));
            assert!(texts.banner_ready.contains("{version}"));
        }
        let zh_cn = update_texts(Language::ZhCn);
        assert_eq!(
            zh_cn.about_downloading,
            "正在从 GitHub 下载版本 {version} · {percent}%"
        );
        assert_eq!(
            zh_cn.about_downloaded,
            "版本 {version} 已下载，重启后安装。"
        );
        assert_eq!(zh_cn.about_up_to_date, "已连接 GitHub，当前是最新版本");
        assert_eq!(zh_cn.banner_ready, "新版本 {version} 已下载");
        assert_eq!(zh_cn.banner_install, "立即安装");
        assert_eq!(zh_cn.banner_open_settings, "查看设置");
        assert_eq!(zh_cn.banner_check_failed, "无法连接 GitHub 检查更新");
        let en_us = update_texts(Language::EnUs);
        assert_eq!(en_us.about_checking, "Connecting to GitHub for updates...");
        assert_eq!(en_us.banner_install, "Install now");
        assert_eq!(en_us.banner_open_settings, "Open settings");
        // zh-TW 横幅键逐字（审查曾漏检该语言导致“檢視設定”漂移——此处钉死）。
        let zh_tw = update_texts(Language::ZhTw);
        assert_eq!(zh_tw.banner_ready, "新版本 {version} 已下載");
        assert_eq!(zh_tw.banner_install, "立即安裝");
        assert_eq!(zh_tw.banner_open_settings, "查看設定");
        assert_eq!(zh_tw.banner_check_failed, "無法連接 GitHub 檢查更新");
    }

    /// M5 Task 3：TS `formatTemplate` 等价——占位符全量替换、未知占位符保留。
    #[test]
    fn format_template_replaces_named_placeholders() {
        assert_eq!(
            format_template(
                "正在从 GitHub 下载版本 {version} · {percent}%",
                &[("version", "1.2.3"), ("percent", "42"),]
            ),
            "正在从 GitHub 下载版本 1.2.3 · 42%"
        );
        assert_eq!(format_template("no placeholders", &[]), "no placeholders");
        assert_eq!(
            format_template("{missing} stays", &[("version", "1")]),
            "{missing} stays"
        );
        // 同一占位符多次出现全量替换（TS replaceAll 语义）。
        assert_eq!(format_template("{v}/{v}", &[("v", "9")]), "9/9");
    }
}
