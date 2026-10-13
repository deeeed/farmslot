# Stacked work specification

**Status:** Proposed for the retained-run attachment in [ADR-040 Amendment 3](../adr/040-work-graph-orchestration.md#amendment-3-retained-run-stack-attachment). Existing graph-dispatched stacking remains available. Attachment requires acceptance and implementation rollout.

## Existing stack lifecycle

The shipped lifecycle is owned by the [Accepted stacked-run amendment](../adr/040-work-graph-orchestration.md#amendment-stacked-runs-2026-10-07). The [operator guide](../operations/stacked-work.md) covers graph dispatch, prepare, task context, publication and retarget, including archive and conflict limits. This Proposed specification defines the retained-run attachment extension below.

## Public surface

The Proposed RPC is `workGraph.attachRun`. Its parameters are:

| Field             | Requirement                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `graphId`         | Existing graph                                                                                            |
| `nodeId`          | Existing backlog node belonging to that graph                                                             |
| `runId`           | Retained dev or fix-bug root run for that node's backlog item; a new attachment requires unpublished work |
| `expectedHeadSha` | Full child commit ID, checked against authoritative Git and any retained publication package              |

The result contains the current `graph`, `run` and `publicationRefreshRequired`. The boolean reports whether the retained publication package needs refresh; it is not an approval or readiness grant.

`@farmslot/protocol` owns `WorkGraphAttachRunParams`, `WorkGraphAttachRunResult` and `WorkGraphMethods.attachRun`. The CLI consumer is `farmslot graph attach-run <graphId> <nodeId> <runId> --expected-head <sha>`. Harnesses use the existing typed gateway transport. The normal compatible protocol/client release enables the interface; there is no client-side binding or alternate stack format.

## Admission

For a new binding, the gateway MUST verify all of the following before attachment:

1. The caller has the existing graph/run control authority, including the native-owner fence when applicable.
2. The graph and backlog node exist, the node's backlog item equals `run.backlogItemId`, and the run is the current retained attempt. A missing backlog ID refuses; do not infer it from a ticket or source ref. Reference nodes are not attachment targets.
3. The root has a retained branch, is human-gating, blocked, paused or done, and no work is progressing according to the existing progress authority. Another queued or running attempt for the item refuses attachment.
4. No child PR has been published. A different graph/node or existing conflicting stack binding refuses attachment.
5. The node has one `published` stack edge and a `merged` completion edge with `rebase-onto` from that same upstream. Its authoritative upstream run and PR belong to the same project and origin repository. The PR remains open and comes from that repository.
6. The run's branch resolves to `expectedHeadSha`. A retained publication package, when present, records that same branch and HEAD. A borrowed checkout's current HEAD is not evidence for this run; verify the retained branch reference through existing source validation.
7. The observed pushed upstream head is an ancestor of the expected child HEAD. Missing refs, source drift, a closed or merged parent, a fork, a different repository or unverifiable ancestry refuse without attachment writes.

The caller MUST NOT provide `stack`, a publication base, upstream identifiers or replacement family/worker ownership. The graph and canonical PR reader determine those values.

## Commit and recovery

Use the existing run transition and graph mutation fences. Read external source facts outside the graph lock, then recheck graph/run identity, ownership and source before committing. A changed admission subject refuses or requires a fresh attempt.

Persist the existing `workGraphId`, `workNodeId` and `Run.stack` together on the run. The stack records the upstream node/run, PR number/URL, canonical head branch and observed head commit. Reconcile through the existing run/backlog/queue projection: human-gating or blocked maps to gated; done maps to succeeded only after required completion blockers clear. Outbound edges retain their own condition checks. Attachment MUST NOT enqueue another run or change vertical family IDs, task/evidence bytes, branch contents, worker/slot binding, lifecycle steps, metrics, verdicts or review budget.

For an identical existing binding, verify caller authority, graph/node/run identity and the expected retained child HEAD, then return the recorded relationship without repeating new-attachment admission. Preserve its recorded upstream and retarget fields even if that upstream has since advanced or merged; do not resolve a replacement PR into it. A changed HEAD or conflicting declaration still refuses. A restart reconstructs the binding from the existing stores; no additional binding store or retry queue is introduced.

## Publication after a base change

Approval and publication MUST compare the selected prepared package's base with the current derived publication base. A mismatch refuses with a refresh reason, including after restart. The old package and reviews remain inspectable but cannot authorize publication against the new base.

Use the existing `run.refreshPublishPackage` operation to capture the new subject and preserved evidence selection. It retains its workspace ownership, hash, evidence applicability and verdict checks. If the source cannot be safely refreshed, report that refusal; attachment does not manufacture a package or claim the old proof now applies. Reviews keep their captured subject and become stale under the normal rules. Artifact-only QA/output gates retain their existing admission path.

## Required proof

The `scripts/runner-validation/gateway/stacked-work.mts` scenario and `scripts/runner-validation/stacked-work.recipe.json` will carry the implementation's public proof. They must demonstrate:

- A public-RPC attachment of a retained standalone run held at its publication gate, preserving its ID, task, source and evidence hashes while deriving the upstream base.
- An identical retry and a gateway restart that preserve the relationship without another run or dispatch.
- Refusals for conflicting ownership/binding, wrong repository, missing or drifting refs, closed/merged upstream and failed ancestry, without attachment writes.
- An old package refused after the base change, a supported refresh, and a matching cold review satisfying the required review count. A wrong-base or stale review must refuse, including a retained WARM review after a base change at unchanged HEAD.
- A real pushed chain with two stacked children, correct prepare base, task context, contribution preview, PR target and parent body link, followed by merge observation, retarget and refreshed diff.

Use public graph/prepare/package/publication interfaces for the chain and retain the actual PR and commit receipts. A seeded stack record cannot prove attachment or graph admission. Each changed behavior needs a negative control that fails its intended assertion. Headless Git/orchestration proof does not claim application or recording evidence.
