#!/usr/bin/env bash
set -euo pipefail

# Parse the workflow as YAML and pin the cross-checkout contracts that shell
# tests cannot see: the immutable base ref, sparse helper checkout, and the
# wait step's cwd. Run this from a checkout containing the candidate workflow.
workflow=${1:-.github/workflows/review-swarm.yml}
guard_workflow=${2:-.github/workflows/review-swarm-wrapper-guard.yml}
test -s "$workflow" || { echo "missing workflow: $workflow" >&2; exit 1; }
test -s "$guard_workflow" || { echo "missing workflow: $guard_workflow" >&2; exit 1; }

ruby -ryaml - "$workflow" "$guard_workflow" <<'RUBY'
workflow_path, guard_path = ARGV
load_yaml = lambda do |path|
  value = YAML.safe_load(File.read(path), aliases: false)
  abort "#{path} must be a YAML mapping" unless value.is_a?(Hash)
  value
rescue Psych::Exception => error
  abort "#{path} is invalid YAML: #{error.message.lines.first.strip}"
end

workflow = load_yaml.call(workflow_path)
review = workflow.fetch("jobs").fetch("review")
steps = review.fetch("steps")
step = ->(name) { steps.find { |candidate| candidate["name"] == name } || abort("missing step: #{name}") }

gate_checkout = step.call("Check out immutable gate from main").fetch("with")
abort "gate must pin the PR base SHA" unless gate_checkout.fetch("ref").include?("pull_request.base.sha")
sparse = gate_checkout.fetch("sparse-checkout")
abort "gate checkout must include the diagnostic helper" unless sparse.include?(".github/workflows/scripts/swarm-status-diagnostic.sh")

self_test_index = steps.index { |candidate| candidate["name"] == "Self-test the gate's verdict logic" }
wait_index = steps.index { |candidate| candidate["name"] == "Wait for cloud swarm" }
abort "self-test must precede wait" unless self_test_index && wait_index && self_test_index < wait_index
self_test = steps[self_test_index].fetch("run")
abort "self-test must verify the diagnostic helper" unless self_test.include?("swarm-status-diagnostic.sh")
wait = steps[wait_index]
abort "wait must run from pr-head for ../gate-files" unless wait.fetch("working-directory") == "pr-head"
abort "wait must call the diagnostic helper" unless wait.fetch("run").include?("swarm-status-diagnostic.sh")

guard = load_yaml.call(guard_path)
guard_job = guard.fetch("jobs").fetch("guard")
guard_steps = guard_job.fetch("steps")
guard_steps.find { |candidate| candidate["id"] == "wrapper_guard" } || abort("missing wrapper_guard step id")
triggers = guard.fetch("on", guard[true])
abort "wrapper guard trigger must be a mapping" unless triggers.is_a?(Hash)
abort "wrapper guard must use pull_request_target" unless triggers.key?("pull_request_target")
abort "pull_request_target trigger must be a mapping" unless triggers.fetch("pull_request_target").is_a?(Hash)
guard_checkout = guard_steps.first.fetch("with")
abort "wrapper guard must pin checkout to base" unless guard_checkout.fetch("ref").include?("pull_request.base.sha")
abort "pull_request_target checkout must not persist candidate credentials" unless guard_checkout.fetch("persist-credentials") == false
abort "wrapper guard must explain intentional rejection" unless guard_steps.any? { |candidate| candidate["name"] == "Explain wrapper guard rejection" }

puts "review-swarm workflow contracts: all passed"
RUBY
