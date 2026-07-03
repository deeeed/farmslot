# Handover — Experimental Worker Session History Panel

> **For the implementing agent (Codex or other).** This worktree is isolated from the operator checkout (`~/dev/farmslot`). Read this file first, then redo your own analysis before writing code.

## Worktree identity

| Field | Value |
| ----- | ----- |
| Path | `~/dev/farmslot-worktrees/chat-interface-spike` |
| Branch | `spike/chat-interface` (tracks `origin/main` at creation; rebase onto latest `main` before PR) |
| Operator checkout | `~/dev/farmslot` — **do not edit**; sibling agents may be active there |
| This handover | `HANDOVER-worker-session-history.md` (this file) |

## What the previous agent did (Grok spike, 2026-07-02)

1. **Feasibility spike only** — no gateway/UI implementation in farmslot.
2. **Proposed ADR-047** (staged, commit may be pending): `docs/adr/047-worker-session-history-panel.md`
3. **Doc cross-links**: `docs/adr/README.md`, `docs/reference/adr-implementation-status.md`, `docs/ROADMAP-next.md`
4. **Private spike artifacts** (outside farmslot repo — MetaMask context, never commit to farmslot):
   - Report: `~/dev/metamask/principal-pitch-2025/06-farmslot/SPIKE-chat-interface.md`
   - Proof script: `~/dev/metamask/principal-pitch-2025/06-farmslot/transcript-to-chat.mjs`
   - Original goal: `~/dev/metamask/principal-pitch-2025/06-farmslot/goal_chat_interface_spike.md`

Treat the spike as **hypothesis**, not gospel. Your first deliverable is a **fresh analysis** on current `main`/this branch.

---

## Product intent (canonical)

**Primary goal:** Make **browsing worker agent history** cleaner than tmux scrollback.

Operators need to answer: what did the worker say, what tools ran, what was the last human nudge — without parsing ANSI noise, spinners, and statusline overlays.

| In scope (v1) | Out of scope (v1) |
| ------------- | ----------------- |
| Read-only, chat-shaped **history timeline** on active worker sessions | Farmslot-owned **API chat** as the worker (loses subscription-backed runners) |
| Tool calls as collapsed chips | Merging into Co-Pilot chat history |
| Experimental label + honest degraded states | Bidirectional chat composer (defer unless analysis proves easy) |
| Claude / Codex / Grok via runner JSONL | Cursor TUI full parity (no `runnerSessionPath` today) |

**Architecture constraint:** The tmux-launched runner CLI remains the single agent. The UI **projects** runner-owned transcripts — it does not start a parallel LLM session.

---

## Mandatory first step — redo analysis (Codex)

Before any implementation PR, produce a short **analysis note** in this worktree (suggested path: `docs/plans/worker-session-history-implementation-analysis.md`) that covers:

1. **Re-read ADR-047** and confirm or challenge its runner matrix and phasing.
2. **Trace live code paths** — verify these still match spike assumptions:
   - `run.metrics.runnerSessionPath` / `captureRunnerSessionMetadata`
   - `services/gateway/src/runners/session-process.ts` — session discovery
   - `services/gateway/src/runners/registry.ts` — per-runner `persistsSessionFiles`, `observabilityScope`
   - `scripts/session-usage.sh` — existing JSONL parsers (reuse patterns, do not duplicate token logic)
   - `services/gateway/src/runners/observability-files.ts` + ADR-032 hooks (`transcript_path`, turn boundaries)
3. **Run the external proof script** on a real Claude session if available:
   ```bash
   node ~/dev/metamask/principal-pitch-2025/06-farmslot/transcript-to-chat.mjs claude <path-to.jsonl> | head -20
   ```
4. **UI placement** — confirm slot-view tab vs run-detail embed; read `apps/command-center/ui/src/components/slot-view/`, `chat-message` components (reuse for rendering only, not Co-Pilot store).
5. **Protocol gap** — propose exact RPC/event names and `@farmslot/protocol` types.
6. **Risks / kill criteria** — restate when to stop (wrong turn order, schema churn, Cursor-only fleets).
7. **Effort estimate** for v1 read-only only.

**Stop and ask the operator** if analysis concludes transcript mirroring is not viable for the runners Arthur actually uses day-to-day.

Do not skip analysis to start coding.

---

## Implementation guide (after analysis approved)

### Phase 1 — v1 read-only history (target)

1. **Protocol** — add types + methods, e.g.:
   - `worker.session.history.get` — snapshot for slot/worker context
   - `worker.session.history.subscribe` / events — append deltas on transcript growth or hook turn-boundary
   - `WorkerSessionHistorySnapshot` per ADR-047 shape (`source: transcript | pane-degraded | unavailable`)

2. **Gateway** — new module (suggested: `services/gateway/src/worker-session-history/`):
   - Resolve path from active `AgentContext` or run metrics
   - Parser per runner (lift from proof script + `session-usage.sh` semantics)
   - Filter noise: hooks, `system-reminder`, `environment_context`, attachments
   - Collapse tool calls to chips
   - **No LLM calls**

3. **Command Center UI** — experimental **History** tab sibling to Terminal on slot view:
   - Reuse `chat-message` visual patterns; **do not** wire to `chat.send` / Co-Pilot store
   - Show `experimental` badge + `source` / `degradedReason`
   - CDP validation required (`apps/command-center/CLAUDE.md`)

4. **Feature flag** — env or config gate, e.g. `FARMSLOT_EXPERIMENTAL_WORKER_HISTORY=1`

### Phase 2 — defer unless operator asks

- Search within thread
- Run-detail embed
- Mobile companion read-only
- Idle-gated input → existing `terminal.send`

---

## Key code anchors (start here)

```
services/gateway/src/runners/session-process.ts      # listRunnerSessionFiles, resolveRunnerSessionBinding
services/gateway/src/runners/session-path-resolution.ts
services/gateway/src/runners/registry.ts             # persistsSessionFiles, observabilityScope per runner
services/gateway/src/runtime/session-usage.ts        # RUNNER_SESSION_PATH env pattern
scripts/session-usage.sh                           # Claude/Codex/Grok JSONL field knowledge
services/gateway/src/methods/terminal.ts             # terminal.send (phase 2 only)
services/gateway/src/chat/chat-engine.ts             # Co-Pilot — DO NOT merge worker history here
apps/command-center/ui/src/components/chat/chat-message.ts
apps/command-center/ui/src/components/slot-view/     # tab placement
packages/protocol/src/methods.ts                   # add new methods here first
```

---

## Hard rules (farmslot)

Read `CLAUDE.md` in repo root. Non-negotiable for this task:

- **Never commit to `main`** — branch `feat/worker-session-history` or continue `spike/chat-interface`; open PR to `deeeed/farmslot`.
- **No MetaMask content** in farmslot commits (generic only).
- **No gateway API chat for workers** — transcript projection only.
- **Validate UI via CDP**, not typecheck alone.
- **Dev stack:** `cd apps/command-center && yarn farmdev` from **this worktree** after `yarn install --immutable` at repo root.
- **Arthur's machine:** operator gateway **7801** (not 7777) — `source ~/dev/farmslot/dev.env`; do not kill Arthur's running gateway/tmux sessions.
- **Review:** `/review` + cross-model review before merge suggestion.
- **Conventional Commits** for all commits.

---

## Acceptance criteria (v1)

- [ ] Analysis doc committed in this worktree before implementation commits
- [ ] ADR-047 status updated to **Accepted** (or analysis documents proposed amendments) in same PR series
- [ ] Read-only history renders real user/assistant turns for at least one live Claude slot (CDP screenshot/evidence)
- [ ] Tool calls visible as collapsed chips, not raw JSONL
- [ ] Panel labeled **experimental**; unavailable/degraded for Cursor TUI is explicit, not broken empty state
- [ ] Worker history does not appear in Co-Pilot session store
- [ ] `yarn typecheck` in `apps/command-center` passes
- [ ] No swallowed exceptions; no UI state injection to fake outcomes

---

## Suggested git workflow for implementing agent

```bash
cd ~/dev/farmslot-worktrees/chat-interface-spike
yarn install --immutable   # required once per fresh worktree
git fetch origin && git rebase origin/main   # before heavy work
git checkout -b feat/worker-session-history   # optional rename from spike/chat-interface

# 1) analysis commit
# 2) implementation commits
# 3) open PR — do not merge without review
```

---

## Open questions (resolve in analysis)

- Subscribe via gateway file watch vs polling node for remote slots
- Message cap for very long sessions (last N turns vs full replay)
- Whether to expose history on run-detail or only slot-view
- Exact experimental flag mechanism (env vs `#config`)

---

## Contact / escalation

If transcript paths are routinely wrong vs tmux, or Claude JSONL schema changed materially, **stop** and report — per ADR-047 kill criteria.

_Last updated: 2026-07-02 — Grok spike + handover for Codex implementation._