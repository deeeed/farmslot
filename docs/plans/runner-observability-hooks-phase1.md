# PRD: Runner Observability Hooks Phase 1

**Status:** Shipped (code + gates); fleet agreement NDJSON collection continues on opt-in slots
**Date:** 2026-05-22
**Relates to:** [ADR-032](../adr/032-runner-observability-via-hooks.md), [ROADMAP-next](../ROADMAP-next.md), [ADR-023](../adr/023-runner-agnostic-tui-execution.md), [ADR-027](../adr/027-unified-gateway-state.md)

## Problem

Farmslot currently infers runner state from tmux pane text. That is operationally useful but brittle for Claude Code because the TUI text changes across Claude upgrades and local statusline/HUD overlays. The 2026-05-21 mm-3 nudge regression came from this class: the worker was composing, the pane regex did not recognize the spinner, and a nudge timed out instead of being queued safely.

ADR-032 defines the long-term architecture: Farmslot-owned hook/statusline scripts emit structured runner events under the slot runtime dir, while pane scraping remains a fallback. This PRD sizes Phase 1 so implementation can start without expanding scope into a full pane-regex retirement.

## Goal

Ship a telemetry-only Claude runner observability path that proves hook events can be collected, correlated to the tmux pane/slot, and compared against existing pane-derived readings without changing nudge behavior yet.

## Runner validation harness (shipped with PR #81 closeout)

Per-runner tmux scenarios live in `scripts/runner-validation/` (see [operations/runner-validation-harness.md](../operations/runner-validation-harness.md)):

- `hook-smoke`, `prompt-accepted`, `turn-boundary` — Claude/Codex live tmux + hooks.jsonl
- `pane-smoke` — Cursor/Grok print-mode launch + pane marker
- `interaction-smoke` — Grok interactive TUI + project-directory + compose submit
- `busy-composer` — Claude pane fixtures
- `mode-switch` — Claude bypass permission mode

Run: `node scripts/runner-validation/run.mjs --runner all --scenario all`

Evidence: `docs/operations/evidence/runner-validate-<host>-<runner>-<scenario>.json` (only hook-smoke JSONs for Claude/Codex plus install probes are committed; other scenarios stay local-only — see ADR-032 closeout addendum)

## Non-Goals

- Do not replace `send-keys` input.
- Do not make hooks authoritative for nudge safety in Phase 1.
- Do not remove pane scraping in Phase 1.
- Do not make Codex/Cursor hook readings authoritative in Phase 1 (Codex hooks shipped in PR #81 closeout as telemetry-only; Cursor stays pane-only).
- Do not depend on OMC internals beyond optional read-only diagnostics documented in ADR-032.

## Requirements

### R1. Empirical hook viability gate

Before installing any slot fixture broadly, run a minimal Claude hook on representative slots and record:

- Whether the hook child process sees `$TMUX_PANE`.
- Hook event latency on runner-local, mini, and runner-a.
- Whether hooks still fire in plan mode.
- Whether `PostToolUse` delivery is exactly-once or at-least-once under normal tool execution.

Implementation must stop at this gate if `$TMUX_PANE` is absent and must switch to the ADR-032 fallback key of `{cwd, session_id}` before continuing.

### R2. Farmslot-owned hook writer

Add a small, runner-scoped hook writer script that receives Claude hook JSON on stdin and appends normalized JSONL records to:

```text
{{runtime_dir}}/.observability/hooks.jsonl
```

The writer owns:

- schema version,
- event timestamp,
- runner id,
- session id,
- tmux pane id when available,
- cwd,
- event name,
- selected event payload fields,
- rotation at 5 MB.

The writer must be fast enough that median hook latency stays below 150 ms on all representative machines.

### R3. Statusline snapshot writer

Add a companion statusline command that writes an atomic snapshot to:

```text
{{runtime_dir}}/.observability/statusline.json
```

The snapshot should include only fields that are available from Claude's statusline payload and useful for operator state, such as model/session/cwd/context percent when present.

### R4. Gateway reader/provider

Node-level monitoring owns file/pane change detection. The node daemon samples tmux panes and runner observability files, pushes changed snapshots to the gateway, and the gateway rebroadcasts `tmux.worker.inventory.updated` for Command Center/Mobile clients. Keep this distinct from `worker.signal`, which remains task-template semantics from `SIGNAL.json`. Runner-aware idle/waiting/stale readings should set `status.requiresAttention` so clients can highlight workers that likely need operator input; tmux-only idle panes should not infer attention. The Claude launcher may add a repo-root `.observability` compatibility symlink pointing at the runtime-dir observability folder for cheap node sampling.

Add a `RunnerObservabilityProvider` abstraction in `services/gateway/src/runners.ts` next to the existing runner status provider. The Claude implementation reads `hooks.jsonl` and `statusline.json` and exposes telemetry-only methods for:

- recent activity,
- prompt accepted after a timestamp,
- last turn completion,
- active tool when known,
- context percent when known,
- confidence/degraded reason.

The provider must return `null`/`unknown` for unavailable signal and must not throw through nudge/control paths for missing files.

### R5. Agreement logging

Record hook-vs-pane agreement for every existing safe-send decision while Phase 1 is enabled. This log is diagnostic only and must not change behavior.

At minimum, capture:

- slot id,
- runner,
- pane-derived state,
- hook-derived state,
- timestamp,
- disagreement reason when known.

### R6. Operator visibility

Expose Phase 1 as minimal diagnostics, not as a new primary UI surface:

- run/slot detail may show hook signal freshness and degraded reason,
- logs should clearly distinguish "hook unavailable" from "pane fallback failed",
- mobile worker inventory may consume hook-enriched status when the gateway already has it, but must keep plain tmux panes visible and controllable.

## Acceptance Criteria

- A minimal empirical report exists for runner-local, mini, and runner-a covering R1.
- Claude hook events are written to `hooks.jsonl` and can be read through node-pushed `tmux.worker.inventory.updated` / `tmux.worker.list` for at least one active slot.
- `statusline.json` is atomically updated and parsed without partial-read failures.
- Existing nudge behavior is unchanged when hooks are absent, stale, malformed, or disabled.
- Live tmux E2E passes via `scripts/e2e-tmux-runner-validate.sh` on a representative machine (hook-smoke + Grok smokes).
- `apps/command-center && yarn typecheck` passes.

## Rollout

1. Build the empirical hook probe and run it on one low-risk slot.
2. Add the hook writer/statusline fixture behind an opt-in pool or project setting.
3. Add the gateway provider and agreement log in telemetry-only mode.
4. Enable on Claude-runner slots one machine at a time.
5. Promote ADR-032 Phase 2 only after tmux E2E stays green across fleet machines and operator review of any agreement-log disagreements (no fixed event-count gate).

## Open Follow-Up

- Codex hook coexistence with OMX `.codex/hooks.json` remains a fleet verification item (installer merges Farmslot hook alongside existing registrations).
- Cursor remains pane-only unless a first-party streamed event surface appears.
- Retiring Claude pane regex belongs to ADR-032 Phase 3 once Phase 2 exit criteria clear under hook-authoritative mode.
