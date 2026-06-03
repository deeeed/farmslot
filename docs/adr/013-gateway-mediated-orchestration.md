# ADR-013: Gateway-Mediated Orchestration

**Status:** Proposed
**Date:** 2026-03-27
**Relates to:** [ADR-001](001-gateway-architecture.md), [ADR-005](005-state-persistence.md), [ADR-008](008-remote-communication.md), [PRD](../PRD-command-center-canonical.md) — Feature Category I

## Context

Orchestration currently lives in ephemeral Claude Code skills (`/farm-fix`, `/farm-review`, `/farm-monitor`). These skills coordinate the full dispatch lifecycle — grading, slot selection, branch setup, task writing, dispatch, monitoring, and completion — but they are session-bound:

- **Skills die with session.** Monitor crons die when the orchestrator Claude Code session exits. If a worker finishes while the orchestrator is down, the slot stays `working` forever. `/farm-resume` exists solely to recover from this.
- **No run history.** Each dispatch is a conversation fragment — no structured record of what happened, how long it took, what decisions were made.
- **No persistent monitoring.** `farm-monitor` skill spawns a background loop, but it's tied to the Claude Code session. Gateway restarts don't affect it; session restarts kill it.
- **Invisible orchestrator.** Workers are observable (terminal, TASK.md progress, device feed) but the orchestrator is invisible — it's a Claude conversation with no UI presence.

The gateway already has the plumbing: `dispatch.execute`, `slot.prepare`, `slot.release`, task watching (M10). But it doesn't own the workflow — it executes individual steps on demand from the CLI/UI.

The PRD describes this vision (B1 Dispatch Wizard, F3 Server-Side Monitoring) but lacks a unified orchestration model.

**Reference:** OpenClaw uses this exact pattern — gateway IS the orchestrator. Sessions, lifecycle, persistence, result delivery all live in the gateway process.

## Options Considered

### A. Keep Skills as Orchestrator (status quo)

Skills (`/farm-fix`, `/farm-review`, etc.) remain the orchestration layer. Gateway stays as a step executor.

**Pros:**

- Works today
- Claude intelligence available for complex decisions (ambiguous tickets, edge cases)
- No new code needed

**Cons:**

- Session-bound — monitor dies on exit, slots go stale
- No run history or analytics
- No persistent monitoring
- Orchestrator invisible to UI
- Context window accumulation → compaction → state loss → `/farm-resume`

### B. Gateway as Full Orchestrator (OpenClaw pattern)

Gateway owns the workflow state machine. Each dispatch is a "Run" with lifecycle states, step history, and metrics. Claude API for intelligence steps (grading, task writing).

**Pros:**

- Persistent — survives gateway restarts (reload from `.runs/`)
- UI-driven — run progress visible in real time
- Run history with metrics (duration, nudges, cost)
- Monitoring is gateway-resident, not session-bound
- No context window — state machine + stateless API calls
- Enables analytics and pattern analysis

**Cons:**

- Significant implementation effort (state machine, Claude API integration, UI)
- Intelligence delegation needs Claude API key and structured prompts
- Jira/GitHub data fetching needs native API clients (currently uses MCP tools in skills)

### C. Hybrid: Gateway State Machine + Orchestrator Claude Session

Gateway tracks state and handles mechanical steps. Claude Code session handles intelligence (grading, task writing, ambiguous decisions).

**Pros:**

- Gateway tracks state persistently
- Claude session handles complex decisions naturally
- Incremental migration from status quo

**Cons:**

- Still session-dependent for intelligence steps
- Two systems to coordinate — state can diverge
- Doesn't eliminate the stale-slot problem for intelligence-gated steps

## Decision

**Option B — Gateway as Full Orchestrator.**

M10 already ported core lifecycle to gateway TypeScript. The remaining gap is workflow coordination (which step → which order → what if blocked). This is a state machine, not AI. Intelligence tasks (grading, task writing, review summary) are structured enough for single-shot Claude API calls — no conversation history needed.

### Key Design Elements

**Run Model** — mirrors OpenClaw sessions. A `Run` represents one task dispatched to one slot, with:

- UUID, flow type (fix/review/feature/pr-complete), creation time
- Lifecycle states with timestamps
- Step history (each step: name, status, duration, output)
- Decision queue (pending decisions for this run)
- Metrics (duration, nudges, model, cost estimate)
- Persisted to `.runs/{id}.json`

**State Machine** — per flow type. Gateway advances automatically, pauses at decision points.

```
fix:     created → grading → slot-finding → preparing → dispatching → monitoring → completing → done
review:  created → slot-finding → preparing → dispatching → monitoring → completing → done
feature: created → slot-finding → preparing → dispatching → monitoring → completing → done
```

Additional states: `blocked` (decision needed), `failed` (unrecoverable error), `cancelled` (user abort).

**Intelligence Delegation** — Claude API (Anthropic SDK) for structured tasks:

- _Grading:_ ticket description + context → difficulty score, rationale, model recommendation
- _Task writing:_ template + ticket + context → TASK.md content
- _Review summary:_ diff + comments + test results → structured review

Each is a single API call with structured input/output. No conversation history, no spawned sessions.

**Persistent Monitoring** — `RunMonitor` replaces `farm-monitor` skill. Same violation detection logic (stuck, idle, skipped step), gateway-resident. Nudges via tmux send-keys. Survives gateway restarts by reloading active runs from `.runs/`.

**Decision Queue** — replaces `.pending_decision.json` filesystem polling. Gateway-resident, in-memory + persisted. Real-time WebSocket push to UI. Each decision belongs to a Run and blocks state machine advancement until resolved.

**Completion Pipeline** — gateway runs post-work steps as part of the state machine:

- Artifact archival (copy from worker repo to run directory)
- PR comment posting (gateway-native)
- PR body sanitization (strip local paths, auto-check author checklist)
- Retrospective curation (queue for UI)
- Metrics finalization

**Storage** — JSON flat files: `.runs/{id}.json`. OpenClaw uses the same pattern (`sessions.json` + per-session JSONL). Farmslot volume is ~10-50 runs/week. `RunStore` with in-memory cache + atomic writes. 30-day auto-prune + archival for old runs.

### Orchestrator Observability

The gateway state machine IS the orchestrator. This means:

- **Run progress = orchestrator progress.** Every state transition emits events. The Run Dashboard renders them as a step timeline.
- **Sub-step streaming.** Existing gateway methods already emit sub-step events (e.g., `slotPrepare()` emits SSH check, device boot, fixture sync). These feed directly into the run's step detail view.
- **Decision visibility.** When the state machine pauses, the UI shows it instantly. No more "is the orchestrator stuck or just waiting?"
- **Parallel run visibility.** Multiple active runs shown side-by-side.
- **Historical comparison.** Past runs show full step timelines with durations.

### Context Window Elimination

Current problem: orchestration is a long Claude conversation → context accumulates → compaction loses state → `/farm-resume` recovers.

M11 solution: orchestrator is a TypeScript state machine.

- Run state in `.runs/{id}.json` — no context window, no compaction, no memory loss
- Gateway restart = reload from disk, continue exactly where stopped
- Claude API calls are stateless single-shot requests — no conversation history needed
- Workers still use Claude Code sessions, but their external state (TASK.md) already survives compaction

## Consequences

**Positive:**

- Persistent orchestration — no stale slots, no `/farm-resume`
- UI-driven — dispatch, monitor, and complete tasks from the browser
- Run history with metrics — duration, nudges, cost per run, outcome
- Monitoring survives gateway restarts (reload active runs from `.runs/`)
- Orchestrator gets the same observability treatment as workers
- No context window constraints on orchestration logic

**Negative:**

- Claude API integration adds a dependency (API key, rate limits, cost)
- `farm-fix`, `farm-review`, `farm-monitor` skills become deprecated
- Intelligence delegation needs carefully crafted prompts for grading/task-writing quality

**Risks:**

- Jira data fetching currently uses MCP tools in skills — gateway needs native Jira API client or MCP tool proxy
- Grading quality via single-shot API may differ from interactive skill (mitigate: structured prompts with examples, calibration against skill outputs)
- State machine complexity for edge cases (partial failures, retries, manual intervention)

**Migration:** Coexistence during rollout. Skills and gateway state machine operate on different slots simultaneously. No big-bang cutover. Skills become `farmslot run fix <ticket>` CLI commands (M10.6 CLI convergence) that call gateway methods.
