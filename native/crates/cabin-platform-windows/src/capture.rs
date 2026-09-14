//! GDI 屏幕捕获：`EnumDisplayMonitors` + `GetMonitorInfoW` 枚举显示器，
//! 选中显示器 `BitBlt` 到内存 DC → `GetDIBits`（自上而下 BGRA）→ 交换为
//! RGBA → image crate PNG 编码。
//!
//! 语义对齐 TS `apps/desktop/src/main/screenshot/screenshotCapture.ts`：
//! `active_point`（逻辑坐标）落在哪个显示器就只捕获该显示器，否则捕获全部；
//! `virtual_bounds` 由选中显示器的逻辑边界经 cabin-core
//! `calculate_capture_bounds` 计算（= TS `calculateVirtualBounds(selected)`）。
//! 纯几何（选择/虚拟边界/缩略尺寸）在 cabin-core 已单测；本模块只补
//! OS 枚举与像素搬运，测试以纯函数单测 + 真机冒烟为主（多显示器布局需要
//! 真实桌面）。
//!
//! 坐标与 DPI 约定：
//! - `GetMonitorInfoW` 的 `rcMonitor` 是虚拟桌面**物理像素**坐标（可为负，
//!   位于主显示器左侧/上方的显示器）；
//! - 每显示器 `GetDpiForMonitor(MDT_EFFECTIVE_DPI)` 取 DPI（Windows 8.1+，
//!   失败回退 96）→ `scale_factor = dpi / 96`，方向：physical = logical ×
//!   scale_factor；
//! - 逻辑边界 = 物理边界 ÷ scale_factor，喂给 cabin-core 几何函数时
//!   `ScreenshotDisplay.id` 用占位值（那些辅助函数从不读 id）；
//! - 捕获的 PNG 尺寸 = 该显示器物理像素尺寸（与 TS desktopCapturer
//!   原生分辨率一致）。
//!
//! 进程 DPI 感知要求：按显示器 v2 感知时 `rcMonitor`/DPI 为真实物理值；
//! 无感知进程拿到的是 DPI 虚拟化后的坐标且 DPI 恒为 96（scale 1.0）——
//! 两种情况下"逻辑 = 物理 ÷ scale"内部自洽，仅分辨率上限不同。生产路径
//! 由 Slint/winit 事件循环在启动时设置 PER_MONITOR_AWARE_V2；测试进程在
//! 冒烟前自行设置（见 tests）。
//!
//! 失败路径：`GetMonitorInfoW` 对单个显示器失败（拔出竞态）只跳过该显示
//! 器，全部失败/零显示器、`BitBlt`/`GetDIBits` 失败、尺寸异常均映射
//! `PlatformError::Capture`。

use std::mem::size_of;

use cabin_core::screenshot::geometry::{
    calculate_capture_bounds, select_displays_for_capture, ScreenshotDisplay,
};
use cabin_core::screenshot::state::{Point, Rect};
use cabin_platform::traits::{CaptureResult, DisplaySnapshot, PlatformError, ScreenshotCapture};
use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};
use windows::core::BOOL;
use windows::Win32::Foundation::{LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
    EnumDisplayMonitors, GetDC, GetDIBits, GetMonitorInfoW, ReleaseDC, SelectObject, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, HMONITOR,
    MONITORINFOEXW, SRCCOPY,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

/// Windows 参考 DPI：scale_factor = dpi / 96（与 Electron `scaleFactor` 同基）。
const BASE_DPI: f64 = 96.0;

/// GDI 截图捕获实现（无状态，可在任意线程调用）。
pub struct GdiScreenshotCapture;

impl Default for GdiScreenshotCapture {
    fn default() -> Self {
        Self
    }
}

impl GdiScreenshotCapture {
    pub fn new() -> Self {
        Self
    }
}

/// 枚举期收集的显示器信息（物理像素 + DPI 缩放）。
struct MonitorInfo {
    /// 虚拟桌面物理像素边界（可为负坐标）。
    rect: RECT,
    scale_factor: f64,
}

impl ScreenshotCapture for GdiScreenshotCapture {
    fn capture_displays(
        &self,
        active_point: Option<Point>,
    ) -> Result<CaptureResult, PlatformError> {
        let monitors = enumerate_monitors()?;
        if monitors.is_empty() {
            return Err(PlatformError::Capture(
                "no displays found (no active desktop session?)".into(),
            ));
        }

        // 物理 → 逻辑；占位 id（几何辅助函数从不读 id，见模块注释）。
        let all_displays: Vec<ScreenshotDisplay> = monitors
            .iter()
            .enumerate()
            .map(|(index, monitor)| ScreenshotDisplay {
                bounds: to_logical_rect(&monitor.rect, monitor.scale_factor),
                // DisplaySnapshot.id 为 u32，枚举顺序即 id 空间。
                id: (index + 1) as i32,
                scale_factor: monitor.scale_factor,
            })
            .collect();

        // TS selectDisplaysForCapture：active_point 命中单显示器或全量。
        let selected = select_displays_for_capture(&all_displays, active_point);

        // selected 是 all_displays 的有序子序列：双指针映射回原始显示器
        // （像素捕获需要物理 rect + HMONITOR，而 ScreenshotDisplay 只有逻辑值）。
        let screen_dc = ScreenDc::acquire()?;
        let mut snapshots = Vec::with_capacity(selected.len());
        let mut cursor = 0usize;
        for display in &selected {
            while cursor < all_displays.len() && &all_displays[cursor] != display {
                cursor += 1;
            }
            let monitor = monitors.get(cursor).ok_or_else(|| {
                PlatformError::Capture("internal: selected display lost from enumeration".into())
            })?;
            let png = capture_monitor_png(&screen_dc, &monitor.rect)?;
            snapshots.push(DisplaySnapshot {
                // 本实现的 id 空间：枚举顺序 1..=n（评审移交：自分配即可）。
                id: (cursor + 1) as u32,
                bounds: display.bounds,
                scale_factor: display.scale_factor,
                png,
            });
            cursor += 1;
        }

        // TS calculateVirtualBounds(selected)：虚拟边界来自**选中**显示器。
        let virtual_bounds = calculate_capture_bounds(&all_displays, active_point);
        Ok(CaptureResult {
            displays: snapshots,
            virtual_bounds,
        })
    }
}

/// EnumDisplayMonitors 枚举所有显示器（hdc=None：整个虚拟桌面，无裁剪）。
fn enumerate_monitors() -> Result<Vec<MonitorInfo>, PlatformError> {
    let mut monitors: Vec<MonitorInfo> = Vec::new();
    let lparam = LPARAM(&mut monitors as *mut Vec<MonitorInfo> as isize);
    // SAFETY: 回调仅通过 lparam 写入本帧的 monitors；EnumDisplayMonitors
    // 同步执行、返回后不再持有指针。
    let ok = unsafe { EnumDisplayMonitors(None, None, Some(enum_monitor_callback), lparam) };
    if !ok.as_bool() {
        return Err(PlatformError::Capture(format!(
            "EnumDisplayMonitors failed (error {})",
            std::io::Error::last_os_error()
        )));
    }
    Ok(monitors)
}

/// 枚举回调：GetMonitorInfoW 失败（显示器拔出竞态）跳过该显示器。
/// SAFETY（前置约定）：lparam 指向有效 `Vec<MonitorInfo>`（见 enumerate_monitors）。
unsafe extern "system" fn enum_monitor_callback(
    hmonitor: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let monitors = &mut *(lparam.0 as *mut Vec<MonitorInfo>);
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    // SAFETY: info 存活至调用结束；hmonitor 来自本次枚举且有效。
    if unsafe { GetMonitorInfoW(hmonitor, &mut info.monitorInfo) }.as_bool() {
        monitors.push(MonitorInfo {
            rect: info.monitorInfo.rcMonitor,
            scale_factor: monitor_scale_factor(hmonitor),
        });
    }
    BOOL::from(true) // 继续枚举
}

/// 每显示器有效 DPI → scale_factor；Windows 8.1 前/查询失败回退 96（scale 1.0）。
fn monitor_scale_factor(hmonitor: HMONITOR) -> f64 {
    let mut dpi_x = 0u32;
    let mut dpi_y = 0u32;
    // SAFETY: 两个有效出参；hmonitor 来自枚举且有效。
    match unsafe { GetDpiForMonitor(hmonitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) } {
        Ok(()) if dpi_x > 0 => dpi_x as f64 / BASE_DPI,
        _ => 1.0,
    }
}

/// 物理像素 RECT → 逻辑 Rect（除以 scale_factor，方向见模块注释）。
fn to_logical_rect(rect: &RECT, scale_factor: f64) -> Rect {
    Rect {
        x: f64::from(rect.left) / scale_factor,
        y: f64::from(rect.top) / scale_factor,
        width: f64::from(rect.right - rect.left) / scale_factor,
        height: f64::from(rect.bottom - rect.top) / scale_factor,
    }
}

/// 校验显示器物理尺寸（拔出竞态下 rcMonitor 可能退化/为负）。
fn checked_extent(rect: &RECT) -> Result<(i32, i32), PlatformError> {
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width <= 0 || height <= 0 {
        return Err(PlatformError::Capture(format!(
            "monitor rect {width}x{height} is empty (display disconnect race?)"
        )));
    }
    Ok((width, height))
}

/// 捕获单个显示器为 PNG（物理像素尺寸）。
fn capture_monitor_png(screen_dc: &ScreenDc, rect: &RECT) -> Result<Vec<u8>, PlatformError> {
    let (width, height) = checked_extent(rect)?;
    let mem_dc = MemoryDc::compatible(screen_dc.hdc())?;
    let bitmap = GdiBitmap::compatible(screen_dc.hdc(), width, height)?;
    // SAFETY: bitmap 新建且未选入任何 DC；保存旧对象以便恢复。
    let old_bitmap = unsafe { SelectObject(mem_dc.hdc(), HGDIOBJ(bitmap.handle().0)) };
    let result = (|| {
        // SAFETY: 全部为有效 DC/尺寸；源坐标为该显示器在虚拟桌面中的
        // 物理位置。CAPTUREBLT 连带分层窗口，对齐桌面整屏语义。
        unsafe {
            BitBlt(
                mem_dc.hdc(),
                0,
                0,
                width,
                height,
                Some(screen_dc.hdc()),
                rect.left,
                rect.top,
                SRCCOPY | CAPTUREBLT,
            )
        }
        .map_err(|e| PlatformError::Capture(format!("BitBlt failed: {e}")))?;

        // GetDIBits 要求位图未被选入 DC：先恢复旧位图再读回。
        // SAFETY: 恢复 SelectObject 保存的旧对象。
        unsafe { SelectObject(mem_dc.hdc(), old_bitmap) };

        let mut buffer = alloc_pixel_buffer(width, height)?;
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        info.bmiHeader.biHeight = -height; // 负高：自上而下（top-down）行序
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB.0;
        let copied = unsafe {
            GetDIBits(
                mem_dc.hdc(),
                bitmap.handle(),
                0,
                height as u32,
                Some(buffer.as_mut_ptr().cast()),
                &mut info,
                DIB_RGB_COLORS,
            )
        };
        if copied != height {
            return Err(PlatformError::Capture(format!(
                "GetDIBits copied {copied} of {height} scanlines (display disconnect race?)"
            )));
        }
        swap_bgra_to_rgba(&mut buffer);
        encode_rgba_png(width as u32, height as u32, &buffer)
    })();
    // 失败路径同样恢复选择（幂等），保证 GdiBitmap::drop 的 DeleteObject 成功。
    // SAFETY: 再次恢复旧对象。
    unsafe { SelectObject(mem_dc.hdc(), old_bitmap) };
    result
}

/// w×h×4 字节像素缓冲（usize 溢出防御）。
fn alloc_pixel_buffer(width: i32, height: i32) -> Result<Vec<u8>, PlatformError> {
    let len = i64::from(width)
        .checked_mul(i64::from(height))
        .and_then(|pixels| pixels.checked_mul(4));
    match len.and_then(|len| usize::try_from(len).ok()) {
        Some(len) => Ok(vec![0u8; len]),
        None => Err(PlatformError::Capture(format!(
            "pixel buffer for {width}x{height} is too large"
        ))),
    }
}

/// GetDIBits 输出为 BGRA：交换 R/B 并强制不透明 alpha（屏幕 DC 不写入
/// alpha，原始值不定；TS desktopCapturer 产物同为不透明）。
fn swap_bgra_to_rgba(bytes: &mut [u8]) {
    for pixel in bytes.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        pixel[3] = 255;
    }
}

fn encode_rgba_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, PlatformError> {
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(rgba, width, height, ExtendedColorType::Rgba8)
        .map_err(|e| PlatformError::Capture(format!("PNG encode failed: {e}")))?;
    Ok(png)
}

/// 屏幕虚拟桌面 DC 守卫（GetDC(None) / ReleaseDC(None, hdc)）。
struct ScreenDc(HDC);

impl ScreenDc {
    fn acquire() -> Result<Self, PlatformError> {
        // SAFETY: hwnd=None 取整个屏幕 DC。
        let hdc = unsafe { GetDC(None) };
        if hdc.is_invalid() {
            return Err(PlatformError::Capture(
                "GetDC(NULL) failed (no desktop?)".into(),
            ));
        }
        Ok(Self(hdc))
    }

    fn hdc(&self) -> HDC {
        self.0
    }
}

impl Drop for ScreenDc {
    fn drop(&mut self) {
        // SAFETY: 与 acquire 中成功的 GetDC 配对。
        let _ = unsafe { ReleaseDC(None, self.0) };
    }
}

/// 兼容内存 DC 守卫。
struct MemoryDc(HDC);

impl MemoryDc {
    fn compatible(source: HDC) -> Result<Self, PlatformError> {
        // SAFETY: source 为有效 DC。
        let hdc = unsafe { CreateCompatibleDC(Some(source)) };
        if hdc.is_invalid() {
            return Err(PlatformError::Capture("CreateCompatibleDC failed".into()));
        }
        Ok(Self(hdc))
    }

    fn hdc(&self) -> HDC {
        self.0
    }
}

impl Drop for MemoryDc {
    fn drop(&mut self) {
        // SAFETY: 与 compatible 中成功的 CreateCompatibleDC 配对。
        let _ = unsafe { DeleteDC(self.0) };
    }
}

/// 兼容位图守卫（析构前调用方必须把选择恢复为旧对象，否则 DeleteObject
/// 因位图仍选入 DC 而失败；capture_monitor_png 已保证）。
struct GdiBitmap(HBITMAP);

impl GdiBitmap {
    fn compatible(source: HDC, width: i32, height: i32) -> Result<Self, PlatformError> {
        // SAFETY: source 为有效 DC；尺寸已经 checked_extent 校验为正。
        let bitmap = unsafe { CreateCompatibleBitmap(source, width, height) };
        if bitmap.is_invalid() {
            return Err(PlatformError::Capture(
                "CreateCompatibleBitmap failed".into(),
            ));
        }
        Ok(Self(bitmap))
    }

    fn handle(&self) -> HBITMAP {
        self.0
    }
}

impl Drop for GdiBitmap {
    fn drop(&mut self) {
        // SAFETY: 位图已从内存 DC 取消选择（见 capture_monitor_png）。
        let _ = unsafe { DeleteObject(HGDIOBJ(self.0 .0)) };
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use windows::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };

    /// 尽力设置按显示器 v2 DPI 感知（进程一次性；已设置/失败时静默忽略）。
    /// 成功后 rcMonitor/DPI 为真实物理值，冒烟断言才有 "物理 ≥ 逻辑" 意义。
    fn enable_per_monitor_dpi() {
        // SAFETY: 进程级一次性设置；返回值无需检查（失败即保持现状）。
        let _ =
            unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    }

    /// 无桌面会话（headless CI）时返回 false 并打印 skip 理由。
    fn skip_without_desktop(error: &PlatformError) -> bool {
        if let PlatformError::Capture(message) = error {
            if message.contains("no displays") || message.contains("GetDC") {
                eprintln!("skip: no desktop session available ({message})");
                return true;
            }
        }
        false
    }

    fn assert_png(bytes: &[u8]) -> image::DynamicImage {
        assert!(!bytes.is_empty());
        assert_eq!(
            &bytes[..4],
            b"\x89PNG",
            "expected PNG magic bytes, got {:?}",
            &bytes[..bytes.len().min(4)]
        );
        image::load_from_memory(bytes).expect("captured PNG should decode")
    }

    #[test]
    fn swaps_bgra_to_opaque_rgba() {
        let mut pixels = vec![
            1, 2, 3, 0, // BGRA → R=3 G=2 B=1 A=255
            255, 128, 0, 7,
        ];
        swap_bgra_to_rgba(&mut pixels);
        assert_eq!(pixels, vec![3, 2, 1, 255, 0, 128, 255, 255]);
    }

    #[test]
    fn logical_rect_divides_physical_by_scale_factor() {
        let rect = RECT {
            left: -1920,
            top: -100,
            right: -960,
            bottom: 940,
        };
        assert_eq!(
            to_logical_rect(&rect, 2.0),
            Rect {
                x: -960.0,
                y: -50.0,
                width: 480.0,
                height: 520.0,
            }
        );
    }

    #[test]
    fn checked_extent_rejects_empty_or_negative_monitor_rects() {
        let ok = RECT {
            left: -100,
            top: 0,
            right: 300,
            bottom: 200,
        };
        assert_eq!(checked_extent(&ok).expect("valid rect"), (400, 200));
        for rect in [
            RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            },
            RECT {
                left: 10,
                top: 10,
                right: 10,
                bottom: 110,
            },
            RECT {
                left: 0,
                top: 100,
                right: 200,
                bottom: 0,
            },
        ] {
            assert!(
                matches!(checked_extent(&rect), Err(PlatformError::Capture(_))),
                "rect {rect:?} must map to Capture"
            );
        }
    }

    #[test]
    fn alloc_pixel_buffer_rejects_overflowing_dimensions() {
        let huge = alloc_pixel_buffer(i32::MAX, i32::MAX);
        assert!(matches!(huge, Err(PlatformError::Capture(_))));
        assert_eq!(
            alloc_pixel_buffer(2, 3).expect("small buffer").len(),
            2 * 3 * 4
        );
    }

    /// 真机冒烟：捕获全部显示器，逐屏校验 PNG 魔数/可解码/尺寸 = 物理
    /// 像素（= round(逻辑 × scale)），virtual_bounds 覆盖全部选中显示器。
    #[test]
    fn captures_all_displays_as_png_on_real_machine() {
        enable_per_monitor_dpi();
        let result = match GdiScreenshotCapture::new().capture_displays(None) {
            Ok(result) => result,
            Err(error) if skip_without_desktop(&error) => return,
            Err(error) => panic!("capture failed: {error}"),
        };

        assert!(!result.displays.is_empty());
        for display in &result.displays {
            assert!(
                display.scale_factor >= 1.0,
                "scale {} < 1",
                display.scale_factor
            );
            let decoded = assert_png(&display.png);
            // PNG 是该显示器的物理像素尺寸：physical = logical × scale（±1 取整）。
            assert!(
                (f64::from(decoded.width()) - display.bounds.width * display.scale_factor).abs()
                    < 1.0,
                "width {} vs logical {} × scale {}",
                decoded.width(),
                display.bounds.width,
                display.scale_factor
            );
            assert!(
                (f64::from(decoded.height()) - display.bounds.height * display.scale_factor).abs()
                    < 1.0,
                "height {} vs logical {} × scale {}",
                decoded.height(),
                display.bounds.height,
                display.scale_factor
            );
            // 非 RGBA 解码（灰度等）不属于本管线产物。
            assert_eq!(decoded.color(), image::ColorType::Rgba8);
        }

        // virtual_bounds = calculateVirtualBounds(全部显示器)（None 时全选）。
        let expected: Vec<ScreenshotDisplay> = result
            .displays
            .iter()
            .enumerate()
            .map(|(index, display)| ScreenshotDisplay {
                bounds: display.bounds,
                id: (index + 1) as i32,
                scale_factor: display.scale_factor,
            })
            .collect();
        assert_eq!(
            result.virtual_bounds,
            cabin_core::screenshot::geometry::calculate_virtual_bounds(&expected)
        );
    }

    /// 真机冒烟：active_point 命中某个显示器时只返回该显示器（TS
    /// selectDisplaysForCapture 语义），且尺寸与全量捕获中的对应项一致。
    #[test]
    fn captures_only_the_display_containing_the_active_point() {
        enable_per_monitor_dpi();
        let capture = GdiScreenshotCapture::new();
        let all = match capture.capture_displays(None) {
            Ok(result) => result,
            Err(error) if skip_without_desktop(&error) => return,
            Err(error) => panic!("capture failed: {error}"),
        };
        let target = &all.displays[0];
        // 显示器中心点必然落在其（半开）边界内。
        let point = Point {
            x: target.bounds.x + target.bounds.width / 2.0,
            y: target.bounds.y + target.bounds.height / 2.0,
        };
        let single = capture
            .capture_displays(Some(point))
            .expect("active-point capture succeeds");
        assert_eq!(single.displays.len(), 1);
        let captured = &single.displays[0];
        assert_eq!(captured.bounds, target.bounds);
        assert_eq!(captured.scale_factor, target.scale_factor);
        assert_eq!(captured.id, target.id);
        assert_png(&captured.png);
        // 虚拟边界只覆盖选中显示器（= 该显示器边界本身）。
        assert_eq!(single.virtual_bounds, captured.bounds);
    }
}
