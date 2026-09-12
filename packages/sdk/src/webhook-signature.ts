import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Per-provider HMAC signature schemes for webhook payload authentication (#304).
 *
 * The receiver only invokes verification when a secret is configured for the
 * provider (via `env[WEBHOOK_SECRET_<PROVIDER>]`). When no secret is set the
 * receiver runs unsigned, matching the initial loopback-only development mode
 * documented in #301. Callers deploying to public ingress MUST set the secret.
 */
export type SignatureScheme = {
  header: string;
  compute(rawBody: Buffer, secret: string): string;
};

const HEX = /^[0-9a-f]+$/i;

const github: SignatureScheme = {
  header: 'x-hub-signature-256',
  compute(rawBody, secret) {
    return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  },
};

const slack: SignatureScheme = {
  header: 'x-slack-signature',
  compute(rawBody, secret) {
    // Slack's v0 scheme is HMAC(SHA256, secret) over `v0:{ts}:{body}`; a
    // deployment that wants Slack signature verification must set the secret
    // to include the timestamp prefix or use provider-specific integration.
    return 'v0=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  },
};

const generic: SignatureScheme = {
  header: 'x-flows-signature-256',
  compute(rawBody, secret) {
    return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  },
};

export const SIGNATURE_SCHEMES: Record<string, SignatureScheme> = {
  github,
  slack,
};

export function schemeFor(provider: string | undefined): SignatureScheme {
  if (provider && Object.hasOwn(SIGNATURE_SCHEMES, provider)) {
    return SIGNATURE_SCHEMES[provider]!;
  }
  return generic;
}

/** Constant-time verification of a hex-encoded signature against the expected. */
export function verifySignature(
  provider: string | undefined,
  rawBody: Buffer,
  headerValue: string | undefined,
  secret: string,
): { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' } {
  const scheme = schemeFor(provider);
  const supplied = headerValue?.trim();
  if (!supplied) return { ok: false, reason: 'missing' };
  const expected = scheme.compute(rawBody, secret);
  if (supplied.length !== expected.length) return { ok: false, reason: 'malformed' };
  const [suppliedHex, expectedHex] = [supplied.replace(/^[^=]+=/, ''), expected.replace(/^[^=]+=/, '')];
  if (!HEX.test(suppliedHex) || suppliedHex.length !== expectedHex.length) {
    return { ok: false, reason: 'malformed' };
  }
  const suppliedBytes = Buffer.from(suppliedHex, 'hex');
  const expectedBytes = Buffer.from(expectedHex, 'hex');
  if (suppliedBytes.length !== expectedBytes.length) return { ok: false, reason: 'malformed' };
  return timingSafeEqual(suppliedBytes, expectedBytes) ? { ok: true } : { ok: false, reason: 'mismatch' };
}
