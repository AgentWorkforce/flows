use std::time::{SystemTime, UNIX_EPOCH};

use relayflowd_core::Clock;

#[derive(Debug, Clone, Copy, Default)]
pub struct WallClock;

impl Clock for WallClock {
    fn now_ms(&self) -> i64 {
        let duration = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch");
        duration.as_millis().min(i64::MAX as u128) as i64
    }
}
