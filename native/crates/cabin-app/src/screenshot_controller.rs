//! 截图覆盖窗口控制器（M3 Task 7/8）：Slint UI ↔ cabin-core 状态机的桥 +
//! 输出动作编排（复制/保存/OCR/翻译/置顶）。
//!
//! 职责边界：
//! - **全部状态逻辑在 cabin-core**（`screenshot::state` reducer）：本模块无状态
//!   判断，只把 Slint 回调翻译成 [`ScreenshotAction`] 派发，再把新状态投影回
//!   Slint 属性/模型。所有 reducer 访问都在 UI 线程（Slint 回调与
//!   `invoke_from_event_loop` 闭包内）；`Mutex` 仅为满足 `Arc` 跨闭包共享
//!   （与 main.rs `AppState` 同一约定）。
//! - worker 线程通过 GDI 读取物理像素并准备可供显示与裁剪的共享位图，经
//!   `invoke_from_event_loop` 交回 UI 线程建会话。隐藏自身窗口后：延时模式
//!   睡模式延时（3000/5000ms），即时模式在确有窗口被隐藏时睡 16ms 捕获面
//!   稳定延迟（TS `defaultCaptureSurfaceSettleMs`，screenshotController.ts:136）。
//! - 指针/键盘语义对齐 TS `ScreenshotOverlay.tsx`：
//!   - 宿主契约（Task 1 评审移交）：**文本提示挂起时，指针按下先派发
//!     `CommitText` 再处理指针**（TS `getPendingTextPointerAction` 语义）。
//!     工具/样式按钮点击同样先提交（TS 按钮 blur → commit 的净效果）。
//!   - TS 文本提示的 220ms 防抖（`createPendingTextAnnotationController`）在
//!     此改为同步打开提示（任务简报授权的差异，报告已注明）。
//!   - 全局键盘只有 Esc（取消）与 Enter（ready 时完成），对齐
//!     `getScreenshotGlobalKeyboardAction`；TS 无工具/撤销重做快捷键。
//!   - 双击 → 完成；TS `event.detail > 1` 的拖拽抑制以 500ms/4px 双击时间窗
//!     等价实现（Slint pointer-event 不携带 click count）。
//! - **输出动作（M3 Task 8）**，对齐 TS finish/runOutputAction：
//!   - 完成选区时按启动模式复制、识别文字或请求翻译。
//!   - 单次仅允许一个输出操作（TS outputOperationBusyRef）：操作期间指针与
//!     输出动作/完成入口全部短路；Esc 取消不受限（TS 同）。
//!   - 保存：IFileSaveDialog（cabin-platform-windows::save_dialog，png/jpg
//!     过滤器 + 默认文件名 `CommandCabin-YYYYMMDD-HHMMSS.png`）→ 按扩展名
//!     判定格式（TS deriveSaveFormatFromPath）→ 写文件；取消不关会话。
//!   - OCR：按界面语言在 worker 线程识别，结果回 UI 线程面板；复制全部写入剪贴板。
//!   - 翻译：在本机识别中英文，Google 自动检测原文语言，译文覆盖在选区。
//!   - 置顶：合成选区图在独立置顶小窗展示（TS PinnedImageView 简化：
//!     可拖 + 保存/复制/关闭按钮）。
//! - 置顶窗的所有权：`thread_local` 注册表持有强句柄（窗口只能在 UI
//!   线程创建/使用，thread_local 规避控制器 `Send` 约束；槽位只置空不移除，
//!   关闭回调经创建时捕获的下标回收）。
//!
//! 渲染：栅格工具（矩形/椭圆/箭头/画笔/马赛克）按 TS `composeScreenshotSelection`
//! 的约定整层重绘进设备像素缓冲（`output_scale` = 会话显示器的最大 DPI 缩放，
//! 马赛克块 parity 依赖它）；缓冲以**选区底图 + 已提交标注**为快照，草稿在快照
//! 副本上绘制，pointer-move 重绘节流至 ≥30fps。文字标注不烧缓冲，以 Slint Text
//! 元素矢量叠加（Task 2 决策）；导出走 Task 3 `compose_export` 的二次矢量绘制。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cabin_core::command::types::{
    Command, CommandAction, CommandActionType, CommandPayload, CommandSource,
};
use cabin_core::screenshot::{
    compose_export, draw_annotation, initial_state, is_non_empty_rect, jpeg_encode_rgba,
    png_encode_rgba, reducer, Annotation, AnnotationStyle, Point, Rect, RgbaImage,
    ScreenshotAction, ScreenshotDisplay, ScreenshotState, Tool, TranslationOutcome,
    TranslationStatus, NO_OCR_TEXT_MESSAGE,
};
use cabin_core::settings::Language;
use cabin_platform::traits::{CapturedFrame, ImageClipboard, ScreenshotCapture};
use cabin_platform_windows::capture::GdiScreenshotCapture;
use cabin_platform_windows::clipboard::ArboardClipboard;
use cabin_platform_windows::ocr::{run_ocr, OcrOutcome, OcrStatus};
use cabin_platform_windows::save_dialog::show_image_save_dialog;
use cabin_platform_windows::translate::run_online_translate;
use slint::winit_030::WinitWindowAccessor;
use slint::{ComponentHandle, Image, ModelRc, SharedString, VecModel, Weak};

use crate::i18n::{self, ScreenshotUiTexts};
use crate::state::{
    derive_save_format_from_path, language_index, save_file_name_now, translation_ocr_languages,
    ui_language_tag,
};
use crate::ui_pin::PinWindow;
use crate::ui_screenshot::{ScreenshotDisplayImage, ScreenshotTextAnnotation, ScreenshotWindow};
use cabin_core::screenshot::encode::translation_overlay;

/// 工具栏固定宽度（须与 screenshot.slint 工具栏容器 width=520px 同步）。
pub const TOOLBAR_WIDTH: f64 = 520.0;
/// 工具栏固定高度（须与 screenshot.slint 工具栏容器 height=122px 同步）。
pub const TOOLBAR_HEIGHT: f64 = 122.0;
/// TS `screenshotToolbarGap`。
const TOOLBAR_GAP: f64 = 12.0;
/// 双击判定窗口（Windows 默认 500ms / 4px；Slint 无 click count，等价实现）。
const DOUBLE_CLICK_TIME: Duration = Duration::from_millis(500);
const DOUBLE_CLICK_SLOP: f64 = 4.0;
/// 草稿层重绘节流间隔（≥30fps 目标；提交/撤销等结构变化不受节流）。
const LIVE_RENDER_MIN_INTERVAL: Duration = Duration::from_millis(16);
/// TS `defaultCaptureSurfaceSettleMs`（screenshotController.ts:136）：隐藏自身
/// 窗口后、即时模式捕获前的稳定延迟（仅当确有窗口被隐藏时插入）。
const CAPTURE_SURFACE_SETTLE_MS: u64 = 16;
/// 色板字符串解析失败时文字标注的回退色（TS 默认 `#ff3355`）。
const FALLBACK_RGB: [u8; 3] = [0xff, 0x33, 0x55];
/// 置顶图窗的图像逻辑尺寸上限（M3 简化：等比缩放到该框内；TS PinnedImageView
/// 以窗口承载原始尺寸图——窗口过大时等比缩小为授权内差异）。
const PIN_WINDOW_MAX_WIDTH: f64 = 320.0;
const PIN_WINDOW_MAX_HEIGHT: f64 = 240.0;
/// 置顶窗在虚拟桌面右上角的落位边距。
const FLOATING_WINDOW_MARGIN: f64 = 16.0;

/// 截图启动模式（TS screenshotController 的模式名子集；延时常量逐字）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenshotMode {
    /// `capture`：立即捕获。
    Capture,
    /// `capture-delay-3`：3000ms 后捕获（TS controller:131）。
    CaptureDelay3,
    /// `capture-delay-5`：5000ms 后捕获（TS controller:132）。
    /// 入口 = 启动器系统命令 `system.screenshot.capture-delay-5`（Task 9 接线）。
    CaptureDelay5,
    /// `ocr`：完成出口为 OCR 而非复制（TS `getScreenshotCompletionAction`）。
    /// 入口 = 启动器系统命令 `system.screenshot.ocr`（Task 9 接线）；完成出口
    /// 语义（OCR 面板 + 会话保持）与 on_ocr 共享同一路径。
    Ocr,
    /// 完成选区时翻译为工具栏所选语言。
    Translate,
}

impl ScreenshotMode {
    /// 捕获前的延时毫秒数（worker 线程睡眠，语义对齐 TS 延时模式）。
    pub fn delay_ms(self) -> Option<u64> {
        match self {
            ScreenshotMode::Capture | ScreenshotMode::Ocr | ScreenshotMode::Translate => None,
            ScreenshotMode::CaptureDelay3 => Some(3000),
            ScreenshotMode::CaptureDelay5 => Some(5000),
        }
    }
}

/// TS index.ts:362 `modeByCommand`：截图系统命令 payload（`screenshot.*`）→
/// 截图启动模式。未知命令返回 `None`（TS 抛
/// `Unsupported screenshot command`，调用方转为执行失败）。
pub fn screenshot_mode_for_system_command(command: &str) -> Option<ScreenshotMode> {
    match command {
        "screenshot.capture" => Some(ScreenshotMode::Capture),
        "screenshot.capture-delay-3" => Some(ScreenshotMode::CaptureDelay3),
        "screenshot.capture-delay-5" => Some(ScreenshotMode::CaptureDelay5),
        "screenshot.ocr" => Some(ScreenshotMode::Ocr),
        "screenshot.translate" => Some(ScreenshotMode::Translate),
        _ => None,
    }
}

/// 单条截图系统命令的构造（source=system / run-system；payload 仅 `command`）。
fn screenshot_system_command(
    id: &str,
    title: &str,
    subtitle: &str,
    keywords: &[&str],
    payload_command: &str,
) -> Command {
    let mut payload = CommandPayload::new();
    payload.insert(
        "command".to_string(),
        serde_json::Value::String(payload_command.to_string()),
    );
    Command {
        id: id.to_string(),
        source: CommandSource::System,
        title: title.to_string(),
        subtitle: Some(subtitle.to_string()),
        keywords: keywords.iter().map(|keyword| keyword.to_string()).collect(),
        icon: None,
        plugin_id: None,
        action: CommandAction {
            action_type: CommandActionType::RunSystem,
            payload,
        },
    }
}

/// 截图、延时截图、OCR 与翻译命令。关键词支持中英文搜索。
pub fn screenshot_system_commands() -> Vec<Command> {
    vec![
        screenshot_system_command(
            "system.screenshot.capture",
            "Capture Screenshot",
            "Select an area to capture",
            &["screenshot", "capture", "screen capture", "截图", "截圖"],
            "screenshot.capture",
        ),
        screenshot_system_command(
            "system.screenshot.capture-delay-3",
            "Capture Screenshot in 3 Seconds",
            "Start a delayed screenshot capture",
            &[
                "screenshot",
                "capture",
                "delay",
                "3 seconds",
                "延时截图",
                "延遲截圖",
            ],
            "screenshot.capture-delay-3",
        ),
        screenshot_system_command(
            "system.screenshot.capture-delay-5",
            "Capture Screenshot in 5 Seconds",
            "Start a delayed screenshot capture",
            &[
                "screenshot",
                "capture",
                "delay",
                "5 seconds",
                "延时截图",
                "延遲截圖",
            ],
            "screenshot.capture-delay-5",
        ),
        screenshot_system_command(
            "system.screenshot.ocr",
            "Recognize Text from Screenshot",
            "Capture an area and run OCR",
            &[
                "screenshot",
                "ocr",
                "text recognition",
                "截图",
                "截圖",
                "文字识别",
                "文字辨識",
                "OCR",
            ],
            "screenshot.ocr",
        ),
        screenshot_system_command(
            "system.screenshot.translate",
            "Translate Screenshot",
            "Select an area and choose the translation language",
            &[
                "screenshot translation",
                "translate",
                "截图翻译",
                "截圖翻譯",
                "翻译",
                "翻譯",
            ],
            "screenshot.translate",
        ),
    ]
}

/// 显示与裁剪共享同一块物理像素缓冲。
pub struct SessionDisplay {
    pub rgba: slint::SharedPixelBuffer<slint::Rgba8Pixel>,
    pub bounds: Rect,
    pub scale_factor: f64,
}

/// 一次捕获的会话数据（UI 线程独占；worker 只投递准备好的位图）。
struct Session {
    displays: Vec<SessionDisplay>,
    virtual_bounds: Rect,
    mode: ScreenshotMode,
    /// Dropping the session invalidates outstanding translations.
    lifetime: Arc<()>,
    /// 选区底图（选区本地设备像素；TS `composeScreenshotSelection` 的底图 pass）。
    base: RgbaImage,
    /// `base` 对应的选区（比较失效，`ensure_buffers` 重建）。
    base_selection: Rect,
    /// 底图 + 已提交栅格标注的快照（标注集合变化即失效重建）。
    committed: RgbaImage,
    committed_valid: bool,
}

/// 进行中的指针手势（TS dragMode + dragStartRef）。
#[derive(Debug, Clone, Copy, PartialEq)]
enum DragMode {
    None,
    Selection,
    Annotation { start: Point },
}

struct ControllerInner {
    state: ScreenshotState,
    session: Option<Session>,
    drag: DragMode,
    /// 上一次指针按下（双击判定输入）。
    last_pointer_down: Option<(Instant, Point)>,
    /// 当前按下是否为双击的第二次按下（TS `event.detail > 1` 抑制拖拽）。
    suppress_drag: bool,
    /// 草稿层上次推送时刻（节流）。
    last_layer_push: Option<Instant>,
    /// 节流窗口内被跳过的层推送（结构变化 / pointer-up 强制补推）。
    layer_push_pending: bool,
    /// 标注层当前是否为"空图"状态（避免重复推空图）。
    layer_empty: bool,
    /// 输出操作进行中（TS outputOperationBusyRef）：导出/复制/保存对话框/
    /// OCR/翻译任一在途即置位；期间指针、输出按钮与完成入口短路。
    output_busy: bool,
    /// UI 语言（设置语言）：OCR/翻译语言映射与输出窗文案的来源；设置变更经
    /// [`ScreenshotController::set_language`] 热切换。
    language: Language,
    translation_target: Option<Language>,
}

/// 跨线程共享的控制器。所有可变状态只在 UI 线程触达；`session_active`
/// 原子量供 hideOnBlur 轮询与热键重入检查无锁读取。
pub struct ScreenshotController {
    window: Weak<ScreenshotWindow>,
    inner: Mutex<ControllerInner>,
    session_active: Arc<AtomicBool>,
    /// 捕获前隐藏启动器/设置窗口（对齐 TS hideLauncherWindowsForScreenshot）；
    /// 返回是否确有窗口被隐藏（TS launcherWasHidden，决定 16ms 捕获面稳定延迟）。
    hide_windows: Box<dyn Fn() -> bool + Send + Sync>,
    /// 会话结束时恢复启动器/设置窗口。
    restore_windows: Box<dyn Fn() + Send + Sync>,
}

impl ScreenshotController {
    pub fn new(
        window: Weak<ScreenshotWindow>,
        hide_windows: Box<dyn Fn() -> bool + Send + Sync>,
        restore_windows: Box<dyn Fn() + Send + Sync>,
    ) -> Arc<Self> {
        Arc::new(Self {
            window,
            inner: Mutex::new(ControllerInner {
                state: initial_state(),
                session: None,
                drag: DragMode::None,
                last_pointer_down: None,
                suppress_drag: false,
                last_layer_push: None,
                layer_push_pending: false,
                layer_empty: true,
                output_busy: false,
                language: Language::ZhCn,
                translation_target: None,
            }),
            session_active: Arc::new(AtomicBool::new(false)),
            hide_windows,
            restore_windows,
        })
    }

    /// hideOnBlur 轮询/热键重入的会话活跃标记（无锁）。
    pub fn is_session_active(&self) -> bool {
        self.session_active.load(Ordering::SeqCst)
    }

    /// 设置语言热切换（main.rs 设置流调用）：更新会话内语言与已打开的
    /// 置顶窗文案。
    pub fn set_language(&self, language: Language) {
        let mut inner = self.inner.lock().unwrap();
        inner.language = language;
        if let Some(window) = self.window.upgrade() {
            window.set_target_language_choice(language_index(
                inner.translation_target.unwrap_or(language),
            ) as i32);
        }
        drop(inner);
        let texts = i18n::screenshot_texts(language);
        with_each_pin_window(|window| push_pin_texts(window, &texts));
    }

    pub fn set_translation_target(self: &Arc<Self>, choice: Option<Language>) {
        let Some(window) = self.window.upgrade() else {
            return;
        };
        let mut inner = self.inner.lock().unwrap();
        let previous = inner.translation_target.unwrap_or(inner.language);
        inner.translation_target = choice;
        let target = choice.unwrap_or(inner.language);
        window.set_target_language_choice(language_index(target) as i32);
        if previous == target || inner.session.is_none() {
            return;
        }
        let before = inner.state.clone();
        inner
            .state
            .redo_annotations
            .retain(|a| a.tool != Tool::Translation);
        let retranslate = translated_text(&inner.state).is_some();
        sync_after_dispatch(&window, &mut inner, &before);
        drop(inner);
        if retranslate {
            self.on_translate();
        }
    }

    /// 启动截图会话（TS screenshotController.start）：隐藏自身窗口 → worker
    /// 线程（延时 / 捕获面稳定延迟 →）GDI 捕获并准备共享位图 → UI 线程建会话并
    /// 显示覆盖窗口。已有会话时拒绝（TS 'Screenshot capture is already active
    /// or starting.'）。
    pub fn start_capture(self: &Arc<Self>, mode: ScreenshotMode) {
        if self
            .session_active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            eprintln!("CommandCabin: screenshot capture is already active or starting");
            return;
        }
        // TS 顺序：ensureOverlayWindow（Rust 窗口常驻，无操作）→ hideLauncher
        // → 模式延时 / 捕获面稳定 → captureDisplays。
        let was_hidden = (self.hide_windows)();
        let controller = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("screenshot-capture".into())
            .spawn(move || {
                if let Some(delay) = mode.delay_ms() {
                    std::thread::sleep(Duration::from_millis(delay));
                } else if was_hidden {
                    std::thread::sleep(Duration::from_millis(CAPTURE_SURFACE_SETTLE_MS));
                }
                let payload = GdiScreenshotCapture::new()
                    .capture_frames(None)
                    .map(|capture| {
                        capture
                            .displays
                            .into_iter()
                            .map(SessionDisplay::from)
                            .collect::<Vec<_>>()
                    });
                let _ = slint::invoke_from_event_loop(move || match payload {
                    Ok(displays) if !displays.is_empty() => controller.on_captured(mode, displays),
                    Ok(_) => controller.abort_with_error("screenshot capture produced no displays"),
                    Err(error) => {
                        controller.abort_with_error(&format!("screenshot capture failed: {error}"))
                    }
                });
            });
        if let Err(error) = spawned {
            // 线程创建失败：复位活跃标记并恢复窗口（会话从未开始）。
            eprintln!("CommandCabin: screenshot capture thread failed to spawn: {error}");
            self.session_active.store(false, Ordering::SeqCst);
            (self.restore_windows)();
        }
    }

    /// worker 失败路径：记录诊断、复位标记、恢复自身窗口（UI 线程）。
    fn abort_with_error(self: &Arc<Self>, message: &str) {
        eprintln!("CommandCabin: {message}");
        self.session_active.store(false, Ordering::SeqCst);
        (self.restore_windows)();
    }

    /// 捕获结果 → 覆盖窗口会话（UI 线程）：装配 Slint 位图、设置窗口几何
    /// （虚拟边界原点 + 尺寸）并显示。
    fn on_captured(self: &Arc<Self>, mode: ScreenshotMode, mut displays: Vec<SessionDisplay>) {
        let Some(window) = self.window.upgrade() else {
            self.abort_with_error("screenshot window is gone");
            return;
        };
        // A single overlay spans the physical desktop even when monitor DPIs differ.
        rebase_displays(&mut displays, 1.0);
        let virtual_bounds = session_virtual_bounds(&displays);
        let rows: Vec<ScreenshotDisplayImage> = displays
            .iter()
            .map(|display| {
                ScreenshotDisplayImage {
                    // GDI frames are opaque, so their RGBA is already premultiplied.
                    image: Image::from_rgba8_premultiplied(display.rgba.clone()),
                    x: (display.bounds.x - virtual_bounds.x) as f32,
                    y: (display.bounds.y - virtual_bounds.y) as f32,
                    width: display.bounds.width as f32,
                    height: display.bounds.height as f32,
                }
            })
            .collect();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.state = initial_state();
            inner.session = Some(Session {
                displays,
                virtual_bounds,
                mode,
                lifetime: Arc::new(()),
                base: RgbaImage::new(1, 1),
                base_selection: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 0.0,
                    height: 0.0,
                },
                committed: RgbaImage::new(1, 1),
                committed_valid: false,
            });
            inner.drag = DragMode::None;
            inner.suppress_drag = false;
            inner.last_layer_push = None;
            inner.layer_push_pending = false;
            inner.layer_empty = true;
            inner.output_busy = false;
        }
        // 新会话复位面板与状态行（上一会话可能残留显示）。
        if let Some(window) = self.window.upgrade() {
            window.set_ocr_visible(false);
            window.set_ocr_running(false);
            window.set_ocr_copyable(false);
            window.set_ocr_text(SharedString::new());
            window.set_ocr_message(SharedString::new());
            window.set_status_message(SharedString::new());
        }
        window.set_displays(ModelRc::new(VecModel::from(rows)));
        window.set_bounds_width(virtual_bounds.width as f32);
        window.set_bounds_height(virtual_bounds.height as f32);
        window.window().set_position(slint::PhysicalPosition::new(
            virtual_bounds.x.round() as i32,
            virtual_bounds.y.round() as i32,
        ));
        {
            let mut inner = self.inner.lock().unwrap();
            push_view_model(&window, &mut inner);
        }
        window.show().expect("show screenshot window");
        // 与 show_launcher_window 同理：show 只映射窗口，不保证前台/键盘焦点；
        // 覆盖窗口需要焦点以接收全局 Esc/Enter（winit focus_window 前台激活）。
        window
            .window()
            .with_winit_window(|winit_window| winit_window.focus_window());
        window.invoke_refocus_scope();
        window.window().request_redraw();
    }

    /// 会话收束：隐藏覆盖窗口、复位状态机与活跃标记、恢复自身窗口。
    /// 幂等守卫：异步输出（复制/保存/OCR）的完成回调可能晚于用户取消到达，
    /// 会话已收束时只清 busy，不重复恢复自身窗口。
    fn end_session(self: &Arc<Self>, inner: &mut ControllerInner) {
        inner.output_busy = false;
        if inner.session.is_none() {
            return;
        }
        inner.state = initial_state();
        inner.session = None;
        inner.drag = DragMode::None;
        inner.suppress_drag = false;
        inner.last_layer_push = None;
        inner.layer_push_pending = false;
        inner.layer_empty = true;
        if let Some(window) = self.window.upgrade() {
            let _ = window.hide();
            window.set_displays(ModelRc::default());
            window.set_annotation_layer(Image::default());
            window.set_translation_retry(false);
            window.set_translating(false);
            window.set_ocr_visible(false);
            window.set_ocr_running(false);
            window.set_ocr_copyable(false);
            window.set_status_message(SharedString::new());
        }
        self.session_active.store(false, Ordering::SeqCst);
        (self.restore_windows)();
    }

    /// 派发动作 + 同步视图（所有 Slint 回调的唯一汇聚点）。
    fn dispatch(self: &Arc<Self>, action: ScreenshotAction) {
        self.dispatch_with_optional_text_commit(action, false);
    }

    /// 带可选文本提交前缀的派发（工具/样式变更，TS blur-commit 净效果）。
    fn dispatch_with_optional_text_commit(
        self: &Arc<Self>,
        action: ScreenshotAction,
        commit_pending_text: bool,
    ) {
        let Some(window) = self.window.upgrade() else {
            return;
        };
        let mut inner = self.inner.lock().unwrap();
        let before = inner.state.clone();
        if commit_pending_text && inner.state.text_prompt.is_some() {
            let value = window.get_prompt_value().to_string();
            inner.state = reducer(&inner.state, ScreenshotAction::CommitText { value });
        }
        inner.state = reducer(&inner.state, action);
        sync_after_dispatch(&window, &mut inner, &before);
    }

    /// 完成请求（done 按钮 / Enter / 双击，TS finish()）：busy 期间短路；
    /// 先提交挂起文本，派发 Complete；仅当置位 done 时导出并走出口——
    /// 普通截图复制，OCR 与翻译复用对应的工具栏操作。
    pub fn on_finish(self: &Arc<Self>) {
        let mode = {
            let Some(window) = self.window.upgrade() else {
                return;
            };
            let mut inner = self.inner.lock().unwrap();
            if inner.output_busy {
                return;
            }
            let before = inner.state.clone();
            if inner.state.text_prompt.is_some() {
                let value = window.get_prompt_value().to_string();
                inner.state = reducer(&inner.state, ScreenshotAction::CommitText { value });
            }
            inner.state = reducer(&inner.state, ScreenshotAction::Complete);
            sync_after_dispatch(&window, &mut inner, &before);
            if !inner.state.done {
                return;
            }
            let Some(session) = &inner.session else {
                return;
            };
            if session.mode == ScreenshotMode::Translate && translated_text(&inner.state).is_some()
            {
                ScreenshotMode::Capture
            } else {
                session.mode
            }
        };
        match mode {
            ScreenshotMode::Ocr => self.on_ocr(),
            ScreenshotMode::Translate => self.on_translate(),
            ScreenshotMode::Capture
            | ScreenshotMode::CaptureDelay3
            | ScreenshotMode::CaptureDelay5 => {
                let export = export_selection_locked(&mut self.inner.lock().unwrap());
                if let Some(image) = export {
                    self.begin_copy(image);
                }
            }
        }
    }

    // ---- 输出动作（M3 Task 8；单次一个输出操作，TS outputOperationBusyRef） ----

    /// 复制出口（TS finish 非 OCR 分支：copyImage → cancel）：worker 线程写
    /// 剪贴板，成功收束会话，失败显示状态行并保持会话。
    fn begin_copy(self: &Arc<Self>, image: RgbaImage) {
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.output_busy {
                return;
            }
            inner.output_busy = true;
        }
        let controller = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("screenshot-copy".into())
            .spawn(move || {
                let result = ArboardClipboard::new().copy_png(png_encode_rgba(&image));
                let _ = slint::invoke_from_event_loop(move || {
                    let mut inner = controller.inner.lock().unwrap();
                    match result {
                        Ok(()) => controller.end_session(&mut inner),
                        Err(error) => {
                            eprintln!("CommandCabin: screenshot copy failed: {error}");
                            controller.set_status_inner(&mut inner, ActionFailed);
                        }
                    }
                });
            });
        if let Err(error) = spawned {
            self.inner.lock().unwrap().output_busy = false;
            eprintln!("CommandCabin: screenshot copy thread failed to spawn: {error}");
        }
    }

    /// OCR（完成出口或工具栏按钮，TS runOcr）：worker 线程跑 WinRT OCR，
    /// 结果回 UI 线程显示在覆盖窗 OCR 面板——**会话保持打开**（T7 移交修正：
    /// 不再 end_session，对齐 TS setOcrPanel 后覆盖层继续可交互）。
    fn begin_ocr(self: &Arc<Self>, image: RgbaImage) {
        let language = {
            let mut inner = self.inner.lock().unwrap();
            if inner.output_busy {
                return;
            }
            inner.output_busy = true;
            inner.language
        };
        if let Some(window) = self.window.upgrade() {
            window.set_ocr_visible(true);
            window.set_ocr_running(true);
            window.set_ocr_copyable(false);
            window.set_ocr_text(SharedString::new());
            window.set_ocr_message(SharedString::new());
        }
        let controller = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("screenshot-ocr".into())
            .spawn(move || {
                // 单独 OCR 沿用界面语言，翻译入口使用双语识别。
                let primary = ui_language_tag(language);
                let outcome = run_ocr(&png_encode_rgba(&image), primary, &[]);
                let _ = slint::invoke_from_event_loop(move || {
                    controller.on_ocr_done(outcome);
                });
            });
        if let Err(error) = spawned {
            self.inner.lock().unwrap().output_busy = false;
            if let Some(window) = self.window.upgrade() {
                window.set_ocr_running(false);
            }
            eprintln!("CommandCabin: screenshot OCR thread failed to spawn: {error}");
        }
    }

    /// OCR 结果 → 面板（TS setOcrPanel(result)：running → success 文本/空文本
    /// noText / unavailable-error 消息）。
    fn on_ocr_done(
        self: &Arc<Self>,
        outcome: Result<OcrOutcome, cabin_platform::traits::PlatformError>,
    ) {
        let mut inner = self.inner.lock().unwrap();
        inner.output_busy = false;
        let Some(window) = self.window.upgrade() else {
            return;
        };
        window.set_ocr_visible(true);
        window.set_ocr_running(false);
        match outcome {
            Ok(outcome) => match outcome.status {
                OcrStatus::Success => {
                    let text = outcome.text.unwrap_or_default();
                    // TS OcrPanel：空文本显示 strings.ocr.noText 且 copyAll 不可用。
                    let has_text = !text.trim().is_empty();
                    window.set_ocr_copyable(has_text);
                    window.set_ocr_text(if has_text {
                        text.into()
                    } else {
                        i18n::screenshot_texts(inner.language).ocr_no_text.into()
                    });
                    window.set_ocr_message(SharedString::new());
                }
                OcrStatus::Unavailable => {
                    window.set_ocr_copyable(false);
                    window.set_ocr_text(SharedString::new());
                    window.set_ocr_message(
                        outcome
                            .message
                            .unwrap_or_else(|| NO_OCR_TEXT_MESSAGE.to_string())
                            .into(),
                    );
                }
                OcrStatus::Error => {
                    window.set_ocr_copyable(false);
                    window.set_ocr_text(SharedString::new());
                    window.set_ocr_message(outcome.message.unwrap_or_default().into());
                }
            },
            Err(error) => {
                window.set_ocr_copyable(false);
                window.set_ocr_text(SharedString::new());
                window.set_ocr_message(error.to_string().into());
            }
        }
    }

    /// 保存（TS runOutputAction('save') → saveImage）：导出 → IFileSaveDialog
    /// （worker 线程，STA）→ 取消/失败不关会话（TS 仅置状态）；按扩展名判定
    /// 格式后写文件。
    pub fn on_save(self: &Arc<Self>) {
        let export = {
            let mut inner = self.inner.lock().unwrap();
            if inner.output_busy {
                return;
            }
            match export_selection_locked(&mut inner) {
                Some(png) => png,
                None => return,
            }
        };
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.output_busy {
                return;
            }
            inner.output_busy = true;
        }
        let controller = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("screenshot-save".into())
            .spawn(move || {
                let outcome = show_image_save_dialog(&save_file_name_now());
                let _ = slint::invoke_from_event_loop(move || {
                    controller.on_save_path(outcome, export);
                });
            });
        if let Err(error) = spawned {
            self.inner.lock().unwrap().output_busy = false;
            eprintln!("CommandCabin: screenshot save thread failed to spawn: {error}");
        }
    }

    /// 保存对话框结果 → 写文件（TS saveImage 的 writeImageFile + 状态行）。
    fn on_save_path(
        self: &Arc<Self>,
        outcome: Result<Option<PathBuf>, cabin_platform::traits::PlatformError>,
        image: RgbaImage,
    ) {
        let mut inner = self.inner.lock().unwrap();
        inner.output_busy = false;
        match outcome {
            // TS：取消 → status saveCanceled，会话保持。
            Ok(None) => {
                self.set_status_inner(&mut inner, SaveCanceled);
            }
            Ok(Some(path)) => {
                let format = derive_save_format_from_path(&path.to_string_lossy(), "png");
                let bytes = if format == "jpg" {
                    jpeg_encode_rgba(&image, cabin_core::screenshot::DEFAULT_JPEG_QUALITY)
                } else {
                    png_encode_rgba(&image)
                };
                match std::fs::write(&path, bytes) {
                    Ok(()) => self.set_status_inner(&mut inner, ImageSaved),
                    Err(error) => {
                        eprintln!(
                            "CommandCabin: writing screenshot to {} failed: {error}",
                            path.display()
                        );
                        self.set_status_inner(&mut inner, ActionFailed);
                    }
                }
            }
            Err(error) => {
                eprintln!("CommandCabin: screenshot save dialog failed: {error}");
                self.set_status_inner(&mut inner, ActionFailed);
            }
        }
    }

    pub fn on_translate(self: &Arc<Self>) {
        let Some(window) = self.window.upgrade() else {
            return;
        };
        let (input, language, target, session_token) = {
            let mut inner = self.inner.lock().unwrap();
            if inner.output_busy || !inner.state.selection.is_some_and(|r| is_non_empty_rect(&r)) {
                return;
            }
            let Some(session) = &inner.session else {
                return;
            };
            let session_token = Arc::downgrade(&session.lifetime);
            let input = if translated_text(&inner.state).is_some() {
                // Keep the visible translation until a replacement succeeds.
                TranslationInput::OriginalText(window.get_original_text().to_string())
            } else {
                let Some(image) = export_selection_locked(&mut inner) else {
                    return;
                };
                TranslationInput::Image(image)
            };
            inner.output_busy = true;
            inner.drag = DragMode::None;
            (
                input,
                inner.language,
                inner.translation_target.unwrap_or(inner.language),
                session_token,
            )
        };
        window.set_ocr_visible(false);
        window.set_translation_retry(false);
        window.set_translating(true);
        window.set_status_message(
            i18n::screenshot_texts(language)
                .translation_translating
                .into(),
        );
        let controller = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("screenshot-translate".into())
            .spawn(move || {
                let view = match input.recognize(language) {
                    TranslationStep::Translate { text } => {
                        if session_token.upgrade().is_none() {
                            return;
                        }
                        // The OCR pack can recognize both Chinese and Latin text. Let the
                        // provider detect the actual source independently of that pack.
                        let result = run_online_translate("auto", target.as_str(), &text);
                        translation_view(&result, &text)
                    }
                    TranslationStep::Unavailable { message }
                    | TranslationStep::Error { message } => TranslateView {
                        message,
                        ..TranslateView::default()
                    },
                };
                let _ = slint::invoke_from_event_loop(move || {
                    if session_token.upgrade().is_some() {
                        controller.on_translate_done(view);
                    }
                });
            });
        if let Err(error) = spawned {
            let mut inner = self.inner.lock().unwrap();
            window.set_translation_retry(translated_text(&inner.state).is_some());
            window.set_translating(false);
            inner.output_busy = false;
            self.set_status_inner(&mut inner, ActionFailed);
            eprintln!("CommandCabin: screenshot translate thread failed to spawn: {error}");
        }
    }

    /// 把成功的译文作为可撤销的标注提交，失败时在工具栏附近显示原因。
    fn on_translate_done(&self, view: TranslateView) {
        let Some(window) = self.window.upgrade() else {
            return;
        };
        let mut inner = self.inner.lock().unwrap();
        window.set_translating(false);
        inner.output_busy = false;
        let replacing = translated_text(&inner.state).is_some();
        let texts = i18n::screenshot_texts(inner.language);
        let Some(selection) = inner.state.selection else {
            return;
        };
        if !view.success {
            let message = match view.message.as_str() {
                NO_OCR_TEXT_MESSAGE => texts.ocr_no_text,
                "" => texts.translation_failed,
                message => message,
            };
            window.set_status_message(message.into());
            window.set_translation_retry(replacing);
            return;
        }
        let Some(annotation) = translation_overlay(selection, &view.target_text) else {
            window.set_status_message(texts.translation_no_text.into());
            window.set_translation_retry(replacing);
            return;
        };
        let before = inner.state.clone();
        inner
            .state
            .annotations
            .retain(|a| a.tool != Tool::Translation);
        inner.state = reducer(
            &inner.state,
            ScreenshotAction::AnnotationAdded { annotation },
        );
        window.set_original_text(view.source_text.into());
        window.set_status_message(SharedString::new());
        sync_after_dispatch(&window, &mut inner, &before);
    }

    /// 置顶（TS runOutputAction('pin')：pinImage → status pinned）：导出合成
    /// 图并打开置顶小窗；会话保持打开。
    pub fn on_pin(self: &Arc<Self>) {
        let bounds = self.session_window_bounds();
        let export = {
            let mut inner = self.inner.lock().unwrap();
            if inner.output_busy {
                return;
            }
            match export_selection_locked(&mut inner) {
                Some(image) => image,
                None => return,
            }
        };
        let language = self.inner.lock().unwrap().language;
        open_pin_window(&export, &i18n::screenshot_texts(language), &bounds);
        let mut inner = self.inner.lock().unwrap();
        self.set_status_inner(&mut inner, Pinned);
    }

    /// 工具栏 OCR 按钮（TS runOutputAction('ocr')）：导出 → OCR 面板；会话保持。
    pub fn on_ocr(self: &Arc<Self>) {
        let export = {
            let mut inner = self.inner.lock().unwrap();
            if inner.output_busy {
                return;
            }
            match export_selection_locked(&mut inner) {
                Some(png) => png,
                None => return,
            }
        };
        self.begin_ocr(export);
    }

    /// OCR 面板"复制全部"（TS copyOcrText：success 且非空文本才复制）。
    pub fn on_ocr_copy_all(self: &Arc<Self>) {
        let text = {
            let Some(window) = self.window.upgrade() else {
                return;
            };
            if !window.get_ocr_copyable() {
                return;
            }
            window.get_ocr_text().to_string()
        };
        if text.is_empty() {
            return;
        }
        let spawned = std::thread::Builder::new()
            .name("screenshot-ocr-copy".into())
            .spawn(move || {
                let result = ArboardClipboard::new().copy_text(text);
                if let Err(error) = result {
                    eprintln!("CommandCabin: copying OCR text failed: {error}");
                }
            });
        if let Err(error) = spawned {
            eprintln!("CommandCabin: OCR copy thread failed to spawn: {error}");
        }
    }

    /// 状态行写入（值语义的私有包装；i18n 按当前语言取词）。
    fn set_status_inner(&self, inner: &mut ControllerInner, status: StatusKind) {
        let texts = i18n::screenshot_texts(inner.language);
        let message = match status {
            ActionFailed => texts.action_failed,
            ImageSaved => texts.status_image_saved,
            SaveCanceled => texts.status_save_canceled,
            Pinned => texts.status_pinned,
        };
        if let Some(window) = self.window.upgrade() {
            window.set_status_message(message.into());
        }
    }

    /// 会话虚拟边界（窗口本地坐标原点）；无会话时回退零矩形（输出窗落位用）。
    fn session_window_bounds(&self) -> Rect {
        self.inner
            .lock()
            .unwrap()
            .session
            .as_ref()
            .map(|session| session.virtual_bounds)
            .unwrap_or(Rect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            })
    }

    // ---- Slint 回调（均在 UI 线程） ----

    pub fn on_pointer_down(self: &Arc<Self>, x: f32, y: f32) {
        let Some(window) = self.window.upgrade() else {
            return;
        };
        let mut inner = self.inner.lock().unwrap();
        // TS beginPointer：输出操作进行中时指针输入整体短路。
        if inner.output_busy {
            return;
        }
        let first_selection = inner.state.selection.is_none();
        let Some(session) = inner.session.as_mut() else {
            return;
        };
        if first_selection {
            // Slint reports pointer positions in the mapped overlay's logical pixels.
            rebase_displays(
                &mut session.displays,
                f64::from(window.window().scale_factor()),
            );
            session.virtual_bounds = session_virtual_bounds(&session.displays);
        }
        let (x, y) = (f64::from(x), f64::from(y));
        let point = window_local_to_virtual(session.virtual_bounds, x, y);
        // 双击判定（TS event.detail > 1 等价）：第二次按下抑制拖拽起点。
        let now = Instant::now();
        inner.suppress_drag = match inner.last_pointer_down {
            Some((previous_time, previous_point)) => {
                is_within_double_click(previous_point, previous_time, point, now)
            }
            None => false,
        };
        inner.last_pointer_down = Some((now, point));
        let mut next = inner.state.clone();
        // 宿主契约：文本提示挂起时先提交（值取自输入框），再处理指针。
        if next.text_prompt.is_some() {
            let value = window.get_prompt_value().to_string();
            next = reducer(&next, ScreenshotAction::CommitText { value });
        }
        if inner.suppress_drag {
            inner.drag = DragMode::None;
        } else {
            match next.selection {
                None => inner.drag = DragMode::Selection,
                Some(selection) if point_in_rect(point, selection) => {
                    let start = to_selection_point(point, selection);
                    inner.drag = DragMode::Annotation { start };
                }
                Some(_) => inner.drag = DragMode::Selection,
            }
        }
        let before = inner.state.clone();
        inner.state = match inner.drag {
            DragMode::Selection => reducer(&next, ScreenshotAction::SelectionStarted { point }),
            DragMode::Annotation { start } => {
                reducer(&next, ScreenshotAction::AnnotationStarted { point: start })
            }
            DragMode::None => next,
        };
        sync_after_dispatch(&window, &mut inner, &before);
    }

    pub fn on_pointer_move(self: &Arc<Self>, x: f32, y: f32) {
        let Some(window) = self.window.upgrade() else {
            return;
        };
        let mut inner = self.inner.lock().unwrap();
        let Some(session) = inner.session.as_ref() else {
            return;
        };
        let (x, y) = (f64::from(x), f64::from(y));
        let point = window_local_to_virtual(session.virtual_bounds, x, y);
        let before = inner.state.clone();
        match inner.drag {
            DragMode::Selection => {
                inner.state = reducer(&inner.state, ScreenshotAction::SelectionUpdated { point });
            }
            DragMode::Annotation { .. } => {
                if let Some(selection) = inner.state.selection {
                    let local = to_selection_point(point, selection);
                    inner.state = reducer(
                        &inner.state,
                        ScreenshotAction::AnnotationUpdated { point: local },
                    );
                }
            }
            DragMode::None => return,
        }
        sync_after_dispatch(&window, &mut inner, &before);
    }

    pub fn on_pointer_up(self: &Arc<Self>, x: f32, y: f32) {
        let Some(window) = self.window.upgrade() else {
            return;
        };
        let mut inner = self.inner.lock().unwrap();
        let before = inner.state.clone();
        let (x, y) = (f64::from(x), f64::from(y));
        if let Some(session) = inner.session.as_ref() {
            let point = window_local_to_virtual(session.virtual_bounds, x, y);
            match inner.drag {
                DragMode::Selection => {
                    inner.state = reducer(&inner.state, ScreenshotAction::SelectionEnded);
                }
                DragMode::Annotation { start } => {
                    if inner.state.tool == Tool::Text {
                        if let Some(selection) = inner.state.selection {
                            let end = to_selection_point(point, selection);
                            // TS：annotation-canceled 后按 3px 阈值开提示；
                            // reducer 的 TextPromptStarted 已合并两步（同步打开，
                            // 220ms 防抖为已文档化差异）。
                            inner.state = reducer(
                                &inner.state,
                                ScreenshotAction::TextPromptStarted {
                                    from: start,
                                    to: end,
                                },
                            );
                        }
                    } else {
                        inner.state = reducer(&inner.state, ScreenshotAction::AnnotationFinished);
                    }
                }
                DragMode::None => {}
            }
        }
        inner.drag = DragMode::None;
        inner.suppress_drag = false;
        // 补推节流期间跳过的草稿层。
        inner.layer_push_pending = true;
        sync_after_dispatch(&window, &mut inner, &before);
        // 文本提示本次打开：把键盘焦点交给输入框（TS target-owns-escape/enter，
        // 提示打开期间 Esc/Enter 由输入框先行消费，不触发全局完成/取消）。
        if before.text_prompt.is_none() && inner.state.text_prompt.is_some() {
            window.invoke_focus_prompt();
        }
    }

    pub fn on_pointer_cancel(self: &Arc<Self>) {
        let Some(window) = self.window.upgrade() else {
            return;
        };
        let mut inner = self.inner.lock().unwrap();
        let before = inner.state.clone();
        if inner.drag != DragMode::None {
            inner.state = reducer(&inner.state, ScreenshotAction::AnnotationCanceled);
            inner.drag = DragMode::None;
        }
        inner.layer_push_pending = true;
        sync_after_dispatch(&window, &mut inner, &before);
    }

    /// 工具选择（先提交挂起文本，TS 工具按钮 blur-commit 净效果）。
    pub fn on_tool_selected(self: &Arc<Self>, index: i32) {
        let Some(tool) = tool_from_index(index) else {
            return;
        };
        self.dispatch_with_optional_text_commit(ScreenshotAction::ToolSelected { tool }, true);
    }

    pub fn on_color_selected(self: &Arc<Self>, color: slint::Color) {
        let hex = color_to_hex(color);
        self.dispatch_with_optional_text_commit(
            ScreenshotAction::ColorSelected { color: hex },
            true,
        );
    }

    pub fn on_line_width_selected(self: &Arc<Self>, line_width: f32) {
        self.dispatch_with_optional_text_commit(
            ScreenshotAction::LineWidthSelected {
                line_width: f64::from(line_width),
            },
            true,
        );
    }

    pub fn on_font_size_selected(self: &Arc<Self>, font_size: f32) {
        self.dispatch_with_optional_text_commit(
            ScreenshotAction::FontSizeSelected {
                font_size: f64::from(font_size),
            },
            true,
        );
    }

    /// 撤销（先提交挂起文本，TS 工具栏按钮 blur-commit 净效果）。
    pub fn on_undo(self: &Arc<Self>) {
        self.dispatch_with_optional_text_commit(ScreenshotAction::Undo, true);
    }

    /// 重做（先提交挂起文本，TS 工具栏按钮 blur-commit 净效果）。
    pub fn on_redo(self: &Arc<Self>) {
        self.dispatch_with_optional_text_commit(ScreenshotAction::Redo, true);
    }

    /// Esc（全局键 / 右键）：取消整个会话（TS cancel → screenshotApi.cancel()）。
    pub fn on_cancel(self: &Arc<Self>) {
        let mut inner = self.inner.lock().unwrap();
        inner.state = reducer(&inner.state, ScreenshotAction::Cancel);
        self.end_session(&mut inner);
    }

    /// 文本提示提交（输入框 Enter）。
    pub fn on_commit_text(self: &Arc<Self>, value: String) {
        self.dispatch(ScreenshotAction::CommitText { value });
    }

    /// 文本提示取消（输入框 Esc；TS TextAnnotationInput onCancel）。
    pub fn on_cancel_prompt(self: &Arc<Self>) {
        let Some(window) = self.window.upgrade() else {
            return;
        };
        let mut inner = self.inner.lock().unwrap();
        let before = inner.state.clone();
        if inner.state.text_prompt.is_some() {
            inner.state = reducer(&inner.state, ScreenshotAction::AnnotationCanceled);
        }
        sync_after_dispatch(&window, &mut inner, &before);
    }
}

// ---------------------------------------------------------------------------
// 纯函数（可单测）：TS 语义的逐字移植与视图映射
// ---------------------------------------------------------------------------

/// TS `toSelectionPoint`：指针 → 选区本地坐标（钳制到 [0, width/height]）。
pub fn to_selection_point(point: Point, selection: Rect) -> Point {
    Point {
        x: (point.x - selection.x).clamp(0.0, selection.width),
        y: (point.y - selection.y).clamp(0.0, selection.height),
    }
}

/// TS `pointInRect`。
pub fn point_in_rect(point: Point, rect: Rect) -> bool {
    point.x >= rect.x
        && point.x <= rect.x + rect.width
        && point.y >= rect.y
        && point.y <= rect.y + rect.height
}

/// TS `getScreenshotToolbarPlacement`（逐字）：先贴选区下方 12px，放不下贴上方，
/// 上下都不行时钳制进视口；水平居中并钳制。
pub fn toolbar_placement(selection: Rect, toolbar: (f64, f64), viewport: (f64, f64)) -> Point {
    let (toolbar_width, toolbar_height) = toolbar;
    let (viewport_width, viewport_height) = viewport;
    let centered_x = selection.x + selection.width / 2.0 - toolbar_width / 2.0;
    let x = clamp(centered_x, 0.0, (viewport_width - toolbar_width).max(0.0));
    let below_y = selection.y + selection.height + TOOLBAR_GAP;
    let above_y = selection.y - toolbar_height - TOOLBAR_GAP;

    if below_y + toolbar_height <= viewport_height {
        return Point { x, y: below_y };
    }
    if above_y >= 0.0 {
        return Point { x, y: above_y };
    }
    Point {
        x,
        y: clamp(below_y, 0.0, (viewport_height - toolbar_height).max(0.0)),
    }
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

/// Choose a real monitor in the overlay's common logical coordinate space.
fn toolbar_placement_local(
    selection: Rect,
    virtual_bounds: Rect,
    displays: impl IntoIterator<Item = Rect>,
) -> Point {
    let intersection_area = |display: &Rect| {
        let width = (selection.x + selection.width).min(display.x + display.width)
            - selection.x.max(display.x);
        let height = (selection.y + selection.height).min(display.y + display.height)
            - selection.y.max(display.y);
        width.max(0.0) * height.max(0.0)
    };
    let display = displays
        .into_iter()
        .max_by(|a, b| intersection_area(a).total_cmp(&intersection_area(b)))
        .unwrap_or(virtual_bounds);
    // Project both corners onto this display. A selection spanning the seam
    // anchors the toolbar to the part the user can see on the chosen monitor.
    let left = (selection.x - display.x).clamp(0.0, display.width);
    let top = (selection.y - display.y).clamp(0.0, display.height);
    let right = (selection.x + selection.width - display.x).clamp(0.0, display.width);
    let bottom = (selection.y + selection.height - display.y).clamp(0.0, display.height);
    // Slint clips the ComboBox popup to its parent window. At a shorter
    // monitor's bottom edge that window continues into the desktop gap.
    // The Fluent list is three 40px items plus 8px padding, replacing the
    // 30px closed control in the last toolbar row.
    let popup_extension = if display.y + display.height < virtual_bounds.y + virtual_bounds.height {
        3.0 * 40.0 + 8.0 - 30.0
    } else {
        0.0
    };
    let placement = toolbar_placement(
        Rect {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        },
        (TOOLBAR_WIDTH, TOOLBAR_HEIGHT + popup_extension),
        (display.width, display.height),
    );
    Point {
        x: display.x - virtual_bounds.x + placement.x,
        y: display.y - virtual_bounds.y + placement.y,
    }
}

/// 双击判定（500ms / 4px 时间窗内即双击的第二次按下）。
pub fn is_within_double_click(
    previous_point: Point,
    previous_time: Instant,
    point: Point,
    now: Instant,
) -> bool {
    if now.duration_since(previous_time) > DOUBLE_CLICK_TIME {
        return false;
    }
    let dx = point.x - previous_point.x;
    let dy = point.y - previous_point.y;
    (dx * dx + dy * dy) <= DOUBLE_CLICK_SLOP * DOUBLE_CLICK_SLOP
}

/// 工具栏序（TS `toolOrder`）→ 索引；Translation 不可选（返回 None）。
pub fn tool_index(tool: Tool) -> Option<usize> {
    match tool {
        Tool::Rectangle => Some(0),
        Tool::Ellipse => Some(1),
        Tool::Arrow => Some(2),
        Tool::Pen => Some(3),
        Tool::Mosaic => Some(4),
        Tool::Text => Some(5),
        Tool::Translation => None,
    }
}

/// 工具栏索引 → 工具；越界返回 None。
pub fn tool_from_index(index: i32) -> Option<Tool> {
    match index {
        0 => Some(Tool::Rectangle),
        1 => Some(Tool::Ellipse),
        2 => Some(Tool::Arrow),
        3 => Some(Tool::Pen),
        4 => Some(Tool::Mosaic),
        5 => Some(Tool::Text),
        _ => None,
    }
}

/// `#rrggbb` / `#rgb` → `[r, g, b]`（色板/文字标注共享解析；非法输入 None）。
pub fn parse_hex_rgb(color: &str) -> Option<[u8; 3]> {
    let hex = color.strip_prefix('#')?;
    match hex.len() {
        6 => {
            let value = u32::from_str_radix(hex, 16).ok()?;
            Some([
                ((value >> 16) & 0xff) as u8,
                ((value >> 8) & 0xff) as u8,
                (value & 0xff) as u8,
            ])
        }
        3 => {
            let mut rgb = [0u8; 3];
            for (index, character) in hex.chars().enumerate() {
                let value = character.to_digit(16)?;
                rgb[index] = (value * 16 + value) as u8;
            }
            Some(rgb)
        }
        _ => None,
    }
}

/// Slint 颜色 → `#rrggbb`（色板回调 → reducer `ColorSelected`）。
pub fn color_to_hex(color: slint::Color) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        color.red(),
        color.green(),
        color.blue()
    )
}

/// 选区本地逻辑 rect → 标注层设备像素尺寸（TS `Math.max(1, Math.round(...))`；
/// 非有限缩放按 1 处理）。
pub fn annotation_layer_size(selection: Rect, output_scale: f64) -> (u32, u32) {
    let scale = if output_scale.is_finite() && output_scale > 0.0 {
        output_scale
    } else {
        1.0
    };
    let width = (selection.width * scale).round().max(1.0) as u32;
    let height = (selection.height * scale).round().max(1.0) as u32;
    (width, height)
}

/// 会话虚拟边界：复用 core `calculate_virtual_bounds`（TS 逐字实现，Task 3），
/// 会话显示器按枚举序占位 id（该函数不读 id）。
fn session_virtual_bounds(displays: &[SessionDisplay]) -> Rect {
    let core_displays: Vec<ScreenshotDisplay> = displays
        .iter()
        .enumerate()
        .map(|(index, display)| ScreenshotDisplay {
            bounds: display.bounds,
            id: index as i32,
            scale_factor: display.scale_factor,
        })
        .collect();
    cabin_core::screenshot::calculate_virtual_bounds(&core_displays)
}

fn rebase_displays(displays: &mut [SessionDisplay], scale: f64) {
    for display in displays {
        let ratio = display.scale_factor / scale;
        display.bounds.x *= ratio;
        display.bounds.y *= ratio;
        display.bounds.width *= ratio;
        display.bounds.height *= ratio;
        display.scale_factor = scale;
    }
}

/// TS `scalePoint`/`scaleRect`/`scaleStyle` 合一（几何 → 缓冲设备像素）。
pub fn scale_annotation(annotation: &Annotation, scale: f64) -> Annotation {
    Annotation {
        id: annotation.id.clone(),
        tool: annotation.tool,
        style: AnnotationStyle {
            color: annotation.style.color.clone(),
            font_size: annotation.style.font_size * scale,
            line_width: annotation.style.line_width * scale,
        },
        points: annotation
            .points
            .iter()
            .map(|point| Point {
                x: point.x * scale,
                y: point.y * scale,
            })
            .collect(),
        text: annotation.text.clone(),
    }
}

fn window_local_to_virtual(virtual_bounds: Rect, x: f64, y: f64) -> Point {
    Point {
        x: virtual_bounds.x + x,
        y: virtual_bounds.y + y,
    }
}

// ---------------------------------------------------------------------------
// 渲染管线：底图 → 已提交快照 → 草稿层 → Slint 视图
// ---------------------------------------------------------------------------

impl From<CapturedFrame> for SessionDisplay {
    fn from(frame: CapturedFrame) -> Self {
        Self {
            rgba: slint::SharedPixelBuffer::clone_from_slice(
                &frame.rgba.data,
                frame.rgba.width,
                frame.rgba.height,
            ),
            bounds: frame.display.bounds,
            scale_factor: frame.display.scale_factor,
        }
    }
}

/// 选区底图：把相交显示器的位图按 `output_scale` 采样进选区本地设备像素
/// （TS `drawDisplayImage` 的逐像素等价；最近邻采样，混合 DPI 下与导出路径
/// 同源语义）。
pub fn compose_base(displays: &[SessionDisplay], selection: Rect, output_scale: f64) -> RgbaImage {
    let (width, height) = annotation_layer_size(selection, output_scale);
    let mut output = RgbaImage::new(width, height);
    for target_y in 0..height {
        for target_x in 0..width {
            let logical_x = selection.x + (f64::from(target_x) + 0.5) / output_scale;
            let logical_y = selection.y + (f64::from(target_y) + 0.5) / output_scale;
            let Some(display) = displays.iter().find(|display| {
                logical_x >= display.bounds.x
                    && logical_x < display.bounds.x + display.bounds.width
                    && logical_y >= display.bounds.y
                    && logical_y < display.bounds.y + display.bounds.height
            }) else {
                continue;
            };
            let source_x = ((((logical_x - display.bounds.x) * display.scale_factor).floor()
                as u32)
                .min(display.rgba.width().saturating_sub(1))) as usize;
            let source_y = ((((logical_y - display.bounds.y) * display.scale_factor).floor()
                as u32)
                .min(display.rgba.height().saturating_sub(1))) as usize;
            let source_start = (source_y * display.rgba.width() as usize + source_x) * 4;
            let target_start = (target_y as usize * width as usize + target_x as usize) * 4;
            output.data[target_start..target_start + 4]
                .copy_from_slice(&display.rgba.as_bytes()[source_start..source_start + 4]);
        }
    }
    output
}

/// 会话的 `output_scale`：TS `getSelectionOutputScale` 的会话级等价（全部显示
/// 器的最大 DPI 缩放，下限 1）。
fn session_output_scale(session: &Session) -> f64 {
    session
        .displays
        .iter()
        .map(|display| display.scale_factor)
        .fold(1.0_f64, f64::max)
}

/// 普通框选不会渲染标注层，导出与标注预览都应按当前选区准备底图。
fn ensure_selection_base(session: &mut Session, selection: Rect) {
    if session.base_selection != selection {
        let output_scale = session_output_scale(session);
        session.base = compose_base(&session.displays, selection, output_scale);
        session.base_selection = selection;
        session.committed_valid = false;
    }
}

/// 保证底图/已提交快照与当前选区/标注集一致（惰性重建）。
fn ensure_buffers(session: &mut Session, state: &ScreenshotState) {
    let Some(selection) = state.selection else {
        return;
    };
    ensure_selection_base(session, selection);
    if !session.committed_valid {
        let output_scale = session_output_scale(session);
        let mut committed = clone_image(&session.base);
        for annotation in &state.annotations {
            if matches!(annotation.tool, Tool::Text | Tool::Translation) {
                continue; // 文字走矢量叠加，不烧缓冲（见模块文档）。
            }
            let scaled = scale_annotation(annotation, output_scale);
            draw_annotation(
                &mut committed,
                &scaled,
                scaled.style.font_size,
                output_scale,
            );
        }
        session.committed = committed;
        session.committed_valid = true;
    }
}

fn clone_image(image: &RgbaImage) -> RgbaImage {
    RgbaImage {
        width: image.width,
        height: image.height,
        data: image.data.clone(),
    }
}

/// 派发后的视图同步：结构变化（选区/标注集合）失效缓冲并立即推层；草稿变化
/// 按 16ms 节流推层（跳过时挂起，结构变化或 pointer-up 强制补推）。提示经非
/// 输入框路径关闭（stage 点击提交 / 工具栏 blur-commit）时把焦点交还全局键
/// 处理（`visible: false` 的 LineEdit 不再命中点击但仍持有键盘焦点，需显式
/// 归还，否则隐藏输入框会吞掉 Esc/Enter）。
fn sync_after_dispatch(
    window: &ScreenshotWindow,
    inner: &mut ControllerInner,
    before: &ScreenshotState,
) {
    let selection_changed = before.selection != inner.state.selection;
    if selection_changed {
        window.set_translation_retry(false);
        window.set_original_text(SharedString::new());
        window.set_status_message(SharedString::new());
    }
    let annotations_changed = before.annotations != inner.state.annotations
        || before.redo_annotations != inner.state.redo_annotations;
    let draft_changed = before.draft_annotation != inner.state.draft_annotation;
    let structural = selection_changed || annotations_changed;
    if annotations_changed {
        if let Some(session) = &mut inner.session {
            session.committed_valid = false;
        }
    }

    push_view_model(window, inner);

    if before.text_prompt.is_some() && inner.state.text_prompt.is_none() {
        window.invoke_refocus_scope();
    }

    let want_push = structural || draft_changed || inner.layer_push_pending;
    if !want_push {
        return;
    }
    let now = Instant::now();
    let throttled = inner
        .last_layer_push
        .is_some_and(|previous| now.duration_since(previous) < LIVE_RENDER_MIN_INTERVAL);
    if structural || !throttled {
        push_annotation_layer(window, inner, now);
    } else {
        inner.layer_push_pending = true;
    }
}

fn translated_text(state: &ScreenshotState) -> Option<&str> {
    state
        .annotations
        .iter()
        .rev()
        .find(|a| a.tool == Tool::Translation)?
        .text
        .as_deref()
}

/// 视图模型推送（属性 + 文字标注模型 + 提示框），无渲染缓冲操作。
/// Slint `length` 属性在生成侧为 f32（`Coord`），f64 状态值在边界处转换。
fn push_view_model(window: &ScreenshotWindow, inner: &mut ControllerInner) {
    let state = &inner.state;
    let virtual_bounds = inner
        .session
        .as_ref()
        .map(|session| session.virtual_bounds)
        .unwrap_or(Rect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        });
    let selection = state.selection;
    window.set_has_selection(selection.is_some_and(|rect| is_non_empty_rect(&rect)));
    if let (Some(selection), Some(session)) = (selection, &inner.session) {
        window.set_selection_x((selection.x - virtual_bounds.x) as f32);
        window.set_selection_y((selection.y - virtual_bounds.y) as f32);
        window.set_selection_width(selection.width as f32);
        window.set_selection_height(selection.height as f32);
        let placement = toolbar_placement_local(
            selection,
            virtual_bounds,
            session.displays.iter().map(|display| display.bounds),
        );
        window.set_toolbar_x(placement.x as f32);
        window.set_toolbar_y(placement.y as f32);
    }

    window.set_active_tool(tool_index(state.tool).unwrap_or(0) as i32);
    let rgb = parse_hex_rgb(&state.style.color).unwrap_or(FALLBACK_RGB);
    window.set_active_color(slint::Color::from_rgb_u8(rgb[0], rgb[1], rgb[2]));
    window.set_line_width(state.style.line_width as f32);
    window.set_font_size(state.style.font_size as f32);
    window.set_can_undo(!state.annotations.is_empty());
    window.set_can_redo(!state.redo_annotations.is_empty());

    // 文字标注矢量行（选区本地锚点 → 窗口坐标）。
    let origin = selection.unwrap_or(virtual_bounds);
    window.set_translated_text(translated_text(state).unwrap_or_default().into());
    let rows: Vec<ScreenshotTextAnnotation> = state
        .annotations
        .iter()
        .filter(|annotation| matches!(annotation.tool, Tool::Text | Tool::Translation))
        .filter_map(|annotation| {
            let anchor = *annotation.points.first()?;
            let rgb = parse_hex_rgb(&annotation.style.color).unwrap_or(FALLBACK_RGB);
            let overlay = annotation.rect();
            Some(ScreenshotTextAnnotation {
                is_translation: overlay.is_some(),
                width: overlay.map_or(0.0, |r| r.width) as f32,
                height: overlay.map_or(0.0, |r| r.height) as f32,
                padding: cabin_core::screenshot::get_translation_overlay_padding(
                    annotation.style.font_size,
                ) as f32,
                text: annotation.text.clone().unwrap_or_default().into(),
                x: (origin.x - virtual_bounds.x + anchor.x) as f32,
                y: (origin.y - virtual_bounds.y + anchor.y) as f32,
                font_size: annotation.style.font_size as f32,
                color: slint::Color::from_rgb_u8(rgb[0], rgb[1], rgb[2]),
            })
        })
        .collect();
    window.set_text_annotations(ModelRc::new(VecModel::from(rows)));

    // 文本提示（选区本地 → 窗口坐标；字号取当前 style）。
    match &state.text_prompt {
        Some(prompt) => {
            window.set_prompt_visible(true);
            window.set_prompt_x((origin.x - virtual_bounds.x + prompt.point.x) as f32);
            window.set_prompt_y((origin.y - virtual_bounds.y + prompt.point.y) as f32);
            window.set_prompt_font_size(state.style.font_size as f32);
        }
        None => {
            window.set_prompt_visible(false);
            window.set_prompt_value(SharedString::new());
        }
    }
}

/// 标注层重绘 + 推送（快照副本 + 草稿；文字不入缓冲）。无可见内容时推送
/// 一次空图复位。
fn push_annotation_layer(window: &ScreenshotWindow, inner: &mut ControllerInner, now: Instant) {
    let has_content = inner.state.draft_annotation.is_some() || !inner.state.annotations.is_empty();
    if has_content {
        if let Some(session) = inner.session.as_mut() {
            ensure_buffers(session, &inner.state);
            let output_scale = session_output_scale(session);
            let mut layer = clone_image(&session.committed);
            if let Some(draft) = &inner.state.draft_annotation {
                if !matches!(draft.tool, Tool::Text | Tool::Translation) {
                    let scaled = scale_annotation(draft, output_scale);
                    draw_annotation(&mut layer, &scaled, scaled.style.font_size, output_scale);
                }
            }
            let buffer = slint::SharedPixelBuffer::<slint::Rgba8Pixel>::clone_from_slice(
                &layer.data,
                layer.width,
                layer.height,
            );
            window.set_annotation_layer(Image::from_rgba8(buffer));
            inner.layer_empty = false;
        }
    } else if !inner.layer_empty {
        window.set_annotation_layer(Image::default());
        inner.layer_empty = true;
    }
    inner.last_layer_push = Some(now);
    inner.layer_push_pending = false;
}

// ---------------------------------------------------------------------------
// 输出动作（M3 Task 8）：导出 / 翻译决策 / 置顶与选区翻译
// ---------------------------------------------------------------------------

/// 状态行的四种取值（值语义，便于 set_status_inner 分派）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StatusKind {
    ActionFailed,
    ImageSaved,
    SaveCanceled,
    Pinned,
}
use StatusKind::{ActionFailed, ImageSaved, Pinned, SaveCanceled};

/// 导出当前选区的合成图像（TS exportImage：Task 3 `compose_export` 的底图 +
/// 全部标注二次矢量绘制；PNG/JPEG 编码由各出口按需进行）。UI 线程、持锁调用。
fn export_selection_locked(inner: &mut ControllerInner) -> Option<RgbaImage> {
    let session = inner.session.as_mut()?;
    let selection = inner.state.selection?;
    if !is_non_empty_rect(&selection) {
        return None;
    }
    ensure_selection_base(session, selection);
    let output_scale = session_output_scale(session);
    Some(compose_export(
        &session.base,
        &inner.state.annotations,
        output_scale,
    ))
}

enum TranslationInput {
    Image(RgbaImage),
    OriginalText(String),
}

impl TranslationInput {
    fn recognize(self, language: Language) -> TranslationStep {
        match self {
            Self::OriginalText(text) => TranslationStep::Translate { text },
            Self::Image(image) => {
                let languages = translation_ocr_languages(language);
                match run_ocr(&png_encode_rgba(&image), languages[0], &languages[1..]) {
                    Ok(ocr) => translation_step(&ocr),
                    Err(error) => TranslationStep::Error {
                        message: error.to_string(),
                    },
                }
            }
        }
    }
}

/// TS runScreenshotTranslation 的分派决策：OCR 结果 → 翻译 / 不可用 / 错误。
/// success 且有非空文本 → Translate；success 空文本 → 逐字 "No OCR text
/// found."；error → 透传消息；unavailable → 透传消息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranslationStep {
    Translate { text: String },
    Unavailable { message: String },
    Error { message: String },
}

pub fn translation_step(ocr: &OcrOutcome) -> TranslationStep {
    match ocr.status {
        OcrStatus::Success => match ocr.text.as_deref() {
            Some(text) if !text.trim().is_empty() => TranslationStep::Translate {
                text: text.to_string(),
            },
            _ => TranslationStep::Unavailable {
                message: NO_OCR_TEXT_MESSAGE.to_string(),
            },
        },
        OcrStatus::Error => TranslationStep::Error {
            message: ocr.message.clone().unwrap_or_default(),
        },
        OcrStatus::Unavailable => TranslationStep::Unavailable {
            message: ocr.message.clone().unwrap_or_default(),
        },
    }
}

/// 识别与翻译的结果；成功时提交覆盖标注，失败时显示提示。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TranslateView {
    pub success: bool,
    pub source_text: String,
    pub target_text: String,
    pub message: String,
}

/// 将翻译服务的结果映射到截图会话。
fn translation_view(result: &TranslationOutcome, source_text: &str) -> TranslateView {
    match result.status {
        TranslationStatus::Success => TranslateView {
            success: true,
            source_text: source_text.to_string(),
            target_text: result.translated_text.clone().unwrap_or_default(),
            message: String::new(),
        },
        TranslationStatus::Unavailable | TranslationStatus::Error => TranslateView {
            success: false,
            source_text: source_text.to_owned(),
            target_text: String::new(),
            message: result.message.clone().unwrap_or_default(),
        },
    }
}

/// 选区图像 → 置顶窗图像逻辑尺寸（等比缩放进 [`PIN_WINDOW_MAX_WIDTH`/`HEIGHT`]，
/// 下限 1px）。返回 (width, height, 缩放后图像)——缩放在 Rust 侧做最邻近采样，
/// 保证 Slint Image 以 1:1 逻辑像素显示（导出原尺寸不动）。
fn pin_window_image(image: &RgbaImage) -> (f64, f64, RgbaImage) {
    let scale_x = PIN_WINDOW_MAX_WIDTH / image.width.max(1) as f64;
    let scale_y = PIN_WINDOW_MAX_HEIGHT / image.height.max(1) as f64;
    let scale = scale_x
        .min(scale_y)
        .min(1.0)
        .max(1.0 / image.width.max(1) as f64);
    let width = ((image.width as f64 * scale).round() as u32).max(1);
    let height = ((image.height as f64 * scale).round() as u32).max(1);
    let mut out = RgbaImage::new(width, height);
    for target_y in 0..height {
        let source_y = ((f64::from(target_y) + 0.5) / scale).floor() as u32;
        let source_y = source_y.min(image.height.saturating_sub(1)) as usize;
        for target_x in 0..width {
            let source_x = ((f64::from(target_x) + 0.5) / scale).floor() as u32;
            let source_x = source_x.min(image.width.saturating_sub(1)) as usize;
            let source_start = (source_y * image.width as usize + source_x) * 4;
            let target_start = (target_y as usize * width as usize + target_x as usize) * 4;
            out.data[target_start..target_start + 4]
                .copy_from_slice(&image.data[source_start..source_start + 4]);
        }
    }
    (width as f64, height as f64, out)
}

// ---- 置顶窗注册表（thread_local；窗口只能在 UI 线程创建/使用） ----

thread_local! {
    /// 打开的置顶窗（槽位只置空不移除：关闭回调经创建时捕获的下标回收，
    /// 追加前压缩一次）。
    static PIN_WINDOWS: std::cell::RefCell<Vec<Option<PinWindow>>> =
        const { std::cell::RefCell::new(Vec::new()) };

}

fn with_each_pin_window(mut visitor: impl FnMut(&PinWindow)) {
    PIN_WINDOWS.with(|slots| {
        for slot in slots.borrow().iter().flatten() {
            visitor(slot);
        }
    });
}

/// 文案推送（置顶窗）。
fn push_pin_texts(window: &PinWindow, texts: &ScreenshotUiTexts) {
    window.set_save_label(texts.save.into());
    window.set_copy_label(texts.image_copy.into());
}

/// 打开一个置顶图窗（虚拟桌面右上角落位；保存/复制/关闭回调在 UI 线程）。
/// 打开一个置顶图窗（虚拟桌面右上角落位；保存/复制/关闭回调在 UI 线程）。
/// 槽位分配：复用最早的空槽或追加——槽位下标终身稳定（不压缩），关闭回调
/// 按创建时捕获的下标置空自己的槽（每窗至多触发一次 close，无复用歧义）。
fn open_pin_window(image: &RgbaImage, texts: &ScreenshotUiTexts, virtual_bounds: &Rect) {
    let (image_width, image_height, scaled) = pin_window_image(image);
    let Ok(window) = PinWindow::new() else {
        eprintln!("CommandCabin: failed to create pin window");
        return;
    };
    push_pin_texts(&window, texts);
    window.set_image_width(image_width as f32);
    window.set_image_height(image_height as f32);
    let buffer = slint::SharedPixelBuffer::<slint::Rgba8Pixel>::clone_from_slice(
        &scaled.data,
        scaled.width,
        scaled.height,
    );
    window.set_pin_image(Image::from_rgba8(buffer));
    // 落位：虚拟边界右上角（TS PinnedImageWindow 由 Electron 定位，M3 简化）。
    let window_width = image_width + 12.0;
    let x = virtual_bounds.x + virtual_bounds.width - window_width - FLOATING_WINDOW_MARGIN;
    let y = virtual_bounds.y + FLOATING_WINDOW_MARGIN;
    window.window().set_position(slint::LogicalPosition::new(
        x.max(virtual_bounds.x) as f32,
        y as f32,
    ));

    // 动作（拖动/复制/保存）在入槽前接线。
    let weak = window.as_weak();
    window.on_drag_requested(move || {
        if let Some(window) = weak.upgrade() {
            window.window().with_winit_window(|winit_window| {
                let _ = winit_window.drag_window();
            });
        }
    });
    // RgbaImage 未实现 Clone（core 约定经 clone_image 深拷贝）；`.clone()` 会
    // 退化为引用拷贝并使 'static 闭包捕获局部引用。
    let copy_image = clone_image(image);
    window.on_copy_requested(move || {
        if let Err(error) = ArboardClipboard::new().copy_png(png_encode_rgba(&copy_image)) {
            eprintln!("CommandCabin: copying pinned image failed: {error}");
        }
    });
    // 保存：与覆盖层保存同一条链路（对话框 → 扩展名判定 → 写文件）；编码在
    // 对话框线程完成，事件循环回调只写文件。
    let save_image = clone_image(image);
    window.on_save_requested(move || {
        let pinned = clone_image(&save_image);
        let spawned = std::thread::Builder::new()
            .name("pin-save".into())
            .spawn(move || {
                let encoded = show_image_save_dialog(&save_file_name_now()).map(|path| {
                    path.map(|path| {
                        let format = derive_save_format_from_path(&path.to_string_lossy(), "png");
                        let bytes = if format == "jpg" {
                            jpeg_encode_rgba(&pinned, cabin_core::screenshot::DEFAULT_JPEG_QUALITY)
                        } else {
                            png_encode_rgba(&pinned)
                        };
                        (path, bytes)
                    })
                });
                let _ = slint::invoke_from_event_loop(move || match encoded {
                    Ok(Some((path, bytes))) => {
                        if let Err(error) = std::fs::write(&path, bytes) {
                            eprintln!("CommandCabin: writing pinned image failed: {error}");
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        eprintln!("CommandCabin: pin save dialog failed: {error}");
                    }
                });
            });
        if let Err(error) = spawned {
            eprintln!("CommandCabin: pin save thread failed to spawn: {error}");
        }
    });

    let weak_for_close = window.as_weak();
    PIN_WINDOWS.with(|slots| {
        let mut slots = slots.borrow_mut();
        // 复用最早的空槽或追加（下标终身稳定，见函数注释）。
        let index = match slots.iter().position(|slot| slot.is_none()) {
            Some(index) => index,
            None => {
                slots.push(None);
                slots.len() - 1
            }
        };
        slots[index] = Some(window.clone_strong());
        window.on_close_requested(move || {
            if let Some(window) = weak_for_close.upgrade() {
                let _ = window.hide();
            }
            PIN_WINDOWS.with(|slots| {
                let mut slots = slots.borrow_mut();
                if slots.get(index).is_some() {
                    slots[index] = None;
                }
            });
        });
    });
    window.show().expect("show pin window");
    window
        .window()
        .with_winit_window(|winit_window| winit_window.focus_window());
}

pub fn copy_text_async(text: String) {
    if text.is_empty() {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("translate-copy".into())
        .spawn(move || {
            if let Err(error) = ArboardClipboard::new().copy_text(text) {
                eprintln!("CommandCabin: copying translation failed: {error}");
            }
        });
    if let Err(error) = spawned {
        eprintln!("CommandCabin: translate copy thread failed to spawn: {error}");
    }
}

#[cfg(test)]
mod tests;
