//! 全局热键：`Accelerator`（修饰键 + 小写键名）到 global-hotkey `HotKey` 的映射，
//! 以及基于 `GlobalHotKeyManager` 的注册/分发实现。
//!
//! 事件泵线程在首次 `register` 时启动，收到 `GlobalHotKeyEvent` 后按 hotkey id
//! 查表调用回调；只分发按下事件（`HotKeyState::Pressed`），抬起事件被忽略。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use cabin_platform::accelerator::Accelerator;
use cabin_platform::traits::{GlobalHotkeyProvider, PlatformError};
use global_hotkey::hotkey::{Code, HotKey, Modifiers};
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};

/// 只分发按下事件：global-hotkey 对同一次按键的按下与抬起各发一个事件
/// （`GlobalHotKeyEvent.state`），不过滤会让回调每次按键触发两次。
fn should_dispatch(event: &GlobalHotKeyEvent) -> bool {
    event.state == HotKeyState::Pressed
}

/// 将解析后的 accelerator 映射为 global-hotkey 的 HotKey；不支持的键名报错。
pub fn to_hotkey(accelerator: &Accelerator) -> Result<HotKey, PlatformError> {
    let mut modifiers = Modifiers::empty();
    if accelerator.ctrl {
        modifiers |= Modifiers::CONTROL;
    }
    if accelerator.shift {
        modifiers |= Modifiers::SHIFT;
    }
    if accelerator.alt {
        modifiers |= Modifiers::ALT;
    }
    if accelerator.meta {
        // HotKey::new 内部会把 META 归一为 SUPER。
        modifiers |= Modifiers::META;
    }
    let code = key_code(&accelerator.key)
        .ok_or_else(|| PlatformError::Hotkey(format!("unsupported key \"{}\"", accelerator.key)))?;
    Ok(HotKey::new(Some(modifiers), code))
}

fn key_code(key: &str) -> Option<Code> {
    Some(match key {
        "space" => Code::Space,
        "enter" | "return" => Code::Enter,
        "tab" => Code::Tab,
        "escape" | "esc" => Code::Escape,
        "backspace" => Code::Backspace,
        "delete" => Code::Delete,
        "home" => Code::Home,
        "end" => Code::End,
        "pageup" => Code::PageUp,
        "pagedown" => Code::PageDown,
        "up" => Code::ArrowUp,
        "down" => Code::ArrowDown,
        "left" => Code::ArrowLeft,
        "right" => Code::ArrowRight,
        "f1" => Code::F1,
        "f2" => Code::F2,
        "f3" => Code::F3,
        "f4" => Code::F4,
        "f5" => Code::F5,
        "f6" => Code::F6,
        "f7" => Code::F7,
        "f8" => Code::F8,
        "f9" => Code::F9,
        "f10" => Code::F10,
        "f11" => Code::F11,
        "f12" => Code::F12,
        k if k.len() == 1 => {
            let c = k.chars().next()?;
            match c {
                'a'..='z' => letter_code(c),
                '0'..='9' => digit_code(c),
                _ => return None,
            }
        }
        _ => return None,
    })
}

fn letter_code(c: char) -> Code {
    match c {
        'a' => Code::KeyA,
        'b' => Code::KeyB,
        'c' => Code::KeyC,
        'd' => Code::KeyD,
        'e' => Code::KeyE,
        'f' => Code::KeyF,
        'g' => Code::KeyG,
        'h' => Code::KeyH,
        'i' => Code::KeyI,
        'j' => Code::KeyJ,
        'k' => Code::KeyK,
        'l' => Code::KeyL,
        'm' => Code::KeyM,
        'n' => Code::KeyN,
        'o' => Code::KeyO,
        'p' => Code::KeyP,
        'q' => Code::KeyQ,
        'r' => Code::KeyR,
        's' => Code::KeyS,
        't' => Code::KeyT,
        'u' => Code::KeyU,
        'v' => Code::KeyV,
        'w' => Code::KeyW,
        'x' => Code::KeyX,
        'y' => Code::KeyY,
        'z' => Code::KeyZ,
        _ => unreachable!(),
    }
}

fn digit_code(c: char) -> Code {
    match c {
        '0' => Code::Digit0,
        '1' => Code::Digit1,
        '2' => Code::Digit2,
        '3' => Code::Digit3,
        '4' => Code::Digit4,
        '5' => Code::Digit5,
        '6' => Code::Digit6,
        '7' => Code::Digit7,
        '8' => Code::Digit8,
        '9' => Code::Digit9,
        _ => unreachable!(),
    }
}

/// 已注册热键表：hotkey id -> (HotKey, 回调)。保留 HotKey 是因为
/// `GlobalHotKeyManager::unregister_all` 需要传入待注销的热键列表。
type HandlerMap = Arc<Mutex<HashMap<u32, (HotKey, Box<dyn Fn() + Send + 'static>)>>>;

pub struct WindowsHotkeys {
    manager: GlobalHotKeyManager,
    handlers: HandlerMap,
    pump_started: AtomicBool,
}

// SAFETY: GlobalHotKeyManager 在 Windows 上持有一个隐藏 HWND，未实现 Send。
// 其 register/unregister 通过 Win32 RegisterHotKey/UnregisterHotKey 完成，
// 可从任意线程调用；handlers 由 Mutex 保护，泵线程仅读表。因此 Send 是安全的。
unsafe impl Send for WindowsHotkeys {}

impl WindowsHotkeys {
    pub fn new() -> Result<Self, PlatformError> {
        let manager =
            GlobalHotKeyManager::new().map_err(|e| PlatformError::Hotkey(e.to_string()))?;
        Ok(Self {
            manager,
            handlers: Arc::new(Mutex::new(HashMap::new())),
            pump_started: AtomicBool::new(false),
        })
    }

    fn start_pump(&self) {
        if self.pump_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let handlers = Arc::clone(&self.handlers);
        std::thread::spawn(move || {
            let receiver = GlobalHotKeyEvent::receiver();
            loop {
                if let Ok(event) = receiver.recv() {
                    if !should_dispatch(&event) {
                        continue;
                    }
                    if let Ok(map) = handlers.lock() {
                        if let Some((_, callback)) = map.get(&event.id) {
                            callback();
                        }
                    }
                }
            }
        });
    }
}

impl GlobalHotkeyProvider for WindowsHotkeys {
    fn register(
        &self,
        accelerator: &Accelerator,
        handler: Box<dyn Fn() + Send + 'static>,
    ) -> Result<(), PlatformError> {
        self.start_pump();
        let hotkey = to_hotkey(accelerator)?;
        self.manager
            .register(hotkey)
            .map_err(|e| PlatformError::Hotkey(e.to_string()))?;
        self.handlers
            .lock()
            .map_err(|e| PlatformError::Hotkey(e.to_string()))?
            .insert(hotkey.id(), (hotkey, handler));
        Ok(())
    }

    fn unregister(&self, accelerator: &Accelerator) -> Result<(), PlatformError> {
        let hotkey = to_hotkey(accelerator)?;
        self.manager
            .unregister(hotkey)
            .map_err(|e| PlatformError::Hotkey(e.to_string()))?;
        self.handlers
            .lock()
            .map_err(|e| PlatformError::Hotkey(e.to_string()))?
            .remove(&hotkey.id());
        Ok(())
    }

    fn unregister_all(&self) -> Result<(), PlatformError> {
        let mut map = self
            .handlers
            .lock()
            .map_err(|e| PlatformError::Hotkey(e.to_string()))?;
        let hotkeys: Vec<HotKey> = map.values().map(|(hotkey, _)| *hotkey).collect();
        if !hotkeys.is_empty() {
            self.manager
                .unregister_all(&hotkeys)
                .map_err(|e| PlatformError::Hotkey(e.to_string()))?;
        }
        map.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cabin_platform::parse_accelerator;

    #[test]
    fn maps_letters_digits_function_and_space_keys() {
        let hotkey = |input: &str| to_hotkey(&parse_accelerator(input).unwrap()).unwrap();
        assert_eq!(hotkey("Alt+Space").key, Code::Space);
        assert_eq!(hotkey("Ctrl+K").key, Code::KeyK);
        assert_eq!(hotkey("Ctrl+5").key, Code::Digit5);
        assert_eq!(hotkey("Ctrl+F5").key, Code::F5);
    }

    #[test]
    fn modifier_flags_map() {
        let hotkey = to_hotkey(&parse_accelerator("Ctrl+Shift+K").unwrap()).unwrap();
        let mods = hotkey.mods;
        assert!(mods.contains(Modifiers::CONTROL | Modifiers::SHIFT));
        assert!(!mods.contains(Modifiers::ALT));
    }

    #[test]
    fn unsupported_key_reports_error() {
        let err = to_hotkey(&parse_accelerator("Ctrl+MediaPlay").unwrap()).unwrap_err();
        assert!(matches!(err, PlatformError::Hotkey(_)));
    }

    #[test]
    fn only_pressed_events_are_dispatched() {
        let event = |state| GlobalHotKeyEvent { id: 1, state };
        assert!(should_dispatch(&event(HotKeyState::Pressed)));
        assert!(!should_dispatch(&event(HotKeyState::Released)));
    }
}
