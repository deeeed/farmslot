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
  status: 'running' | 'blocked' | 'complete' | 'failed' | 'done' | 'done-partial';
  outcome?: 'success' | 'failure' | 'partial';
  disposition?: 'fixed' | 'already_fixed' | 'not_reproducible' | 'blocked' | 'failed';
  evidence?: WorkerTerminalEvidence;
  checklistTiming?: WorkerSignalChecklistTiming;
  step?: string;
  reason?: string;
  prNumber?: number;
  timestamp: string;
}

interface WorkerSignalChecklistTiming {
  schemaVersion: 1;
  source?: string;
  events: WorkerSignalChecklistEvent[];
}

interface WorkerSignalChecklistEvent {
  stepNumber: number;
  label: string;
  checkedAt: string;
}
```

Unknown additive fields are ignored by older readers. Required fields must keep
backward-compatible meaning.

## Status and outcome matrix

| Status              | Terminal?                          | Meaning                                                                                    | Outcome rule                                                |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `running`           | No                                 | Worker is alive and reporting the current task step.                                       | Do not set `outcome` or `disposition`.                      |
| `blocked`           | Yes for the current worker attempt | Worker cannot continue without a precondition, credential, environment, or human decision. | `outcome` may be `partial`; `disposition` may be `blocked`. |
| `complete` / `done` | Yes                                | Worker finished the requested flow.                                                        | `outcome` may be `success`; `disposition` may be `fixed`.   |
| `failed`            | Yes                                | Worker reached a terminal failure.                                                         | `outcome` may be `failure`; `disposition` may be `failed`.  |
| `done-partial`      | Legacy input only                  | Legacy blocked/partial spelling.                                                           | Gateway normalizes it to `blocked` + `partial`.             |

Evidence-backed no-code terminal dispositions are allowed for bugfix-style runs:

- `already_fixed`
- `not_reproducible`

Those dispositions require `evidence.noCodeChange: true` plus a report or artifact
path; `not_reproducible` also requires `evidence.reproductionAttempted: true`.

## Checklist timing extension

`checklistTiming` is optional metadata for low-volume progress analytics. Workers
may include it when their instructions ask them to record checklist timing, but a
missing field must never block completion.

Farmslot-rendered tasks include a tiny `mark` helper beside `TASK.md`. When the
worker begins the checklist (typically right after setting `STATUS: working`),
run `{{TASK_DIR}}/mark start` once to create a worker-owned `SIGNAL.json` with
`status: "running"` and `step: "started"`. This timestamp is the durable
"worker engaged" floor — distinct from gateway dispatch time.

After that, run `{{TASK_DIR}}/mark N` after completing checklist item `N`
(using the visible 1-based step number). If unsure, run `{{TASK_DIR}}/mark --help`.

For terminal completion, use `mark complete` — it merges into the existing
signal file and preserves `checklistTiming` history. Never truncate with
`echo > SIGNAL.json`:

```bash
{{TASK_DIR}}/mark complete --outcome success --mark-last
```

Role-specific signal files (`SELF-REVIEW-SIGNAL.json`, `CI-FIX-SIGNAL.json`,
etc.) use the same helper with an explicit task/signal path:

```bash
node {{farmslot_dir}}/packages/skills/scripts/mark-checklist-step.cjs \
  {{TASK_DIR}}/SELF-REVIEW.md {{TASK_DIR}}/SELF-REVIEW-SIGNAL.json \
  complete --outcome success --mark-last
```

Direct skill runs (consensys agentic skills) use `recipe-harness/scripts/mark-checklist-step.cjs`.
Farmslot gateway dispatch uses the same implementation mirrored in
`@farmslot/skills` at `scripts/mark-checklist-step.cjs` on the slot's farmslot
install. Keep the mirror in sync with recipe-harness when changing behavior.

Worker engaged (bootstrap, no checklist event yet):

```json
{
  "status": "running",
  "step": "started",
  "checklistTiming": {
    "schemaVersion": 1,
    "source": "TASK.md",
    "events": []
  },
  "timestamp": "2026-06-26T10:00:00Z"
}
```

Each progress event records the moment a checklist item changed from unchecked to checked:

```json
{
  "status": "complete",
  "outcome": "success",
  "step": "write-report",
  "checklistTiming": {
    "schemaVersion": 1,
    "source": "CHECKLIST.md",
    "events": [
      {
        "stepNumber": 1,
        "label": "Run focused validation",
        "checkedAt": "2026-06-25T10:00:00Z"
      },
      {
        "stepNumber": 2,
        "label": "Capture before/after evidence",
        "checkedAt": "2026-06-25T10:04:30Z"
      }
    ]
  },
  "timestamp": "2026-06-25T10:05:00Z"
}
```

Consumers derive per-step duration from event order and timestamps. `stepNumber`
matches the worker-facing `mark N` command, so agents and humans do not need
to translate between 1-based commands and zero-based indexes. `label` is copied
so analytics still makes sense if the markdown later changes.

Checklist timing must stay compact. If a run needs high-volume command/tool
telemetry, write a separate append-only observability stream and aggregate it
outside `SIGNAL.json`.

## Freshness rules

A signal is considered fresh only when its `timestamp` is at or after the current
monitoring attempt's durable start floor. Gateway readers reject stale terminal
signals from earlier dispatches, reruns, or recovered monitor attempts.

If `timestamp` is missing or unparsable, legacy readers may tolerate it for
compatibility, but new writers must always provide UTC ISO8601 timestamps.

## Compatibility policy

- Additive optional fields are allowed.
- Required fields and existing enum meanings must not be changed without a
  protocol version bump and migration plan.
- High-volume data, secrets, transcripts, and raw command/tool payloads do not
  belong in this file.
- `SIGNAL.json` remains task-owned even when runner hooks are available.
- Ongoing progress should remain visible in `TASK.md` or `CHECKLIST.md`; the
  signal file is the machine-readable terminal/summary channel.

## Minimal examples

Successful completion:

```json
{
  "status": "complete",
  "outcome": "success",
  "disposition": "fixed",
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

Failure with evidence:

```json
{
  "status": "failed",
  "outcome": "failure",
  "disposition": "failed",
  "reason": "Typecheck failed after implementation.",
  "evidence": {
    "reportPath": ".task/fix/proj-123/artifacts/report.md"
  },
  "timestamp": "2026-06-25T10:05:00Z"
}
```
