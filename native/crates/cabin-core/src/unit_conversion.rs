//! Standalone converter math, ported from `packages/core/src/unitConversion.ts`.
//! The page has its own exact base factors and six significant digit formatting;
//! the search quick converter has a different TS reference and remains separate.
use crate::features::calculator::{js_number_to_string, number_to_precision};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Weight,
    Length,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unit {
    Kilogram,
    Gram,
    Milligram,
    Pound,
    Ounce,
    Centimeter,
    Millimeter,
    Meter,
    Inch,
    Foot,
}

impl Category {
    pub fn units(self) -> &'static [Unit; 5] {
        match self {
            Self::Weight => &[
                Unit::Kilogram,
                Unit::Gram,
                Unit::Milligram,
                Unit::Pound,
                Unit::Ounce,
            ],
            Self::Length => &[
                Unit::Centimeter,
                Unit::Millimeter,
                Unit::Meter,
                Unit::Inch,
                Unit::Foot,
            ],
        }
    }

    pub fn default_pair(self) -> (Unit, Unit) {
        let units = self.units();
        (units[0], units[3])
    }
}

impl Unit {
    pub fn category(self) -> Category {
        match self {
            Self::Kilogram | Self::Gram | Self::Milligram | Self::Pound | Self::Ounce => {
                Category::Weight
            }
            _ => Category::Length,
        }
    }

    pub fn symbol(self) -> &'static str {
        match self {
            Self::Kilogram => "kg",
            Self::Gram => "g",
            Self::Milligram => "mg",
            Self::Pound => "lb",
            Self::Ounce => "oz",
            Self::Centimeter => "cm",
            Self::Millimeter => "mm",
            Self::Meter => "m",
            Self::Inch => "in",
            Self::Foot => "ft",
        }
    }

    fn to_base_factor(self) -> f64 {
        match self {
            Self::Kilogram | Self::Meter => 1.,
            Self::Gram | Self::Millimeter => 0.001,
            Self::Milligram => 0.000001,
            Self::Pound => 0.45359237,
            Self::Ounce => 0.028349523125,
            Self::Centimeter => 0.01,
            Self::Inch => 0.0254,
            Self::Foot => 0.3048,
        }
    }
}

/// TS: `(input.value * fromUnit.toBaseFactor) / toUnit.toBaseFactor`.
pub fn convert_unit_value(value: f64, from: Unit, to: Unit) -> Option<f64> {
    (value.is_finite() && from.category() == to.category())
        .then(|| (value * from.to_base_factor()) / to.to_base_factor())
}

/// TS: `Number(normalizedValue.toPrecision(6)).toString()`; normalize -0.
pub fn format_unit_conversion_value(value: f64) -> String {
    js_number_to_string(number_to_precision(if value == 0. { 0. } else { value }, 6))
}

/// TS page: non-empty `Number(value)` with `Number.isFinite`, including exponent
/// notation and unsigned radix prefixes. Invalid intermediate edits clear the
/// opposite field while leaving the user's input intact.
pub fn parse_unit_value(value: &str) -> Option<f64> {
    let value = value.trim_matches(|c| {
        matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
            | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}')
    });
    if value.is_empty() {
        return None;
    }
    let radix = match value.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0o" | "0O") => Some(8),
        Some("0b" | "0B") => Some(2),
        _ => None,
    };
    let number = if let Some(radix) = radix {
        let digits = &value[2..];
        if digits.is_empty() {
            return None;
        }
        digits.chars().try_fold(0., |number, digit| {
            digit
                .to_digit(radix)
                .map(|digit| number * radix as f64 + digit as f64)
        })?
    } else {
        value.parse::<f64>().ok()?
    };
    number.is_finite().then_some(number)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ts_page_factors_and_formatting_match_reference_examples() {
        // UnitConverterPage.test.ts: 1 kg -> 2.20462 lb, or 35.274 oz.
        for (value, from, to, expected) in [
            (1., Unit::Kilogram, Unit::Pound, "2.20462"),
            (1., Unit::Kilogram, Unit::Ounce, "35.274"),
            (2.54, Unit::Centimeter, Unit::Inch, "1"),
            (1., Unit::Foot, Unit::Centimeter, "30.48"),
            (1., Unit::Milligram, Unit::Gram, "0.001"),
            (-0., Unit::Kilogram, Unit::Pound, "0"),
            (-2.54, Unit::Centimeter, Unit::Inch, "-1"),
        ] {
            assert_eq!(
                format_unit_conversion_value(convert_unit_value(value, from, to).unwrap()),
                expected
            );
        }
        assert_eq!(convert_unit_value(1., Unit::Kilogram, Unit::Meter), None);
        assert_eq!(
            convert_unit_value(f64::INFINITY, Unit::Kilogram, Unit::Gram),
            None
        );
    }

    #[test]
    fn numeric_input_accepts_ts_number_forms_and_rejects_invalid_edits() {
        for (input, expected) in [
            ("1", 1.),
            (" -.5 ", -0.5),
            ("1e3", 1000.),
            ("0x10", 16.),
            ("0b10", 2.),
            ("0o10", 8.),
        ] {
            assert_eq!(parse_unit_value(input), Some(expected));
        }
        for input in [
            "", " ", "-", ".", "abc", "NaN", "Infinity", "1e999", "0x", "-0x10", "0b2", "1_000",
        ] {
            assert_eq!(parse_unit_value(input), None, "{input}");
        }
    }
}
