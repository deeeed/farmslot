# ADR-047: Experimental Worker Session History Panel

**Status:** Accepted (experimental)
**Date:** 2026-07-02

## Context

Farmslot workers run in tmux via subscription-backed runner CLIs (Claude, Codex, Cursor, Grok). That preserves engineer-controlled execution, tool/MCP wiring, and **subscription economics** — the runner is the agent, not a farmslot-owned API call.

The downside is **history UX**: tmux scrollback is noisy (ANSI, spinners, tool dumps, statusline overlays), hard to search, and poor on mobile. Operators who do not live in tmux struggle to answer basic questions: _what did the worker already try? what was the last user nudge? which tools ran?_

Farmslot already captures durable session pointers on runs (`runnerSessionId`, `runnerSessionPath` in `run.metrics`; hook-driven `transcript_path` for Claude/Codex per [ADR-032](032-runner-observability-via-hooks.md)). Token usage extraction already parses runner-owned JSONL ([runner token usage reference](../reference/runner-token-usage.md)). Nothing yet **renders** that material as a readable conversation timeline in Command Center.

This is **not** the same problem as [ADR-016](016-d9-copilot.md) Co-Pilot (fleet LLM chat + suggested actions). Co-Pilot answers orchestration questions; this ADR is about **browsing a specific worker's turn history** more cleanly than raw terminal scrollback.

A 2026-07 feasibility spike concluded the approach is viable for Claude/Codex/Grok via transcript tailing; Cursor TUI remains degraded (pane-only) until a structured session source exists. Spike artifacts live outside this repo (operator-private notes); this ADR records the decision to try implementation.

**Experimental posture:** We may ship this behind an explicit experimental flag and remove it if adoption or fidelity is poor. The decision here is _worth trying_, not _committed product surface forever_.

## Decision

### Primary goal — cleaner history browsing

The **main user value** is a **read-only, chat-shaped timeline** of worker turns on active sessions and recent runs:

- User and assistant messages in order
- Tool calls collapsed to compact chips (expand on demand)
- System/hook noise filtered (not hidden in tmux, but not shown by default)
- Search/jump within the session thread

Tmux remains the power-user surface for live control and full fidelity. The history panel is an **on-ramp and review lens**, not a replacement for the terminal.

### Non-goal — farmslot API chat as worker

Do **not** implement worker interaction by calling model APIs from the gateway for this feature. That would:

- Bypass subscription-backed runners and shift cost to API metering
- Fork execution semantics (permissions, MCP, hooks, runner tools)
- Create two agents (tmux worker + web chat) that can diverge

The worker process started at dispatch remains the single source of truth. The panel **projects** runner-owned transcripts (and degraded pane snapshots when no transcript exists).

### Surface placement

Add an **experimental** panel on active worker sessions — sibling to the existing terminal, not merged into Co-Pilot:

| Surface                    | Scope                                                           |
| -------------------------- | --------------------------------------------------------------- |
| Slot view (active worker)  | **Terminal** \| **History** tab (experimental)                  |
| Run detail (terminal runs) | Link or embedded history when `runnerSessionPath` is known      |
| Mobile companion           | Optional later — same gateway projection, not a separate parser |

Label copy should say **experimental** and explain degraded modes honestly (e.g. Cursor pane-only: "terminal-accurate history unavailable — use Terminal tab").

### Data contract (gateway-owned projection)

Introduce a gateway projection (protocol types TBD in implementation PR) roughly shaped as:

```ts
WorkerSessionHistoryMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  tools?: { name: string }[];
  at?: string; // ISO timestamp when known
}

WorkerSessionHistorySnapshot {
  slotId: string;
  contextId?: string;
  runId?: string;
  runner: string;
  source: 'transcript' | 'pane-degraded' | 'unavailable';
  runnerSessionPath?: string;
  messages: WorkerSessionHistoryMessage[];
  degradedReason?: string;
}
```

**Live updates:** tail transcript append + hook turn-boundary refresh ([ADR-032](032-runner-observability-via-hooks.md)). Do not poll `capture-pane` for message bodies when a transcript path is available.

**Runner matrix (v1 expectations):**

| Runner             | History source                                    | v1 quality                   |
| ------------------ | ------------------------------------------------- | ---------------------------- |
| Claude             | `~/.claude/projects/.../*.jsonl` + hooks          | Full                         |
| Codex              | per-slot `codex-home/sessions/**/rollout-*.jsonl` | Full                         |
| Grok               | `~/.grok/sessions/.../chat_history.jsonl`         | Full (with noise filters)    |
| Cursor TUI         | none persisted                                    | Degraded / unavailable       |
| Headless `--print` | stdout/json artifact if captured                  | Artifact-only, not live chat |

### Secondary goal — input (deferred, optional)

Sending text from the history panel is **out of v1 scope** unless explicitly promoted after read-only fidelity is proven. If added later, it must route through existing `terminal.send` / tmux `send-keys` with runner busy gating ([ADR-023](023-runner-agnostic-tui-execution.md)) — never a parallel API session.

### Separation from Co-Pilot

- Do not append worker turns into Co-Pilot `sessions/*.json`.
- Do not use the fleet LLM to summarize worker history in v1 (adds cost and hallucination risk).
- Session namespace example: worker history keyed by `slotId` + worker `contextId` / `runId`, distinct from `slot:<id>` Co-Pilot scopes in ADR-016.

### Kill criteria (when to remove or freeze)

Stop investing and hide the panel if any of these hold after a reasonable trial:

- Claude/Codex/Grok history is routinely **wrong or stale** vs tmux (>5s tail lag is OK; wrong turn order is not)
- Operators still prefer terminal-only for history review in user feedback
- Maintenance burden from runner JSONL schema churn exceeds value
- Cursor/degraded paths dominate supported runners and the panel feels broken more often than helpful

## Consequences

### Positive

- Lower TUI barrier for PMs and engineers who need **read-only oversight**
- Reuses existing `runnerSessionPath` and hook infrastructure — no new agent runtime
- Preserves subscription-backed runner economics
- Composes with gate-held sessions ([ADR-038](038-gate-held-worker-session.md)) — history remains inspectable while tmux worker stays alive

### Negative / risks

- Runner vendors can change JSONL shapes without notice — parser maintenance
- Two surfaces (tmux + history) can confuse operators if copy is weak
- Cursor TUI gap may make "experimental" feel half-baked until upstream session files exist
- Must not imply chat parity with ChatGPT/Cursor native UIs — this is a **projection**, not the product's chat engine

### Implementation phases (guidance, not commitment)

1. **v1 — read-only history** on slot view for transcript-backed runners; CDP-validated
2. **v1.1 — run-detail + search** within thread; mobile read-only if cheap
3. **v2 — idle-gated nudge** from history composer only if v1 proves useful (optional)

## Related

- [ADR-002](002-tmux-streaming.md) — terminal streaming (complementary, not replaced)
- [ADR-010](010-slot-view-layout.md) — slot view hosts the experimental tab
- [ADR-016](016-d9-copilot.md) — fleet Co-Pilot stays separate
- [ADR-023](023-runner-agnostic-tui-execution.md) — TUI-first execution unchanged
- [ADR-032](032-runner-observability-via-hooks.md) — live correlation via hooks
- [PRD-command-center-canonical.md](../PRD-command-center-canonical.md) — operator surfaces
- [PRD-runner-execution-canonical.md](../PRD-runner-execution-canonical.md) — runner session metadata

## Open questions

- Exact protocol method names (`worker.session.history` vs extending `terminal.*`) — resolve in implementation PR
- Whether run-detail embeds history inline or deep-links to slot view — UX choice during v1
- Retention: full session vs last N turns for very long runs — default cap TBD
