// Exact decimal-dollar arithmetic shared by the journal folds.

/**
 * Sum two decimal dollar strings exactly, at whatever scale they carry — the
 * kernel's budget fold (`relayflowd-core/src/state/budget.rs`) aligns every
 * fractional digit before adding, and it accepts arbitrary precision. Scaling
 * to a fixed six fractional digits dropped a charge of `0.0000001` to zero, so
 * `flows status` underreported spend the kernel had totalled exactly.
 *
 * A value that is not a decimal number is left out of the sum rather than
 * counted as zero, and the caller is told by `malformed`.
 */
export function addDollars(left: string, right: string): string {
  const parsed = [left, right].map((value) => /^\d+(?:\.\d+)?$/.test(value) ? value : null);
  const usable = parsed.filter((value): value is string => value !== null);
  if (usable.length === 0) return '0';
  if (usable.length === 1) return normalizeDollars(usable[0]!);
  const scale = Math.max(...usable.map((value) => (value.split('.')[1] ?? '').length));
  const scaled = usable.map((value) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
  });
  return fromScaled(scaled[0]! + scaled[1]!, scale);
}

/** `12.3400` -> `12.34`, `0.000` -> `0`; the journal's own spelling otherwise. */
function normalizeDollars(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  return fromScaled(BigInt(`${whole}${fraction}`), fraction.length);
}

function fromScaled(total: bigint, scale: number): string {
  if (scale === 0) return String(total);
  const digits = String(total).padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}
