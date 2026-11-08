# Blind eval trials

Normative reference for [ADR-030](../adr/030-replay-provenance-and-reference-evals.md#amendment-1-blind-trial-inputs-and-comparison-eligibility-2026-10-30). Owned by gateway eval execution; retain with that capability. This reference defines the worker-input and comparison contract, rather than a particular experiment or rollout. The proof profile below is proposed in Amendment 4; existing profiles retain Amendments 1 to 3.

## Inputs

These input rules describe the existing `dev` and `fix-bug` profiles. The [proof profile](#proof-profile) supplies the implementation as an allowed input.

- An experiment must retain explicit problem text supplied from the ticket. A reference PR body or diff is not a problem-statement fallback.
- The gateway resolves and freezes a full base commit identity before launching the worker. The reference answer must not be part of that base.
- Task-specific worker inputs contain the problem statement and base identity. They must not contain the reference PR number, URL, commit, patch, package or experiment manifest, including paths to those inputs. Reference data stays gateway-side.
- Normal framework instructions and tool provenance remain available. Forward task sync and replay must preserve the same input boundary.
- Trials missing problem text, a usable reference comparison patch or verified isolation fail before worker dispatch. A legacy trial cannot silently resume through an unblinded path.

## Proof profile

Status: proposed contract for ADR-030 Amendment 4.

### Admission and inputs

- `eval.experiment.create` accepts `taskProfile: "proof"`, explicit problem text and a nonempty `acceptanceCriteria` string array. These become the trial ticket's exact ordered criteria and task init assigns `AC-N`; do not append the implementation-trial placeholder. Reject these new criteria/QA-selection parameters on `dev` and `fix-bug`.
- Accept `qaProfileId` and `qaInputs` using the existing QA selection contract. Resolve an explicit or unambiguous project-default preset; missing/ambiguous configuration refuses. Freeze the admitted profile, inputs and farm-owned execution-template snapshot in experiment/trial identity. A template axis must match that snapshot; it cannot override the preset or select an org-skill template. Existing shared skills can be consumed without changing their bytes or behavior.
- Map `taskProfile: "proof"` to `flowType: "qa"`. Use the frozen selection at task writing/dispatch, rather than resolving current defaults again. No new flow or runner is introduced. Existing unsupported sandbox combinations refuse before dispatch.
- For merged PRs, implementation `headSha` is the resolved merge commit and QA `baseSha` is its first parent. Refuse if the stable patch identity of that range differs from the complete PR diff, including a rebase merge whose final commit is only part of the change. Git refs require an explicit resolved base and head. Package and `prior-run` sources take their full committed base/head range from retained baseline/head metadata; refuse if either is absent or the recorded change does not match that range. No new source range fields are introduced. A working-diff artifact alone is insufficient; refuse rather than silently starting without the change. General legacy-diff rehydration remains outside this profile.
- Freeze `qaSource { baseSha, headSha }`, implementation tree/diff digest and original criteria digest. Derive the selected implementation diff from exactly `qaSource.baseSha..headSha`; retain the original PR/recorded diff digest as provenance, not as a different worker scope. The worker receives that source pair and derived diff, problem and criteria. The supplied source identities are allowed; golden recipes, reference-package paths, previous proof results and judge labels are not forwarded. A golden recipe is not required to start a trial.
- Known-overlap checks use the gateway-retained reference proof artifact paths/content hashes against the selected implementation/diff/context. The bench applies its declared held-out exclusions before submitting context and retains that provenance. Refuse detected overlap; do not relabel golden proof as implementation input or certify undeclared context as clean.

### Git and filesystem boundary

- Prepare the implementation and project resources through the existing lifecycle before dispatch. The proof worker's independent Git store contains the implementation and QA base commit/tree objects as shallow snapshots, without other refs, history, remotes or alternates. QA can read base..head and validate the base commit object. Hidden proof commits are the existing reference commit set minus the admitted QA base and implementation. Those hidden commits must be unavailable; the two allowed source commits must be present.
- Extend the proof boundary's denied reads to prior task directories in this checkout and the gateway's project task/eval roots when hosted on this node, including reference inputs/packages and sibling candidate outputs. Allow the current worker task only when it is disjoint from hidden material. Retain Amendment 3's other-slot, original-Git and credential restrictions. Refuse an overlapping layout that cannot preserve this boundary.
- Deny worker writes to product and pinned input roots, including `.git`. Permit the current task output root and captured, project-declared runtime-cache roots needed by the prepared harness. Derive them from admitted task/resource configuration, not arbitrary worker paths. Canonicalize and refuse root/ancestor, tracked-product, Git or pinned-input overlap. Do not deny ordinary writes to a validated gitignored runtime cache by treating it as product code.
- Application-state actions through prepared interfaces remain available. Product-code changes are not recipe repairs. Verify head, index/worktree and admitted input identity at launch and first output. Selected recipe execution provenance must bind the same implementation; a recorded temporary source change invalidates the trial even if later restored. Never silently restore changed code and count its proof as valid.

### First output and completion

- Freeze a bounded task-artifact manifest before judging: actual recipe versions, selected attempted recipe-run packages, engine claims, report, admitted QA profile/source/criteria and worker measurements. Hash the retained bytes. A product diff alone is not this output; zero product diff must not suppress a proof package.
- Proof-specific task instructions and completion replace ordinary QA's all-cases-pass/rerun requirement. Failed, unexecuted and capture-interrupted cases settle as measured first output with their actual status/reasons; they do not request a retry, fix handoff or human decision. Ordinary QA retains its passing-suite rule.
- Missing expected output is recorded as missing/unexecuted, never fabricated proof. A manifest referencing absent bytes, digest mismatch, malformed package, scope/source drift or ownership violation is an integrity failure and still refuses. Selected failed attempts must retain their real identities, not masquerade as a passing selection. Worker AC verdicts remain engine-produced and advisory shape does not grant acceptance.
- Once first output is frozen, gateway or judge feedback cannot start another worker attempt. Existing blocked-output finalization remains a measurement with its recorded reason; it does not gain an invented judge verdict.

### Judging, replay and eligibility

- Reuse the one-shot first-output judge and artifact-only finalization. Supply frozen proof/evidence, criteria and allowed implementation context. Judge recipe/evidence fit and each AC; read recorded CI/receipts. No tests, builds, recipes, installs or probes, and no product-code fix request.
- Bind judge receipts and replay to proof-package digest plus implementation/QA-source identity. Freeze worker usage before judge usage. Replays reuse the frozen output and completed judge; they cannot replace proof bytes.
- Proof eligibility requires verified isolation, immutable implementation/input receipts and a frozen proof package. Do not compare the product patch against the supplied implementation to detect copying. Preserve explicit invalid reasons and keep package finality separate from benchmark eligibility.
- Keep the existing public-network limitation visible. Provided code may be read; undisclosed golden proof is still an answer key. Every benchmark result carries its exposure check, and possible/unknown exposure is not certified clean by a successful run or filesystem receipt. Bench context must exclude held-out golden/prior-task material, including retrieval inputs.
- Existing eval manifests/result projections expose profile and input/output identities. Legacy implementation packages retain their original bytes and interpretation; no background migration or reclassification occurs.

## Git isolation and cleanup

- For `dev` and `fix-bug`, the worker repository has its own object store, without alternates or shared worktree objects. It contains a shallow base snapshot and candidate objects only. The proof profile instead admits its implementation and QA base snapshots.
- Before implementation-trial worker launch, verify that reference answer commits are unavailable, remote URLs are absent and fetch protocols are disabled. Proof trials check hidden proof commits while admitting their explicit source pair. Recheck the boundary at dispatch and first-output capture.
- Existing slot Git metadata is retained outside the worker checkout under the trial's lease. Preparation and recovery must not fetch into the isolated repository.
- Teardown stops the owned worker, retains its candidate commits, then restores the original Git metadata before ordinary slot cleanup. Restoration is bound to the original run and slot ownership. A failed restoration keeps the slot fenced.
- A finished trial's run-end cleanup restores the original Git while the run still owns the slot; a failed restoration holds the slot for retry. With the first output frozen, the checkout then returns to idle and the candidate branch stays. A run that retains its workspace for completion replay or a result decision keeps it until that is settled; a cancelled trial kept for replay is restored when its slot is reclaimed.

## Worker boundary

- The worker starts without source-host credentials: no GitHub token variables, an empty GitHub CLI configuration, no Git credential helper and no Git SSH transport.
- Recording stand-ins in the trial capsule refuse the GitHub CLI on the worker's path and Git's credential and SSH-transport calls. Git's trace in the capsule records transports the isolated repository refuses, whichever git binary ran. A recorded attempt makes the trial invalid at first-output capture.
- A GitHub CLI call that bypasses the stand-in, by absolute path or through a shell profile that reorders `PATH`, fails without credentials but is not recorded.
- The worker runs under a macOS `sandbox-exec` profile generated from the pool at preparation. It cannot read the node's other slot checkouts, the original checkout a linked-worktree slot shares objects with, blind capsules other than its own boundary, or the GitHub CLI login.
- Worker session reloads (recovery, parking and operator resume) start under the same boundary.
- The network stays open. A blind trial on a source repository readable without credentials is not isolated by this boundary.
- Preparation fails on a node without `sandbox-exec`. Dispatch fails for a native worker and for a runner tier that applies its own sandbox. Neither path starts the worker unsandboxed.

## First output and contamination

- Freeze the first worker output's base, head, contribution diff and digest before review or a fix round can alter it. Later output cannot replace this snapshot.
- For `dev` and `fix-bug`, the gateway computes stable patch identities from the frozen candidate contribution and reference patch. A nonempty identity match makes the trial contaminated and ineligible for comparison. The proof profile uses its frozen proof package and immutable implementation receipt instead.
- Comparison eligibility is pending until an output is captured, then eligible, contaminated or invalid. Completed outputs with missing blind provenance or unavailable comparison inputs are invalid.
- Preserve the reason and source identities with the assessment. Hidden reference identities are never copied back into the worker task tree; a proof profile explicitly admits its supplied implementation identity.
- Finalized historical output packages retain their original bytes and hashes. Readers show their missing blind provenance as invalid comparison input; finality alone does not imply eligibility.

## First-output judging

- A valid completed first worker output receives exactly one configured/default reviewer as a judge, including when a review axis says none or production review is disabled. Invalid blind trials retain their package and reason without judging.
- A worker that blocks itself has its first output frozen with the blocked reason as an outcome claim. The package finalizes without a judge or person decision, like a judged output.
- Freeze worker evidence and native worker usage before the judge starts. Worker elapsed time ends at the first terminal output; reviewer time and usage remain separate. Missing measurements stay unknown.
- Preserve the judge's verdict and findings by severity. Passing and issues verdicts both finalize the artifact-only package automatically. No worker fix, send-back decision or second review follows an eval judge.
- A replay reuses the completed judge for the same frozen output. An in-flight review keeps its existing recovery identity. Changed worker evidence cannot replace the frozen facts.
- Infrastructure failures remain separate from model quality. Existing final packages and historical trials are not rewritten or rerun.

## Public surface

The protocol package owns the case, trial and result-package fields consumed by the existing eval RPCs and Command Center comparison readers. The gateway owns input validation, Git isolation, first-output capture and contamination assessment. Existing framework prepare/dispatch/teardown contracts remain the lifecycle path. Harnesses inherit the blinded task, base and worker boundary; they receive no reference lookup capability or new command. Additive wire metadata follows protocol patch versioning and the matching-reader rollout.
