//! Pure head/tail retention for command output. The budget bounds retention,
//! not reading: exec_det's read_all still reads the entire stream unbounded.
//! Deliberately no failure markers: knowing that `not ok` means a failing test
//! is test-runner vocabulary, i.e. product logic, which stays outside kernel/.
//! Selecting interesting lines belongs to the SDK renderer.

pub(crate) fn capture(bytes: &[u8], budget: usize) -> String {
    // Internal callers use 16/64 KiB; leave room to state the cut honestly.
    assert!(budget >= 128, "capture budget must leave room for its marker");
    let source = String::from_utf8_lossy(bytes);
    if source.len() <= budget {
        return source.into_owned();
    }
    let mut head = budget / 4;
    while !source.is_char_boundary(head) {
        head -= 1;
    }
    let marker = |omitted| format!("\n… relayflow: {omitted} bytes elided at capture …\n");
    // Reserving the widest possible count prevents the marker growing past
    // the budget. Lossy decoding precedes cuts so invalid input cannot expand
    // an otherwise bounded result; valid UTF-8 retains exact byte accounting.
    let tail_bytes = budget - head - marker(source.len()).len();
    let mut tail = source.len() - tail_bytes;
    while !source.is_char_boundary(tail) {
        tail += 1;
    }
    format!("{}{}{}", &source[..head], marker(tail - head), &source[tail..])
}

#[cfg(test)]
mod tests {
    use super::capture;

    #[test]
    fn short_and_exact_budget_are_unchanged() {
        for text in ["", "hello\n", "{\"ok\":true}", &"x".repeat(65536)] {
            assert_eq!(capture(text.as_bytes(), 65536), text);
        }
    }

    #[test]
    fn one_byte_over_accounts_for_marker_space_too() {
        let text = "x".repeat(65537);
        let result = capture(text.as_bytes(), 65536);
        let count: usize = result.split("relayflow: ").nth(1).unwrap()
            .split_whitespace().next().unwrap().parse().unwrap();
        assert_eq!(result.bytes().filter(|b| *b == b'x').count() + count, text.len());
        assert!(count > 1); // The in-band marker itself also needs space.
        assert!(result.len() <= 65536);
    }

    #[test]
    fn keeps_early_tap_failure_and_final_summary() {
        let text = format!("TAP version 13\nnot ok 3 - child reaped twice\n{}# fail 1\n", "ok - passing\n".repeat(10000));
        let result = capture(text.as_bytes(), 65536);
        assert!(result.contains("not ok 3 - child reaped twice"));
        assert!(result.ends_with("# fail 1\n"));
        assert!(result.contains("bytes elided at capture"));
    }

    #[test]
    fn cuts_never_split_utf8_and_all_budgets_hold() {
        let text = "a🦀é中\n".repeat(10000);
        for budget in 128..2048 {
            let result = capture(text.as_bytes(), budget);
            assert!(!result.contains('\u{fffd}'));
            assert!(result.len() <= budget);
        }
    }

    #[test]
    fn invalid_input_still_respects_the_byte_budget() {
        let result = capture(&[0xff; 65536], 65536);
        assert!(result.len() <= 65536);
        assert!(result.contains("bytes elided at capture"));
    }
}
