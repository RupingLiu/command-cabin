//! 登录自启动：直写 HKCU\Software\Microsoft\Windows\CurrentVersion\Run，
//! 替代 Electron app.setLoginItemSettings（对齐 launchAtLogin.ts 语义）。
//! 值数据格式：`"<exe_path>" --command-cabin-login-startup`（exe 路径加引号）。

use std::path::PathBuf;

use cabin_platform::traits::{AutostartManager, PlatformError, LOGIN_STARTUP_ARG};
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegQueryValueExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SAM_FLAGS,
    REG_SZ,
};

const RUN_SUBKEY: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
const VALUE_NAME: &str = "CommandCabin";

pub struct WindowsAutostart {
    exe_path: PathBuf,
    value_name: String,
}

impl WindowsAutostart {
    pub fn new(exe_path: PathBuf) -> Self {
        Self {
            exe_path,
            value_name: VALUE_NAME.into(),
        }
    }

    /// 测试专用：独立值名，绝不触碰真实 CommandCabin 值。
    #[cfg(test)]
    fn for_test(exe_path: PathBuf, value_name: &str) -> Self {
        Self {
            exe_path,
            value_name: value_name.into(),
        }
    }

    /// Run 值数据：`"<exe>" --command-cabin-login-startup`。
    fn value_data(&self) -> String {
        format!("\"{}\" {LOGIN_STARTUP_ARG}", self.exe_path.display())
    }

    fn open_run_key(&self, sam: REG_SAM_FLAGS) -> Result<RunKey, PlatformError> {
        let mut key = HKEY::default();
        // SAFETY: RUN_SUBKEY 为静态 NUL 结尾宽字符串；&mut key 指向有效局部变量。
        unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                RUN_SUBKEY,
                None,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                sam,
                None,
                &mut key,
                None,
            )
        }
        .ok()
        .map_err(autostart_err)?;
        Ok(RunKey(key))
    }

    /// 读取值数据；值不存在返回 Ok(None)。
    fn read_value(&self) -> Result<Option<String>, PlatformError> {
        let key = self.open_run_key(KEY_QUERY_VALUE)?;
        let name = HSTRING::from(self.value_name.as_str());
        let mut size: u32 = 0;
        // SAFETY: key 与 name 有效；lpdata=None 仅查询所需缓冲大小。
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                PCWSTR(name.as_ptr()),
                None,
                None,
                None,
                Some(&mut size),
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        status.ok().map_err(autostart_err)?;
        if size == 0 || !size.is_multiple_of(2) {
            return Err(PlatformError::Autostart(format!(
                "unexpected REG_SZ byte size {size}"
            )));
        }
        let mut buf = vec![0u16; size as usize / 2 + 1];
        let mut data_size = size;
        // SAFETY: buf 容量大于 size 字节；API 最多写入 data_size 字节并回写实际大小。
        unsafe {
            RegQueryValueExW(
                key.0,
                PCWSTR(name.as_ptr()),
                None,
                None,
                Some(buf.as_mut_ptr() as *mut u8),
                Some(&mut data_size),
            )
        }
        .ok()
        .map_err(autostart_err)?;
        let text = String::from_utf16_lossy(&buf[..data_size as usize / 2]);
        Ok(Some(text.trim_end_matches('\0').to_string()))
    }
}

impl AutostartManager for WindowsAutostart {
    fn is_enabled(&self) -> Result<bool, PlatformError> {
        Ok(self.read_value()?.is_some())
    }

    fn set_enabled(&self, enabled: bool) -> Result<(), PlatformError> {
        let key = self.open_run_key(KEY_SET_VALUE)?;
        let name = HSTRING::from(self.value_name.as_str());
        if enabled {
            let bytes: Vec<u8> = self
                .value_data()
                .encode_utf16()
                .chain(std::iter::once(0))
                .flat_map(u16::to_le_bytes)
                .collect();
            // SAFETY: key 与 name 有效；bytes 为 NUL 结尾的 UTF-16 LE REG_SZ 数据。
            unsafe { RegSetValueExW(key.0, PCWSTR(name.as_ptr()), None, REG_SZ, Some(&bytes)) }
                .ok()
                .map_err(autostart_err)
        } else {
            // SAFETY: key 与 name 有效。删除不存在的值视为成功（幂等）。
            let status = unsafe { RegDeleteValueW(key.0, PCWSTR(name.as_ptr())) };
            if status == ERROR_FILE_NOT_FOUND {
                Ok(())
            } else {
                status.ok().map_err(autostart_err)
            }
        }
    }
}

fn autostart_err(e: windows::core::Error) -> PlatformError {
    PlatformError::Autostart(e.to_string())
}

/// RAII 关闭注册表键句柄。
struct RunKey(HKEY);

impl Drop for RunKey {
    fn drop(&mut self) {
        // SAFETY: 句柄由本守卫独占持有，仅关闭一次。
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_VALUE_NAME: &str = "CommandCabinTest";

    fn test_autostart(exe_path: PathBuf) -> WindowsAutostart {
        WindowsAutostart::for_test(exe_path, TEST_VALUE_NAME)
    }

    /// 测试结束（含 panic）务必删除测试值，避免污染真实 Run 键。
    struct Cleanup;

    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = test_autostart(PathBuf::new()).set_enabled(false);
        }
    }

    #[test]
    fn value_data_quotes_exe_path() {
        let autostart = test_autostart(PathBuf::from(r"C:\Apps\Command Cabin\cabin.exe"));
        assert_eq!(
            autostart.value_data(),
            format!("\"C:\\Apps\\Command Cabin\\cabin.exe\" {LOGIN_STARTUP_ARG}")
        );
    }

    #[test]
    fn registry_round_trip() {
        let _cleanup = Cleanup;
        let exe = PathBuf::from(r"C:\Program Files\CommandCabin\CommandCabin.exe");
        let autostart = test_autostart(exe.clone());
        let expected = format!("\"{}\" {LOGIN_STARTUP_ARG}", exe.display());

        // 预清理，保证初始为未启用。
        autostart.set_enabled(false).unwrap();
        assert!(!autostart.is_enabled().unwrap());
        assert_eq!(autostart.read_value().unwrap(), None);

        autostart.set_enabled(true).unwrap();
        assert!(autostart.is_enabled().unwrap());
        assert_eq!(
            autostart.read_value().unwrap().as_deref(),
            Some(expected.as_str())
        );

        // 删除幂等：删除不存在的值不报错。
        autostart.set_enabled(false).unwrap();
        autostart.set_enabled(false).unwrap();
        assert!(!autostart.is_enabled().unwrap());
        assert_eq!(autostart.read_value().unwrap(), None);
    }
}
