# Command Center Code Quality Notes

This document records the Command Center quality guardrails and the current large-file breakup inventory. The latest cleanup PR keeps the repo-wide formatting/lint/type ratchets in place while moving more state/payload/recovery logic out of mega-files behind tested helper modules.

## Automated checks

Run the aggregate command from the repository root for the full Command Center quality gate:

```bash
yarn quality
```

Root `yarn quality` expands to the repo Prettier check, the repo ESLint ratchet, workspace structure and import-boundary guards, a non-blocking >1000 LOC file-size warning, the Command Center type-escape ratchet, package/service workspace quality, protocol/recipe/gateway/UI tests, companion model tests, recipe operational gates, and Command Center typecheck; run the individual sub-steps only when you are isolating a failure. The CI workflow at `.github/workflows/command-center-quality.yml` runs the merge-blocking subset as named steps so pull requests fail before merge for formatting, lint, workspace structure, import boundaries, type-escape, typecheck, package-readiness, docs-build, UI, companion, or operational-gate regressions.

For a fresh checkout, install dependencies first:

```bash
yarn install --immutable
```

Before opening a PR, run:

```bash
yarn format:check
yarn lint
yarn lint:type-escapes
yarn typecheck
yarn quality
```

`yarn format` and `yarn lint:fix` are the automatic fix commands. Broad formatter/import-sort dry runs can still produce very large diffs, so keep mechanical formatting commits separate from semantic refactors and use the size gate below before applying repo-wide formatting churn.

The old scoped commands remain temporarily for compatibility with previous PR notes and should be removed by follow-up queue item 5 after the full quality gate has been stable for one follow-up PR:

```bash
yarn lint:slot-view
yarn format:extracted:check
yarn quality:slot-view
```

### GitHub Actions quality gate

`.github/workflows/command-center-quality.yml` runs on pull requests and pushes to `main` that touch Command Center, root quality scripts, root formatting/lint config, or the workflow itself. It uses Node 22 with Corepack and official GitHub actions pinned to the current major tag so the workflow receives maintained action runtime updates without silently moving to unrelated third-party actions. It installs Command Center dependencies via `yarn install --immutable`, then runs named steps for:

- `yarn format:check`
- `yarn lint` (ESLint ratchet plus stale-baseline failure)
- `yarn quality:structure` (package/service README and script consistency, plus stale service path references)
- `yarn quality:imports` (package/service/app import-boundary guard)
- `yarn quality:large-files` (non-blocking warning for tracked source/docs files above 1000 LOC)
- `yarn lint:type-escapes` (production type-escape ratchet plus stale-baseline failure)
- `yarn typecheck`
- `yarn test:ui`
- `yarn --cwd apps/command-center test:recipe-operational-gates`
- `yarn --cwd apps/companion test:lib`
- `yarn workspace @farmslot/theme quality`
- `yarn workspace @farmslot/recipe-harness quality`
- `node scripts/quality/check-farmslot-package-readiness.mjs --pack`
- `yarn docs:build`

The workflow intentionally runs the component steps instead of running `yarn quality` afterward, because `yarn quality` would duplicate the same expensive checks and the local package/service workspace matrix. The older scoped gates (`yarn quality:slot-view` and `yarn format:extracted:check`) remain local compatibility commands by design; CI uses the broader ratchets plus focused tests. Local developers should still use root `yarn quality` as the one-command pre-PR gate. The `apps/command-center` package `yarn quality` remains a scoped UI/gateway helper, not the full pre-PR gate.

### Repo-wide lint ratchet and Sonar input

The root `eslint.config.mjs` is the single lint policy for JavaScript/TypeScript in this repository. Hooks, CI, and package scripts call that config through `scripts/quality/check-eslint-ratchet.mjs`; the rule set stays active, including unused-variable detection, while `scripts/quality/eslint-baseline.json` records existing debt so new issues fail the gate instead of hiding the rule. `yarn lint` runs the ESLint ratchet with `--strict-stale`, so stale baseline entries fail and should be pruned rather than left as warnings.

The repo-level ESLint, Prettier, and Command Center test-runner CLIs are resolved from the Command Center workspace dependencies. Packages that own standalone TypeScript tests, including the companion app, should declare `tsx` directly so their package scripts do not depend on another workspace layout. Before installing hooks in a fresh checkout, run `yarn install --immutable` so workspace tooling dependencies are available.

SonarQube/SonarCloud warnings can be pulled into the same agent-visible evidence path without hardcoding a project:

```bash
SONAR_HOST_URL=https://sonar.example.com \
SONAR_TOKEN=... \
SONAR_PROJECT_KEY=... \
node scripts/quality/fetch-sonar-issues.mjs
```

The command writes `temp/quality/sonar-issues.json` by default, which review agents can read alongside ESLint, Prettier, typecheck, and ratchet output. CI treats Sonar as optional evidence: when `SONAR_HOST_URL`, `SONAR_TOKEN`, and `SONAR_PROJECT_KEY` secrets are unavailable, the workflow logs a skip message and continues; when they are available, it uploads the JSON as the `sonar-issues` artifact instead of committing generated evidence.

### Commit hook

Install the repo-wide pre-commit hook once per checkout:

```bash
yarn hooks:install
```

The hook sets `core.hooksPath` to the absolute `apps/command-center/scripts/git-hooks` directory and delegates to the repo-level `scripts/quality/precommit-quality.mjs`. On every commit it temporarily stashes unstaged work, runs autofix/Prettier only on the staged paths, re-stages only those paths, then checks the repo-level ESLint ratchet and the Command Center production type-escape ratchet against the staged snapshot with stale-baseline enforcement enabled. This keeps indentation/import-order churn out of review without hardcoding per-project hook behavior or silently adding unrelated files to a commit.

### Mechanical change policy

- If a formatter/import-sort dry run affects more than **50 files** or **500 changed lines**, make the PR mechanical-only.
- Autofix/formatter commits must not include semantic refactors.
- Semantic refactors should run `yarn lint`/`yarn format:check`; use `yarn lint:fix`/`yarn format` only in a dedicated mechanical commit.

### Type-escape ratchet

`yarn lint:type-escapes` compares production `any`, `as any`, and `as unknown` usage against `apps/command-center/scripts/type-escape-baseline.json`. The current baseline records existing legacy debt only; new production escape hatches and stale baseline entries fail the gate. When touching a legacy file, prefer deleting the baseline entry by adding a typed reader/narrower rather than refreshing the baseline.

### Temporary lint suppressions

The full-repo ESLint gate currently enforces parseability, Prettier-compatible formatting, import/export ordering, unused-variable detection with the `^_` intentional-unused convention, `no-empty`, and `no-useless-catch`. To make the mechanical baseline reviewable, other legacy semantic lint debt is temporarily suppressed in `eslint.config.mjs` for:

- unused expressions and `prefer-const`;
- legacy `require()` imports;
- existing control-character regexes and escape patterns;
- existing `@ts-ignore` comments and empty object types;
- 14 existing core ESLint `preserve-caught-error` findings.

These suppressions are not the desired end state. Owner/tracking: follow-up queue item 5 below should remove or narrow them as each mega-file lane is refactored; do not add new code that relies on these patterns. `no-unused-vars` is intentionally active now; existing unused-variable debt is only allowed through the ratchet baseline, and new unused variables fail the gate.

### Commit-hook caveats

`yarn hooks:install` sets local `core.hooksPath` to the absolute `apps/command-center/scripts/git-hooks` path and may affect sibling worktrees that share the same git common directory; the installer prints that worktree count before mutating config. If a checkout already has custom root hooks, the installer refuses to replace them unless rerun with `--force`; merge custom hooks into `apps/command-center/scripts/git-hooks` first. The pre-commit hook runs the same repo-level quality script as `yarn precommit:quality`, with lint policy owned by the root ESLint config instead of shell path filters. The type-escape ratchet intentionally scans the full Command Center production tree, so an unrelated local edit with a new escape can block the commit until fixed or stashed. Shell hook files under `apps/command-center/scripts/git-hooks/` are ignored by Prettier and should be kept manually shell-formatted.

The hook uses `git stash push --keep-index --include-untracked` to protect unstaged work before formatting staged files. If restoring that stash conflicts, Git leaves the stash in `git stash list`; inspect it with `git stash show -p stash@{0}`, resolve the working tree, then rerun `git stash pop stash@{0}` or apply the specific patch hunks you want to keep.

### Ratchet implementation caveat

The type-escape ratchet intentionally uses a simple raw-source scan instead of a TypeScript AST so it stays dependency-free and fast in hooks. It compares count-based `file/kind/text` entries rather than line numbers, normalizing whitespace inside the matched escape text, so normal refactors can move legacy debt within the same file without refreshing the baseline. The v1 pattern set covers direct `: any`, `as any`, `as unknown`, generic-argument positions such as `Array<any>`, `Promise<any>`, `Record<string, any>`, or `Map<string, any>`, and generic default/bound forms such as `<T = any>` or `<T extends any>`. If a false positive appears in a string/comment or in rare value syntax such as an array element named `any`, prefer rewriting the text or adding a narrowly documented baseline entry rather than weakening the production-code guard. Stale baseline entries are blocking in CI and hooks via `--strict-stale`; prune them with `--write-baseline` only after confirming the entries are genuinely gone.

Prune commands:

```bash
cd apps/command-center
node scripts/check-type-escape-ratchet.mjs --write-baseline > scripts/type-escape-baseline.json
cd ..
node scripts/quality/check-eslint-ratchet.mjs --write-baseline > scripts/quality/eslint-baseline.json
```

## URL state convention

Shared hash/query helpers live in `ui/src/utils/url-state.ts`. New view code should use that utility instead of hand-parsing `location.hash` or directly constructing `URLSearchParams` from hash slices.

Current migration status:

- `slot-view` URL-state parsing now goes through `ui/src/utils/url-state.ts` via `slot-view-url-state.ts`.
- App-level global filters and `#runs` filters now live in `ui/src/state-url-state.ts`, backed by `ui/src/utils/url-state.ts` and focused tests.
- `runs/family-observability.ts` run/diff-modal hash state now goes through `family-observability-url-state.ts`, backed by the shared URL helper. Evidence grouping/lightbox pairing moved into `family-observability-evidence.ts`; output comparison/evidence summaries moved into `family-observability-output-model.ts`.
- `runs/run-detail.ts` step and evidence-artifact modal params now go through `run-detail-url-state.ts`. CI output bag narrowing moved into `run-detail-model.ts` instead of using `any` casts inline.
- `workspace/ready-workspace.ts` and `workspace/review-workspace.ts` now share `workspace-url-state.ts`, preserving unrelated hash params and replace-state semantics.
- `dispatch/dispatch-wizard.ts` URL/prefill parsing now lives in `dispatch-wizard-prefill.ts`, with draft, selector, validation, and payload seams split into focused helpers and golden payload tests.
- `evals/eval-cockpit.ts`, `fleet-map/fleet-canvas.ts`, and `pr-dashboard/pr-board.ts` now use dedicated URL-state helper modules backed by focused parse/serialize/preserve-param tests.
- New stateful hash/query parsing should continue to go through `ui/src/utils/url-state.ts` or a narrow view-local module that wraps it with focused tests.

## Typing convention

- New/extracted helper modules should expose narrow typed inputs and focused `tsx` tests.
- Do not add `any`, `as any`, `as unknown`, or fixture casts. If an output bag is genuinely untyped (`Record<string, unknown>`), add a typed reader/narrower close to the consuming view and test it.
- Extracted slot-view renderers are typed against `SlotView` instead of `view: any`; keep those collaborators internal-by-convention (`_` names) and prefer future pure/model seams over adding new renderer host surface area.
- Known legacy `any` debt that remains outside this PR's touched/extracted helper surfaces: `runs/run-pipeline.ts`, `runs/run-pipeline-mini.ts`, and `workspace/git-changes.ts`. Do not copy those patterns; replace them with typed readers when those files are next refactored.

## Protocol/backend split foundation (PR-A)

Protocol compatibility barrels now stay at the historical public paths:

- `../../packages/protocol/src/types.ts` → re-exports neutral domain/common type entrypoints.
- `../../packages/protocol/src/methods.ts` → re-exports neutral domain/common method entrypoints.
- New domain entrypoints live under `../../packages/protocol/src/types/*` and `../../packages/protocol/src/methods/*`.
- `../../packages/protocol/package.json` declares explicit `./types`, `./methods`, `./types/*`, and `./methods/*` exports so existing subpath imports and new domain imports resolve deterministically.
- `../../packages/protocol/src/domain-imports.test.ts` is the import smoke test for old and new protocol surfaces.

Gateway backend seams extracted in this pass:

- `services/gateway/src/run-engine/ci-watch-chain.ts` owns CI follow-up run creation parameters and chain metadata.
- `services/gateway/src/run-engine/decision-replay.ts` owns human-gate replay and collision-decision replay predicates.
- `services/gateway/src/run-engine/diff-artifacts.ts` owns diff/stat capture, review-input artifact capture, pathspec quoting, and artifact mutation serialization; `diff-artifact-utils.ts` owns atomic artifact writes, timeout guards, hash helpers, and diff-too-large stderr parsing.
- `services/gateway/src/run-engine/publish-package-refresh.ts` owns ready-gate package refresh, evidence-selection preservation, and refreshed-review restamping; focused publish-package refresh tests import that owner directly.
- `services/gateway/src/run-engine/engine-decisions.ts` owns engine decision creation/resolution, validation-mode auto-resolution, and task-directory collision redirects; callers import that owner directly instead of routing decisions through the run-engine orchestrator.
- `services/gateway/src/run-engine/review-gate.ts` owns review-posting gate creation, PR comment posting, evidence-quality override persistence, and pending review-gate refresh; run RPC handlers import refresh directly from that owner.
- `services/gateway/src/run-engine/ready-gate.ts` owns ready/publication gate payload construction, independent publish-review loops, approval-package validation, CI/self-review summaries, and gate feedback artifacts.
- `services/gateway/src/run-engine/task-steps.ts` owns GRADE and WRITE_TASK behavior: ticket hydration/grading, project/flow mismatch prompts, review-recipe strategy selection, TASK.md generation, task-directory collision retry, template provenance, and review-input artifact capture.
- `services/gateway/src/run-engine/dispatch-policy.ts` owns dispatch preview params, slot-selection labels, runner/model resolution, and CI terminal patch mapping.
- `services/gateway/src/run-engine/eval-replay-normalization.ts` owns eval replay task profile/start-ref normalization.
- `services/gateway/src/run-engine/gate-policy.ts` owns publication-review policy, no-change gate copy, PR self-approval detection, and pure gate status transforms.
- `services/gateway/src/run-engine/recovery.ts` owns startup recovery, blocked-review decision rehydration, recovery health checks, and orphaned-slot reconciliation behind typed collaborators.
- `services/gateway/src/run-engine/review-artifacts.ts` owns worker artifact mirroring and review artifact parsing.
- `services/gateway/src/run-engine/remote-probes.ts` owns remote PATH readiness probing used by run preparation/recovery checks.
- `services/gateway/src/run-engine/review-plan.ts` owns publish-gate review-loop parsing and human-gate review-depth policy.
- `services/gateway/src/run-engine/run-links.ts` owns run external-link projection.
- `services/gateway/src/run-engine/task-artifacts.ts` owns optional task artifact reads and diff-stat projection.
- `services/gateway/src/run-engine/task-sync.ts` owns forward task-file synchronization into the worker slot.
- `services/gateway/src/run-engine/ticket-data.ts` owns PR/Jira ticket hydration and flow-type mismatch detection.
- `services/gateway/src/run-completion/artifact-mirror.ts` owns worker artifact mirroring, recipe-run cache preservation, and mirror cache invalidation.
- `services/gateway/src/run-completion/draft-pr.ts` owns local-first draft PR title/body generation and local evidence preview insertion.
- `services/gateway/src/run-completion/evidence-manifest.ts` owns evidence manifest rendering and caption-confidence gating.
- `services/gateway/src/run-completion/independent-reviews.ts` owns self-review materialization and review-loop artifact attempt recovery.
- `services/gateway/src/run-completion/package-evidence-manifest.ts` owns immutable publishable evidence manifest entry construction.
- `services/gateway/src/run-completion/pr-publication.ts` owns PR comment, title, and ready-state mutations.
- `services/gateway/src/run-completion/ready-gate-package.ts` owns ready-gate package hashing, selected evidence validation, and prepared package reads.
- `services/gateway/src/self-review/review-agent.ts` owns self-review runner launch/completion collection, while `issues.ts` and `worker-lifecycle.ts` own issue parsing and worker relaunch/liveness helpers.
- `services/gateway/src/chat/assistant-response.ts`, `safe-client-context.ts`, and `screen-evidence-prompt.ts` own chat parser, untrusted UI-context sanitization, and screen-evidence prompt compaction; tests now live beside those owners.
- `services/gateway/src/chat/tool-definitions.ts` owns Co-Pilot tool schemas, and `self-inspection-tools.ts` owns bounded Farmslot file/log/task read/search helpers with beside-owner tests. Gateway internals import definitions from the owner module rather than through `chat-tools.ts`.
- `services/gateway/src/chat/chat-action-normalization.ts` owns model-suggested action allowlisting, label/param normalization, short-run-id expansion, and slot.prepare param dropping; normalization tests live beside that owner.
- `services/gateway/src/methods/dispatch/role-target.ts`, `safety-tier.ts`, `task-flow-key.ts`, and `slot-file-write.ts` own dispatch role-target parsing, safety-tier precedence, task-flow default-key mapping, and local/remote slot text writes. Internal callers now import these owners directly.
- `services/gateway/src/methods/dispatch/ticket-ref.ts` owns ticket/PR normalization and validation.
- `services/gateway/src/methods/dispatch/slot-scoring.ts` owns slot scoring, identity-policy checks, Jira-branch matching, and claim status composition.
- `services/gateway/src/methods/filesystem/range-serving.ts` owns MIME lookup and HTTP byte-range serving for local and proxied artifact files with beside-owner tests.
- `services/gateway/src/auto-recovery/watcher-llm.test.ts` owns LLM auto-recovery budget/timeout/proposal coverage, while `watcher-test-fixtures.ts` owns shared watcher test fixtures.
- `services/gateway/src/runners-safety.test.ts` owns ADR-023 runner safety-tier and launch-policy coverage, while `runners-test-fixtures.ts` owns shared runner test fixtures.
- `services/gateway/src/runners/launch-command.ts` owns runner shell command construction, `runners/session-process.ts` owns session-file/process-descendant helpers, and `runners/status-provider.ts` owns runner status scraping.
- `services/gateway/src/live-recipe-artifact-filters.ts` owns live recipe artifact path normalization, evidence-manifest references, and hidden/excluded artifact scan filtering with beside-owner tests.
- `services/gateway/src/live-recipe-context-cache.test.ts` owns live recipe context memo/artifact-cache coverage, `live-recipe-context-selection.test.ts` owns selection/video/group ordering coverage, and `live-recipe-context-test-fixtures.ts` owns shared run/node fixtures.
- `services/gateway/src/family-observability-change-ledger.test.ts` owns family change-ledger coverage, `family-observability-provenance.test.ts` owns recipe provenance/report coverage, `family-observability-retrospective.test.ts` owns retrospective coverage, and `family-observability-test-fixtures.ts` owns shared observability fixtures.
- `services/gateway/src/methods/eval/candidate-setup.ts` owns eval candidate axes/template/harness setup, and `methods/eval/source-resolution.ts` owns reference source hydration plus merged-PR input materialization.
- `services/gateway/src/ci-monitor/state.ts` owns CI-watch persisted phase/dedup/progress helpers, and `ci-monitor/inline-fix.ts` owns CI-FIX task writing, worker nudging, HEAD/signal polling, and check reruns.
- `services/gateway/src/server/route-method.ts` owns non-run RPC dispatch, `server/run-route.ts` owns run/eval/family/operator RPC dispatch, `server/client-state.ts` owns websocket client/subscription state types, and `server/terminal-subscriptions.ts` owns terminal unsubscribe key selection with beside-owner tests. `server.ts` remains the websocket lifecycle/frame-routing owner.
- `services/gateway/src/family-observability/change-ledger.ts` owns family diff/review-signal ledger projection, `eval-experiments.ts` owns eval package projection, `artifacts.ts` owns artifact normalization, `io.ts` owns optional artifact reads, and `report.ts` owns report generation/cache. Change-ledger coverage now lives beside its owner.
- Eval/result-package/template-provenance protocol declarations now live in `../../packages/protocol/src/types/evals.ts` and eval RPC method contracts live in `../../packages/protocol/src/methods/eval.ts`; compatibility barrels continue to re-export them.
- The former mega-suite `services/gateway/src/run-engine.test.ts` is deleted. Run-engine coverage now lives beside the owner modules under `services/gateway/src/run-engine/*.test.ts`; each focused suite is under 800 LOC, and shared fixtures live in `services/gateway/src/run-engine/test-fixtures.ts`.

For Gateway internals, prefer direct imports from the focused owner modules after extraction. Keep compatibility façades only for deliberate public or runtime entrypoints, not as a dumping ground for first-party convenience re-exports.

## Final single cleanup PR review gate

The final Command Center refactor cleanup PR was verified against
`.omx/plans/final-command-center-refactor-single-pr.md`. This pass keeps
behavior stable while completing the remaining UI/backend/protocol mega-file
cleanup behind focused typed helper modules. Gateway internals should import
focused owners directly once a seam is extracted; compatibility façades are only
for deliberate public/runtime entrypoints.

Validation evidence belongs in the PR body/check output, not committed quality
logs. The branch must pass `yarn typecheck`, `yarn lint:type-escapes`,
`yarn lint`, `yarn format:check`, `yarn quality`, focused lane tests, CDP route
smokes, and independent cross-review before merge.

Current high-churn line-count snapshot:

| Host file                                                         | Lines | Target | Status  |
| ----------------------------------------------------------------- | ----: | -----: | ------- |
| `services/gateway/src/run-engine/orchestrator.ts`                 |   965 |  1,000 | met     |
| `services/gateway/src/run-engine/diff-artifacts.ts`               |   979 |  1,000 | met     |
| `services/gateway/src/run-engine/publish-package-refresh.ts`      |   273 |  1,000 | met     |
| `services/gateway/src/run-engine/review-gate.ts`                  |   500 |  1,000 | met     |
| `services/gateway/src/run-engine/ready-gate.ts`                   |   563 |  1,000 | met     |
| `services/gateway/src/run-engine/task-steps.ts`                   |   559 |  1,000 | met     |
| `services/gateway/src/methods/run.ts`                             |   978 |  1,000 | met     |
| `services/gateway/src/run-completion/orchestrator.ts`             |   988 |  1,000 | met     |
| `services/gateway/src/self-review/orchestrator.ts`                |   975 |  1,000 | met     |
| `services/gateway/src/copilot-runtime/controller.ts`              |   634 |  1,000 | met     |
| `services/gateway/src/chat/chat-tools.ts`                         |   730 |  1,000 | met     |
| `services/gateway/src/chat/chat-tools.test.ts`                    |   524 |  1,000 | met     |
| `services/gateway/src/chat/chat-actions.ts`                       |   862 |  1,000 | met     |
| `services/gateway/src/chat/chat-actions.test.ts`                  |   981 |  1,000 | met     |
| `services/gateway/src/live-recipe-context.ts`                     |   956 |  1,000 | met     |
| `services/gateway/src/live-recipe-context.test.ts`                |   948 |  1,000 | met     |
| `services/gateway/src/live-recipe-context-cache.test.ts`          |   398 |  1,000 | met     |
| `services/gateway/src/live-recipe-context-selection.test.ts`      |   196 |  1,000 | met     |
| `services/gateway/src/auto-recovery/watcher.test.ts`              |   913 |  1,000 | met     |
| `services/gateway/src/auto-recovery/watcher-llm.test.ts`          |   490 |  1,000 | met     |
| `services/gateway/src/runners.ts`                                 |   972 |  1,000 | met     |
| `services/gateway/src/runners/launch-command.ts`                  |   272 |  1,000 | met     |
| `services/gateway/src/runners/session-process.ts`                 |   142 |  1,000 | met     |
| `services/gateway/src/runners/status-provider.ts`                 |    75 |  1,000 | met     |
| `services/gateway/src/runners.test.ts`                            |   681 |  1,000 | met     |
| `services/gateway/src/runners-safety.test.ts`                     |   457 |  1,000 | met     |
| `services/gateway/src/family-observability.ts`                    |   926 |  1,000 | met     |
| `services/gateway/src/family-observability/artifacts.ts`          |    81 |  1,000 | met     |
| `services/gateway/src/family-observability/change-ledger.ts`      |   355 |  1,000 | met     |
| `services/gateway/src/family-observability/change-ledger.test.ts` |   765 |  1,000 | met     |
| `services/gateway/src/family-observability/eval-experiments.ts`   |   246 |  1,000 | met     |
| `services/gateway/src/family-observability/io.ts`                 |    42 |  1,000 | met     |
| `services/gateway/src/family-observability/report.ts`             |   109 |  1,000 | met     |
| `services/gateway/src/family-observability.test.ts`               |   544 |  1,000 | met     |
| `services/gateway/src/family-observability-provenance.test.ts`    |   528 |  1,000 | met     |
| `services/gateway/src/family-observability-retrospective.test.ts` |   279 |  1,000 | met     |
| `services/gateway/src/methods/eval.ts`                            |   978 |  1,000 | met     |
| `services/gateway/src/methods/eval/source-resolution.ts`          |   436 |  1,000 | met     |
| `services/gateway/src/methods/eval/candidate-setup.ts`            |   166 |  1,000 | met     |
| `services/gateway/src/ci-monitor.ts`                              |   943 |  1,000 | met     |
| `services/gateway/src/ci-monitor/inline-fix.ts`                   |   641 |  1,000 | met     |
| `services/gateway/src/ci-monitor/state.ts`                        |   258 |  1,000 | met     |
| `services/gateway/src/server.ts`                                  |   556 |  1,000 | met     |
| `services/gateway/src/server/route-method.ts`                     |   935 |  1,000 | met     |
| `services/gateway/src/server/run-route.ts`                        |   223 |  1,000 | met     |
| `services/gateway/src/server/client-state.ts`                     |    43 |  1,000 | met     |
| `services/gateway/src/server/terminal-subscriptions.ts`           |    46 |  1,000 | met     |
| `services/gateway/src/server/terminal-subscriptions.test.ts`      |    54 |  1,000 | met     |
| `services/gateway/src/methods/dispatch/execute.ts`                |   999 |  1,000 | met     |
| `services/gateway/src/methods/filesystem.ts`                      |   950 |  1,000 | met     |
| `services/gateway/src/methods/dispatch/preview.ts`                |   825 |    900 | met     |
| `services/gateway/src/methods/dispatch/nudge.ts`                  |   406 |    500 | met     |
| `../../packages/protocol/src/types/common.ts`                     |    14 |     50 | met     |
| `../../packages/protocol/src/methods/registry.ts`                 |   259 |    300 | met     |
| `ui/src/components/evals/eval-cockpit.ts`                         | 2,208 |  1,000 | UI lane |
| `ui/src/components/dispatch/dispatch-wizard.ts`                   | 1,951 |  1,000 | UI lane |

Final cleanup notes:

- Slot and dispatch method public entrypoints are three-line runtime façades.
  Slot lifecycle implementation now lives in focused modules under
  `services/gateway/src/methods/slot/`; dispatch keeps a small compatibility
  barrel under `services/gateway/src/methods/dispatch/index.ts` while preview,
  queue, project matching, nudge, slot scoring, and ticket-reference logic live in
  focused dispatch modules. Keep future dispatch changes domain-scoped.
- Protocol compatibility barrels are below target and continue to re-export domain
  modules for compatibility; first-party `legacy.ts` filenames are guarded against by
  `scripts/quality/check-no-first-party-legacy.mjs`.
- Eval cockpit and dispatch wizard now keep URL/prefill, model/payload,
  validation, preview, and style seams in focused modules with tests.
- Type-escape and ESLint ratchet baselines are pruned as part of this pass so
  stale allowlist entries do not hide cleanup progress.
- No new production `any`, `as any`, `as unknown`, eslint disables, or
  `@ts-ignore` entries are allowed.

## Massive-file breakup inventory

### Current large-file triage

`yarn quality:large-files` currently reports 45 tracked source/docs files above
1,000 LOC. This remains a warning, not a blocker:

- **Services:** Gateway and Node TypeScript files are below the threshold after
  the service cleanup; keep future service growth in owner modules.
- **Command Center UI:** defer UI mega-component splits to the active UI cleanup
  lane so behavior can be validated with CDP.
- **Mobile Companion:** treat large released-app route files as stabilization
  debt and split only with dedicated app regression coverage.
- **Protocol and recipe harness:** recipe validators, `types/runs.ts`,
  `recipe-harness/src/runner.ts`, and the harness mega-test are acceptable
  until a protocol/harness behavior change gives a focused seam to extract.
- **Schema, skills, and reference docs:** acceptable unless touched by a planned
  owner-domain change.

Snapshot line counts after the final cleanup pass. Counts are not the only goal:
the important reduction is responsibility moved behind focused, tested seams
while deliberate runtime entrypoints remain stable.

| File                                                  | Lines | Current boundary / future touch rule                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/gateway/src/run-engine/orchestrator.ts`     |   965 | Lifecycle orchestration only; focused modules own task/grading steps, dispatch policy, CI chaining, engine decisions/collisions, review-posting gates, ready/publication gates, decision replay, eval replay normalization, links, task sync/artifact reads, ticket hydration, review artifact mirroring, CI watch, dispatch lifecycle, recovery, finalization, sub-step collection, and publish-package refresh. |
| `services/gateway/src/family-observability.ts`        |   926 | Family snapshot orchestration; artifact normalization, optional reads, eval package projection, change ledger, and report generation now live under `family-observability/` owner modules with beside-owner change-ledger tests.                                                                                                                                                                                  |
| `ui/src/components/runs/family-observability.ts`      | 3,098 | Data/render helpers, URL state, evidence, and output-model seams are extracted; only split further when changing that domain.                                                                                                                                                                                                                                                                                     |
| `ui/src/components/slot-view/slot-view.ts`            | 3,177 | Header, panel, URL-state, and live-effect seams are extracted; keep future branch/PR plumbing changes covered by route/gateway smokes.                                                                                                                                                                                                                                                                            |
| `ui/src/components/runs/run-detail.ts`                | 2,467 | URL/model/evidence helpers and render sections are extracted; keep run loading/actions and gate controls narrow.                                                                                                                                                                                                                                                                                                  |
| `ui/src/components/evals/eval-cockpit.ts`             | 2,152 | URL state, model/payload/result, preview, guide, and style helpers are extracted.                                                                                                                                                                                                                                                                                                                                 |
| `services/gateway/src/methods/slot.ts`                |     3 | Public façade; slot lifecycle implementation is split under `methods/slot/*` (`prepare.ts`, `prepare-command.ts`, `release.ts`, etc.).                                                                                                                                                                                                                                                                            |
| `services/gateway/src/methods/slot/prepare.ts`        |   743 | Prepare orchestration; command execution, sentinels, fixtures, and shared state live in focused siblings.                                                                                                                                                                                                                                                                                                         |
| `services/gateway/src/methods/slot/check.ts`          |   567 | Slot check/health helpers.                                                                                                                                                                                                                                                                                                                                                                                        |
| `services/gateway/src/methods/slot/release.ts`        |   497 | Release plus tmux agent-window cleanup helpers.                                                                                                                                                                                                                                                                                                                                                                   |
| `../../packages/protocol/src/types/common.ts`         |    14 | Neutral primitives only (`OkResult`, command output shapes); domain declarations live in `types/*`.                                                                                                                                                                                                                                                                                                               |
| `ui/src/components/dispatch/dispatch-wizard.ts`       | 1,939 | URL/prefill, draft, selector, validation, payload, and style seams are extracted.                                                                                                                                                                                                                                                                                                                                 |
| `ui/src/components/workspace/ready-workspace.ts`      | 1,832 | URL state, artifact grouping/filtering, and light-DOM style helpers are extracted.                                                                                                                                                                                                                                                                                                                                |
| `services/gateway/src/methods/dispatch.ts`            |     3 | Public façade; delegates to `methods/dispatch/index.ts`, which re-exports dispatch leaves.                                                                                                                                                                                                                                                                                                                        |
| `services/gateway/src/methods/dispatch/index.ts`      |     5 | Dispatch internal barrel; do not add implementation here.                                                                                                                                                                                                                                                                                                                                                         |
| `services/gateway/src/methods/dispatch/execute.ts`    | 1,073 | Remaining dispatch orchestration; ticket refs and slot scoring are already extracted, split future queue/preview/affinity edits by domain.                                                                                                                                                                                                                                                                        |
| `services/gateway/src/methods/run.ts`                 |   978 | Slot-history, improvement-proposal, replay-step, ticket-policy, lifecycle-control, admin, context, and engine-op ownership are extracted under `methods/run/`; `run.test.ts` is also below 1000 LOC. Keep future run CRUD/lifecycle splits beside tests and import owner modules directly.                                                                                                                        |
| `services/gateway/src/methods/pr.ts`                  |   970 | Raw GitHub snapshot/cache, GraphQL batch prefetch, JSONL parsing, and review-comment mutation RPC ownership are extracted under `methods/pr/`; `pr.test.ts` is also below 1000 LOC. Keep future PR API additions in owner modules and import them directly.                                                                                                                                                       |
| `services/gateway/src/run-completion/orchestrator.ts` |   988 | Publication artifacts, ready-gate package hashing, evidence captioning, artifact mirroring, draft PR generation, independent review materialization, package evidence manifest construction, PR publication mutations, and retrospective logic are extracted. Keep future completion work in owner modules.                                                                                                       |
| `services/gateway/src/server.ts`                      |   556 | WebSocket lifecycle, auth handshake, node frame pre-routing, client cleanup, and broadcast fanout only; RPC dispatch now lives under `server/` owner modules.                                                                                                                                                                                                                                                     |
| `services/gateway/src/server/route-method.ts`         |   935 | Non-run RPC dispatch boundary; keep method handler implementation in `methods/*` owners and move any future large method family into a sibling route module.                                                                                                                                                                                                                                                      |
| `services/gateway/src/server/run-route.ts`            |   223 | Run/eval/family/operator RPC dispatch boundary; keep run behavior in `methods/run/*`, eval, and family owners rather than growing websocket server code.                                                                                                                                                                                                                                                          |
| `../../packages/protocol/src/methods/registry.ts`     |   244 | Method name registry only; domain method contracts live under `methods/*`.                                                                                                                                                                                                                                                                                                                                        |
| `services/gateway/src/self-review/orchestrator.ts`    |   975 | Feedback, progress, snapshot, template, review-agent launch/completion, issue parsing, and worker relaunch/liveness seams are extracted; keep retry orchestration thin and move future runner/provider details into owner modules.                                                                                                                                                                                |
| `ui/src/components/runs/run-pipeline.ts`              | 1,591 | Pipeline model derivation and CI/progress helpers are extracted.                                                                                                                                                                                                                                                                                                                                                  |
| `ui/src/components/workspace/review-workspace.ts`     | 1,208 | URL state and light-DOM style helpers are extracted.                                                                                                                                                                                                                                                                                                                                                              |
| `ui/src/state.ts`                                     |   985 | URL state is extracted; continue keeping bootstrap/event wiring separate from selectors and mutation helpers.                                                                                                                                                                                                                                                                                                     |

Future refactors should be opportunistic and domain-scoped: do not start a new
cleanup-only PR unless a concrete behavior change, test gap, or regression fix
requires touching one of these seams.
