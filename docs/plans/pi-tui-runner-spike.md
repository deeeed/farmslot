# PI TUI runner spike

**Status:** Spike proven 2026-09-17; promoted into [ADR-059](../adr/059-pi-tui-model-agnostic-runner.md)
**Date:** 2026-09-17
**Relates to:** [ROADMAP-next](../ROADMAP-next.md) item 21, [ROADMAP](../ROADMAP.md) Phase 5, [PRD-runner-execution-canonical](../PRD-runner-execution-canonical.md), [ADR-023](../adr/023-runner-agnostic-tui-execution.md), [ADR-032](../adr/032-runner-observability-via-hooks.md), [ADR-057](../adr/057-structured-runner-transports.md)
**Lifecycle:** Keep until the spike is promoted into an ADR/PRD slice or closed as not worth integrating.

## Governance checklist

- **Document type:** approved supporting plan under `docs/plans/`.
- **Why a new file:** PI as a Farmslot worker changes the runner boundary; the spike is too detailed for the near-term roadmap and not yet accepted as an ADR.
- **Canonical support:** runner-agnostic execution. ADR-057 left PI runtime replacement and OpenCode outside the native-transport delivery.
- **Public-safety:** no private pool names, tokens, hostnames, or credentials.

## Spike goal

Prove one non-mobile slot can run a Farmslot task through the PI coding-agent TUI (`@earendil-works/pi-coding-agent`) and still produce the host-side observability Farmslot expects: `hooks.jsonl` `UserPromptSubmit` digest, turn complete/`Stop`, and worker `SIGNAL.json` from the task template.

The first success case is intentionally narrow:

1. Register `pi` as a TUI-first runner.
2. Launch it in tmux with a Farmslot-owned extension (`pi -e …`).
3. Use a model PI already speaks without Claude Code impersonation (default `grok-4.6` via official PI xAI OAuth / SuperGrok). Codex-LB Astra is not the default while that quota is exhausted. Cursor subscription quota cannot be spent by PI; keep that on the Cursor runner.
4. Map PI events (`input`, `session_start`, `agent_settled`, tool start/end) onto the existing Claude-shaped hook file.
5. Pass `scripts/runner-validation/` `prompt-accepted` and `hook-smoke`.

## Kill criteria

Stop and close the spike as failed if any of these become true:

- Prompt-accepted or turn-complete can only be proven by parsing PI TUI text.
- Launch only works by stealing Claude Code / Codex CLI tokens and rewriting billing headers to impersonate those clients.
- PI cannot load a Farmslot extension in tmux without an interactive trust/login prompt that Farmslot would have to click via pane text.

OpenCode TUI+ACP is the fallback only after this spike fails. It is not the first implementation.

## Explicit non-goals

- Routing Claude Max included usage through PI.
- Native structured Copilot (PI RPC/ACP) in this slice.
- Replacing vendor runners.
- Session resume, parking, retained handoff.
- Eval-package bake-off (follow-on once hooks exist).

## Architecture touchpoints

- `services/gateway/src/runners/registry.ts` — `RunnerDefinition`
- `services/gateway/src/runners/launch-command.ts` — inline launch, same family as Grok
- `services/gateway/src/runners/claude-observability.ts` — reuse if the jsonl contract matches
- `scripts/install-runner-observability.mjs` — copy the extension into the slot runtime dir
- `packages/slot-config/src/hooks.ts` — `{pi_path}`
- `scripts/runner-validation/runners/pi.mjs`

## Auth

Workers authenticate as PI. Default is PI's official xAI / SuperGrok OAuth (`/login xai`). If the Grok CLI on the machine is already logged in with the same xAI OAuth client, `install-runner-observability.mjs` may seed `~/.pi/agent/auth.json` so PI does not need a second browser login. Do not import Claude Code keychain tokens or Cursor Agent credentials. Cursor subscription quota stays on the `cursor` runner; PI has no Cursor provider. Codex-LB remains available as an explicit model, not the default.

## Promotion

If live scenarios pass: write an ADR (PI as a first-class TUI runner, model-agnostic dispatch, hook contract) and keep vendor runners for subscription-native work. If they fail: record the evidence in this plan, mark the backlog item done-as-failed, and only then consider OpenCode ACP.
