Launch shakedown against #269 `f3dc7ce` found a real endpoint mismatch, independent of the stale-cookie browser issue. Please handle on the existing observer branch; this shakedown is not editing that PR.

1. `RELAYCAST_WORKSPACE_KEY=rk_live_test flows run observer.flow.yaml` succeeds as a flow but emits `[observer] token mint failed: mint API returned HTTP 404; skipping observer link`. Default `https://agentrelay.com/v1/observer-tokens` is the dashboard origin, not the canonical API.
2. The active workspace reports `relaycastUrl: https://cast.agentrelay.com`. Setting `RELAYCAST_API_URL` to that URL makes the dummy key fail with the expected HTTP401.
3. With the existing real canonical workspace key (never logged), minting succeeds, but the CLI prints `Observer: https://cast.agentrelay.com/observer?key=ot_live_REDACTED`.
4. Actually loading that printed URL with `curl -L` returns **HTTP404**, body `{"ok":false,"error":{"code":"not_found","message":"Route not found"}}`.

The code derives both `/v1/observer-tokens` and `/observer` from the same base. The API and dashboard are different origins in the canonical deployment. Acceptance: separate the API mint origin from the human dashboard origin, and load a freshly printed real-key URL before declaring the link delivered. Dummy-key failure must remain best-effort and leave a successful local run at exit0.

At this tested head, `flows observer` itself is still absent (`REFUSED [invalid_invocation]`, exit2); I will retest if the follow-up lands. A first real-key mint attempt also hit HTTP429, so the final successful mint was done after backing off.

Follow-up at `0a0bca4`: rebuilt and exercised new `flows observer` and the actual existing cloud-login store. With no env key, the default mint still404s; canonical API override mints successfully, and the printed URL still loads404. Suppressed and absent-store refusals are actionable. `npx tsc --noEmit` passes. `npx vitest run tests/observer-link.test.ts` is **34 passed / 4 failed** when composed with #268: `startCliLoopback` still binds `join(dataDir, 'relayflowd.sock')` at line74, so the CLI connects to a freshly spawned real daemon on its hashed path instead of the test loopback; expected sentinel run IDs are replaced by real ULIDs. Please reconcile test socket setup with #268 on your branch.
