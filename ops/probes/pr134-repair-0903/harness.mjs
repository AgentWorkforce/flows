// Shared probe harness for the PR #134 authored-lifecycle repair.
//
// Drives the real `executeAuthoredFlow` against a loopback journal faithful to
// `packages/sdk/tests/journal-client-loopback.ts`, and reports which journal runs were
// started — so "did the flow lower its terminal complete-* run" is observed,
// not inferred. Run any probe in this directory with plain `node`.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const { executeAuthoredFlow } = await import(`${REPO}/sdk/dist/authored-flow-executor.js`);
export const { JournalClient } = await import(`${REPO}/sdk/dist/journal-client.js`);
export const { flow } = await import(`${REPO}/surface/dist/index.js`);

function sockPath() { return join(tmpdir(), `rf-${randomUUID().slice(0, 8)}.sock`); }

export async function runFlow(handle) {
  const path = sockPath();
  const started = [];
  const stepByRun = new Map();
  let nextRun = 1;
  const server = createServer((socket) => {
    let buffer = '';
    const send = (o) => socket.write(JSON.stringify(o) + '\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const req = JSON.parse(line);
        if (req.verb === 'hello') { send({ id: req.id, ok: true, result: { protocol: '0.1.0', server: 'probe' } }); continue; }
        if (req.verb === 'run.start') {
          const spec = req.params.spec; const step = spec.steps[0];
          const runId = `probe-run-${nextRun++}`;
          started.push(spec.name);
          stepByRun.set(runId, { id: step.id, command: step.command });
          send({ id: req.id, ok: true, result: {
            run_id: runId,
            status: step.command === 'false' ? 'failed' : 'completed',
            completion_reason: step.command === 'false' ? 'step_failed' : 'success',
            completed_steps: 1,
          }});
          continue;
        }
        if (req.verb === 'journal.read') {
          const step = stepByRun.get(req.params.run_id);
          const failed = step.command === 'false';
          send({ id: req.id, ok: true, result: { entries: [{
            entry_type: 'step.completed', step_id: step.id,
            payload: { completionReason: failed ? 'verification_failed' : 'success',
                       output: failed ? null : { stdout_tail: '', stderr_tail: '', exit_code: 0 } },
          }]}});
          continue;
        }
        send({ id: req.id, ok: false, error: { code: 'unknown_verb', message: req.verb } });
      }
    });
  });
  await new Promise((r) => server.listen(path, r));
  const client = new JournalClient(path, { requestTimeoutMs: 600000 });
  await client.connect();
  await client.hello('pr134-repair-probe');
  let result, error;
  try { result = await executeAuthoredFlow(handle, client); }
  catch (e) { error = e; }
  finally { client.close(); await new Promise((r) => server.close(r)); rmSync(path, { force: true }); }
  return { started, result, error, terminal: started.some((n) => n.includes('/complete-')) };
}

export function report(label, r) {
  console.log(`--- ${label}`);
  console.log(`    journal runs started: ${JSON.stringify(r.started)}`);
  console.log(`    terminal complete-* lowered: ${r.terminal}`);
  console.log(`    result: ${r.result ? JSON.stringify(r.result.completionReason) : 'none'}   error: ${r.error ? (r.error.code ?? '') + ': ' + r.error.message : 'none'}`);
}

export function verdict(r) {
  return r.error ? `REFUSED ${r.error.code}` : `PASSED(terminal=${r.terminal})`;
}
