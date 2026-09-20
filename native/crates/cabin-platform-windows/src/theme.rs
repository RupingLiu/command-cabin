//! Read the application theme directly, including after a hidden window misses
//! a Windows theme notification. Never modify the user's personalization values.

use cabin_platform::SystemThemeProvider;
use windows::core::w;
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};

pub struct WindowsSystemTheme;

impl SystemThemeProvider for WindowsSystemTheme {
    fn prefers_light_theme(&self) -> Option<bool> {
        let mut value = 0u32;
        let mut size = std::mem::size_of_val(&value) as u32;
        // SAFETY: static NUL-terminated names, predefined HKCU handle, and a
        // writable DWORD buffer whose size is supplied. RegGetValueW opens and
        // closes the subkey itself and rejects values of other registry types.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
                w!("AppsUseLightTheme"),
                RRF_RT_REG_DWORD,
                None,
                Some((&mut value as *mut u32).cast()),
                Some(&mut size),
            )
        };
        status.ok().ok().map(|()| value != 0)
    }
}
