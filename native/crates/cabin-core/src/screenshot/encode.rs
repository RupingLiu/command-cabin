//! Screenshot export: geometry-independent compositor plus PNG/JPEG encoders.
//!
//! [`compose_export`] is the Rust counterpart of the drawing half of TS
//! `composeScreenshotSelection` (`screenshotCanvas.ts:75-113`): given a base
//! screenshot buffer and the committed annotations, it burns the annotations in
//! and returns a fresh buffer ready for [`png_encode_rgba`] /
//! [`jpeg_encode_rgba`]. The TS save path encodes via
//! `canvas.toDataURL('image/png')` / `canvas.toDataURL('image/jpeg', 0.92)`
//! (the `jpegQuality = 0.92` default at `screenshotCanvas.ts:80`; the overlay
//! never overrides it), so [`DEFAULT_JPEG_QUALITY`] ports that value.
//!
//! Semantics and deliberate divergences:
//!
//! * **Buffer space / mosaic parity.** `base` must be in *device pixels*
//!   (selection logical size × `output_scale`, the TS `outputScale` from
//!   `getSelectionOutputScale`), and the same `output_scale` is passed through
//!   to [`draw_annotation`]. Mosaic parity requires both halves of that
//!   contract: the mosaic block size is `max(4, round(8 * output_scale))` in
//!   buffer coordinates, so pre-scaling the geometry without passing the scale
//!   (or scaling the buffer without scaling the geometry) yields the wrong
//!   cell size. Geometry handed to the raster pass is pre-transformed here
//!   (TS `scalePoint`/`scaleRect`/`scaleStyle`).
//!
//! * **Two passes, text second.** [`draw_annotation`] deliberately skips
//!   `Tool::Text` / `Tool::Translation` (see the `raster` module docs), so this
//!   module runs a **second vector pass** that redraws them on top of the
//!   rasterized buffer:
//!   - *Text* ports TS `drawText` + the style application: fontSize in px
//!     (scaled by `output_scale`), `textBaseline: 'top'`, line height
//!     `fontSize * 1.2`, lines split on `\n`, anchored at `points[0]`,
//!     fill color `style.color`.
//!   - *Translation* ports TS `drawTranslationOverlay`: white-filled rect +
//!     the annotation color, line height `fontSize * 1.35`
//!     ([`get_translation_overlay_line_height`]), text wrapped by the ported
//!     `wrapTranslationOverlayText` ([`wrap_translation_overlay_text`]) and
//!     positioned by the ported `getTranslationOverlayTextOrigin`
//!     ([`get_translation_overlay_text_origin`]) — all from
//!     `translationOverlay.ts`, with the wrapped rect/fontSize in device
//!     pixels (line breaking is scale-invariant because width and font size
//!     scale together, so breaks match the TS overlay).
//!
//! * **Glyphs.** Text is rasterized with the pure-Rust `fontdue` crate and an
//!   embedded Liberation Sans Regular (SIL Open Font License 1.1, committed
//!   next to this crate under `native/assets/fonts/` with its license text —
//!   401 KB, see `LICENSE-LiberationSans.txt`). Liberation Sans is a
//!   `sans-serif` metric-compatible substitute, matching the TS
//!   `font: '<size>px sans-serif'` intent for Latin/Greek/Cyrillic text.
//!   Missing glyphs (notably CJK — the browser would fall back to a system
//!   CJK font here) are skipped entirely: no advance, no notdef box. Canvas
//!   kerning is approximated with the font's `kern` table when present.
//!   Baseline placement approximates the canvas `top` baseline as
//!   `line_top + ascent(px)` (hhea ascent); a browser engine's exact
//!   em-box positioning may differ by a fraction of a pixel.
//!
//! * **Z-order divergence.** TS composites strictly in annotation order, so a
//!   stroke drawn after a text annotation covers it. Here every
//!   text/translation annotation composites above *all* raster annotations
//!   (the mandated second pass); relative order among the text/translation
//!   annotations themselves is preserved. Accepted — tests lock it in.
//!
//! * **Fill/edge divergence.** The translation white rect fills hard-edged
//!   rounded pixel bounds (`[round(x), round(x + width))`), where a canvas
//!   would antialias fractional edges. Style colors follow the `raster`
//!   module's model: an unparseable color skips the drawing instead of
//!   silently keeping a previous style.
//!
//! * **Encoders.** PNG is lossless RGBA8. JPEG drops the alpha channel
//!   without compositing (the `image` crate JPEG encoder takes RGB only;
//!   screenshot buffers are opaque in practice — a canvas would blend
//!   transparent pixels toward black instead) and maps the canvas-style
//!   `0..=1` quality to the libjpeg-style
//!   `0..=100` scale the same way Chromium does (`round(q * 100)`, clamped);
//!   a non-finite quality falls back to the default, matching the HTML spec's
//!   "NaN → default" rule. Both encoders write to an in-memory `Vec<u8>`,
//!   which cannot fail for a well-formed [`RgbaImage`] (length is guaranteed
//!   to be `width * height * 4`), so failures are unrecoverable bugs and the
//!   API returns plain bytes.

use std::sync::OnceLock;

use fontdue::{Font, FontSettings};
use image::{codecs::jpeg::JpegEncoder, codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};

use super::raster::{draw_annotation, parse_color, RgbaImage};
use super::state::{Annotation, AnnotationStyle, Point, Rect, Tool};

/// TS `jpegQuality = 0.92` default in `composeScreenshotSelection`
/// (screenshotCanvas.ts:80).
pub const DEFAULT_JPEG_QUALITY: f64 = 0.92;

/// Embedded Liberation Sans Regular 2.1.5
/// (`native/assets/fonts/LiberationSans-Regular.ttf`, SIL OFL 1.1 — see
/// `native/assets/fonts/LICENSE-LiberationSans.txt`).
const FONT_BYTES: &[u8] = include_bytes!("../../../../assets/fonts/LiberationSans-Regular.ttf");

/// Upper bound for the per-glyph pixel size we are willing to rasterize.
/// Anything above this is pathological serde input (a real export renders at
/// display resolution); rasterizing it would attempt absurd allocations.
const MAX_FONT_PX: f32 = 10_000.0;

/// Parses the embedded font once per process. `Font` is plain data and safe to
/// share across threads.
fn builtin_font() -> &'static Font {
    static FONT: OnceLock<Font> = OnceLock::new();
    FONT.get_or_init(|| {
        Font::from_bytes(
            FONT_BYTES,
            FontSettings {
                collection_index: 0,
                // Geometry optimization target; rendering works at any px.
                scale: 48.0,
                load_substitutions: true,
            },
        )
        .expect("built-in Liberation Sans Regular must parse")
    })
}

/// Encodes `img` as a lossless PNG (`canvas.toDataURL('image/png')`).
pub fn png_encode_rgba(img: &RgbaImage) -> Vec<u8> {
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(&img.data, img.width, img.height, ExtendedColorType::Rgba8)
        .expect("in-memory PNG encoding of a well-formed RGBA buffer cannot fail");
    bytes
}

/// Encodes `img` as a JPEG (`canvas.toDataURL('image/jpeg', quality)`).
///
/// `quality` uses the canvas `0.0..=1.0` scale (see
/// [`DEFAULT_JPEG_QUALITY`]); values outside the range are clamped and a
/// non-finite quality falls back to [`DEFAULT_JPEG_QUALITY`]. The alpha
/// channel is dropped without compositing (JPEG has none; screenshot buffers
/// are opaque in practice — a canvas would blend transparent pixels toward
/// black instead).
pub fn jpeg_encode_rgba(img: &RgbaImage, quality: f64) -> Vec<u8> {
    let percent = if quality.is_finite() {
        (quality.clamp(0.0, 1.0) * 100.0).round()
    } else {
        DEFAULT_JPEG_QUALITY * 100.0
    };
    // The image crate's JPEG encoder has no RGBA input, so strip the alpha
    // channel first (keep the raw RGB values; see the doc note above).
    let mut rgb = Vec::with_capacity(img.data.len() / 4 * 3);
    for pixel in img.data.as_chunks::<4>().0 {
        rgb.extend_from_slice(&pixel[..3]);
    }
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, percent as u8)
        .write_image(&rgb, img.width, img.height, ExtendedColorType::Rgb8)
        .expect("in-memory JPEG encoding of a well-formed RGB buffer cannot fail");
    bytes
}

/// Burns `annotations` into a copy of the device-pixel `base` buffer and
/// returns the result. See the module docs for the two-pass contract and the
/// `output_scale` / mosaic-parity requirements.
pub fn compose_export(
    base: &RgbaImage,
    annotations: &[Annotation],
    output_scale: f64,
) -> RgbaImage {
    let mut img = RgbaImage {
        width: base.width,
        height: base.height,
        data: base.data.clone(),
    };

    // Pass 1: raster tools (rectangle/ellipse/arrow/pen/mosaic). Geometry is
    // pre-scaled into buffer coordinates here (TS scalePoint/scaleRect/
    // scaleStyle); `output_scale` still flows to draw_annotation for the
    // device-pixel mosaic block size, and the scaled font size is forwarded
    // as the reserved text_font_scale argument.
    for annotation in annotations {
        let scaled = scale_annotation(annotation, output_scale);
        draw_annotation(&mut img, &scaled, scaled.style.font_size, output_scale);
    }

    // Pass 2: vector text (Tool::Text / Tool::Translation) on top.
    for annotation in annotations {
        draw_text_annotation(&mut img, annotation, output_scale);
    }

    img
}

/// TS `scalePoint`/`scaleRect`/`scaleStyle` folded into one annotation copy.
fn scale_annotation(annotation: &Annotation, scale: f64) -> Annotation {
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

/// Dispatches the second vector pass for one annotation (no-op for raster
/// tools, which pass 1 already handled).
fn draw_text_annotation(img: &mut RgbaImage, annotation: &Annotation, output_scale: f64) {
    match annotation.tool {
        Tool::Text => draw_text_annotation_inner(img, annotation, output_scale),
        Tool::Translation => draw_translation_annotation(img, annotation, output_scale),
        _ => {}
    }
}

/// TS `drawText`: `textBaseline: 'top'`, `lineHeight = fontSize * 1.2`,
/// lines split on `\n`, anchored at `points[0]` with `style.color`.
fn draw_text_annotation_inner(img: &mut RgbaImage, annotation: &Annotation, output_scale: f64) {
    let Some(text) = annotation.text.as_deref() else {
        return;
    };
    let Some(&anchor) = annotation.points.first() else {
        return;
    };
    // TS scaleStyle scales fontSize; scalePoint scales the anchor.
    let font_px = annotation.style.font_size * output_scale;
    let line_height = font_px * 1.2;
    let Some(color) = parse_color(&annotation.style.color) else {
        return;
    };

    for (index, line) in text.split('\n').enumerate() {
        draw_glyph_line(
            img,
            line,
            anchor.x * output_scale,
            anchor.y * output_scale + index as f64 * line_height,
            font_px,
            color,
        );
    }
}

/// TS `drawTranslationOverlay`: opaque white rect over the (scaled)
/// annotation rect, then the annotation color at
/// `getTranslationOverlayTextOrigin` with wrapped lines and a
/// `fontSize * 1.35` line height.
fn draw_translation_annotation(img: &mut RgbaImage, annotation: &Annotation, output_scale: f64) {
    let Some(text) = annotation.text.as_deref() else {
        return;
    };
    let Some(rect) = annotation.rect() else {
        return;
    };
    let scaled = Rect {
        x: rect.x * output_scale,
        y: rect.y * output_scale,
        width: rect.width * output_scale,
        height: rect.height * output_scale,
    };
    let Some(color) = parse_color(&annotation.style.color) else {
        return;
    };
    let font_px = annotation.style.font_size * output_scale;

    fill_rect(img, &scaled, [255, 255, 255, 255]);

    let line_height = get_translation_overlay_line_height(font_px);
    let lines = wrap_translation_overlay_text(text, &scaled, font_px);
    let origin = get_translation_overlay_text_origin(&scaled, font_px, lines.len());

    for (index, line) in lines.iter().enumerate() {
        draw_glyph_line(
            img,
            line,
            origin.x,
            origin.y + index as f64 * line_height,
            font_px,
            color,
        );
    }
}

/// TS `getTranslationOverlayPadding` (translationOverlay.ts:31-33).
pub fn get_translation_overlay_padding(font_size: f64) -> f64 {
    (font_size * 0.55).round().max(8.0)
}

/// TS `getTranslationOverlayLineHeight` (translationOverlay.ts:35-37).
pub fn get_translation_overlay_line_height(font_size: f64) -> f64 {
    font_size * 1.35
}

/// TS `getTranslationOverlayTextOrigin` (translationOverlay.ts:39-52).
pub fn get_translation_overlay_text_origin(
    rect: &Rect,
    font_size: f64,
    line_count: usize,
) -> Point {
    let padding = get_translation_overlay_padding(font_size);
    let line_height = get_translation_overlay_line_height(font_size);
    let text_block_height = line_count.max(1) as f64 * line_height;

    Point {
        x: rect.x + padding,
        y: rect.y + padding.max((rect.height - text_block_height) / 2.0),
    }
}

/// TS `wrapTranslationOverlayText` (translationOverlay.ts:54-85): greedy
/// width-unit wrapping where CJK characters count 1 unit, other characters
/// 0.55 (tab 2, space 0.35), against `maxLineUnits` derived from the rect
/// width and font size. Paragraphs split on `\n` (optionally preceded by
/// `\r`).
pub fn wrap_translation_overlay_text(text: &str, rect: &Rect, font_size: f64) -> Vec<String> {
    let max_line_units = {
        let available_width =
            (rect.width - get_translation_overlay_padding(font_size) * 2.0).max(1.0);
        (available_width / font_size.max(1.0)).max(4.0)
    };

    let mut lines: Vec<String> = Vec::new();
    for paragraph in text.trim().split('\n') {
        let paragraph = paragraph.strip_suffix('\r').unwrap_or(paragraph);
        let mut current_line = String::new();
        let mut current_units = 0.0;

        for character in paragraph.trim().chars() {
            let next_units = get_character_width_units(character);
            if !current_line.is_empty() && current_units + next_units > max_line_units {
                lines.push(std::mem::take(&mut current_line));
                // TS `character.trimStart()`: a whitespace break character is
                // dropped entirely.
                if !character.is_whitespace() {
                    current_line.push(character);
                }
                current_units = get_line_width_units(&current_line);
            } else {
                current_line.push(character);
                current_units += next_units;
            }
        }

        if !current_line.is_empty() {
            lines.push(current_line);
        }
    }

    if lines.is_empty() {
        vec![text.trim().to_string()]
    } else {
        lines
    }
}

/// TS `isCjkCharacter` (`/[\u3000-\u9fff\uf900-\ufaff]/u`).
fn is_cjk_character(character: char) -> bool {
    let code = character as u32;
    (0x3000..=0x9FFF).contains(&code) || (0xF900..=0xFAFF).contains(&code)
}

/// TS `getCharacterWidthUnits`.
fn get_character_width_units(character: char) -> f64 {
    if character == '\t' {
        2.0
    } else if character == ' ' {
        0.35
    } else if is_cjk_character(character) {
        1.0
    } else {
        0.55
    }
}

/// TS `getLineWidthUnits` (sums width units over the line's code points).
fn get_line_width_units(line: &str) -> f64 {
    line.chars().map(get_character_width_units).sum()
}

/// Fills `[round(x), round(x + width)) × [round(y), round(y + height))` with
/// an opaque color (canvas `fillRect` without fractional-edge AA; see the
/// module docs).
fn fill_rect(img: &mut RgbaImage, rect: &Rect, color: [u8; 4]) {
    let left = rect.x.round() as i64;
    let top = rect.y.round() as i64;
    let right = (rect.x + rect.width).round() as i64;
    let bottom = (rect.y + rect.height).round() as i64;
    let min_x = left.max(0);
    let min_y = top.max(0);
    let max_x = right.min(img.width as i64);
    let max_y = bottom.min(img.height as i64);
    for y in min_y..max_y {
        for x in min_x..max_x {
            let start = (y as usize * img.width as usize + x as usize) * 4;
            img.data[start..start + 4].copy_from_slice(&color);
        }
    }
}

/// Draws one line of text with the embedded font: `origin_x`/`line_top` are
/// the TS `fillText(line, x, y)` coordinates in device pixels with the canvas
/// `top` text baseline, approximated as `line_top + ascent(px)`.
fn draw_glyph_line(
    img: &mut RgbaImage,
    line: &str,
    origin_x: f64,
    line_top: f64,
    font_px: f64,
    color: [u8; 4],
) {
    if line.is_empty() {
        return;
    }
    let px = font_px as f32;
    if !px.is_finite() || px <= 0.0 || px > MAX_FONT_PX {
        return;
    }
    let font = builtin_font();
    // Canvas `top` baseline: the em-box top sits on `line_top`.
    let ascent = font
        .horizontal_line_metrics(px)
        .map(|metrics| metrics.ascent as f64)
        .unwrap_or_else(|| font_px * 0.8);
    let baseline = line_top + ascent;
    let mut pen_x = origin_x;

    let mut previous: Option<char> = None;
    for character in line.chars() {
        let glyph_index = font.lookup_glyph_index(character);
        if glyph_index == 0 {
            // Missing glyph (e.g. CJK): TS would fall back to a system font;
            // we skip the glyph entirely (see module docs).
            previous = None;
            continue;
        }
        // Canvas applies kerning by default; fontdue exposes the legacy kern
        // table for it.
        if let Some(previous) = previous {
            if let Some(kern) = font.horizontal_kern(previous, character, px) {
                pen_x += kern as f64;
            }
        }
        let (metrics, coverage) = font.rasterize_indexed(glyph_index, px);
        // fontdue bitmap coordinates: `xmin` offsets the left edge from the
        // pen, `ymin` offsets the bottom edge from the baseline (negative
        // below it).
        blit_glyph(
            img,
            &coverage,
            metrics.width,
            metrics.height,
            pen_x + metrics.xmin as f64,
            baseline - metrics.ymin as f64 - metrics.height as f64,
            color,
        );
        pen_x += metrics.advance_width as f64;
        previous = Some(character);
    }
}

/// Src-over composites a glyph coverage bitmap (row-major `u8` alphas) whose
/// top-left lands at (`left`, `top`).
fn blit_glyph(
    img: &mut RgbaImage,
    coverage: &[u8],
    width: usize,
    height: usize,
    left: f64,
    top: f64,
    color: [u8; 4],
) {
    let min_x = left.floor() as i64;
    let min_y = top.floor() as i64;
    for row in 0..height {
        for column in 0..width {
            let alpha = coverage[row * width + column];
            if alpha == 0 {
                continue;
            }
            let x = min_x + column as i64;
            let y = min_y + row as i64;
            if x < 0 || y < 0 || x >= img.width as i64 || y >= img.height as i64 {
                continue;
            }
            let coverage_fraction = alpha as f64 / 255.0;
            let start = (y as usize * img.width as usize + x as usize) * 4;
            let pixel = &mut img.data[start..start + 4];
            for (offset, &source) in color.iter().enumerate() {
                let blended = source as f64 * coverage_fraction
                    + pixel[offset] as f64 * (1.0 - coverage_fraction);
                pixel[offset] = blended.round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screenshot::state::{AnnotationStyle, Tool};

    const BG: [u8; 4] = [16, 32, 48, 255];
    const RED: [u8; 4] = [255, 51, 85, 255];
    /// `#111827`, the TS translation text color.
    const DARK: [u8; 4] = [17, 24, 39, 255];
    const WHITE: [u8; 4] = [255, 255, 255, 255];

    fn solid(width: u32, height: u32, color: [u8; 4]) -> RgbaImage {
        let mut image = RgbaImage::new(width, height);
        for pixel in image.data.chunks_exact_mut(4) {
            pixel.copy_from_slice(&color);
        }
        image
    }

    /// Position-derived pattern matching the raster test helper.
    fn patterned(width: u32, height: u32) -> RgbaImage {
        let mut image = RgbaImage::new(width, height);
        for y in 0..height {
            for x in 0..width {
                let start = (y as usize * width as usize + x as usize) * 4;
                image.data[start] = (x * 8 % 256) as u8;
                image.data[start + 1] = (y * 8 % 256) as u8;
                image.data[start + 2] = 7;
                image.data[start + 3] = 255;
            }
        }
        image
    }

    fn style(color: &str, font_size: f64, line_width: f64) -> AnnotationStyle {
        AnnotationStyle {
            color: color.to_string(),
            font_size,
            line_width,
        }
    }

    fn point(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    fn corners(x: f64, y: f64, width: f64, height: f64) -> Vec<Point> {
        vec![point(x, y), point(x + width, y + height)]
    }

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    /// Counts pixels that differ from the solid background and returns them
    /// as `(x, y, pixel)` triples.
    fn changed_pixels(image: &RgbaImage, base: [u8; 4]) -> Vec<(u32, u32, [u8; 4])> {
        let mut changed = Vec::new();
        for y in 0..image.height {
            for x in 0..image.width {
                let pixel = image.pixel(x, y);
                if pixel != base {
                    changed.push((x, y, pixel));
                }
            }
        }
        changed
    }

    #[test]
    fn png_round_trip_preserves_dimensions_and_pixels() {
        let mut image = RgbaImage::new(4, 3);
        for y in 0..3u32 {
            for x in 0..4u32 {
                let start = (y as usize * 4 + x as usize) * 4;
                image.data[start..start + 4].copy_from_slice(&[
                    (x * 60) as u8,
                    (y * 80) as u8,
                    (x * y * 13) as u8,
                    200,
                ]);
            }
        }
        // Corner extremes, including full transparency.
        image.data[0..4].copy_from_slice(&[0, 0, 0, 0]);
        image.data[44..48].copy_from_slice(&[255, 255, 255, 255]);

        let encoded = png_encode_rgba(&image);
        let decoded = image::load_from_memory(&encoded).expect("decode png");
        assert_eq!(decoded.width(), 4);
        assert_eq!(decoded.height(), 3);
        let rgba = decoded.to_rgba8();
        for y in 0..3u32 {
            for x in 0..4u32 {
                assert_eq!(
                    rgba.get_pixel(x, y),
                    &image::Rgba(image.pixel(x, y)),
                    "pixel ({x},{y})"
                );
            }
        }
    }

    #[test]
    fn jpeg_output_starts_with_soi_marker_and_decodes() {
        let image = solid(8, 8, [200, 30, 40, 255]);
        let encoded = jpeg_encode_rgba(&image, DEFAULT_JPEG_QUALITY);

        // SOI marker.
        assert_eq!(&encoded[..2], &[0xFF, 0xD8]);
        let decoded = image::load_from_memory(&encoded).expect("decode jpeg");
        assert_eq!(decoded.width(), 8);
        assert_eq!(decoded.height(), 8);
        // Lossy format: assert the solid red-ish region stays dominant in red.
        let rgba = decoded.to_rgba8();
        let pixel = rgba.get_pixel(4, 4);
        assert!(pixel[0] > pixel[1] && pixel[0] > pixel[2]);
    }

    #[test]
    fn jpeg_quality_matches_ts_default_and_tolerates_out_of_range_input() {
        assert_eq!(DEFAULT_JPEG_QUALITY, 0.92);
        let image = solid(8, 8, [200, 30, 40, 255]);
        for quality in [
            0.0,
            1.0,
            DEFAULT_JPEG_QUALITY,
            -1.0,
            2.0,
            f64::NAN,
            f64::INFINITY,
        ] {
            let encoded = jpeg_encode_rgba(&image, quality);
            assert_eq!(&encoded[..2], &[0xFF, 0xD8], "quality {quality}");
            assert!(
                image::load_from_memory(&encoded).is_ok(),
                "quality {quality}"
            );
        }
    }

    #[test]
    fn compose_export_without_annotations_copies_the_base() {
        let base = patterned(12, 9);
        let composed = compose_export(&base, &[], 1.0);
        assert_eq!(composed.width, 12);
        assert_eq!(composed.height, 9);
        assert_eq!(composed.data, base.data);
    }

    #[test]
    fn compose_export_draws_raster_annotations_with_scaled_geometry() {
        let base = solid(48, 48, BG);
        // Logical rect (5, 5, 10, 10) at output_scale 2 → device (10, 10, 20, 20).
        let annotation = Annotation {
            id: "r".to_string(),
            tool: Tool::Rectangle,
            style: style("#ff3355", 18.0, 3.0),
            points: corners(5.0, 5.0, 10.0, 10.0),
            text: None,
        };

        let composed = compose_export(&base, &[annotation], 2.0);

        // Stroke centerline on the scaled outline (device px).
        assert_eq!(composed.pixel(10, 20), RED);
        assert_eq!(composed.pixel(20, 10), RED);
        assert_eq!(composed.pixel(30, 20), RED);
        assert_eq!(composed.pixel(20, 30), RED);
        // Interior and outside stay background.
        assert_eq!(composed.pixel(20, 20), BG);
        // Half of the scaled line width is 3 device px, so (8, 20) is inside
        // the stroke; (5, 20) is 4.5 px from the centerline and stays clean.
        assert_eq!(composed.pixel(5, 20), BG);
    }

    #[test]
    fn compose_export_renders_text_annotations_with_the_builtin_font() {
        let base = solid(64, 40, BG);
        let annotation = Annotation {
            id: "t".to_string(),
            tool: Tool::Text,
            style: style("#111827", 18.0, 3.0),
            points: vec![point(4.0, 6.0)],
            text: Some("Hi".to_string()),
        };

        let composed = compose_export(&base, &[annotation], 1.0);
        let changed = changed_pixels(&composed, BG);
        assert!(
            changed.len() > 20,
            "expected glyph pixels, got {}",
            changed.len()
        );

        // Fully covered glyph pixels reach the exact style color.
        assert!(
            changed.iter().any(|(_, _, pixel)| *pixel == DARK),
            "no fully covered text pixel"
        );

        // Everything renders below/right of the anchor and within roughly one
        // line box (top baseline + ascent + descender headroom).
        for (x, y, _) in &changed {
            assert!(*x >= 3 && *x < 40, "glyph pixel x = {x}");
            assert!(*y >= 6 && *y < 27, "glyph pixel y = {y}");
        }
    }

    #[test]
    fn compose_export_splits_text_lines_on_newline_with_1_2_line_height() {
        let base = solid(64, 64, BG);
        let annotation = Annotation {
            id: "t".to_string(),
            tool: Tool::Text,
            style: style("#111827", 18.0, 3.0),
            points: vec![point(4.0, 4.0)],
            text: Some("H\nH".to_string()),
        };

        let composed = compose_export(&base, &[annotation], 1.0);

        // Line 1 glyphs sit roughly in y 4..22; with lineHeight 21.6 the
        // second line starts well below it.
        let band = |from: u32, to: u32| {
            changed_pixels(&composed, BG)
                .into_iter()
                .filter(|(_, y, _)| *y >= from && *y < to)
                .count()
        };
        let first = band(0, 23);
        let second = band(24, 50);
        assert!(first > 5, "first line pixels: {first}");
        assert!(second > 5, "second line pixels: {second}");
        assert_eq!(band(50, 64), 0, "glyphs leaked below the second line");
    }

    #[test]
    fn compose_export_translation_overlay_draws_white_rect_and_text() {
        let base = solid(140, 80, BG);
        let annotation = Annotation {
            id: "tr".to_string(),
            tool: Tool::Translation,
            style: style("#111827", 18.0, 1.0),
            points: corners(4.0, 4.0, 120.0, 60.0),
            text: Some("hello".to_string()),
        };

        let composed = compose_export(&base, &[annotation], 1.0);

        // White rect covers exactly [4, 124) × [4, 64).
        assert_eq!(composed.pixel(5, 5), WHITE);
        assert_eq!(composed.pixel(123, 63), WHITE);
        assert_eq!(composed.pixel(3, 4), BG);
        assert_eq!(composed.pixel(4, 3), BG);
        assert_eq!(composed.pixel(124, 10), BG);
        assert_eq!(composed.pixel(10, 64), BG);

        // Wrapped text renders in the annotation color, positioned inside the
        // rect (padding 10 → origin (14, ~17.9), baseline ~34.2).
        let dark = changed_pixels(&composed, WHITE)
            .into_iter()
            .filter(|(x, y, pixel)| *pixel == DARK && *x >= 4 && *x < 124 && *y >= 4 && *y < 64)
            .count();
        assert!(dark > 5, "expected wrapped text pixels, got {dark}");
    }

    #[test]
    fn compose_export_translation_wraps_long_text_into_multiple_lines() {
        let base = solid(200, 200, BG);
        let annotation = Annotation {
            id: "tr".to_string(),
            tool: Tool::Translation,
            style: style("#111827", 18.0, 1.0),
            points: corners(0.0, 0.0, 90.0, 200.0),
            text: Some("This is a longer translation that should wrap".to_string()),
        };

        // Ported TS wrapping case (translationOverlay.test.ts): must wrap to
        // more than one line.
        let lines = wrap_translation_overlay_text(
            "This is a longer translation that should wrap",
            &rect(0.0, 0.0, 90.0, 200.0),
            16.0,
        );
        assert!(lines.len() > 1, "lines: {lines:?}");

        // The composed overlay shows text below the first line box
        // (lineHeight = 16 * 1.35 = 21.6 → second line top ≈ padding + 21.6).
        let composed = compose_export(&base, &[annotation], 1.0);
        let lower_half = changed_pixels(&composed, WHITE)
            .into_iter()
            .filter(|(x, y, pixel)| *pixel == DARK && *x < 90 && *y > 40 && *y < 200)
            .count();
        assert!(
            lower_half > 5,
            "expected a wrapped second line, got {lower_half}"
        );
    }

    #[test]
    fn wrap_translation_overlay_text_matches_ts_width_units() {
        // maxLineUnits for width 90, fontSize 16: padding = max(8, round(8.8))
        // = 9; available = max(1, 90 - 18) = 72; 72 / 16 = 4.5 units. Eight
        // 'a' characters weigh 8 * 0.55 = 4.4 and fit; the space would push
        // to 4.75 and breaks (the break character is dropped, TS trimStart),
        // so "b" starts the next line.
        let rect = rect(0.0, 0.0, 90.0, 120.0);
        assert_eq!(
            wrap_translation_overlay_text("aaaaaaaa b", &rect, 16.0),
            vec!["aaaaaaaa", "b"]
        );
        // CJK characters weigh 1 unit (isCjkCharacter port): four fit in 4.5
        // units, the fifth breaks.
        assert_eq!(
            wrap_translation_overlay_text("好你好你好你", &rect, 16.0),
            vec!["好你好你", "好你"]
        );
        // Paragraphs split on \n before wrapping.
        assert_eq!(
            wrap_translation_overlay_text("aa\naa", &rect, 16.0),
            vec!["aa", "aa"]
        );
    }

    #[test]
    fn compose_export_passes_output_scale_through_to_mosaic() {
        // 64x64 device-pixel base = 32x32 logical selection at output_scale 2.
        let base = patterned(64, 64);
        let annotation = Annotation {
            id: "m".to_string(),
            tool: Tool::Mosaic,
            style: style("#ff3355", 18.0, 3.0),
            points: corners(0.0, 0.0, 32.0, 32.0),
            text: None,
        };

        let composed = compose_export(&base, &[annotation], 2.0);

        // Scaled rect (0, 0, 64, 64), block = max(4, round(8 * 2)) = 16:
        // four 16x16 cells each replicating their top-left pixel.
        assert_eq!(composed.pixel(0, 0), [0, 0, 7, 255]);
        assert_eq!(composed.pixel(15, 15), [0, 0, 7, 255]);
        assert_eq!(composed.pixel(16, 0), [128, 0, 7, 255]);
        assert_eq!(composed.pixel(31, 15), [128, 0, 7, 255]);
        assert_eq!(composed.pixel(0, 16), [0, 128, 7, 255]);
        assert_eq!(composed.pixel(15, 31), [0, 128, 7, 255]);
        assert_eq!(composed.pixel(16, 16), [128, 128, 7, 255]);
        assert_eq!(composed.pixel(31, 31), [128, 128, 7, 255]);
    }

    #[test]
    fn compose_export_draws_text_annotations_on_top_of_raster_annotations() {
        // Locks in the documented z-order divergence: the second vector pass
        // composites text above every raster annotation, even when the
        // annotation list orders the raster tool last.
        let base = solid(64, 64, BG);
        let translation = Annotation {
            id: "tr".to_string(),
            tool: Tool::Translation,
            style: style("#111827", 18.0, 1.0),
            points: corners(4.0, 4.0, 40.0, 40.0),
            text: Some("hi".to_string()),
        };
        let pen = Annotation {
            id: "p".to_string(),
            tool: Tool::Pen,
            style: style("#ff3355", 18.0, 3.0),
            points: vec![point(0.0, 16.0), point(64.0, 16.0)],
            text: None,
        };

        let composed = compose_export(&base, &[translation.clone(), pen.clone()], 1.0);
        // Inside the translation rect the pen band is covered by the white
        // overlay (second pass); outside it, the pen stroke shows.
        assert_eq!(composed.pixel(20, 16), WHITE);
        assert_eq!(composed.pixel(2, 16), RED);
        // TS sequential order would draw pen last and paint (20, 16) red.
        let ts_order = compose_export(&base, &[pen, translation], 1.0);
        assert_eq!(ts_order.pixel(20, 16), WHITE);
    }

    #[test]
    fn compose_export_skips_missing_glyphs_without_panicking() {
        let base = solid(48, 48, BG);
        let cjk_text = Annotation {
            id: "c".to_string(),
            tool: Tool::Text,
            style: style("#111827", 18.0, 3.0),
            points: vec![point(4.0, 4.0)],
            text: Some("你好".to_string()),
        };
        let mixed = Annotation {
            id: "m".to_string(),
            tool: Tool::Text,
            style: style("#111827", 18.0, 3.0),
            points: vec![point(4.0, 4.0)],
            text: Some("a你b".to_string()),
        };
        let cjk_translation = Annotation {
            id: "c2".to_string(),
            tool: Tool::Translation,
            style: style("#111827", 18.0, 1.0),
            points: corners(0.0, 0.0, 48.0, 48.0),
            text: Some("你好".to_string()),
        };

        // Pure CJK text: no glyphs available → the buffer is untouched.
        let composed = compose_export(&base, &[cjk_text], 1.0);
        assert_eq!(composed.data, base.data);

        // Mixed text: only the Latin glyphs render (a, then b after the
        // skipped CJK glyph).
        let composed = compose_export(&base, &[mixed], 1.0);
        assert!(changed_pixels(&composed, BG)
            .iter()
            .all(|(x, _, _)| *x < 30));

        // Translation: the white rect still covers the region.
        let composed = compose_export(&base, &[cjk_translation], 1.0);
        assert_eq!(composed.pixel(10, 10), WHITE);
    }

    #[test]
    fn compose_export_ignores_pathological_text_geometry() {
        let base = solid(32, 32, BG);
        let huge = Annotation {
            id: "h".to_string(),
            tool: Tool::Text,
            style: style("#111827", 1.0e9, 3.0),
            points: vec![point(0.0, 0.0)],
            text: Some("H".to_string()),
        };
        let negative_font = Annotation {
            id: "n".to_string(),
            tool: Tool::Text,
            style: style("#111827", -18.0, 3.0),
            points: vec![point(0.0, 0.0)],
            text: Some("H".to_string()),
        };
        let nan_font = Annotation {
            id: "nan".to_string(),
            tool: Tool::Text,
            style: style("#111827", f64::NAN, 3.0),
            points: vec![point(0.0, 0.0)],
            text: Some("H".to_string()),
        };
        let offscreen = Annotation {
            id: "o".to_string(),
            tool: Tool::Text,
            style: style("#111827", 18.0, 3.0),
            points: vec![point(-500.0, -500.0)],
            text: Some("H".to_string()),
        };
        let empty_text = Annotation {
            id: "e".to_string(),
            tool: Tool::Text,
            style: style("#111827", 18.0, 3.0),
            points: vec![point(4.0, 4.0)],
            text: Some(String::new()),
        };
        let no_anchor = Annotation {
            id: "na".to_string(),
            tool: Tool::Text,
            style: style("#111827", 18.0, 3.0),
            points: Vec::new(),
            text: Some("H".to_string()),
        };
        let invalid_color = Annotation {
            id: "ic".to_string(),
            tool: Tool::Text,
            style: style("nope", 18.0, 3.0),
            points: vec![point(4.0, 4.0)],
            text: Some("H".to_string()),
        };
        let translation_without_rect = Annotation {
            id: "twr".to_string(),
            tool: Tool::Translation,
            style: style("#111827", 18.0, 1.0),
            points: vec![point(4.0, 4.0)],
            text: Some("hello".to_string()),
        };

        for annotation in [
            huge,
            negative_font,
            nan_font,
            offscreen,
            empty_text,
            no_anchor,
            invalid_color,
            translation_without_rect,
        ] {
            let composed = compose_export(&base, std::slice::from_ref(&annotation), 1.0);
            assert_eq!(composed.data, base.data, "annotation {:?}", annotation.id);
        }
    }

    #[test]
    fn translation_overlay_helpers_match_ts_values() {
        // padding = max(8, round(fontSize * 0.55)).
        assert_eq!(get_translation_overlay_padding(18.0), 10.0);
        assert_eq!(get_translation_overlay_padding(10.0), 8.0);
        // lineHeight = fontSize * 1.35.
        assert_eq!(get_translation_overlay_line_height(18.0), 24.3);
        // Origin: padding, vertically centered when there is room.
        let origin = get_translation_overlay_text_origin(&rect(0.0, 0.0, 90.0, 120.0), 16.0, 1);
        assert_eq!(origin.x, 9.0);
        assert_eq!(origin.y, (120.0 - 16.0 * 1.35) / 2.0);
        // Clamped to at least the padding.
        let origin = get_translation_overlay_text_origin(&rect(0.0, 0.0, 90.0, 20.0), 16.0, 3);
        assert_eq!(origin.y, 9.0);
    }
}
