//! Screenshot feature pure logic.
//!
//! Task 1 of the M3 plan ports the annotation state machine
//! ([`state`], from `apps/desktop/src/renderer/src/screenshot/screenshotState.ts`).
//! Task 2 adds annotation rasterization ([`raster`], from
//! `screenshotCanvas.ts`). Task 3 adds capture geometry ([`geometry`], from
//! `screenshotCapture.ts`) and the export compositor + PNG/JPEG encoders
//! ([`encode`]).

pub mod encode;
pub mod geometry;
pub mod raster;
pub mod state;
pub mod translate;

pub use encode::{
    compose_export, get_translation_overlay_line_height, get_translation_overlay_padding,
    get_translation_overlay_text_origin, jpeg_encode_rgba, png_encode_rgba,
    wrap_translation_overlay_text, DEFAULT_JPEG_QUALITY,
};
pub use geometry::{
    calculate_capture_bounds, calculate_thumbnail_size, calculate_virtual_bounds,
    select_displays_for_capture, ScreenshotDisplay, ThumbnailSize,
};
pub use raster::{
    draw_annotation, mosaic_block_size, pixelate_region, RgbaImage, MOSAIC_BASE_BLOCK_SIZE,
    MOSAIC_MIN_BLOCK_SIZE,
};
pub use state::{
    initial_state, is_non_empty_rect, is_ready_to_complete, normalize_rect, reducer, Annotation,
    AnnotationInput, AnnotationStyle, Point, Rect, ScreenshotAction, ScreenshotState, TextPrompt,
    Tool, TEXT_PROMPT_MAX_DRAG_DISTANCE,
};
pub use translate::{
    normalize_text_for_online_translation, parse_google_translated_text,
    parse_my_memory_translated_text, to_online_language, translate_text, TranslationHttpError,
    TranslationHttpRequest, TranslationOutcome, TranslationStatus, DEFAULT_TRANSLATION_TIMEOUT_MS,
    GOOGLE_TRANSLATE_ENDPOINT, MAX_TRANSLATION_TEXT_LENGTH, NO_OCR_TEXT_MESSAGE,
    NO_TRANSLATED_TEXT_MESSAGE, ONLINE_TRANSLATION_UNAVAILABLE_MESSAGE, TRANSLATION_FAILED_MESSAGE,
};
