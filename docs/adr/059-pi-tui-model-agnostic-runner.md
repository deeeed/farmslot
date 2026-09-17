# ADR-059: PI TUI as a model-agnostic Farmslot worker

**Status:** Accepted
**Date:** 2026-09-17
**Scope:** [Runner execution PRD](../PRD-runner-execution-canonical.md), [near-term roadmap](../ROADMAP-next.md) item 21
**Related:** [ADR-014](014-llm-provider-abstraction.md), [ADR-023](023-runner-agnostic-tui-execution.md), [ADR-032](032-runner-observability-via-hooks.md), [ADR-057](057-structured-runner-transports.md)
**Lifecycle:** Keep as the accepted decision for the PI worker runner. Vendor TUIs remain; this adds a harness whose TUI does not change when the model does.

## Context

Farmslot workers are vendor TUIs (Claude, Codex, Cursor, Grok). Model is a flag inside each product, so dispatch cannot treat Grok, Codex, and a local model as the same worker. ADR-057 shipped native transports for those vendors and left PI runtime replacement and OpenCode outside that delivery.

Gateway intelligence already uses `@earendil-works/pi-ai`. Workers did not. PI coding-agent is a TUI harness with a TypeScript extension API, official xAI/Grok OAuth, and a multi-provider catalog. Farmslot needs that as a `RunnerDefinition`, not as another vendor-name branch.

## Decision

### `pi` is a TUI-first worker runner

Register `pi` in the runner capability registry. Default launch is the interactive PI TUI in tmux. The task prompt is delivered after launch (`needsPostLaunchPrompt`). Session reload and retained handoff stay fail-closed until a later slice proves resume.

Pool `pi_path` / `{pi_path}` resolve the binary. Inline launch does not require a runner-aware `dispatch_cmd`.

### Model is the dispatch axis

`acceptsModel` is permissive. The default is `grok-4.6`, launched as `xai/grok-4.6`. Operators may pass any PI-catalog model (`provider/id` or a bare id). Cursor subscription quota stays on the `cursor` runner; PI has no Cursor provider.

### OpenAI-compatible routers and local models

Farmslot does not ship a routing engine. The PI extension registers OpenAI-compatible endpoints that are already running:

- Ollama: `OLLAMA_HOST` / `OLLAMA_BASE_URL` / `FARMSLOT_PI_OLLAMA_URL` (default `127.0.0.1:11434`). Set `FARMSLOT_PI_OLLAMA=0` to skip.
- LiteLLM: `LITELLM_URL` / `LITELLM_API_KEY`
- Custom router: `FARMSLOT_PI_ROUTER_URL` / `FARMSLOT_PI_ROUTER_KEY`

Discovery GETs `/v1/models` with a short timeout and fails open. Dispatch uses `runner=pi` and `model=ollama/qwen2.5-coder` (or `litellm/…`, `router/…`). PI's own `~/.pi/agent/models.json` still applies. Local Ollama is actual on-machine inference; a cloud router only inherits that backend's retention.

### Observability is a Farmslot PI extension, not pane text

Launch copies `scripts/runners/pi-farmslot-observability.ts` into the slot runtime dir and loads it with `pi -e`. The extension maps PI events (`session_start`, `input`, tool start/end, `agent_settled`) onto the existing Claude-shaped `hooks.jsonl` contract. `getRunnerObservability('pi')` reuses the Claude hook provider. Prompt-accepted is a digest match, not a pane scrape.

### Auth is PI's, not a stolen official client

Workers authenticate as PI. Official PI xAI OAuth (`/login xai` / SuperGrok) is the default path. If the Grok CLI on the machine is already logged in with the same xAI OAuth client, observability install may seed `~/.pi/agent/auth.json` so PI does not need a second browser login. Do not import Claude Code keychain tokens or rewrite Claude billing headers.

A custom TUI does not by itself give zero data retention. Retention is the provider account: xAI API defaults to 30-day audit storage and no training without permission; Zero Data Retention is an xAI API team/enterprise setting on API keys, not SuperGrok OAuth. Point PI at a ZDR key or another provider when that contract is required.

### OpenCode remains the fallback harness

If PI cannot emit structured hooks, adopt OpenCode TUI+ACP using the existing Cursor/Grok ACP adapters. Do not start with OpenCode while PI hooks work.

## Consequences

- Dispatch can select `runner=pi` and `model=grok-4.6` (or another PI model) the same way as Grok/Claude.
- Native Copilot/RPC for PI is not in this slice.
- Vendor runners remain for subscription-native tools (Claude Max, Codex CLI, Cursor Agent).
- Eval-package comparison of PI vs vendor harnesses is follow-on work.

## Validation

Live `scripts/runner-validation/` on Grok 4.6: `prompt-accepted`, `hook-smoke`, and `pi-interactive-prompt` (TUI + post-launch send-keys, digest-matched `UserPromptSubmit` + `Stop`). A production `run.create --runner pi --model grok-4.6` on `macwork-ff-2` launched the PI TUI, wrote structured hooks, and the worker `mark blocked` because the smoke ticket had no ACs.
