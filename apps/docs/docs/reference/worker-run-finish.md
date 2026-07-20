---
title: Finish a worker run
---

# Finish a worker run

Short checklist for **template authors**, **workers**, and **standalone skill runs** (e.g. MetaMask agentic skills under `consensys-skills/domains/agentic/skills`, or `@farmslot/skills` installed in a repo). The **same finish shape** works inside and outside Farmslot.

**Per-flow artifact list:** [Worker artifacts by flow](worker-artifacts-by-flow.md)

## The three steps

1. **Write packaged artifacts** into `{{TASK_DIR}}/artifacts/` (see table below).
2. **Check every checklist box** in `TASK.md` (or `CHECKLIST.md`).
3. **Signal completion with `./mark`** — never hand-write `SIGNAL.json`.

```bash
{{TASK_DIR}}/mark complete --mark-last
```

Use `./mark no-change --reason "…" --mark-last` when the bug was already fixed or not reproducible (after `artifacts/no-change-report.md`).

Use `./mark blocked --reason "…"` when setup or environment blocked the task.

The task directory always includes a `./mark` helper. Run `./mark --help` if unsure.

## Same protocol in Farmslot and standalone skills

The finish contract is **not Farmslot-specific**. It is a small, portable convention any agent workflow can use:

| Piece                       | Purpose                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `CHECKLIST.md` or `TASK.md` | Human- and agent-visible steps (`- [ ]` / `- [x]`)                                  |
| `artifacts/`                | Packaged evidence (learnings, PR body, review, recipe outputs)                      |
| `./mark`                    | Updates checklist timing and writes `SIGNAL.json` — **never hand-write the signal** |
| `SIGNAL.json`               | Terminal status (`complete`, `blocked`, …) + optional `evidence.reportPath`         |

**Shared implementation:** `mark-checklist-step.cjs` ships in `@farmslot/agent-runtime`. Legacy `@farmslot/skills` script paths are compatibility shims. Standalone skills bootstrap a task dir with `CHECKLIST.md`, `artifacts/`, and a `./mark` wrapper that calls the installed runtime.

```bash
# Standalone (skills-only) — no gateway, no slot
.agents/skills/mms-recipe-dev/scripts/init-checklist.sh --platform mobile --slug my-task
# → temp/tasks/recipe-dev/<timestamp>-my-task/
cd temp/tasks/recipe-dev/...
./mark start
./mark 1
./mark complete --mark-last
```

```bash
# Farmslot-dispatched worker — same ./mark semantics, task under project task_dir
{{TASK_DIR}}/mark complete --mark-last
```

## What to write (by flow)

| Flow                                   | Outcome artifact (before `./mark complete`)                               | Learnings                                                       |
| -------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **dev**                                | `artifacts/pr-description.md` — PR body + summary + evidence placeholders | `artifacts/learnings.md` — 3–5 bullets; one if nothing relevant |
| **fix-bug**                            | `artifacts/pr-description.md`                                             | same                                                            |
| **review-pr**                          | `artifacts/review.md`, `artifacts/line-comments.json` (may be `[]`)       | same                                                            |
| **pr-complete**                        | `artifacts/comments-report.md`                                            | same                                                            |
| **update-branch**                      | `artifacts/report.md`                                                     | same                                                            |
| **Standalone recipe-dev / fix-ticket** | `artifacts/report.md` (no auto-PR)                                        | same                                                            |

Do **not** write both `report.md` and `pr-description.md` on dev/fix-bug — `pr-description.md` is the single outcome file.

**Learnings example when nothing surprising:**

```markdown
- Nothing relevant — straightforward run; no blockers or surprises.
```

**If the run used a recipe** (`artifacts/recipe.json` exists), also write:

- `artifacts/recipe-coverage.md`
- `artifacts/evidence-manifest.json`
- `artifacts/recipe-quality.json` (when your project expects it; generate it with `farmslot-agent recipe-quality build`, do not hand-author the full schema)

## Copy into new templates

Add this block near the end of every terminal worker template (adjust outcome path for the flow — see [Worker artifacts by flow](worker-artifacts-by-flow.md)):

```markdown
- [ ] **Write `{{TASK_DIR}}/artifacts/learnings.md`** — 3–5 bullets on key learnings or struggles; if nothing relevant, one bullet.
- [ ] **Write the flow outcome artifact** — e.g. `pr-description.md` (dev/fix-bug), `review.md` (review-pr), `report.md` (update-branch).
- [ ] **Finish** — `{{TASK_DIR}}/mark complete --mark-last` (never hand-write `SIGNAL.json`).
```

Interactive **pr-complete** is different: the worker prepares artifacts and stops; the operator writes the terminal signal after manual work.

## How Farmslot enforces this

Farmslot **adds orchestration** on top of the portable protocol above. Standalone skill runs still benefit from `./mark` locally; they simply do not have a gateway monitor.

| Layer                           | Standalone skills                                                       | Farmslot-dispatched run                                                               |
| ------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Checklist in template/skill** | Skill doc + embedded checklist (e.g. `recipe-dev`, `recipe-fix-ticket`) | `projects/<farm>/templates/worker/*.md`                                               |
| **`./mark` gate**               | Yes — same script; fails if required artifacts missing                  | Yes — same script; may read `inputs/worker-terminal-contract.json` when present       |
| **Run monitor**                 | No — human watches `CHECKLIST.md` / `SIGNAL.json` in the repo           | Yes — holds run until terminal `SIGNAL.json` (except interactive pr-complete handoff) |
| **Family / retrospective**      | Only if artifacts use standard names and run is imported                | Automatic via gateway + task dir                                                      |
| **Template CI lint**            | Optional (`yarn quality:worker-templates` on farm projects)             | Same                                                                                  |

### 1. Template or skill (you document it)

Worker templates under `projects/<farm>/templates/worker/` **or** agentic skill checklists tell the agent what to write and to run `./mark` last. That is the primary contract.

Farmslot farm projects can run `yarn quality:worker-templates` in CI to catch templates that call `./mark complete` but omit required artifact paths. Skill repos enforce the same via review of embedded checklists.

### 2. `./mark` (worker cannot signal without evidence — everywhere)

Every dispatched task gets a `./mark` helper beside `TASK.md`. On `complete` or `no-change`, `./mark` **refuses to write `SIGNAL.json`** until:

- required artifacts exist and are non-empty (contribution flows: **learnings** + **flow outcome**; reviewer flows: their **feedback/report** artifact);
- with `--mark-last`, every checklist item is `[x]`;
- when `artifacts/recipe.json` exists, recipe coverage / manifest / quality checks run too.

The worker sees the error locally and can fix artifacts before retrying. This works **with or without** a Farmslot gateway.

### 3. Run monitor (Farmslot only)

After dispatch, the gateway monitors the slot for a **terminal** `SIGNAL.json`. If the agent exits without signaling, the run **holds** for operator action instead of silently completing — except interactive pr-complete handoff.

Standalone skills have no monitor: the human (or a later import into Farmslot) relies on `./mark` + `SIGNAL.json` in the task dir.

Once a valid terminal signal exists, Farmslot runs advance (self-review, publication gate, release, …) and family observability reads learnings and outcome artifacts.

### Optional: project overrides (Farmslot farms)

Most farms need nothing beyond [Worker artifacts by flow](worker-artifacts-by-flow.md). Projects that want explicit per-flow lists can add `worker_terminal` in `project.json`; the gateway then writes `inputs/worker-terminal-contract.json` for each run and `./mark` reads it. See [ADR-045](https://github.com/deeeed/farmslot/blob/main/docs/adr/045-worker-terminal-contract.md).

```text
Skill/template checklist  →  worker writes artifacts  →  ./mark validates  →  SIGNAL.json
                                      ↑                           ↑
                              (same locally)          Farmslot: monitor waits for signal
```

## More detail

- **Per-flow artifact table** → [Worker artifacts by flow](worker-artifacts-by-flow.md)
- Skills-only adoption (no gateway) → [Recipe skills adoption kit](../guides/recipe-skills-adoption.md)
- Signal schema, freshness, blocked/failed shapes → [Worker signal protocol](worker-signal-protocol.md)
- Optional template authoring lint + review skill → [Worker template quality (optional)](worker-template-quality.md)
- Farmslot worker templates → [Customize worker prompts](../guides/customize-worker-prompts.md)
- Per-project artifact lists (`project.json` `worker_terminal`) → [ADR-045](https://github.com/deeeed/farmslot/blob/main/docs/adr/045-worker-terminal-contract.md)
