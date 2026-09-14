//! 保存对话框（M3 Task 8）：`IFileSaveDialog`（png/jpg 过滤器）。
//!
//! TS 基准（index.ts `screenshotController.showSaveDialog`）：标题 "Save screenshot"、
//! 过滤器 PNG Image (*.png) / JPEG Image (*.jpg;*.jpeg)；取消 → `{ canceled: true }`。
//! TS 的 `dialog.showSaveDialog` 由 Electron 托管 COM 套间与消息泵；等价实现为
//! **每次调用一个专职线程 + `CoInitializeEx`(STA)**：`Show` 自泵模态消息循环，
//! 线程阻塞直至用户关闭对话框，结果经通道回传。调用方在事件循环外的工作线程
//! 使用，路径再交回 UI 线程（cabin-app 编排层职责）。
//!
//! 分层规则：Win32 调用只在 cabin-platform-windows（Global Constraints）；扩展名
//! → 格式判定是纯逻辑，归 cabin-app（`state::derive_save_format`）。

use std::path::PathBuf;

use cabin_platform::traits::PlatformError;
use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::Shell::{
    FileSaveDialog, IFileSaveDialog, FOS_OVERWRITEPROMPT, SIGDN_FILESYSPATH,
};

/// TS `showSaveDialog` 的 title + filters（逐字）。
const DIALOG_TITLE: &str = "Save screenshot";
const FILTERS: [(&str, &str); 2] = [("PNG Image", "*.png"), ("JPEG Image", "*.jpg;*.jpeg")];

/// 对话框取消的两种 HRESULT：`HRESULT_FROM_WIN32(ERROR_CANCELLED)`（实际观察值）
/// 与 `E_CANCELLED`（SDK 文档措辞，0x80004140）。
const CANCEL_HRESULTS: [i32; 2] = [0x8007_04C7u32 as i32, 0x8000_4140u32 as i32];

/// 打开保存对话框。`Ok(None)` = 用户取消；`Ok(Some(path))` = 选定路径。
/// 阻塞至对话框关闭（内部 STA 线程，见模块注释）。
pub fn show_image_save_dialog(default_file_name: &str) -> Result<Option<PathBuf>, PlatformError> {
    let default_file_name = default_file_name.to_string();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("screenshot-save-dialog".into())
        .spawn(move || {
            let _ = sender.send(run_dialog_on_sta_thread(&default_file_name));
        })
        .map_err(|error| PlatformError::SaveDialog(format!("spawn dialog thread: {error}")))?;
    receiver
        .recv()
        .map_err(|error| PlatformError::SaveDialog(format!("dialog thread: {error}")))?
}

fn run_dialog_on_sta_thread(default_file_name: &str) -> Result<Option<PathBuf>, PlatformError> {
    let _com = ComApartment::init();
    run_dialog_inner(default_file_name)
}

fn run_dialog_inner(default_file_name: &str) -> Result<Option<PathBuf>, PlatformError> {
    // SAFETY：CoCreateInstance/COM 接口调用按 Win32 契约使用；对话框接口与
    // GetDisplayName 返回的 PWSTR 均为 COM 引用/内存，显式配对释放。
    unsafe {
        let dialog: IFileSaveDialog = CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(dialog_error("CoCreateInstance(FileSaveDialog)"))?;
        // 过滤器字符串须活到 SetFileTypes 调用结束，先建局部再取指针。
        let png_name = HSTRING::from(FILTERS[0].0);
        let png_spec = HSTRING::from(FILTERS[0].1);
        let jpg_name = HSTRING::from(FILTERS[1].0);
        let jpg_spec = HSTRING::from(FILTERS[1].1);
        let filters = [
            COMDLG_FILTERSPEC {
                pszName: PCWSTR(png_name.as_ptr()),
                pszSpec: PCWSTR(png_spec.as_ptr()),
            },
            COMDLG_FILTERSPEC {
                pszName: PCWSTR(jpg_name.as_ptr()),
                pszSpec: PCWSTR(jpg_spec.as_ptr()),
            },
        ];
        dialog
            .SetFileTypes(&filters)
            .map_err(dialog_error("SetFileTypes"))?;
        dialog.SetFileTypeIndex(1).ok(); // 默认 PNG（索引自 1 起）。
        dialog.SetTitle(&HSTRING::from(DIALOG_TITLE)).ok();
        dialog
            .SetFileName(&HSTRING::from(default_file_name))
            .map_err(dialog_error("SetFileName"))?;
        let options = dialog.GetOptions().map_err(dialog_error("GetOptions"))?;
        dialog
            .SetOptions(options | FOS_OVERWRITEPROMPT)
            .map_err(dialog_error("SetOptions"))?;

        if let Err(error) = dialog.Show(Some(HWND::default())) {
            if is_cancel(&error) {
                return Ok(None);
            }
            return Err(dialog_error("Show")(error));
        }
        let item = dialog.GetResult().map_err(dialog_error("GetResult"))?;
        let display = item
            .GetDisplayName(SIGDN_FILESYSPATH)
            .map_err(dialog_error("GetDisplayName"))?;
        let path = display_to_string(display);
        if path.is_empty() {
            return Ok(None);
        }
        Ok(Some(PathBuf::from(path)))
    }
}

/// 用户取消判定（见 [`CANCEL_HRESULTS`]）。
fn is_cancel(error: &windows::core::Error) -> bool {
    let code = error.code().0;
    CANCEL_HRESULTS.contains(&code)
}

// SAFETY: GetDisplayName 返回的 PWSTR 由 COM 分配器分配，读出后须 CoTaskMemFree。
unsafe fn display_to_string(display: PWSTR) -> String {
    let text = display.to_string().unwrap_or_default();
    CoTaskMemFree(Some(display.0.cast()));
    text
}

fn dialog_error(context: &'static str) -> impl Fn(windows::core::Error) -> PlatformError {
    move |error| PlatformError::SaveDialog(format!("{context} failed: {error}"))
}

/// RAII 守卫：仅当 CoInitializeEx 成功（S_OK/S_FALSE）时持有，
/// Drop 时配对 CoUninitialize（与 indexer.rs 的同名守卫同型）。
struct ComApartment;

impl ComApartment {
    fn init() -> Option<Self> {
        // SAFETY: COM 单线程套间初始化；S_OK/S_FALSE 均 is_ok()，均需配对 uninit。
        if unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok() {
            Some(Self)
        } else {
            None
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        // SAFETY: 与 init 中成功的 CoInitializeEx 配对。
        unsafe { CoUninitialize() };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 过滤器常量与标题逐字对齐 TS showSaveDialog（无需真实对话框）。
    #[test]
    fn dialog_constants_match_ts() {
        assert_eq!(DIALOG_TITLE, "Save screenshot");
        assert_eq!(FILTERS[0], ("PNG Image", "*.png"));
        assert_eq!(FILTERS[1], ("JPEG Image", "*.jpg;*.jpeg"));
    }

    /// 取消 HRESULT 判定覆盖两种取消码；非取消错误不误判。
    #[test]
    fn cancel_hresult_is_recognized() {
        let win32_cancelled =
            windows::core::Error::from_hresult(windows::core::HRESULT(CANCEL_HRESULTS[0]));
        let e_cancelled =
            windows::core::Error::from_hresult(windows::core::HRESULT(CANCEL_HRESULTS[1]));
        let other =
            windows::core::Error::from_hresult(windows::core::HRESULT(0x8000_4005u32 as i32)); // E_FAIL
        assert!(is_cancel(&win32_cancelled));
        assert!(is_cancel(&e_cancelled));
        assert!(!is_cancel(&other));
    }
}
