# Completed GitHub delivery

**Delivered by the coordinator's authenticated session on 2026-09-10; independently verified via the public API. Do not re-run these creation commands.**

- LLM: [#273](https://github.com/AgentWorkforce/flows/issues/273)
- YAML worker: [#274](https://github.com/AgentWorkforce/flows/issues/274)
- YAML binding: [#275](https://github.com/AgentWorkforce/flows/issues/275)
- Runtime diagnostic: [#276](https://github.com/AgentWorkforce/flows/issues/276)
- Dependency audit: [#277](https://github.com/AgentWorkforce/flows/issues/277)
- Observer origins: [#278](https://github.com/AgentWorkforce/flows/issues/278)
- Help fix: [PR #279](https://github.com/AgentWorkforce/flows/pull/279)
- Docs fix: [PR #280](https://github.com/AgentWorkforce/flows/pull/280)
- Report: [draft PR #281](https://github.com/AgentWorkforce/flows/pull/281)
- Observer owner update: [#264 comment](https://github.com/AgentWorkforce/flows/issues/264#issuecomment-5620663794)

The commands below and local HTTP401 transcripts are historical evidence. A human still merges. No credentials belong in this file.

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

The report now links the created objects. Filing an issue does not resolve the product blocker.

## observer-origins

```sh
gh issue create --repo AgentWorkforce/flows --title 'flows: observer API and dashboard origins produce HTTP 404' --body-file evidence/shakedown-0910/issues/observer-origins.md
```
