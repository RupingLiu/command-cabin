//! 视图转换与动作分发辅助。把 core 的 Command 字段翻译为 Slint 视图模型，
//! 并把命令 action 翻译为平台层 LaunchTarget；两个方向都是纯函数，可脱离 UI 单测。

use std::path::PathBuf;

use cabin_core::command::types::{CommandActionType, CommandPayload};
use cabin_platform::traits::LaunchTarget;

pub struct ViewItem {
    pub title: String,
    pub subtitle: String,
}

pub fn view_item(title: &str, subtitle: &Option<String>) -> ViewItem {
    ViewItem {
        title: title.to_string(),
        subtitle: subtitle.clone().unwrap_or_default(),
    }
}

/// 由命令 action 构造启动目标；缺少必要 payload 键时报错（边界校验职责，对齐
/// TS shared API parser 的“拒绝畸形输入后进入核心”约定）。
pub fn launch_target_for(
    action_type: &CommandActionType,
    payload: &CommandPayload,
) -> Result<LaunchTarget, String> {
    let get_path = |key: &str| -> Result<PathBuf, String> {
        payload
            .get(key)
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| format!("action payload is missing \"{key}\""))
    };
    match action_type {
        CommandActionType::OpenApp => Ok(LaunchTarget::Shortcut(get_path("shortcutPath")?)),
        CommandActionType::OpenPath => Ok(LaunchTarget::Path(get_path("path")?)),
        CommandActionType::OpenUrl => {
            let url = payload
                .get("url")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "action payload is missing \"url\"".to_string())?;
            Ok(LaunchTarget::Url(url.to_string()))
        }
        other => Err(format!(
            "action type \"{}\" has no launch target",
            other.as_str()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_search_results_to_view_items() {
        // 构造一个最小 SearchResultItem 并验证 title/subtitle 映射与空 subtitle 回退
        let item = view_item("Visual Studio Code", &None);
        assert_eq!(item.subtitle, "");
        let item = view_item("Code", &Some("C:\\code.exe".to_string()));
        assert_eq!(item.subtitle, "C:\\code.exe");
    }

    #[test]
    fn launch_target_from_open_app_uses_shortcut() {
        let mut payload = CommandPayload::new();
        payload.insert("shortcutPath".into(), "C:\\x.lnk".into());
        payload.insert("executablePath".into(), "C:\\x.exe".into());
        let target = launch_target_for(&CommandActionType::OpenApp, &payload).unwrap();
        // 走 .lnk 让 Shell 处理 AUMID/参数（对齐 TS open-app 行为）
        assert_eq!(target, LaunchTarget::Shortcut(PathBuf::from("C:\\x.lnk")));
    }

    #[test]
    fn launch_target_missing_path_is_error() {
        assert!(launch_target_for(&CommandActionType::OpenPath, &CommandPayload::new()).is_err());
    }
}
