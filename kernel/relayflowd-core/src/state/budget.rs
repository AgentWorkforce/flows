use crate::entry::Budget;

use super::StateError;

pub(super) fn add_budget(total: &mut Budget, value: &Budget) -> Result<(), StateError> {
    total.tokens_in = total.tokens_in.saturating_add(value.tokens_in);
    total.tokens_out = total.tokens_out.saturating_add(value.tokens_out);
    total.dollars = add_decimal_strings(&total.dollars, &value.dollars)?;
    Ok(())
}

fn add_decimal_strings(left: &str, right: &str) -> Result<String, StateError> {
    fn parts(value: &str) -> Result<(u128, usize), StateError> {
        let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
        if whole.is_empty()
            || !whole.bytes().all(|byte| byte.is_ascii_digit())
            || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(StateError::InvalidDollars(value.to_owned()));
        }
        let digits = format!("{whole}{fraction}")
            .parse::<u128>()
            .map_err(|_| StateError::InvalidDollars(value.to_owned()))?;
        Ok((digits, fraction.len()))
    }
    let (left_value, left_scale) = parts(left)?;
    let (right_value, right_scale) = parts(right)?;
    let scale = left_scale.max(right_scale);
    let scaled_left =
        left_value.saturating_mul(10_u128.saturating_pow((scale - left_scale) as u32));
    let scaled_right =
        right_value.saturating_mul(10_u128.saturating_pow((scale - right_scale) as u32));
    let sum = scaled_left.saturating_add(scaled_right);
    if scale == 0 {
        return Ok(sum.to_string());
    }
    let divisor = 10_u128.saturating_pow(scale as u32);
    let fraction = format!("{:0scale$}", sum % divisor, scale = scale);
    Ok(format!("{}.{fraction}", sum / divisor)
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_owned())
}
