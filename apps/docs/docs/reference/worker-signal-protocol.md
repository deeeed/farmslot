---
title: Worker signal protocol
---

# Worker signal protocol

`SIGNAL.json` is the worker-owned task signal file. It gives Farmslot a
runner-neutral way to observe terminal task state without parsing Claude, Codex,
Cursor, Grok, or shell output.

The canonical protocol type is `WorkerSignal` in
`packages/protocol/src/transport/signal.ts`. This page is the reader-facing
contract for task templates, project integrations, and UI/API consumers.

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

Role-specific signal files use the same helper with an explicit task/signal path:

```bash
node {{farmslot_dir}}/packages/skills/scripts/mark-checklist-step.cjs \
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
