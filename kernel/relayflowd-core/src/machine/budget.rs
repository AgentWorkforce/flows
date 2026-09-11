use crate::{Budget, RunState};
use std::cmp::Ordering;

/// Completion facts charge the envelope; already-running work remains valid.
pub fn exceeded(state: &RunState, now_ms: i64) -> bool {
    let Some(limit) = &state.spec.budget else {
        return false;
    };
    let empty = Budget::default();
    let (spent, wallclock) = if limit.window.is_some() {
        if state.budget_day == Some(now_ms.div_euclid(86_400_000)) {
            (&state.daily_budget, state.daily_wallclock_ms)
        } else {
            (&empty, 0)
        }
    } else {
        (&state.budget, state.wallclock_ms)
    };
    limit.max_tokens_in.is_some_and(|n| spent.tokens_in > n)
        || limit.max_tokens_out.is_some_and(|n| spent.tokens_out > n)
        || limit.max_tokens.is_some_and(|n| {
            u128::from(spent.tokens_in) + u128::from(spent.tokens_out) > u128::from(n)
        })
        || limit.max_wallclock_ms.is_some_and(|n| wallclock > n)
        || limit
            .max_dollars
            .as_deref()
            .is_some_and(|n| crate::memory::decimal_cmp(&spent.dollars, n) == Ordering::Greater)
}
