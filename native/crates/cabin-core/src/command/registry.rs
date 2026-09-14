use std::collections::HashMap;

use thiserror::Error;

use super::types::{Command, CommandSource};

#[derive(Debug, Error, PartialEq, Eq)]
#[error("Command already registered: {0}")]
pub struct DuplicateCommandIdError(pub String);

/// 对齐 TS createCommandRegistry：所有取出操作返回克隆，调用方无法改动内部状态。
#[derive(Default)]
pub struct CommandRegistry {
    commands: HashMap<String, Command>,
}

impl CommandRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, command: Command) -> Result<Command, DuplicateCommandIdError> {
        if self.commands.contains_key(&command.id) {
            return Err(DuplicateCommandIdError(command.id.clone()));
        }
        self.commands.insert(command.id.clone(), command.clone());
        Ok(command)
    }

    pub fn unregister(&mut self, command_id: &str) -> bool {
        self.commands.remove(command_id).is_some()
    }

    pub fn get(&self, command_id: &str) -> Option<Command> {
        self.commands.get(command_id).cloned()
    }

    pub fn has(&self, command_id: &str) -> bool {
        self.commands.contains_key(command_id)
    }

    pub fn list(&self) -> Vec<Command> {
        self.commands.values().cloned().collect()
    }

    pub fn clear_by_source(&mut self, source: CommandSource) -> usize {
        let before = self.commands.len();
        self.commands.retain(|_, command| command.source != source);
        before - self.commands.len()
    }

    pub fn clear(&mut self) {
        self.commands.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::types::tests::sample_command;

    #[test]
    fn register_rejects_duplicate_id() {
        let mut registry = CommandRegistry::new();
        registry
            .register(sample_command("a", CommandSource::App))
            .unwrap();
        let err = registry
            .register(sample_command("a", CommandSource::App))
            .unwrap_err();
        assert_eq!(err.to_string(), "Command already registered: a");
    }

    #[test]
    fn get_returns_clone_not_reference() {
        let mut registry = CommandRegistry::new();
        registry
            .register(sample_command("a", CommandSource::App))
            .unwrap();
        let mut fetched = registry.get("a").unwrap();
        fetched.title = "mutated".into();
        assert_eq!(registry.get("a").unwrap().title, "Command a");
    }

    #[test]
    fn clear_by_source_removes_only_matching() {
        let mut registry = CommandRegistry::new();
        registry
            .register(sample_command("a", CommandSource::App))
            .unwrap();
        registry
            .register(sample_command("s", CommandSource::System))
            .unwrap();
        assert_eq!(registry.clear_by_source(CommandSource::App), 1);
        assert!(!registry.has("a"));
        assert!(registry.has("s"));
    }
}
