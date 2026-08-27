use sha2::{Digest, Sha256};

use crate::spec::RetryPolicy;

/// Deterministic exponential backoff with symmetric bounded jitter.
///
/// `completed_attempt` is one-based. The stable idempotency key makes the
/// same attempt choose the same wake-up delay after every resume.
pub fn backoff_delay_ms(
    policy: &RetryPolicy,
    idempotency_key: &str,
    completed_attempt: u32,
) -> u64 {
    let exponent = completed_attempt.saturating_sub(1);
    let base = policy
        .initial_backoff_ms
        .saturating_mul((policy.multiplier as u64).saturating_pow(exponent))
        .min(policy.max_backoff_ms);
    let jitter_range = base.saturating_mul(policy.jitter_percent as u64) / 100;
    if jitter_range == 0 {
        return base;
    }

    let mut hasher = Sha256::new();
    hasher.update(idempotency_key.as_bytes());
    hasher.update(completed_attempt.to_be_bytes());
    let digest = hasher.finalize();
    let sample = u64::from_be_bytes(digest[..8].try_into().expect("eight hash bytes"));
    let width = jitter_range.saturating_mul(2).saturating_add(1);
    let offset = (sample % width) as i128 - jitter_range as i128;
    (base as i128 + offset).max(0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jitter_is_repeatable_and_bounded() {
        let policy = RetryPolicy {
            initial_backoff_ms: 1_000,
            max_backoff_ms: 5_000,
            multiplier: 2,
            jitter_percent: 20,
        };
        let first = backoff_delay_ms(&policy, "stable", 3);
        assert_eq!(first, backoff_delay_ms(&policy, "stable", 3));
        assert!((3_200..=4_800).contains(&first));
        let capped = backoff_delay_ms(&policy, "stable", 8);
        assert!((4_000..=6_000).contains(&capped));
    }
}
