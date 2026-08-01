---
title: Worker template quality (optional)
---

# Worker template quality (optional)

Tooling for **pack authors** who edit `projects/<name>/templates/worker/*.md`. It does **not** run during dispatch, slot prepare, or the run monitor — workers still finish via `./mark` and packaged artifacts at runtime.

Use this when authoring or reviewing templates before merge.

## Two layers

| Layer                  | What                                       | When                                          |
| ---------------------- | ------------------------------------------ | --------------------------------------------- |
| **Deterministic lint** | Script checks contract + structure         | Always — fast, no model                       |
| **Heuristic review**   | Agent skill (`fs-worker-template-quality`) | Optional — succinctness, contradictions, flow |

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

**Structure checks**

- `{TASK_DIR}` single-brace typos (must be `{{TASK_DIR}}`)
- Duplicate checklist step numbers (`**14.` twice)
- Missing `## Task` / checklist / completion section on terminal templates

Failing lint should be fixed before merge. Farmslot’s own repo runs this in `yarn quality` for `projects/farmslot-farm` only — external packs run it locally.

## Heuristic review (skill)

In Cursor / Claude Code, invoke the **`fs-worker-template-quality`** skill when you want a second pass:

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

| Flow            | Typical complete artifacts                                                       |
| --------------- | -------------------------------------------------------------------------------- |
| dev / fix-bug   | `learnings.md`, `pr-description.md`                                              |
| review-pr       | `learnings.md`, `review.md`, `line-comments.json` (when posting inline comments) |
| pr-complete     | `learnings.md`, `comments-report.md`                                             |
| update-branch   | `learnings.md`, `report.md`                                                      |
| ci-fix          | `learnings.md`, `report.md`                                                      |
| validate-dep    | `learnings.md`, `report.md`                                                      |
| self-review     | `review-feedback.md` (reviewer flow — no learnings required)                     |
| self-review-fix | `report.md` (reviewer-fix flow — no learnings required)                          |

Projects may override lists via `worker_terminal` in `project.json` — see [ADR-045](https://github.com/deeeed/farmslot/blob/main/docs/adr/045-worker-terminal-contract.md).
