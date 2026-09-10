## Summary

**Low launch severity for this local CLI shakedown; reachability not assessed.** The documented fresh `packages/sdk` install succeeds but immediately reports `6 vulnerabilities (4 moderate, 1 high, 1 critical)`. This is visible first-build friction and merits dependency maintenance. The high/critical findings are in development tooling, not the production-only audit.

## Repro

From main `a42ca16` plus #268/#269, using Node 25.8.1:

```sh
cd packages/sdk
npm ci
npm audit --json
npm audit --omit=dev --json
```

Install output:

```text
added 58 packages, and audited 59 packages in 1s

16 packages are looking for funding
  run `npm fund` for details

6 vulnerabilities (4 moderate, 1 high, 1 critical)
```

Full audit: `vitest` critical, `vite` high, `@vitest/mocker`, `vite-node`, `esbuild`, and `ajv` moderate. The suggested test-tooling upgrade crosses a major version to Vitest 4.1.11. Production-only audit contains just the moderate Ajv `$data` ReDoS advisory (GHSA-2g4f-4pwh-qvx6). This report does not establish exploitability or assert that `$data` is enabled.

## Expected

The documented clean SDK build has an evaluated dependency baseline and no unexplained high/critical install banner.

## Suggested direction

Evaluate compatible test-tooling and Ajv updates, capture reachability where upgrades must be deferred, and rerun the SDK tests. Do not use blanket audit suppression or `npm audit fix --force` without checking the resulting major-version changes.

## Acceptance criteria

- Fresh install and full/production-only audits are captured after maintenance.
- The selected dependency changes pass SDK type checks and relevant tests.
- Any remaining advisory has an explicit, evidence-based disposition.
