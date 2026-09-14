//! Annotation rasterization onto an RGBA8 buffer, ported from
//! `apps/desktop/src/renderer/src/screenshot/screenshotCanvas.ts`
//! (`drawAnnotation`, `drawMosaic`, `pixelate`). Pure logic, no GUI deps.
//!
//! Semantics and deliberate divergences from the TS canvas renderer:
//!
//! * **Coordinate space.** [`draw_annotation`] draws 1:1 in image-buffer pixel
//!   coordinates. The M3 Task 3 PNG compositor owns the logical-point →
//!   device-pixel transform (TS `scalePoint`/`scaleRect`/`scaleStyle` with
//!   `outputScale`); it should pre-transform annotation geometry before calling
//!   into this module **and pass the same scale as [`draw_annotation`]'s
//!   `output_scale`**: the mosaic block size is `max(4, round(8 *
//!   outputScale))` in buffer coordinates (TS computes it in device pixels),
//!   so mosaic parity requires the buffer to be in device pixels —
//!   pre-scaling geometry alone does not scale the block. Screen-space
//!   callers render at 1:1 and pass 1.0. Canvas pixel `(x, y)` covers
//!   `[x, x+1) × [y, y+1)`, and coverage is computed against pixel centers
//!   `(x + 0.5, y + 0.5)`, matching the canvas convention.
//!
//! * **Text is NOT rasterized (decision, carry-forward for Tasks 3/7).**
//!   `Tool::Text` and `Tool::Translation` annotations are deliberately *not*
//!   burned into the buffer — there is no font rasterizer in this crate, and
//!   the M3 plan recommends rendering them as vector overlays instead:
//!   the live Slint overlay draws text annotations as text elements, and the
//!   export compositor (Task 3) must run a **second vector pass** that redraws
//!   text (`fontSize px sans-serif`, baseline `top`, line height
//!   `fontSize * 1.2`, lines split on `\n`, anchored at `points[0]`) and
//!   translation overlays (white-filled rect + wrapped text) on top of the
//!   rasterized buffer. Mosaic must be rasterized here (it changes image
//!   content); text must survive as vectors (it must stay sharp at any export
//!   scale). If this decision is ever reversed, `text_font_scale` is already
//!   in the [`draw_annotation`] signature so callers do not break.
//!
//! * **Stroke shape.** TS sets `lineCap: 'round'` / `lineJoin: 'round'`, so a
//!   stroked path is the Minkowski sum of the path with a disc of radius
//!   `lineWidth / 2`. We approximate exactly that by stamping AA discs every
//!   ≤ 0.5 px along each segment (sub-pixel-accurate to within
//!   `step² / (8r)`). A single-point pen path stamps one dot, matching the
//!   round-cap behavior of a zero-length canvas subpath.
//!
//! * **Antialiasing.** The TS canvas 2D context antialiases by default; we
//!   approximate with a 1 px signed-distance feather
//!   (`coverage = clamp(r + 0.5 − d, 0, 1)` per stamped disc) composited
//!   src-over. Stroke interiors reach the exact style color; edges are close
//!   to (slightly harder than) canvas AA. This divergence is accepted and
//!   pixel tests only assert fully-covered pixels.
//!
//! * **Arrow.** The TS arrow is an *open V head*, not a filled triangle:
//!   shaft `from → to` plus two barbs from `to` at `angle ± π/6` with
//!   `headLength = max(12, lineWidth * 4)`. Ported verbatim, including the
//!   12 px floor (the M3 brief sketched "triangle head, length ∝ lineWidth*3";
//!   the existing TS semantics win per the brief's own instruction).
//!
//! * **Rectangle / ellipse.** Stroke only, centered on the path (half the
//!   line width outside), as in TS. The brief's "optionally filled" is not
//!   implemented: no TS code path ever fills these shapes. Ellipses are
//!   sampled into a closed polyline (≈1 px vertex spacing, clamped to
//!   `[16, 4096]` vertices via a Ramanujan perimeter estimate) before the
//!   round-pen stroke.
//!
//! * **Mosaic.** Ported verbatim from TS `drawMosaic` + `pixelate`: block size
//!   `max(4, round(8 * outputScale))` (see [`mosaic_block_size`], fed by
//!   [`draw_annotation`]'s `output_scale`; at `outputScale = 1` that is
//!   [`MOSAIC_BASE_BLOCK_SIZE`] = 8), and each block is replaced with a copy
//!   of its *top-left* pixel (the earlier block-averaging draft lost to the
//!   plan's behavior-aligns-to-TS rule). Blocks are aligned to the rounded
//!   region top-left, matching the TS extraction rect. `Tool::Mosaic` in
//!   [`draw_annotation`] ignores the style color (TS paints mosaic pixels,
//!   not strokes).
//!
//! * **Colors.** `AnnotationStyle::color` is `#rrggbb` (see
//!   `state.rs`); `#rgb` is also accepted (both valid CSS). An unparseable
//!   color skips the affected stroke tool: a canvas would silently keep its
//!   previous style, which does not exist here because every call carries its
//!   own style. `lineWidth <= 0` also skips stroke tools (canvas spec: a zero
//!   line width draws nothing).
//!
//! * **Degenerate geometry** (missing corner/from/to points) is skipped, the
//!   raster-side mirror of `Annotation::rect` / `Annotation::from_to`
//!   returning `None`.

use super::state::{Annotation, Point, Rect, Tool};

/// TS `drawMosaic` base block size: `Math.max(4, Math.round(8 * outputScale))`.
pub const MOSAIC_BASE_BLOCK_SIZE: f64 = 8.0;

/// TS floor for the mosaic block size (`Math.max(4, ...)`).
pub const MOSAIC_MIN_BLOCK_SIZE: u32 = 4;

/// TS `Math.max(4, Math.round(8 * outputScale))`. Non-finite scales fall back
/// to the base block size ([`MOSAIC_BASE_BLOCK_SIZE`] = 8) instead of
/// saturating the float→int cast.
pub fn mosaic_block_size(scale: f64) -> u32 {
    let scaled = MOSAIC_BASE_BLOCK_SIZE * scale;
    if !scaled.is_finite() {
        return MOSAIC_BASE_BLOCK_SIZE as u32;
    }
    scaled.round().max(MOSAIC_MIN_BLOCK_SIZE as f64) as u32
}

/// TS `Math.PI / 6`: arrow barbs open at ±30° from the shaft direction.
const ARROW_BARB_ANGLE: f64 = std::f64::consts::FRAC_PI_6;

/// TS arrow head floor: `Math.max(12, lineWidth * 4)`.
const ARROW_HEAD_MIN_LENGTH: f64 = 12.0;

/// Maximum spacing between disc stamps along a stroked path. Small enough that
/// the union of stamps deviates from the true capsule by well under 0.01 px
/// for any annotation line width.
const STAMP_STEP: f64 = 0.5;

/// Hard cap on stamps per segment. Segments longer than cap × step (~0.5 M px
/// — far beyond any display) lose stamp density, and non-finite / saturating
/// lengths terminate instead of looping ~2^64 times.
const MAX_STAMPS_PER_SEGMENT: f64 = 1_048_576.0;

/// Minimum/maximum number of vertices used to sample an ellipse perimeter.
const ELLIPSE_MIN_STEPS: usize = 16;
const ELLIPSE_MAX_STEPS: usize = 4096;

/// A tightly packed 8-bit RGBA image (RGBA8, row-major, non-premultiplied).
pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    /// `width * height * 4` bytes; pixel `(x, y)` occupies
    /// `data[(y * width + x) * 4 .. +4]` as `[r, g, b, a]`.
    pub data: Vec<u8>,
}

impl RgbaImage {
    /// A fully transparent black image.
    pub fn new(width: u32, height: u32) -> Self {
        let len = width as usize * height as usize * 4;
        Self {
            width,
            height,
            data: vec![0; len],
        }
    }

    /// Reads the pixel at `(x, y)` as `[r, g, b, a]`; panics when out of
    /// bounds (tests only — production callers iterate `data` directly).
    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let start = self.pixel_start(x, y);
        [
            self.data[start],
            self.data[start + 1],
            self.data[start + 2],
            self.data[start + 3],
        ]
    }

    fn pixel_start(&self, x: u32, y: u32) -> usize {
        assert!(x < self.width && y < self.height, "pixel out of bounds");
        (y as usize * self.width as usize + x as usize) * 4
    }
}

/// Draws one annotation onto the buffer, mirroring the TS `drawAnnotation`
/// branches (see the module docs for per-tool semantics and divergences).
///
/// `text_font_scale` is currently unused (text is rendered as a vector
/// overlay, not rasterized) and is kept so a rasterized-text path can be
/// added later without breaking callers.
///
/// `output_scale` is the TS `outputScale` (device pixels per logical point)
/// the buffer was rendered at. Only the mosaic branch consumes it (TS
/// `drawMosaic`: `max(4, round(8 * outputScale))` device pixels); the
/// buffer must be in device pixels for mosaic parity. Screen-space callers
/// rendering 1:1 pass 1.0.
pub fn draw_annotation(
    img: &mut RgbaImage,
    ann: &Annotation,
    text_font_scale: f64,
    output_scale: f64,
) {
    let _ = text_font_scale;

    match ann.tool {
        Tool::Rectangle => {
            if let Some(rect) = ann.rect() {
                let outline = rect_outline(rect);
                stroke_with_style(img, ann, &[&outline]);
            }
        }
        Tool::Ellipse => {
            if let Some(rect) = ann.rect() {
                let outline = ellipse_outline(rect);
                stroke_with_style(img, ann, &[&outline]);
            }
        }
        Tool::Arrow => {
            if let Some((from, to)) = ann.from_to() {
                let (upper, lower) = arrow_barbs(from, to, ann.style.line_width);
                stroke_with_style(img, ann, &[&[from, to], &[to, upper], &[to, lower]]);
            }
        }
        Tool::Pen => {
            stroke_with_style(img, ann, &[&ann.points]);
        }
        Tool::Mosaic => {
            if let Some(rect) = ann.rect() {
                // TS drawMosaic computes the block size in device pixels from
                // the same `outputScale` used to transform geometry; see the
                // module docs on why the buffer must be in device pixels.
                pixelate_region(img, &rect, mosaic_block_size(output_scale));
            }
        }
        // Text and translation overlays stay vector-side; see the module docs.
        Tool::Text | Tool::Translation => {}
    }
}

/// Strokes `paths` with the annotation's color and line width, when both are
/// usable (see the module docs on colors and zero line widths). All paths
/// share one style, like a single TS `stroke()` call.
fn stroke_with_style(img: &mut RgbaImage, ann: &Annotation, paths: &[&[Point]]) {
    let Some(color) = parse_color(&ann.style.color) else {
        return;
    };
    if ann.style.line_width <= 0.0 {
        return;
    }
    for path in paths {
        stroke_path(img, path, color, ann.style.line_width);
    }
}

/// TS arrow head geometry: barbs leave `to` at `angle ± π/6` with
/// `headLength = max(12, lineWidth * 4)`; returns `(upper, lower)` barb
/// endpoints.
fn arrow_barbs(from: Point, to: Point, line_width: f64) -> (Point, Point) {
    let angle = (to.y - from.y).atan2(to.x - from.x);
    let head_length = (line_width * 4.0).max(ARROW_HEAD_MIN_LENGTH);
    let barb = |offset: f64| Point {
        x: to.x - head_length * (angle + offset).cos(),
        y: to.y - head_length * (angle + offset).sin(),
    };
    (barb(-ARROW_BARB_ANGLE), barb(ARROW_BARB_ANGLE))
}

/// Round-pen stroke of a polyline: the union of discs of radius
/// `lineWidth / 2` swept along the path (round caps and joins). A path with a
/// single point stamps one dot.
fn stroke_path(img: &mut RgbaImage, path: &[Point], color: [u8; 4], line_width: f64) {
    let radius = line_width / 2.0;
    let Some(&first) = path.first() else {
        return;
    };
    if path.len() == 1 {
        fill_disc(img, first.x, first.y, radius, color);
        return;
    }
    for pair in path.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let len = (dx * dx + dy * dy).sqrt();
        if len == 0.0 {
            // Zero-length segment: canvas still paints a round-cap dot.
            fill_disc(img, a.x, a.y, radius, color);
            continue;
        }
        let steps = (len / STAMP_STEP).ceil().clamp(1.0, MAX_STAMPS_PER_SEGMENT);
        for i in 0..=steps as usize {
            let t = i as f64 / steps;
            fill_disc(img, a.x + dx * t, a.y + dy * t, radius, color);
        }
    }
}

/// Stamps one antialiased disc: coverage is the 1 px signed-distance feather
/// `clamp(radius + 0.5 − d, 0, 1)` against the pixel center, composited
/// src-over with an opaque source color.
fn fill_disc(img: &mut RgbaImage, cx: f64, cy: f64, radius: f64, color: [u8; 4]) {
    if radius <= 0.0 {
        return;
    }
    // Clamp the stamp bounding box to the image first: pathological geometry
    // (screen coords are bounded, but serde inputs are not) saturates the
    // float→int casts, and clamping turns those into empty ranges instead of
    // billion-pixel loops.
    let min_x = ((cx - radius - 1.0).floor() as i64).max(0);
    let max_x = ((cx + radius + 1.0).ceil() as i64).min(img.width as i64 - 1);
    let min_y = ((cy - radius - 1.0).floor() as i64).max(0);
    let max_y = ((cy + radius + 1.0).ceil() as i64).min(img.height as i64 - 1);
    if min_x > max_x || min_y > max_y {
        return;
    }
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let dx = x as f64 + 0.5 - cx;
            let dy = y as f64 + 0.5 - cy;
            let distance = (dx * dx + dy * dy).sqrt();
            let coverage = (radius + 0.5 - distance).clamp(0.0, 1.0);
            if coverage > 0.0 {
                blend_pixel(img, x, y, color, coverage);
            }
        }
    }
}

/// Src-over blend of an opaque source color with fractional coverage.
fn blend_pixel(img: &mut RgbaImage, x: i64, y: i64, color: [u8; 4], coverage: f64) {
    if x < 0 || y < 0 || x >= img.width as i64 || y >= img.height as i64 {
        return;
    }
    let start = (y as usize * img.width as usize + x as usize) * 4;
    let pixel = &mut img.data[start..start + 4];
    for (offset, &source) in color.iter().enumerate() {
        let blended = source as f64 * coverage + pixel[offset] as f64 * (1.0 - coverage);
        pixel[offset] = blended.round().clamp(0.0, 255.0) as u8;
    }
}

/// Closed rectangle outline path (first point repeated to close the stroke).
fn rect_outline(rect: Rect) -> Vec<Point> {
    let point = |x: f64, y: f64| Point { x, y };
    let x = rect.x;
    let y = rect.y;
    let right = rect.x + rect.width;
    let bottom = rect.y + rect.height;
    vec![
        point(x, y),
        point(right, y),
        point(right, bottom),
        point(x, bottom),
        point(x, y),
    ]
}

/// Ellipse outline sampled as a closed polyline. Vertex spacing is ~1 px along
/// the perimeter (Ramanujan estimate), clamped to a sane vertex budget so the
/// round-pen stroke stays within a fraction of a pixel of the true ellipse.
fn ellipse_outline(rect: Rect) -> Vec<Point> {
    let cx = rect.x + rect.width / 2.0;
    let cy = rect.y + rect.height / 2.0;
    let (a, b) = (rect.width / 2.0, rect.height / 2.0);
    let perimeter = std::f64::consts::PI * (3.0 * (a + b) - ((3.0 * a + b) * (a + 3.0 * b)).sqrt());
    let steps = (perimeter.ceil() as usize).clamp(ELLIPSE_MIN_STEPS, ELLIPSE_MAX_STEPS);
    (0..=steps)
        .map(|i| {
            let t = i as f64 / steps as f64 * std::f64::consts::TAU;
            Point {
                x: cx + a * t.cos(),
                y: cy + b * t.sin(),
            }
        })
        .collect()
}

/// Pixelates the rounded, image-clipped `rect` with the given block size,
/// replacing each block with a copy of its top-left pixel (TS `pixelate`).
/// Blocks are aligned to the region's top-left (TS extracts exactly this rect
/// and iterates it), and partial blocks at the region/image edges replicate
/// their top-left pixel over whatever remains inside.
///
/// `block` of 0 is treated as 1 to keep the grid well-defined.
pub fn pixelate_region(img: &mut RgbaImage, rect: &Rect, block: u32) {
    let block = block.max(1) as usize;
    // TS drawMosaic rounding: `Math.round` on the origin, `Math.max(1, round)`
    // on the extents. Extents use saturating adds so non-finite/huge inputs
    // (possible via serde) clamp to the image instead of overflowing.
    let left = rect.x.round() as i64;
    let top = rect.y.round() as i64;
    let right = left.saturating_add((rect.width.round() as i64).max(1));
    let bottom = top.saturating_add((rect.height.round() as i64).max(1));
    let region_x = left.clamp(0, img.width as i64);
    let region_y = top.clamp(0, img.height as i64);
    let region_right = right.clamp(0, img.width as i64);
    let region_bottom = bottom.clamp(0, img.height as i64);
    if region_x >= region_right || region_y >= region_bottom {
        return;
    }
    let region_width = (region_right - region_x) as u32;
    let region_height = (region_bottom - region_y) as u32;

    let block_u = block as u32;
    for cell_y in (0..region_height).step_by(block) {
        for cell_x in (0..region_width).step_by(block) {
            let cell_right = (cell_x + block_u).min(region_width);
            let cell_bottom = (cell_y + block_u).min(region_height);
            replicate_block(
                img,
                region_x + cell_x as i64,
                region_y + cell_y as i64,
                cell_right - cell_x,
                cell_bottom - cell_y,
            );
        }
    }
}

/// Copies the block's top-left pixel into every pixel of the block, exactly
/// like TS `pixelate` (whose source index is the block origin). Callers
/// guarantee the block lies inside the image.
fn replicate_block(img: &mut RgbaImage, x: i64, y: i64, width: u32, height: u32) {
    let start = (y as usize * img.width as usize + x as usize) * 4;
    let pixel = [
        img.data[start],
        img.data[start + 1],
        img.data[start + 2],
        img.data[start + 3],
    ];
    for row in 0..height {
        for column in 0..width {
            let target =
                ((y + row as i64) as usize * img.width as usize + (x + column as i64) as usize) * 4;
            img.data[target..target + 4].copy_from_slice(&pixel);
        }
    }
}

/// Parses `#rgb` / `#rrggbb` into an opaque RGBA color; `None` for anything
/// else (module docs: the tool is then skipped). Shared with the `encode`
/// module's vector text pass.
pub(crate) fn parse_color(color: &str) -> Option<[u8; 4]> {
    let hex = color.strip_prefix('#')?;
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    match hex.len() {
        3 => {
            let channels: Vec<u8> = hex
                .chars()
                .map(|c| c.to_digit(16).map(|d| (d * 17) as u8).expect("hex digit"))
                .collect();
            Some([channels[0], channels[1], channels[2], 255])
        }
        6 => {
            let bytes = (0..3)
                .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("hex digits"))
                .collect::<Vec<u8>>();
            Some([bytes[0], bytes[1], bytes[2], 255])
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screenshot::state::AnnotationStyle;

    const BG: [u8; 4] = [16, 32, 48, 255];
    const RED: [u8; 4] = [255, 51, 85, 255];

    fn img(width: u32, height: u32) -> RgbaImage {
        let mut image = RgbaImage::new(width, height);
        for pixel in image.data.chunks_exact_mut(4) {
            pixel.copy_from_slice(&BG);
        }
        image
    }

    fn style(color: &str, line_width: f64) -> AnnotationStyle {
        AnnotationStyle {
            color: color.to_string(),
            font_size: 18.0,
            line_width,
        }
    }

    fn annotation(tool: Tool, points: Vec<Point>, color: &str, line_width: f64) -> Annotation {
        Annotation {
            id: "test".to_string(),
            tool,
            style: style(color, line_width),
            points,
            text: None,
        }
    }

    fn point(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    fn corners(x: f64, y: f64, width: f64, height: f64) -> Vec<Point> {
        vec![point(x, y), point(x + width, y + height)]
    }

    fn px(image: &RgbaImage, x: u32, y: u32) -> [u8; 4] {
        image.pixel(x, y)
    }

    /// Fills every pixel with a position-derived pattern for mosaic tests.
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

    #[test]
    fn rect_border_color_at_expected_pixels() {
        let mut image = img(40, 40);
        let ann = annotation(
            Tool::Rectangle,
            corners(5.0, 5.0, 20.0, 20.0),
            "#ff3355",
            3.0,
        );
        draw_annotation(&mut image, &ann, 1.0, 1.0);

        // Stroke centerline is exactly on the rect outline; mid-edge pixels
        // are fully covered and carry the exact style color.
        assert_eq!(px(&image, 5, 15), RED);
        assert_eq!(px(&image, 15, 5), RED);
        assert_eq!(px(&image, 25, 15), RED);
        assert_eq!(px(&image, 15, 25), RED);
        // Interior and far outside stay background.
        assert_eq!(px(&image, 15, 15), BG);
        assert_eq!(px(&image, 1, 15), BG);
        assert_eq!(px(&image, 15, 1), BG);
    }

    #[test]
    fn ellipse_strokes_ring_but_not_interior() {
        let mut image = img(40, 40);
        let ann = annotation(Tool::Ellipse, corners(5.0, 5.0, 20.0, 20.0), "#ff3355", 3.0);
        draw_annotation(&mut image, &ann, 1.0, 1.0);

        // Top of the ring (center 15,15, radius 10, stroke spans 8.5..11.5).
        assert_eq!(px(&image, 15, 5), RED);
        assert_eq!(px(&image, 5, 15), RED);
        assert_eq!(px(&image, 25, 15), RED);
        assert_eq!(px(&image, 15, 25), RED);
        // Interior stays background.
        assert_eq!(px(&image, 15, 15), BG);
        assert_eq!(px(&image, 15, 12), BG);
        // Outside stays background.
        assert_eq!(px(&image, 15, 1), BG);
    }

    #[test]
    fn pen_draws_round_capped_endpoints() {
        let mut image = img(40, 40);
        let ann = annotation(
            Tool::Pen,
            vec![point(10.0, 10.0), point(20.0, 20.0)],
            "#ff3355",
            3.0,
        );
        draw_annotation(&mut image, &ann, 1.0, 1.0);

        assert_eq!(px(&image, 10, 10), RED); // start cap
        assert_eq!(px(&image, 20, 20), RED); // end cap
        assert_eq!(px(&image, 15, 15), RED); // midpoint
        assert_eq!(px(&image, 7, 7), BG);
        assert_eq!(px(&image, 23, 23), BG);
    }

    #[test]
    fn pen_single_point_stamps_a_round_dot() {
        let mut image = img(20, 20);
        let ann = annotation(Tool::Pen, vec![point(10.0, 10.0)], "#ff3355", 3.0);
        draw_annotation(&mut image, &ann, 1.0, 1.0);

        assert_eq!(px(&image, 10, 10), RED);
        assert_eq!(px(&image, 7, 10), BG);
    }

    #[test]
    fn arrow_draws_shaft_and_open_v_head() {
        let mut image = img(48, 40);
        let ann = annotation(
            Tool::Arrow,
            vec![point(10.0, 10.0), point(30.0, 10.0)],
            "#ff3355",
            3.0,
        );
        draw_annotation(&mut image, &ann, 1.0, 1.0);

        // headLength = max(12, lineWidth * 4) = 12; barbs at ±30° from the
        // shaft land at (30 - 12cos30, 10 ± 12sin30) = (19.608, 4 | 16).
        assert_eq!(px(&image, 30, 10), RED); // tip
        assert_eq!(px(&image, 20, 10), RED); // shaft
                                             // A point exactly on the lower barb line.
        assert_eq!(px(&image, 24, 13), RED);
        // A point exactly on the upper barb line.
        assert_eq!(px(&image, 24, 7), RED);
        assert_eq!(px(&image, 10, 4), BG);
        assert_eq!(px(&image, 10, 16), BG);
    }

    #[test]
    fn arrow_head_length_floors_at_twelve_px() {
        let mut image = img(48, 40);
        let ann = annotation(
            Tool::Arrow,
            vec![point(10.0, 10.0), point(30.0, 10.0)],
            "#ff3355",
            2.5,
        );
        draw_annotation(&mut image, &ann, 1.0, 1.0);

        // lineWidth * 4 = 10 < 12, so the 12 px floor applies: the upper barb
        // tip sits at (30 - 12cos30, 10 - 12sin30) = (19.608, 4). Without the
        // floor (head = 10 → tip (21.34, 5)) pixel (19, 4) would stay
        // background; with it the tip stamp covers it exactly.
        assert_eq!(px(&image, 19, 4), RED);
        // Mid-barb pixel on the upper barb line.
        assert_eq!(px(&image, 24, 7), RED);
        // The thinner shaft still covers its centerline.
        assert_eq!(px(&image, 20, 10), RED);
        assert_eq!(px(&image, 10, 6), BG);
    }

    #[test]
    fn mosaic_replicates_each_blocks_top_left_pixel() {
        let mut image = patterned(32, 32);
        let ann = annotation(Tool::Mosaic, corners(4.0, 8.0, 16.0, 16.0), "#ff3355", 3.0);
        draw_annotation(&mut image, &ann, 1.0, 1.0);

        // One 8x8 cell covers region rows 8..16, cols 4..12 (plus three
        // more cells). TS `pixelate` fills each cell with its top-left
        // source pixel, so the first cell is an exact copy of pixel (4, 8).
        let expected = [32, 64, 7, 255];
        for y in 8..16u32 {
            for x in 4..12u32 {
                assert_eq!(px(&image, x, y), expected, "cell pixel ({x},{y})");
            }
        }
        // The second cell (cols 12..20, rows 8..16) replicates its own
        // top-left pixel (12, 8), which differs from the first cell's.
        let second = [96, 64, 7, 255];
        for y in 8..16u32 {
            for x in 12..20u32 {
                assert_eq!(px(&image, x, y), second, "cell pixel ({x},{y})");
            }
        }
        assert_ne!(second, expected);
        // Outside the mosaic rect the source pattern is untouched.
        assert_eq!(px(&image, 3, 8), [24, 64, 7, 255]);
        assert_eq!(px(&image, 4, 7), [32, 56, 7, 255]);
    }

    #[test]
    fn mosaic_block_size_follows_output_scale() {
        // TS drawMosaic computes `max(4, round(8 * outputScale))` in device
        // pixels, so at outputScale 2 the cells are 16 px: the mosaic rect
        // (0, 0, 32, 32) splits into four 16x16 cells, each a copy of its
        // top-left pixel.
        let mut image = patterned(32, 32);
        let ann = annotation(Tool::Mosaic, corners(0.0, 0.0, 32.0, 32.0), "#ff3355", 3.0);
        draw_annotation(&mut image, &ann, 1.0, 2.0);
        assert_eq!(px(&image, 0, 0), [0, 0, 7, 255]);
        assert_eq!(px(&image, 15, 15), [0, 0, 7, 255]);
        assert_eq!(px(&image, 16, 0), [128, 0, 7, 255]);
        assert_eq!(px(&image, 31, 15), [128, 0, 7, 255]);
        assert_eq!(px(&image, 0, 16), [0, 128, 7, 255]);
        assert_eq!(px(&image, 15, 31), [0, 128, 7, 255]);
        assert_eq!(px(&image, 16, 16), [128, 128, 7, 255]);
        assert_eq!(px(&image, 31, 31), [128, 128, 7, 255]);

        // Non-integer scales round like TS: 8 * 1.25 = 10 px cells.
        let mut image = patterned(20, 20);
        let ann = annotation(Tool::Mosaic, corners(0.0, 0.0, 20.0, 20.0), "#ff3355", 3.0);
        draw_annotation(&mut image, &ann, 1.0, 1.25);
        assert_eq!(px(&image, 9, 9), [0, 0, 7, 255]);
        assert_eq!(px(&image, 10, 5), [80, 0, 7, 255]);
    }

    #[test]
    fn mosaic_block_size_matches_ts_constant() {
        assert_eq!(MOSAIC_BASE_BLOCK_SIZE, 8.0);
        assert_eq!(MOSAIC_MIN_BLOCK_SIZE, 4);
        // TS: Math.max(4, Math.round(8 * scale)).
        assert_eq!(mosaic_block_size(1.0), 8);
        assert_eq!(mosaic_block_size(2.0), 16);
        assert_eq!(mosaic_block_size(1.5), 12);
        assert_eq!(mosaic_block_size(0.5), 4);
        assert_eq!(mosaic_block_size(0.0), 4);
        // Non-finite scales fall back to the base block size instead of
        // saturating the float→int cast.
        assert_eq!(mosaic_block_size(f64::NAN), 8);
        assert_eq!(mosaic_block_size(f64::INFINITY), 8);
        assert_eq!(mosaic_block_size(f64::NEG_INFINITY), 8);
    }

    #[test]
    fn pixelate_region_clips_partial_blocks_at_region_edges() {
        let mut image = patterned(20, 20);
        pixelate_region(
            &mut image,
            &Rect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            8,
        );

        // Full 8x8 cell replicates its top-left pixel (0, 0).
        let full = [0, 0, 7, 255];
        for y in 0..8u32 {
            for x in 0..8u32 {
                assert_eq!(px(&image, x, y), full);
            }
        }
        // Right partial cell (cols 8..10, rows 0..8) replicates (8, 0).
        let right = [64, 0, 7, 255];
        for y in 0..8u32 {
            for x in 8..10u32 {
                assert_eq!(px(&image, x, y), right);
            }
        }
        // Bottom partial cell (cols 0..8, rows 8..10) replicates (0, 8).
        let bottom = [0, 64, 7, 255];
        for y in 8..10u32 {
            for x in 0..8u32 {
                assert_eq!(px(&image, x, y), bottom);
            }
        }
        // Corner partial cell (cols 8..10, rows 8..10) replicates (8, 8).
        for y in 8..10u32 {
            for x in 8..10u32 {
                assert_eq!(px(&image, x, y), [64, 64, 7, 255]);
            }
        }
        // Outside the region the pattern survives.
        assert_eq!(px(&image, 10, 10), [80, 80, 7, 255]);
    }

    #[test]
    fn pixelate_region_clips_to_image_bounds_and_handles_degenerate_blocks() {
        let mut image = patterned(16, 16);
        // Region extending past the image: clamped to 12..16, one 4x4 cell
        // replicating its top-left pixel (12, 12).
        pixelate_region(
            &mut image,
            &Rect {
                x: 12.0,
                y: 12.0,
                width: 100.0,
                height: 100.0,
            },
            4,
        );
        let expected = [96, 96, 7, 255];
        for y in 12..16u32 {
            for x in 12..16u32 {
                assert_eq!(px(&image, x, y), expected);
            }
        }
        assert_eq!(px(&image, 11, 12), [88, 96, 7, 255]);

        // block = 0 is treated as 1 (no panic, per-pixel blocks on a uniform
        // region are a no-op in effect for single pixels).
        let mut tiny = img(2, 2);
        pixelate_region(
            &mut tiny,
            &Rect {
                x: 0.0,
                y: 0.0,
                width: 2.0,
                height: 2.0,
            },
            0,
        );
        // Zero-area regions are a no-op.
        let mut other = img(4, 4);
        pixelate_region(
            &mut other,
            &Rect {
                x: 1.0,
                y: 1.0,
                width: 0.0,
                height: 5.0,
            },
            8,
        );
        assert_eq!(other.data, img(4, 4).data);
    }

    #[test]
    fn text_and_translation_annotations_are_not_rasterized() {
        let mut image = img(20, 20);
        let before = image.data.clone();
        let text = Annotation {
            id: "t".to_string(),
            tool: Tool::Text,
            style: style("#ff3355", 3.0),
            points: vec![point(5.0, 5.0)],
            text: Some("hello".to_string()),
        };
        draw_annotation(&mut image, &text, 18.0, 1.0);
        let translation = Annotation {
            id: "tr".to_string(),
            tool: Tool::Translation,
            style: style("#111827", 1.0),
            points: corners(0.0, 0.0, 10.0, 10.0),
            text: Some("translated".to_string()),
        };
        draw_annotation(&mut image, &translation, 18.0, 1.0);
        assert_eq!(image.data, before);
    }

    #[test]
    fn invalid_color_skips_stroke_tools() {
        let mut image = img(20, 20);
        let before = image.data.clone();
        for (tool, points) in [
            (Tool::Rectangle, corners(2.0, 2.0, 10.0, 10.0)),
            (Tool::Ellipse, corners(2.0, 2.0, 10.0, 10.0)),
            (Tool::Arrow, vec![point(2.0, 2.0), point(12.0, 12.0)]),
            (Tool::Pen, vec![point(2.0, 2.0), point(12.0, 12.0)]),
        ] {
            draw_annotation(
                &mut image,
                &annotation(tool, points.clone(), "nope", 3.0),
                1.0,
                1.0,
            );
            draw_annotation(
                &mut image,
                &annotation(tool, points, "#12345", 3.0),
                1.0,
                1.0,
            );
        }
        assert_eq!(image.data, before);
    }

    #[test]
    fn zero_line_width_skips_stroke_tools() {
        let mut image = img(20, 20);
        let before = image.data.clone();
        draw_annotation(
            &mut image,
            &annotation(
                Tool::Rectangle,
                corners(2.0, 2.0, 10.0, 10.0),
                "#ff3355",
                0.0,
            ),
            1.0,
            1.0,
        );
        draw_annotation(
            &mut image,
            &annotation(Tool::Pen, corners(2.0, 2.0, 10.0, 10.0), "#ff3355", 0.0),
            1.0,
            1.0,
        );
        draw_annotation(
            &mut image,
            &annotation(Tool::Arrow, corners(2.0, 2.0, 10.0, 10.0), "#ff3355", -1.0),
            1.0,
            1.0,
        );
        assert_eq!(image.data, before);
    }

    #[test]
    fn degenerate_geometry_is_skipped() {
        let mut image = img(20, 20);
        let before = image.data.clone();
        // Fewer than two corners / arrow points.
        draw_annotation(
            &mut image,
            &annotation(Tool::Rectangle, vec![point(1.0, 1.0)], "#ff3355", 3.0),
            1.0,
            1.0,
        );
        draw_annotation(
            &mut image,
            &annotation(Tool::Ellipse, Vec::new(), "#ff3355", 3.0),
            1.0,
            1.0,
        );
        draw_annotation(
            &mut image,
            &annotation(Tool::Arrow, vec![point(1.0, 1.0)], "#ff3355", 3.0),
            1.0,
            1.0,
        );
        // A pen path with zero points.
        draw_annotation(
            &mut image,
            &annotation(Tool::Pen, Vec::new(), "#ff3355", 3.0),
            1.0,
            1.0,
        );
        assert_eq!(image.data, before);
    }

    #[test]
    fn shorthand_hex_color_expands_like_css() {
        let mut image = img(20, 20);
        // #f35 == #ff3355.
        draw_annotation(
            &mut image,
            &annotation(Tool::Pen, vec![point(10.0, 10.0)], "#f35", 3.0),
            1.0,
            1.0,
        );
        assert_eq!(px(&image, 10, 10), RED);
    }

    #[test]
    fn pathological_coordinates_do_not_panic_or_hang() {
        let mut image = img(16, 16);
        // Huge and non-finite geometry (reachable via serde even though the
        // UI never sends it) must clamp/skip instead of overflowing or
        // looping over an unbounded pixel range.
        draw_annotation(
            &mut image,
            &annotation(
                Tool::Pen,
                vec![point(1.0e300, 1.0e300), point(-1.0e300, -1.0e300)],
                "#ff3355",
                3.0,
            ),
            1.0,
            1.0,
        );
        pixelate_region(
            &mut image,
            &Rect {
                x: -1.0e300,
                y: -1.0e300,
                width: 1.0e300,
                height: 1.0e300,
            },
            8,
        );
        pixelate_region(
            &mut image,
            &Rect {
                x: f64::NAN,
                y: 0.0,
                width: 5.0,
                height: 5.0,
            },
            8,
        );
        // Fully off-image geometry leaves the buffer untouched.
        let mut pristine = img(16, 16);
        draw_annotation(
            &mut pristine,
            &annotation(
                Tool::Pen,
                vec![point(-50.0, -50.0), point(-40.0, -40.0)],
                "#ff3355",
                3.0,
            ),
            1.0,
            1.0,
        );
        assert_eq!(pristine.data, img(16, 16).data);
    }
}
