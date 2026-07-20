# Farmslot Implemented History

This is the canonical shipped-history summary for Farmslot in pass one. Use it with [DOCS-GOVERNANCE.md](DOCS-GOVERNANCE.md), [ROADMAP.md](ROADMAP.md), and the canonical PRD hierarchy as an operator-facing reconstruction of what has shipped, while treating ADRs, archived roadmaps, and git history as higher-authority raw evidence.

## Purpose

This document summarizes shipped product work by chunk and phase without pretending to replace the raw evidence. When exact historical truth matters, prefer ADRs, archived roadmap history, subsystem docs, and qualifying git commits before this derived summary.

## Evidence Basis

This summary is reconstructed from:

1. `docs/ROADMAP.md` for the original phase progression and product-level sequencing.
2. `docs/archive/roadmap-completed-milestones.md` for the command-center M0-M11 implementation archive.
3. `docs/ROADMAP.md`, the mobile canonical PRD, and ADR-033 for mobile milestone delivery through M4 and current M5/operator-control context.
4. `docs/adr/*.md` directly, including ADR-026 and ADR-027 beyond the stale ADR README table.
5. Post-archive git history after commit `d47f651` for later capability additions that are not fully captured in the archived milestone document.
6. Pre-publication migration commits through `4ddedfd3` on 2026-06-02. If Farmslot is moved to a new public repository without full private git history, keep this file as the compact source-history bridge and preserve the source refs in this section.

## Shipped History Summary

### 1. Core Farmslot foundations shipped first

Farmslot first became a reusable platform by shipping the project-agnostic framework, project-config-driven setup, source-agnostic issue ingestion, and standalone scoring flow.

**Evidence**

- `docs/ROADMAP.md` phases 1, 1.5, and 2 record framework extraction, GitHub issue support, and pre-dispatch scoring as completed work.
- [PRD-core-farmslot-canonical.md](PRD-core-farmslot-canonical.md), ADR-001, ADR-005, ADR-007, ADR-022, and ADR-027 describe the shared pool/project/slot/lifecycle model that these phases established.
- ADR-001, ADR-005, ADR-007, ADR-022, and ADR-027 show the durable architecture around gateway ownership, persistence, project structure, lifecycle simplification, and unified gateway state.

### 2. The Command Center shipped as a full desktop control surface

The Command Center is not a speculative future product. The archived milestone history and current supporting roadmap together show that M0-M11 were delivered, followed by Streams A-E and later polish/features.

**Evidence**

- `docs/archive/roadmap-completed-milestones.md` preserves the M0-M11 implementation archive, including the gateway, terminal observatory, fleet map, dispatch flows, PR dashboard, diff/review surfaces, slot workspace, structured tasks, device screen work, native TS gateway, and gateway-mediated orchestration.
- `docs/archive/roadmap-completed-milestones.md` preserves the M0-M11 completion history, and later ADR/git history records the follow-on Streams A-E / flow-graph work.
- Supporting ADRs include ADR-001 through ADR-018, especially ADR-011 and ADR-012 for structured task tracking and device screen streaming.

### 3. Automation, orchestration, and intelligence are already shipped product layers

After the initial command-center platform landed, Farmslot shipped persistent automation and intelligence features that changed the product from a UI shell into a full supervised run system.

**Evidence**

- `docs/ROADMAP.md` phase 4 marks the automation layer complete, including task queueing, webhook intake, auto-recycle, notifications, and the persistent daemon / `farmslot` CLI path.
- `docs/ROADMAP.md` phase 6 marks the intelligence layer complete, including multi-provider LLM support, self-review, and co-pilot.
- Post-archive git history after `d47f651` includes shipped capability milestones such as:
  - `5e1d990` — flow graph visualization
  - `f0c75ed` — ADR-024 run-family lanes/model
  - `ce90510` — family observability improvements aligned with ADR-025
  - `93aa55a` — ADR-026 self-improvement recursive loop
  - `a5ef1fa` — ADR-026 retrospective grading + ADR-027 state persistence follow-through
  - `5832f84` (PR #21) — runner-agnostic launch unification + first-class `SafetyTier` (`sandboxed`/`full-auto`/`dangerous`) on Run with per-run override and family inheritance (ADR-023 §3)
  - `2be5b3e` (PR #37) — LLM auth lifecycle, PR-body recipe extraction with provenance gating, codex 5.5 default
  - `a064839` / `dae87aa` / `4740b74` (PRs #30/#31/#32) — role-scoped agent panes per slot context with post-merge hardening
  - `4e68d48` / `d6fd814` / `60548d7` … `d244208` (PR #41) — branch-affinity nudge for busy PR-bound slots, surfaced via `dispatch.candidates` + `branch_affinity_nudge` decision card; reuses tmux session via `sendRunnerInstructionSafely` (ADR-023 status update)
  - `a347b65` (2026-04-30) — family-chain `recipe-flows` directory inheritance via new artifact spec `kind: 'directory'`; closes the gap where pr-complete inherited `recipe.json` but not bundled subflows
  - `1b4dde6` (PR #42, 2026-05-01) — ADR-028 GraphQL batch for `pr.list`: aliased GraphQL replaces the per-PR REST fan-out and drops the PR dashboard from per-PR REST polling to one chunked GraphQL request per repo when the cache is cold.
  - `dd5ef11` (PR #43) — cached live recipe context reads to reduce repeated gateway-to-node filesystem chatter when slot and recipe panels open.
  - `d48d79e` / `7b2bacc` / `0fa70f2` / `5b059c5` (PRs #44-#48) — Co-Pilot v2 grounding: route/screen context, scoped sessions, observer evidence separation, and evidence-first guidance for operational answers.
  - `95e0c36` (PR #49) — production log registry for intelligence evidence, keeping logs behind typed registry-backed discovery instead of ad hoc paths in prompts.
  - `f2933fa` (PR #50) — read-only recovery proposals that let gateway intelligence investigate and propose operator-confirmed actions without autonomous writes.
  - `4d89db8` (PR #51) — family-level retrospective with combined learnings from root work plus reviewer-driven deltas, including flow-aware report lookup, conditional missing-data handling, and decision-resolution UI fixes.
  - `f8bfecc` / PR #52 (2026-05-03) — family change ledger and first-class diff artifacts: contribution runs persist `artifacts/diff.txt` and `artifacts/diff-stat.json`, review/follow-up runs preserve reviewed-input snapshots, review-signal counters distinguish bugbot and human reviewer signals, and family observability surfaces change/evidence footprint summaries with source filtering and provenance bounds.
  - `1eb899e` / PR #53 (2026-05-04) — family evidence polish: family observability consumes the existing ledger in operator language, adds produced-code/reviewed-input/follow-up/evidence/usage/model-drift chips to the existing run selector, makes selected-run detail ledger-aware, exposes run metrics in family summaries, and validates the page through typecheck, targeted gateway/UI tests, UI build, and CDP harness/integrated checks.
  - `695f068` / PR #59 — runs/family readiness analytics from `#runs`: opt-in metadata-only family/project summaries, readiness/eligibility helpers, state hydration, project analytics strip, and compact family readiness badges.
  - `6806adf` / PR #60 — shareable `#runs` URL state and family-row summaries.
  - `2db5901` / PR #61 — no-change bugfix terminal dispositions: `already_fixed` / `not_reproducible` worker outcomes, evidence-backed no-change human gate, disposition metrics, and no-code self-review/CI-watch skips.
  - `be9b683` / PR #63 plus `7e2aaa3` polish — bulk fleet “Refresh idle slots” modal with safe/force sections, per-slot progress, PR-state danger gating, and recoverable force handling.
  - `a297973` / PR #65 — slot history viewer for slot-scoped run context recovery, including gateway run-history lookup, recovery metadata, and slot-view/dev-harness integration.
  - `c7c470d` / PR #57 and `fc0aaa0` / PR #66 — Co-Pilot session-owned confirmed action cards and write-action tightening: gateway-owned action ids, `chat.confirmAction(sessionId, actionId)`, allowlisted server-side execution, rejection for unknown/expired/consumed/cross-session/snapshot-mismatch actions, and typed tests/probes.
  - `60e282c` / PR #69 (2026-05-06) — family evidence filter + lightbox provenance + PR-evidence helper: kind-based filter chips on the family evidence panel (all/before/after/setup), provenance footer on the media lightbox, and a shared `pr-evidence` helper for consistent evidence association across surfaces.
  - `1ebf9c9` / PR #70 (2026-05-07) — dispatch-wizard family auto-detection + in-wizard comparison entry + tmux-observable prepare flow:
    - public `run.list({ ticketOrPr })` and `nextFreeComparisonVariant()` walk family siblings to pick the next free `<runner>-<model>[-vN]` tag.
    - wizard prior-run banner/picker with same-runner/same-model variant collision handling.
    - `DecisionAction.description` ships operator-facing subtext on collision cards; run-detail auto-jumps after `start-comparison`.
    - tmux-window prepare wrapper (`prepare-<runId8>-<phase>`) strips FORCE_COLOR to fix node --print VisionCamera podspec poisoning, pipes output via `tmux pipe-pane` for live `tmux attach` inspection, and uses a sentinel exit-code file to avoid window-death races.
    - rode along: manual `slot.release`/`slot.recycle` progress streaming, and configurable self-review retries/timeout (`max_retries`, `review_timeout_min`).
  - `af91315d` / PR #71 (2026-05-08) — family retro view with interactive pipeline, linkified refs, and diff modal integration.
  - `a1abcb99` / PR #73 (2026-05-08) — bugfix local-first publication gate and review-depth cockpit:
    - bugfix completion prepares a local PR package with package/hash/HEAD guards before public publication.
    - reusable ready workspace surfaces expose PR preview, diff, evidence/artifacts, review provenance, and publication target controls.
    - independent review depth, additional review loops, and fix-loop provenance are persisted for gate decisions and pipeline visibility.
    - publication-status guards protect CI-watch, rehydrate, draft-vs-ready publication, and no-PR-before-approval behavior.
    - dev harness fixtures, diff viewer modal, media evidence affordances, and flow graph/pipeline visibility were updated around the gate.
  - `267dfdc` through `c2948086` / PRs #74-#78 (2026-05-09 through 2026-05-12) — eval replay package foundation and cockpit:
    - artifact-only reference evals, `EvalExperimentManifest`, and `ResultPackageManifest` establish package-based replay semantics on the existing family/lane/run model.
    - dataset/suite/scorer types provide catalog/draft/scoring-intent seams without turning one experiment into a multi-case runtime.
    - `#evals` adds a Reference picker, Candidate setup, generated variant defaults, and local fan-out through single-case `eval.experiment.create` / `eval.trial.start`.
    - startRef replay policy, no-PR mutation guards, artifact-only task guarding, and family-observability projection make eval families visible without creating a new `FlowType`.
    - generated replay tasks capture `inputs/template-provenance.json` with template content hash and project/farmslot commit provenance.
  - `c943bf32` / PR #81 (2026-05-12) — fixture sync WAN reliability: remote fixture copies reuse an SSH ControlMaster/ControlPersist connection and gateway fixture sync gets a wider timeout budget for cold WAN prepares.
  - `a371d7d` / PR #82 (2026-05-12) — ADR-031 deterministic-first auto-recovery:
    - gateway watcher classifies recoverable failures, applies allowlisted typed recovery actions, and records audit/dead-letter/degraded states.
    - LLM refinement is budgeted, schema-validated, and allowlisted; unsafe or human-gated actions remain proposals.
    - project config, intelligence summary/audit surfaces, `slot.fixtureRefresh`, protocol `0.5.0`, and node protocol compatibility handling shipped with the feature.
  - `ce8fdb5` / PR #83 (2026-05-13) — flexible interactive dev tasks:
    - `dev` can start from freeform operator `initialContext` with normalized local `DEV-*` identities.
    - runs and queue items persist `devInteractiveProfile` (`lightweight` or `reviewed`) and generated sidecars (`inputs/dev-intake.json`, `CHECKLIST.md`).
    - run detail exposes operator-owned completion actions for done-without-PR, PR + CI-watch, PR-complete handoff, self-review, blocked, failed, and abort.
  - `e330f396` / PR #85 (2026-05-13) — task-dir collision prior-run redirect:
    - collision detection moved to the start of slot finding so operators can redirect before LLM cost or filesystem work is spent.
    - decision payloads carry resolved prior-run IDs, and run/slot UI surfaces prior-run context, pipeline status, and comparison redirect affordances.
  - `03fd3014` / PR #86 (2026-05-14) — shared dispatch priority queue and eval slot caps:
    - normal dispatches and eval cells share the same operator-visible backlog rather than eval matrices monopolizing every free slot.
    - eval suite cap records limit active matrix cells per cap group while preserving normal dispatch throughput.
    - queued eval cells reconnect to dispatched runs/result packages for live cockpit progress and evidence telemetry.
    - dispatch/runs/eval queue panels replace free-text slot filters with a no-typing fleet slot picker that disables ineligible rows, plus subset-safe priority reordering.
  - `a2d1af65` / PR #87 (2026-05-14) — worker template version selection:
    - dispatch and eval flows can choose project-owned worker template versions as a first-class axis.
    - generated artifact-only tasks retain template provenance without fixture sync or slot-side default-template overwrites.
  - `dd5c87f6` through `497cd165` / PRs #88-#93 (2026-05-14 through 2026-05-15) — Command Center decomposition and quality hardening:
    - slot view, run detail, family observability, run pipeline, ready/review workspaces, dispatch wizard, and eval cockpit were split into focused model/render/style/url-state modules.
    - protocol/backend mega-files were split behind compatibility facades and narrower dispatch, run-engine, run-completion, self-review, and slot seams while preserving behavior.
    - scoped tests and quality inventories now guard the extracted surfaces against regression and type-escape backslide.
  - `d0f89517` / PR #94 (2026-05-15) — Command Center quality gates in CI:
    - GitHub Actions now runs the Command Center quality workflow.
    - lint/type-escape ratchets and quality workflow policy are documented so local and CI guardrails match.
  - `a6efb0cc` / PR #95 (2026-05-15) — backlog dispatch intake:
    - durable backlog items, gateway APIs, protocol types/events, project config, and a Command Center `#backlog` panel shipped.
    - Ready backlog items can hand off into the existing dispatch queue with guarded project config while direct Jira/GitHub dispatch remains intact.
  - `af1aa2f1` / PR #96 (2026-05-15) — dev publication gate:
    - interactive/autonomous dev runs can select project-owned templates and prepare local workspace packages before public PR publication.
    - human package approval and optional independent review now gate dev publication, aligning dev with the local-first publication boundary already used by bugfix completion.
  - `29bfe820` / `c3ac8339` / `62d8f074` / `36390cd0` / `db4f45df` / `9b79e5d3` / `578c972b` / `97ea0de7` / `09a07b7c` (2026-05-20 to 2026-05-21) — authenticated remote Companion access and Android targeting:
    - gateway authentication became a first-class local/remote Companion connection requirement rather than a disconnected-state afterthought; Command Center can surface pairing from connection status, and Companion supports LAN/remote gateway profiles with token auth.
    - mobile profiles reject localhost/loopback for real devices, preserve safe secret keys, attach auth to artifact loads, show the active gateway profile in terminal/connection UI, and can test authenticated profiles.
    - Android launch tooling can choose a target device, including Wi-Fi ADB targets by IP, instead of accidentally opening an unrelated simulator/device.
  - `bba221d4` / `c05a1802` / `6a89e5e8` / `37c069da` / `54c8e5ef` / `7509a5cd` / `b1673fc3` (2026-05-21) — mobile voice permission setup and ASR build contract:
    - Companion surfaces microphone permission readiness in Settings and terminal voice flows, routes blocked/skipped permissions to the right app/system settings path, and locks Expo native microphone/Sherpa plugin configuration with tests.
  - `943368c6` through `d47f43c2` plus follow-up fixes (2026-05-21 to 2026-05-22) — mobile operator workspace hardening:
    - Companion gained phone-native before→after comparison affordances across slot, run, family, decision, artifact, diff, terminal, and PR contexts.
    - workspace navigation preserves focused project/family/run/decision/artifact/recipe/retro context, makes gate/retro/recipe evidence reachable from compact mobile screens, and keeps global filters/workspace focus usable across refreshes.
    - fullscreen artifact/document/diff/terminal surfaces were tightened around safe areas, sticky headers, terminal scrolling, monitor-notification noise, active progress/checklist fallbacks, and contextual co-pilot entry points.
  - `2f02450a` / `99970783` / `0e882f83` / `0a91a7b1` / `a4a33111` / `321c25cb` / `926b31b6` / `352782c3` / `9b075823` / `59a7af54` / `d546f67b` (2026-05-22) — Mobile Tmux Worker Control through V1/M8:
    - gateway/node/protocol now expose registered-node tmux worker inventory, worker-ref terminal subscribe/input/resize/snapshot, status/source/freshness/confidence enrichment, and optional per-node `tmux_workers` include/exclude policy.
    - Companion has a Workers tab and worker terminal route for arbitrary node panes, including independent `omx`/`omc`/shell panes with no Farmslot run identity.
    - foreground voice nudges can target selected workers through `copilot.formatInstruction` using terminal-tail context, while V1 still requires review/edit and explicit send.
    - node deployment/auth and live tmux parser validation were hardened after real runner-local/mini/runner-a/runner-b redeploys exposed token and parser drift.
    - worker terminals were corrected to reuse the existing `pty-stream` + `XtermTerminalView` path rather than a capture-pane polling loop; Android Wi-Fi validation confirmed `terminal.mode: pty`, stable xterm output without full-pane flashing, shortcut controls, and keyboard-aware typing/drag behavior.
    - node worker inventory now exposes git branch, observed/last-changed timestamps, node summary counts, and `fs.watch`-invalidated branch caches so Companion can distinguish active/waiting/idle/stale panes without showing raw tmux pane ids as progress-like metadata.
    - `a1ba9c09` fixed the first live state-fusion regression: metadata-only `lastChangedAt` no longer makes stable workers appear stale, and active run-store correlation now overrides stale fleet slot snapshots for worker state badges.
  - `6aad3686` through `4ddedfd3` (2026-05-23 to 2026-06-02) — public-readiness, package extraction, and repo/documentation consolidation before migration:
    - farmslot.io landing/docs deployment, MIT/package metadata, workspace README guidance, service/package quality gates, duplicate-import hygiene, auth/file-boundary hardening, stale slot storage pruning, and slot git-cleanup hardening made the repository safer to publish and easier to operate as a public monorepo.
    - `@farmslot/protocol`, `@farmslot/recipe-harness`, `@farmslot/expo-recipe`, and `@farmslot/skills` were shaped as external-facing packages, with changelog-gated publishing and v0 protocol/harness API boundaries.
    - recipe operational validation and Expo project integration connected the protocol/harness direction to real client adoption rather than keeping the recipe work only inside Command Center.
    - command-center view models and repo support scripts/skills were reorganized for public readiness, and PR #128 (`b139955f`) consolidated the docs tree around canonical PRDs, ADRs, operations docs, reference material, and implemented history.
    - `4ddedfd3` added the Metro protocol module-resolution helper needed by embedded/client package consumers.
  - `fe3f932` through `c2927e0` (2026-06-12) — ADR-036 CLI gateway profiles:
    - kubeconfig-style `~/.farmslot/gateways.json` store, `farmslot gateway add/remove/list/use`, global `--gateway <name>`, and doctor Gateways reachability/auth hints.
    - `farmslot login`/`logout`/`auth status` reuse the Companion pairing/auth flow against named profiles.
  - `81c5704` / PR #30 (2026-06-13) and `bfcca19` / PR #46 (2026-06-22) — one-command local onboarding:
    - `farmslot up`/`down` run a token-auth local gateway as a managed background service with the built UI bundle on the gateway port.
    - `farmslot pair` exposes LAN/Tailscale pairing QR for the Companion via `pairing.create`/`pairing.exchange`.
  - `7ec8827` / PR #32 (2026-06-13) — ADR-037 prepare profiles:
    - project-owned `prepare.profiles` with phased `git`/`fixtures`/`deps`/`preflight`/`health`, machine-checkable `requires`, deterministic `fallback`, and `FARMSLOT_PREPARE_PROFILE` on every hook invocation.
    - CLI/RPC `prepareProfile`, gateway `resolvePrepareProfile`, unified `slot-prepare-options` across dispatch wizard, slot view, step replay, and activate-on-slot; `skip_prepare_requires_health` removed from schema/gateway.
  - `792469b` / PR #48 (2026-06-23) — pipeline-ops analytics V1:
    - terminal-run NDJSON sink, `analytics.query`/`analytics.backfill`, `farmslot analytics` CLI, and Command Center `#analytics` dashboard for per-step bottlenecks, failure attribution, loop counts, and wait-time views (cost/tokens intentionally excluded until extraction is reliable).
  - `70742c2` (2026-06-23) — update freshness:
    - read-only `gateway.status` reports clone-behind-origin metadata from a TTL-cached `git fetch`; Command Center renders a dismissable update banner and `farmslot doctor` surfaces an Updates section.
  - `1a491df` / PR #54 (2026-06-23) — family-compare view (template/model comparison slice 1):
    - within-family Leaderboard/Matrix/Evidence/Cards tabs in family observability, `cmpTab`/`cmpSort` URL state, visual evidence matrix, and run-list family compare shortcuts.
  - `60cad69` / PR #55 (2026-06-23) — activate-on-slot V1:
    - `run.activateOnSlot` re-binds terminal/`blocked` runs onto a slot and re-drives PREPARE→DISPATCH with the `attach` warm profile (falls back to project warm default); exposed from run-detail, slot-view, and slot-history.
  - `e4cbcb4` / PR #81 through `91674d9` (2026-06-27) — ADR-032 runner observability Phases 1–2:
    - Claude/Codex hook installers, `scripts/runner-validation/` harness, obs-first `sendRunnerInstructionSafely`, agreement log, and hook-path timeout via `resolveSafeSendTimeoutMs()`.
    - Phase 2 empirical exit passed (`nudgeTimeoutCount=0` over 7d on Claude slots; frozen in `docs/operations/evidence/adr032/phase2-exit-window.json`).
    - Committed closeout evidence is trimmed to four macwork snapshots (two install probes + two hook-smoke harness JSONs); optional scenario/agreement/grok/cursor artifacts stay local-only. One-shot ADR closeout verifiers were retired from `scripts/`; reusable ops gates remain (`e2e-tmux-runner-validate.sh`, `run-runner-observability-gate.sh`, `capture-nudge-timeout-window.mjs`).
    - Phase 3 retirement of Claude-only pane-regex branches was historically scheduled here and has since shipped (Phase 3A shadow flag PR #344, Phase 3B deletion PR #345); no ADR-032 send-path implementation work remains — only the shared-monitor pane-branch hook migration.
  - Recipe Protocol v1 (ADR-034) — `@farmslot/protocol` validators (`validateRecipeDocument`, `validateRecipeWithManifest`, `validateRecipeArtifactPackage`), `@farmslot/recipe-harness` graph runtime, `farmslot recipe validate`, and `docs/examples/recipes/farmslot/` self-validation fixtures established the core contract; the 2026-07-04 closeout completed typed manifest enforcement, manifest-first rendering, recipe-quality producer tooling, first-party `hooks.recipe_run` alignment, local `e2e:recipe-protocol` execution, and live `@deeeed/metamask-harness` package conformance. See [reference/adr-implementation-status.md](reference/adr-implementation-status.md).
  - PRs #150, #155, #157, #160, and #163 (2026-06-28 to 2026-06-29) — roadmap-backed WorkGraph orchestration moved from ADR intent into shipped operator tooling: backlog dependency orchestration, cross-project dependency visualization, roadmap item refinement/promotion into backlog specs, WorkGraph composition from promoted specs, execution overlays/dispatch config, and a roadmap guide/demo capture mode.
  - PRs #151, #152, #153, #154, #156, #158, and #159 (2026-06-29) — proof/gate hardening: Command Center recipe-v1 proof HUD wiring, unified gate-summary projection across live gate and historical retrospective surfaces, pr-complete contribution-base/diff fixes, test-runner git-env isolation, manual-only loc-history CI, per-model token/worker stats on gate/analytics surfaces, historical-run gate-summary rendering, and a faster pre-push hook.
  - PR #161 (`4c4aeffb`, 2026-06-29) — activate-on-slot UI re-dispatch buttons were removed after proving they were a gate-held-run footgun; the `run.activateOnSlot` RPC remains available as an explicit operator escape hatch while the UI keeps only bind/load-slot affordances.
  - PRs #164-#174 and #176 (2026-06-29 to 2026-06-30) — Codex/self-dispatch and runner reliability hardening: passive validation-stack handling, Codex readiness gates, per-slot `CODEX_HOME` provisioning/fallback, no stale symlink write-through, duplicate prompt-send prevention, slot-scoped CDP port export, gateway-token seeding for recipe browsers, recipe video capture against the recipe's own CDP Chrome, scripted-runner validation harness, Codex session-metrics discovery from slot `CODEX_HOME`, dispatch-wizard mode defaults, and reliable tmux compose/prompt delivery.
  - PRs #177-#184 (2026-06-30) — operator UI/metric stabilization: run duration now has a single helper, recipe-quality surfaces consume one gateway-produced signal, interactive handoff exposes clearer `SIGNAL.json` gate UX, worker terminal signals use one `mark` CLI path, release maturity diagnostics shipped ALPHA labels for under-tested Command Center surfaces plus a version diagnostics modal and section-scoped Doctor refresh, pack submodules track remote `main` on sync/first clone, terminal output waits for PTY resize, and terminal Active Runs gained list alignment plus a Pinned watchlist.
  - PRs #185-#190 (2026-06-30) — release and runtime closeout: runner detection scans all panes and auth blockers line-by-line, runner-provisioned `.codex/` artifacts are ignored, CI-fix template fallback and secondary-template docs shipped, leaked gateway test runs are quarantined on load/recovery, Farmslot now uses the installed `capture-helper` package/native binary instead of embedded source, and `@farmslot/protocol@0.7.0`, `@farmslot/recipe-harness@0.3.2`, and `@farmslot/skills@0.1.1` were published.
  - PR #260 (2026-07-04) — task lifecycle runtime extraction: `@farmslot/agent-runtime` became the reusable owner for `mark`, `SIGNAL.json`, worker terminal contract resolution, and artifact checks; `RecipeQualityArtifact` validation moved into `@farmslot/protocol`; `@farmslot/skills` kept compatibility shims and instruction ownership; Gateway templates and remote-node deploy sync now point at the runtime package.
- ADR-023, ADR-024, ADR-025, ADR-026, ADR-027, ADR-028, ADR-030, ADR-031, ADR-032, ADR-033, ADR-034, ADR-036, ADR-037, ADR-040, and ADR-041 provide the architecture trail for the current runner, observability, self-improvement, quota, replay provenance, auto-recovery, hook-based runner observability, recipe protocol, CLI gateway profiles, prepare profiles, roadmap/backlog promotion, work-graph orchestration, and mobile tmux worker-control direction.

### 4. Mobile Companion is shipped through oversight, evidence review, and operator-control lanes

Mobile is part of the implemented product, not just a placeholder. The canonical mobile PRD and ADR-033 record the shipped baseline through M4/global filters, and the 2026-05-21/22 sprint moved the app beyond read-heavy oversight into practical operator control.

**Evidence**

- [ROADMAP.md](ROADMAP.md) summarizes the shipped mobile state; this history file, the canonical mobile PRD, and ADR-033 retain the durable M1a-M4/global-filters/M5 context after removal of the raw mobile roadmap.
- [PRD-mobile-companion-canonical.md](PRD-mobile-companion-canonical.md) records M5/operator-gate hardening, before→after review emphasis, authenticated gateway profile/pairing support, Android device targeting, foreground voice groundwork, and terminal keyboard/drag polish.
- ADR-033 records the V1/M8 implementation of registered-node tmux worker discovery/control, including arbitrary node panes that do not map to Farmslot runs.
- The canonical mobile PRD establishes the mobile app as a companion to the shared gateway-backed product rather than a separate product line.

### 5. Runner-neutral execution: contract shipped, second-runner bring-up still open

Farmslot has the tmux-based, operator-attachable execution style, the unified launch entry point (`buildLaunchCommand` in `services/gateway/src/runners/launch-command.ts`), the first-class `SafetyTier` model on Run (per-run override, family inheritance), and a capability-based runner registry pattern (`RunnerStatusProvider`, `runnerSupportsTmuxNudges`). ADR-032 adds hook-based `RunnerObservability` for `event-driven` runners with obs-first safe-send, and its Phase 3A/3B pane-regex retirement (PRs #344/#345) made Claude send decisions hook-only. The shared contract is in production. What remains open is the shared-monitor pane-branch hook migration, the rules-shim layer (`.cursor/rules/<name>/RULE.md`, `.agents/skills/<name>/SKILL.md`), optional session resume on relaunch, and OpenCode bring-up — deferred until production pain or a second non-Claude runner need appears.

**Evidence**

- `5832f84` (PR #21) — runner-agnostic launch unification + `SafetyTier` (sandboxed/full-auto/dangerous) on Run.
- `47fd062` — runner status behind a typed provider interface (`RunnerStatusProvider` registry pattern enforced by `apps/command-center/CLAUDE.md`).
- `e4cbcb4` through `91674d9` / PRs #81–#84 — ADR-032 hook installers, runner-validation harness, obs-first `sendRunnerInstructionSafely`, and hook-path timeout.
- Codex exec-mode validated on live slots (per ADR-023 status updates).
- ADR-023 §4 marks the rules-shim layer deferred until a second non-Claude runner reaches production.
- `docs/ROADMAP.md` still tracks runner-neutral expansion as deferred strategic follow-up after the active evaluation-hardening lane.

## Crosswalk Notes for Historical Truth

- If this repository is migrated to a new public repo without preserving the original private commit graph, treat the source repository history through `4ddedfd3` (2026-06-02) as the pre-migration raw evidence. The most important compact anchors are PRs #73-#78, #81-#96, #121-#123, and #128 plus the commits named above.
- Post-migration infrastructure on current `main` also anchors on `fe3f932` (ADR-036 profiles), `7ec8827` / PR #32 (ADR-037 prepare profiles), `792469b` / PR #48 (pipeline analytics V1), `1a491df` / PR #54 (family-compare), `60cad69` / PR #55 (activate-on-slot), `81c5704` / PR #30 + `bfcca19` / PR #46 (onboarding up/pair), and `e4cbcb4`–`91674d9` / PRs #81–#84 (ADR-032 Phases 1–2). PR numbers before and after migration are not always the same feature — prefer commit SHA when in doubt.
- `docs/archive/roadmap-completed-milestones.md` remains the raw archive for command-center milestone history.
- ADR-033 and the canonical mobile PRD retain the durable mobile operator-control detail.
- `docs/adr/README.md` is helpful as an index, but it is not a complete inventory because ADR-026, ADR-027, and ADR-028 exist outside its current table.
- This file intentionally summarizes history; it does not override raw ADR text or archived milestone records.

## Current Historical Interpretation

As of 2026-07-20 (through PR #361, the recipe source trust model; see [reference/adr-implementation-status.md](reference/adr-implementation-status.md) for ADR-level shipped-vs-open detail):

1. Farmslot shipped the core platform first.
2. The desktop command center and persistent automation/orchestration stack are already real product surfaces.
3. Mobile oversight is shipped through M4/global filters and M5/operator-control hardening is now usable: authenticated gateway profiles/pairing, mobile evidence/before→after review, progress/workspace navigation, foreground voice nudges, and registered-node tmux worker control are implemented.
4. The runner-neutral execution contract is in production for Claude + Codex (unified launch, `SafetyTier`, capability registry, status providers). ADR-032 is fully shipped through Phase 3: hook installers, runner-validation harness, obs-first safe-send (Phases 1–2), and the Phase 3A/3B pane-regex retirement (PRs #344/#345) — Claude send decisions are hook-only unconditionally; Codex keeps its pane fallback, and shared monitor pane branches remain the follow-up hook migration. OpenCode bring-up and the deferred rules-shim layer (ADR-023 §4) stay gated on a real second-runner production use case.
5. The active near-term lane has moved from landing eval-package/operator-flow/mobile-control foundations to stabilizing recently changed UI surfaces, then closing replay evidence and corpus workflow gaps. Dispatch-wizard comparison entry, the bugfix local-first publish gate, eval experiment/result-package artifacts, the local `#evals` Reference/Candidate cockpit, shared dispatch queue/eval slot caps, worker-template selection, deterministic auto-recovery, flexible interactive dev intake, backlog intake, roadmap refinement/promotion, WorkGraph orchestration/visualization, dev publication gating, authenticated Companion access, mobile evidence navigation, Mobile Tmux Worker Control, ADR-037 prepare profiles, ADR-036 CLI gateway profiles + `farmslot up`/`pair`, pipeline analytics V1, family-compare view, activate-on-slot V1 with UI re-dispatch removed, release maturity diagnostics, scripted-runner validation, installed capture-helper integration, and the 2026-06-30 package release are implemented history. Recipe review/quality work should be treated as maintenance unless eval experiments or normal PR work exposes a concrete regression. The 2026-07 window added the operator CLI dual-mode TUI + full operator loop (PRs #307-#318), the reliability backlog drain (PRs #326-#352, including restart-durable gate/review loops and dead-session chained-dispatch re-prepare), the slot lifecycle ownership protocol (PR #353), the ADR-049 execution-template resolver + `list`/`lint`/`new` tools (PR #347 — dispatch/render/skills integration still open, ADR remains `Status: Proposed`), the worker terminal contract (ADR-045, Accepted — runtime enforcement plus author-time lint incl. mark-less templates), recipe-harness reusable flows / 0.7.0 (PRs #355/#358), and the recipe source trust model (PR #361) to implemented history.
6. The repository has been prepared for public migration: docs are consolidated around canonical current-state sources, package publishing is changelog-gated, and the protocol/harness/Expo/skills packages have explicit external adoption boundaries.

## Explicit Not-Yet-Shipped Boundaries

The following are planned roadmap items, not implemented history as of 2026-07-20:

- remaining UI/UX stabilization fixes discovered by real testing of recently changed operator surfaces; ALPHA maturity labels, version diagnostics, progressive Doctor refresh, terminal resize/pinning polish, and interactive handoff gate UX are already shipped;
- replay closure for a durable regression program: complete real-run manifests, consistent baseline/head/diff identity, richer missing-data semantics, and enough live replay evidence beyond dev-harness fixtures;
- gateway-owned suite history, corpus dashboards, aggregate reports, and scorer execution beyond the shipped shared queue/cap execution path;
- backlog-intelligence, Jira/GitHub write-back, or auto-dispatch policy expansion beyond PR #95's shipped guarded intake/queue handoff;
- dev publication policy tuning beyond PR #96's shipped local-first gate, unless real interactive/autonomous dev evidence shows a concrete gap;
- ADR-032 shared-monitor pane-branch hook migration (Phase 3A/3B send-path retirement shipped in PRs #344/#345);
- activate-on-slot warm-auto-pick follow-ups (affinity scan when `slotId` is omitted, recently-released slot eligibility) and portable replay delta for artifact-only cross-slot hydration;
- dispatch-time nudge router, optional runner session resume on relaunch/fix paths, OpenShell slot-runtime spike, and any post-PR #189 capture-helper follow-up beyond the installed-package/native-binary integration now used by Farmslot;
- ADR-036 onboarding follow-ups only when demos/org rollout need them: portable `farmslot` pack and clean-machine `curl | bash` rehearsal;
- pipeline-ops analytics follow-ups: trend/time-series, regression detection, richer failure/host-load/prepare-substep capture, and cost-per-PR once token extraction is reliable;
- mobile background wake-word, automatic send without tap, and remote node provisioning/enrollment beyond the shipped foreground/authenticated V1;
- deeper iOS interactive worker-terminal QA and landscape/fullscreen terminal refinement beyond current Android real-device + iOS launch smoke;
- any Langfuse/LangSmith export adapter or external eval platform integration.
