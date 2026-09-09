#!/usr/bin/env bash
set -eu
export npm_config_registry="${1:?Usage: cold-clone.sh CANDIDATE_REGISTRY_URL}"
export npm_config_cache=/tmp/ws13-empty-cache
export npm_config_audit=false
export npm_config_fund=false
node --version
git clone --depth 1 https://github.com/AgentWorkforce/flows.git /tmp/flows
cd /tmp/flows
npx --yes create-flow@latest /tmp/hello --template deterministic
cd /tmp/hello
export PATH="/tmp/hello/node_modules/.bin:$PATH"
flows run hello.flow.ts --input '{}'
