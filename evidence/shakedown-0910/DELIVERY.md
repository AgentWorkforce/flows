# Pending GitHub delivery

These commands were attempted and refused with HTTP 401. They are ready to run after existing GitHub write authentication is restored. Run from the root of branch `shakedown/v2-launch-0910`. Check for an existing matching issue/PR first if another coordinator has resumed delivery, to avoid duplicates. The report PR must remain a draft; a human merges. No credentials belong in this file.

## llm-local

```sh
gh issue create --repo AgentWorkforce/flows --title 'flows: flagship llm chain has no executable local path in YAML or TypeScript' --body-file evidence/shakedown-0910/issues/llm-local.md
```

## yaml-worker

```sh
gh issue create --repo AgentWorkforce/flows --title 'flows: YAML agent runs park without a supported local-worker command' --body-file evidence/shakedown-0910/issues/yaml-worker.md
```

## yaml-binding

```sh
gh issue create --repo AgentWorkforce/flows --title 'flows: declarative steps lack a supported way to consume upstream output' --body-file evidence/shakedown-0910/issues/yaml-binding.md
```

## runtime-diagnostic

```sh
gh issue create --repo AgentWorkforce/flows --title 'flows: failed deterministic runs hide the command exit code and stderr' --body-file evidence/shakedown-0910/issues/runtime-diagnostic.md
```

## dependency-audit

```sh
gh issue create --repo AgentWorkforce/flows --title 'flows: fresh SDK npm ci reports six dependency advisories' --body-file evidence/shakedown-0910/issues/dependency-audit.md
```

## observer-comment

```sh
gh issue comment 264 --repo AgentWorkforce/flows --body-file evidence/shakedown-0910/issues/observer-264-comment.md
```

## help-pr

```sh
gh pr create --repo AgentWorkforce/flows --base main --head fix/cli-help-shakedown-0910 --title 'fix(cli): make help and single-step summaries readable' --body-file evidence/shakedown-0910/help-pr-body.md
```

## docs-pr

```sh
gh pr create --repo AgentWorkforce/flows --base main --head fix/docs-inline-model-shakedown-0910 --title 'fix(docs): clarify inline model behavior without project config' --body-file evidence/shakedown-0910/docs-pr-body.md
```

## report-pr

```sh
gh pr create --repo AgentWorkforce/flows --base main --head shakedown/v2-launch-0910 --title 'docs: report v2 launch shakedown findings and evidence' --body-file evidence/shakedown-0910/report-pr-body.md --draft
```

After creation, replace the report’s prepared-body links with the returned GitHub URLs and update the delivery-status paragraph. Do not mark any product blocker resolved merely because its issue was filed.

## observer-origins

```sh
gh issue create --repo AgentWorkforce/flows --title 'flows: observer API and dashboard origins produce HTTP 404' --body-file evidence/shakedown-0910/issues/observer-origins.md
```
