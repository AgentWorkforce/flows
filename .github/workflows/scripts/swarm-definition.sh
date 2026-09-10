#!/usr/bin/env bash
set -euo pipefail

candidate=${1:?usage: swarm-definition.sh CANDIDATE TRUSTED}
trusted=${2:?usage: swarm-definition.sh CANDIDATE TRUSTED}

test -s "$candidate" || { echo "candidate workflow is missing: $candidate" >&2; exit 1; }
test -s "$trusted" || { echo "trusted workflow is missing: $trusted" >&2; exit 1; }

# The candidate is parsed for structural and policy invariants only. It is never
# used as the authority for the review result: the caller must still launch the
# trusted definition from the base commit. Ruby's stdlib YAML parser is present
# on the GitHub runner, so this check adds no floating dependency.
ruby -ryaml - "$candidate" "$trusted" <<'RUBY'
candidate_path, trusted_path = ARGV

def load_workflow(path, label)
  abort "#{label} must not be a symbolic link" if File.lstat(path).symlink?
  value = YAML.safe_load(File.read(path), aliases: false)
  abort "#{label} is not a YAML mapping" unless value.is_a?(Hash)
  value
rescue Psych::Exception => error
  abort "#{label} is invalid YAML: #{error.message.lines.first.strip}"
end

candidate = load_workflow(candidate_path, "candidate workflow")
trusted = load_workflow(trusted_path, "trusted workflow")

swarm = candidate.fetch("swarm")
abort "candidate swarm must be a mapping" unless swarm.is_a?(Hash)
error_handling = candidate.fetch("errorHandling")
abort "candidate errorHandling must be a mapping" unless error_handling.is_a?(Hash)

strategy = error_handling.fetch("strategy")
abort "candidate errorHandling.strategy must be retry (got #{strategy.inspect})" unless strategy == "retry"

delay = error_handling.fetch("retryDelayMs")
abort "candidate retryDelayMs must be a positive integer" unless delay.is_a?(Integer) && delay.positive?
abort "candidate retryDelayMs must honor the platform's 60s backoff (got #{delay})" unless delay >= 60_000

trusted_timeout = trusted.fetch("swarm").fetch("timeoutMs")
candidate_timeout = swarm.fetch("timeoutMs")
abort "candidate timeoutMs must remain #{trusted_timeout} (got #{candidate_timeout.inspect})" unless candidate_timeout == trusted_timeout

puts "CANDIDATE_DEFINITION_OK"
puts "retry strategy=#{strategy} retryDelayMs=#{delay} timeoutMs=#{candidate_timeout}"
RUBY
