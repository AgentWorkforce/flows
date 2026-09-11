//! Step-declared memory substrate. Requests and accepted packs are data; this
//! module neither retrieves memory nor calls a provider.
use crate::{Budget, BudgetSpec};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    Script,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MemorySpec {
    pub scope: MemoryScope,
    pub query: String,
    pub budget: BudgetSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MemoryInjectedPayload {
    pub request: MemorySpec,
    pub pack: Value,
    /// Charged only by memory.injected, never again by a step completion.
    pub budget: Budget,
    pub provider: String,
}

impl MemorySpec {
    pub fn validate(&self) -> Result<(), String> {
        if self.budget.pricing.is_some() || self.budget.prior_spend.is_some()
            || self.budget.max_tokens.is_some() || self.budget.max_wallclock_ms.is_some()
            || self.budget.window.is_some() {
            return Err("memory budgets accept only max_tokens_in, max_tokens_out, max_dollars".into());
        }
        if self.query.trim().is_empty() {
            return Err("query must be a non-empty string".into());
        }
        // Both dialects must transmit the exact integer through JSON/JS.
        const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
        if [self.budget.max_tokens_in, self.budget.max_tokens_out]
            .into_iter()
            .flatten()
            .any(|n| n > MAX_SAFE_INTEGER)
        {
            return Err("budget token limits must be safe non-negative integers".into());
        }
        if self
            .budget
            .max_dollars
            .as_deref()
            .is_some_and(|s| !valid_decimal(s))
        {
            return Err("budget.max_dollars must be a non-negative decimal string".into());
        }
        Ok(())
    }

    pub fn permits(&self, cost: &Budget) -> bool {
        valid_decimal(&cost.dollars)
            && self
                .budget
                .max_tokens_in
                .is_none_or(|limit| cost.tokens_in <= limit)
            && self
                .budget
                .max_tokens_out
                .is_none_or(|limit| cost.tokens_out <= limit)
            && self
                .budget
                .max_dollars
                .as_deref()
                .is_none_or(|limit| decimal_cmp(&cost.dollars, limit) != Ordering::Greater)
    }
}

pub fn valid_decimal(value: &str) -> bool {
    let (whole, fraction) = value
        .split_once('.')
        .map_or((value, None), |(w, f)| (w, Some(f)));
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction.is_none_or(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()))
}

/// Exact decimal comparison without floating point or fixed-width scaling.
pub(crate) fn decimal_cmp(left: &str, right: &str) -> Ordering {
    let parts = |value: &str| {
        let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
        (
            whole.trim_start_matches('0').to_owned(),
            fraction.trim_end_matches('0').to_owned(),
        )
    };
    let (lw, lf) = parts(left);
    let (rw, rf) = parts(right);
    lw.len()
        .cmp(&rw.len())
        .then_with(|| lw.cmp(&rw))
        .then_with(|| {
            let width = lf.len().max(rf.len());
            lf.bytes()
                .chain(std::iter::repeat(b'0'))
                .take(width)
                .cmp(rf.bytes().chain(std::iter::repeat(b'0')).take(width))
        })
}

/// Optional serde fields otherwise accept explicit null, which the SDK rejects.
pub(crate) fn validate_shape(value: &Value) -> Result<(), String> {
    let object = value.as_object().ok_or("memory must be an object")?;
    let budget = object
        .get("budget")
        .and_then(Value::as_object)
        .ok_or("memory.budget must be an object")?;
    if budget.values().any(Value::is_null) {
        return Err("memory budget limits cannot be null".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn caps_compare_exact_decimals_and_each_token_dimension() {
        let request: MemorySpec = serde_json::from_value(json!({"scope":"script","query":"lessons","budget":{"max_tokens_in":7,"max_tokens_out":0,"max_dollars":"0000.00200"}})).unwrap();
        let cost = Budget {
            tokens_in: 7,
            tokens_out: 0,
            dollars: "0.002".into(),
        };
        assert!(request.permits(&cost));
        assert!(!request.permits(&Budget {
            tokens_in: 8,
            ..cost.clone()
        }));
        assert!(!request.permits(&Budget {
            tokens_out: 1,
            ..cost.clone()
        }));
        assert!(!request.permits(&Budget {
            dollars: "0.0020000000000000000000000000000000000001".into(),
            ..cost.clone()
        }));
        for dollars in ["-1", "NaN", "1e-3", "0."] {
            assert!(!request.permits(&Budget {
                dollars: dollars.into(),
                ..cost.clone()
            }));
        }
        assert!(request.permits(&Budget {
            dollars: "0.0019999999999999999999999999999999999999".into(),
            ..cost
        }));
    }
}
