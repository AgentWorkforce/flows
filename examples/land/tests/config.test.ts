import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  parseLandConfig, LAND_CONFIG_DEFAULTS, MERGE_MODES, CHANGELOG_RULES, HARNESSES, SQUASH_AUTHORS, RUNNER_OS, RUNNER_ARCH,
} from '../land.flow.ts';

const schema = JSON.parse(readFileSync(new URL('../land.config.schema.json', import.meta.url), 'utf8'));
const minimal = { reviewFlows: { adversarial: 'flows/adversarial-review.flow.ts', context: 'flows/context-review.flow.ts' }, ciFlow: 'flows/ci.flow.ts' };

test('defaults: mergePolicy is shadow, placeholders are the spec proposals', () => {
  const c = parseLandConfig(minimal);
  assert.equal(c.mergePolicy.mode, 'shadow');
  assert.equal(c.fixLoop.maxRounds, 4);
  assert.equal(c.fixLoop.wallclockMinutes, 180);
  assert.equal(c.fixLoop.harness, 'claude');
  assert.equal(c.fixLoop.model, undefined);
  assert.equal(c.changelog, 'optional');
  assert.equal(c.baseBranch, 'main');
  assert.deepEqual(c.runner, { os: 'linux', arch: 'x64', commands: ['git', 'node'], setup: [], stageMinutes: 30 });
});

test('a full relay-desktop shaped config round-trips', () => {
  const full = {
    $schema: './land.config.schema.json', ...minimal, baseBranch: 'main', flowsBin: 'flows/node_modules/.bin/flows',
    runner: { os: 'linux', arch: 'x64', commands: ['git', 'node', 'cargo', 'python3', 'claude'], setup: ['npm ci --prefix flows --no-audit --no-fund'], stageMinutes: 25 },
    changelog: 'required',
    mergePolicy: { mode: 'shadow', squashAuthor: 'agent-with-human-coauthor', approvalDropAfterCleanLandings: 10 },
    fixLoop: { maxRounds: 3, wallclockMinutes: 120, harness: 'codex', model: 'gpt-5.5-codex' },
    landRef: 'land/{user}/{sha7}',
  };
  const { $schema, ...rest } = full;
  assert.deepEqual(parseLandConfig(full), rest);
});

test('refusals: unknown keys, bad enums, unsafe paths, out-of-range numbers', () => {
  const bad: Array<[unknown, RegExp]> = [
    [null, /must be an object/],
    [{ ...minimal, extra: 1 }, /\.extra: unknown key/],
    [{ ciFlow: 'ci.flow.ts' }, /\.reviewFlows: must be an object/],
    [{ ...minimal, ciFlow: '../ci.flow.ts' }, /\.ciFlow/],
    [{ ...minimal, ciFlow: '/abs/ci.flow.ts' }, /\.ciFlow/],
    [{ ...minimal, ciFlow: 'a;rm -rf x' }, /\.ciFlow/],
    [{ ...minimal, mergePolicy: { mode: 'yolo' } }, /\.mergePolicy\.mode: must be one of shadow, approval, auto/],
    [{ ...minimal, changelog: 'sometimes' }, /\.changelog/],
    [{ ...minimal, fixLoop: { maxRounds: 0 } }, /\.fixLoop\.maxRounds/],
    [{ ...minimal, fixLoop: { maxRounds: 2.5 } }, /\.fixLoop\.maxRounds/],
    [{ ...minimal, fixLoop: { wallclockMinutes: 5 } }, /\.fixLoop\.wallclockMinutes/],
    [{ ...minimal, fixLoop: { harness: 'cursor' } }, /\.fixLoop\.harness/],
    [{ ...minimal, fixLoop: { model: 'x y' } }, /\.fixLoop\.model/],
    // Removed: shadow never has a write token (cloud#5806 decision B), so the flag could never succeed.
    [{ ...minimal, mergePolicy: { githubGateInShadow: true } }, /\.mergePolicy\.githubGateInShadow: unknown key/],
    [{ ...minimal, landRef: 'land/{user}' }, /\.landRef/],
    [{ ...minimal, runner: { commands: ['git; curl'] } }, /\.runner\.commands\[0\]/],
    [{ ...minimal, baseBranch: '-main' }, /\.baseBranch/],
    [{ ...minimal, runner: { stageMinutes: 40 } }, /\.runner\.stageMinutes: must be an integer 5-35/],
  ];
  for (const [raw, message] of bad) assert.throws(() => parseLandConfig(raw), message, JSON.stringify(raw));
});

test('JSON schema matches the runtime validator: keys, required, enums and defaults', () => {
  const p = schema.properties;
  assert.deepEqual(Object.keys(p).sort(), ['$schema', 'reviewFlows', 'ciFlow', 'baseBranch', 'flowsBin', 'runner', 'changelog', 'mergePolicy', 'fixLoop', 'landRef'].sort());
  assert.deepEqual(schema.required, ['reviewFlows', 'ciFlow']);
  assert.deepEqual(p.reviewFlows.required, ['adversarial', 'context']);
  assert.deepEqual(p.mergePolicy.properties.mode.enum, [...MERGE_MODES]);
  assert.deepEqual(p.changelog.enum, [...CHANGELOG_RULES]);
  assert.deepEqual(p.fixLoop.properties.harness.enum, [...HARNESSES]);
  assert.deepEqual(p.mergePolicy.properties.squashAuthor.enum, [...SQUASH_AUTHORS]);
  assert.deepEqual(p.runner.properties.os.enum, [...RUNNER_OS]);
  assert.deepEqual(p.runner.properties.arch.enum, [...RUNNER_ARCH]);
  const D = LAND_CONFIG_DEFAULTS;
  assert.equal(p.baseBranch.default, D.baseBranch);
  assert.equal(p.flowsBin.default, D.flowsBin);
  assert.equal(p.changelog.default, D.changelog);
  assert.equal(p.landRef.default, D.landRef);
  assert.deepEqual(p.runner.properties.commands.default, D.runner.commands);
  assert.equal(p.runner.properties.stageMinutes.default, D.runner.stageMinutes);
  for (const key of Object.keys(D.mergePolicy) as Array<keyof typeof D.mergePolicy>) assert.equal(p.mergePolicy.properties[key].default, D.mergePolicy[key], key);
  for (const key of ['maxRounds', 'wallclockMinutes', 'harness'] as const) assert.equal(p.fixLoop.properties[key].default, D.fixLoop[key], key);
  for (const [section, keys] of [['runner', ['os', 'arch', 'commands', 'setup', 'stageMinutes']], ['mergePolicy', Object.keys(D.mergePolicy)], ['fixLoop', ['maxRounds', 'wallclockMinutes', 'harness', 'model']]] as const) {
    assert.deepEqual(Object.keys(p[section].properties).sort(), [...keys].sort(), section);
    assert.equal(p[section].additionalProperties, false, section);
  }
});

test('every PLACEHOLDER default names its open question', () => {
  const source = readFileSync(new URL('../land.flow.ts', import.meta.url), 'utf8');
  const lines = source.split('\n').filter(line => line.includes('PLACEHOLDER'));
  assert.ok(lines.length >= 5);
  for (const line of lines) assert.match(line, /PLACEHOLDER pending decision \(cloud#5806 Q\d\)/, line);
  for (const q of ['Q2', 'Q3', 'Q5', 'Q6']) assert.ok(lines.some(line => line.includes(`cloud#5806 ${q}`)), q);
});
