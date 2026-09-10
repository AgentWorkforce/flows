## Summary

**High launch friction.** When a deterministic command exits nonzero, `flows run` reports only the run-level `step_failed`. The user's stderr and the actual exit code are absent, and the message gives no inspection command. A first-time author must reach into the journal to learn why a command failed.

## Repro

```yaml
version: "0.1.0"
name: runtime-error
steps:
  - id: fail-command
    type: deterministic
    command: 'printf "shakedown intentional failure" >&2; exit 7'
```

Run with a fresh data directory:

```sh
flows run runtime-error.flow.yaml --data-dir /tmp/runtime-error-fresh
```

Captured output (main `a42ca16` + #268/#269):

```text
EXIT: 1
STDOUT:
RUN 01M25VBQ8W3TCRWTM15KYAM7AA failed (1 steps) completionReason: step_failed

STDERR:
WARNING [unprovable_effects] Step "fail-command" command "printf" resolves, but its effects cannot be proven before execution.
FAILED [step_failed] Run "01M25VBQ8W3TCRWTM15KYAM7AA" failed with completionReason: step_failed.
```

Neither `exit 7` nor `shakedown intentional failure` appears. The warning happens to name the step here, but it is unrelated to the failure and cannot substitute for a failed-step diagnostic.

## Expected

The refusal/failure output names the failed step and exit code, includes an appropriately bounded stderr tail, and gives an executable inspection command when additional context is available. Preserve the typed run completion reason.

## Suggested direction

Read the journaled failed attempt result at the CLI reporting boundary and render the already captured result, applying the project's output bounds and credential-redaction conventions. Do not re-run the command to diagnose it.

## Acceptance criteria

- The repro identifies `fail-command`, exit code 7, and its captured stderr.
- Successful summaries remain concise.
- `--json` exposes the same useful failure context in structured form.
- Long stderr is bounded, with clear truncation and an inspection path.
