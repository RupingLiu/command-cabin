//! Settings model ported from `packages/core/src/storage/settings.ts` and
//! `packages/core/src/defaultSettings.ts`.
//!
//! Validation messages mirror `packages/core/src/storage/settingsRepository.ts`.

use serde::{Deserialize, Serialize};
use std::str::FromStr;
use thiserror::Error;

pub const APP_ID: &str = "com.commandcabin.app";
pub const DEFAULT_HOTKEY: &str = "Alt+Space";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Theme {
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Language {
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "zh-TW")]
    ZhTw,
    #[serde(rename = "en-US")]
    EnUs,
}

impl Language {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ZhCn => "zh-CN",
            Self::ZhTw => "zh-TW",
            Self::EnUs => "en-US",
        }
    }
}

impl FromStr for Language {
    type Err = std::convert::Infallible;

    /// Unknown values fall back to zh-CN, matching the TS `getUiStrings`
    /// fallback semantics.
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Ok(match value {
            "zh-TW" => Self::ZhTw,
            "en-US" => Self::EnUs,
            _ => Self::ZhCn,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSettings {
    pub max_results: u32,
    pub history_boost: f64,
    pub plugin_boost: f64,
    pub app_boost: f64,
    pub file_boost: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub hotkey: String,
    pub screenshot_hotkey: String,
    pub delayed_screenshot_hotkey: String,
    pub hide_on_blur: bool,
    pub launch_at_login: bool,
    pub preserve_search_query: bool,
    pub theme: Theme,
    pub language: Language,
    pub search: SearchSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: DEFAULT_HOTKEY.to_string(),
            screenshot_hotkey: "Ctrl+Alt+A".to_string(),
            delayed_screenshot_hotkey: "Ctrl+Alt+D".to_string(),
            hide_on_blur: true,
            launch_at_login: false,
            preserve_search_query: false,
            theme: Theme::System,
            language: Language::ZhCn,
            search: SearchSettings {
                max_results: 20,
                history_boost: 1.4,
                plugin_boost: 1.0,
                app_boost: 1.2,
                file_boost: 0.9,
            },
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SearchSettingsPatch {
    pub max_results: Option<u32>,
    pub history_boost: Option<f64>,
    pub plugin_boost: Option<f64>,
    pub app_boost: Option<f64>,
    pub file_boost: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SettingsPatch {
    pub hotkey: Option<String>,
    pub screenshot_hotkey: Option<String>,
    pub delayed_screenshot_hotkey: Option<String>,
    pub hide_on_blur: Option<bool>,
    pub launch_at_login: Option<bool>,
    pub preserve_search_query: Option<bool>,
    pub theme: Option<Theme>,
    pub language: Option<Language>,
    pub search: Option<SearchSettingsPatch>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SettingsError {
    #[error("Invalid settings: {0}")]
    Invalid(String),
}

fn validate_hotkey(field_name: &str, hotkey: &str) -> Result<(), SettingsError> {
    if hotkey.trim().is_empty() {
        return Err(SettingsError::Invalid(format!(
            "{field_name} must be a non-empty string"
        )));
    }
    Ok(())
}

fn validate_boost(field_name: &str, boost: f64) -> Result<(), SettingsError> {
    if !boost.is_finite() {
        return Err(SettingsError::Invalid(format!(
            "search.{field_name} must be finite"
        )));
    }
    Ok(())
}

impl Settings {
    /// Pure merge: returns a new `Settings` with the patch applied. Invalid
    /// patches return `Err` and leave `self` untouched.
    pub fn apply_patch(&self, patch: &SettingsPatch) -> Result<Settings, SettingsError> {
        if let Some(hotkey) = &patch.hotkey {
            validate_hotkey("hotkey", hotkey)?;
        }
        if let Some(hotkey) = &patch.screenshot_hotkey {
            validate_hotkey("screenshotHotkey", hotkey)?;
        }
        if let Some(hotkey) = &patch.delayed_screenshot_hotkey {
            validate_hotkey("delayedScreenshotHotkey", hotkey)?;
        }
        if let Some(search) = &patch.search {
            if let Some(max_results) = search.max_results {
                if max_results > i32::MAX as u32 {
                    return Err(SettingsError::Invalid(
                        "search.maxResults must be a safe integer >= 0".to_string(),
                    ));
                }
            }
            if let Some(boost) = search.history_boost {
                validate_boost("historyBoost", boost)?;
            }
            if let Some(boost) = search.plugin_boost {
                validate_boost("pluginBoost", boost)?;
            }
            if let Some(boost) = search.app_boost {
                validate_boost("appBoost", boost)?;
            }
            if let Some(boost) = search.file_boost {
                validate_boost("fileBoost", boost)?;
            }
        }

        let mut next = self.clone();
        if let Some(hotkey) = &patch.hotkey {
            next.hotkey = hotkey.clone();
        }
        if let Some(hotkey) = &patch.screenshot_hotkey {
            next.screenshot_hotkey = hotkey.clone();
        }
        if let Some(hotkey) = &patch.delayed_screenshot_hotkey {
            next.delayed_screenshot_hotkey = hotkey.clone();
        }
        if let Some(hide_on_blur) = patch.hide_on_blur {
            next.hide_on_blur = hide_on_blur;
        }
        if let Some(launch_at_login) = patch.launch_at_login {
            next.launch_at_login = launch_at_login;
        }
        if let Some(preserve_search_query) = patch.preserve_search_query {
            next.preserve_search_query = preserve_search_query;
        }
        if let Some(theme) = patch.theme {
            next.theme = theme;
        }
        if let Some(language) = patch.language {
            next.language = language;
        }
        if let Some(search) = &patch.search {
            if let Some(max_results) = search.max_results {
                next.search.max_results = max_results;
            }
            if let Some(boost) = search.history_boost {
                next.search.history_boost = boost;
            }
            if let Some(boost) = search.plugin_boost {
                next.search.plugin_boost = boost;
            }
            if let Some(boost) = search.app_boost {
                next.search.app_boost = boost;
            }
            if let Some(boost) = search.file_boost {
                next.search.file_boost = boost;
            }
        }
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn electron_settings_json() -> &'static str {
        r#"{
            "hotkey": "Alt+Space",
            "screenshotHotkey": "Ctrl+Alt+A",
            "delayedScreenshotHotkey": "Ctrl+Alt+D",
            "hideOnBlur": true,
            "theme": "system",
            "language": "zh-CN",
            "launchAtLogin": false,
            "preserveSearchQuery": false,
            "search": {
                "maxResults": 20,
                "historyBoost": 1.4,
                "pluginBoost": 1,
                "appBoost": 1.2,
                "fileBoost": 0.9
            }
        }"#
    }

    #[test]
    fn constants_match_ts_default_settings() {
        assert_eq!(APP_ID, "com.commandcabin.app");
        assert_eq!(DEFAULT_HOTKEY, "Alt+Space");
    }

    #[test]
    fn default_settings_match_ts_defaults_field_by_field() {
        let settings = Settings::default();
        assert_eq!(settings.hotkey, "Alt+Space");
        assert_eq!(settings.screenshot_hotkey, "Ctrl+Alt+A");
        assert_eq!(settings.delayed_screenshot_hotkey, "Ctrl+Alt+D");
        assert!(settings.hide_on_blur);
        assert!(!settings.launch_at_login);
        assert!(!settings.preserve_search_query);
        assert_eq!(settings.theme, Theme::System);
        assert_eq!(settings.language, Language::ZhCn);
        assert_eq!(settings.search.max_results, 20);
        assert_eq!(settings.search.history_boost, 1.4);
        assert_eq!(settings.search.plugin_boost, 1.0);
        assert_eq!(settings.search.app_boost, 1.2);
        assert_eq!(settings.search.file_boost, 0.9);
    }

    #[test]
    fn apply_patch_merges_partial_fields_without_touching_original() {
        let base = Settings::default();
        let patch = SettingsPatch {
            hotkey: Some("Ctrl+Space".to_string()),
            theme: Some(Theme::Dark),
            launch_at_login: Some(true),
            ..SettingsPatch::default()
        };

        let next = base.apply_patch(&patch).expect("patch is valid");

        assert_eq!(next.hotkey, "Ctrl+Space");
        assert_eq!(next.theme, Theme::Dark);
        assert!(next.launch_at_login);
        assert_eq!(next.screenshot_hotkey, "Ctrl+Alt+A");
        assert_eq!(next.delayed_screenshot_hotkey, "Ctrl+Alt+D");
        assert!(next.hide_on_blur);
        assert!(!next.preserve_search_query);
        assert_eq!(next.language, Language::ZhCn);
        assert_eq!(next.search, base.search);

        // Pure function: the base settings are unchanged.
        assert_eq!(base, Settings::default());
    }

    #[test]
    fn apply_patch_merges_search_sub_object_partially() {
        let base = Settings::default();
        let patch = SettingsPatch {
            search: Some(SearchSettingsPatch {
                max_results: Some(50),
                app_boost: Some(2.0),
                ..SearchSettingsPatch::default()
            }),
            ..SettingsPatch::default()
        };

        let next = base.apply_patch(&patch).expect("patch is valid");

        assert_eq!(next.search.max_results, 50);
        assert_eq!(next.search.app_boost, 2.0);
        assert_eq!(next.search.history_boost, 1.4);
        assert_eq!(next.search.plugin_boost, 1.0);
        assert_eq!(next.search.file_boost, 0.9);
    }

    #[test]
    fn apply_patch_rejects_non_finite_boosts() {
        let base = Settings::default();
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let patches = [
                SearchSettingsPatch {
                    history_boost: Some(bad),
                    ..SearchSettingsPatch::default()
                },
                SearchSettingsPatch {
                    plugin_boost: Some(bad),
                    ..SearchSettingsPatch::default()
                },
                SearchSettingsPatch {
                    app_boost: Some(bad),
                    ..SearchSettingsPatch::default()
                },
                SearchSettingsPatch {
                    file_boost: Some(bad),
                    ..SearchSettingsPatch::default()
                },
            ];
            for search in patches {
                let patch = SettingsPatch {
                    search: Some(search),
                    ..SettingsPatch::default()
                };
                let err = base
                    .apply_patch(&patch)
                    .expect_err("non-finite boost must be rejected");
                assert!(err.to_string().contains("must be finite"), "{err}");
            }
        }
    }

    #[test]
    fn apply_patch_rejects_max_results_outside_safe_integer_domain() {
        let base = Settings::default();
        let patch = SettingsPatch {
            search: Some(SearchSettingsPatch {
                max_results: Some(u32::MAX),
                ..SearchSettingsPatch::default()
            }),
            ..SettingsPatch::default()
        };

        let err = base
            .apply_patch(&patch)
            .expect_err("max_results above i32::MAX must be rejected");
        assert_eq!(
            err.to_string(),
            "Invalid settings: search.maxResults must be a safe integer >= 0"
        );

        let boundary = SettingsPatch {
            search: Some(SearchSettingsPatch {
                max_results: Some(i32::MAX as u32),
                ..SearchSettingsPatch::default()
            }),
            ..SettingsPatch::default()
        };
        let next = base
            .apply_patch(&boundary)
            .expect("i32::MAX is the largest safe value");
        assert_eq!(next.search.max_results, i32::MAX as u32);
    }

    #[test]
    fn apply_patch_rejects_blank_hotkeys() {
        let base = Settings::default();
        let patches = [
            SettingsPatch {
                hotkey: Some("   ".to_string()),
                ..SettingsPatch::default()
            },
            SettingsPatch {
                screenshot_hotkey: Some(String::new()),
                ..SettingsPatch::default()
            },
            SettingsPatch {
                delayed_screenshot_hotkey: Some("\t ".to_string()),
                ..SettingsPatch::default()
            },
        ];
        for patch in patches {
            let err = base
                .apply_patch(&patch)
                .expect_err("blank hotkey must be rejected");
            assert!(err.to_string().starts_with("Invalid settings: "), "{err}");
        }
    }

    #[test]
    fn settings_serialize_to_camel_case_json() {
        let settings = Settings::default();
        let value = serde_json::to_value(&settings).expect("serialize");
        assert_eq!(value["hotkey"], "Alt+Space");
        assert_eq!(value["screenshotHotkey"], "Ctrl+Alt+A");
        assert_eq!(value["delayedScreenshotHotkey"], "Ctrl+Alt+D");
        assert_eq!(value["hideOnBlur"], true);
        assert_eq!(value["launchAtLogin"], false);
        assert_eq!(value["preserveSearchQuery"], false);
        assert_eq!(value["theme"], "system");
        assert_eq!(value["language"], "zh-CN");
        assert_eq!(value["search"]["maxResults"], 20);
        assert_eq!(value["search"]["historyBoost"], 1.4);
        assert_eq!(value["search"]["pluginBoost"], 1.0);
        assert_eq!(value["search"]["appBoost"], 1.2);
        assert_eq!(value["search"]["fileBoost"], 0.9);
    }

    #[test]
    fn settings_serde_roundtrip_preserves_values() {
        let settings = Settings {
            hotkey: "Ctrl+Space".to_string(),
            theme: Theme::Light,
            language: Language::ZhTw,
            launch_at_login: true,
            search: SearchSettings {
                max_results: 42,
                history_boost: 2.5,
                plugin_boost: 0.5,
                app_boost: 3.25,
                file_boost: 0.125,
            },
            ..Settings::default()
        };
        let json = serde_json::to_string(&settings).expect("serialize");
        let parsed: Settings = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, settings);
    }

    #[test]
    fn parses_electron_written_settings_json() {
        let parsed: Settings =
            serde_json::from_str(electron_settings_json()).expect("Electron JSON parses");
        assert_eq!(parsed, Settings::default());

        let customized = electron_settings_json()
            .replace("\"system\"", "\"dark\"")
            .replace("\"zh-CN\"", "\"zh-TW\"");
        let parsed: Settings = serde_json::from_str(&customized).expect("Electron JSON parses");
        assert_eq!(parsed.theme, Theme::Dark);
        assert_eq!(parsed.language, Language::ZhTw);
    }

    #[test]
    fn language_serde_uses_ts_string_values() {
        assert_eq!(
            serde_json::to_string(&Language::ZhCn).expect("serialize"),
            "\"zh-CN\""
        );
        assert_eq!(
            serde_json::to_string(&Language::ZhTw).expect("serialize"),
            "\"zh-TW\""
        );
        assert_eq!(
            serde_json::to_string(&Language::EnUs).expect("serialize"),
            "\"en-US\""
        );
        let parsed: Language = serde_json::from_str("\"zh-CN\"").expect("deserialize");
        assert_eq!(parsed, Language::ZhCn);
    }

    #[test]
    fn language_as_str_matches_ts_values() {
        assert_eq!(Language::ZhCn.as_str(), "zh-CN");
        assert_eq!(Language::ZhTw.as_str(), "zh-TW");
        assert_eq!(Language::EnUs.as_str(), "en-US");
    }

    #[test]
    fn language_from_str_falls_back_to_zh_cn_for_unknown_values() {
        assert_eq!(Language::from_str("zh-CN"), Ok(Language::ZhCn));
        assert_eq!(Language::from_str("zh-TW"), Ok(Language::ZhTw));
        assert_eq!(Language::from_str("en-US"), Ok(Language::EnUs));
        assert_eq!(Language::from_str("fr-FR"), Ok(Language::ZhCn));
        assert_eq!(Language::from_str(""), Ok(Language::ZhCn));
    }
}
