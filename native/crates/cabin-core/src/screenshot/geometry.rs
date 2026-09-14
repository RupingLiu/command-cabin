//! Screenshot capture geometry, ported verbatim from
//! `apps/desktop/src/main/screenshot/screenshotCapture.ts:42-97`
//! (`calculateVirtualBounds`, `calculateThumbnailSize`, `pointInBounds`,
//! `selectDisplaysForCapture`, `calculateCaptureBounds`).
//!
//! Pure functions over display rectangles: no OS/display-enumeration calls
//! live here (the host supplies [`ScreenshotDisplay`] values). Coordinates are
//! logical screen points and may be negative for displays left of / above the
//! primary monitor; TS numbers map to `f64`.
//!
//! Types reuse the annotation model ([`Point`] / [`Rect`]) rather than
//! duplicating shape structs: TS `ScreenshotPoint` is the annotation `point`
//! shape and TS `ScreenshotBounds` is the `rect` shape (both
//! `{ x, y, width | height }` in logical points).

use serde::{Deserialize, Serialize};

use super::state::{Point, Rect};

/// TS `ScreenshotDisplay` (screenshotCapture.ts:7-11): one display's logical
/// bounds, Electron display id, and device scale factor. Electron display ids
/// are 32-bit integers.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotDisplay {
    pub bounds: Rect,
    pub id: i32,
    pub scale_factor: f64,
}

/// TS inline `{ height, width }` thumbnail size (screenshotCapture.ts:60-68),
/// in device pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailSize {
    pub height: f64,
    pub width: f64,
}

/// TS `calculateVirtualBounds`: the bounding box of every display, or the zero
/// rect for an empty display list.
pub fn calculate_virtual_bounds(displays: &[ScreenshotDisplay]) -> Rect {
    let Some(first) = displays.first() else {
        return Rect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        };
    };
    let left = displays
        .iter()
        .map(|d| d.bounds.x)
        .fold(first.bounds.x, f64::min);
    let top = displays
        .iter()
        .map(|d| d.bounds.y)
        .fold(first.bounds.y, f64::min);
    let right = displays
        .iter()
        .map(|d| d.bounds.x + d.bounds.width)
        .fold(first.bounds.x + first.bounds.width, f64::max);
    let bottom = displays
        .iter()
        .map(|d| d.bounds.y + d.bounds.height)
        .fold(first.bounds.y + first.bounds.height, f64::max);

    Rect {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    }
}

/// TS `calculateThumbnailSize`: the largest per-display device-pixel size,
/// used as the `thumbnailSize` requested from the desktopCapturer sources.
pub fn calculate_thumbnail_size(displays: &[ScreenshotDisplay]) -> ThumbnailSize {
    displays.iter().fold(
        ThumbnailSize {
            height: 0.0,
            width: 0.0,
        },
        |size, display| ThumbnailSize {
            height: size
                .height
                .max((display.bounds.height * display.scale_factor).round()),
            width: size
                .width
                .max((display.bounds.width * display.scale_factor).round()),
        },
    )
}

/// TS `pointInBounds`: half-open containment — a point exactly on the right or
/// bottom edge is outside.
fn point_in_bounds(point: Point, bounds: &Rect) -> bool {
    point.x >= bounds.x
        && point.x < bounds.x + bounds.width
        && point.y >= bounds.y
        && point.y < bounds.y + bounds.height
}

/// TS `selectDisplaysForCapture`: only the display containing the active
/// pointer, or every display when there is no point (or the point is on no
/// display, e.g. exactly on a shared edge).
pub fn select_displays_for_capture(
    displays: &[ScreenshotDisplay],
    active_point: Option<Point>,
) -> Vec<ScreenshotDisplay> {
    let Some(active_point) = active_point else {
        return displays.to_vec();
    };

    let active_display = displays
        .iter()
        .find(|display| point_in_bounds(active_point, &display.bounds));

    match active_display {
        Some(display) => vec![*display],
        None => displays.to_vec(),
    }
}

/// TS `calculateCaptureBounds`: the virtual bounds of the selected displays.
pub fn calculate_capture_bounds(
    displays: &[ScreenshotDisplay],
    active_point: Option<Point>,
) -> Rect {
    calculate_virtual_bounds(&select_displays_for_capture(displays, active_point))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        id: i32,
        scale_factor: f64,
    ) -> ScreenshotDisplay {
        ScreenshotDisplay {
            bounds: Rect {
                x,
                y,
                width,
                height,
            },
            id,
            scale_factor,
        }
    }

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn point(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    #[test]
    fn virtual_bounds_of_empty_display_list_is_the_zero_rect() {
        assert_eq!(calculate_virtual_bounds(&[]), rect(0.0, 0.0, 0.0, 0.0));
    }

    #[test]
    fn virtual_bounds_spans_multi_display_layouts_with_negative_coordinates() {
        // screenshotCapture.test.ts: displays side by side at the origin.
        let side_by_side = [
            display(0.0, 0.0, 1920.0, 1080.0, 10, 1.0),
            display(1920.0, 0.0, 1440.0, 900.0, 20, 1.5),
        ];
        assert_eq!(
            calculate_virtual_bounds(&side_by_side),
            rect(0.0, 0.0, 3360.0, 1080.0)
        );

        // Left-of-primary monitor: the union starts at a negative x.
        let left_of_primary = [
            display(-1920.0, 0.0, 1920.0, 1080.0, 10, 1.0),
            display(0.0, 0.0, 2560.0, 1440.0, 20, 1.5),
        ];
        assert_eq!(
            calculate_virtual_bounds(&left_of_primary),
            rect(-1920.0, 0.0, 4480.0, 1440.0)
        );
    }

    #[test]
    fn thumbnail_size_uses_rounded_device_pixels_of_the_largest_display() {
        // screenshotCapture.test.ts first case: { height: 1350, width: 2160 }.
        let side_by_side = [
            display(0.0, 0.0, 1920.0, 1080.0, 10, 1.0),
            display(1920.0, 0.0, 1440.0, 900.0, 20, 1.5),
        ];
        assert_eq!(
            calculate_thumbnail_size(&side_by_side),
            ThumbnailSize {
                height: 1350.0,
                width: 2160.0
            }
        );

        // screenshotCapture.test.ts second case: { height: 2160, width: 3840 }.
        let left_of_primary = [
            display(-1920.0, 0.0, 1920.0, 1080.0, 10, 1.0),
            display(0.0, 0.0, 2560.0, 1440.0, 20, 1.5),
        ];
        assert_eq!(
            calculate_thumbnail_size(&left_of_primary),
            ThumbnailSize {
                height: 2160.0,
                width: 3840.0
            }
        );

        assert_eq!(
            calculate_thumbnail_size(&[]),
            ThumbnailSize {
                height: 0.0,
                width: 0.0
            }
        );
    }

    #[test]
    fn select_displays_for_capture_picks_the_display_containing_the_active_point() {
        let displays = [
            display(-1920.0, 0.0, 1920.0, 1080.0, 10, 1.0),
            display(0.0, 0.0, 2560.0, 1440.0, 20, 1.5),
        ];

        // The active cursor (100, 200) sits on the primary display.
        assert_eq!(
            select_displays_for_capture(&displays, Some(point(100.0, 200.0))),
            vec![display(0.0, 0.0, 2560.0, 1440.0, 20, 1.5)]
        );

        // Negative-coordinate display containment.
        assert_eq!(
            select_displays_for_capture(&displays, Some(point(-100.0, 200.0))),
            vec![display(-1920.0, 0.0, 1920.0, 1080.0, 10, 1.0)]
        );

        // No active point keeps every display.
        assert_eq!(
            select_displays_for_capture(&displays, None),
            displays.to_vec()
        );

        // Half-open bounds: x = 0 is the right edge of display 10 but the
        // left edge of display 20, so display 20 wins (leftmost `find` that
        // contains the point).
        assert_eq!(
            select_displays_for_capture(&displays, Some(point(0.0, 0.0))),
            vec![display(0.0, 0.0, 2560.0, 1440.0, 20, 1.5)]
        );
        // The left/top edges are inclusive.
        assert_eq!(
            select_displays_for_capture(&displays, Some(point(-1920.0, 0.0))),
            vec![display(-1920.0, 0.0, 1920.0, 1080.0, 10, 1.0)]
        );
        // A point on no display (below both) falls back to every display.
        assert_eq!(
            select_displays_for_capture(&displays, Some(point(0.0, 2000.0))),
            vec![
                display(-1920.0, 0.0, 1920.0, 1080.0, 10, 1.0),
                display(0.0, 0.0, 2560.0, 1440.0, 20, 1.5),
            ]
        );
    }

    #[test]
    fn calculate_capture_bounds_ports_the_ts_active_cursor_cases() {
        // screenshotCapture.test.ts 'calculates capture bounds from the active
        // cursor display'.
        let displays = [
            display(-1920.0, 0.0, 1920.0, 1080.0, 10, 1.0),
            display(0.0, 0.0, 2560.0, 1440.0, 20, 1.5),
        ];

        assert_eq!(
            calculate_capture_bounds(&displays, Some(point(100.0, 200.0))),
            rect(0.0, 0.0, 2560.0, 1440.0)
        );
        assert_eq!(
            calculate_capture_bounds(&displays, None),
            rect(-1920.0, 0.0, 4480.0, 1440.0)
        );
    }

    #[test]
    fn display_serializes_with_ts_camel_case_fields() {
        let json = serde_json::to_string(&display(1.0, 2.0, 3.0, 4.0, 7, 1.5)).expect("serialize");
        assert_eq!(
            json,
            r#"{"bounds":{"x":1.0,"y":2.0,"width":3.0,"height":4.0},"id":7,"scaleFactor":1.5}"#
        );
        let back: ScreenshotDisplay = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, display(1.0, 2.0, 3.0, 4.0, 7, 1.5));
    }
}
