//! 由 IndexedShortcut 生成启动器命令。移植自 packages/core/src/indexer/appIndexer.ts
//!（M1 简化版：新增卸载项过滤；命令级 identity 去重留待后续任务）。

use std::path::Path;

use sha2::{Digest, Sha256};

use crate::command::types::{
    Command, CommandAction, CommandActionType, CommandPayload, CommandSource,
};
use crate::indexer::{IndexedShortcut, PackagedAppEntry};

const EXECUTABLE_EXTENSIONS: [&str; 4] = [".exe", ".com", ".bat", ".cmd"];
const COMMON_CONTAINER_NAMES: [&str; 3] = ["programs", "start menu", "startmenu"];

fn normalize_command_id_input(shortcut_path: &str) -> String {
    shortcut_path.replace('/', "\\").to_lowercase()
}

/// sha256 前 6 字节 = 12 个 hex 字符。app 命令 id scheme 家族：
/// `app.{前 12 hex}` —— .lnk 应用哈希归一化快捷方式路径，打包应用（UI 修复 4）
/// 哈希 AUMID 原文（PackageManager 返回的 AUMID 大小写/内容稳定，无需归一化；
/// 与 `favorite.{...}` 等前缀命名的既有惯例一致）。
fn hash_hex_prefix_12(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    digest
        .iter()
        .take(6)
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

fn command_id(shortcut_path: &str) -> String {
    let normalized = normalize_command_id_input(shortcut_path);
    format!("app.{}", hash_hex_prefix_12(&normalized))
}

/// 打包应用命令 id：`app.{sha256(aumid) 前 12 hex}`（稳定，同一 AUMID 恒同 id；
/// 与 .lnk 的 `app.{sha256(shortcutPath)}` 无哈希输入重叠，不会碰撞）。
pub fn packaged_app_command_id(app_user_model_id: &str) -> String {
    format!("app.{}", hash_hex_prefix_12(app_user_model_id))
}

/// M1 简化过滤：名称以 "unins" 开头、或含 "uninstall"/"卸载" 的快捷方式跳过。
fn is_uninstaller(name: &str) -> bool {
    let lowered = name.trim().to_lowercase();
    lowered.starts_with("unins") || lowered.contains("uninstall") || lowered.contains("卸载")
}

fn is_executable(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            EXECUTABLE_EXTENSIONS.contains(&format!(".{}", ext.to_lowercase()).as_str())
        })
}

fn parent_keyword(shortcut_path: &Path) -> Option<String> {
    let parent = shortcut_path.parent()?.file_name()?.to_str()?.trim();
    if parent.is_empty() || COMMON_CONTAINER_NAMES.contains(&parent.to_lowercase().as_str()) {
        return None;
    }
    Some(parent.to_string())
}

fn add_keyword(keywords: &mut Vec<String>, keyword: Option<&str>) {
    let Some(keyword) = keyword else { return };
    let trimmed = keyword.trim();
    if trimmed.is_empty() || keywords.iter().any(|k| k == trimmed) {
        return;
    }
    keywords.push(trimmed.to_string());
}

pub fn commands_from_shortcuts(shortcuts: &[IndexedShortcut]) -> Vec<Command> {
    shortcuts
        .iter()
        .filter(|shortcut| !is_uninstaller(&shortcut.name))
        .map(|shortcut| {
            let mut keywords = Vec::new();
            add_keyword(&mut keywords, Some(&shortcut.name));
            add_keyword(&mut keywords, Some(&shortcut.name.to_lowercase()));
            add_keyword(
                &mut keywords,
                parent_keyword(&shortcut.shortcut_path).as_deref(),
            );
            add_keyword(
                &mut keywords,
                shortcut.target_path.as_ref().and_then(|p| p.to_str()),
            );
            add_keyword(&mut keywords, shortcut.app_user_model_id.as_deref());
            if shortcut.target_path.is_none() && shortcut.app_user_model_id.is_none() {
                add_keyword(&mut keywords, shortcut.shortcut_path.to_str());
            }

            let executable = shortcut.target_path.as_deref().is_some_and(is_executable);
            let mut payload = CommandPayload::new();
            payload.insert(
                "shortcutPath".into(),
                shortcut.shortcut_path.to_string_lossy().into_owned().into(),
            );
            if let Some(aumid) = &shortcut.app_user_model_id {
                payload.insert("appUserModelId".into(), aumid.clone().into());
            }
            let action_type = if executable {
                if let Some(target) = &shortcut.target_path {
                    payload.insert(
                        "executablePath".into(),
                        target.to_string_lossy().into_owned().into(),
                    );
                }
                if let Some(arguments) = &shortcut.arguments {
                    payload.insert("arguments".into(), arguments.clone().into());
                }
                if let Some(working) = &shortcut.working_directory {
                    payload.insert(
                        "workingDirectory".into(),
                        working.to_string_lossy().into_owned().into(),
                    );
                }
                CommandActionType::OpenApp
            } else {
                payload.insert(
                    "path".into(),
                    shortcut
                        .target_path
                        .as_ref()
                        .unwrap_or(&shortcut.shortcut_path)
                        .to_string_lossy()
                        .into_owned()
                        .into(),
                );
                CommandActionType::OpenPath
            };

            Command {
                id: command_id(&shortcut.shortcut_path.to_string_lossy()),
                source: CommandSource::App,
                title: shortcut.name.clone(),
                subtitle: shortcut
                    .target_path
                    .as_ref()
                    .map(|p| p.to_string_lossy().into_owned()),
                // 与 TS 的差距：TS 的 subtitle 回退链为 target ?? aumid ?? shortcutPath，
                // 此处无 target 时为 None（M1 无 AUMID，影响可忽略；M2 引入 AUMID 时补齐）。
                keywords,
                icon: shortcut.icon_path.clone(),
                plugin_id: None,
                action: CommandAction {
                    action_type,
                    payload,
                },
            }
        })
        .collect()
}

/// 打包应用 → open-app 命令（UI 修复 4）。TS-parity 说明（M1 T9 评审挂账的
/// AUMID 规则）：MSIX/APPX 打包应用没有可执行文件路径，`shell:AppsFolder\{AUMID}`
/// 是 TS 语义下该应用的等价"快捷方式"——open-app + `shortcutPath =
/// shell:AppsFolder\{AUMID}` 经 ShellExecuteW 由 Shell 负责激活（.lnk 应用保持
/// 既有扩展名判定不变，此规则仅适用于打包路径）。
///
/// - id：[`packaged_app_command_id`]（`app.{sha256(aumid) 前 12 hex}`）
/// - title：display_name（trim 后为空时回退 AUMID，防止无名条目）
/// - subtitle：AUMID（对齐 TS 的 target ?? aumid ?? shortcutPath 回退链——
///   打包应用无 target，取 aumid）
/// - keywords：镜像 `commands_from_shortcuts` 的关键词推导（名称、名称小写、
///   AUMID；打包应用无父目录/target 路径可加）
/// - icon：`shell:AppsFolder\{AUMID}`——图标水合候选管线把 icon 排在首位，
///   extract_icon_png 已原生支持该 shell 命名空间项
pub fn command_from_packaged_app(display_name: &str, app_user_model_id: &str) -> Command {
    let aumid = app_user_model_id.trim();
    let title = display_name.trim();
    let title = if title.is_empty() { aumid } else { title };
    let shell_target = format!("shell:AppsFolder\\{aumid}");

    let mut keywords = Vec::new();
    add_keyword(&mut keywords, Some(title));
    add_keyword(&mut keywords, Some(&title.to_lowercase()));
    add_keyword(&mut keywords, Some(aumid));

    let mut payload = CommandPayload::new();
    payload.insert("shortcutPath".into(), shell_target.clone().into());
    payload.insert("appUserModelId".into(), aumid.to_string().into());

    Command {
        id: packaged_app_command_id(aumid),
        source: CommandSource::App,
        title: title.to_string(),
        subtitle: Some(aumid.to_string()),
        keywords,
        icon: Some(shell_target),
        plugin_id: None,
        action: CommandAction {
            action_type: CommandActionType::OpenApp,
            payload,
        },
    }
}

/// 批量转换打包应用条目。
pub fn commands_from_packaged_apps(entries: &[PackagedAppEntry]) -> Vec<Command> {
    entries
        .iter()
        .map(|entry| command_from_packaged_app(&entry.display_name, &entry.app_user_model_id))
        .collect()
}

/// 合并 .lnk 与打包应用命令并去重（先到先得，保持输入序）。
/// 两级（对齐 TS appIndexer.ts dedupeAppCommands）：
/// 1. id：同 id 直接丢弃（防御——两组 id 哈希输入不同，正常不碰撞）。
/// 2. identity key（TS createAppCommandIdentityKey）：open-app 命令按
///    title + appUserModelId/executablePath + arguments + workingDirectory
///    合成——桌面与开始菜单指向同一 exe 的两个 .lnk（如飞书）因此合并为一条；
///    非 app/open-app 命令按 id 兜底。
pub fn merge_app_commands(
    shortcut_commands: Vec<Command>,
    packaged_commands: Vec<Command>,
) -> Vec<Command> {
    let mut seen_ids = std::collections::HashSet::new();
    let mut seen_identities = std::collections::HashSet::new();
    shortcut_commands
        .into_iter()
        .chain(packaged_commands)
        .filter(|command| {
            if !seen_ids.insert(command.id.clone()) {
                return false;
            }
            seen_identities.insert(app_command_identity_key(command))
        })
        .collect()
}

/// TS createAppCommandIdentityKey 的等价实现：
/// open-app 命令 → "app-user-model-id|title|aumid|args|workdir"（有 AUMID）
/// 或 "executable|title|exePath|args|workdir"（无 AUMID 有 exe 路径）；
/// 其余 → "id:{id}"。文本 trim+lowercase，路径额外 '/'→'\\'（对齐 TS
/// normalizeIdentityText / normalizeIdentityPath / normalizeCommandIdInput）。
fn app_command_identity_key(command: &Command) -> String {
    if command.source != CommandSource::App
        || command.action.action_type != CommandActionType::OpenApp
    {
        return format!("id:{}", command.id);
    }
    let payload = &command.action.payload;
    let title = normalize_identity_text(Some(command.title.as_str()));
    let aumid = normalize_identity_text(payload_str(payload, "appUserModelId"));
    let executable = normalize_identity_path(payload_str(payload, "executablePath"));
    let arguments = normalize_identity_text(payload_str(payload, "arguments"));
    let working_directory = normalize_identity_path(payload_str(payload, "workingDirectory"));

    if !aumid.is_empty() {
        return [
            "app-user-model-id",
            &title,
            &aumid,
            &arguments,
            &working_directory,
        ]
        .join("|");
    }
    if !executable.is_empty() {
        return [
            "executable",
            &title,
            &executable,
            &arguments,
            &working_directory,
        ]
        .join("|");
    }
    format!("id:{}", command.id)
}

fn payload_str<'p>(
    payload: &'p crate::command::types::CommandPayload,
    key: &str,
) -> Option<&'p str> {
    payload.get(key).and_then(serde_json::Value::as_str)
}

fn normalize_identity_text(value: Option<&str>) -> String {
    value.map(str::trim).unwrap_or_default().to_lowercase()
}

fn normalize_identity_path(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .unwrap_or_default()
        .replace('/', "\\")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::types::CommandActionType;
    use crate::indexer::IndexedShortcut;
    use std::path::PathBuf;

    fn shortcut(name: &str, path: &str, target: Option<&str>) -> IndexedShortcut {
        IndexedShortcut {
            shortcut_path: PathBuf::from(path),
            name: name.into(),
            target_path: target.map(PathBuf::from),
            arguments: None,
            working_directory: None,
            app_user_model_id: None,
            icon_path: None,
        }
    }

    #[test]
    fn command_id_is_stable_sha256_prefix() {
        let commands = commands_from_shortcuts(&[shortcut(
            "Code",
            r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Code.lnk",
            Some(r"C:\Apps\code.exe"),
        )]);
        assert_eq!(commands.len(), 1);
        assert!(commands[0].id.starts_with("app."));
        assert_eq!(commands[0].id.len(), "app.".len() + 12);
        // 路径分隔符/大小写归一后 id 相同
        let again = commands_from_shortcuts(&[shortcut(
            "Code",
            "c:/programdata/microsoft/windows/start menu/programs/code.lnk",
            Some(r"C:\Apps\code.exe"),
        )]);
        assert_eq!(commands[0].id, again[0].id);
    }

    #[test]
    fn uninstaller_shortcuts_are_skipped() {
        let commands = commands_from_shortcuts(&[
            shortcut(
                "Uninstall Code",
                r"C:\x\uninstall code.lnk",
                Some(r"C:\x\unins000.exe"),
            ),
            shortcut("Code", r"C:\x\code.lnk", Some(r"C:\x\code.exe")),
        ]);
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].title, "Code");
    }

    #[test]
    fn executable_target_produces_open_app_with_payload() {
        let commands =
            commands_from_shortcuts(&[shortcut("Code", r"C:\x\code.lnk", Some(r"C:\x\code.exe"))]);
        assert_eq!(commands[0].action.action_type, CommandActionType::OpenApp);
        assert_eq!(
            commands[0]
                .action
                .payload
                .get("executablePath")
                .and_then(|v| v.as_str()),
            Some(r"C:\x\code.exe")
        );
    }

    #[test]
    fn non_executable_target_produces_open_path() {
        let commands =
            commands_from_shortcuts(&[shortcut("Docs", r"C:\x\docs.lnk", Some(r"C:\x\docs"))]);
        assert_eq!(commands[0].action.action_type, CommandActionType::OpenPath);
    }

    // ---- 打包应用（MSIX/APPX）命令映射（UI 修复 4） ----

    fn packaged_entry(name: &str, aumid: &str) -> PackagedAppEntry {
        PackagedAppEntry {
            display_name: name.into(),
            app_user_model_id: aumid.into(),
        }
    }

    /// 1Password 的真实 AUMID（本机 Get-StartApps 实证），作为活体形状参照。
    const ONEPASSWORD_AUMID: &str = "DC5C6510.2032887045529_2v019pwa6amcg!Agilebits.OnePassword";

    #[test]
    fn packaged_app_id_is_stable_sha256_prefix_of_aumid() {
        let command = command_from_packaged_app("1Password", ONEPASSWORD_AUMID);
        assert!(command.id.starts_with("app."));
        assert_eq!(command.id.len(), "app.".len() + 12);
        // 同一 AUMID 恒同 id（稳定 scheme）。
        let again = command_from_packaged_app("1Password", ONEPASSWORD_AUMID);
        assert_eq!(command.id, again.id);
        // AUMID 前后空白在 id 与 payload 中均被 trim。
        let padded = command_from_packaged_app("1Password", &format!("  {ONEPASSWORD_AUMID} "));
        assert_eq!(command.id, padded.id);
        // 不同 AUMID → 不同 id；与 .lnk 的路径哈希输入无重叠。
        let other =
            command_from_packaged_app("其他", "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App");
        assert_ne!(command.id, other.id);
    }

    #[test]
    fn packaged_app_maps_to_open_app_with_shell_apps_folder_payload() {
        let command = command_from_packaged_app("1Password", ONEPASSWORD_AUMID);
        assert_eq!(command.source, CommandSource::App);
        assert_eq!(command.title, "1Password");
        assert_eq!(command.action.action_type, CommandActionType::OpenApp);
        assert_eq!(
            command
                .action
                .payload
                .get("shortcutPath")
                .and_then(|v| v.as_str()),
            Some("shell:AppsFolder\\DC5C6510.2032887045529_2v019pwa6amcg!Agilebits.OnePassword")
        );
        assert_eq!(
            command
                .action
                .payload
                .get("appUserModelId")
                .and_then(|v| v.as_str()),
            Some(ONEPASSWORD_AUMID)
        );
        // icon = shell:AppsFolder\{AUMID}：图标水合候选首位即命中。
        assert_eq!(
            command.icon.as_deref(),
            Some("shell:AppsFolder\\DC5C6510.2032887045529_2v019pwa6amcg!Agilebits.OnePassword")
        );
        // subtitle 走 TS 回退链的 aumid 一层（打包应用无 target）。
        assert_eq!(command.subtitle.as_deref(), Some(ONEPASSWORD_AUMID));
    }

    #[test]
    fn packaged_app_keywords_mirror_shortcut_derivation() {
        let command = command_from_packaged_app("1Password", ONEPASSWORD_AUMID);
        assert!(command.keywords.contains(&"1Password".to_string()));
        assert!(command.keywords.contains(&"1password".to_string()));
        assert!(command.keywords.iter().any(|k| k.contains('!')));
    }

    #[test]
    fn packaged_app_blank_display_name_falls_back_to_aumid() {
        let command = command_from_packaged_app("   ", ONEPASSWORD_AUMID);
        assert_eq!(command.title, ONEPASSWORD_AUMID);
        // 名称与回退去重后关键词不重复。
        assert_eq!(
            command
                .keywords
                .iter()
                .filter(|k| **k == ONEPASSWORD_AUMID)
                .count(),
            1
        );
    }

    #[test]
    fn commands_from_packaged_apps_maps_each_entry() {
        let commands = commands_from_packaged_apps(&[
            packaged_entry("1Password", ONEPASSWORD_AUMID),
            packaged_entry("Terminal", "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App"),
        ]);
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].title, "1Password");
        assert_eq!(commands[1].title, "Terminal");
    }

    #[test]
    fn merge_app_commands_dedupes_by_id_keeping_first() {
        let shortcut_commands =
            commands_from_shortcuts(&[shortcut("Code", r"C:\x\code.lnk", Some(r"C:\x\code.exe"))]);
        let first = command_from_packaged_app("First", ONEPASSWORD_AUMID);
        // 同 id 的重复项：先到先留，title 保持先出现的 "First"。
        let duplicate = command_from_packaged_app("Duplicate", ONEPASSWORD_AUMID);
        let second =
            command_from_packaged_app("Second", "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App");
        let merged = merge_app_commands(shortcut_commands, vec![first, duplicate, second]);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].title, "Code");
        assert_eq!(merged[1].title, "First");
        assert_eq!(merged[2].title, "Second");
    }

    /// 用户实测：飞书在桌面与开始菜单各有一个 .lnk（两个 id），同名同目标
    /// exe——TS appIndexer.dedupeAppCommands 按 identity key（title+exe 等）
    /// 合并，native 此前只按 id 去重导致搜索结果出现两条。本测试固化该语义。
    #[test]
    fn merge_app_commands_dedupes_same_target_different_shortcut_paths() {
        let shortcut_commands = commands_from_shortcuts(&[
            shortcut(
                "飞书",
                r"C:\Users\x\Desktop\飞书.lnk",
                Some(r"C:\Users\x\AppData\Local\Feishu\Feishu.exe"),
            ),
            shortcut(
                "飞书",
                r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\飞书.lnk",
                // 路径分隔符/大小写差异不应影响身份判定（TS normalizeIdentityPath）。
                Some(r"C:\USERS\X\AppData\Local\Feishu/Feishu.exe"),
            ),
            shortcut("VS Code", r"C:\x\code.lnk", Some(r"C:\x\code.exe")),
        ]);
        let merged = merge_app_commands(shortcut_commands, vec![]);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].title, "飞书");
        assert_eq!(merged[1].title, "VS Code");
    }

    /// 同名不同目标的快捷方式（如不同版本 MATLAB）不得合并。
    #[test]
    fn merge_app_commands_keeps_same_title_different_targets() {
        let shortcut_commands = commands_from_shortcuts(&[
            shortcut(
                "MATLAB",
                r"C:\a\matlab.lnk",
                Some(r"C:\R2025b\bin\matlab.exe"),
            ),
            shortcut(
                "MATLAB",
                r"C:\b\matlab.lnk",
                Some(r"C:\R2024a\bin\matlab.exe"),
            ),
        ]);
        let merged = merge_app_commands(shortcut_commands, vec![]);
        assert_eq!(merged.len(), 2);
    }
}
