use std::cell::Cell;

/// Time source supplied to kernel decisions.
pub trait Clock {
    fn now_ms(&self) -> i64;
}

/// Deterministic clock for state-machine tests and simulations.
#[derive(Debug)]
pub struct SimClock {
    now_ms: Cell<i64>,
}

impl SimClock {
    pub fn new(now_ms: i64) -> Self {
        Self {
            now_ms: Cell::new(now_ms),
        }
    }

    pub fn set(&self, now_ms: i64) {
        self.now_ms.set(now_ms);
    }

    pub fn advance(&self, duration_ms: i64) {
        assert!(duration_ms >= 0, "simulated time cannot move backwards");
        self.now_ms.set(self.now_ms.get() + duration_ms);
    }
}

impl Clock for SimClock {
    fn now_ms(&self) -> i64 {
        self.now_ms.get()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simulated_clock_is_explicitly_advanced() {
        let clock = SimClock::new(10);
        clock.advance(25);
        assert_eq!(clock.now_ms(), 35);
        clock.set(4);
        assert_eq!(clock.now_ms(), 4);
    }
}
