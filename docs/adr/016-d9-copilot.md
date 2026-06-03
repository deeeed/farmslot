# ADR-016: D9 Co-Pilot — Fleet OS Observer + Conversational Interface

**Status**: Accepted
**Date**: 2026-03-29

## Context

The command center manages 12+ slots and dozens of runs. Operators context-switch between views to answer basic questions. The gateway already holds all relevant state — fleet, runs, diffs, task progress, decisions — but none of it is surfaced proactively or conversationally.

The original D9 PRD described a simple "chat panel that asks the gateway questions." During implementation, the design evolved into something more fundamental: the gateway as an always-on fleet OS, with the chat interface as one window into it.

## Decision

### Two-layer architecture

**Layer 1 — Gateway observer (always-on, no user interaction required)**

`CopilotObserver` wraps `broadcastEvent` at the `index.ts` level. Every event that passes through the gateway is inspected passively. Significant events (run failures, pending decisions, monitor violations) are:

1. Logged to an in-memory rolling event log (capped at 200 entries)
2. Converted to system `ChatMessage` objects and appended to the default session
3. Broadcast to connected UI clients as `CHAT_RESPONSE { state: 'notification' }`

This layer runs without LLM calls, without user interaction, and never blocks the gateway. If it throws, errors are caught and logged — the event broadcast continues unaffected.

#### 2026-05-02 refinement — observer state must stay separate from operator chat

The original D9 implementation appended observer notifications into the default chat session. That was acceptable for the first conversational surface, but it is not the long-term contract. The gateway observer is the always-on orchestration awareness layer; operator chat sessions are user-driven workspaces. They must not share one mutable conversation history by default.

The refined contract is:

- The observer owns a durable event/annotation stream: recent fleet events, run/family annotations, alert summaries, and recommended operator attention.
- Operator chat sessions are scoped conversations, not the observer's memory. They may read observer summaries and event evidence, but ad hoc operator questions must not pollute the observer state.
- Observer output should be exposed as typed evidence to Co-Pilot and the UI, not injected as raw system messages into whichever chat session happens to be active.
- User chat sessions should support stable scopes such as `global`, `family:<id>`, `run:<id>`, `slot:<id>`, and explicit ad hoc sessions. The current screen can select the default session, while the operator can switch sessions manually.
- Reads and diagnosis may use the observer stream plus typed gateway tools autonomously. Writes, restarts, terminal sends, run cancellation, memory mutation, and other side effects remain explicit operator-confirmed actions.

The existing default-session notification behavior should therefore be treated as transitional compatibility, not as the architecture to preserve.

**Layer 2 — Conversational interface (user-driven)**

On each `chat.send`, the gateway:

1. Loads `SOUL.md` (agent identity) + `MEMORY.md` (persistent facts) from the copilot workspace
2. Builds fresh fleet context: slot table + active runs + pending decisions + recent event log (last 2h from the observer)
3. Injects prior conversation turns into the system prompt (pi-ai `completeSimple` doesn't accept raw AssistantMessage history, so history is injected as a `## Prior Conversation` block)
4. Calls `callLLMChat()` with real streaming via pi-ai `streamSimple` — `text_delta` events are broadcast as they arrive
5. Parses `<actions>[...]</actions>` from the response — stripped from display text, returned as `suggestedActions[]`
6. Appends both user and assistant messages to the session store (debounced JSON persistence)

### Identity and memory (OpenClaw pattern)

```
{farmslotRoot}/copilot/        ← dev default (gitignored sessions/, tracked SOUL+MEMORY)
  SOUL.md                      ← permanent identity: who the agent is, how it operates
  MEMORY.md                    ← accumulated facts, fleet notes, user preferences
  memory/{date}-{slug}.md      ← session summaries written on /new
  sessions/{id}.json           ← full conversation history (JSON, gitignored)
```

`FARMSLOT_COPILOT_DIR` env var overrides the workspace root (prod: `~/.farmslot/copilot`).

`SOUL.md` is injected first in the system prompt, before memory and fleet context. It defines the agent's operating principles and is tracked in git — evolves deliberately, not automatically.

`MEMORY.md` accumulates through `memory.update` action cards confirmed by the operator. The agent can suggest updates; it cannot write them autonomously.

### Action model

LLM suggests, user confirms. Actions are structured JSON embedded in `<actions>` tags:

```json
[
  {
    "type": "run.create",
    "label": "Dispatch PROJ-2483",
    "params": {
      "ticket": "PROJ-2483"
    }
  }
]
```

Supported: `run.create`, `run.cancel`, `terminal.send`, `decision.resolve`, `memory.update`.

UI renders confirm cards. On confirm, the UI calls the gateway method directly. No autonomous execution in v1.

### Model configuration

Default: `anthropic/sonnet`. Override via `COPILOT_PROVIDER` / `COPILOT_MODEL` in `.env`. Logged on startup.

## Consequences

**Positive:**

- The gateway is now an OS-level observer — it knows what happened even when the operator isn't looking
- Notification badge on `✦` surfaces fleet problems without requiring the operator to poll views
- Fleet context is always fresh (rebuilt per message from live state + rolling event log)
- SOUL + MEMORY give the agent persistent identity that improves over time
- Real token streaming (pi-ai `streamSimple`) — UI shows text appearing word-by-word
- Fully backward-compatible: observer is passive, chat methods are isolated, no existing code modified

**Trade-offs:**

- Multi-turn history is injected into system prompt (not native pi-ai message format) — token overhead grows with conversation length
- Transitional default-session notifications can still accumulate system messages until the observer stream is fully separated from operator chat history
- Observer only sees events that pass through `broadcastEvent` — direct DB writes or bash-script state changes are invisible

## Out of Scope (deferred)

- **D9.2** — Compaction detection: monitor tmux for Claude's context compression message, auto-nudge workers
- **v1.1** — Run history tools: `search_runs`, `read_task_file`, `check_pr` — added to close collision context gap
- **v1.2** — Observer/chat separation: move observer notifications out of default chat history, expose them as typed event evidence, and add scoped chat session selection
- **v2** — Autonomous tool-use (execute actions without confirm)
- **v2** — Vector/semantic memory search (OpenClaw uses SQLite+embeddings)
- **v2** — Native multi-turn message history (requires pi-ai AssistantMessage reconstruction)
