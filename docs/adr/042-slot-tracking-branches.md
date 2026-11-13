# ADR-042: Slot Tracking Branches for Worktrees and Idle State

**Status:** Accepted (implemented — PR #146 release/prepare parity, PR #147 refresh/fleet parity)
**Date:** 2026-06-28
**Relates to:** [ADR-022](022-slot-lifecycle-simplification.md), [ADR-024](024-run-lanes-and-run-family-model.md), [ADR-037](037-prepare-profiles.md), [ADR-039](039-run-portable-bundles.md)
**Reference:** [Worktree operator model](../operations/worktree-operator-model.md)

Amendment 3 is Accepted under Arthur's approved rule and paired text review `428c9b94`; implementation is in progress in PR #2066.

## Context

Farmslot slots map 1:1 to git checkouts — either a **primary clone** (standalone repo, can checkout `main`) or a **linked worktree** (`.git` is a file; `main` may be checked out elsewhere and cannot be checked out in the worktree).

Today idle/prepare/release behavior is **asymmetric**:

1. **Prepare understands worktrees; release does not.** `slot.prepare` allows idle worktrees on `wt/ff-*` when `HEAD === origin/defaultBranch`, resets linked worktrees to `origin/main` without checking out `main`, and checks out feature branches from that base ([`prepare.ts`](../../services/gateway/src/methods/slot/prepare.ts)). `slot.release` still runs `git checkout main` with stderr swallowed — it logs success but often leaves the worktree on the feature branch ([`release.ts`](../../services/gateway/src/methods/slot/release.ts)).
2. **Tracking branch naming is hardcoded.** `isDefaultWorktreeTrackingBranch()` only accepts `^wt/ff-[A-Za-z0-9._-]+$`. That matches the current `farmslot-wt/farmslot-*` sandboxes but cannot express MetaMask farms (`wt/mm-*`), companion-only slots, or per-pool conventions without code changes.
3. **Idle semantics are implicit.** Operators expect "slot released = back to baseline," but baseline for a worktree is **commit equality with `origin/defaultBranch` on a stable tracking branch**, not the branch name `main`. Fleet status and prepare guards encode this partially; release and bash `release-slot.sh` do not.
4. **`update-branch` in prepare creates merge commits.** `review-pr` auto-enables `mergeMain` in prepare ([`dispatch-lifecycle-steps.ts`](../../services/gateway/src/run-engine/dispatch-lifecycle-steps.ts)); prepare runs `git merge ${defaultBranch} --no-edit`. That is correct for abort-on-conflict reviewer flows but produces noisy history when chained with worker-side merges or when operators prefer rebase.

The immediate failure mode: after E2E or demo dispatches, worktrees stay on `feat/*` branches. The next prepare either fails the idle guard or dispatches from the wrong base. Manual `git checkout wt/ff-N && git reset --hard origin/main` is the current operator workaround.

This ADR does **not** change worktree provisioning (symlinks, port isolation, bundle seeding — see ADR-039 and the worktree operator doc). It standardizes **what "idle" means** and makes prepare/release symmetric.

## Decision

Introduce an explicit **slot tracking branch** as the idle checkout for each slot. Primary clones may use `default_branch` as their tracking branch; linked worktrees use a dedicated local branch pinned to `origin/defaultBranch`.

### 1. Idle contract

After `slot.release` (without `--keep-work`), a slot's repo MUST satisfy:

| Check          | Primary clone                          | Linked worktree                            |
| -------------- | -------------------------------------- | ------------------------------------------ |
| Current branch | `default_branch` (from `project.json`) | `slot_tracking_branch` (resolved per slot) |
| `HEAD`         | `origin/default_branch` (after fetch)  | same                                       |
| Working tree   | clean (existing release safety rules)  | same                                       |

`slot.prepare` without an explicit `branch` MUST accept this state. Any other branch is **working state** and MUST be normalized by release before the slot is `ready`.

### 2. Project config: `slot_tracking_branch`

Projects MAY declare a template in `project.json`:

```jsonc
{
  "default_branch": "main",
  "worktree_base": "/Users/deeeed/dev/farmslot-wt",
  "slot_tracking_branch": "wt/{{session}}",
}
```

Hook expansion substitutes slot resources (`{{session}}`, `{{slot_id}}`, etc.) the same way as recycle/health hooks. When omitted:

- **Primary clone path:** tracking branch = `default_branch`.
- **Linked worktree path:** gateway derives `wt/{{session}}` from the slot's tmux/session id (today `ff-1`…`ff-4` → `wt/ff-1`…`wt/ff-4`).

The hardcoded `isDefaultWorktreeTrackingBranch()` regex is a **compatibility shim** until all pool slots declare or derive names through this field.

### 3. Symmetric git reset in prepare and release

Extract shared helpers (names illustrative):

- `resolveSlotTrackingBranch(vars, projectJson)` → branch name
- `isLinkedWorktree(repo)` → boolean (`.git` fileMarker)
- `resetSlotToIdleBase(vars, { defaultBranch, trackingBranch, baseRef })` → resets current branch to `baseRef` (`origin/defaultBranch` or `startRef` SHA when set)

**Prepare (existing behavior, formalized):** when checking out a feature branch from idle, linked worktrees reset the **tracking branch** to `baseRef` without `git checkout main`.

**Release (gap to close):** replace `git checkout ${defaultBranch}` with the same idle reset path. Step text becomes `Returned to ${trackingBranch} @ origin/${defaultBranch}` instead of implying `main` was checked out.

Bash `scripts/release-slot.sh` and any pool `recycle_cmd` overrides SHOULD call the same contract (documented in the worktree operator model) so CLI and gateway paths do not diverge.

### 4. `merge_main_strategy` (prepare-time)

Add optional project-level default and per-prepare override:

```jsonc
"merge_main_strategy": "merge"   // or "rebase"
```

| Strategy          | Prepare command                                                           | On conflict                                              |
| ----------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| `merge` (default) | `git merge origin/${defaultBranch} --no-edit`                             | abort merge; fail prepare (current `review-pr` behavior) |
| `rebase`          | `git fetch origin ${defaultBranch} && git rebase origin/${defaultBranch}` | abort rebase; fail prepare                               |

Flow policy from [`dispatch-lifecycle-steps.ts`](../../services/gateway/src/run-engine/dispatch-lifecycle-steps.ts):

- `review-pr` — **does not** auto-enable `mergeMain` (see 2026-07-02 addendum). Optional
  `mergeMain: true` uses merge-only integration with soft-fail on conflict.
- `pr-complete`, `update-branch` — worker owns integration; prepare does not auto-merge.
- Other flows — `mergeMain` only when explicitly requested.

Rebase is opt-in because some runner templates and operator habits assume merge commits; farms with linear-history preference (e.g. `farmslot-farm`) may set `rebase` after validation.

### 5. Fleet status and operator UX

`farm-status` / slot list SHOULD show `branch: wt/ff-2` with `at: origin/main` when idle on a tracking branch, not report `main` when the checkout name differs. Prepare error messages SHOULD name the expected tracking branch, not only `default_branch`.

## Consequences

**Positive**

- Worktree sandboxes and primary clones share one idle mental model.
- Release actually returns slots to dispatchable baseline (unblocks E2E Phase 1 and daily `macwork-ff-*` use).
- MetaMask and other farms can adopt `wt/mm-*` without gateway patches.
- Operators can choose rebase vs merge for `review-pr` without forking prepare logic per project.

**Negative / migration**

- Existing pools must ensure each worktree has its tracking branch created once (`git branch wt/ff-N origin/main` or let first release create it).
- Brief window where `release.ts` still uses old path until implementation lands — treat as known bug until ADR-042 implementation PR merges.
- Before rewriting local work, retain it through the park-before-reset rule below; ownership guards still apply.

## Implementation plan

1. **Gateway:** shared idle-reset helper; wire `release.ts` to tracking-branch reset; replace hardcoded regex with `resolveSlotTrackingBranch`.
2. **Protocol:** optional `mergeMainStrategy` on `SlotPrepareParams`; project schema field `slot_tracking_branch`, `merge_main_strategy`.
3. **Tests:** release on linked-worktree fixture; idle guard with custom `slot_tracking_branch`; rebase vs merge prepare branches.
4. **Docs/ops:** update [worktree-operator-model.md](../operations/worktree-operator-model.md) idle section; `farmslot-farm` `project.json` declares `slot_tracking_branch`.
5. **Follow-up (non-blocking):** bash `release-slot.sh` parity; fleet-status branch display.

## Non-goals

- Auto-provisioning worktrees or changing `worktree_base` layout.
- Replacing worker-side `update-branch` / `pr-complete` templates. _(Superseded by 2026-06-29 addendum for `pr-complete` rebase policy; `update-branch` templates unchanged.)_
- Enforcing linear history on `main` (branch protection remains a GitHub concern).
- Cross-project tracking branch names (each project owns its template).

---

## Addendum: Worker branch integration and family diff accuracy (2026-06-29)

**Status:** Accepted  
**Relates to:** [ADR-024](024-run-lanes-and-run-family-model.md) (family observability)

### Context

Multi-round `pr-complete` families were accumulating merge commits on every follow-up when
`main` moved, and family history recorded **cumulative branch-vs-main** diffs — making each
round look like a massive change even when the worker only fixed a review comment.

ADR-042 §4 covered prepare-time `merge_main_strategy` for `review-pr` only. Worker templates
for `pr-complete` still mandated `git merge origin/main` on every run (see MetaMask pack).

### Decision

1. **Worker integration (`pr-complete`)** — rebase onto `origin/${defaultBranch}` when the branch
   is behind; skip when `origin/${defaultBranch}` is already an ancestor of `HEAD`. Record
   `integration-status` in task artifacts (`skipped` | `rebased` | `blocked`). Push with
   `--force-with-lease` after a rebase.

2. **Worker integration (`update-branch`)** — unchanged: explicit merge flow for hard conflicts.

3. **Prepare-time (`review-pr`)** — projects MAY set `"merge_main_strategy": "rebase"` in
   `project.json` (same field as §4).

4. **Contribution diff base** — gateway captures cumulative contribution diff against
   `origin/${defaultBranch}` (after fetch), not stale local `main`.

5. **Iteration diff** — at dispatch, gateway records `worktreeHeadAtDispatch` on the run. At
   complete, it also captures `dispatchHead..HEAD` as `iteration` provenance
   (`artifacts/iteration-diff-stat.json`). Family ledger and run summaries prefer iteration
   delta for follow-up runs; cumulative diff remains available for total PR scope.

6. **Follow-up `pr-complete` ledger** — when `parentRunId` is set, GitHub PR input diff is not
   treated as the authoritative display diff (iteration/contribution wins).

### Consequences

- Agent branches stay linear; fewer stacked merge commits across ci-watch chains.
- Family iteration cards show per-run code delta instead of repeating the full PR diff.
- Rebased pushes require `--force-with-lease` (agent feature branches only; not `main`).

### Non-goals (unchanged)

- Gateway auto-merge during prepare for `pr-complete` / `update-branch` (worker still owns integration).
- Enforcing linear history on protected branches.

---

## Addendum: review-pr branch-as-is prepare (2026-07-02)

**Status:** Accepted  
**Relates to:** §4 `merge_main_strategy`, [ADR-024](024-run-lanes-and-run-family-model.md)

### Context

`review-pr` auto-enabled `mergeMain` in prepare and used project `merge_main_strategy`
(often `rebase` on core farms). That blocked reviews when local rebase conflicted even
though GitHub reported the PR mergeable. Review and worker integration are different jobs:
reviewers read the PR as pushed; authors (or `pr-complete` / `update-branch` workers) resolve
integration.

### Decision

1. **`review-pr` prepare does not auto-merge or auto-rebase.** Default: checkout
   `origin/<branch>` only. Prepare never hard-fails because the author has not integrated
   latest `main`.
2. **Integration is informational in TASK.md** — `fetchPRData` records GitHub
   `mergeable` / `mergeStateStatus` on `RunTicketData.prIntegration` for the reviewer to
   comment on merge readiness.
3. **Optional integrate-main** — operator may pass `mergeMain: true` on `slot.prepare` (or
   a future run flag). For `review-pr`, integration always uses **merge commits** (never
   rebase). On conflict: abort, reset to `origin/<branch>`, warn in prepare output, continue
   review on branch-as-is.
4. **Worker flows unchanged** — `pr-complete` / `update-branch` still own integration;
   `merge_main_strategy: rebase` remains valid there via worker templates, not review prepare.

### Consequences

- Reviews no longer blocked by author rebase debt.
- Slot worktrees may review slightly stale vs `main`; TASK.md carries explicit merge signals.
- Local merge-for-review (opt-in) is disposable slot state — does not rewrite PR history.

## Addendum (2026-07-14): `update-branch` flow strategy vs prepare-time `merge_main_strategy`

The branch-maintenance follow-up flow (formerly `merge-main`) is renamed to
`update-branch` (see [ADR-024](024-run-lanes-and-run-family-model.md), MANUAL-000014).
Two related-but-distinct strategy surfaces now coexist and keep separate names:

- **`merge_main_strategy` (this ADR, §4)** — prepare-time integrate-main for
  `review-pr` opt-in (`mergeMain` on `slot.prepare`). Unchanged.
- **`BranchUpdateStrategy` (new)** — the `update-branch` flow's explicit
  `rebase | merge | project-default` policy, threaded to the worker as a task
  input (`BRANCH_UPDATE_STRATEGY`). The worker owns integration; the default
  resolver prefers `rebase` for agent-owned PR branches (`--force-with-lease`)
  and downgrades to `merge` when force-push is disallowed. `project-default`
  defers to this ADR's `merge_main_strategy`.

## Amendment 1: fleet release and update to main (2026-10-25)

**Status:** Accepted by the lead on 2026-10-25, reviewed proposal `4951004d`. Implementation: PR #1490.
**Specification:** [Fleet slot recovery](../reference/recipe-runtime-capability-contract.md#fleet-slot-recovery).
**Related:** [ADR-004](004-fleet-map.md), [ADR-022](022-slot-lifecycle-simplification.md), [ADR-054](054-run-resource-posture.md).

### Decision

Keep stale-slot selection a human decision. Command Center and Companion expose **Release and update to main** through one fleet view-model in `@farmslot/review-dispatch`. Each row shows actual branch, authoritative owner/hold, verified merged/pushed/unpushed state and commits behind local `origin/<default>` with its fetch time and a remote-advanced warning, with unknown/error states stated honestly.

The action composes existing release, idle reset and fixture-sync implementations under one fence. A primary clone ends on its configured default branch; a linked worktree ends on its tracking branch at the same remote commit. An unowned baseline checkout takes the same dispatch-blocking fence but skips teardown, preserving warm resources. Success requires free ownership, verified checkout/fixtures and zero branch/fixture stale penalty. Pressure, device, profile and source-admission rules remain unchanged.

Bulk keeps its explicitly displayed scope and existing owner/hold guards. Dirty or unpublished local work follows Amendment 3: park it before reset, without a discard choice. Unreadable local work or failed durable parking cannot authorize destruction. Existing cancelled-hold release remains a separate, owner-bound operation.

A failed or interrupted operation remains held across reconciliation and restart. The same refresh action retries against its recovery identity and fresh workspace evidence; the slot becomes ready only after verification succeeds.

### Rationale and consequences

Leftover published branches cause avoidable stale-slot decisions. Operators currently have to find separate release, refresh and fixture actions. One action should prove the existing idle contract without weakening ownership or silently discarding work.

Extend the existing Command Center fleet and refresh UI; Companion adds the corresponding progress surface through the same shared model. Replace the browser's stale-row bulk-force groups and dangerous override. Move its existing fleet calculations to the shared owner rather than keeping a second implementation. No new reclamation RPC, scheduler, job store or automatic retry daemon.

### Public surface

Reuse `fleet.status` / `fleet.refresh`, `slot.release`, `slot.refresh` and `fleet.refreshSlots`. Add optional workspace/recovery status and an opt-in release mode with expected workspace identity to the existing refresh contracts. Default refresh remains available. `@farmslot/protocol` owns the additive types and shared pure eligibility predicate; gateway and client model consume that predicate. `FleetRefreshViewModel` owns both clients' rows, scope, confirmations, requests and progress. These are additive minor package changes. Amendment 3 defines the parked-work CLI/RPC. Existing harness/provider extension points and project-owned fixture contents remain unchanged. Activation ordering belongs to the implementation's release plan.

### Required proof

Use real Git/fixtures and both authenticated fleet renderers. Seed stale eligible fixtures. Recover one through the fleet action; the next unpinned, unrestricted selection must choose it by scoring without a slot-picker decision. Also prove safe bulk scope, durable parking, protected-owner refusal and failed-operation retry after restart. No product orders, funds or model worker are needed.

## Amendment 2: automatic safe slot reuse (2026-10-27)

**Status:** Accepted. Lead approval on 2026-10-27; both independent amendment reviews approved proposal `7e7e6e19`. Implementation: PR #1515.
**Specification:** [Automatic safe reuse](../reference/recipe-runtime-capability-contract.md#automatic-safe-reuse).

### Decision

Automatic selection uses the existing guarded release and idle reset. A free
checkout's dirty or unpublished work is parked under Amendment 3 before the
incoming task is written. Local work alone does not require a picker or refusal.
Preserve the existing default/tracking branch contract.

Try candidates in admission/ranking order. Unavailable Git/node evidence or
failed parking is reported and does not prevent trying another candidate. If
none can be safely normalized, refuse with the actual reasons. Unknown ownership
never grants reset authority; unknown publication requires conservative parking
of readable local work, not a guessed publication verdict.

Use the existing recovery eligibility and owner/epoch fences. Git parked-work
receipts grant no ownership and never block checkout. Machine parking, run gate
parking and protected workspace holds retain their existing authority.

Pinned slot and skip-prepare/warm selections keep their existing paths. Never
reset a checkout still required by an active pinned warm, native or skip-prepare
successor. A post-prepare replay must verify its recorded checkout, or refuse
with an instruction to replay from prepare or earlier.

Manual and automatic proofs seed dirty/unpublished work, verify parking before
recovery, and proceed without a local-work picker or refusal.
The fleet recovery action and its shared model remain available. Normal prepare
continues to own task-specific fixture setup.

### Rationale and consequences

Published ticket branches and old default-branch heads must not strand otherwise
usable capacity. Recovery precedes the incoming task write, preserves run evidence
and never resets local work before durable parking. A failed recovery retains its existing hold.
Returning to the idle branch removes target-branch affinity for later follow-ups.

### Public surface

Existing find-slot, slot release/refresh and terminal cleanup consume the same
safety checks. Amendment 3 defines the parked-work interface; no new harness
action or daemon is introduced.

## Amendment 3: park before reset (2026-11-13)

**Status:** Accepted. Arthur approved the rule and routing; both text reviews approved `428c9b94074165ec02d5b4a703ce8ce6bc418909`. Implementation: PR #2066.
**Specification:** [Fleet slot recovery](../reference/recipe-runtime-capability-contract.md#fleet-slot-recovery).

### Decision

Use one park-before-reset rule for release, refresh, archive/close, recovery,
automatic reuse and fresh prepare. Before a permitted operation would overwrite,
delete, move off or reset unpublished commits or dirty work, extend the existing
parking owner to retain every threatened head and a stash-style snapshot of
staged, unstaged and relevant untracked work. Verify the immutable local ref
`refs/farmslot/parked/<slot>/<run-or-timestamp>/<snapshot-key>` and durably record its receipt
on the run when present and in the slot's inventory before destruction starts.
The snapshot key distinguishes every threatened head and dirty snapshot, even
at the same original HEAD; include staged/index and worktree state. Exact retries reuse their recorded key; run ID alone
is never a snapshot key. Legacy run/head and manual-slot/time/head refs stay valid.

Then proceed. Local-work classifications, stale Git evidence and #2060's
same-branch refusal no longer block eligible work. Existing owner, held-slot,
source, resource and branch-holder owner/park guards remain. Failed capture/persistence or
changing ownership still stops the operation safely, with a typed repair reason;
there is no discard-without-parking escape. `--keep-work` keeps the
checkout; a later archive parks before its own reset. Git parking is not machine
or run ownership.

Restore verifies the retained snapshot, parks threatened current work first,
and recovers into a fresh local branch. It does not revive a run, worker, review
or evidence verdict, and never writes a remote. It preserves configured posture;
it does not create a manual hold. A later dispatch may park it again. Prune through
`startRunRetention` in `methods/run/retention.ts`: default 14 days or verified
reachability of the retained tip from a remote branch, excluding backups required
by protected/in-flight operations. Dirty snapshots age out; publishing only their
original HEAD never permits early pruning. Missing replay checkpoints refuse
with truthful prune/missing provenance, never a fresh-baseline fallback. Unknown legacy age is not inferred from commit age.
This supersedes ADR-054's cancelled-delete/archive local-discard wording, not its
ownership or resource-posture rules.

### Public surface

- `farmslot slot parked list <slot>` and `farmslot slot parked restore <slot> <ref>` consume one `slot.parked` RPC with `list`/`restore` actions, scoped and authorized like slot release.
- `@farmslot/protocol` owns proposed `SlotParkedParams`, `SlotParkedResult`, `SlotParkedWorkSummary` and the extended canonical `ParkedRunCommits` receipt. The SDK transport, CLI and shared fleet model consume them; Command Center adds a slot-row line, not another Git controller.
- Existing retention consumes `FARMSLOT_PARKED_WORK_RETENTION_DAYS`, default 14. No new daemon or harness hook. Harnesses inherit parking through prepare/release.
- Contracts are additive and experimental, released with matching protocol, gateway, CLI/SDK and client readers. Old records keep only proven facts; missing snapshot/age data is not fabricated.
