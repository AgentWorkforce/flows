// digest — reduce the last N runs of one flow to a per-step leverage ranking.
//
// Pure: no I/O, no clock. The input is the `CloudStep[]` shape that
// `getCloudRunSteps` returns (packages/sdk/src/cloud-read.ts), one array per
// run; the output is what the analyst agent reads first. The ranking is a
// starting point, not a verdict — the agent sees every number behind it and
// may pick a different step if the evidence says so.

/** Runs that ended on their own. A cancelled run says nothing about the flow. */
export const TERMINAL_RUN_STATUSES = new Set(["completed", "failed"]);

/** Step rows that never executed carry no latency, cost or outcome. */
const NOT_EXECUTED = new Set(["pending", "skipped", "queued", "unknown"]);

/**
 * How much one unit of each signal is worth. `failing` and `weak` are rates
 * (per execution); `costly` and `slow` are shares of all spend and wallclock,
 * and some step always holds the largest share, so shares are discounted. A
 * failure is weighted highest: it throws away the whole run, upstream spend
 * included, and produces nothing.
 */
export const SIGNAL_WEIGHTS = Object.freeze({ failing: 2.0, weak: 1.0, costly: 0.5, slow: 0.4 });

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[at];
}

/**
 * Cost as Cloud reports it. An unmetered attempt makes that a lower bound, and
 * `getCloudRunSteps` carries no flag saying so, so cost shares are "as
 * reported" — the analyst is told the same.
 */
function stepCost(step) {
  return finite(step.cost_usd) ?? finite(step.transcript?.total_cost_usd);
}

function failed(step) {
  if (step.status === "failed") return true;
  return step.completion_reason !== null && step.completion_reason !== undefined && step.completion_reason !== "success";
}

/**
 * "Weak": the step reported success but something about it was not right —
 * a verification gate rejected an attempt, it needed retries, or the agent
 * CLI itself said its result was an error.
 */
function weak(step) {
  if (failed(step)) return false;
  const gateRejected = step.gate !== null && step.gate !== undefined && step.gate.verdict !== "pass" && step.gate.verdict !== "passed";
  const retried = (finite(step.retry_count) ?? 0) > 0 || (Array.isArray(step.attempts) && step.attempts.length > 1);
  const cliError = step.transcript?.is_error === true;
  return gateRejected || retried || cliError;
}

/**
 * @param {{ run_id: string, status: string, steps: object[] }[]} runs
 * @returns {{ runs: number, steps: object[] }}
 */
export function digestRuns(runs) {
  const byStep = new Map();
  let runCost = 0;
  let runWallclock = 0;
  for (const run of runs) {
    for (const step of run.steps) {
      if (NOT_EXECUTED.has(step.status)) continue;
      let entry = byStep.get(step.step_name);
      if (entry === undefined) {
        entry = { step: step.step_name, type: step.step_type, executions: 0, failures: 0, weak: 0,
          durations: [], costs: [], tokens_in: 0, tokens_out: 0, failed_runs: [], weak_runs: [],
          completion_reasons: {}, gate_details: [] };
        byStep.set(step.step_name, entry);
      }
      entry.executions += 1;
      const duration = finite(step.duration_ms);
      if (duration !== null) { entry.durations.push(duration); runWallclock += duration; }
      const cost = stepCost(step);
      if (cost !== null) { entry.costs.push(cost); runCost += cost; }
      entry.tokens_in += finite(step.tokens_in) ?? finite(step.transcript?.tokens_in) ?? 0;
      entry.tokens_out += finite(step.tokens_out) ?? finite(step.transcript?.tokens_out) ?? 0;
      const reason = step.completion_reason ?? step.status;
      entry.completion_reasons[reason] = (entry.completion_reasons[reason] ?? 0) + 1;
      if (failed(step)) { entry.failures += 1; entry.failed_runs.push(run.run_id); }
      else if (weak(step)) { entry.weak += 1; entry.weak_runs.push(run.run_id); }
      if (step.gate && step.gate.detail && entry.gate_details.length < 3) entry.gate_details.push(step.gate.detail);
    }
  }

  const steps = [...byStep.values()].map((entry) => {
    const durations = [...entry.durations].sort((a, b) => a - b);
    const totalDuration = entry.durations.reduce((a, b) => a + b, 0);
    const totalCost = entry.costs.reduce((a, b) => a + b, 0);
    const signals = {
      failing: entry.failures / entry.executions,
      weak: entry.weak / entry.executions,
      costly: runCost > 0 ? totalCost / runCost : 0,
      slow: runWallclock > 0 ? totalDuration / runWallclock : 0,
    };
    const weighted = Object.entries(signals).map(([name, value]) => [name, value * SIGNAL_WEIGHTS[name]]);
    weighted.sort((a, b) => b[1] - a[1]);
    const [primary, leverage] = weighted[0];
    return {
      step: entry.step,
      type: entry.type,
      executions: entry.executions,
      failures: entry.failures,
      weak: entry.weak,
      p50_ms: quantile(durations, 0.5),
      p95_ms: quantile(durations, 0.95),
      mean_cost_usd: entry.costs.length ? totalCost / entry.costs.length : null,
      tokens_in: entry.tokens_in,
      tokens_out: entry.tokens_out,
      completion_reasons: entry.completion_reasons,
      failed_runs: entry.failed_runs,
      weak_runs: entry.weak_runs,
      gate_details: entry.gate_details,
      signals: Object.fromEntries(Object.entries(signals).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
      primary_signal: primary,
      leverage: Math.round(leverage * 1000) / 1000,
    };
  });
  steps.sort((a, b) => b.leverage - a.leverage || a.step.localeCompare(b.step));
  return { runs: runs.length, steps };
}

/**
 * The per-step rows an agent can read without blowing its context: the
 * numbers plus the bounded text Cloud already keeps (output summary, gate
 * detail, the last tool calls), never a full transcript.
 */
export function compactRun(run) {
  return {
    run_id: run.run_id,
    status: run.status,
    completion_reason: run.completion_reason ?? null,
    created_at: run.created_at ?? null,
    steps: run.steps.map((step) => ({
      step: step.step_name,
      type: step.step_type,
      status: step.status,
      completion_reason: step.completion_reason,
      model: step.model ?? step.transcript?.model ?? null,
      duration_ms: finite(step.duration_ms),
      cost_usd: stepCost(step),
      tokens_in: finite(step.tokens_in),
      tokens_out: finite(step.tokens_out),
      retry_count: finite(step.retry_count),
      attempts: Array.isArray(step.attempts) ? step.attempts.length : 0,
      gate: step.gate ?? null,
      num_turns: step.transcript?.num_turns ?? null,
      cli_error: step.transcript?.is_error === true,
      tool_errors: (step.transcript?.tools ?? []).reduce((n, t) => n + (finite(t.errors) ?? 0), 0),
      output_summary: typeof step.output_summary === "string" ? step.output_summary.slice(0, 1500) : null,
      last_calls: (step.transcript?.last_calls ?? []).slice(-5).map((c) => ({ name: c.name, input: c.input_excerpt })),
    })),
  };
}
