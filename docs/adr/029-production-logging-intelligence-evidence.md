# ADR-029: Production Logging and Intelligence Evidence Registry

**Status:** Accepted
**Date:** 2026-05-02
**Relates to:** [ADR-013](013-gateway-mediated-orchestration.md), [ADR-016](016-d9-copilot.md), [ADR-027](027-unified-gateway-state.md)

## Context

Gateway intelligence can now inspect runs, route-aware Command Center context, observer evidence, source files, and a narrow development log (`/tmp/farmslot-dev.log`). The primary evidence path should remain run state plus artifacts gathered at each step: reports, grades, recipes, CI summaries, review output, and structured observer events. Logs are not the normal answer source; they are a secondary self-diagnosis surface when those artifacts are missing, contradictory, or too coarse to explain a gateway/runtime failure.

Some failures are deterministic and should stay in gateway policy code: restart recovery, bounded monitor nudges, CI inline-fix attempts, queue auto-dispatch, and deduped chained runs. Other failures need interpretation: ambiguous tmux output, parser drift, prepare logs that disagree with run artifacts, or CI/monitor behavior that requires source/log context before recommending a nudge. Those intelligence-assisted paths need trustworthy log evidence without granting broad filesystem access.

## Decision

Introduce a typed **log registry** owned by the gateway. The registry is the only path by which Co-Pilot and read-only investigation workers discover production/development logs.

The main gateway intelligence may use the registry as one of its diagnostic tools, especially when diagnosing its own runtime, prepare scripts, monitor behavior, tmux parsing, or missing artifact capture. That does not change the default evidence order: normal run explanations should prefer structured artifacts and only fall through to logs when the artifact trail is insufficient.

The registry provides:

1. **Canonical production log directory**
   - Default: `~/.farmslot/logs`
   - Override: `FARMSLOT_LOG_DIR`
2. **Operator-configured extra log directories**
   - `FARMSLOT_EXTRA_LOG_DIRS`, split by the platform path delimiter
3. **Development compatibility sources**
   - `/tmp/farmslot-dev.log`
4. **Typed entries**
   - `id`, `label`, `category`, `owner`, `kind`, `path`, `displayPath`, `description`, `exists`, `size`, `modifiedAt`
5. **Read constraints**
   - Co-Pilot may read only registry-listed log files or existing approved source/doc roots.
   - Directory scans are non-recursive and skip symlinks and non-log-like extensions.
   - Reads remain bounded by byte/character caps.
   - Log content is redacted before returning to the model.

Evidence priority remains:

1. Structured run state and step artifacts.
2. Observer evidence and typed Command Center screen context.
3. Source inspection when explaining gateway behavior.
4. Registered logs for self-diagnosis of gateway/runtime failures or artifact gaps.

## Authority Model

The registry does not make the LLM an autonomous operator.

| Actor                             |                       Can read logs |        Can propose writes |                     Can execute writes |
| --------------------------------- | ----------------------------------: | ------------------------: | -------------------------------------: |
| Co-Pilot chat                     | yes, via registry-backed read tools |      yes, via `<actions>` |                                     no |
| Read-only investigator            | yes, via registry-backed read tools |          no direct writes |                                     no |
| Gateway observer                  |                 event evidence only | attention/recommendations |                                     no |
| UI action card                    |                     no intelligence |         displays proposal |            yes, after operator confirm |
| Deterministic orchestrator policy |     yes, through gateway-owned code |                       n/a | yes, only for explicit built-in policy |

Reads and diagnosis may be autonomous. Writes, terminal sends, run cancellation, restarts, memory mutation, and other side effects remain either deterministic gateway policy or explicit operator-confirmed actions.

## Consequences

**Positive:**

- Co-Pilot and investigator workers can inspect production logs through a stable typed evidence surface instead of hardcoding `/tmp` paths.
- Future proactive recovery proposals can cite log ids and snippets when structured artifacts are insufficient, without broad filesystem access.
- Production deployments can move logs without changing tool prompts by setting `FARMSLOT_LOG_DIR`.
- Tests can inject temporary log directories through `FARMSLOT_EXTRA_LOG_DIRS`.

**Negative:**

- The registry is only as complete as the log producers wired into it. Node daemon and per-slot production logs still need consistent writers before they are always useful.
- Redaction is defense-in-depth, not a replacement for keeping secrets out of logs.
- Development harness logs remain available only when explicitly registered through `FARMSLOT_EXTRA_LOG_DIRS`; they are not part of the production storage contract.

## Implementation Notes

The first implementation slice ships with the ADR:

- `services/gateway/src/log-registry.ts` owns registry discovery, path display, and redaction.
- `list_farmslot_logs` returns typed registry entries.
- `read_farmslot_file` can read logs by registry `id`, display path, or absolute path, and marks log reads as redacted.
- Existing source/doc/script reads remain scoped to approved self-inspection roots.

## Out of Scope

- Proactive LLM recovery proposal engine.
- Automatic execution of LLM-proposed terminal nudges or run mutations.
- Long-term retention/rotation daemon.
- Structured JSON log schema for every subsystem.
- Hosted/multi-user production deployment logging backend.
