# ADR-064: Deterministic checklist checks before publication

**Status:** Accepted
**Date:** 2026-10-11, accepted 2026-10-12
**Owner:** Farmslot maintainers
**Scope:** Extends [ADR-060](060-sub-task-observability.md) and the [task directory contract](../reference/task-directory-contract.md).

## Context

A checked box records a worker's claim. Skipped checks and CI drift expose failures after publication. Deterministic steps need execution receipts.

## Decision

A step may declare a DETERMINISTIC command. `./mark N` executes it in the slot repository, captures output and exit code, and marks done only after exit zero and receipt persistence. Failure, interruption or missing configuration returns an error and leaves the step incomplete. Bulk and terminal completion cannot bypass checks.

Receipts identify checklist, step, command, source inputs, timestamps, exit code and log. Changed commands or publishable inputs invalidate prior passes. The publish gate independently verifies every declaration, ignoring checkbox claims. Missing, failed, interrupted or stale checks block publication; rerun `./mark N` after correction.

## Public surface

- **Project field:** `ci.local_check` holds a portable shell command, required when CI parity is declared.
- **Checklist syntax:** `- [ ] CI parity [DETERMINISTIC: ci.local_check]`. Initialization freezes the resolved command in the task contract. PR-producing templates include one shared step part.
- **Mark behavior:** `@farmslot/agent-runtime` owns `./mark N` execution and versioned receipts/logs under `artifacts/deterministic-checks/`, scoped by checklist and step. No new flags or SDK exports.
- **Gate display:** both operator clients consume one `@farmslot/protocol` projection showing command, status, exit code and log link. Approval requires every declared check to pass.
- **Harness consumption:** harnesses supply configuration, invoke generated mark and read shared artifacts. They inherit enforcement.

## Alternatives considered

- An instruction asking the worker to run the command. Rejected because it can be skipped without an execution receipt.
- A separate gateway execution step. Rejected because the mark receipt supplies the execution result and publication precondition.

## Consequences

- Deterministic checks add local execution time and durable logs. Failed checks stop completion and publication with a command and log to inspect.
- Shared commands prevent local/CI drift; harnesses and operator clients use the same receipts and gate rules.

## CI parity and implementation

Local checks and CI call the same script. Remote-only checks remain in CI. Undeclared steps retain existing behavior.

The implementation PR adds normative rules to the existing [task directory contract](../reference/task-directory-contract.md).

## Amendment 1 (2026-10-12): CI decision check context

**Status:** Accepted
**Implementation:** Merged in [#951](https://github.com/deeeed/farmslot/pull/951).
**Specification:** [CI decision check context](../reference/ci-decision-check-context.md).

### Decision

Add an optional read-only `PRStatus.checkSnapshot` to existing `pr.status` reads.
The gateway retains PR/repository identity, fetch time and provider check rows
with every newly raised `ci_*` decision. Keep gate-time and current data separate;
missing historical metadata remains unknown. The existing CLI and GraphQL check
queries share normalization, without another endpoint or request.

`@farmslot/protocol` owns the pure comparison model consumed by the existing
Command Center and Companion decision renderers. Companion refresh uses
`pr.status` with `force: true`, bound to the selected decision and connection.
It retains the frozen gate snapshot and never resolves the decision or changes
its actions. Desktop consumes its existing reads only.

### Rationale

Gate-time prose and current coarse check groups cannot explain CI drift.
Retaining the check snapshot lets operators compare what raised the decision
with current provider facts without reconstructing history.

### Consequences

The snapshot/row types and `RunDecision.context.checkSnapshot` are additive.
Legacy records remain readable without backfill. Existing watched groups,
recommendations, caching, backoff, broadcasts, timeout auto-resume and timers
retain their behavior. Harnesses inherit the response and decision context;
no RPC, public command/flag, harness hook, policy, gate-resolution rule or
schema-version change is added. Successful empty reads differ from failed or
truncated reads. List trimming is explicit and detail hydration retains the
snapshot. The specification owns transport normalization, all six CI types,
refresh races, availability states and verification requirements.
