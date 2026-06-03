# ADR-031: Autonomous Transient-Failure Recovery and Intelligence Action Audit

**Status:** Accepted
**Date:** 2026-05-11
**Relates to:** [ADR-002](002-tmux-streaming.md), [ADR-013](013-gateway-mediated-orchestration.md), [ADR-014](014-llm-provider-abstraction.md), [ADR-021](021-llm-enhanced-orchestration.md), [ADR-027](027-unified-gateway-state.md), [ADR-029](029-production-logging-intelligence-evidence.md)

## Context

Some run failures are transient and deterministically classifiable (`flake`, `infra`, `env-drift`, `timeout`). Today they require operator nudging. ADR-029 declared "Deterministic orchestrator policy" as the only actor allowed to execute writes autonomously; ADR-031 is the first concrete consumer of that row. To make ADR-029's authority claim auditable, ADR-031 specifies how every autonomous decision is recorded — on disk, from day one — and constrains the channels through which any autonomous mutation may occur.

## Decision

Single feature PR; default-off per project (`auto_recovery.enabled=false`); full e2e validation on the feature branch before merge per the §Branch e2e validation plan in `.omc/plans/auto-recovery-adr031-v7.md`. Subscriber-watcher gated by `auto_recovery.enabled`; deterministic classifier (lazy-loaded); per-runId mutex with strict ordering; family ledger derived at read time; boot-time orphan scan. Every decision persisted as an append-only NDJSON line under `~/.farmslot/logs/intelligence-actions/<UTC-date>.ndjson`, allowlist-redacted at write time, bounded to ≤4 KiB serialized for sub-PIPE_BUF write atomicity, with the directory registered as `intelligence-audit` in ADR-029's log registry. Each record carries both `timestamp` (failure-event time) and `decidedAt` (decision time) so boot-scan-fired recoveries are temporally honest. Write failures set `Run.engineState.intelligenceAuditDegraded=true` and emit `RUN_UPDATED`; the UI surfaces a degraded chip live. CI-grep step asserts zero direct-exec calls in `auto-recovery/*`. The typed `IntelligenceAction` schema, `intelligence.actions.summary` RPC, and UI audit panel ship in the same PR and consume the same files. Tier-2 LLM refinement ships with `proposedAction.type` JSON-schema-validated against an allowlist BEFORE execution and bounded by a daily USD budget; default off until template + budget signed off per project.

## Constraints

- **Authority channels (HARD).** All recovery-side mutations route through typed gateway RPC primitives (`runReplayStep`, `resetSlot`, `cleanupSlotProcesses`, `slotFixtureRefresh`, `runCancel`) OR tmux send-keys via `tmuxSend`. No direct `child_process.exec`/SSH-shell/out-of-band execution from `auto-recovery/*`. `slotFixtureRefresh` is a new typed RPC introduced by this PR that extracts the existing inline fixture-sync code path at `services/gateway/src/methods/slot.ts:1216` into a standalone callable handler.
- **LLM remediation surface (HARD).** Tier-2 LLM output is restricted to typed `FailureCategory` + `confidence`, OR `proposedAction.type` in `{run.replayStep, slot.reset, slot.cleanupProcesses, slot.fixtureRefresh, tmux.send}`. JSON-schema-validated BEFORE execution; failures demoted to proposal-only with `confidence='low'`.

## Architecture

Subscriber-watcher classifies + guards + dispatches via typed RPC primitives. Tier-1 deterministic → `runReplayStep`. Tier-2 LLM-suggested remediations are schema-validated against the allowlist first; only safe typed primitives with explicit handlers (`run.replayStep`, `slot.fixtureRefresh`) may auto-apply. More intrusive or human-contextual actions (`slot.reset`, `slot.cleanupProcesses`, `tmux.send`) are recorded as proposal-only audit records until a human validates them.

**Why tmux-only for non-primitive remediations.** tmux send-keys preserves observability (ADR-002 streaming), operator override (humans attach + interrupt), audit replay (`appliedAction.tmuxKeys` + scrollback), and authority alignment (already-allowed actor + channel under ADR-029). Direct exec satisfies none.

Boot-time orphan scan in `recoverActiveRuns()`; per-runId `Map<runId, Promise<void>>` mutex; family ledger derived from `Run.recoveryAttempts[]`. `maxAttempts` is evaluated per step, matching resolved Q1 in `.omc/plans/open-questions.md`.

## Persistence

Append-only NDJSON file at `~/.farmslot/logs/intelligence-actions/<UTC-date>.ndjson`. One file per UTC day, directory mode `0700`. Each line is bounded to ≤4 KiB serialized so a single `appendFile` write remains atomic under POSIX `PIPE_BUF`; `appliedAction.tmuxKeys` is truncated to 2 KiB with a `…[truncated]` suffix above that threshold. No file locking. Write is best-effort: failures set `Run.engineState.intelligenceAuditDegraded=true`, emit `RUN_UPDATED`, log a structured warn, and the recovery decision still dispatches. Directory registered as `intelligence-audit` in the log registry; `LOG_FILE_EXTENSIONS` extended to include `.ndjson`. No rotation (deferred). The typed RPC reads these files; the typed parser drops shape-drift lines via the same warn-counter mechanism as JSON parse-fails.

## Privacy

Allowlist redaction at write time via `audit-fields.ts`. Persisted keys include both `timestamp` and `decidedAt`. `appliedAction.tmuxKeys` is a controlled string (runner commands like `yarn install`) with a 2 KiB cap; ADR-029 redactor runs as defense-in-depth. Free-text fields (`verdict.rationale`, error `detail`, guard `reason`) dropped at write time.

## Consequences

**Positive.** First autonomous orchestrator-policy actor; ADR-029 authority becomes auditable AND structurally enforced (no direct-exec surface, on-disk trail registered in the log registry); typed schema + RPC + UI panel ship together so observability is real on day one; degraded-write state is visible to operators in real time, not silent; default-off-per-project means landing is a no-op until a flag flips.

**Negative.** One protocol-surface bump; NDJSON storage needs monitoring; CI-grep step is one more lint surface; directory perm management is a new operational concern; 4 KiB line bound caps how verbose any future allowlisted field can be; per-project LLM template adoption is gated on nested-repo commits outside this PR.

**Deferred.** Rotation policy; trend-analytics dashboard; cross-tier cost aggregation beyond per-call `costUsd`.

## Alternatives Considered

- Inline catch-block recovery — rejected (engine coupling, no mutex).
- 3-PR split — rejected: default-off-per-project means landing the whole feature is a no-op until a flag flips; e2e validation on the feature branch trumps PR-size hygiene.
- `console.log`-only audit — rejected: not real persistence; no analytics surface; lost on log rotation.
- File-locking for NDJSON appends — rejected: sub-PIPE_BUF write bound gives atomicity for free.
- Single `timestamp` field — rejected: boot-scan recoveries need to record both event time and decision time for the audit to be temporally honest.
- LLM-driven autonomous loop without typed-RPC constraint — rejected (ADR-029 violation; unbounded cost; no audit replay).
- Direct `child_process.exec` for non-primitive remediations — rejected (no observability, override, audit, authority alignment).

## Follow-ups

10 PR-blocking questions tracked in `.omc/plans/open-questions.md` (Q1–Q10; all resolved 2026-05-11). Per-project `templates/prompts/classify-failure.md` adoption is per-nested-repo and outside this PR. ADR-027 unchanged (no new persisted state schema). ADR-029 gains a concrete first consumer (auto-recovery actor) AND a concrete first log-registry entry (`intelligence-audit`). Q9 override: `slot.fixtureRefresh` joins the typed-RPC primitive set and the LLM `proposedAction.type` allowlist; the new RPC ships in this PR.

## Out of Scope

Hosted multi-user audit storage; pre-merge eval of recovery patterns (handled by ADR-030); rotation policy.
