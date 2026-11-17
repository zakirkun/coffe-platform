//! Reconnect delays: exponential backoff with full jitter (§8.6).

use std::time::Duration;

pub const RECONNECT_BASE: Duration = Duration::from_secs(1);
pub const RECONNECT_CAP: Duration = Duration::from_secs(30);
/// A connection that stayed up this long resets the backoff.
pub const STABLE_AFTER: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct Backoff {
    base: Duration,
    cap: Duration,
    attempt: u32,
}

impl Backoff {
    pub fn new(base: Duration, cap: Duration) -> Self {
        Self { base, cap, attempt: 0 }
    }

    /// Upper bound of the next delay: `min(cap, base * 2^attempt)`.
    pub fn ceiling(&self) -> Duration {
        let factor = 1u32.checked_shl(self.attempt).unwrap_or(u32::MAX);
        self.base.checked_mul(factor).map_or(self.cap, |delay| delay.min(self.cap))
    }

    /// Next delay for a given random sample; uniform in `[0, ceiling]`.
    pub fn next_delay_with(&mut self, sample: u64) -> Duration {
        let ceiling = self.ceiling();
        self.attempt = self.attempt.saturating_add(1);
        ceiling.mul_f64(sample as f64 / u64::MAX as f64)
    }

    pub fn next_delay(&mut self) -> Duration {
        // A failing OS RNG only costs the jitter: fall back to the full ceiling.
        self.next_delay_with(getrandom::u64().unwrap_or(u64::MAX))
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new(RECONNECT_BASE, RECONNECT_CAP)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ceiling_doubles_from_base_and_saturates_at_cap() {
        let mut backoff = Backoff::default();
        let mut ceilings = Vec::new();
        for _ in 0..8 {
            ceilings.push(backoff.ceiling().as_secs());
            backoff.next_delay_with(0);
        }
        assert_eq!(ceilings, [1, 2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn delays_stay_within_the_jitter_window() {
        let mut backoff = Backoff::default();
        assert_eq!(backoff.next_delay_with(0), Duration::ZERO);
        assert_eq!(backoff.next_delay_with(u64::MAX), Duration::from_secs(2));
        let half = backoff.next_delay_with(u64::MAX / 2);
        assert!(half > Duration::from_millis(1900) && half < Duration::from_millis(2100), "{half:?}");
        for _ in 0..200 {
            let ceiling = backoff.ceiling();
            assert!(backoff.next_delay() <= ceiling);
            assert!(ceiling <= RECONNECT_CAP);
        }
    }

    #[test]
    fn reset_returns_to_the_base_delay() {
        let mut backoff = Backoff::default();
        for _ in 0..40 {
            backoff.next_delay_with(u64::MAX);
        }
        assert_eq!(backoff.ceiling(), RECONNECT_CAP);
        backoff.reset();
        assert_eq!(backoff.ceiling(), RECONNECT_BASE);
    }
}
