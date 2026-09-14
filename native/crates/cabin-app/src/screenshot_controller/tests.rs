//! 控制器纯函数单测：TS 语义移植（toSelectionPoint / toolbarPlacement /
//! 双击判定）与视图映射（工具索引、色板解析、层尺寸、底图采样、虚拟边界）。

use std::time::{Duration, Instant};

use super::{
    annotation_layer_size, compose_base, is_within_double_click, online_translation_gate,
    parse_hex_rgb, pin_window_image, point_in_rect, scale_annotation,
    screenshot_mode_for_system_command, screenshot_system_commands, session_virtual_bounds,
    to_selection_point, tool_from_index, tool_index, toolbar_placement, toolbar_placement_local,
    translation_step, translation_view, ScreenshotMode, TranslateView, TranslationStep,
    DOUBLE_CLICK_SLOP, TOOLBAR_HEIGHT, TOOLBAR_WIDTH,
};
use cabin_core::command::types::{CommandActionType, CommandSource};
use cabin_core::screenshot::{Annotation, AnnotationStyle, Point, Rect, RgbaImage, Tool};
use cabin_core::screenshot::{TranslationOutcome, TranslationStatus, NO_OCR_TEXT_MESSAGE};
use cabin_platform_windows::ocr::{OcrOutcome, OcrStatus};

use super::SessionDisplay;

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

#[test]
fn to_selection_point_clamps_to_rect_bounds() {
    // TS toSelectionPoint：Math.max(0, Math.min(point.x - selection.x, width))。
    let selection = rect(10.0, 20.0, 120.0, 90.0);
    assert_eq!(
        to_selection_point(point(40.0, 60.0), selection),
        point(30.0, 40.0)
    );
    // 越界钳制到 [0, width] / [0, height]。
    assert_eq!(
        to_selection_point(point(5.0, 15.0), selection),
        point(0.0, 0.0)
    );
    assert_eq!(
        to_selection_point(point(500.0, 500.0), selection),
        point(120.0, 90.0)
    );
}

#[test]
fn point_in_rect_matches_ts() {
    let rect_nice = rect(0.0, 0.0, 10.0, 10.0);
    assert!(point_in_rect(point(0.0, 0.0), rect_nice));
    assert!(point_in_rect(point(10.0, 10.0), rect_nice));
    assert!(!point_in_rect(point(10.1, 5.0), rect_nice));
    assert!(!point_in_rect(point(-0.1, 5.0), rect_nice));
}

#[test]
fn toolbar_placement_places_below_with_gap_then_above_then_clamped() {
    // 下方放得下：贴选区下方 12px，水平居中（TS getScreenshotToolbarPlacement）。
    let selection = rect(200.0, 100.0, 300.0, 200.0);
    let placement = toolbar_placement(selection, (TOOLBAR_WIDTH, TOOLBAR_HEIGHT), (1920.0, 1080.0));
    assert_eq!(placement.y, 100.0 + 200.0 + 12.0);
    // 居中：200 + 150 - 520/2 = 90（左缘情形的钳制在下方 left_edge 用例）。
    assert_eq!(placement.x, 200.0 + 150.0 - TOOLBAR_WIDTH / 2.0);

    // 下方放不下、上方放得下：贴上方。
    let near_bottom = rect(100.0, 900.0, 300.0, 170.0);
    let above = toolbar_placement(
        near_bottom,
        (TOOLBAR_WIDTH, TOOLBAR_HEIGHT),
        (1920.0, 1080.0),
    );
    assert_eq!(above.y, 900.0 - TOOLBAR_HEIGHT - 12.0);

    // 上下都放不下：钳制进视口底沿。
    let huge = rect(0.0, 0.0, 1920.0, 1070.0);
    let clamped = toolbar_placement(huge, (TOOLBAR_WIDTH, TOOLBAR_HEIGHT), (1920.0, 1080.0));
    assert_eq!(clamped.y, 1080.0 - TOOLBAR_HEIGHT);

    // 窄选区左缘：水平钳制到 0。
    let left_edge = rect(0.0, 0.0, 50.0, 50.0);
    let left = toolbar_placement(left_edge, (TOOLBAR_WIDTH, TOOLBAR_HEIGHT), (1920.0, 1080.0));
    assert_eq!(left.x, 0.0);
}

#[test]
fn toolbar_placement_local_handles_negative_origin_bounds() {
    // 负 X 原点（左屏为负）：选区绝对坐标 (-1320, 100) → 窗口本地 (600, 100)。
    // 修复前把绝对坐标直接传入 toolbar_placement，水平/垂直钳制与 above/below
    // 判定都在错误坐标系求值，工具栏会偏移出窗口。
    let virtual_bounds = rect(-1920.0, 0.0, 3840.0, 1080.0);
    let selection = rect(-1320.0, 100.0, 300.0, 200.0);
    let placement = toolbar_placement_local(selection, virtual_bounds);
    // 下方放得下：y = 100 + 200 + 12；x = 600 + 150 - 520/2 = 490。
    assert_eq!(placement.y, 100.0 + 200.0 + 12.0);
    assert_eq!(placement.x, 600.0 + 150.0 - TOOLBAR_WIDTH / 2.0);
    // 结果完整落在窗口本地视口内。
    assert!(placement.x >= 0.0 && placement.x + TOOLBAR_WIDTH <= virtual_bounds.width);
    assert!(placement.y >= 0.0 && placement.y + TOOLBAR_HEIGHT <= virtual_bounds.height);

    // 负 Y 原点：选区绝对坐标 (100, -980) → 窗口本地 (100, 100)。
    let vertical_bounds = rect(0.0, -1080.0, 1920.0, 2160.0);
    let vertical_selection = rect(100.0, -980.0, 300.0, 200.0);
    let vertical = toolbar_placement_local(vertical_selection, vertical_bounds);
    assert_eq!(vertical.y, 100.0 + 200.0 + 12.0);
    assert!(vertical.x >= 0.0 && vertical.x + TOOLBAR_WIDTH <= vertical_bounds.width);
    assert!(vertical.y >= 0.0 && vertical.y + TOOLBAR_HEIGHT <= vertical_bounds.height);

    // 零原点直通 toolbar_placement（回归保护）。
    let zero_bounds = rect(0.0, 0.0, 1920.0, 1080.0);
    let plain = rect(200.0, 100.0, 300.0, 200.0);
    assert_eq!(
        toolbar_placement_local(plain, zero_bounds),
        toolbar_placement(plain, (TOOLBAR_WIDTH, TOOLBAR_HEIGHT), (1920.0, 1080.0))
    );
}

#[test]
fn double_click_window_uses_time_and_distance() {
    let now = Instant::now();
    let earlier = now - Duration::from_millis(100);
    assert!(is_within_double_click(
        point(10.0, 10.0),
        earlier,
        point(12.0, 11.0),
        now
    ));
    // 超距（> 4px 欧氏）不算双击。
    assert!(!is_within_double_click(
        point(10.0, 10.0),
        earlier,
        point(10.0 + DOUBLE_CLICK_SLOP + 1.0, 10.0),
        now
    ));
    // 超时不算双击。
    let much_earlier = now - Duration::from_millis(501);
    assert!(!is_within_double_click(
        point(10.0, 10.0),
        much_earlier,
        point(10.5, 10.5),
        now
    ));
}

#[test]
fn tool_index_round_trips_ts_tool_order() {
    // TS toolOrder：rectangle, ellipse, arrow, pen, mosaic, text。
    let order = [
        Tool::Rectangle,
        Tool::Ellipse,
        Tool::Arrow,
        Tool::Pen,
        Tool::Mosaic,
        Tool::Text,
    ];
    for (index, tool) in order.iter().enumerate() {
        assert_eq!(tool_index(*tool), Some(index));
        assert_eq!(tool_from_index(index as i32), Some(*tool));
    }
    assert_eq!(tool_index(Tool::Translation), None);
    assert_eq!(tool_from_index(-1), None);
    assert_eq!(tool_from_index(6), None);
}

#[test]
fn parse_hex_rgb_supports_six_and_three_digit_forms() {
    assert_eq!(parse_hex_rgb("#ff3355"), Some([0xff, 0x33, 0x55]));
    assert_eq!(parse_hex_rgb("#f53"), Some([0xff, 0x55, 0x33]));
    assert_eq!(parse_hex_rgb("#FFFFFF"), Some([0xff, 0xff, 0xff]));
    assert_eq!(parse_hex_rgb("ff3355"), None);
    assert_eq!(parse_hex_rgb("#12345"), None);
    assert_eq!(parse_hex_rgb("#zzzzzz"), None);
}

#[test]
fn annotation_layer_size_rounds_and_floors_at_one() {
    assert_eq!(
        annotation_layer_size(rect(0.0, 0.0, 100.0, 50.0), 1.0),
        (100, 50)
    );
    assert_eq!(
        annotation_layer_size(rect(0.0, 0.0, 100.5, 50.4), 2.0),
        (201, 101)
    );
    assert_eq!(annotation_layer_size(rect(0.0, 0.0, 0.2, 0.2), 1.0), (1, 1));
    // 非有限 / 非正缩放按 1 处理。
    assert_eq!(
        annotation_layer_size(rect(0.0, 0.0, 10.0, 5.0), f64::NAN),
        (10, 5)
    );
    assert_eq!(
        annotation_layer_size(rect(0.0, 0.0, 10.0, 5.0), 0.0),
        (10, 5)
    );
}

#[test]
fn session_virtual_bounds_spans_negative_coordinates() {
    let display = |x: f64, y: f64, width: f64, height: f64| SessionDisplay {
        rgba: RgbaImage::new(1, 1),
        bounds: rect(x, y, width, height),
        scale_factor: 1.0,
    };
    let bounds = session_virtual_bounds(&[
        display(0.0, 0.0, 1920.0, 1080.0),
        display(-1280.0, 100.0, 1280.0, 800.0),
    ]);
    assert_eq!(bounds, rect(-1280.0, 0.0, 3200.0, 1080.0));
    // 单显示器直通；空输入回退零矩形（core calculate_virtual_bounds 语义）。
    assert_eq!(
        session_virtual_bounds(&[display(5.0, 7.0, 100.0, 50.0)]),
        rect(5.0, 7.0, 100.0, 50.0)
    );
    assert_eq!(session_virtual_bounds(&[]), rect(0.0, 0.0, 0.0, 0.0));
}

#[test]
fn scale_annotation_maps_geometry_and_style_to_buffer_pixels() {
    let annotation = Annotation {
        id: "id".to_string(),
        tool: Tool::Rectangle,
        style: AnnotationStyle {
            color: "#ff3355".to_string(),
            font_size: 18.0,
            line_width: 3.0,
        },
        points: vec![point(10.0, 20.0), point(60.0, 70.0)],
        text: None,
    };
    let scaled = scale_annotation(&annotation, 1.5);
    assert_eq!(scaled.points, vec![point(15.0, 30.0), point(90.0, 105.0)]);
    assert_eq!(scaled.style.line_width, 4.5);
    assert_eq!(scaled.style.font_size, 27.0);
    assert_eq!(scaled.style.color, "#ff3355");
    assert_eq!(scaled.id, "id");
}

#[test]
fn compose_base_samples_intersecting_display_nearest() {
    // 单个 2x2 逻辑（3x2 物理，scale 1.5）显示器；选区即全显示器。
    let display = SessionDisplay {
        rgba: RgbaImage {
            width: 3,
            height: 2,
            data: vec![
                255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, //
                10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, //
            ],
        },
        bounds: rect(0.0, 0.0, 2.0, 2.0),
        scale_factor: 1.5,
    };
    let base = compose_base(&[display], rect(0.0, 0.0, 2.0, 2.0), 1.5);
    // 2x2 逻辑 @1.5 → 3x3 设备像素；底部越界行钳制到源图末行。
    assert_eq!((base.width, base.height), (3, 3));
    // 左上像素命中显示器 (0,0)；右下命中物理 (2,1)。
    assert_eq!(&base.data[0..4], &[255, 0, 0, 255]);
    let last = (base.height as usize - 1) * base.width as usize * 4 + (base.width as usize - 1) * 4;
    assert_eq!(&base.data[last..last + 4], &[70, 80, 90, 255]);
}

#[test]
fn compose_base_leaves_transparent_when_no_display_covers() {
    let base = compose_base(&[], rect(0.0, 0.0, 4.0, 4.0), 1.0);
    assert_eq!((base.width, base.height), (4, 4));
    assert!(base.data.iter().all(|byte| *byte == 0));
}

#[test]
fn color_to_hex_round_trips_parse_hex_rgb() {
    let hex = super::color_to_hex(slint::Color::from_rgb_u8(0xff, 0x33, 0x55));
    assert_eq!(hex, "#ff3355");
    assert_eq!(parse_hex_rgb(&hex), Some([0xff, 0x33, 0x55]));
}

// ---- M3 Task 8：模式→行为映射（TS screenshotController.ts:130-133 + 完成出口） ----

#[test]
fn mode_delay_table_matches_ts_constants() {
    // TS delayByMode：capture-delay-3 = 3000ms、capture-delay-5 = 5000ms；
    // capture / ocr 无延时。
    assert_eq!(ScreenshotMode::Capture.delay_ms(), None);
    assert_eq!(ScreenshotMode::CaptureDelay3.delay_ms(), Some(3000));
    assert_eq!(ScreenshotMode::CaptureDelay5.delay_ms(), Some(5000));
    assert_eq!(ScreenshotMode::Ocr.delay_ms(), None);
}

#[test]
fn mode_completion_exit_matches_ts_get_screenshot_completion_action() {
    // TS getScreenshotCompletionAction：ocr 模式 → OCR 出口，其余 → 复制。
    assert!(!ScreenshotMode::Capture.completion_action_is_ocr());
    assert!(!ScreenshotMode::CaptureDelay3.completion_action_is_ocr());
    assert!(!ScreenshotMode::CaptureDelay5.completion_action_is_ocr());
    assert!(ScreenshotMode::Ocr.completion_action_is_ocr());
}

// ---- M3 Task 8：翻译分派决策（TS runScreenshotTranslation 的分派段） ----

fn ocr(status: OcrStatus, text: Option<&str>, message: Option<&str>) -> OcrOutcome {
    OcrOutcome {
        status,
        language: "en-US".to_string(),
        text: text.map(str::to_string),
        lines: Vec::new(),
        message: message.map(str::to_string),
    }
}

#[test]
fn translation_step_translates_on_success_with_text() {
    // success + 非空文本 → 翻译；源语言 = 请求语言（与目标不同）。
    let outcome = ocr(OcrStatus::Success, Some("  hello  "), None);
    assert_eq!(
        translation_step(&outcome, "en-US", "zh-CN"),
        TranslationStep::Translate {
            source_language: "en-US".to_string(),
            text: "  hello  ".to_string()
        }
    );
}

#[test]
fn translation_step_reports_no_ocr_text_verbatim() {
    // success + 空白文本 → 逐字 "No OCR text found."（unavailable）。
    for text in [None, Some(""), Some("   ")] {
        let outcome = ocr(OcrStatus::Success, text, None);
        assert_eq!(
            translation_step(&outcome, "en-US", "zh-CN"),
            TranslationStep::Unavailable {
                message: NO_OCR_TEXT_MESSAGE.to_string()
            }
        );
    }
}

#[test]
fn translation_step_passes_through_unavailable_and_error() {
    let outcome = ocr(
        OcrStatus::Unavailable,
        None,
        Some("Windows OCR is not available."),
    );
    assert_eq!(
        translation_step(&outcome, "en-US", "zh-CN"),
        TranslationStep::Unavailable {
            message: "Windows OCR is not available.".to_string()
        }
    );
    let outcome = ocr(OcrStatus::Error, None, Some("boom"));
    assert_eq!(
        translation_step(&outcome, "en-US", "zh-CN"),
        TranslationStep::Error {
            message: "boom".to_string()
        }
    );
}

// ---- M3 Task 8：翻译结果视图映射（TS TranslationPanel 三态） ----

/// 评审 Finding 3：在线翻译同意门 fail-closed——默认拒绝（consent=false 必须被
/// 拒并携带拒绝文案），仅显式同意放行。
#[test]
fn online_translation_gate_denies_until_consented() {
    const CONSENT_MESSAGE: &str = "Translation sends this locally recognized OCR text to the Google online translation service (up to 2,000 characters). Continue?";
    // 未同意 → Err(consent 文案)：on_translate 据此直接返回不可用结果，
    // 不做 OCR、不外发文字。
    assert_eq!(
        online_translation_gate(false, CONSENT_MESSAGE),
        Err(CONSENT_MESSAGE.to_string())
    );
    // 同意 → 放行。
    assert_eq!(online_translation_gate(true, CONSENT_MESSAGE), Ok(()));
}

#[test]
fn translation_view_maps_three_outcome_states() {
    let success = TranslationOutcome {
        status: TranslationStatus::Success,
        ocr_language: "en-US".into(),
        target_language: "zh-CN".into(),
        source_text: Some("hello".into()),
        translated_text: Some("你好".into()),
        message: None,
    };
    assert_eq!(
        translation_view(&success, "hello"),
        TranslateView {
            success: true,
            source_text: "hello".to_string(),
            target_text: "你好".to_string(),
            message: String::new(),
        }
    );
    let unavailable = TranslationOutcome {
        status: TranslationStatus::Unavailable,
        ocr_language: "en-US".into(),
        target_language: "zh-CN".into(),
        source_text: None,
        translated_text: None,
        message: Some(NO_OCR_TEXT_MESSAGE.into()),
    };
    let view = translation_view(&unavailable, "");
    assert!(!view.success);
    assert_eq!(view.message, NO_OCR_TEXT_MESSAGE);
    let error = TranslationOutcome {
        status: TranslationStatus::Error,
        ocr_language: "en-US".into(),
        target_language: "zh-CN".into(),
        source_text: None,
        translated_text: None,
        message: Some("Online translation failed.".into()),
    };
    assert_eq!(
        translation_view(&error, "").message,
        "Online translation failed."
    );
}

// ---- M3 Task 8：置顶窗图像等比缩放（不放大、尺寸下限 1） ----

#[test]
fn pin_window_image_scales_down_only_and_keeps_aspect() {
    // 小图不放大。
    let tiny = RgbaImage::new(4, 3);
    let (width, height, scaled) = pin_window_image(&tiny);
    assert_eq!((width, height), (4.0, 3.0));
    assert_eq!((scaled.width, scaled.height), (4, 3));
    // 大图等比缩小到上限框内：1000x500 → 320x160。
    let big = RgbaImage::new(1000, 500);
    let (width, height, scaled) = pin_window_image(&big);
    assert_eq!((width, height), (320.0, 160.0));
    assert_eq!((scaled.width, scaled.height), (320, 160));
    // 内容采样：纯色图缩放后仍为纯色。
    let mut solid = RgbaImage::new(600, 300);
    for pixel in solid.data.chunks_exact_mut(4) {
        pixel.copy_from_slice(&[10, 20, 30, 255]);
    }
    let (_, _, scaled) = pin_window_image(&solid);
    assert!(scaled
        .data
        .chunks_exact(4)
        .all(|pixel| pixel == [10, 20, 30, 255]));
}

// ---- M3 Task 9：截图系统命令（TS createScreenshotCommands + modeByCommand） ----

/// 四条系统命令逐字对齐 TS screenshotCommands.ts：id / source / run-system /
/// 标题 / 副标题 / 关键词 / payload（标题英文系 TS 硬编码，i18n 表不含这些 id）。
#[test]
fn screenshot_system_commands_match_ts() {
    let commands = screenshot_system_commands();
    assert_eq!(commands.len(), 4);
    let mut by_id = commands
        .iter()
        .map(|command| (command.id.as_str(), command))
        .collect::<Vec<_>>();
    by_id.sort_by_key(|(id, _)| *id);

    let (capture_id, capture) = by_id[0];
    assert_eq!(capture_id, "system.screenshot.capture");
    assert_eq!(capture.source, CommandSource::System);
    assert_eq!(capture.title, "Capture Screenshot");
    assert_eq!(
        capture.subtitle.as_deref(),
        Some("Select an area to capture")
    );
    assert_eq!(
        capture.keywords,
        ["screenshot", "capture", "screen capture", "截图", "截圖"]
    );
    assert_eq!(capture.action.action_type, CommandActionType::RunSystem);
    assert_eq!(
        capture
            .action
            .payload
            .get("command")
            .and_then(|v| v.as_str()),
        Some("screenshot.capture")
    );

    let (delay3_id, delay3) = by_id[1];
    assert_eq!(delay3_id, "system.screenshot.capture-delay-3");
    assert_eq!(delay3.title, "Capture Screenshot in 3 Seconds");
    assert_eq!(
        delay3.subtitle.as_deref(),
        Some("Start a delayed screenshot capture")
    );
    assert_eq!(
        delay3.keywords,
        [
            "screenshot",
            "capture",
            "delay",
            "3 seconds",
            "延时截图",
            "延遲截圖"
        ]
    );
    assert_eq!(delay3.action.action_type, CommandActionType::RunSystem);
    assert_eq!(
        delay3
            .action
            .payload
            .get("command")
            .and_then(|v| v.as_str()),
        Some("screenshot.capture-delay-3")
    );

    let (delay5_id, delay5) = by_id[2];
    assert_eq!(delay5_id, "system.screenshot.capture-delay-5");
    assert_eq!(delay5.title, "Capture Screenshot in 5 Seconds");
    assert_eq!(
        delay5.subtitle.as_deref(),
        Some("Start a delayed screenshot capture")
    );
    assert_eq!(
        delay5.keywords,
        [
            "screenshot",
            "capture",
            "delay",
            "5 seconds",
            "延时截图",
            "延遲截圖"
        ]
    );
    assert_eq!(
        delay5
            .action
            .payload
            .get("command")
            .and_then(|v| v.as_str()),
        Some("screenshot.capture-delay-5")
    );

    let (ocr_id, ocr) = by_id[3];
    assert_eq!(ocr_id, "system.screenshot.ocr");
    assert_eq!(ocr.title, "Recognize Text from Screenshot");
    assert_eq!(ocr.subtitle.as_deref(), Some("Capture an area and run OCR"));
    assert_eq!(
        ocr.keywords,
        [
            "screenshot",
            "ocr",
            "text recognition",
            "截图",
            "截圖",
            "文字识别",
            "文字辨識",
            "OCR"
        ]
    );
    assert_eq!(
        ocr.action.payload.get("command").and_then(|v| v.as_str()),
        Some("screenshot.ocr")
    );
}

/// payload → 模式映射对齐 TS index.ts `modeByCommand`；未知命令返回 `None`
/// （TS 抛 Unsupported screenshot command）。
#[test]
fn screenshot_mode_for_system_command_follows_ts_map() {
    assert_eq!(
        screenshot_mode_for_system_command("screenshot.capture"),
        Some(ScreenshotMode::Capture)
    );
    assert_eq!(
        screenshot_mode_for_system_command("screenshot.capture-delay-3"),
        Some(ScreenshotMode::CaptureDelay3)
    );
    assert_eq!(
        screenshot_mode_for_system_command("screenshot.capture-delay-5"),
        Some(ScreenshotMode::CaptureDelay5)
    );
    assert_eq!(
        screenshot_mode_for_system_command("screenshot.ocr"),
        Some(ScreenshotMode::Ocr)
    );
    for unknown in ["", "open-settings", "screenshot", "screenshot.unknown"] {
        assert_eq!(screenshot_mode_for_system_command(unknown), None);
    }
}

/// 每条系统命令的 payload 都能映射到模式（注册表与分派不脱节），延时与
/// 完成出口语义成立（ocr → OCR 出口，其余 → 复制）。
#[test]
fn every_screenshot_system_command_maps_to_a_live_mode() {
    for command in screenshot_system_commands() {
        let payload = command
            .action
            .payload
            .get("command")
            .and_then(|value| value.as_str())
            .expect("payload command must be a string");
        let mode = screenshot_mode_for_system_command(payload)
            .unwrap_or_else(|| panic!("{payload} must map to a mode"));
        match payload {
            "screenshot.capture" => assert_eq!(mode.delay_ms(), None),
            "screenshot.capture-delay-3" => assert_eq!(mode.delay_ms(), Some(3000)),
            "screenshot.capture-delay-5" => assert_eq!(mode.delay_ms(), Some(5000)),
            "screenshot.ocr" => assert!(mode.completion_action_is_ocr()),
            other => panic!("unexpected payload {other}"),
        }
        if payload != "screenshot.ocr" {
            assert!(!mode.completion_action_is_ocr());
        }
    }
}
