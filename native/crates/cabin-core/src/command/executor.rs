use std::collections::HashMap;
use std::fmt;

use super::types::{Command, CommandActionType, CommandExecutionMetadata};

pub type HandlerError = Box<dyn std::error::Error + Send + Sync + 'static>;
pub type HandlerResult = Result<Option<CommandExecutionMetadata>, HandlerError>;

pub trait CommandActionHandler: Send + Sync {
    fn handle(&self, command: &Command) -> HandlerResult;
}

impl<F> CommandActionHandler for F
where
    F: Fn(&Command) -> HandlerResult + Send + Sync,
{
    fn handle(&self, command: &Command) -> HandlerResult {
        self(command)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionErrorCode {
    MissingHandler,
    HandlerError,
    /// 保留与 TS 对齐的错误码；Rust 中 payload 由类型系统保证为合法 JSON，正常路径不可达。
    InvalidCommand,
    InvalidResult,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CommandExecutionResult {
    Success {
        command_id: String,
        action_type: CommandActionType,
        metadata: CommandExecutionMetadata,
    },
    Failure {
        command_id: String,
        action_type: CommandActionType,
        code: ExecutionErrorCode,
        message: String,
    },
}

impl fmt::Display for CommandActionType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Default)]
pub struct CommandExecutor {
    handlers: HashMap<CommandActionType, Box<dyn CommandActionHandler>>,
}

impl CommandExecutor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_handler(
        &mut self,
        action_type: CommandActionType,
        handler: Box<dyn CommandActionHandler>,
    ) {
        self.handlers.insert(action_type, handler);
    }

    pub fn execute(&self, command: &Command) -> CommandExecutionResult {
        let action_type = command.action.action_type;
        let Some(handler) = self.handlers.get(&action_type) else {
            return CommandExecutionResult::Failure {
                command_id: command.id.clone(),
                action_type,
                code: ExecutionErrorCode::MissingHandler,
                message: format!(
                    "No command handler registered for action type \"{action_type}\"."
                ),
            };
        };

        match handler.handle(command) {
            Ok(result) => CommandExecutionResult::Success {
                command_id: command.id.clone(),
                action_type,
                metadata: result.unwrap_or_default(),
            },
            Err(error) => CommandExecutionResult::Failure {
                command_id: command.id.clone(),
                action_type,
                code: ExecutionErrorCode::HandlerError,
                message: error.to_string(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::types::tests::sample_command;
    use crate::command::types::CommandSource;

    struct FailingHandler;
    impl CommandActionHandler for FailingHandler {
        fn handle(&self, _command: &Command) -> HandlerResult {
            Err("boom".into())
        }
    }

    struct NoopHandler;
    impl CommandActionHandler for NoopHandler {
        fn handle(&self, _command: &Command) -> HandlerResult {
            Ok(None)
        }
    }

    #[test]
    fn missing_handler_reports_error_code() {
        let executor = CommandExecutor::new();
        let result = executor.execute(&sample_command("a", CommandSource::App));
        match result {
            CommandExecutionResult::Failure { code, message, .. } => {
                assert_eq!(code, ExecutionErrorCode::MissingHandler);
                assert!(message.contains("open-path"));
            }
            other => panic!("expected failure, got {other:?}"),
        }
    }

    #[test]
    fn handler_error_is_wrapped() {
        let mut executor = CommandExecutor::new();
        executor.register_handler(CommandActionType::OpenPath, Box::new(FailingHandler));
        let result = executor.execute(&sample_command("a", CommandSource::App));
        match result {
            CommandExecutionResult::Failure { code, message, .. } => {
                assert_eq!(code, ExecutionErrorCode::HandlerError);
                assert_eq!(message, "boom");
            }
            other => panic!("expected failure, got {other:?}"),
        }
    }

    #[test]
    fn success_defaults_metadata_to_empty_object() {
        let mut executor = CommandExecutor::new();
        executor.register_handler(CommandActionType::OpenPath, Box::new(NoopHandler));
        match executor.execute(&sample_command("a", CommandSource::App)) {
            CommandExecutionResult::Success {
                command_id,
                metadata,
                ..
            } => {
                assert_eq!(command_id, "a");
                assert!(metadata.is_empty());
            }
            other => panic!("expected success, got {other:?}"),
        }
    }
}
