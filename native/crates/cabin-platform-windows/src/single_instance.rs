//! 单实例守卫：命名 mutex。已存在同名 mutex 时本进程为非主实例，应立即退出；
//! 守卫析构时关闭句柄释放锁。

use cabin_platform::traits::{PlatformError, SingleInstance};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
use windows::Win32::System::Threading::CreateMutexW;

pub struct WindowsSingleInstance {
    handle: Option<HANDLE>,
    primary: bool,
}

// SAFETY: HANDLE 是 *mut c_void 而未实现 Send。本结构独占该句柄，
// 仅在 Drop 中关闭一次，且不提供跨线程共享句柄的 API，因此 Send 是安全的。
unsafe impl Send for WindowsSingleInstance {}

impl WindowsSingleInstance {
    pub fn acquire(mutex_name: &str) -> Result<Self, PlatformError> {
        let wide: Vec<u16> = mutex_name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: 传入以 NUL 结尾的宽字符；CreateMutexW 失败时返回 NULL。
        let handle = unsafe { CreateMutexW(None, true, PCWSTR(wide.as_ptr())) }
            .map_err(|e| PlatformError::SingleInstance(e.to_string()))?;
        if handle.is_invalid() {
            return Err(PlatformError::SingleInstance(
                "CreateMutexW returned null".into(),
            ));
        }
        // SAFETY: handle 有效；GetLastError 读取当前线程错误码。
        // 注意必须在成功路径上不插入任何其他 Win32 调用，避免覆盖 last-error。
        let already_exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        Ok(Self {
            handle: Some(handle),
            primary: !already_exists,
        })
    }
}

impl SingleInstance for WindowsSingleInstance {
    fn is_primary(&self) -> bool {
        self.primary
    }
}

impl Drop for WindowsSingleInstance {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            // SAFETY: handle 由本结构持有且仅关闭一次。
            unsafe {
                let _ = CloseHandle(handle);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_acquisition_is_not_primary() {
        let first = WindowsSingleInstance::acquire("CommandCabin-Test-Mutex-1").unwrap();
        assert!(first.is_primary());
        let second = WindowsSingleInstance::acquire("CommandCabin-Test-Mutex-1").unwrap();
        assert!(!second.is_primary());
        drop(first);
    }
}
