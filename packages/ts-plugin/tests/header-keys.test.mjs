import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { checkHelperBody } from '../../sdk/src/cli/check-helper-body.ts';
import codes from '../dist/diagnostics.js';
import { languageService } from './host.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const projects = readdirSync(fixtures, { withFileTypes: true }).filter((entry) => entry.isDirectory());

for (const project of projects) {
  const directory = join(fixtures, project.name);
  const file = join(directory, 'flow.ts');
  const source = readFileSync(file, 'utf8');
  const expected = JSON.parse(readFileSync(join(directory, 'expected.json'), 'utf8'));

  test(`${project.name}: language service diagnostic code and span`, () => {
    const host = languageService(file);
    try {
      const diagnostics = host.diagnostics();
      assert.equal(diagnostics.length, expected.length);
      for (const [index, expectation] of expected.entries()) {
        const diagnostic = diagnostics[index];
        assert.equal(diagnostic.code, codes.DIAGNOSTICS.UNKNOWN_HEADER_KEY);
        assert.equal(diagnostic.category, ts.DiagnosticCategory.Error);
        assert.equal(diagnostic.start, source.indexOf(expectation.token));
        assert.equal(diagnostic.length, expectation.token.length);
        assert.equal(diagnostic.file.fileName, file);
        assert.ok(diagnostic.messageText.includes(`unknown field ${JSON.stringify(expectation.key)}`));
        if (expectation.suggestion) {
          assert.ok(diagnostic.messageText.includes(`Did you mean "${expectation.suggestion}"?`));
        } else {
          assert.ok(!diagnostic.messageText.includes('Did you mean'));
        }
      }
    } finally { host.dispose(); }
  });

  test(`${project.name}: exact static parity with the flows check TypeScript entry point`, async () => {
    const host = languageService(file);
    try {
      const diagnostics = host.diagnostics();
      const { report } = await checkHelperBody(file);
      // Compare all SDK diagnostics, not a filtered subset that could hide
      // missing checks. Each bad fixture intentionally has one refusal.
      assert.equal(report.ok, diagnostics.length === 0, JSON.stringify(report));
      assert.equal(report.diagnostics.length, diagnostics.length, JSON.stringify(report));
      for (const [index, diagnostic] of diagnostics.entries()) {
        const refusal = report.diagnostics[index];
        assert.equal(refusal.kind, 'invalid_spec');
        assert.equal(refusal.severity, 'refusal');
        assert.ok(refusal.message.includes('unsupported_header:'), refusal.message);
        const field = `unknown field ${JSON.stringify(expected[index].key)}`;
        assert.ok(refusal.message.includes(field), refusal.message);
        assert.ok(diagnostic.messageText.includes(field));
      }
    } finally { host.dispose(); }
  });
}

const virtualFile = join(fixtures, 'virtual.ts');
test('preserves native diagnostics and delegate methods; refreshes unsaved edits', () => {
  const bad = `import { flow } from '@relayflows/surface';
const value: string = 1;
export default flow('example', { identty: 'test' }, async () => {});`;
  const host = languageService(virtualFile, bad);
  try {
    const native = host.original.getSemanticDiagnostics(virtualFile);
    assert.ok(native.some((d) => d.code === 2322));
    assert.deepEqual(host.service.getSemanticDiagnostics(virtualFile).filter((d) => d.source !== 'relayflows'), native);
    assert.equal(host.service.getProgram(), host.original.getProgram());
    assert.equal(host.diagnostics().length, 1);
    host.update(bad.replace('identty', 'identity'));
    assert.equal(host.diagnostics().length, 0);
    host.update(bad);
    assert.equal(host.diagnostics().length, 1);
  } finally { host.dispose(); }
});

for (const [name, source] of Object.entries({
  unrelated: `function flow(...args: any[]) {}\nflow('x', { identty: 'x' }, async () => {});`,
  shadowed: `import { flow } from '@relayflows/surface';
function example(flow: (...args: any[]) => void) { flow('x', { identty: 'x' }, async () => {}); }`,
  dynamic: `import { flow } from '@relayflows/surface';
const header = { identity: 'x' }; flow('x', header, async () => {});`,
  overwritten: `import { flow } from '@relayflows/surface';
flow('x', { memory: { scrip: true }, ...{ memory: { script: true } } }, async () => {});`,
  accessor: `import { flow } from '@relayflows/surface';
flow('x', { get memory() { return { scrip: true }; } }, async () => {});`,
})) {
  test(`does not speculate about ${name} code`, () => {
    const host = languageService(virtualFile, source);
    try { assert.deepEqual(host.diagnostics(), []); } finally { host.dispose(); }
  });
}
