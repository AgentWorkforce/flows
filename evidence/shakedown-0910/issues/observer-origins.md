## Summary

**High launch severity; #269 remains with its existing owner.** The default API base is the dashboard origin (`https://agentrelay.com`), so minting returns 404. Overriding to the canonical API (`https://cast.agentrelay.com`) allows minting, but the generated dashboard URL uses that API origin too and also returns 404 when loaded.

Confirmed both on initial #269 `f3dc7ce` and its on-demand/cloud-login follow-up `0a0bca4`, composed with main `a42ca16` and #268 `33c460a`.

## Repro

```sh
RELAYCAST_WORKSPACE_KEY=rk_live_test flows observer
```

```
EXIT: 2
REFUSED [observer_link_unavailable] mint API returned HTTP 404
```

The canonical API reported by `agent-relay workspace active --json` is `https://cast.agentrelay.com`. A dummy key there gives HTTP401 as expected. With an existing real cloud-login workspace key and **no** RELAYCAST_WORKSPACE_KEY env var:

```sh
RELAYCAST_API_URL=https://cast.agentrelay.com flows observer
```

```
EXIT: 0
https://cast.agentrelay.com/observer?key=ot_live_REDACTED
```

Actually loading the printed URL:

```text
curl --max-time 15 -sS -L '<printed URL>'
HTTP: 404
{"ok":false,"error":{"code":"not_found","message":"Route not found"}}
```

`flows run` also prints an unusable URL; a mint failure itself correctly leaves a successful deterministic run at exit0. Live credential material is intentionally redacted.

## Expected

Default cloud-login or explicit-key observer commands mint against the canonical API and emit a dashboard URL that actually loads.

## Suggested direction

Separate the mint API base and dashboard URL. Default the API to the canonical Relaycast service and the dashboard to its UI origin; respect deployment overrides independently. Do not conflate this with the separate stale-cookie fix.

## Acceptance criteria

- Dummy key against the default mint endpoint yields an auth failure, not 404.
- A real existing workspace key mints a URL through both `flows run` and `flows observer`.
- Load the printed URL with a browser or curl and capture a non-404 dashboard response.
- Cloud-login fallback works without exposing the admin key in URLs/logs.
- Observer failures remain nonfatal to otherwise successful runs.
