//! Windows 启动器：ShellExecuteW 实现 cabin-platform 的 Launcher trait。

use std::path::PathBuf;

use cabin_platform::traits::{LaunchTarget, Launcher, PlatformError};
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

pub struct WindowsLauncher;

impl WindowsLauncher {
    pub fn new() -> Self {
        Self
    }
}

impl Default for WindowsLauncher {
    fn default() -> Self {
        Self::new()
    }
}

fn shell_execute(
    file: &str,
    parameters: Option<&str>,
    working_dir: Option<&PathBuf>,
) -> Result<(), PlatformError> {
    let file = HSTRING::from(file);
    let verb = HSTRING::from("open");
    let params = parameters.map(HSTRING::from);
    let dir = working_dir.map(|p| HSTRING::from(p.to_string_lossy().as_ref()));
    // SAFETY: 全部参数为本帧内有效的 NUL 结尾宽字符串；ShellExecuteW 返回值 <= 32 表示失败。
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(file.as_ptr()),
            params
                .as_ref()
                .map_or(PCWSTR::null(), |p| PCWSTR(p.as_ptr())),
            dir.as_ref().map_or(PCWSTR::null(), |d| PCWSTR(d.as_ptr())),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as usize <= 32 {
        return Err(PlatformError::Launch(format!(
            "ShellExecuteW failed with code {}",
            result.0 as usize
        )));
    }
    Ok(())
}

impl Launcher for WindowsLauncher {
    fn open(&self, target: &LaunchTarget) -> Result<(), PlatformError> {
        match target {
            LaunchTarget::Shortcut(path) | LaunchTarget::Path(path) => {
                shell_execute(&path.to_string_lossy(), None, None)
            }
            LaunchTarget::Executable {
                path,
                arguments,
                working_directory,
            } => shell_execute(
                &path.to_string_lossy(),
                arguments.as_deref(),
                working_directory.as_ref(),
            ),
            LaunchTarget::Url(url) => shell_execute(url, None, None),
        }
    }
}
