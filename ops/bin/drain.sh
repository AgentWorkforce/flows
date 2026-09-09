#!/usr/bin/env bash
# Drain check. Fails LOUDLY: every failure path exits non-zero with a reason.
# An empty result must never be reportable as "0 pending".
set -uo pipefail
AUTH=~/.agentworkforce/relay/cloud-auth.json
[ -f "$AUTH" ] || { echo "DRAIN_FAIL: no auth file $AUTH" >&2; exit 3; }
BASE=$(python3 -c "import json;print(json.load(open('$AUTH'))['apiUrl'].rstrip('/'))") || exit 3
TOK=$(python3 -c "import json;print(json.load(open('$AUTH'))['accessToken'])") || exit 3
[ -n "$TOK" ] || { echo "DRAIN_FAIL: empty access_token" >&2; exit 3; }
OUT=${DRAIN_OUT:-$(mktemp)}
# --compressed: the body is JSON workflow source and compresses ~10x.
# --max-time 300: generous; the failure mode we are avoiding is a TRUNCATED
# body, which parses as empty and reads exactly like "nothing pending".
# The endpoint intermittently returns Cloudflare 1101 ("Worker threw exception")
# because the body is ~46MB -- see AgentWorkforce/cloud#3488. Retry a bounded
# number of times so a transient 1101 does not read as a drain failure; do NOT
# loop forever, a persistently failing endpoint is itself the finding.
attempts=${DRAIN_ATTEMPTS:-4}
code=""
for i in $(seq 1 "$attempts"); do
  code=$(curl -sS --compressed --max-time 300 -w '%{http_code}' \
    -H "Authorization: Bearer $TOK" \
    -o "$OUT" "$BASE/api/v1/workflows/runs") || {
      echo "DRAIN_FAIL: curl transport error (exit $?)" >&2; exit 4; }
  bytes=$(wc -c < "$OUT" | tr -d ' ')
  echo "attempt $i: http=$code decompressed_bytes=$bytes"
  [ "$code" = "200" ] && break
  [ "$i" -lt "$attempts" ] && sleep 10
done
[ "$code" = "200" ] || {
  echo "DRAIN_FAIL: http $code after $attempts attempts (cloud#3488)" >&2
  head -c 300 "$OUT" >&2; exit 5; }
python3 - "$OUT" <<'PY'
import json,sys,collections
try:
    d=json.load(open(sys.argv[1]))
except Exception as e:
    print(f"DRAIN_FAIL: body did not parse ({type(e).__name__}: {e})", file=sys.stderr)
    sys.exit(6)
runs=d.get("runs")
if not isinstance(runs,list):
    print("DRAIN_FAIL: no 'runs' array in body", file=sys.stderr); sys.exit(7)
c=collections.Counter(r.get("status") for r in runs)
pending=sum(v for k,v in c.items() if k in ("pending","launching"))
print("total=%d pending=%d" % (len(runs), pending))
print("by status:", dict(c.most_common()))
for r in runs:
    if r.get("status") in ("pending","launching"):
        print("STUCK?", r.get("runId"), r.get("status"),
              "sandboxId=%s" % r.get("sandboxId"),
              "created=%s updated=%s" % (r.get("createdAt"), r.get("updatedAt")))
import datetime
now=datetime.datetime.now(datetime.timezone.utc)
def age(v):
    try: return now - datetime.datetime.fromisoformat((v or "").replace("Z","+00:00"))
    except Exception: return None
rows=[r for r in runs if r.get("status")=="running"]
if rows:
    print("\n-- running (%d) --" % len(rows))
    rows.sort(key=lambda r: r.get("createdAt") or "")
    for r in rows:
        a=age(r.get("createdAt")); u=age(r.get("updatedAt"))
        print("%s age=%s sinceUpdate=%s sandbox=%s" % (
            r.get("runId"),
            str(a).split(".")[0] if a is not None else "?",
            str(u).split(".")[0] if u is not None else "?",
            (r.get("sandboxId") or "NULL")[:24]))
PY
