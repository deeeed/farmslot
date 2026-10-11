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
