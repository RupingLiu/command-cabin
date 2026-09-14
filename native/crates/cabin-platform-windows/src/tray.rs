//! 系统托盘：托盘图标 + 三项菜单（"显示 CommandCabin" / "设置" / "退出"）。
//! 菜单事件经全局 handler 转入 mpsc 通道，由 `take_events` 一次性取走 receiver。
//! 菜单文案由 app 层按设置语言注入（构造时 `initial_*_text`，运行期经
//! `set_menu_texts` 更新，对齐 TS trayController 的语言切换；三项结构与
//! TS `trayMenuLabels` 的 show/settings/quit 一致）。

use std::sync::mpsc::{channel, Receiver};
use std::sync::Mutex;

use cabin_platform::traits::{PlatformError, TrayEvent, TrayProvider};
use tray_icon::menu::{Menu, MenuEvent, MenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

const MENU_SHOW_ID: &str = "tray.show";
const MENU_SETTINGS_ID: &str = "tray.settings";
const MENU_QUIT_ID: &str = "tray.quit";

pub struct WindowsTray {
    // TrayIcon 必须存活以维持托盘图标；字段永不读取属正常。
    #[allow(dead_code)]
    tray: TrayIcon,
    show_item: MenuItem,
    settings_item: MenuItem,
    quit_item: MenuItem,
    events: Mutex<Option<Receiver<TrayEvent>>>,
}

// SAFETY: TrayIcon 内部为 Rc，未实现 Send。调用方约定：WindowsTray 在主线程
// （Slint 事件循环所在线程）创建、持有并析构；Send 仅用于把所有权移交应用状态，
// 不在其他线程访问。在此约定下 Send 是安全的。
unsafe impl Send for WindowsTray {}

impl WindowsTray {
    /// 必须在主线程（Slint 事件循环所在线程）创建。菜单初始文案由调用方
    /// （app 层按设置语言）传入。
    pub fn new(
        icon_png: &[u8],
        tooltip: &str,
        initial_show_text: &str,
        initial_settings_text: &str,
        initial_quit_text: &str,
    ) -> Result<Self, PlatformError> {
        let (sender, receiver) = channel::<TrayEvent>();

        let show_item = MenuItem::with_id(MENU_SHOW_ID, initial_show_text, true, None);
        let settings_item = MenuItem::with_id(MENU_SETTINGS_ID, initial_settings_text, true, None);
        let quit_item = MenuItem::with_id(MENU_QUIT_ID, initial_quit_text, true, None);
        let menu = Menu::new();
        menu.append_items(&[&show_item, &settings_item, &quit_item])
            .map_err(|e| PlatformError::Tray(e.to_string()))?;

        let image = image::load_from_memory(icon_png)
            .map_err(|e| PlatformError::Tray(e.to_string()))?
            .to_rgba8();
        let (width, height) = image.dimensions();
        let icon = Icon::from_rgba(image.into_raw(), width, height)
            .map_err(|e| PlatformError::Tray(e.to_string()))?;

        MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
            let tray_event = match event.id().0.as_str() {
                MENU_SHOW_ID => TrayEvent::Show,
                MENU_SETTINGS_ID => TrayEvent::Settings,
                MENU_QUIT_ID => TrayEvent::Quit,
                _ => return,
            };
            let _ = sender.send(tray_event);
        }));

        let tray = TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_tooltip(tooltip)
            .with_icon(icon)
            .build()
            .map_err(|e| PlatformError::Tray(e.to_string()))?;

        Ok(Self {
            tray,
            show_item,
            settings_item,
            quit_item,
            events: Mutex::new(Some(receiver)),
        })
    }

    /// 运行期更新菜单文案（设置 language 变更时由 app 层调用；
    /// 对齐 TS trayController 的 `applyLanguage`）。
    pub fn set_menu_texts(&self, show_text: &str, settings_text: &str, quit_text: &str) {
        self.show_item.set_text(show_text);
        self.settings_item.set_text(settings_text);
        self.quit_item.set_text(quit_text);
    }
}

impl TrayProvider for WindowsTray {
    fn take_events(&self) -> Option<Receiver<TrayEvent>> {
        self.events.lock().ok()?.take()
    }
}
