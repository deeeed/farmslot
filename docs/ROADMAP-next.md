# Farmslot Near-Term Roadmap

**Owner:** Arthur / Farmslot
**Last updated:** 2026-06-25 (gate-held worker shipped PR #62)
**Stale by:** 2026-08-22

This is the canonical near-term execution roadmap for Farmslot after the dispatch comparison, bugfix local-first publication gate, eval replay cockpit, deterministic auto-recovery, flexible interactive dev work, shared dispatch queue/eval caps, worker-template selection, backlog intake, and dev publication gating. Use it with [ROADMAP.md](ROADMAP.md), [IMPLEMENTED-HISTORY.md](IMPLEMENTED-HISTORY.md), [DOCS-GOVERNANCE.md](DOCS-GOVERNANCE.md), [PRD-product.md](PRD-product.md), and the canonical chunk PRDs.

## Purpose

This document identifies what should land next. Shipped history belongs in [IMPLEMENTED-HISTORY.md](IMPLEMENTED-HISTORY.md), ADRs, archived roadmaps, and git history. This file should stay focused on upcoming work and should not retell every completed Command Center milestone.

## Current Read

Farmslot now has a first shipped replay/eval loop for evaluating agent output: worker screenshots/videos, evidence manifests, media lightboxes, artifact galleries, family observability, durable diffs, review-signal counters, retrospective learnings, Co-Pilot/log/recovery evidence surfaces, dispatch comparison lanes, a bugfix local-first publication gate, a local `#evals` Reference/Candidate cockpit, shared dispatch queue/eval slot caps, selectable worker template versions, backlog intake, and local-first dev publication gating.

The immediate product problem is no longer landing the eval foundation; PRs #74-#78 shipped that foundation. The problem is **turning shipped eval packages into a reliable regression program**. When we adjust prompts, worker templates, recipe-runner behavior, model/runner configuration, flexible interactive-dev workflow, or the recipe protocol itself, Farmslot should be able to recreate previous PR outcomes as artifact-only Candidate packages and compare them against known-good Reference packages with diffs, visual evidence, validation evidence, review signals, time/cost, and explicit package comparison pairs. The new Generic Recipe Protocol v1 proposal in [plans/generic-recipe-protocol.md](plans/generic-recipe-protocol.md) is the planning surface for standardizing the recipe graph envelope, typed artifact manifest, and Farmslot self-validation recipes that make those comparisons trustworthy.

This continues to extend the existing run-family/lane/run model from ADR-024 and add evals over result packages, rather than create a second top-level replay taxonomy or a separate line concept. The shipped near-term eval lane is incremental: single-case experiment/package foundation, dataset/suite/scorer boundary, local suite-builder fan-out, shared dispatch-queue slot caps, and worker-template version selection are complete; remaining gateway-owned suite history, scoring/reporting, and corpus/history surfaces wait until replay closure is reliable.

The dev-flow publication decision is no longer open: PR #96 shipped the local-first dev publication gate on top of PR #83's flexible interactive starts. Backlog Dispatch is also no longer a captured-only lane: PR #95 shipped durable backlog intake, guarded handoff into the existing queue, and a Command Center backlog surface. The 2026-05-22 mobile sprint also shipped the Companion operator-control lane: authenticated gateway profiles/pairing, Android device targeting, before→after/evidence/workspace navigation hardening, fullscreen/safe-area viewer fixes, foreground voice nudge groundwork, and registered-node tmux worker discovery/control with xterm/PTY streaming. Because PRs #88-#94 decomposed many high-churn Command Center surfaces and the mobile sprint touched many high-churn phone surfaces, the immediate safe follow-up is a short UI/UX stabilization pass across newly shipped operator flows before resuming deeper replay/corpus expansion.

## Immediate Execution Order

1. **Run a short operator UI/UX stabilization pass.** Exercise the recently changed Command Center surfaces (`#evals`, `#backlog`, dispatch, run detail/family observability, slot view, ready/review workspaces, and dev publication gate) plus the newly shipped Mobile Companion operator surfaces (active runs, artifacts/diff/recipe workspaces, PRs, terminal, and Workers). Fix concrete regressions and polish issues found during real operator use. This is stabilization of shipped roadmap work, not a new product lane; small run-history curation affordances such as operator tags for demo/review collections belong here. Companion structural refactor (screen controllers, feature folders, shared workspace kit) is captured in [plans/companion-ui-architecture-refactor.md](plans/companion-ui-architecture-refactor.md).
2. **Start Generic Recipe Protocol v1 as the replay/evidence substrate.** Use [reference/recipe-protocol-v1.md](reference/recipe-protocol-v1.md), [ADR-034](adr/034-recipe-protocol-v1.md), and [plans/generic-recipe-protocol.md](plans/generic-recipe-protocol.md) to formalize the mandatory `validate.workflow` graph envelope, typed artifact manifest, additive composition/start-state semantics, and proof-window evidence phases before deeper replay/corpus expansion depends on unstable recipe evidence.
3. **Close remaining package provenance and real-run capture gaps.** Worker-template version selection is shipped, but durable replay still needs actual eval baseline SHA, candidate head/diff identity, complete real-run manifests, richer task-profile metadata, typed recipe artifact semantics, and clearer missing-data semantics before evals can be treated as a regression program.
4. **Use eval packages to validate prompt/template/harness changes.** The first practical target is evaluating whether recipe/video/base-flow/template/protocol changes recreate prior PR quality better or worse.
5. **Promote replay from queued cockpit execution to durable operator workflow.** The shared dispatch queue, eval slot caps, and template selection are shipped; add gateway-owned suite history, corpus/history views, and reporting only after replay closure is trustworthy.
6. **Tune deterministic auto-recovery from audit evidence.** ADR-031 is implemented; the next work is policy tuning, category coverage, degraded/dead-letter UX, and Co-Pilot/intelligence consumption of recovery evidence.
7. **Ship runner observability via runner hooks (ADR-032).** Execute [plans/runner-observability-hooks-phase1.md](plans/runner-observability-hooks-phase1.md). Motivated by the 2026-05-21 mm-3 regression (`· Composing…` spinner not in regex set, coincided with the operator's first Claude version upgrade). **Phase 1 shipped (PR #81):** Claude + Codex hook installers, gateway `event-driven` Codex scope, tmux E2E gate (`scripts/e2e-tmux-runner-validate.sh`), and the **`scripts/runner-validation/` harness** — per-runner launch adapters plus tmux scenarios for hook smoke, prompt-accepted digest correlation, turn boundaries, busy-composer pane fixtures, permission-mode checks, **pane-smoke** (Cursor/Grok), and **interaction-smoke** (Grok production TUI path). Operator guide: [operations/runner-validation-harness.md](operations/runner-validation-harness.md). **Phase 2 (in flight):** hooks authoritative for `event-driven` runners — `sendRunnerInstructionSafely` prefers `RunnerObservability` with pane fallback; 10 s hook-path timeout via `resolveSafeSendTimeoutMs()`. Cursor/Grok stay `pane-only`. Phase 2 exit: `Run.metrics.nudgeTimeoutCount` zero over 7-day window on Claude slots; optional agreement-log triage (no fixed event-count gate). Phase 3: retire Claude-only pane regex branches after one Claude minor upgrade under Phase 2.
8. **Run the OpenShell-backed slot runtime spike.** Use [plans/openshell-slot-runtime-spike.md](plans/openshell-slot-runtime-spike.md) to prove whether OpenShell belongs in Farmslot as a slot runtime sandbox backend rather than just another runner. Keep the first slice wrapper-based on a non-mobile/headless slot: create/reuse one sandbox, launch a supported inner agent, sync `SIGNAL.json` and `artifacts/` back to the host slot repo, and decide whether to promote the result into an ADR.
9. **Make the CLI a generic multi-gateway client ([ADR-036](adr/036-cli-gateway-profiles.md)).** Adopt the Companion's shipped authenticated gateway profiles/pairing model (ADR-033 lane) in the `farmslot` CLI: kubeconfig-style profiles (`farmslot gateway add/use/list`, `--gateway <name>` override, `~/.farmslot/gateways.json`), `farmslot login`/`logout`/`auth status` reusing the existing pairing/auth flow, and a per-profile Gateways section in doctor (reachable + authenticated with fix hints, mirroring the onboarding runner-state model). No new gateway protocol surface; local single-gateway flows stay unchanged. npm-publishing `@farmslot/cli` as a standalone client is explicitly deferred until profiles/auth prove out — the CLI runs from the workspace clone today. **In-flight extension (PR #30):** one-command local onboarding on top of this profile model — `farmslot up`/`down` (token-auth gateway as a managed background service, dashboard served from the gateway port via the built UI bundle), `farmslot pair` (LAN/Tailscale pairing QR for the Companion, reusing `pairing.create`/`pairing.exchange`), and an install.sh pair-your-phone step with live step progress. Follow-ups after merge: make the `farmslot-companion` pack portable (drop the hardcoded `primary_repo` machine path) so the bundled Expo app is the zero-setup demo target on org machines, run one clean-machine `curl | bash` rehearsal, and validate the phone scan→tmux leg end-to-end. **Update-available surface (shipped):** because Farmslot has no semver release stream — `farmslot update` fetches and resets the clone to origin's default branch — "a new version is available" means the local HEAD is behind `origin/<default-branch>`. A read-only `gateway.status` RPC reports `{ version, update: { commitsBehind, commitsAhead, localSha, remoteSha, branch, lastChecked, error } }` from a TTL-cached `git fetch` against the gateway's own clone; the Command Center renders a dismissable banner (re-shows when the remote SHA advances) linking to `farmslot update`, and `farmslot doctor` gains an offline `Updates` section comparing against the last-fetched tracking ref. No semver/tag adoption and no one-click in-app update yet — both are deferred until the freshness signal proves out.
10. **Ship prepare profiles — project-defined slot entry points ([ADR-037](adr/037-prepare-profiles.md)).** Replace the binary warm/cold prepare with named profiles declared in `project.json` (`prepare.profiles`): each profile selects a subset of the optional cost phases (`git`, `fixtures`, `deps`, `preflight`, `health`), may override hooks for its run, and declares machine-checkable preconditions (`deps_current`, `dev_server_up`, `health_ok`) with a deterministic fallback profile when a check fails. Selection is operator-driven (`--prepare-profile`, `run.create` param, wizard dropdown) with `prepare.default` when unset; every hook invocation exports `FARMSLOT_PREPARE_PROFILE`. `skipPrepare` stays as the one clean binary ("run no preparation at all", operator-owned, no health gating); the hardcoded warm hack — `skip_prepare_requires_health` schema prop and run-engine warm-reuse special case — is deleted, its use case expressed as a minimal profile (e.g. `attach` with `phases: ["health"]`, `fallback: "full"`); projects with no `prepare` block keep today's behavior unchanged. First consumers: MetaMask branch-switch relaunch (checkout + fixtures + incremental relaunch instead of full 20-min prepare) and backend-style deps-only prepares with non-CDP health. Automatic cheapest-profile selection, per-flow-type default maps, and profile-aware slot scoring are explicitly deferred.
11. **Migrate Farmslot capture/recording callers to the published `capture-helper` package.** The standalone package is available via npm/Homebrew and provides the generic macOS window discovery, permission diagnostics, native MP4 recording, snapshot, and human/JSON listing UX that Farmslot's internal capture-helper grew toward. Farmslot should stop carrying bespoke capture-helper behavior in runner plans and instead depend on the published tool at the integration boundary: install/doctor checks in node setup, stable JSON selectors for agents, raw H.264/framed stream for live capture, native `record` for evidence MP4s, and explicit `list --all --json` debugging when agents need offscreen/system windows. This is a migration/refactor lane, not a new capture product lane; keep project-specific simulator/slot/window selection in Farmslot and pass concrete macOS targets to `capture-helper`.

**Shipped current-state note:** Mobile Tmux Worker Control is not a remaining protocol lane. [ADR-033](adr/033-mobile-tmux-worker-control.md) is implemented through M8: gateway/node inventory, worker-ref terminal control, hook/status enrichment, node-level branch/activity summaries, Companion worker list/terminal, shortcut keys, foreground voice nudges, authenticated node redeploy hardening, live tmux parser validation, Android real-device smoke, iOS simulator launch smoke, optional per-node `tmux_workers` include/exclude policy, and the follow-up xterm/PTY streaming + keyboard/drag polish are complete. Remaining mobile work belongs under the stabilization pass unless it explicitly targets deferred scope such as background wake-word, auto-send without tap, or remote node provisioning.

## Decision: What Lands Next

### 0. Shipped Foundation — Bugfix Local-First Publish Gate

**Status:** shipped in `a1abcb99` / PR #73 (2026-05-08).

**Planning artifacts retained for history:**

- `.omx/plans/prd-bugfix-local-first-publish-gate.md`
- `.omx/plans/test-spec-bugfix-local-first-publish-gate.md`
- `.omx/plans/plan-bugfix-local-first-publish-gate.md`
- `.omx/plans/prd-review-depth-final-live-validation.md`

**Shipped capability:** bugfix completion can prepare a local PR package and gate public publication behind a reusable operator cockpit. The shipped lane includes review provenance, configurable review depth, local package/hash/head guards, draft-vs-ready publication target, publication-status guards for CI/rehydrate, reusable ready workspace surfaces, diff/evidence review affordances, flow graph/pipeline visibility, and dev-harness fixtures.

**Why it matters for the next lane:** eval packages can now build on a cleaner local-first boundary instead of extending premature public PR mutation behavior.

### 1. Shipped Strategic Evaluation Lane — Eval Package Template Regression

**Status:** shipped through PRs #74-#78 (2026-05-09 to 2026-05-12). This intentionally jumped ahead of the dev-flow publication decision.

**Planning artifacts:**

- `.omx/plans/full-reference-eval-template-regression-roadmap.md`
- `docs/adr/030-replay-provenance-and-reference-evals.md`

**Shipped product capability:** an operator can seed eval cases from merged GitHub PRs, prior runs, packages, or git refs; choose References in a sortable date-aware picker rather than an intrusive inline browser; launch artifact-only Candidate packages with different template/prompt/harness/base-recipe/runner/model axes through the single-case experiment APIs; and compare package diffs, visual evidence, validation evidence, review signals, time, cost, and captured template provenance.

**Foundation success:**

- `EvalExperimentManifest` + `ResultPackageManifest` are the semantic source of truth.
- `EvalDatasetManifest` + `EvalSuiteDraftManifest` define only catalog/draft intent; a suite creates or links many single-case experiments later, not one giant experiment.
- `EvalScorerConfigRef` records future scoring intent only; score values, reports, and exports remain later work.
- PR #78 adds a local suite builder over hydrated PRs/runs and manual package/git-ref entries; it fans out by creating/reusing one single-case experiment per selected case.
- `datasetId` stays grouping metadata for a selected basket/suite draft and is excluded from single-case `experimentKey`; any pre-release local experiments keyed with dataset membership should be recreated.
- Candidate runs reuse the `dev` carrier but persist task semantics through `taskProfile`.
- Parallel candidates use `lane:'comparison'`, a unique `variant`, and `completionPolicy:'artifact-only'`.
- Candidate variants are generated from selected task profile/template/runner/model dimensions by default; manual identity fields are advanced overrides.
- New generated tasks capture `inputs/template-provenance.json` with the exact template content hash and project/farmslot commit provenance used at launch; older local artifacts can simply show template provenance as missing data.
- Follow-up UX should discover project-owned worker template versions (for example `templates/worker/fix-bug.md`, `fix-bug-v2.md`, `fix-bug-v3.md`) as selectable Candidate axes. Eval template choice renders/injects the selected template into the artifact-only task and records provenance; it must not sync fixtures or overwrite the slot's default template file.
- The UI and ADRs must keep the model self-documenting and product-first: case → candidate strategy → artifact-only trial → result package → experiment, while lane/variant/mode/flow carrier remain runtime mapping details.
- No singular legacy eval manifest/API bridge is retained.
- UI renders selected experiment packages by case/strategy/trial and package evidence instead of generic before/after guesses.

**Explicit non-goals that remain after the shipped cockpit:**

- claiming the full eval/corpus product is complete,
- gateway-owned suite projection/history, or running `EvalSuiteDraftManifest` files beyond the shipped shared dispatch queue fan-out and slot caps,
- writing `EvalDatasetManifest` or `EvalSuiteDraftManifest` files from the PR #78 UI-local basket,
- scorer execution, score persistence, aggregate reports, or export adapters,
- generalizing bugfix publication review depth into global eval policy,
- adding a new replay/reference `FlowType`,
- adding corpus/history dashboards or external eval exports.

### 2. Planned Follow-Up — Generic Recipe Protocol v1

**Status:** planned PRD proposal; implementation should begin only after explicit approval.

**Planning artifacts:** [reference/recipe-protocol-v1.md](reference/recipe-protocol-v1.md), [ADR-034](adr/034-recipe-protocol-v1.md), and [plans/generic-recipe-protocol.md](plans/generic-recipe-protocol.md).

**Goal:** standardize Farmslot recipes around the existing `validate.workflow` graph envelope while preserving project-native runner/adapters. The work should make recipe evidence portable across Extension, Mobile, Audiolab, future backend/web/macOS projects, Command Center, Gateway, and Mobile Companion without rewriting existing project validators.

**Placement rationale:** this belongs before deeper replay/corpus productization because eval packages depend on trustworthy recipe artifacts, replay semantics, and artifact viewers. It also belongs after the immediate UI stabilization pass because the current operator surfaces are already high-churn.

**Required v1 outcomes:**

- formalize the mandatory `validate.workflow` graph envelope;
- keep flat recipes valid while adding optional `uses`, `call`, `startState`, `proofTargets`, `phase`, and `record` semantics for composed recipes;
- preserve Extension/Mobile/Audiolab validators as reference implementations;
- specify a Farmslot compatibility validator for graph envelope + artifact package + flow catalogs;
- add a typed artifact manifest so UI surfaces do not rely only on filename inference;
- define UI-class replay/slow-playback expectations separately from backend/batch expectations;
- plan Farmslot self-validation recipes for Command Center web UI, Gateway RPC/API, Mobile Companion, recipe replay, artifact viewer, and ready/review workspaces;
- consolidate `docs/reference/recipe-runner-protocol.md`, `projects/README.md`, and new-project onboarding examples.

### 3. In-Flight Follow-Up — `@farmslot/skills` recipe-first adoption kit

**Status:** implementation is in progress on the `@farmslot/skills` package branch.

**Goal:** make Farmslot useful before a project adopts the full framework. A user should be able to install a small skill pack, ask an agent to create or review a proof recipe, and produce a credible evidence plan with no gateway, pool, Command Center, or multi-machine setup.

**Placement rationale:** this is the external adoption wedge for Generic Recipe Protocol v1. The recipe specification becomes more valuable if agents can apply it inside arbitrary projects through low-friction skills, then graduate to `@farmslot/recipe-harness`, `@farmslot/expo-recipe`, project hooks, and Command Center only when useful.

**Branch package shape:**

- add `packages/skills` as the npm-distributed `@farmslot/skills` package;
- define `recipe-doctor`, `recipe-cook`, `recipe-harness`, `recipe-quality`, and `project-adopt` as the initial generic skill set;
- support install targets for Claude, Codex, Cursor, and generic `.agents/skills` folders;
- keep the first-run flow recipe-only and project-local;
- document the adoption ladder: skills only → generic `recipe` front-controller → project runner → project recipe layer → Farmslot project integration → full framework;
- plan a thin generic `recipe` CLI front-controller that discovers project recipe config, renders actions/flows/artifacts, and delegates `doctor`, `status`, `launch`, `refresh`, `record`, and `run` to platform/project adapters;
- avoid private/project-specific assumptions so domain packs such as domain-specific skills can layer on top instead of forking the generic recipe concepts.

### 4. Active Follow-Up — Replay Closure and Evidence Use

**Status:** active next.

**Goal:** make shipped eval packages reliable enough to judge prompt/template/harness changes and to support later corpus/reporting work.

**Required closure before treating evals as a durable regression program:**

- complete real-run manifest capture and baseline SHA semantics for all Reference/Candidate sources;
- tighter candidate head/diff identity and task-profile metadata;
- clearer missing-data vs not-yet-captured evidence semantics in family projection and package panels;
- reproducible template provenance from project-owned worker templates without slot-side default-template overwrites is now shipped at selection/render time; continue hardening it with real replay evidence rather than reopening the mechanism;
- enough live replay runs to verify the local cockpit's Reference/Candidate model beyond dev-harness data;
- a crisp boundary for when queued local basket execution graduates into gateway-owned suite history.

### 5. Shipped Follow-Up — Dev Flow Publication Model

**Status:** shipped in PR #96 (2026-05-15).

**Shipped capability:** `dev` now uses local-first publication gating instead of publishing before operator validation. Interactive dev runs can select project-owned templates, prepare local workspace packages, require human package approval before public PR publication, and optionally require independent review according to project policy. `dev-interactive.md` is the operator-driven template when present; autonomous dev publication stays behind the same local validation boundary.

**Remaining work:** treat dev publication as an operator-hardening and evidence-consumption surface. Fix concrete UI/UX issues found during real usage, and use eval packages to compare workflow/template quality if the gate policy needs further tuning. Do not reopen the pre-PR #96 binary decision unless real evidence shows the local-first model is wrong.

### 6. Later Lanes / Captured Backlog

The remaining future lanes should not displace eval packages unless they become blockers. The list below also calls out items that are implemented history, so they are not accidentally scheduled again.

#### Recently implemented / do not reschedule as future roadmap

These were previously future-looking backlog items, but the codebase now shows them implemented. The raw plan files have been deleted or promoted into canonical docs; reopen these lanes only for concrete defects or follow-up polish.

- **Runs/family readiness analytics** shipped in `695f068` / PR #59 with `RunFamilyReadinessSummary`, project analytics, opt-in `run.list` summaries, state hydration, run-list badges/cards, and helper tests.
- **`#runs` shareable URL state and family-row summaries** shipped in `6806adf` / PR #60.
- **No-change bug-fix terminal outcomes** shipped in `2db5901` / PR #61 with `already_fixed` / `not_reproducible` dispositions, evidence-backed no-change human gate payloads, and CI-watch/self-review skip behavior for no-code outcomes.
- **Fleet “Refresh idle slots” bulk modal** shipped in `be9b683` / PR #63, with later polish in `7e2aaa3`.
- **Slot history viewer / slot context recovery** shipped in `a297973` / PR #65.
- **Co-Pilot session-owned confirmed actions and write-action tightening** shipped across `c7c470d` / PR #57 and `fc0aaa0` / PR #66. Future Co-Pilot work should be framed as consuming gate/eval evidence or adding specific durability/test seams, not as first-time session-owned action support.
- **Family evidence filter + lightbox provenance + PR-evidence helper** shipped in `60e282c` / PR #69 — kind-based evidence filter chips, lightbox provenance footer, and shared `pr-evidence` helper.
- **Dispatch wizard family-detection + in-wizard comparison entry + tmux-observable prepare flow** shipped in `1ebf9c9` / PR #70 — `nextFreeComparisonVariant()`, wizard prior-run banner/picker with same-runner/same-model variant collision handling, `DecisionAction.description` operator subtext, run-detail auto-jump on `start-comparison`, and a tmux-window prepare wrapper that fixes FORCE_COLOR pod-install poisoning and surfaces live prepare logs to operators via `tmux attach`. Manual slot.release/recycle progress streaming and configurable self-review retries/timeout rode along on the same branch.
- **Family retro view — interactive pipeline + linkified refs + diff modal** shipped in `af91315d` / PR #71.
- **Bugfix local-first publication gate and review-depth cockpit** shipped in `a1abcb99` / PR #73 — local PR package/hashes, publication-status guards, review provenance/depth, draft-vs-ready target, reusable ready workspace surfaces, diff/evidence/artifact review affordances, and flow graph visibility.
- **Eval replay cockpit and package model** shipped across PRs #74-#78 — artifact-only reference evals, `EvalExperimentManifest`/`ResultPackageManifest`, dataset/suite/scorer catalog seams, `#evals` Reference picker and Candidate setup, startRef replay policy, template provenance, and family-observability projection.
- **Fixture sync WAN reliability** shipped in `c943bf32` / PR #81 — SSH ControlMaster/ControlPersist reuse for remote fixture copy and a wider gateway fixture-sync budget.
- **Deterministic-first auto-recovery** shipped in `a371d7d` / PR #82 — ADR-031 watcher, audit logging, allowlisted typed recovery actions, project config, intelligence summary surface, and protocol `0.5.0`.
- **Flexible interactive dev intake** shipped in `ce8fdb5` / PR #83 — freeform interactive `dev` starts, `DEV-*` identities, lightweight/reviewed profiles, `dev-intake.json`, `CHECKLIST.md`, and operator-owned completion actions.
- **Task-dir collision prior-run redirect** shipped in PR #85 (2026-05-13) — collision detection moved earlier to avoid wasting LLM/FS work, prior run IDs are carried in decision payloads, and run/slot UI surfaces richer prior-run context for comparison redirection.
- **Shared dispatch queue and eval slot caps** shipped in PR #86 (2026-05-14) — normal dispatches and eval cells share one priority backlog, eval matrices can cap active slot usage, queued eval cells sync back to run/package telemetry, and queue slot selection uses a no-typing fleet picker with disabled ineligible rows.
- **Worker template version selection** shipped in PR #87 (2026-05-14) — dispatch and eval flows can choose project-owned worker template versions without slot-side default-template overwrites, and generated tasks retain template provenance.
- **Command Center quality/refactor hardening** shipped across PRs #88-#94 (2026-05-14 to 2026-05-15) — slot/run/family/workspace/eval/dispatch mega-surfaces were decomposed behind model/render/style/url-state seams, protocol/backend legacy seams were split behind compatibility facades, quality baselines were ratcheted, and GitHub Actions now enforce Command Center quality gates.
- **Backlog dispatch intake** shipped in PR #95 (2026-05-15) — durable backlog items, gateway APIs, project config, guarded handoff into the existing dispatch queue, and a Command Center `#backlog` surface let operators shape work before it reaches a slot while preserving direct Jira/GitHub dispatch.
- **Dev publication gate** shipped in PR #96 (2026-05-15) — interactive/autonomous dev runs now prepare local workspace packages and gate public PR publication behind operator approval and optional independent review, reusing local-first publication policy instead of pre-approval public PR mutation.

#### Captured but should be re-planned before execution

- **Backlog Dispatch follow-ons** — PR #95 shipped V1 intake and guarded queue handoff. Do not reschedule the captured implementation lane as future work. Re-plan only concrete V2 items such as Jira/GitHub write-back, rough-idea refinement, auto-dispatch policy expansion, or backlog intelligence after real usage exposes a need.
- **Dev flow publication gate follow-ons** — PR #96 shipped the publication model. Do not re-plan the original decision lane. Reopen only for evidence-driven tuning after real interactive/autonomous dev runs show a gap.
- **Fuller cross-runner review skill/productization** — current `.agents/skills/fs-cross-review-loop/` and shipped bugfix-gate review-depth policy are enough for day-to-day use. Productize only if the gate/eval-package loop exposes gaps.
- **Worker phase decomposition and sub-agent cost roll-up** — captured as a strategic lane, but should wait until eval packages provide a reliable way to compare harness changes. Run a new `$deep-interview`/`$plan --consensus` before implementation.

- **Gate-held worker session (publication + review gates)** — **Shipped (PR #62, [ADR-038](adr/038-gate-held-worker-session.md)):** local-first `dev` / `fix-bug` defer agent teardown from COMPLETE to FINALIZE; `holdSlotForPublicationGate` keeps `busy` / `review-gate` / `agent: working` through HUMAN_GATE; `fleet.refresh` preserves gate-held rows via `blocksGateHeldSlotRelease`; `slot.release` blocks while a gate-held run is active; engine blocked/failed paths call `teardownGateHeldAgentsIfNeeded`; operator `run.cancel` kills agents via `killAllAgentWindows` / `killAgentInSession` then `resetSlot`. Metamask `dev.md` / `fix-bug.md` templates instruct stay-alive after `SIGNAL.json` (nested project repo). **Remaining:** Companion UI affordances keyed off gate-held phase; optional `pane-died` softening during gate wait; session-resume on relaunch as fallback when runner still exits ([PRD-runner-execution-canonical.md](PRD-runner-execution-canonical.md) §2).

- **Optional runner session resume on relaunch/fix paths** — captured follow-up from the 2026-06 self-review fix-loop incident (worker completed, `dev` pane died, fix feedback landed on the wrong tmux target and relaunch started a cold session). Today dispatch captures `runnerSessionId` / `runnerSessionPath` onto `run.metrics` and the primary `AgentContext` via `captureRunnerSessionMetadata`, but relaunch sites (`relaunchWorkerForFix`, `ci-monitor/inline-fix`) always call `buildLaunchCommand` for a fresh TUI — no `--resume` / Codex continue / Grok resume. The registry already models `continueCommand` (Claude `/continue`, Codex natural-language nudge) and `persistsSessionFiles`, but there is no launch-time `resume` capability or per-runner matrix entry. **Prerequisites before implementation:** (1) durable, per-role session identity on every `AgentContext` (worker vs review), not only primary dispatch and `run.metrics`; (2) registry fields for launch-time resume (`resumeLaunchArgs` or equivalent) distinct from in-pane `continueCommand`; (3) explicit runner coverage — Claude `--resume <id>`, Codex `codex --continue` at launch vs nudge when alive, Grok `sessions`/`resume` once transcript/session discovery is trustworthy ([ADR-032](adr/032-runner-observability-via-hooks.md) matrix still marks Grok metadata null); Cursor/OpenCode remain non-resumable until the runner exposes stable session files; (4) a three-step fallback ladder gated behind project/run policy: nudge when the runner is still alive under the canonical named target → resume launch when session files exist and validate → fresh launch plus `SELF-REVIEW-FIX.md` / CI fix artifact; (5) relaunch paths must keep using named role windows (`dev`, `self-review`) so resume does not target metro/shell panes. **Non-goals:** mandatory resume for all flows, cross-runner handoff (resume Claude session from a Codex relaunch), or replacing fix-artifact delivery when resume is unavailable. Aligns with [PRD-runner-execution-canonical.md](PRD-runner-execution-canonical.md) §2 (runner-neutral resume/recovery contract). Re-plan with a short capability matrix test suite before wiring orchestrator defaults.

- **Dispatch-time nudge router (PRD)** — `docs/plans/dispatch-time-nudge-router.md` captures the structural fix for the regression class that motivated the 2026-05-21 mm-3 patches. Today the wizard pre-commits nudge/fresh at `run.create` time (`services/gateway/src/methods/run.ts:407-446`); the gate (`methods/dispatch/preview.ts:418-445`) throws on drift, breaking replay/auto-recovery/restart. PRD proposes a non-throwing router predicate at DISPATCH-step time; wizard becomes a hint provider, three-phase migration ending with retirement of `engineState.flags.nudgeReuse`. Independent of ADR-032 (composes with it but does not depend on it). Phase 1 is additive (no behavior change) and ships standalone.

- **Pipeline-ops analytics event stream + dashboard** — `docs/plans/pipeline-ops-analytics-goal.md` proposes durable, queryable analytics about how the dispatch pipeline performs over time (per-step bottleneck map, failure rate by step, self-review/CI loop counts, nudge rate, wall-vs-idle split) filterable by project, host, flow, runner, model, and time. Key design decision: analytics live in a **decoupled append-only per-run record** (NDJSON, embedded step array) written at the terminal transition, so run history — including failed runs — stays prunable without losing the signal. First-pass aggregation over current live runs found timing/durations/nudges fully reliable, but cost/tokens populated on 0% of runs and failures never persisted (no `error` step status survives), so three minimal forward-capture additions are scoped: normalized failure reason codes, a host-load snapshot at prepare start, and persisted prepare substep timing. Distinct from the eval-corpus dashboard non-goal above and from ADR-032 runner-state hooks; cost-per-PR is explicitly deferred to the sub-agent cost roll-up lane. Status: V1 implemented in PR #48 (sink + emit/backfill, `analytics.query`/`analytics.backfill`, `farmslot analytics` CLI, and the `#analytics` dashboard). Follow-ups: trend/time-series + regression detection, template/model comparison view, and cost-per-PR once token extraction is reliable.
  - **Family-compare view (template/model comparison view, slice 1)** — the operator-facing first slice of the template/model comparison follow-up. Scoped to **within-family** comparison (one project + root ticket, the existing `lane: 'comparison'` siblings from ADR-024), the common case being 2 runs side-by-side and up to ~4 for model/runner bake-offs (e.g. `comparison-opus` / `-codex` / `-cursor` / `-grok`) and eval replay variants (`startRef` trials). UI-only: reuses `RunMetrics` + `FamilyObservabilityRunSummary` (already carries `metrics`), no new protocol types or gateway capture. Replaces the flat comparison-card grid in `family-observability-comparison-renderers.ts` with tabs: a sortable **efficiency leaderboard** (duration, output tokens, nudges, turns, diff, recipe-quality, self-review, CI; per-column winner badges; `costEstimate` excluded as unreliable), an **N-column metric matrix** generalized from the 2-column `run-compare`, and a **visual evidence matrix** that compares run output *visually* — rows are evidence stems / proof targets, columns are runs, cells are each run's screenshot/video; clicking a cell opens the existing `media-lightbox` stepping across runs for the same target (single mode), and any two runs can open the existing before/after compare mode as a cross-run A/B slider (no new N-up lightbox rewrite — the before/after pair is reused as run-A/run-B). Plus a "Compare family (N)" shortcut from the run-list family group and run detail. Cross-family / cross-project comparison (e.g. mobile + extension siblings keyed by shared ticket) is an explicit non-goal pending cross-project family grouping.

- **Hot-run portability — activate-on-slot swap + portable replay delta** — captured follow-up, **no new ADR**. The "no rebuild" half is already shipped (ADR-037 prepare profiles + fast/incremental preflight: the default `ensure-js-runtime` profile is a warm branch switch). Two gaps remain: (a) no first-class "activate this prior/sibling run on a slot" swap — re-engaging a warm slot still needs a fresh `run.create` + dispatch because slot history is read-only; (b) comparison/artifact-only work branches are kept local-only (`start-ref-policy.ts` `assertStartRefWorkBranchIsLocalOnly`) so those runs cannot hydrate onto another slot. Homes: activate-on-slot + reuse of held/recently-released warm slot → **[ADR-024](adr/024-run-lanes-and-run-family-model.md) §7 addendum (Activate-on-Slot)**; portable replay delta (complete re-appliable contribution patch or gateway-owned `refs/farmslot/runs/<runId>` namespace on `ResultPackageManifest`) → **[ADR-030](adr/030-replay-provenance-and-reference-evals.md) Follow-Up #8**. Delta-portability (b) is the critical-path enabler and lands first; operator-driven activation first; per-SHA build cache and worktree-per-branch are explicit non-goals under the delta-only model.
  - **Activate-on-Slot V1 shipped** (PR #55, commit `60cad69`) — operator-driven re-bind of a terminal/`blocked` run onto a target slot, re-driving PREPARE→DISPATCH with the `attach` warm profile (falls back to the project warm default); exposed identically from run-detail, slot-view, and slot-history. This is the "operator-driven activation first" slice of gap (a) above. The remaining **warm-auto-pick** slice (next increment) is two ADR-024 §7-addendum decisions that V1 did not wire — both gateway+UI-only, both still gated behind operator confirmation (auto-activate without confirmation stays a non-goal):
    - **(a1) `slotId`-omitted affinity scan** — `run.activateOnSlot` resolves `targetSlot = params.slotId?.trim() || run.slotId` (`services/gateway/src/methods/run/engine-ops.ts:112`) and the UI always passes the run's origin slot (`apps/command-center/ui/src/components/runs/run-detail.ts:684`), so the addendum's "no slot specified → prefer the warm slot holding the run's branch/family, fall through to any allowed slot" path (ADR-024 §7 addendum, Decision bullet 3) never executes. Wire it by calling `findAffinitySlot` from the activate path when `slotId` is omitted, and surface a "fastest warm slot" default/preview in the run-detail action.
    - **(a2) released-slot affinity eligibility** — `findAffinitySlot` (`services/gateway/src/methods/dispatch/preview.ts:112`) gates on `s.lifecycle === 'held'` only, so a just-`released` slot still on the run's branch/family is not a reuse candidate; the addendum calls for extending eligibility to recently-released slots so switching back does not re-pay a cold pick.

- **Mobile Tmux Worker Control** — ADR-033 captures the mobile lane for managing all tmux panes on registered nodes, including independent `omx`/`omc` and plain shell panes that do not map to Farmslot runs. Implementation is complete through M8: discovery, status/source/freshness labels, node-side branch/activity summaries, open-any-pane terminal, shortcut/control keys, foreground voice nudges, authenticated node deployment hardening, live tmux parser validation, Android real-device smoke, iOS simulator launch smoke, optional per-node `tmux_workers` include/exclude policy, and worker terminal stabilization on the existing xterm/PTY path. V1 still defers background wake-word, auto-send without tap, and remote node provisioning.

#### Opportunistic / no current dedicated PRD

- Co-Pilot consumption of bugfix-gate package evidence, eval-package artifacts, and auto-recovery audit evidence;
- Auto-recovery policy tuning only when audit evidence shows a category, project-default, or operator-UX gap;
- recipe proof/quality maintenance only when eval-package or normal PR work exposes a concrete regression outside the Generic Recipe Protocol v1 scope;
- mobile/extension base-recipe primitives for high-signal visual evidence, folded into Generic Recipe Protocol v1 when they affect the shared graph/artifact/replay contract.

## Cross-Checks

- `docs/IMPLEMENTED-HISTORY.md` records shipped work; do not reframe planned evals as implemented history.
- `docs/ROADMAP.md` owns product-level sequencing; this file owns the near-term execution shape.
- Bugfix local-first publication gating is shipped history; use it as the clean boundary that eval packages build on.
- Eval experiments consume the cleaner local-first package/publication boundary and remain artifact-only/no-PR by construction. PR #78's local suite builder still fans out into many single-case experiments rather than introducing a new suite runtime.
- Dev-flow publication gating is shipped; future work should be evidence-driven tuning and UI/UX polish, not a fresh publication-model decision.
- Any UI change still requires Command Center typecheck plus browser/CDP validation per `CLAUDE.md` and `apps/command-center/CLAUDE.md`.
