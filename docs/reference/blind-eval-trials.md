# Blind eval trials

Normative reference for [ADR-030 Amendment 1](../adr/030-replay-provenance-and-reference-evals.md#amendment-1-blind-trial-inputs-and-comparison-eligibility-2026-10-30). Owned by gateway eval execution; retain with that capability. This reference defines the worker-input and comparison contract, rather than a particular experiment or rollout.

## Inputs

- An experiment must retain explicit problem text supplied from the ticket. A reference PR body or diff is not a problem-statement fallback.
- The gateway resolves and freezes a full base commit identity before launching the worker. The reference answer must not be part of that base.
- Task-specific worker inputs contain the problem statement and base identity. They must not contain the reference PR number, URL, commit, patch, package or experiment manifest, including paths to those inputs. Reference data stays gateway-side.
- Normal framework instructions and tool provenance remain available. Forward task sync and replay must preserve the same input boundary.
- Trials missing problem text, a usable reference comparison patch or verified isolation fail before worker dispatch. A legacy trial cannot silently resume through an unblinded path.

## Git isolation and cleanup

- The worker repository has its own object store, without alternates or shared worktree objects. It contains a shallow base snapshot and candidate objects only.
- Before worker launch, verify that reference commits are unavailable, remote URLs are absent and fetch protocols are disabled. Recheck the boundary at dispatch and first-output capture.
- Existing slot Git metadata is retained outside the worker checkout under the trial's lease. Preparation and recovery must not fetch into the isolated repository.
- Teardown stops the owned worker, retains its candidate commits, then restores the original Git metadata before ordinary slot cleanup. Restoration is bound to the original run and slot ownership. A failed restoration keeps the slot fenced.

## First output and contamination

- Freeze the first worker output's base, head, contribution diff and digest before review or a fix round can alter it. Later output cannot replace this snapshot.
- The gateway computes stable patch identities from the frozen candidate contribution and reference patch. A nonempty identity match makes the trial contaminated and ineligible for comparison.
- Comparison eligibility is pending until an output is captured, then eligible, contaminated or invalid. Completed outputs with missing blind provenance or unavailable comparison inputs are invalid.
- Preserve the reason and source identities with the assessment. Reference identities are never copied back into the worker task tree.
- Finalized historical output packages retain their original bytes and hashes. Readers show their missing blind provenance as invalid comparison input; finality alone does not imply eligibility.

## Public surface

The protocol package owns the case, trial and result-package fields consumed by the existing eval RPCs and Command Center comparison readers. The gateway owns input validation, Git isolation, first-output capture and contamination assessment. Existing framework prepare/dispatch/teardown contracts remain the lifecycle path. Harnesses inherit the blinded task and base; they receive no reference lookup capability or new command. Additive wire metadata follows protocol patch versioning and the matching-reader rollout.
