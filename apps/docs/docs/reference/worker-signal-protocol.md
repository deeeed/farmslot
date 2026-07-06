---
title: Worker signal protocol
---

# Worker signal protocol

`SIGNAL.json` is the worker-owned task signal file. It gives Farmslot a
runner-neutral way to observe terminal task state without parsing Claude, Codex,
Cursor, Grok, or shell output.

**Start here if you author templates or run workers (Farmslot or skills-only):**
[Finish a worker run](worker-run-finish.md) — portable checklist, `./mark`, and what Farmslot adds on top.
This page is the technical reference for the `SIGNAL.json` file itself.

## Ownership boundary

`SIGNAL.json` reports **task-template semantics**: completion, failure,
blocking reasons, current task step, terminal evidence, and optional low-volume
checklist timing. It is written by the worker into the task directory beside the
rendered `TASK.md`.

Runner-process telemetry belongs elsewhere. Turn boundaries, active tools,
statusline state, token usage, and high-volume command/tool events are emitted
through runner observability files such as `hooks.jsonl` and `statusline.json`
when a runner supports them. Do not put command transcripts, tool input payloads,
or per-command event streams in `SIGNAL.json`.

## File location

For a task directory such as `.task/fix/proj-123`, the terminal worker signal is:

```text
.task/fix/proj-123/SIGNAL.json
```

Role-specific workers may use sibling signal files such as
`SELF-REVIEW-SIGNAL.json`, `SELF-REVIEW-FIX-SIGNAL.json`, or
`CI-FIX-SIGNAL.json`. Those files use the same `WorkerSignal` shape but are
scoped to their role-specific task.

## Schema

```ts
interface WorkerSignal {
  role?: AgentRole;
  contextId?: string;
  status: 'running' | 'blocked' | 'complete' | 'failed' | 'done';
  outcome?: 'success' | 'failure' | 'partial';
  disposition?: 'fixed' | 'already_fixed' | 'not_reproducible' | 'blocked' | 'failed';
  evidence?: WorkerTerminalEvidence;
  checklistTiming?: WorkerSignalChecklistTiming;
  step?: string;
  reason?: string;
  prNumber?: number;
  timestamp: string;
}

interface WorkerTerminalEvidence {
  reportPath?: string;
  artifacts?: string[];
  confidence?: 'low' | 'medium' | 'high';
}
```

Workers must not hand-write `SIGNAL.json`. Use the `mark` helper only.

## Terminal commands

| Command                                                         | When to use                                                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `./mark complete [--mark-last]`                                 | Fix shipped or task finished successfully                                           |
| `./mark no-change --reason "…" [--already-fixed] [--mark-last]` | Bug already fixed or not reproducible after writing `artifacts/no-change-report.md` |
| `./mark blocked --reason "…" [--mark-last]`                     | Setup/env/precondition blocked the task                                             |

`mark` sets `status`, `outcome`, `disposition`, and `evidence.reportPath` for you.
For `no-change`, the report file must exist before the command succeeds.

### Packaged evidence enforced at terminal

On terminal success (`complete`, `no-change`), `./mark` validates worker-owned
artifacts before writing `SIGNAL.json`. The **expected files** are documented in
[Finish a worker run](worker-run-finish.md).

Typical checks:

| Check                                | `complete`                                       | `no-change`               | Waive              |
| ------------------------------------ | ------------------------------------------------ | ------------------------- | ------------------ |
| `artifacts/learnings.md` (non-empty) | yes                                              | yes                       | `--skip-learnings` |
| Flow worker report                   | `report.md` / `review.md` / `comments-report.md` | `no-change-report.md`     | —                  |
| Checklist all `[x]`                  | when `--mark-last`                               | when `--mark-last`        | `--skip-checklist` |
| Recipe artifacts                     | when `recipe.json` exists                        | when `recipe.json` exists | —                  |

Write **3–5 markdown bullets** on key learnings or struggles during the session.
When nothing relevant, one bullet is enough: `- Nothing relevant — straightforward run; no blockers or surprises.`

Projects may optionally declare overrides in `project.json` → `worker_terminal`
(see [ADR-045](https://github.com/deeeed/farmslot/blob/main/docs/adr/045-worker-terminal-contract.md)); the gateway
may also write `inputs/worker-terminal-contract.json` for a run. **Most teams
only need the finish checklist above.**

Orchestration consumers (retrospective, improvement engine, family readiness) read
the same artifact store documented in [ADR-026](https://github.com/deeeed/farmslot/blob/main/docs/adr/026-self-improvement-recursive-loop.md).

## Status and outcome matrix

| Status              | Terminal? | Meaning                                                                                    | Outcome rule                                                |
| ------------------- | --------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `running`           | No        | Worker is alive and reporting the current task step.                                       | Do not set `outcome` or `disposition`.                      |
| `blocked`           | Yes       | Worker cannot continue without a precondition, credential, environment, or human decision. | `outcome: partial`, `disposition: blocked`.                 |
| `complete` / `done` | Yes       | Worker finished the requested flow.                                                        | `outcome: success`, `disposition: fixed` or no-change path. |
| `failed`            | Yes       | Worker reached a terminal failure.                                                         | `outcome: failure`, `disposition: failed`.                  |

No-change terminal dispositions:

- `already_fixed`
- `not_reproducible`

Both require `evidence.reportPath` pointing at `artifacts/no-change-report.md`.

## Checklist timing extension

`checklistTiming` is optional metadata for low-volume progress analytics.

Farmslot-rendered tasks include a tiny `mark` helper beside `TASK.md`:

```bash
{{TASK_DIR}}/mark start
{{TASK_DIR}}/mark 1
{{TASK_DIR}}/mark 2
{{TASK_DIR}}/mark complete --mark-last
```

The gateway writes `checklist-target.json` beside `mark` when a nested-loop role
activates (self-review, self-review-fix, CI-fix). The manifest holds the active
checklist basename; the signal file is derived by convention (`SELF-REVIEW.md` →
`SELF-REVIEW-SIGNAL.json`, worker `TASK.md` → `SIGNAL.json`). The same `./mark`
command retargets automatically; templates never need role-specific wrapper scripts.

Override without editing the manifest:

```bash
{{TASK_DIR}}/mark --checklist SELF-REVIEW.md 1
{{TASK_DIR}}/mark --checklist SELF-REVIEW.md complete --mark-last
```

Example manifest during self-review:

```json
{
  "checklist": "SELF-REVIEW.md"
}
```

Legacy explicit paths remain supported for tooling:

```bash
node {{farmslot_dir}}/packages/agent-runtime/scripts/mark-checklist-step.cjs \
  {{TASK_DIR}}/SELF-REVIEW.md {{TASK_DIR}}/SELF-REVIEW-SIGNAL.json \
  complete --mark-last
```

## Freshness rules

A signal is considered fresh only when its `timestamp` is at or after the current
monitoring attempt's durable start floor. Gateway readers reject stale terminal
signals from earlier dispatches, reruns, or recovered monitor attempts.

New writers must always provide UTC ISO8601 timestamps.

## Minimal examples

Successful fix:

```json
{
  "status": "complete",
  "outcome": "success",
  "disposition": "fixed",
  "timestamp": "2026-06-25T10:05:00Z"
}
```

No-change exit:

```json
{
  "status": "complete",
  "outcome": "success",
  "disposition": "not_reproducible",
  "reason": "Bug does not reproduce with forced GC.",
  "evidence": {
    "reportPath": "artifacts/no-change-report.md"
  },
  "timestamp": "2026-06-25T10:05:00Z"
}
```

Blocked worker:

```json
{
  "status": "blocked",
  "outcome": "partial",
  "disposition": "blocked",
  "step": "validate",
  "reason": "Simulator is unavailable on the selected slot.",
  "timestamp": "2026-06-25T10:05:00Z"
}
```
