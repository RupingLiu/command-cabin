//! cabin-platform：OS 抽象层。cabin-app 仅通过本 crate 的 trait 访问
//! 全局热键、托盘、单实例、应用索引与启动能力。

pub mod accelerator;
pub mod hotkey_normalize;
pub mod traits;

pub use accelerator::{parse_accelerator, Accelerator, AcceleratorError};
pub use hotkey_normalize::{assert_unique_hotkeys, normalize_hotkey, HotkeyNormalizeError};
pub use traits::*;
