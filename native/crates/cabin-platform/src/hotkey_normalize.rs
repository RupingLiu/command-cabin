//! 设置 UI 的热键字符串规范化与跨字段冲突检测。
//!
//! 移植自 TS：
//! - `apps/desktop/src/shared/settingsApi.ts` 的 `parseHotkeyAccelerator`（校验 +
//!   规范化：修饰键表、命名键表、单字符大写、F1-F24）；
//! - `apps/desktop/src/main/settings/updateSettingsWithHotkeyRegistration.ts` 的
//!   `canonicalizeHotkey`（别名归一）与 `assertUniqueHotkeys`（逐字冲突消息）。
//!
//! 与 [`crate::accelerator::parse_accelerator`] 是不同关注点：本模块面向设置 UI 的
//! 展示回写与唯一性检查，产出规范化字符串；`parse_accelerator` 产出注册用结构体。
//! 规范化采用固定修饰键顺序 Alt+Ctrl(+别名组)+Shift+Meta(+别名组)，保证等价输入
//! 展示一致。

use std::collections::{HashMap, HashSet};

use thiserror::Error;

/// 修饰键表（逐字 TS `hotkeyModifiers`，大小写敏感）。
const HOTKEY_MODIFIERS: [&str; 8] = [
    "Alt",
    "Command",
    "CommandOrControl",
    "Control",
    "Ctrl",
    "Meta",
    "Shift",
    "Super",
];

/// 命名键表（逐字 TS `hotkeyNamedKeys`，大小写敏感）。
const HOTKEY_NAMED_KEYS: [&str; 19] = [
    "Space",
    "Tab",
    "Esc",
    "Escape",
    "Enter",
    "Return",
    "Backspace",
    "Delete",
    "Insert",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Up",
    "Down",
    "Left",
    "Right",
    "Plus",
    "Minus",
];

#[derive(Debug, Error, PartialEq, Eq)]
pub enum HotkeyNormalizeError {
    #[error("Hotkey contains an empty key part.")]
    EmptyKeyPart,
    #[error("Hotkey must include at least one modifier.")]
    MissingModifier,
    #[error("Hotkey contains unsupported modifier \"{0}\".")]
    UnsupportedModifier(String),
    #[error("Hotkey contains duplicate modifier \"{0}\".")]
    DuplicateModifier(String),
    #[error("Hotkey must include a non-modifier key.")]
    ModifierOnly,
    #[error("Hotkey contains unsupported key \"{0}\".")]
    UnsupportedKey(String),
    /// 逐字 TS 冲突消息：
    /// `CommandCabin shortcuts must be unique. <field> conflicts with <field>: <hotkey>.`
    #[error(
        "CommandCabin shortcuts must be unique. {field} conflicts with {conflicts_with}: {hotkey}."
    )]
    Conflict {
        field: String,
        conflicts_with: String,
        hotkey: String,
    },
}

fn is_hotkey_modifier(part: &str) -> bool {
    HOTKEY_MODIFIERS.contains(&part)
}

/// 单字符键：TS `/^[A-Z0-9]$/i`。
fn is_single_char_key(key: &str) -> bool {
    key.len() == 1 && key.as_bytes()[0].is_ascii_alphanumeric()
}

/// 功能键：TS `/^F(?:[1-9]|1[0-9]|2[0-4])$/`（大小写敏感，仅大写 F）。
fn is_function_key(key: &str) -> bool {
    let digits = match key.strip_prefix('F') {
        Some(digits) => digits,
        None => return false,
    };
    match digits.len() {
        1 => digits.bytes().all(|b| matches!(b, b'1'..=b'9')),
        2 => {
            let bytes = digits.as_bytes();
            (bytes[0] == b'1' && bytes[1].is_ascii_digit())
                || (bytes[0] == b'2' && matches!(bytes[1], b'0'..=b'4'))
        }
        _ => false,
    }
}

/// 固定修饰键展示顺序：Alt 组 < Ctrl 组 < Shift 组 < Meta 组。
/// 同组内保持输入相对顺序（稳定排序），修饰键名称本身不改写。
fn modifier_rank(name: &str) -> u8 {
    match name {
        "Alt" => 0,
        "CommandOrControl" | "Control" | "Ctrl" => 1,
        "Shift" => 2,
        "Command" | "Meta" | "Super" => 3,
        _ => unreachable!("modifier validated against HOTKEY_MODIFIERS before ranking"),
    }
}

/// 规范化用户输入的快捷键为规范形：修饰键固定序（Alt+Ctrl+Shift+Meta 组序）+ 键名，
/// 单字符键大写，命名键/功能键保持集合内的规范拼写。
/// 拒绝：空段、重复修饰键、仅修饰键、<2 段、未知修饰键、未知键。
pub fn normalize_hotkey(input: &str) -> Result<String, HotkeyNormalizeError> {
    let parts: Vec<&str> = input.split('+').map(str::trim).collect();

    if parts.iter().any(|part| part.is_empty()) {
        return Err(HotkeyNormalizeError::EmptyKeyPart);
    }

    if parts.len() < 2 {
        return Err(HotkeyNormalizeError::MissingModifier);
    }

    let (key, modifiers) = parts.split_last().expect("parts is non-empty");
    let mut seen_modifiers = HashSet::new();

    for &modifier in modifiers {
        if !is_hotkey_modifier(modifier) {
            return Err(HotkeyNormalizeError::UnsupportedModifier(
                modifier.to_string(),
            ));
        }

        if !seen_modifiers.insert(modifier) {
            return Err(HotkeyNormalizeError::DuplicateModifier(
                modifier.to_string(),
            ));
        }
    }

    if is_hotkey_modifier(key) {
        return Err(HotkeyNormalizeError::ModifierOnly);
    }

    let canonical_key = if is_single_char_key(key) {
        key.to_ascii_uppercase()
    } else if is_function_key(key) || HOTKEY_NAMED_KEYS.contains(key) {
        (*key).to_string()
    } else {
        return Err(HotkeyNormalizeError::UnsupportedKey((*key).to_string()));
    };

    let mut ordered_modifiers: Vec<&str> = modifiers.to_vec();
    ordered_modifiers.sort_by_key(|modifier| modifier_rank(modifier));

    let mut normalized: Vec<String> = ordered_modifiers
        .iter()
        .map(|modifier| (*modifier).to_string())
        .collect();
    normalized.push(canonical_key);
    Ok(normalized.join("+"))
}

/// 逐字 TS `canonicalizeHotkey`：分段 trim + 小写、去空段、别名归一
/// （commandorcontrol→cmdorctrl、control→ctrl、option→alt）、排序后拼接。
fn canonicalize_hotkey(hotkey: &str) -> String {
    let mut parts: Vec<String> = hotkey
        .split('+')
        .map(|part| part.trim().to_lowercase())
        .filter(|part| !part.is_empty())
        .map(|part| match part.as_str() {
            "commandorcontrol" => "cmdorctrl".to_string(),
            "control" => "ctrl".to_string(),
            "option" => "alt".to_string(),
            _ => part,
        })
        .collect();
    parts.sort();
    parts.join("+")
}

/// 跨热键字段查重。`entries` 为 `(字段展示名, 热键字符串)`，按序检查；
/// 冲突时返回逐字 TS 消息（`hotkey` 为后写字段的原始字符串）。
pub fn assert_unique_hotkeys(entries: &[(&str, &str)]) -> Result<(), HotkeyNormalizeError> {
    let mut fields_by_hotkey: HashMap<String, String> = HashMap::new();

    for &(field, hotkey) in entries {
        let canonical = canonicalize_hotkey(hotkey);

        if let Some(existing_field) = fields_by_hotkey.get(&canonical) {
            return Err(HotkeyNormalizeError::Conflict {
                field: field.to_string(),
                conflicts_with: existing_field.clone(),
                hotkey: hotkey.to_string(),
            });
        }

        fields_by_hotkey.insert(canonical, field.to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- normalize_hotkey：合法输入规范化 ----------

    #[test]
    fn default_hotkey_unchanged() {
        assert_eq!(normalize_hotkey("Alt+Space").unwrap(), "Alt+Space");
    }

    #[test]
    fn keeps_canonical_modifier_order() {
        assert_eq!(normalize_hotkey("Ctrl+Shift+K").unwrap(), "Ctrl+Shift+K");
        assert_eq!(
            normalize_hotkey("Alt+Ctrl+Shift+F5").unwrap(),
            "Alt+Ctrl+Shift+F5"
        );
    }

    #[test]
    fn reorders_modifiers_to_fixed_order() {
        assert_eq!(normalize_hotkey("Shift+Ctrl+K").unwrap(), "Ctrl+Shift+K");
        assert_eq!(normalize_hotkey("Shift+Alt+K").unwrap(), "Alt+Shift+K");
        assert_eq!(normalize_hotkey("Meta+Alt+F4").unwrap(), "Alt+Meta+F4");
        assert_eq!(
            normalize_hotkey("Super+Shift+Control+Alt+A").unwrap(),
            "Alt+Control+Shift+Super+A"
        );
    }

    #[test]
    fn uppercases_single_char_keys() {
        assert_eq!(normalize_hotkey("Ctrl+k").unwrap(), "Ctrl+K");
        assert_eq!(normalize_hotkey("Ctrl+K").unwrap(), "Ctrl+K");
        assert_eq!(normalize_hotkey("Ctrl+5").unwrap(), "Ctrl+5");
        assert_eq!(normalize_hotkey("Alt+f").unwrap(), "Alt+F");
    }

    #[test]
    fn accepts_function_keys_f1_through_f24() {
        for n in [1, 5, 9, 10, 15, 19, 20, 21, 24] {
            let input = format!("Ctrl+F{n}");
            assert_eq!(normalize_hotkey(&input).unwrap(), input);
        }
    }

    #[test]
    fn accepts_all_named_keys() {
        for key in HOTKEY_NAMED_KEYS {
            let input = format!("Ctrl+{key}");
            assert_eq!(normalize_hotkey(&input).unwrap(), input, "key: {key}");
        }
    }

    #[test]
    fn accepts_all_modifiers_without_renaming() {
        for modifier in HOTKEY_MODIFIERS {
            let input = format!("{modifier}+A");
            assert_eq!(
                normalize_hotkey(&input).unwrap(),
                input,
                "modifier: {modifier}"
            );
        }
    }

    #[test]
    fn trims_whitespace_around_parts() {
        assert_eq!(normalize_hotkey("  Ctrl +  Space ").unwrap(), "Ctrl+Space");
        assert_eq!(
            normalize_hotkey("Shift + Ctrl + k").unwrap(),
            "Ctrl+Shift+K"
        );
    }

    // ---------- normalize_hotkey：非法输入拒绝 ----------

    #[test]
    fn rejects_empty_input_and_empty_parts() {
        for input in ["", "Ctrl+", "+K", "Ctrl++K", "Ctrl +  + K", "+"] {
            assert_eq!(
                normalize_hotkey(input),
                Err(HotkeyNormalizeError::EmptyKeyPart),
                "input: {input:?}"
            );
        }
    }

    #[test]
    fn rejects_single_part_without_modifier() {
        assert_eq!(
            normalize_hotkey("K"),
            Err(HotkeyNormalizeError::MissingModifier)
        );
        assert_eq!(
            normalize_hotkey("Alt"),
            Err(HotkeyNormalizeError::MissingModifier)
        );
        assert_eq!(
            normalize_hotkey("Space"),
            Err(HotkeyNormalizeError::MissingModifier)
        );
    }

    #[test]
    fn rejects_unknown_modifier() {
        assert_eq!(
            normalize_hotkey("Hyper+K"),
            Err(HotkeyNormalizeError::UnsupportedModifier(
                "Hyper".to_string()
            ))
        );
        assert_eq!(
            normalize_hotkey("Cmd+K"),
            Err(HotkeyNormalizeError::UnsupportedModifier("Cmd".to_string()))
        );
        assert_eq!(
            normalize_hotkey("Option+K"),
            Err(HotkeyNormalizeError::UnsupportedModifier(
                "Option".to_string()
            ))
        );
    }

    #[test]
    fn rejects_lowercase_modifiers_case_sensitively() {
        // TS 修饰键表大小写敏感："ctrl" 不在表内。
        assert_eq!(
            normalize_hotkey("ctrl+K"),
            Err(HotkeyNormalizeError::UnsupportedModifier(
                "ctrl".to_string()
            ))
        );
        assert_eq!(
            normalize_hotkey("ctrl+shift+k"),
            Err(HotkeyNormalizeError::UnsupportedModifier(
                "ctrl".to_string()
            ))
        );
    }

    #[test]
    fn rejects_duplicate_modifier() {
        assert_eq!(
            normalize_hotkey("Ctrl+Ctrl+K"),
            Err(HotkeyNormalizeError::DuplicateModifier("Ctrl".to_string()))
        );
        assert_eq!(
            normalize_hotkey("Shift+Alt+Shift+K"),
            Err(HotkeyNormalizeError::DuplicateModifier("Shift".to_string()))
        );
    }

    #[test]
    fn rejects_modifier_only_combos() {
        assert_eq!(
            normalize_hotkey("Ctrl+Alt"),
            Err(HotkeyNormalizeError::ModifierOnly)
        );
        assert_eq!(
            normalize_hotkey("Ctrl+Shift"),
            Err(HotkeyNormalizeError::ModifierOnly)
        );
        assert_eq!(
            normalize_hotkey("Alt+Meta+Super"),
            Err(HotkeyNormalizeError::ModifierOnly)
        );
    }

    #[test]
    fn rejects_unsupported_keys() {
        for (input, key) in [
            ("Ctrl+Spacebar", "Spacebar"),
            ("Ctrl+@", "@"),
            ("Ctrl+KK", "KK"),
            ("Ctrl+f5", "f5"),
            ("Ctrl+F0", "F0"),
            ("Ctrl+F25", "F25"),
            ("Ctrl+F30", "F30"),
            ("Ctrl+F01", "F01"),
            ("Ctrl+space", "space"),
            ("Ctrl+PAGEUP", "PAGEUP"),
        ] {
            assert_eq!(
                normalize_hotkey(input),
                Err(HotkeyNormalizeError::UnsupportedKey(key.to_string())),
                "input: {input:?}"
            );
        }
    }

    // ---------- 错误消息逐字对齐 TS（context = "Hotkey"） ----------

    #[test]
    fn error_messages_match_ts_wording() {
        assert_eq!(
            HotkeyNormalizeError::EmptyKeyPart.to_string(),
            "Hotkey contains an empty key part."
        );
        assert_eq!(
            HotkeyNormalizeError::MissingModifier.to_string(),
            "Hotkey must include at least one modifier."
        );
        assert_eq!(
            HotkeyNormalizeError::UnsupportedModifier("Hyper".to_string()).to_string(),
            "Hotkey contains unsupported modifier \"Hyper\"."
        );
        assert_eq!(
            HotkeyNormalizeError::DuplicateModifier("Ctrl".to_string()).to_string(),
            "Hotkey contains duplicate modifier \"Ctrl\"."
        );
        assert_eq!(
            HotkeyNormalizeError::ModifierOnly.to_string(),
            "Hotkey must include a non-modifier key."
        );
        assert_eq!(
            HotkeyNormalizeError::UnsupportedKey("Spacebar".to_string()).to_string(),
            "Hotkey contains unsupported key \"Spacebar\"."
        );
    }

    // ---------- assert_unique_hotkeys ----------

    #[test]
    fn accepts_distinct_hotkeys() {
        let entries = [
            ("launcher", "Alt+Space"),
            ("screenshot", "Ctrl+Shift+S"),
            ("delayed screenshot", "Ctrl+Shift+D"),
        ];
        assert!(assert_unique_hotkeys(&entries).is_ok());
        assert!(assert_unique_hotkeys(&[]).is_ok());
    }

    #[test]
    fn detects_exact_duplicate_with_verbatim_message() {
        let entries = [("launcher", "Alt+Space"), ("screenshot", "Alt+Space")];
        let err = assert_unique_hotkeys(&entries).unwrap_err();
        assert_eq!(
            err.to_string(),
            "CommandCabin shortcuts must be unique. screenshot conflicts with launcher: Alt+Space."
        );
    }

    #[test]
    fn detects_alias_equivalence() {
        // control → ctrl
        let entries = [("launcher", "Ctrl+Space"), ("screenshot", "Control+Space")];
        let err = assert_unique_hotkeys(&entries).unwrap_err();
        assert_eq!(
            err.to_string(),
            "CommandCabin shortcuts must be unique. screenshot conflicts with launcher: Control+Space."
        );

        // commandorcontrol → cmdorctrl
        let entries = [
            ("launcher", "CommandOrControl+P"),
            ("screenshot", "CmdOrCtrl+P"),
        ];
        assert!(assert_unique_hotkeys(&entries).is_err());

        // option → alt
        let entries = [("launcher", "Alt+Space"), ("screenshot", "Option+Space")];
        assert!(assert_unique_hotkeys(&entries).is_err());
    }

    #[test]
    fn detects_order_and_case_equivalence() {
        let entries = [("launcher", "Ctrl+Shift+K"), ("screenshot", "shift+ctrl+k")];
        assert!(assert_unique_hotkeys(&entries).is_err());

        let entries = [("launcher", " Alt + Space "), ("screenshot", "alt+space")];
        assert!(assert_unique_hotkeys(&entries).is_err());
    }

    #[test]
    fn reports_first_conflict_in_entry_order() {
        let entries = [
            ("launcher", "Alt+Space"),
            ("screenshot", "Ctrl+Shift+S"),
            ("delayed screenshot", "alt+space"),
        ];
        let err = assert_unique_hotkeys(&entries).unwrap_err();
        assert_eq!(
            err,
            HotkeyNormalizeError::Conflict {
                field: "delayed screenshot".to_string(),
                conflicts_with: "launcher".to_string(),
                hotkey: "alt+space".to_string(),
            }
        );
    }
}
