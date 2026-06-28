# ADR-042: Slot Tracking Branches for Worktrees and Idle State

**Status:** Accepted (implemented — PR #146 release/prepare parity, PR #147 refresh/fleet parity)
**Date:** 2026-06-28
**Relates to:** [ADR-022](022-slot-lifecycle-simplification.md), [ADR-024](024-run-lanes-and-run-family-model.md), [ADR-037](037-prepare-profiles.md), [ADR-039](039-run-portable-bundles.md)
**Reference:** [Worktree operator model](../operations/worktree-operator-model.md)

## Context

Farmslot slots map 1:1 to git checkouts — either a **primary clone** (standalone repo, can checkout `main`) or a **linked worktree** (`.git` is a file; `main` may be checked out elsewhere and cannot be checked out in the worktree).

Today idle/prepare/release behavior is **asymmetric**:

1. **Prepare understands worktrees; release does not.** `slot.prepare` allows idle worktrees on `wt/ff-*` when `HEAD === origin/defaultBranch`, resets linked worktrees to `origin/main` without checking out `main`, and checks out feature branches from that base ([`prepare.ts`](../../services/gateway/src/methods/slot/prepare.ts)). `slot.release` still runs `git checkout main` with stderr swallowed — it logs success but often leaves the worktree on the feature branch ([`release.ts`](../../services/gateway/src/methods/slot/release.ts)).
2. **Tracking branch naming is hardcoded.** `isDefaultWorktreeTrackingBranch()` only accepts `^wt/ff-[A-Za-z0-9._-]+$`. That matches the current `farmslot-wt/farmslot-*` sandboxes but cannot express MetaMask farms (`wt/mm-*`), companion-only slots, or per-pool conventions without code changes.
3. **Idle semantics are implicit.** Operators expect "slot released = back to baseline," but baseline for a worktree is **commit equality with `origin/defaultBranch` on a stable tracking branch**, not the branch name `main`. Fleet status and prepare guards encode this partially; release and bash `release-slot.sh` do not.
4. **`merge-main` in prepare creates merge commits.** `review-pr` auto-enables `mergeMain` in prepare ([`dispatch-lifecycle-steps.ts`](../../services/gateway/src/run-engine/dispatch-lifecycle-steps.ts)); prepare runs `git merge ${defaultBranch} --no-edit`. That is correct for abort-on-conflict reviewer flows but produces noisy history when chained with worker-side merges or when operators prefer rebase.

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

Flow policy unchanged from [`dispatch-lifecycle-steps.ts`](../../services/gateway/src/run-engine/dispatch-lifecycle-steps.ts):

- `review-pr` — auto `mergeMain: true` in prepare (strategy from project config).
- `pr-complete`, `merge-main` — worker owns integration; prepare does not auto-merge.
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
- Rebase strategy can rewrite local-only commits on the feature branch if release safety checks were bypassed; keep existing dirty/unpushed guards.

## Implementation plan

1. **Gateway:** shared idle-reset helper; wire `release.ts` to tracking-branch reset; replace hardcoded regex with `resolveSlotTrackingBranch`.
2. **Protocol:** optional `mergeMainStrategy` on `SlotPrepareParams`; project schema field `slot_tracking_branch`, `merge_main_strategy`.
3. **Tests:** release on linked-worktree fixture; idle guard with custom `slot_tracking_branch`; rebase vs merge prepare branches.
4. **Docs/ops:** update [worktree-operator-model.md](../operations/worktree-operator-model.md) idle section; `farmslot-farm` `project.json` declares `slot_tracking_branch`.
5. **Follow-up (non-blocking):** bash `release-slot.sh` parity; fleet-status branch display.

## Non-goals

- Auto-provisioning worktrees or changing `worktree_base` layout.
- Replacing worker-side `merge-main` / `pr-complete` templates.
- Enforcing linear history on `main` (branch protection remains a GitHub concern).
- Cross-project tracking branch names (each project owns its template).
