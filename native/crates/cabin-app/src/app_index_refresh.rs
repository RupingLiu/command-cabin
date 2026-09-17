//! Refresh admission for the background app index.
//! TS `apps/desktop/src/main/index.ts` uses `refreshIntervalMs: 30 * 60 * 1000`;
//! `packages/core/src/indexer/appIndexer.ts` shares `refreshInFlight` between callers.
//! Also refresh when the launcher is shown, with a short cooldown for hotkey toggles.

use std::time::{Duration, Instant};

pub const AUTO_REFRESH_INTERVAL: Duration = Duration::from_secs(30 * 60);
const SHOW_REFRESH_COOLDOWN: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct AppIndexRefresh {
    in_flight: bool,
    last_finished: Option<Instant>,
}

impl AppIndexRefresh {
    pub fn try_start(&mut self, now: Instant) -> bool {
        if self.in_flight
            || self
                .last_finished
                .is_some_and(|last| now.duration_since(last) < SHOW_REFRESH_COOLDOWN)
        {
            return false;
        }
        self.in_flight = true;
        true
    }

    pub fn finish(&mut self, now: Instant) {
        self.in_flight = false;
        self.last_finished = Some(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_and_later_shows_can_refresh_without_restarting() {
        let mut refresh = AppIndexRefresh::default();
        let now = Instant::now();
        assert!(refresh.try_start(now));
        refresh.finish(now);
        assert!(!refresh.try_start(now + SHOW_REFRESH_COOLDOWN - Duration::from_millis(1)));
        assert!(refresh.try_start(now + SHOW_REFRESH_COOLDOWN));
        refresh.finish(now + SHOW_REFRESH_COOLDOWN);
        assert!(refresh.try_start(now + AUTO_REFRESH_INTERVAL));
    }

    #[test]
    fn slow_scan_excludes_overlapping_startup_show_and_timer_requests() {
        let mut refresh = AppIndexRefresh::default();
        let now = Instant::now();
        assert!(refresh.try_start(now));
        assert!(!refresh.try_start(now));
        assert!(!refresh.try_start(now + AUTO_REFRESH_INTERVAL));
        refresh.finish(now + AUTO_REFRESH_INTERVAL);
        assert!(!refresh.try_start(now + AUTO_REFRESH_INTERVAL));
        assert!(refresh.try_start(now + AUTO_REFRESH_INTERVAL + SHOW_REFRESH_COOLDOWN));
    }
}
