---
# GENERATED from packages/protocol/src/contracts/runs.ts; run generate:contracts, do not edit.
title: Run states and the gate
---

# Run states and the gate

The protocol owns the vocabulary and per-flow steps below. The gateway owns
transitions and prerequisite checks; clients display its state and reasons.
These tables list configured steps, not every possible transition or replay.
See [How Farmslot works](../concepts/operating-loop.md) for the operating loop.

## Run states

| State           | Protocol category          |
| --------------- | -------------------------- |
| `created`       | Waiting or requires action |
| `grading`       | Active                     |
| `writing-task`  | Active                     |
| `slot-finding`  | Active                     |
| `preparing`     | Active                     |
| `dispatching`   | Active                     |
| `monitoring`    | Active                     |
| `reviewing`     | Active                     |
| `fixing`        | Active                     |
| `review-failed` | Waiting or requires action |
| `reconciling`   | Active                     |
| `completing`    | Active                     |
| `human-gating`  | Waiting or requires action |
| `ci-watching`   | Active                     |
| `paused`        | Waiting or requires action |
| `done`          | Terminal                   |
| `blocked`       | Waiting or requires action |
| `failed`        | Terminal                   |
| `cancelled`     | Terminal                   |

An active category does not prove that a process is progressing. Uncertain
delivery requires reconciliation. A terminal state closes execution; `done`
does not guarantee successful validation. Read the retained outcome and evidence.
`blocked` is not terminal in this protocol: recovery may resume it. Gate,
pause and reviewer-failure states require their recorded reason and next action.

## Flows and publication

| Flow            | Canonical steps, in order                                                                                                                  | Human gate in pipeline      | Publication path                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | -------------------------------------- |
| `qa`            | `find-slot` → `write-task` → `prepare` → `dispatch` → `monitor` → `human-gate` → `complete`                                                | Yes                         | Report or posted review; no new PR     |
| `fix-bug`       | `find-slot` → `grade` → `write-task` → `prepare` → `dispatch` → `monitor` → `review` → `complete` → `human-gate` → `finalize` → `ci-watch` | Yes                         | Gateway finalize: publish or update PR |
| `review-pr`     | `find-slot` → `write-task` → `prepare` → `dispatch` → `monitor` → `human-gate` → `complete`                                                | Yes                         | Report or posted review; no new PR     |
| `dev`           | `find-slot` → `write-task` → `prepare` → `dispatch` → `monitor` → `review` → `complete` → `human-gate` → `finalize` → `ci-watch`           | Yes                         | Gateway finalize: publish or update PR |
| `pr-complete`   | `find-slot` → `write-task` → `prepare` → `dispatch` → `monitor` → `complete` → `finalize` → `ci-watch`                                     | No separate human-gate step | Gateway finalize: publish or update PR |
| `update-branch` | `write-task` → `dispatch` → `monitor` → `review` → `complete` → `finalize` → `ci-watch`                                                    | No separate human-gate step | Gateway finalize: publish or update PR |

`dev` and `fix-bug` may create a PR. `pr-complete` and `update-branch`
operate on an existing PR. QA acknowledges a report, and review can post or
dismiss its retained review. Neither creates a new PR. Interactive development
can open its own draft PR; its operator-driven completion is an exception to the
autonomous flow table. Policy can add decisions inside steps, so absence of a
`human-gate` step is not permission to bypass approval or prerequisites.

## The approval boundary

Readiness checks compose the owning deterministic, review and evidence contracts.
Missing, failed, stale or invalid prerequisites prevent normal advancement.
Authorized evidence attestation can waive only the scoped claim-policy/binding
findings permitted by ADR-062; integrity failures and unrelated prerequisites
remain enforced. The gateway
rechecks at decision resolution and publication. Inspection and authorized
recovery remain separate actions while readiness is incomplete.

Approval binds the selected inventory and validation identity. It does not turn
report prose, a video file or a checked box into claim proof. Publication must
refuse changed approved bytes or selection. See the
[fail-closed lifecycle specification](https://github.com/deeeed/farmslot/blob/main/docs/reference/fail-closed-run-lifecycle.md)
and [evidence specification](https://github.com/deeeed/farmslot/blob/main/docs/reference/recorded-run-evidence.md).
