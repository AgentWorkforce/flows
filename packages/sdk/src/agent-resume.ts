/**
 * Resuming an agent step's CLI session.
 *
 * `resume` names a session the declared CLI recorded on an earlier step —
 * read back as `AgentResult.sessionId` — so this step continues that
 * conversation instead of starting cold. The CLI stores the session (Claude
 * under `~/.claude`, Codex under `~/.codex`); resuming only works where that
 * store survives, such as a sandbox reused for the same pull request.
 *
 * The declaration is lexical and identical in both dialects: the kernel's
 * `relayflowd_core::spec` applies the same rule, and
 * `testdata/agent-resume-cases.json` is the corpus both are tested against.
 * An id must start with a letter or digit, so it can never be read as a CLI
 * flag, and stays within the characters session and thread ids use.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** Why a declared `resume` is not a session id, or `undefined` when it is one. */
export function agentResumeDeclarationError(resume: unknown): string | undefined {
  const expected = 'expected a CLI session id';
  if (typeof resume !== 'string') return `${expected} (got ${resume === null ? 'null' : typeof resume})`;
  if (!SESSION_ID.test(resume)) {
    return `${expected}: 1-200 of A-Z a-z 0-9 . _ : -, starting with a letter or digit`;
  }
  return undefined;
}

/**
 * A relay-dispatched agent runs on another host, whose CLI session store this
 * worker cannot see; resuming there would silently start a fresh session.
 */
export function agentResumeTransportError(resume: unknown, transport: unknown): string | undefined {
  if (resume === undefined || transport !== 'relay') return undefined;
  return 'resume is not supported with transport "relay": the agent runs on another host, '
    + "whose CLI session store this worker cannot see";
}
