# ADR-056: Opaque runner session archive at recycle

**Status:** Accepted
**Date:** 2026-09-12
**Follows:** [ADR-047](047-worker-session-history-panel.md)

## Context

ADR-047 projects a live runner transcript into the experimental History tab. The run JSON only stores `runnerSessionId` / `runnerSessionPath`. Those pointers die when a slot recycles: Codex homes live in the slot workspace, Claude and Grok key files by cwd, and temp folders get cleared.

Copying the live path into the eval result package is the wrong unit. Grok is a directory. Cursor has no file Farmslot knows. Formats change. Transcripts hold secrets. A copied file still will not make `claude --resume` or `codex resume` work from another cwd (`sessionPortability: 'workspace'`).

## Decision

Snapshot the runner transcript **once**, at slot release, after the agent is killed and before workspace recycle.

- Capability: `sessionArchive: 'jsonl' | 'none'` on `RunnerDefinition`. Fail closed. Claude, Codex, and Grok opt in. Cursor, OpenCode, scripted, and unknown runners stay `none`.
- Store opaque bytes next to `.runs/` as `session-archives/<runId>/<contextId>/`, with a pointer on the run (`metrics.runnerSessionArchive` and the agent context). Do not embed the transcript in `.runs/<id>.json`.
- Grok's session path may be a directory; the runner layer resolves it to `chat_history.jsonl` before copy. Same History projectors read the snapshot later.
- Not eval evidence. Not a farmrun payload. `sanitizeRunForBundleExport` strips the pointer.
- Command Center stays the ADR-047 History tab. When the live file is gone, `worker.session.history.get` returns `source: 'transcript-archive'`. No new cockpit. This is a rare review path after recycle.

Non-goals: making resume/re-attach work from the copy; scraping Cursor tmux scrollback; copying on every save; a new family-view panel.

## Consequences

Operators can re-read Claude/Codex/Grok History after the slot forgets the file. Cursor remains unavailable. Recycle must not fail because the copy failed; the archive is best-effort and records `missing` with a reason.

## Related

- [ADR-023](023-runner-agnostic-tui-execution.md) — capability registry
- [ADR-039](039-run-portable-bundles.md) — farmrun stays free of session bytes
- [ADR-047](047-worker-session-history-panel.md) — History projection this snapshot feeds
