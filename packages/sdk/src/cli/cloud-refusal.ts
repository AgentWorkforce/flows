// Every way a hosted read can refuse, as a code, a sentence and an exit.
//
// Moved out of `cli/cloud-read.ts` when the live views needed to refuse in
// exactly the same words: `flows status --cloud --watch` that meets a 404 must
// say what `flows status --cloud` says, or a reader would have to learn two
// vocabularies for one failure. A dependency-only module — it imports no other
// Cloud CLI module, so the one-shot and live entry points can both use it with
// no import cycle between them.

import { canonicalize } from '../canonical.js';
import { CloudFlowError, type CloudConnectionOptions } from '../cloud-http.js';
import { redact } from '../redact.js';
import type { CliIo } from '../cli.js';

/** Injected by tests; production takes the ambient clock and environment. */
export interface CloudReadOptions extends CloudConnectionOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/**
 * Every way these verbs can refuse, as a code and a sentence.
 *
 * Each one names the thing to do next. A missing credential names
 * `agent-relay cloud login` because that is the command that fixes it; a 404
 * names `flows runs` because the usual cause is a run id from another
 * workspace, and the list is how you find yours.
 */
export interface Refusal { code: string; message: string; exit: 1 | 2 }

export function refusalFor(error: unknown, subject: string, env: NodeJS.ProcessEnv): Refusal {
  const clean = (message: string): string => redact(message, env);
  if (error instanceof CloudFlowError) {
    if (error.code === 'configuration') {
      switch (error.reason) {
        case 'auth_missing':
          return {
            code: 'cloud_auth_missing', exit: 2,
            message: 'No Cloud credential. Sign in with `agent-relay cloud login`, or set FLOWS_CLOUD_TOKEN to a '
              + 'Cloud API token with workflow:runs:read (and workflow:logs:read for `flows logs`).',
          };
        case 'auth_expired':
          return { code: 'cloud_auth_expired', exit: 2, message: clean(error.message) };
        case 'url_mismatch':
          return { code: 'cloud_url_mismatch', exit: 2, message: clean(error.message) };
        default:
          return { code: 'cloud_configuration', exit: 2, message: clean(error.message) };
      }
    }
    if (error.code === 'http_error') {
      if (error.status === 401) {
        return {
          code: 'cloud_auth_rejected', exit: 2,
          message: 'Cloud rejected the credential (HTTP 401). The token is unknown or revoked; '
            + 'sign in again with `agent-relay cloud login`.',
        };
      }
      if (error.status === 403) {
        return {
          code: 'cloud_forbidden', exit: 2,
          message: `The credential is valid but not allowed to read ${subject} (HTTP 403). `
            + 'A run-scoped sandbox token may only read its own run; a workspace token needs '
            + 'workflow:runs:read, and workflow:logs:read or workflow:invoke:read for logs.',
        };
      }
      if (error.status === 404) {
        return {
          code: 'cloud_run_not_found', exit: 2,
          message: `Cloud has no ${subject} visible to this credential (HTTP 404). `
            + 'It may belong to another workspace; `flows runs` lists the ones this credential can read.',
        };
      }
      return { code: 'cloud_http_error', exit: 1, message: clean(error.message) };
    }
    if (error.code === 'invalid_input') return { code: 'invalid_invocation', exit: 2, message: clean(error.message) };
    if (error.code === 'transient_error' || error.code === 'transport_error') {
      return { code: error.code === 'transient_error' ? 'cloud_unreachable' : 'cloud_transport_failed', exit: 1, message: clean(error.message) };
    }
    return { code: 'cloud_invalid_response', exit: 1, message: clean(error.message) };
  }
  return { code: 'cloud_read_failed', exit: 1, message: clean(error instanceof Error ? error.message : String(error)) };
}

export function fail(refusal: Refusal, json: boolean, io: CliIo): 1 | 2 {
  if (json) io.stdout(canonicalize({ v: 1, ok: false, code: refusal.code, message: refusal.message }));
  else io.stderr(`REFUSED [${refusal.code}] ${refusal.message}`);
  return refusal.exit;
}

/**
 * `flows status --cloud` with no run id.
 *
 * Shared by the one-shot and watched forms so both name the same remedy: a
 * hosted run has no ambient id the way a step inside a local run does.
 */
export const RUN_ID_REQUIRED: Refusal = {
  code: 'run_unknown', exit: 2,
  message: '`flows status --cloud` needs the hosted run id; `flows runs` lists them. '
    + '(Without --cloud the run id defaults to RELAYFLOW_RUN_ID inside a step.)',
};

/**
 * A read that a poll can retry rather than end on.
 *
 * The same set `waitForCloudFlowRun` retries: the failure says the request did
 * not complete, not that the request was wrong. Anything else — a 404, a
 * rejected credential, a response this client cannot trust — ends the command
 * through `refusalFor`, exactly as it ends a one-shot read.
 */
export function isTransientRead(error: unknown): boolean {
  return error instanceof CloudFlowError && (error.code === 'transient_error'
    || (error.code === 'http_error' && [408, 429, 500, 502, 503, 504].includes(error.status ?? 0)));
}
