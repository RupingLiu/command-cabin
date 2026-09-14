//! 全局快捷键字符串解析。移植自 TS 设置中的 hotkey 表达（"Alt+Space"）。
//! 仅做纯解析：产物为小写键名 + 修饰键标志，具体键码映射由平台层完成。

use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accelerator {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
    /// 小写键名（"space"、"k"、"f5"……）。具体键码映射由平台层完成。
    pub key: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AcceleratorError {
    #[error("Accelerator must end with a non-modifier key: \"{0}\"")]
    MissingKey(String),
    #[error("Unknown accelerator modifier \"{0}\" in \"{1}\"")]
    UnknownModifier(String, String),
}

fn is_modifier(name: &str) -> bool {
    matches!(
        name,
        "ctrl" | "control" | "shift" | "alt" | "meta" | "win" | "super"
    )
}

pub fn parse_accelerator(input: &str) -> Result<Accelerator, AcceleratorError> {
    let mut accelerator = Accelerator {
        ctrl: false,
        shift: false,
        alt: false,
        meta: false,
        key: String::new(),
    };
    let parts: Vec<&str> = input.split('+').map(|part| part.trim()).collect();
    let (key_part, modifier_parts) = parts
        .split_last()
        .ok_or_else(|| AcceleratorError::MissingKey(input.to_string()))?;
    let key = key_part.to_ascii_lowercase();
    // 末段必须是非修饰键："Alt"、"Alt+"、"Ctrl+Alt" 均拒绝。
    if key.is_empty() || is_modifier(&key) {
        return Err(AcceleratorError::MissingKey(input.to_string()));
    }
    for modifier in modifier_parts {
        match modifier.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => accelerator.ctrl = true,
            "shift" => accelerator.shift = true,
            "alt" => accelerator.alt = true,
            "meta" | "win" | "super" => accelerator.meta = true,
            "" => return Err(AcceleratorError::MissingKey(input.to_string())),
            other => {
                return Err(AcceleratorError::UnknownModifier(
                    other.to_string(),
                    input.to_string(),
                ));
            }
        }
    }
    accelerator.key = key;
    Ok(accelerator)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modifier_combo() {
        let acc = parse_accelerator("Ctrl+Shift+K").unwrap();
        assert!(acc.ctrl && acc.shift && !acc.alt && !acc.meta);
        assert_eq!(acc.key, "k");
    }

    #[test]
    fn default_hotkey_alt_space() {
        let acc = parse_accelerator("Alt+Space").unwrap();
        assert!(acc.alt);
        assert_eq!(acc.key, "space");
    }

    #[test]
    fn rejects_empty_and_modifier_only() {
        assert!(parse_accelerator("").is_err());
        assert!(parse_accelerator("Alt+").is_err());
        assert!(parse_accelerator("Alt").is_err());
    }

    #[test]
    fn rejects_unknown_modifier() {
        assert!(parse_accelerator("Hyper+K").is_err());
    }
}
