# Worker Session History Implementation Analysis

**Status:** approved v1 implementation plan  
**Supports:** [ADR-047](../adr/047-worker-session-history-panel.md), [ROADMAP-next](../ROADMAP-next.md)  
**Date:** 2026-07-03

## Summary

Go for v1. Transcript mirroring is viable for the day-to-day transcript-backed
runners, with an explicit degraded/unavailable state for Cursor TUI and other
non-persisted runners. The implementation should remain a read-only projection
of runner-owned transcripts; it must not create a gateway LLM/API chat worker
or merge worker turns into Co-Pilot session storage.

Current-code adjustments from the handover:

- Protocol methods now live under `packages/protocol/src/rpc/*`; there is no
  `packages/protocol/src/methods.ts`.
- Runner-specific parsing must be hidden behind the runner abstraction under
  `services/gateway/src/runners/`, matching the Command Center rule against
  inline runner checks outside the runner layer.
- Slot view already has a bottom panel tab strip; v1 should add a `History`
  tab beside `Terminal`, `Problems`, and `Comments`, using the selected agent
  context for role/context targeting.

## Runner Matrix

| Runner     | Source                                                                                                                 | v1 quality             | Notes                                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude     | `~/.claude/projects/.../*.jsonl`, preferably from `transcript_path` hook or `runnerSessionPath`                        | Full                   | Must filter `attachment`, `file-history-snapshot`, meta/local-command caveats, tool results, and thinking-only rows. Tool uses become chips. |
| Codex      | Per-slot `codex-home/sessions/**/rollout-*.jsonl`, falling back to `~/.codex/sessions` only through existing discovery | Full                   | Must filter developer/system/environment context, reasoning, function outputs, and token-count events. `function_call` rows become chips.    |
| Grok       | `~/.grok/sessions/<cwd>/<session>/chat_history.jsonl` from existing session directory discovery                        | Good                   | Parser should accept session directory or file path and filter `system-reminder` / `user_info` noise. No hook-driven turn boundary today.    |
| Cursor TUI | None persisted by runner registry                                                                                      | Unavailable / degraded | `persistsSessionFiles: false`; do not fake chat from tmux pane scrollback in v1. Show clear copy directing operator to Terminal.             |

The registry confirms Claude, Codex, and Grok persist session files, while Cursor
does not. `session-process.ts` already resolves bindings from ADR-032 hooks and
filesystem discovery. `session-path-resolution.ts` preserves the right
precedence for hook, existing path, fresh path, and dispatch-time slack.

## Proof Check

The private proof script was run read-only against a real Claude transcript:

```bash
node /Users/deeeed/dev/metamask/principal-pitch-2025/06-farmslot/transcript-to-chat.mjs claude \
  /Users/deeeed/.claude/projects/-Users-deeeed-dev-farmslot/a232105b-fe61-49e6-923d-3b0c59a1d186.jsonl | head -5
```

It emitted user/assistant/tool-shaped rows, proving the basic projection. It
also exposed two implementation requirements:

- The proof output includes local command caveats, `/clear`, meta skill prompts,
  and tool result payloads unless the v1 parser filters them.
- The throwaway script exits with `EPIPE` when piped to `head`; production code
  should be implemented in TypeScript without inheriting that stream behavior.

No real Claude session was found under the isolated worktree path during this
analysis. Live acceptance must be validated on an active Claude worker before
claiming the UI criterion.

## Protocol and Gateway Plan

Add protocol surface:

- `worker.session.history.get`
- `worker.session.history.subscribe`
- `worker.session.history.unsubscribe`
- event `worker.session.history.delta`

Snapshot shape:

- target: `slotId`, optional `runId`, `role`, `contextId`
- identity: `runner`, `runnerSessionPath`, `runnerSessionId`
- quality: `source: 'transcript' | 'pane-degraded' | 'unavailable'`,
  `degradedReason`
- data: ordered messages, tool chips, cursor, `truncated`
- default cap: last 300 messages, hard max 1000

Gateway implementation should:

- Resolve path from selected `AgentContext.runnerSessionPath`, then linked run
  `metrics.runnerSessionPath`, then existing hook/filesystem binding.
- Reuse `session-usage.sh` field knowledge without duplicating token/cost logic.
- Keep parser/provider code under `services/gateway/src/runners/`.
- Keep the RPC method handler thin, likely in `services/gateway/src/methods/`.
- Use file stat/size polling only while clients are subscribed; emit appended
  messages and reset the client when the file rotates or truncates.
- Throw real errors for unexpected failures; return `unavailable` only for
  expected no-source runner states.
- Avoid all Co-Pilot chat paths, especially `chat.send`, the Co-Pilot session
  store, and `services/gateway/src/chat/chat-engine.ts`.

## UI Plan

Add an experimental History tab to the slot-view bottom panel:

- hidden unless gateway capability/flag says enabled
- same height and resize behavior as Terminal
- selected role/context follows the existing agent context selector
- show runner, source, transcript path when known, and degraded reason when not
- render messages with existing `chat-message` visual language or a focused
  wrapper, but never write into Co-Pilot session state
- no composer, no input box, no run-detail embed, no mobile UI in v1

Feature flag: `FARMSLOT_EXPERIMENTAL_WORKER_HISTORY=1`. The gateway should expose
the flag in `gateway.status` so the UI does not need a separate Vite build-time
flag.

## Risks and Kill Criteria

Main risks:

- Runner JSONL schema drift can silently degrade fidelity.
- Wrong transcript binding is worse than no panel; source/path must be visible.
- Very long sessions can be expensive to parse; v1 must cap replay and keep
  subscribe incremental.
- Cursor-heavy fleets will see unavailable states often.

Stop or freeze per ADR-047 if transcript order is routinely wrong vs tmux,
tail lag is unacceptable beyond short polling delays, runner schema churn is
too high, or operators keep preferring terminal-only history review.

## Effort Estimate

Read-only v1 is roughly 2-4 focused days:

- analysis and protocol: 0.5 day
- parsers/resolver/RPCs/subscription: 1-1.5 days
- slot-view UI: 0.5-1 day
- tests, typecheck, CDP proof, and review fixes: 1 day

Go/no-go: go for transcript-backed read-only v1, with Cursor unavailable and
all input/composer behavior deferred.
