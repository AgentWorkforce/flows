use crate::entry::Budget;

use super::StateError;

pub(super) fn add_budget(total: &mut Budget, value: &Budget) -> Result<(), StateError> {
    let tokens_in = total
        .tokens_in
        .checked_add(value.tokens_in)
        .ok_or(StateError::BudgetOverflow)?;
    let tokens_out = total
        .tokens_out
        .checked_add(value.tokens_out)
        .ok_or(StateError::BudgetOverflow)?;
    let dollars = add_decimal_strings(&total.dollars, &value.dollars)?;
    *total = Budget {
        tokens_in,
        tokens_out,
        dollars,
    };
    Ok(())
}

/// Align decimal points and add digits directly. Decimal strings have no fixed
/// precision, so floating point and fixed-width scaling would lose cost.
fn add_decimal_strings(left: &str, right: &str) -> Result<String, StateError> {
    fn parts(value: &str) -> Result<(&str, &str), StateError> {
        let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
        if whole.is_empty()
            || !whole.bytes().all(|byte| byte.is_ascii_digit())
            || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(StateError::InvalidDollars(value.to_owned()));
        }
        Ok((whole, fraction))
    }
    let (lw, lf) = parts(left)?;
    let (rw, rf) = parts(right)?;
    let scale = lf.len().max(rf.len());
    let digits = |whole: &str, fraction: &str| {
        whole
            .bytes()
            .chain(fraction.bytes())
            .chain(std::iter::repeat_n(b'0', scale - fraction.len()))
            .collect::<Vec<_>>()
    };
    let left = digits(lw, lf);
    let right = digits(rw, rf);
    let width = left.len().max(right.len());
    let mut sum = Vec::with_capacity(width + 1);
    let mut carry = 0;
    for index in 0..width {
        let a = left
            .len()
            .checked_sub(index + 1)
            .map_or(0, |i| left[i] - b'0');
        let b = right
            .len()
            .checked_sub(index + 1)
            .map_or(0, |i| right[i] - b'0');
        let digit = a + b + carry;
        sum.push(b'0' + digit % 10);
        carry = digit / 10;
    }
    if carry != 0 {
        sum.push(b'0' + carry);
    }
    sum.reverse();
    let mut result = String::from_utf8(sum).expect("decimal digits are ASCII");
    if scale > 0 {
        result.insert(result.len() - scale, '.');
        result = result
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_owned();
    }
    let result = result.trim_start_matches('0');
    Ok(if result.is_empty() {
        "0".into()
    } else if result.starts_with('.') {
        format!("0{result}")
    } else {
        result.into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_costs_exactly_beyond_machine_decimal_precision() {
        assert_eq!(add_decimal_strings("0.002", "0.003").unwrap(), "0.005");
        assert_eq!(add_decimal_strings("000.000", "0").unwrap(), "0");
        assert_eq!(
            add_decimal_strings("999999999999999999999999999999999999999.99", "0.01").unwrap(),
            "1000000000000000000000000000000000000000"
        );
        assert_eq!(
            add_decimal_strings("1", "0.0000000000000000000000000000000000000001").unwrap(),
            "1.0000000000000000000000000000000000000001"
        );
    }

    #[test]
    fn overflow_and_malformed_cost_leave_total_unchanged() {
        let mut total = Budget {
            tokens_in: u64::MAX,
            tokens_out: 1,
            dollars: "0.002".into(),
        };
        let original = total.clone();
        assert!(matches!(
            add_budget(
                &mut total,
                &Budget {
                    tokens_in: 1,
                    ..Budget::default()
                }
            ),
            Err(StateError::BudgetOverflow)
        ));
        assert_eq!(total, original);
        assert!(
            add_budget(
                &mut total,
                &Budget {
                    dollars: "NaN".into(),
                    ..Budget::default()
                }
            )
            .is_err()
        );
        assert_eq!(total, original);
    }
}
