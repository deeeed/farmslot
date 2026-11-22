---
title: Worker template quality (optional)
---

# Worker template quality (optional)

Tooling for **pack authors** who edit `projects/<name>/templates/worker/*.md`. It does **not** run during dispatch, slot prepare, or the run monitor — workers still finish via `./mark` and packaged artifacts at runtime.

Use this when authoring or reviewing templates before merge.

## Two layers

| Layer                  | What                                                  | When                                          |
| ---------------------- | ----------------------------------------------------- | --------------------------------------------- |
| **Deterministic lint** | Script checks contract + structure                    | Always — fast, no model                       |
| **Heuristic review**   | Repo-local agent skill (`fs-worker-template-quality`) | Optional — succinctness, contradictions, flow |

## Deterministic lint

From a Farmslot checkout:

```bash
# Default: farmslot-farm reference project
yarn quality:worker-templates

# Your pack (nested project repo or path)
yarn quality:worker-templates projects/my-farm

# Single file
node scripts/quality/check-worker-template-contract.mjs projects/my-farm/templates/worker/dev.md
```

**Contract checks**

- Terminal flow documents `./mark complete`, `./mark no-change`, or `./mark blocked` (or `mark-checklist-step … complete` for secondary signals like self-review)
- Checklist references required artifact paths for the inferred flow (`artifacts/learnings.md`, `artifacts/report.md`, `artifacts/review.md`, …)
- Honors `worker_terminal` overrides in `project.json` when present
- A template or execution-template checklist that runs recipe proof names the selected proof attempt, `artifacts/latest-valid-recipe-run.json` (see [Recipe proof selection](#recipe-proof-selection)). Review and QA flows are exempt.

**Structure checks**

- `{TASK_DIR}` single-brace typos (must be `{{TASK_DIR}}`)
- Duplicate checklist step numbers (`**14.` twice)
- Missing `## Task` / checklist / completion section on terminal templates

Failing lint should be fixed before merge. Farmslot’s own repo runs this in `yarn quality` for `projects/farmslot-farm` only — external packs run it locally.

## Recipe proof selection

A worker template that runs recipe proof tells the worker which attempt the task claims: the passing attempt selected in `artifacts/latest-valid-recipe-run.json`. A passing proof run with `RECIPE_TASK_DIR` set in the same command, writing under `artifacts/recipe-runs/<attempt>`, records that selection. To claim another retained attempt, run `retained-recipe-attempt.cjs <task-dir> <attempt-dir>`. `./mark complete` refuses proof attempts under `artifacts/recipe-runs` when nothing selects one. It also refuses a selection without `artifacts/recipe.json`.

A task-root `artifacts/evidence-manifest.json` is optional. Use it only to declare extra evidence, such as captures from another attempt.

**Before evidence from a separate base run.** Publication checks only the paths declared in the selected manifest. A file from another recipe attempt is accepted only as before evidence (`before_after_pairs[].before` or `videos.before`), never as after or standalone evidence. That attempt must carry `product-provenance.json` with a clean `git_ref` equal to an eligible base: a recorded pre-work base, the publication merge base when the selected attempt is on the publication head, or a `BUG_MARKER` child of a recorded base. Run the base proof from that clean commit into its own attempt, then declare its captures as before evidence. Undeclared attempts and prose in reports never block publication. If an "outside selected recipe attempt" error names an older attempt, the selection has moved since: check the newest package under `artifacts/publication-packages` before changing evidence.

## Heuristic review (skill)

From a Farmslot checkout, invoke the **`fs-worker-template-quality`** skill in Cursor / Claude Code when you want a second pass. It lives at `.agents/skills/fs-worker-template-quality/` in this repository and is **not** shipped in the `@farmslot/skills` package, so it is available to contributors working in the repo rather than to package consumers:

1. Run the deterministic script (skill Step 1)
2. Critique against the rubric: succinct steps, no contradictions, clear stop conditions, consistent finish contract
3. Output blocking / should-fix / nits with suggested line edits

The skill is **not wired into** gateway hooks or operator UI. It is documentation + rubric for humans and agents editing templates.

## What runtime still enforces

Template quality tooling is separate from **run finish**:

- Workers write artifacts and run `./mark complete --mark-last` (see [Finish a worker run](worker-run-finish.md))
- `./mark` validates learnings, reports, checklist completion, and artifact contract
- Farmslot monitor waits for terminal `SIGNAL.json` when `requireSignal` applies

See also [Worker signal protocol](worker-signal-protocol.md) and [Customize worker prompts](../guides/customize-worker-prompts.md).

## Flow artifact quick reference

| Flow            | Typical complete artifacts                                                      |
| --------------- | ------------------------------------------------------------------------------- |
| dev / fix-bug   | `learnings.md`, `pr-description.md`                                             |
| review-pr       | `learnings.md`, `review.md`, `line-comments.json` (always — write `[]` if none) |
| pr-complete     | `learnings.md`, `comments-report.md`                                            |
| update-branch   | `learnings.md`, `report.md`                                                     |
| ci-fix          | `learnings.md`, `report.md`                                                     |
| validate-dep    | `learnings.md`, `report.md`                                                     |
| self-review     | `review-feedback.md` (reviewer flow — no learnings required)                    |
| self-review-fix | `report.md` (reviewer-fix flow — no learnings required)                         |

Projects may override lists via `worker_terminal` in `project.json` — see [ADR-045](https://github.com/deeeed/farmslot/blob/main/docs/adr/045-worker-terminal-contract.md).
