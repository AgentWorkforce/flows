/**
 * Provider refusals that mean "this credential is out of capacity right now",
 * not "this model does not exist". Shared by raw provider adapters because the
 * wording overlaps (HTTP 429, `rate_limit_error`, subscription usage windows).
 */
const USAGE_LIMITED = [
  /usage limit/i,
  /hit your (?:usage )?limit/i,
  /(?:5-hour|weekly|session) limit reached/i,
  /rate_limit_error/,
  /API Error: 429\b/,
  /credit balance is too low/i,
];

export function providerUsageLimited(output: string): boolean {
  return USAGE_LIMITED.some(pattern => pattern.test(output));
}
