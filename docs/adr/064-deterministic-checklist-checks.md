# ADR-064: Deterministic checklist checks before publication

**Status:** Accepted
**Date:** 2026-10-11, accepted 2026-10-12
**Implementation:** Deterministic receipts and publication enforcement shipped in [#952](https://github.com/deeeed/farmslot/pull/952).
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

The implementation added normative rules to the existing [task directory contract](../reference/task-directory-contract.md).

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

### Public surface

The existing `pr.status` RPC exposes optional `PRStatus.checkSnapshot`, and
`RunDecision.context.checkSnapshot` retains it. `@farmslot/protocol` owns the
additive named check snapshot/row types and pure view-model for the gateway and
both operator clients. Companion uses the existing `force` flag for read-only
refresh. Harnesses inherit the existing response and context; no RPC, command,
CLI flag, hook, policy or schema version is added.

## Amendment 2 (2026-10-22): Reuse passing checks and freeze fix scope

**Status:** Accepted (2026-10-22)

### Decision and rationale

Reuse a passing receipt when its frozen command, publishable-input hash and recorded log still validate. Otherwise execute the check. Repeated marks preserve a successful terminal signal. This removes repeated CI runs with identical inputs.

Review-fix and CI-fix roles freeze the engine's pre-fix commit in their CI command as `FARMSLOT_CI_BASE_REF`, including retained delivery and replay. The Terminal pack uses it to select tests for that fix, including committed changes. Normal contribution checks keep their existing base.

### Public surface and consequences

The existing `ci.local_check`, frozen command and schema-version-1 receipt remain the contract. The gateway binds fix context; `@farmslot/agent-runtime` owns validation and reuse, and `@farmslot/recipe-cli` delegates to it. `FARMSLOT_CI_BASE_REF` is consumed by the Terminal pack's CI script. No CLI flag or SDK export is added; harnesses inherit the behavior. The [task directory contract](../reference/task-directory-contract.md#mark-and-receipt-rules) owns the rules.

## Amendment 3 (2026-10-26, Accepted): Local CI parity is no longer a worker step or completion/publication receipt requirement; other deterministic checks remain enforced.

## Amendment 4 (2026-11-04): Restore engine-owned changed-file checks

**Status:** Accepted, directed by Arthur for F394 on 2026-11-04. Supersedes Amendment 3.

Implementation workers declare `[DETERMINISTIC: ci.local_check]` and call `./mark N`.
They write code and tests, read failures and fix them. They do not choose or launch
validation commands. The configured script selects changed files and affected tests,
without running the full suite. CI owns broader validation. Reviewers inspect existing
CI results, deterministic receipts and logs; they do not execute validation.

The existing frozen command, source hash, receipt reuse and completion/publication
enforcement apply to `ci.local_check` again, including retained declarations.
No new command, flag, export or receipt format is introduced. The obsolete
`CI_PARITY_STEP` placeholder stays retired; templates declare the step literally.

## Amendment 5 (2026-11-15): Declared proof artifacts

**Status:** Accepted, directed by the lead for F6 on 2026-11-15.

A checked box records a claim; Amendment 4 covers the claim that a command ran.
A proof step's claim is that evidence exists, and nothing checked it: in blind
trial 9b117108 the worker checked "draft the recipe", "retain the failing
baseline run" and "run the required recipe" between 19:18Z and 19:30Z, the only
retained run was written at 20:05Z, no failing baseline run was ever retained,
and the run still finished.

A step may declare the artifact it produces on its own row:

```
- [ ] 9. Retain the failing baseline run [PROOF: artifacts/recipe-baseline-run]
```

The declaration is frozen into the task's terminal contract at init, beside the
deterministic commands. `./mark N` refuses the tick while that path is absent or
empty, and completion refuses a checked step whose evidence is missing or was
written after the step's last mark; re-marking such a step restates the claim
over repaired evidence, which is the sanctioned repair path. A step that declares
nothing keeps its prior behaviour exactly, so a template that has not adopted the
marker is unaffected.

Marks recorded after a later-numbered step are kept in the signal as
`checklistTiming.outOfOrder`. Order alone says nothing about the work, so it
refuses nothing.

A declared path is evidence only inside the task directory: it is resolved, and a
path that lands elsewhere through a symlink is refused, so a populated directory
the run never produced cannot stand in for the proof.

Completion inspects the declarations of the checklist that is completing, the one
`resolveChecklistTarget` names. A reviewer finishing its own checklist answers for
its own declarations; the worker's unproven step is the thing the reviewer reports
on, not a reason to refuse its report.

No new flag, command or receipt format is introduced: the declaration travels in
the existing contract and the refusals use the existing mark and completion
paths.

## Amendment 6 (2026-11-15): Unattended completion

**Status:** Accepted, directed by the lead for F6 on 2026-11-15.

A refused completion assumes somebody answers it. A blind eval trial that runs
with `review: false` has nobody: in trial 8cb5aea2 an acceptance refusal parked
the run at a gate in an unattended batch until an operator aborted it 18 minutes
later, and the trial was lost rather than scored.

The gateway stamps `unattendedCompletion` on the worker terminal contract when a
run's `engineState.evalExperiment.review === false`. On such a run a refused
`mark complete` ends the run with the refusal as its reason, so the trial is
scored as a refusal naming its cause. Runs with a human gate keep today's
behaviour, including the untestable override recorded by an authorized person.

## Amendment 7 (2026-11-15): Checklist order, and optional steps

**Status:** Accepted, directed by Arthur on 2026-11-15 after blind trial 40d98f79.

Amendment 5 refuses a claim whose evidence is absent. It does not refuse a claim
made in the wrong place: in trial 40d98f79 the worker applied a fix with no
baseline behind it and then ran `mark 13`, the changed-file CI gate, while it was
still on step 1 ("let me not overthink the checklist marks"). The mark engine
accepted a step twelve places ahead of the work.

Steps are claimed in order. `./mark N` is refused while any earlier step is
unchecked, deterministic steps included, and completion refuses a checklist whose
checked steps have a gap behind them.

The exception is declared by the template, never by the worker. A step title may
carry a condition:

```
- [ ] 11. Exit early if already fixed or not reproduced [OPTIONAL: the bug still reproduces]
```

Such a step may be skipped with `./mark 11 --skip "<reason>"`. The reason is
recorded in the ledger beside the step (`skipped: true` with the reason in
`checklistTiming`), the step's deterministic command does not run, and a declared
proof artifact is not required of it, because the skip claims the work did not
apply. A step without the marker can never be skipped: the worker does it, or
stops the run with `mark blocked`. The grant is the frozen contract, not the file
on disk: a marker a worker writes into its own checklist grants nothing, so a
step it was refused cannot be waived by marking that row optional. A task whose
contract predates the marker therefore has no optional steps at all. Completion refuses a recorded skip on a step
the template never declared optional.

The marker is frozen into the task's terminal contract at init beside the
deterministic commands and the proof declarations, and it is one spec across every
project: the same `[OPTIONAL: <when>]` in a pack template, a recipe-cook template
or a role checklist.

Good models already work in order, so nothing changes for them. What changes is
that skipping ahead now fails loudly at the mark, where the worker can still fix
it, instead of silently producing a finished-looking run with no baseline.
