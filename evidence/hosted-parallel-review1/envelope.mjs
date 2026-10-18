// Apply the Cloud Bun-compatibility envelope (cloud packages/core/src/bootstrap/lib/relayflow-v2-executor.ts ~3912-3975) to an installed Surface.
import fs from 'node:fs'; import path from 'node:path';
const root = process.argv[2];
const m = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: m.name, version: m.version, private: true, type: 'module', types: './index.d.ts',
  exports: { '.': './index.js', './runtime': './runtime.js', './triggers': './triggers/index.js', './triggers/*': './triggers/*.js' } }));
fs.writeFileSync(path.join(root, 'index.js'), "export * from './dist/index.js';\n");
fs.writeFileSync(path.join(root, 'runtime.js'), "export { getFlowDefinition } from './dist/flow.js';\n");
fs.writeFileSync(path.join(root, 'index.d.ts'), "export * from './dist/index.js';\n");
fs.writeFileSync(path.join(root, 'runtime.d.ts'), "export { getFlowDefinition } from './dist/flow.js';\n");
fs.mkdirSync(path.join(root, 'triggers'), { recursive: true });
for (const e of fs.readdirSync(path.join(root, 'dist/triggers')).filter(n => /^[a-z0-9-]+\.js$/.test(n))) {
  fs.writeFileSync(path.join(root, 'triggers', e), `export * from '../dist/triggers/${e}';\n`);
  fs.writeFileSync(path.join(root, 'triggers', e.replace(/\.js$/, '.d.ts')), `export * from '../dist/triggers/${e}';\n`);
}
console.log('envelope applied', m.version);
