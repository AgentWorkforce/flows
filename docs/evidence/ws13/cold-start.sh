#!/usr/bin/env bash
set -eu
# Candidate registry argument supplies this unpublished branch's packed npm artifacts.
export npm_config_registry="${1:?Usage: cold-start.sh CANDIDATE_REGISTRY_URL}"
export npm_config_cache=/tmp/ws13-empty-cache
export npm_config_audit=false
export npm_config_fund=false
node --version
npx --yes create-flow@latest /tmp/hello --template deterministic
cd /tmp/hello
npx --no-install flows run hello.flow.ts --input '{}'
