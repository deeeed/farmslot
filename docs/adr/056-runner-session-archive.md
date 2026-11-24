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
- Store opaque bytes under `.runs/session-archives/<runId>/<contextId>/`, with a pointer on the run (`metrics.runnerSessionArchive` and the agent context). Do not embed the transcript in `.runs/<id>.json`. Evicting or deleting the run deletes that directory.
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

## Amendment 1: 2026-11-24 capture when each session ends

**Status:** Proposed with [ADR-039 Amendment 9](039-run-portable-bundles.md#amendment-9-2026-11-24-run-traces-as-private-training-data).

The snapshot is taken when each agent session ends (worker completion, each
review round and review fix, before a replay or an operator completion replaces
it), with slot release kept as the backstop that retries `missing` sessions.
Reviewer transcripts were often gone by slot release, and a context reused across
rounds kept only its last session. Archives are keyed by context and runner
session, written through a temporary file and a rename, and captured one at a time
per run; the details are in [Run traces](../reference/run-traces.md).

Two statements in the decision above are out of date and are corrected here:

- The capability list is wider than Claude, Codex and Grok: Pi also archives
  (`jsonl`), and `claude-acp` inherits `none`.
- Deleting a run no longer deletes its archive directory: since ADR-039
  Amendment 3, retention moves it to the run archive with the rest of the run's
  storage.

The archive is still not eval evidence and still not a farmrun payload. It also
feeds ADR-039 Amendment 9's private dataset export, which redacts its own copies
and never edits the archive.
