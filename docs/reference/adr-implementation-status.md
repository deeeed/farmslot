# ADR Implementation Status

**Owner:** Arthur / Farmslot
**Last updated:** 2026-06-28 (ADR-042 refresh parity shipped in PR #147)
**Stale by:** 2026-09-08
**Authority:** Derived visibility doc. When this file disagrees with an ADR body, the ADR wins for intent; git history and `IMPLEMENTED-HISTORY.md` win for what actually shipped.

This matrix answers: **for each current ADR, what is shipped, what is partial, and what is still open?** Use it with [adr/README.md](../adr/README.md), [ROADMAP-next.md](../ROADMAP-next.md), and [IMPLEMENTED-HISTORY.md](../IMPLEMENTED-HISTORY.md).

## How to read status

| Status          | Meaning                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------- |
| **Shipped**     | Decision is implemented in `main` for its core scope; only polish/policy tuning may remain. |
| **Partial**     | Foundational code or UX exists; ADR follow-ups or product closure items are still open.     |
| **Not started** | Accepted/planned decision with no meaningful implementation yet.                            |
| **Proposed**    | ADR not accepted — treat as design intent only.                                             |

## Summary (ADR-026 – ADR-042)

| ADR                                                        | Title                             | ADR status | Implementation | Top open gap                                                         |
| ---------------------------------------------------------- | --------------------------------- | ---------- | -------------- | -------------------------------------------------------------------- |
| [026](../adr/026-self-improvement-recursive-loop.md)       | Self-improvement recursive loop   | Proposed   | Partial        | Structured retrospective grading + improvement loop not fully wired  |
| [030](../adr/030-replay-provenance-and-reference-evals.md) | Eval packages on run families     | Accepted   | Partial        | Replay closure: baseline/head identity, live regression evidence     |
| [031](../adr/031-deterministic-first-auto-recovery.md)     | Deterministic-first auto-recovery | Accepted   | Shipped        | Policy tuning from audit evidence                                    |
| [032](../adr/032-runner-observability-via-hooks.md)        | Runner observability via hooks    | Accepted   | Partial        | Phase 2 exit passed; Phase 3 pane-regex retirement                   |
| [033](../adr/033-mobile-tmux-worker-control.md)            | Mobile tmux worker control        | Accepted   | Shipped        | Deferred: background wake-word, auto-send, remote provisioning       |
| [034](../adr/034-recipe-protocol-v1.md)                    | Recipe Protocol v1                | Accepted   | Partial        | Project migration + manifest-first UI + live self-validation         |
| [035](../adr/035-node-support-bundles.md)                  | Node support bundles              | Accepted   | Partial        | Gateway prepare sync; not all projects declare bundles               |
| [036](../adr/036-cli-gateway-profiles.md)                  | CLI gateway profiles              | Accepted   | Partial        | Core shipped; demo/onboarding rehearsal follow-ups                   |
| [037](../adr/037-prepare-profiles.md)                      | Prepare profiles                  | Accepted   | Shipped        | Automatic profile selection deferred by ADR                          |
| [038](../adr/038-gate-held-worker-session.md)              | Gate-held worker session          | Accepted   | Partial        | Companion gate-held affordances; optional pane-died softening        |
| [039](../adr/039-run-portable-bundles.md)                  | Portable run bundles              | Accepted   | Shipped        | v1.1 selectors, CC export UI, `--seed-eval` helper                   |
| [040](../adr/040-work-graph-orchestration.md)              | Work-graph orchestration          | Proposed   | Not started    | Proposed DAG scheduler over dispatchable backlog items               |
| [041](../adr/041-roadmap-idea-refinement-layer.md)         | Operator roadmap idea refinement  | Proposed   | Not started    | Proposed markdown roadmap/refinement/promotion layer                 |
| [042](../adr/042-slot-tracking-branches.md)                | Slot tracking branches            | Accepted   | Partial        | `release.ts` idle reset; configurable tracking branch + rebase merge |
| [047](../adr/047-worker-session-history-panel.md)          | Worker session history panel      | Proposed   | Not started    | Experimental read-only transcript mirror on active sessions          |

Older ADRs **001–025** are foundation/shipped for their core scope. This file does not re-audit every legacy ADR; use `IMPLEMENTED-HISTORY.md` for historical detail.

---

## ADR-026 — Self-Improvement Recursive Loop (Proposed)

**Implementation: Partial (fragments only, loop not closed)**

| ADR requirement                           | Status      | Evidence / gap                                                                                             |
| ----------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| Retrospective as primary grading surface  | Partial     | `family-observability` exists; structured proof-target checklist grading per ADR-026 not fully productized |
| Structured proof-target checklist grades  | Not started | `grade-form.ts` on run-detail remains legacy three-button flow                                             |
| Rerun verdict as scoped grade             | Not started | Warm-slot rerun exists; no structured rerun-grade contract                                                 |
| Improvement proposals gated on bad grades | Partial     | ADR-021 improvement-engine / `learnings.md` path exists; ADR-026 wiring into retrospective incomplete      |
| Validator-loop scoring in UI              | Not started | `packages/skills` validator-loop scripts are CLI-only                                                      |

**Do not schedule as shipped.** Accept ADR-026 or revise before treating the recursive loop as canonical.

---

## ADR-030 — Eval Packages and Reference Evals (Accepted)

**Implementation: Partial (foundation + cockpit shipped)**

| ADR requirement                                    | Status      | Evidence / gap                                                  |
| -------------------------------------------------- | ----------- | --------------------------------------------------------------- |
| `EvalExperimentManifest` + `ResultPackageManifest` | Shipped     | PRs #74–#78                                                     |
| `#evals` Reference/Candidate cockpit               | Shipped     | Local suite builder, template provenance                        |
| Artifact-only comparison trials                    | Shipped     | `lane: comparison`, `completionPolicy: artifact-only`           |
| Baseline/head/diff identity on every package       | Partial     | Fields exist; not consistently populated on live runs           |
| Gateway-owned suite runner + persisted history     | Not started | Local basket fan-out only                                       |
| Scorer execution + aggregate reports               | Not started | `EvalScorerConfigRef` is catalog seam only                      |
| Corpus/history dashboards                          | Not started | Explicit ADR non-goal until replay closure                      |
| Portable replay delta (follow-up #8)               | Not started | Artifact-only branches local-only; cross-slot hydration blocked |

**Next product lane:** replay closure on real merged PRs, not re-building the experiment model.

---

## ADR-031 — Deterministic-First Auto-Recovery (Accepted)

**Implementation: Shipped**

| ADR requirement                        | Status  | Evidence / gap                                   |
| -------------------------------------- | ------- | ------------------------------------------------ |
| Watcher + allowlisted recovery actions | Shipped | PR #82, `a371d7d` lineage on historical branches |
| Audit log + intelligence summary       | Shipped | Gateway surfaces                                 |
| Policy tuning per project/category     | Partial | Opportunistic from audit evidence                |

---

## ADR-032 — Runner Observability via Hooks (Accepted)

**Implementation: Partial (Phases 1–2 shipped; Phase 2 exit passed)**

| ADR requirement                                     | Status      | Evidence / gap                                                                                                     |
| --------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Hook installers + `hooks.jsonl` / statusline writes | Shipped     | PR #81 (`e4cbcb4`)                                                                                                 |
| `scripts/runner-validation/` harness                | Shipped     | Operator guide in `docs/operations/`                                                                               |
| Obs-first `sendRunnerInstructionSafely`             | Shipped     | PRs #82–#84, `91674d9` follow-up                                                                                   |
| Phase 2 exit: zero `nudgeTimeoutCount` over 7 days  | Shipped     | `docs/operations/evidence/adr032/phase2-exit-window.json` (`exitPass: true`)                                       |
| Committed macwork evidence snapshots                | Shipped     | Four JSONs listed in `docs/operations/evidence/adr032/GOAL-SCOPE.json`; closeout verifiers retired from `scripts/` |
| Phase 3: retire Claude pane-regex branches          | Not started | Scheduled; exit gate cleared                                                                                       |
| Cursor/Grok hook path                               | Not started | Remain `pane-only` per ADR matrix                                                                                  |

---

## ADR-033 — Mobile Tmux Worker Control (Accepted)

**Implementation: Shipped (V1/M8)**

| ADR requirement                            | Status      | Evidence / gap                |
| ------------------------------------------ | ----------- | ----------------------------- |
| Worker inventory + terminal + voice nudges | Shipped     | 2026-05-22 sprint, ADR-033 M8 |
| Background wake-word / auto-send           | Not started | Explicitly deferred           |
| Remote node provisioning                   | Not started | Explicitly deferred           |
| Companion structural refactor              | Not started | Captured plan only            |

---

## ADR-034 — Recipe Protocol v1 (Accepted)

**Implementation: Partial (core contract shipped, adoption incomplete)**

The protocol is **not** a future proposal. Validators, harness runtime, CLI, and self-validation **fixtures** exist. Remaining work is **rollout and dependency**, not greenfield protocol design.

| ADR / PRD requirement                                                                     | Status      | Evidence / gap                                                                |
| ----------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| Canonical spec `recipe-protocol-v1.md`                                                    | Shipped     | `docs/reference/recipe-protocol-v1.md`                                        |
| `validateRecipeDocument` / `validateRecipeWithManifest` / `validateRecipeArtifactPackage` | Shipped     | `@farmslot/protocol`                                                          |
| Graph envelope + composition (`call`, `startState`, `proofTargets`, `phase`, `record`)    | Shipped     | Protocol tests + `@farmslot/recipe-harness`                                   |
| `farmslot recipe validate`                                                                | Shipped     | `packages/cli/src/commands/recipe.ts`                                         |
| Farmslot self-validation recipe **fixtures**                                              | Shipped     | `docs/examples/recipes/farmslot/*.recipe.json`                                |
| Typed `artifact-manifest.json` on all project runs                                        | Partial     | Harness writes manifests; legacy runners still emit summary/trace only        |
| UI manifest-first rendering (no filename inference fallback)                              | Partial     | Gateway reads manifests when present; `inferArtifactPurpose` fallback remains |
| Mobile/Audiolab `hooks.recipe_run` alignment                                              | Partial     | Still often worker-template invoked validators                                |
| Live self-validation suite on real slots                                                  | Not started | Fixtures validate offline; live execution is operator harness work            |
| Onboarding doc consolidation                                                              | Partial     | Spec exists; `projects/README.md` not fully unified                           |

**Validate locally:**

```bash
cd apps/command-center
yarn farmslot recipe validate ../../docs/examples/recipes/farmslot/command-center-ui.recipe.json \
  --artifact-dir ../../docs/examples/recipes/farmslot/artifacts/command-center-ui
```

---

## ADR-035 — Node Support Bundles (Accepted)

**Implementation: Partial**

| ADR requirement                              | Status  | Evidence / gap                                     |
| -------------------------------------------- | ------- | -------------------------------------------------- |
| Content-addressed bundle sync on prepare     | Shipped | `services/gateway/src/node-support/`, prepare step |
| `scripts/check-node-support-bundles.ts` gate | Shipped | CI/check script                                    |
| All hook-heavy projects declare bundles      | Partial | Optional per ADR; project adoption varies          |

---

## ADR-036 — CLI Gateway Profiles (Accepted)

**Implementation: Partial (operator core shipped)**

| ADR requirement                                              | Status      | Evidence / gap            |
| ------------------------------------------------------------ | ----------- | ------------------------- |
| `farmslot gateway add/use/list`, `~/.farmslot/gateways.json` | Shipped     | `packages/cli`            |
| `login` / `logout` / `auth status`                           | Shipped     | Reuses pairing flow       |
| Doctor Gateways section                                      | Shipped     | Reachability + auth hints |
| `farmslot up` / `down` / `pair`                              | Shipped     | PRs #30, #46              |
| `gateway.status` update freshness + CC banner                | Shipped     | `70742c2` lineage         |
| Portable companion pack + clean-machine rehearsal            | Not started | Onboarding follow-up      |
| npm-publish standalone `@farmslot/cli`                       | Not started | Explicitly deferred       |

---

## ADR-037 — Prepare Profiles (Accepted)

**Implementation: Shipped**

| ADR requirement                                          | Status  | Evidence / gap                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare.profiles` in project.json                       | Shipped | PR #32 (`7ec8827`)                                                                                                                                                                                                                          |
| CLI/RPC/UI `prepareProfile` + `FARMSLOT_PREPARE_PROFILE` | Shipped | Gateway + `slot-prepare-options`                                                                                                                                                                                                            |
| `skip_prepare_requires_health` removed                   | Shipped | Schema/gateway clean                                                                                                                                                                                                                        |
| Auto cheapest-profile selection                          | Partial | Profile-fit gate + dispatch preview for `farmslot` shipped (`profile-fit-gate.ts`); ADR-037 per-flow default map still open — see [plans/farmslot-unified-project-validation-plan.md](../plans/farmslot-unified-project-validation-plan.md) |

---

## ADR-038 — Gate-Held Worker Session (Accepted)

**Implementation: Partial (gateway shipped)**

| ADR requirement                                 | Status      | Evidence / gap              |
| ----------------------------------------------- | ----------- | --------------------------- |
| `holdSlotForPublicationGate` through HUMAN_GATE | Shipped     | PR #62                      |
| `fleet.refresh` + `slot.release` guards         | Shipped     | `blocksGateHeldSlotRelease` |
| Worker templates stay alive after SIGNAL        | Shipped     | Nested project templates    |
| Companion affordances for gate-held phase       | Not started | ADR consequence callout     |
| Optional `pane-died` softening during gate wait | Not started | Captured follow-up          |
| Session resume on relaunch                      | Not started | ROADMAP-next captured lane  |

---

## ADR-040 — Work-Graph Orchestration (Proposed)

**Implementation: Not started**

ADR-040 is design intent only. It should not be implemented until a ROADMAP-next milestone accepts the v1 graph scheduler scope, after ADR-041 promotion plus the flat backlog path are proven.

| ADR requirement                                    | Status      | Evidence / gap                                |
| -------------------------------------------------- | ----------- | --------------------------------------------- |
| WorkGraph / WorkNode / WorkEdge protocol contracts | Not started | Proposed in ADR-040                           |
| Gateway graph store + action ledger                | Not started | Proposed sibling store to backlog             |
| Scheduler events and graph enqueue authority       | Not started | Proposed glue over backlog/queue/run/ci-watch |
| Command Center graph surface                       | Not started | Proposed read-only v1 surface                 |

---

## ADR-041 — Operator Roadmap Idea Refinement Layer (Proposed)

**Implementation: Not started**

ADR-041 is design intent only. It should not be implemented until a roadmap milestone accepts the markdown-backed roadmap/refinement/promotion scope; it is the prerequisite planning layer before ADR-040 graph execution.

| ADR requirement                                      | Status      | Evidence / gap                                    |
| ---------------------------------------------------- | ----------- | ------------------------------------------------- |
| `{farmslotRoot}/.roadmap` markdown index             | Not started | Proposed in ADR-041                               |
| Tmux refinement helper outside dispatch/run families | Not started | Proposed tmux runner helper, no `run.create`      |
| Roadmap promotion to backlog markdown specs with ACs | Not started | Proposed bridge to PR #95 backlog intake          |
| Roadmap/backlog/run tag convergence                  | Not started | Proposed compatibility path for existing run tags |

---

## ADR-042 — Slot Tracking Branches (Accepted)

**Implementation: Shipped (prepare/release/refresh parity in PR #146/#147)**

| ADR requirement                                   | Status  | Evidence / gap                                                                      |
| ------------------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| Idle = tracking branch @ `origin/defaultBranch`   | Shipped | `resetSlotRepoToIdle` on prepare/release/refresh; shared `tracking-branch.ts`       |
| Linked worktree reset without `checkout main`     | Shipped | `slot-tracking.ts`; fleet refresh probes `linked_worktree` into `.farm-status.json` |
| Project `slot_tracking_branch` template           | Shipped | Schema + `farmslot-farm` `wt/{{session}}`; legacy `wt/ff-*` regex shim **removed**  |
| `merge_main_strategy` rebase vs merge             | Shipped | `resolveMergeMainStrategy` in prepare merge step                                    |
| Worker `pr-complete` rebase + skip-if-current     | Shipped | ADR-042 addendum 2026-06-29; MetaMask pack templates                                |
| Contribution diff base `origin/defaultBranch`     | Shipped | `contributionDiffBaseSpec` + fetch before capture                                   |
| Per-run iteration diff (`worktreeHeadAtDispatch`) | Shipped | `iteration-diff-stat.json`; ledger prefers iteration for follow-ups                 |
| Shared idle-reset helper prepare + release        | Shipped | `resetSlotRepoToIdle` on release + refresh; prepare uses `detectLinkedWorktree`     |
| Fleet status shows tracking branch @ default      | Partial | `.farm-status.json` persists `linked_worktree`; `@ origin/main` display still TBD   |

**Follow-ups:** bash `release-slot.sh` parity doc, fleet-status `@ origin/main` display string.

---

## Index hygiene notes

These ADR index mismatches are doc-only (fix in `adr/README.md`, not by rewriting ADRs):

- **ADR-034** body is **Accepted**; index incorrectly said Proposed (fixed 2026-06-27).
- **ADR-026** remains **Proposed** — do not mark Accepted until the loop is implemented or the ADR is revised.
- **ADR-013** body still says Proposed while gateway-orchestrated runs are production — historical record; implementation is shipped.

## Maintenance

Update this file when:

1. An ADR follow-up section closes or new follow-ups are added.
2. A roadmap item moves between shipped and active execution.
3. A validator, gateway method, or UI surface makes a prior "not started" row obsolete.

After edits, sync `ROADMAP-next.md` immediate execution order and `IMPLEMENTED-HISTORY.md` if the change reflects newly shipped history.
