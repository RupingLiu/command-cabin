//! State transitions ported from renderer `converter/UnitConverterPage.tsx`:
//! recalculate from the last edited side; swap values and editing baseline too.
use cabin_core::unit_conversion::{
    convert_unit_value, format_unit_conversion_value, parse_unit_value, Category, Unit,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    From,
    To,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConverterState {
    pub category: Category,
    pub from_unit: Unit,
    pub to_unit: Unit,
    pub from_value: String,
    pub to_value: String,
    last_edited: Side,
}

impl Default for ConverterState {
    fn default() -> Self {
        Self::new(Category::Weight)
    }
}

impl ConverterState {
    fn new(category: Category) -> Self {
        let (from_unit, to_unit) = category.default_pair();
        Self {
            category,
            from_unit,
            to_unit,
            from_value: String::new(),
            to_value: String::new(),
            last_edited: Side::From,
        }
    }

    pub fn select_category(&mut self, index: i32) {
        let category = match index {
            0 => Category::Weight,
            1 => Category::Length,
            _ => return,
        };
        *self = Self::new(category);
    }

    pub fn edit_value(&mut self, side: Side, value: String) {
        match side {
            Side::From => self.from_value = value,
            Side::To => self.to_value = value,
        }
        self.last_edited = side;
        self.recalculate();
    }

    pub fn select_unit(&mut self, side: Side, index: i32) {
        let Some(unit) = usize::try_from(index)
            .ok()
            .and_then(|index| self.category.units().get(index))
            .copied()
        else {
            return;
        };
        match side {
            Side::From => self.from_unit = unit,
            Side::To => self.to_unit = unit,
        }
        self.recalculate();
    }

    pub fn swap(&mut self) {
        std::mem::swap(&mut self.from_unit, &mut self.to_unit);
        std::mem::swap(&mut self.from_value, &mut self.to_value);
        self.last_edited = match self.last_edited {
            Side::From => Side::To,
            Side::To => Side::From,
        };
    }

    fn recalculate(&mut self) {
        let (input, from, to) = match self.last_edited {
            Side::From => (&self.from_value, self.from_unit, self.to_unit),
            Side::To => (&self.to_value, self.to_unit, self.from_unit),
        };
        let output = parse_unit_value(input)
            .and_then(|value| convert_unit_value(value, from, to))
            .map(format_unit_conversion_value)
            .unwrap_or_default();
        match self.last_edited {
            Side::From => self.to_value = output,
            Side::To => self.from_value = output,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ts_swap_preserves_the_physical_value_and_last_edited_side() {
        // UnitConverterPage.test.ts: swapping 1 kg then selecting oz must yield
        // 35.274 oz while preserving the exact 1 kg editing baseline.
        let mut state = ConverterState::default();
        state.edit_value(Side::From, "1".into());
        assert_eq!(state.to_value, "2.20462");
        state.swap();
        assert_eq!(
            (state.from_value.as_str(), state.to_value.as_str()),
            ("2.20462", "1")
        );
        state.select_unit(Side::From, 4);
        assert_eq!(
            (state.from_value.as_str(), state.to_value.as_str()),
            ("35.274", "1")
        );
        state.edit_value(Side::To, "2".into());
        assert_eq!(state.from_value, "70.5479");
    }

    #[test]
    fn category_changes_reset_inputs_and_invalid_edits_clear_the_other_side() {
        let mut state = ConverterState::default();
        state.edit_value(Side::From, "abc".into());
        assert_eq!(
            (state.from_value.as_str(), state.to_value.as_str()),
            ("abc", "")
        );
        state.select_category(1);
        assert_eq!(
            (state.from_unit, state.to_unit),
            (Unit::Centimeter, Unit::Inch)
        );
        assert_eq!(
            (state.from_value.as_str(), state.to_value.as_str()),
            ("", "")
        );
        state.edit_value(Side::To, "1".into());
        assert_eq!(state.from_value, "2.54");
        let before = state.clone();
        state.select_unit(Side::From, -1);
        state.select_unit(Side::To, 99);
        state.select_category(99);
        assert_eq!(state, before);
    }
}
