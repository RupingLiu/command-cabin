//! The mutex elects the primary instance. An auto-reset event lets a subsequent
//! manual launch request its window, including while the primary is starting.

use cabin_platform::traits::{PlatformError, SingleInstance};
use windows::core::{Owned, HSTRING};
use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS, HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{
    CreateEventW, CreateMutexW, SetEvent, WaitForSingleObject,
};

pub struct WindowsSingleInstance {
    _mutex: Owned<HANDLE>,
    show_event: Owned<HANDLE>,
    primary: bool,
}

// SAFETY: the owned kernel handles may be moved between threads and are closed once.
unsafe impl Send for WindowsSingleInstance {}

impl WindowsSingleInstance {
    pub fn acquire(mutex_name: &str) -> Result<Self, PlatformError> {
        let event_name = HSTRING::from(format!("{mutex_name}-Show"));
        let mutex_name = HSTRING::from(mutex_name);
        // Open the event first so a request cannot be lost during primary initialization.
        // SAFETY: both calls return owned handles and the names live across each call.
        let show_event = unsafe {
            Owned::new(
                CreateEventW(None, false, false, &event_name)
                    .map_err(|e| PlatformError::SingleInstance(e.to_string()))?,
            )
        };
        let mutex = unsafe { CreateMutexW(None, false, &mutex_name) }
            .map_err(|e| PlatformError::SingleInstance(e.to_string()))?;
        // Read before making another Win32 call.
        let already_exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        Ok(Self {
            _mutex: unsafe { Owned::new(mutex) },
            show_event,
            primary: !already_exists,
        })
    }
}

impl SingleInstance for WindowsSingleInstance {
    fn is_primary(&self) -> bool {
        self.primary
    }

    fn request_show(&self) -> Result<(), PlatformError> {
        // SAFETY: this instance holds the event open for the duration of the call.
        unsafe { SetEvent(*self.show_event) }
            .map_err(|e| PlatformError::SingleInstance(e.to_string()))
    }

    fn take_show_request(&self) -> bool {
        // SAFETY: zero timeout polls the live auto-reset event without blocking the UI thread.
        unsafe { WaitForSingleObject(*self.show_event, 0) == WAIT_OBJECT_0 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secondary_can_wake_primary_once_even_before_its_event_loop_starts() {
        // TS singleInstance.ts: app.on('second-instance', ... showExistingWindow()).
        let first = WindowsSingleInstance::acquire("CommandCabin-Test-Mutex-1").unwrap();
        assert!(first.is_primary());
        let second = WindowsSingleInstance::acquire("CommandCabin-Test-Mutex-1").unwrap();
        assert!(!second.is_primary());
        assert!(!first.take_show_request());
        second.request_show().unwrap();
        drop(second);
        assert!(first.take_show_request());
        assert!(!first.take_show_request());
    }
}
