/**
 * In-process token-bucket rate limiter for the local webhook receiver (#304).
 *
 * Slice E's receiver binds loopback and is documented as development-only, so
 * a single-process in-memory bucket is sufficient. Cluster deployments must
 * layer a shared store in a follow-up slice; the taxonomy stays the same
 * (`webhook_rate_limited`) so client behavior does not change.
 */
export interface RateLimitConfig {
  /** Tokens replenished per second. */
  readonly ratePerSecond: number;
  /** Maximum burst capacity. */
  readonly burst: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  refilledAtMs: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly config: RateLimitConfig,
    private readonly clock: () => number = Date.now,
  ) {
    if (config.burst <= 0 || config.ratePerSecond < 0) {
      throw new Error('rate limiter: burst > 0 and ratePerSecond >= 0 required');
    }
  }

  consume(key: string, cost = 1): RateLimitDecision {
    const now = this.clock();
    const bucket = this.buckets.get(key) ?? { tokens: this.config.burst, refilledAtMs: now };
    const elapsedSeconds = Math.max(0, (now - bucket.refilledAtMs) / 1000);
    bucket.tokens = Math.min(this.config.burst, bucket.tokens + elapsedSeconds * this.config.ratePerSecond);
    bucket.refilledAtMs = now;
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      this.buckets.set(key, bucket);
      return { allowed: true, retryAfterMs: 0 };
    }
    this.buckets.set(key, bucket);
    const missingTokens = cost - bucket.tokens;
    const retryAfterMs = this.config.ratePerSecond > 0
      ? Math.ceil((missingTokens / this.config.ratePerSecond) * 1000)
      : Number.POSITIVE_INFINITY;
    return { allowed: false, retryAfterMs };
  }

  /** Test/inspection helper — production code should only call {@link consume}. */
  size(): number {
    return this.buckets.size;
  }
}

export function keyFor(
  provider: string | undefined,
  name: string,
  sourceAddress: string,
): string {
  return `${provider ?? 'raw'}:${name}:${sourceAddress}`;
}
