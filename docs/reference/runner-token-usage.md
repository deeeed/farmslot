# Runner token usage extraction

Status: stable technical reference supporting `docs/PRD-runner-execution-canonical.md` and runner cost attribution.
Assessment date: 2026-06-23.
Lifecycle: keep updated whenever a runner CLI version changes token/usage output.
Public safety: no local session IDs, private paths, credentials, or run evidence.

## Goal

Farmslot should attribute token usage per run from durable, runner-owned structured data. Never infer tokens from tmux panes, progress text, or regex over terminal UI. If a runner does not expose durable usage, mark usage `unavailable` with a reason instead of reporting zero.

There does not appear to be one stable cross-runner token-extraction library or CLI protocol that covers Claude Code, Codex CLI, Grok Build, and Cursor Agent TUI modes with identical semantics. Treat Farmslot's implementation as a thin adapter layer over each runner's best structured source. If an upstream runner later exposes a standard usage event or adopts a common agent protocol with usage metadata, prefer that contract and remove runner-specific scraping.

## Runner contracts

| Runner       | Farmslot source                                                      | Token status                       | Notes                                                                                                                                                                                                                                                    |
| ------------ | -------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code  | Persisted JSONL under Claude Code project sessions                   | exact tokens                       | Sum assistant `message.usage` fields. `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and `output_tokens` are separate Claude usage fields. Cost is optional and omitted when the model id is not in Farmslot's pricing table. |
| Codex CLI    | Persisted Codex JSONL session                                        | exact tokens                       | Prefer provider `total_tokens` from the token-count event. `cached_input_tokens` and `reasoning_output_tokens` are detail fields and must not be added to `total_tokens` when a provider total exists. Fallback total is `input_tokens + output_tokens`. |
| Grok Build   | Grok session `summary.json` joined to Grok unified log by session id | exact tokens when log entry exists | Use `prompt_tokens + completion_tokens` as total. `cached_prompt_tokens` and `reasoning_tokens` are detail fields; expose them separately, but do not double-count them in total.                                                                        |
| Cursor Agent | Captured `--print --output-format json` stdout only                  | partial                            | The installed headless CLI emits usage, but the normal interactive TUI transcript does not persist usage fields. Interactive Cursor runs should remain `unavailable` until Farmslot captures a structured stdout/session source.                         |

## TUI vs headless dispatch

Default interactive TUI dispatch is still the right mode when a worker needs a live pane, tmux steering, review nudges, or manual intervention. Token accuracy is runner-dependent in that mode because TUIs do not all persist structured usage with the same fidelity.

For small, bounded, non-interactive tasks, Farmslot may dispatch through a runner's headless mode instead of the TUI when all of these are true:

1. The runner documents a structured output mode (`json`, JSONL, or streaming JSON) for headless execution.
2. The structured output includes usage or can be joined to a durable session/log with a stable session id.
3. The task does not need mid-run human steering, pane inspection, or a long-lived interactive conversation.
4. Farmslot stores the structured stdout/session path as a run artifact and records the extractor status as `exact`, `partial`, or `unavailable`.

Headless mode is therefore an accuracy tool, not a universal replacement for TUI mode. If a headless path cannot prove token fields from structured data, do not improve the number by parsing terminal text; report `unavailable`.

## Official-source basis

- Claude Code documents `/usage` as the current-session token/cost view, and says cost is an estimated local calculation; status-line JSON exposes `cost.total_cost_usd` and context token totals. See <https://code.claude.com/docs/en/costs> and <https://code.claude.com/docs/en/statusline>.
- Codex documents `codex exec --json` as JSONL with `turn.completed` events. Codex pricing is based on input, cached input, and output token rates. See <https://developers.openai.com/codex/noninteractive> and <https://developers.openai.com/codex/pricing>.
- xAI documents Grok Build headless mode, `--output-format plain|json|streaming-json`, and session storage under `~/.grok/sessions`. xAI API usage examples define prompt/completion totals with cached/reasoning detail fields. See <https://docs.x.ai/build/cli/headless-scripting> and <https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing>.
- Cursor documents `--print --output-format text|json|stream-json`, but the public output-format page currently documents the success object without token fields. Treat headless stdout usage as local CLI evidence, not a guaranteed public spec. See <https://cursor.com/docs/cli/reference/output-format>.

## Known generic-tooling status

- Claude Code has third-party usage tools that parse Claude's local JSONL sessions. Those can be useful cross-checks for Claude-specific totals, but they do not solve Codex/Grok/Cursor extraction.
- Provider API/tokenizer libraries can estimate or price direct API usage, but runner CLIs add cache reads/writes, reasoning tokens, model aliases, and session-level accounting that must come from the runner or provider usage event.
- ACP-style integrations may eventually standardize agent transport, but do not currently replace runner-specific token usage contracts for all supported CLIs.

## Validation protocol

For every runner upgrade, run a tiny prompt such as `Reply exactly TOKEN_CHECK_OK.` and record:

1. CLI command and version.
2. Durable transcript/stdout path used by Farmslot.
3. Provider usage fields observed.
4. Farmslot extractor output.
5. Verdict: `exact`, `partial`, or `unavailable`.

Do not merge runner usage changes unless the extractor output matches the provider source for the tiny prompt or the runner is explicitly documented as unavailable.
