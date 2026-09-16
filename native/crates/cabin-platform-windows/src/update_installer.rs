//! Start the per-machine NSIS installer through the Windows elevation broker.
//! CreateProcess (including std::process::Command) cannot request UAC elevation.
use std::path::Path;

use windows::core::{Error, HSTRING, PCWSTR};
use windows::Win32::Foundation::ERROR_CANCELLED;
use windows::Win32::UI::Shell::{
    ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

#[derive(Debug, PartialEq, Eq)]
pub enum InstallerLaunch {
    Started,
    Cancelled,
}

/// Only called after the user chooses Install for a verified download.
pub fn launch_installer(program: &Path) -> Result<InstallerLaunch, String> {
    if !program.is_file() {
        return Err(format!("installer is missing: {}", program.display()));
    }
    launch_with(program, |info| {
        // SAFETY: all strings outlive this synchronous call; no process handle is
        // requested. NOASYNC ensures the broker accepts launch before we exit.
        unsafe { ShellExecuteExW(info) }
    })
}

fn launch_with(
    program: &Path,
    invoke: impl FnOnce(&mut SHELLEXECUTEINFOW) -> windows::core::Result<()>,
) -> Result<InstallerLaunch, String> {
    let file = HSTRING::from(program.as_os_str());
    let verb = HSTRING::from("runas");
    let parameters = HSTRING::from("/S");
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(parameters.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    match invoke(&mut info) {
        Ok(()) => Ok(InstallerLaunch::Started),
        Err(error) if error.code() == Error::from(ERROR_CANCELLED).code() => {
            Ok(InstallerLaunch::Cancelled)
        }
        Err(error) => Err(format!("could not start {}: {error}", program.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::ERROR_ACCESS_DENIED;

    #[test]
    fn elevated_launch_keeps_unicode_path_separate_from_silent_argument() {
        let path = Path::new(r"C:\用户\Update cache\CommandCabin-Setup-1.0.5.exe");
        let result = launch_with(path, |info| {
            // SAFETY: these pointers are owned by launch_with for this call.
            unsafe {
                assert_eq!(info.lpVerb.to_string().unwrap(), "runas");
                assert_eq!(info.lpFile.to_string().unwrap(), path.to_str().unwrap());
                assert_eq!(info.lpParameters.to_string().unwrap(), "/S");
            }
            assert_ne!(info.fMask & SEE_MASK_NOASYNC, 0);
            Ok(())
        });
        assert_eq!(result.unwrap(), InstallerLaunch::Started);
    }

    #[test]
    fn uac_cancel_is_not_a_failed_or_successful_install() {
        let result = launch_with(Path::new("setup.exe"), |_| Err(ERROR_CANCELLED.into()));
        assert_eq!(result.unwrap(), InstallerLaunch::Cancelled);
    }

    #[test]
    fn launch_errors_and_missing_downloads_are_reported() {
        let result = launch_with(Path::new("setup.exe"), |_| Err(ERROR_ACCESS_DENIED.into()));
        assert!(result.unwrap_err().contains("could not start setup.exe"));
        assert!(launch_installer(Path::new("missing-installer-test.exe")).is_err());
    }
}
