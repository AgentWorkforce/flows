#!/bin/sh
# Stands in for api.github.com. Fixtures come from env: PRPROOF_HEAD (sha),
# PRPROOF_REF (head branch), PRPROOF_DRAFT (true/false). Every call is logged.
url=""; for a in "$@"; do case "$a" in https://api.github.com/*) url="$a";; esac; done
echo "$*" >> "$PRPROOF_LOG"
draft="${PRPROOF_DRAFT:-false}"
case "$url" in
  */pulls/[0-9]*/comments*) printf '[]' ;;
  */pulls/[0-9]*/reviews*) printf '[]' ;;
  */pulls/[0-9]*) printf '{"state":"open","draft":%s,"merged":false,"mergeable":true,"mergeable_state":"clean","user":{"login":"octocat"},"labels":[],"head":{"sha":"%s","ref":"%s"},"base":{"ref":"main"},"html_url":"https://github.com/o/r/pull/7","title":"feature"}' "$draft" "$PRPROOF_HEAD" "$PRPROOF_REF" ;;
  */commits/*/check-runs*) printf '{"check_runs":[{"name":"ci","status":"completed","conclusion":"success"}]}' ;;
  */issues/[0-9]*/comments) printf '{"id":1}' ;;
  *) echo "unexpected $url" >&2; exit 22 ;;
esac
