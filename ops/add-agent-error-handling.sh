#!/bin/sh
# Add workspace admission retry handling to all agent steps in workflow files.
# This fixes the workspace_busy rate-limit failures seen in assess-1 and other
# agent steps when mcp-args --register fails.
#
# Context: Same fix as applied to review-swarm.yaml. The default retry strategy
# has retryDelayMs:1000 but workspace rate-limits request 60s backoff, so retries
# are exhausted before the requested backoff period even begins.

set -eu

# Apply to all version 1.0 workflow files that have agent steps
for workflow in workflows/bootstrap-gate1.yaml workflows/daemon-lifecycle.yaml workflows/watchdog.yaml; do
  if [ ! -f "$workflow" ]; then
    echo "Skip $workflow (not found)"
    continue
  fi

  echo "Processing $workflow..."

  # Use Python to parse and modify YAML properly
  python3 - "$workflow" <<'PYTHON'
import sys
import yaml

workflow_file = sys.argv[1]

with open(workflow_file, 'r') as f:
    data = yaml.safe_load(f)

# Find all agent steps and add errorHandling if not present
modified = False
if 'workflows' in data:
    for workflow in data['workflows']:
        if 'steps' in workflow:
            for step in workflow['steps']:
                if step.get('type') == 'agent' and 'errorHandling' not in step:
                    step['errorHandling'] = {
                        'strategy': 'retry',
                        'retryDelayMs': 60000
                    }
                    modified = True
                    print(f"  Added errorHandling to step: {step.get('name', 'unnamed')}")

if modified:
    with open(workflow_file, 'w') as f:
        yaml.dump(data, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
    print(f"✓ Updated {workflow_file}")
else:
    print(f"  No changes needed for {workflow_file}")
PYTHON
done

echo ""
echo "Regenerating drive-cloud.yaml from updated drive.yaml..."
python3 ops/gen-drive-cloud.py

echo ""
echo "✓ All workflow files updated with workspace admission retry handling"
