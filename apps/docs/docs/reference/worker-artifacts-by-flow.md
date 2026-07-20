---
title: Worker artifacts by flow
---

# Worker artifacts by flow

High-level contract for what a worker must write under `{{TASK_DIR}}/artifacts/` before `./mark complete --mark-last`. This is the same finish shape in **Farmslot-dispatched runs** and **standalone agentic skills** (with one exception noted below).

For the short worker checklist, see [Finish a worker run](worker-run-finish.md). For signal schema and freshness rules, see [Worker signal protocol](worker-signal-protocol.md).

## Every terminal run

| Artifact                   | Required                                                                                                                                                | Purpose                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `artifacts/learnings.md`   | **Contribution flows** (unless `./mark --skip-learnings`); reviewer flows (self-review, self-review-fix) require their feedback/report artifact instead | Process meta for retrospective and improvement — 3–5 bullets; one bullet if nothing relevant |
| Flow outcome file          | **Yes** (see table below)                                                                                                                               | What happened: fix summary, review, PR body, merge notes, or no-change investigation         |
| `SIGNAL.json`              | **Yes**                                                                                                                                                 | Written only by `./mark` — never hand-edited                                                 |
| `CHECKLIST.md` / `TASK.md` | **Yes**                                                                                                                                                 | Every box `[x]` when using `--mark-last`                                                     |

## Outcome file by flow

PR-producing flows use **`pr-description.md`** as the single outcome artifact (internal operator summary + publishable PR body). Do **not** also write `report.md` for dev/fix-bug.

| Flow                                              | Outcome artifact                | Notes                                                                                                                          |
| ------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **dev**                                           | `artifacts/pr-description.md`   | Gateway publishes this after the publication gate. Include summary, test plan, evidence placeholders, validation recipe block. |
| **fix-bug**                                       | `artifacts/pr-description.md`   | Same — root cause, fix, validation, repo template sections.                                                                    |
| **review-pr**                                     | `artifacts/review.md`           | Primary review output. Also `artifacts/line-comments.json` (may be `[]`).                                                      |
| **pr-complete**                                   | `artifacts/comments-report.md`  | Comment triage + fixes; interactive handoff may omit worker terminal signal.                                                   |
| **update-branch**                                 | `artifacts/report.md`           | Conflicts resolved, validation, risk notes.                                                                                    |
| **no-change** (any flow)                          | `artifacts/no-change-report.md` | Use `./mark no-change --reason "…" --mark-last`.                                                                               |
| **ci-fix**, **validate-dep**, **self-review-fix** | `artifacts/report.md`           | Secondary/utility flows — no PR package.                                                                                       |

### Standalone recipe skills (no Farmslot dispatch)

`recipe-dev` and `recipe-fix-ticket` under consensys-skills typically **do not** open a PR automatically. They use:

- `artifacts/learnings.md` — always
- `artifacts/report.md` — short run summary for the human reviewer (no `pr-description.md` unless you later open a PR via `/mms-recipe-evidence`)

When the same run is later imported into Farmslot or promoted to a farm worker flow, rename or copy into `pr-description.md` if publishing.

## Recipe runs (conditional)

When `artifacts/recipe.json` exists, also write:

| Artifact                           | When                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `artifacts/recipe-coverage.md`     | Recipe maps to acceptance criteria                                                         |
| `artifacts/evidence-manifest.json` | Visual evidence for PR embed                                                               |
| `artifacts/recipe-quality.json`    | Project/template expects quality gate; generate with `farmslot-agent recipe-quality build` |

`./mark complete` and `check-task-artifact-contract.mjs` enforce these when the recipe file is present.

## How enforcement works

```text
Template / skill checklist
        ↓
Worker writes artifacts/
        ↓
./mark complete --mark-last   ← canonical script: @farmslot/agent-runtime
        ↓
SIGNAL.json (terminal)
        ↓
Farmslot: monitor + publication gate reads pr-description / review / …
```

Built-in defaults live in [`worker-terminal-contract.cjs`](https://github.com/deeeed/farmslot/blob/main/packages/agent-runtime/scripts/worker-terminal-contract.cjs). Farmslot farms may override per flow in `project.json` -> `worker_terminal`; dispatched runs also get `inputs/worker-terminal-contract.json`.

## Related

- [Finish a worker run](worker-run-finish.md) — three-step worker checklist
- [ADR-045: Worker terminal contract](https://github.com/deeeed/farmslot/blob/main/docs/adr/045-worker-terminal-contract.md) — project.json overrides
- [Recipe skills adoption kit](../guides/recipe-skills-adoption.md) — standalone skills path
