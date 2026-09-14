use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub type CommandPayload = Map<String, Value>;
pub type CommandExecutionMetadata = Map<String, Value>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommandSource {
    System,
    App,
    File,
    Url,
    Plugin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommandActionType {
    OpenApp,
    OpenPath,
    OpenUrl,
    CopyText,
    RunPlugin,
    RunSystem,
}

impl CommandSource {
    /// TS 字面量（kebab-case，与 serde 表示一致；DB 按此字符串存储）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::App => "app",
            Self::File => "file",
            Self::Url => "url",
            Self::Plugin => "plugin",
        }
    }

    /// 从 TS 字面量解析；未知值返回 `None`。
    pub fn parse(value: &str) -> Option<CommandSource> {
        match value {
            "system" => Some(Self::System),
            "app" => Some(Self::App),
            "file" => Some(Self::File),
            "url" => Some(Self::Url),
            "plugin" => Some(Self::Plugin),
            _ => None,
        }
    }
}

impl CommandActionType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenApp => "open-app",
            Self::OpenPath => "open-path",
            Self::OpenUrl => "open-url",
            Self::CopyText => "copy-text",
            Self::RunPlugin => "run-plugin",
            Self::RunSystem => "run-system",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandAction {
    #[serde(rename = "type")]
    pub action_type: CommandActionType,
    pub payload: CommandPayload,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Command {
    pub id: String,
    pub source: CommandSource,
    pub title: String,
    pub subtitle: Option<String>,
    pub keywords: Vec<String>,
    pub icon: Option<String>,
    pub plugin_id: Option<String>,
    pub action: CommandAction,
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn sample_command(id: &str, source: CommandSource) -> Command {
        let mut payload = CommandPayload::new();
        payload.insert(
            "path".into(),
            serde_json::Value::String("C:\\app.exe".into()),
        );
        Command {
            id: id.to_string(),
            source,
            title: format!("Command {id}"),
            subtitle: None,
            keywords: vec!["kw".into()],
            icon: None,
            plugin_id: None,
            action: CommandAction {
                action_type: CommandActionType::OpenPath,
                payload,
            },
        }
    }

    #[test]
    fn command_action_type_serializes_kebab_case() {
        let json = serde_json::to_string(&CommandActionType::OpenApp).unwrap();
        assert_eq!(json, "\"open-app\"");
        let back: CommandActionType = serde_json::from_str("\"open-app\"").unwrap();
        assert_eq!(back, CommandActionType::OpenApp);
    }

    #[test]
    fn command_source_as_str_matches_serde_and_parse_round_trips() {
        for source in [
            CommandSource::System,
            CommandSource::App,
            CommandSource::File,
            CommandSource::Url,
            CommandSource::Plugin,
        ] {
            // as_str 与 serde kebab-case 表示一致。
            let json = serde_json::to_string(&source).unwrap();
            assert_eq!(json, format!("\"{}\"", source.as_str()));
            assert_eq!(CommandSource::parse(source.as_str()), Some(source));
            let back: CommandSource = serde_json::from_str(&json).unwrap();
            assert_eq!(back, source);
        }
        assert_eq!(CommandSource::parse("builtin"), None);
        assert_eq!(CommandSource::parse("APP"), None);
    }
}
