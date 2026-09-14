//! arboard 剪贴板写入包装：`ImageClipboard`（copy_png / copy_text）与
//! 读取包装：`ClipboardReader`（read_text，M4 Task 3）。
//!
//! COM/apartment 说明（M3 计划要求文档化）：arboard 的 Windows 后端
//! （clipboard-win）直接使用 `OpenClipboard`/`SetClipboardData` 等 Win32
//! 用户态剪贴板 API，**不经 OLE 剪贴板，因此不需要 COM 初始化**
//! （STA/MTA 均不需要），与 icons.rs 的 `ComApartment` 守卫无关。实测
//! arboard 3.6.1 `src/platform/windows.rs`：`Clipboard::new` 持有
//! `clipboard_win::Clipboard`（RAII 打开/关闭剪贴板），无任何
//! `CoInitialize*`/`OleInitialize` 调用。读侧 `Get::text` 走同一打开路径，
//! 同样无需 COM。
//!
//! 图片语义：arboard v3 `ImageData` 即 RGBA（set_image 内部再做
//! RGBA→DIBV5 需要的位序转换并同时写入注册格式 "PNG"），因此这里直接
//! 解码 PNG → RGBA8 → 构造 `ImageData`，无需手工 BGRA 交换。每次写入
//! 新建 `arboard::Clipboard` 实例、用完即弃（与 cabin-app M1 copy-text
//! 先例一致；实例不是 `Sync`，不跨线程共享）。
//!
//! 读侧 `get_text` → `Ok(None)`/`Err` 的映射（依 vendored arboard 3.6.1
//! `src/platform/windows.rs` `Get::text` 逐分支核对）：
//! - `OpenClipboard` 失败 → `Error::ClipboardOccupied` → `Err(Clipboard)`
//!   （TS readText 抛错 → onError 的对应物，环境条件非内容形态）；
//! - 剪贴板无 `CF_UNICODETEXT` 格式（仅图片等非文本内容）→
//!   `Error::ContentNotAvailable` → `Ok(None)`；
//! - `get_string` 读缓冲失败 → `Error::ContentNotAvailable` → `Ok(None)`；
//! - 缓冲非 UTF-8（理论不可达，CF_UNICODETEXT 是 UTF-16 由 Win32 转换）
//!   → `Error::ConversionFailure` → `Err(Clipboard)`。
//! - TS 的 Electron `clipboard.readText()` 对非文本返回 `''`、由 watcher
//!   空值短路跳过；Rust 侧把该情形显式建模为 `Ok(None)`，最终行为一致。

use std::borrow::Cow;

use cabin_platform::traits::{ClipboardReader, ImageClipboard, PlatformError};

/// arboard 实现的剪贴板写入（无状态，可在任意线程调用）。
pub struct ArboardClipboard;

impl Default for ArboardClipboard {
    fn default() -> Self {
        Self
    }
}

impl ArboardClipboard {
    pub fn new() -> Self {
        Self
    }
}

impl ImageClipboard for ArboardClipboard {
    /// 解码 PNG → RGBA8 → arboard ImageData（v3 即 RGBA，无需 BGRA 交换）。
    /// 空/畸形 PNG 属于调用方输入错误 → `PlatformError::Clipboard`；
    /// 剪贴板打开/写入失败同样映射 Clipboard。
    fn copy_png(&self, png: Vec<u8>) -> Result<(), PlatformError> {
        if png.is_empty() {
            return Err(PlatformError::Clipboard("empty PNG payload".into()));
        }
        let decoded = image::load_from_memory(&png)
            .map_err(|e| PlatformError::Clipboard(format!("decode PNG failed: {e}")))?;
        let rgba = decoded.to_rgba8();
        let (width, height) = rgba.dimensions();
        let mut clipboard = open_clipboard()?;
        clipboard
            .set_image(arboard::ImageData {
                width: width as usize,
                height: height as usize,
                bytes: Cow::from(rgba.into_raw()),
            })
            .map_err(|e| PlatformError::Clipboard(format!("set_image failed: {e}")))
    }

    /// 纯文本写入（CF_UNICODETEXT）。空串按原样写入（对齐 TS
    /// `clipboard.writeText(payload.text ?? '')` 的缺省空串语义）。
    fn copy_text(&self, text: String) -> Result<(), PlatformError> {
        let mut clipboard = open_clipboard()?;
        clipboard
            .set_text(text)
            .map_err(|e| PlatformError::Clipboard(format!("set_text failed: {e}")))
    }
}

fn open_clipboard() -> Result<arboard::Clipboard, PlatformError> {
    arboard::Clipboard::new()
        .map_err(|e| PlatformError::Clipboard(format!("open clipboard failed: {e}")))
}

/// arboard 实现的剪贴板纯文本读取（无状态，可在任意线程调用；语义见模块
/// 文档的 get_text 分支映射表）。
pub struct ArboardClipboardReader;

impl Default for ArboardClipboardReader {
    fn default() -> Self {
        Self
    }
}

impl ArboardClipboardReader {
    pub fn new() -> Self {
        Self
    }
}

impl ClipboardReader for ArboardClipboardReader {
    /// 非文本内容（无 CF_UNICODETEXT）→ `Ok(None)`；真·空文本 →
    /// `Ok(Some(""))`。剪贴板被占用等环境性读失败 → `Err(PlatformError::Clipboard)`。
    fn read_text(&self) -> Result<Option<String>, PlatformError> {
        let mut clipboard = open_clipboard()?;
        match clipboard.get_text() {
            Ok(text) => Ok(Some(text)),
            Err(arboard::Error::ContentNotAvailable) => Ok(None),
            Err(error) => Err(PlatformError::Clipboard(format!(
                "read text failed: {error}"
            ))),
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// OpenClipboard 是系统级独占：测试间并行会互相打开失败，用互斥锁串行化。
    static CLIPBOARD_LOCK: Mutex<()> = Mutex::new(());

    /// 无桌面会话（headless CI）或剪贴板被其他进程独占时返回 false 并打印
    /// skip 理由。OpenClipboard 是系统级独占资源：远端桌面/剪贴板管理器/
    /// 并行测试宿主都可能短暂占用，占用电属于环境条件而非代码缺陷。
    fn skip_without_clipboard(error: &PlatformError) -> bool {
        let PlatformError::Clipboard(message) = error else {
            return false;
        };
        if message.contains("open clipboard failed")
            || message.contains("not accessible due to being held by another party")
        {
            eprintln!("skip: clipboard unavailable ({message})");
            return true;
        }
        false
    }

    fn tiny_png(width: u32, height: u32) -> Vec<u8> {
        let mut image = image::RgbaImage::new(width, height);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = image::Rgba([(x * 29 % 256) as u8, (y * 41 % 256) as u8, 7, 255]);
        }
        let mut png = Vec::new();
        image
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("encode tiny png");
        png
    }

    #[test]
    fn copy_text_round_trips_through_the_system_clipboard() {
        let Ok(_guard) = CLIPBOARD_LOCK.lock() else {
            eprintln!("skip: another clipboard test panicked and poisoned the lock");
            return;
        };
        let clipboard = ArboardClipboard::new();
        let payload = "CommandCabin clipboard round-trip: 剪贴板 123 ✓";
        if let Err(error) = clipboard.copy_text(payload.to_string()) {
            if skip_without_clipboard(&error) {
                return;
            }
            panic!("copy_text failed: {error}");
        }
        // 读回打开同样暴露于剪贴板独占（arboard Error::ClipboardOccupied），
        // 与写入一样视为环境条件而 skip。
        let Ok(mut reader) = arboard::Clipboard::new() else {
            eprintln!("skip: clipboard unavailable for read-back");
            return;
        };
        let read_back = reader.get_text().expect("read text back");
        assert_eq!(read_back.as_str(), payload);
    }

    /// 真机冒烟：写入小 PNG 后经 arboard `get_image` 读回。set_image 同时
    /// 写 "PNG" 注册格式与 DIBV5，get_image 优先读 PNG → 精确 RGBA 回读。
    #[test]
    fn copy_png_round_trips_pixels_through_the_system_clipboard() {
        let Ok(_guard) = CLIPBOARD_LOCK.lock() else {
            eprintln!("skip: another clipboard test panicked and poisoned the lock");
            return;
        };
        let clipboard = ArboardClipboard::new();
        let png = tiny_png(8, 6);
        if let Err(error) = clipboard.copy_png(png.clone()) {
            if skip_without_clipboard(&error) {
                return;
            }
            panic!("copy_png failed: {error}");
        }
        // 读回打开同样暴露于剪贴板独占（arboard Error::ClipboardOccupied），
        // 与写入一样视为环境条件而 skip。
        let Ok(mut reader) = arboard::Clipboard::new() else {
            eprintln!("skip: clipboard unavailable for read-back");
            return;
        };
        let Ok(rgba) = reader.get_image() else {
            // 平台不支持 get_image 时按任务要求降级为只断言写入成功。
            eprintln!("limitation: arboard get_image unsupported on this platform");
            return;
        };
        assert_eq!(rgba.width, 8);
        assert_eq!(rgba.height, 6);
        let expected = image::load_from_memory(&png)
            .expect("decode source png")
            .to_rgba8()
            .into_raw();
        assert_eq!(
            rgba.bytes.as_ref(),
            expected.as_slice(),
            "RGBA pixels must round-trip exactly"
        );
    }

    /// 失败注入：空 payload 与非 PNG 字节均映射 Clipboard（不触桌面的纯路径）。
    #[test]
    fn copy_png_rejects_empty_and_garbage_payloads() {
        let clipboard = ArboardClipboard::new();
        assert!(matches!(
            clipboard.copy_png(Vec::new()),
            Err(PlatformError::Clipboard(_))
        ));
        assert!(matches!(
            clipboard.copy_png(vec![1, 2, 3, 4]),
            Err(PlatformError::Clipboard(_))
        ));
        // PNG 头 + 截断 body：解码失败同样映射 Clipboard。
        let truncated = tiny_png(4, 4)[..20].to_vec();
        assert!(matches!(
            clipboard.copy_png(truncated),
            Err(PlatformError::Clipboard(_))
        ));
    }

    /// 读侧冒烟：copy_text 写入后 read_text 读回一致。系统级独占同上，
    /// 写/读失败均先按环境条件 skip。
    #[test]
    fn read_text_round_trips_written_text() {
        let Ok(_guard) = CLIPBOARD_LOCK.lock() else {
            eprintln!("skip: another clipboard test panicked and poisoned the lock");
            return;
        };
        let payload = "CommandCabin clipboard read: 轮询 456 ✓";
        if let Err(error) = ArboardClipboard::new().copy_text(payload.to_string()) {
            if skip_without_clipboard(&error) {
                return;
            }
            panic!("copy_text failed: {error}");
        }
        match ArboardClipboardReader::new().read_text() {
            Ok(text) => assert_eq!(text.as_deref(), Some(payload)),
            Err(error) => {
                if skip_without_clipboard(&error) {
                    return;
                }
                panic!("read_text failed: {error}");
            }
        }
    }

    /// `Ok(None)` 分支：仅图片的剪贴板（set_image 只写 PNG 注册格式与
    /// DIBV5，无 CF_UNICODETEXT）→ ContentNotAvailable → None。
    #[test]
    fn read_text_returns_none_for_image_only_clipboard() {
        let Ok(_guard) = CLIPBOARD_LOCK.lock() else {
            eprintln!("skip: another clipboard test panicked and poisoned the lock");
            return;
        };
        if let Err(error) = ArboardClipboard::new().copy_png(tiny_png(6, 4)) {
            if skip_without_clipboard(&error) {
                return;
            }
            panic!("copy_png failed: {error}");
        }
        match ArboardClipboardReader::new().read_text() {
            Ok(None) => {}
            Ok(Some(text)) => panic!("expected None for image-only clipboard, got {text:?}"),
            Err(error) => {
                if skip_without_clipboard(&error) {
                    return;
                }
                panic!("read_text failed: {error}");
            }
        }
    }

    /// 空文本契约：copy_text("") 后 read_text 绝不报错；Some("") 或 None
    /// （clipboard-win 对空 CF_UNICODETEXT 缓冲的行为未承诺）均可接受，
    /// watcher 对两者同样空值短路跳过。
    #[test]
    fn read_text_never_errors_for_empty_written_text() {
        let Ok(_guard) = CLIPBOARD_LOCK.lock() else {
            eprintln!("skip: another clipboard test panicked and poisoned the lock");
            return;
        };
        if let Err(error) = ArboardClipboard::new().copy_text(String::new()) {
            if skip_without_clipboard(&error) {
                return;
            }
            panic!("copy_text failed: {error}");
        }
        match ArboardClipboardReader::new().read_text() {
            Ok(None) => {}
            Ok(Some(text)) => assert_eq!(text, ""),
            Err(error) => {
                if skip_without_clipboard(&error) {
                    return;
                }
                panic!("read_text failed: {error}");
            }
        }
    }
}
