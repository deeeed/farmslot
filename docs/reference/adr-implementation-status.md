# ADR Implementation Status

**Owner:** Arthur / Farmslot
**Last updated:** 2026-06-27
**Stale by:** 2026-09-27
**Authority:** Derived visibility doc. When this file disagrees with an ADR body, the ADR wins for intent; git history and `IMPLEMENTED-HISTORY.md` win for what actually shipped.

This matrix answers: **for each current ADR, what is shipped, what is partial, and what is still open?** Use it with [adr/README.md](../adr/README.md), [ROADMAP-next.md](../ROADMAP-next.md), and [IMPLEMENTED-HISTORY.md](../IMPLEMENTED-HISTORY.md).

## How to read status

| Status | Meaning |
| ------ | ------- |
| **Shipped** | Decision is implemented in `main` for its core scope; only polish/policy tuning may remain. |
| **Partial** | Foundational code or UX exists; ADR follow-ups or product closure items are still open. |
| **Not started** | Accepted/planned decision with no meaningful implementation yet. |
| **Proposed** | ADR not accepted — treat as design intent only. |

## Summary (ADR-026 – ADR-039)

| ADR | Title | ADR status | Implementation | Top open gap |
| --- | ----- | ---------- | -------------- | ------------ |
| [026](../adr/026-self-improvement-recursive-loop.md) | Self-improvement recursive loop | Proposed | Partial | Structured retrospective grading + improvement loop not fully wired |
| [030](../adr/030-replay-provenance-and-reference-evals.md) | Eval packages on run families | Accepted | Partial | Replay closure: baseline/head identity, live regression evidence |
| [031](../adr/031-deterministic-first-auto-recovery.md) | Deterministic-first auto-recovery | Accepted | Shipped | Policy tuning from audit evidence |
| [032](../adr/032-runner-observability-via-hooks.md) | Runner observability via hooks | Accepted | Partial | Phase 2 exit passed; Phase 3 pane-regex retirement |
| [033](../adr/033-mobile-tmux-worker-control.md) | Mobile tmux worker control | Accepted | Shipped | Deferred: background wake-word, auto-send, remote provisioning |
| [034](../adr/034-recipe-protocol-v1.md) | Recipe Protocol v1 | Accepted | Partial | Project migration + manifest-first UI + live self-validation |
| [035](../adr/035-node-support-bundles.md) | Node support bundles | Accepted | Partial | Gateway prepare sync; not all projects declare bundles |
| [036](../adr/036-cli-gateway-profiles.md) | CLI gateway profiles | Accepted | Partial | Core shipped; demo/onboarding rehearsal follow-ups |
| [037](../adr/037-prepare-profiles.md) | Prepare profiles | Accepted | Shipped | Automatic profile selection deferred by ADR |
| [038](../adr/038-gate-held-worker-session.md) | Gate-held worker session | Accepted | Partial | Companion gate-held affordances; optional pane-died softening |
| [039](../adr/039-run-portable-bundles.md) | Portable run bundles | Accepted | Shipped | v1.1 selectors, CC export UI, `--seed-eval` helper |

Older ADRs **001–025** are foundation/shipped for their core scope. This file does not re-audit every legacy ADR; use `IMPLEMENTED-HISTORY.md` for historical detail.

---

## ADR-026 — Self-Improvement Recursive Loop (Proposed)

**Implementation: Partial (fragments only, loop not closed)**

| ADR requirement | Status | Evidence / gap |
| --------------- | ------ | -------------- |
| Retrospective as primary grading surface | Partial | `family-observability` exists; structured proof-target checklist grading per ADR-026 not fully productized |
| Structured proof-target checklist grades | Not started | `grade-form.ts` on run-detail remains legacy three-button flow |
| Rerun verdict as scoped grade | Not started | Warm-slot rerun exists; no structured rerun-grade contract |
| Improvement proposals gated on bad grades | Partial | ADR-021 improvement-engine / `learnings.md` path exists; ADR-026 wiring into retrospective incomplete |
| Validator-loop scoring in UI | Not started | `packages/skills` validator-loop scripts are CLI-only |

**Do not schedule as shipped.** Accept ADR-026 or revise before treating the recursive loop as canonical.

---

## ADR-030 — Eval Packages and Reference Evals (Accepted)

**Implementation: Partial (foundation + cockpit shipped)**

| ADR requirement | Status | Evidence / gap |
| --------------- | ------ | -------------- |
| `EvalExperimentManifest` + `ResultPackageManifest` | Shipped | PRs #74–#78 |
| `#evals` Reference/Candidate cockpit | Shipped | Local suite builder, template provenance |
| Artifact-only comparison trials | Shipped | `lane: comparison`, `completionPolicy: artifact-only` |
| Baseline/head/diff identity on every package | Partial | Fields exist; not consistently populated on live runs |
| Gateway-owned suite runner + persisted history | Not started | Local basket fan-out only |
| Scorer execution + aggregate reports | Not started | `EvalScorerConfigRef` is catalog seam only |
| Corpus/history dashboards | Not started | Explicit ADR non-goal until replay closure |
| Portable replay delta (follow-up #8) | Not started | Artifact-only branches local-only; cross-slot hydration blocked |

**Next product lane:** replay closure on real merged PRs, not re-building the experiment model.

---

## ADR-031 — Deterministic-First Auto-Recovery (Accepted)

**Implementation: Shipped**

| ADR requirement | Status | Evidence / gap |
| --------------- | ------ | -------------- |
| Watcher + allowlisted recovery actions | Shipped | PR #82, `a371d7d` lineage on historical branches |
| Audit log + intelligence summary | Shipped | Gateway surfaces |
| Policy tuning per project/category | Partial | Opportunistic from audit evidence |

---

## ADR-032 — Runner Observability via Hooks (Accepted)

**Implementation: Partial (Phases 1–2 shipped; Phase 2 exit passed)**

| ADR requirement | Status | Evidence / gap |
| --------------- | ------ | -------------- |
| Hook installers + `hooks.jsonl` / statusline writes | Shipped | PR #81 (`e4cbcb4`) |
| `scripts/runner-validation/` harness | Shipped | Operator guide in `docs/operations/` |
| Obs-first `sendRunnerInstructionSafely` | Shipped | PRs #82–#84, `91674d9` follow-up |
| Phase 2 exit: zero `nudgeTimeoutCount` over 7 days | Shipped | `docs/operations/evidence/adr032/phase2-exit-window.json` (`exitPass: true`) |
| Committed macwork evidence snapshots | Shipped | Four JSONs listed in `docs/operations/evidence/adr032/GOAL-SCOPE.json`; closeout verifiers retired from `scripts/` |
| Phase 3: retire Claude pane-regex branches | Not started | Scheduled; exit gate cleared |
| Cursor/Grok hook path | Not started | Remain `pane-only` per ADR matrix |

---

## ADR-033 — Mobile Tmux Worker Control (Accepted)

**Implementation: Shipped (V1/M8)**

| ADR requirement | Status | Evidence / gap |
| --------------- | ------ | -------------- |
| Worker inventory + terminal + voice nudges | Shipped | 2026-05-22 sprint, ADR-033 M8 |
| Background wake-word / auto-send | Not started | Explicitly deferred |
| Remote node provisioning | Not started | Explicitly deferred |
| Companion structural refactor | Not started | Captured plan only |

---

## ADR-034 — Recipe Protocol v1 (Accepted)

**Implementation: Partial (core contract shipped, adoption incomplete)**

The protocol is **not** a future proposal. Validators, harness runtime, CLI, and self-validation **fixtures** exist. Remaining work is **rollout and dependency**, not greenfield protocol design.

| ADR / PRD requirement | Status | Evidence / gap |
| --------------------- | ------ | -------------- |
| Canonical spec `recipe-protocol-v1.md` | Shipped | `docs/reference/recipe-protocol-v1.md` |
| `validateRecipeDocument` / `validateRecipeWithManifest` / `validateRecipeArtifactPackage` | Shipped | `@farmslot/protocol` |
| Graph envelope + composition (`call`, `startState`, `proofTargets`, `phase`, `record`) | Shipped | Protocol tests + `@farmslot/recipe-harness` |
| `farmslot recipe validate` | Shipped | `packages/cli/src/commands/recipe.ts` |
| Farmslot self-validation recipe **fixtures** | Shipped | `docs/examples/recipes/farmslot/*.recipe.json` |
| Typed `artifact-manifest.json` on all project runs | Partial | Harness writes manifests; legacy runners still emit summary/trace only |
| UI manifest-first rendering (no filename inference fallback) | Partial | Gateway reads manifests when present; `inferArtifactPurpose` fallback remains |
| Mobile/Audiolab `hooks.recipe_run` alignment | Partial | Still often worker-template invoked validators |
| Live self-validation suite on real slots | Not started | Fixtures validate offline; live execution is operator harness work |
| Onboarding doc consolidation | Partial | Spec exists; `projects/README.md` not fully unified |

**Validate locally:**

```bash
cd apps/command-center
yarn farmslot recipe validate ../../docs/examples/recipes/farmslot/command-center-ui.recipe.json \
  --artifact-dir ../../docs/examples/recipes/farmslot/artifacts/command-center-ui
```

---

## ADR-035 — Node Support Bundles (Accepted)

**Implementation: Partial**

| ADR requirement | Status | Evidence / gap |
| --------------- | ------ | -------------- |
| Content-addressed bundle sync on prepare | Shipped | `services/gateway/src/node-support/`, prepare step |
| `scripts/check-node-support-bundles.ts` gate | Shipped | CI/check script |
| All hook-heavy projects declare bundles | Partial | Optional per ADR; project adoption varies |

---

## ADR-036 — CLI Gateway Profiles (Accepted)

**Implementation: Partial (operator core shipped)**

| ADR requirement | Status | Evidence / gap |
| --------------- | ------ | -------------- |
| `farmslot gateway add/use/list`, `~/.farmslot/gateways.json` | Shipped | `packages/cli` |
| `login` / `logout` / `auth status` | Shipped | Reuses pairing flow |
| Doctor Gateways section | Shipped | Reachability + auth hints |
| `farmslot up` / `down` / `pair` | Shipped | PRs #30, #46 |
| `gateway.status` update freshness + CC banner | Shipped | `70742c2` lineage |
| Portable companion pack + clean-machine rehearsal | Not started | Onboarding follow-up |
| npm-publish standalone `@farmslot/cli` | Not started | Explicitly deferred |

---

## ADR-037 — Prepare Profiles (Accepted)

**Implementation: Shipped**

| ADR requirement | Status | Evidence / gap |
| --------------- | ------ | -------------- |
| `prepare.profiles` in project.json | Shipped | PR #32 (`7ec8827`) |
| CLI/RPC/UI `prepareProfile` + `FARMSLOT_PREPARE_PROFILE` | Shipped | Gateway + `slot-prepare-options` |
| `skip_prepare_requires_health` removed | Shipped | Schema/gateway clean |
| Auto cheapest-profile selection | Not started | Explicit ADR deferral |

---

## ADR-038 — Gate-Held Worker Session (Accepted)

**Implementation: Partial (gateway shipped)**

| ADR requirement | Status | Evidence / gap |
| --------------- | ------ | -------------- |
| `holdSlotForPublicationGate` through HUMAN_GATE | Shipped | PR #62 |
| `fleet.refresh` + `slot.release` guards | Shipped | `blocksGateHeldSlotRelease` |
| Worker templates stay alive after SIGNAL | Shipped | Nested project templates |
| Companion affordances for gate-held phase | Not started | ADR consequence callout |
| Optional `pane-died` softening during gate wait | Not started | Captured follow-up |
| Session resume on relaunch | Not started | ROADMAP-next captured lane |

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