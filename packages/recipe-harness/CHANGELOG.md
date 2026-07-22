# Changelog

All notable changes to `@farmslot/recipe-harness` are tracked here.

## Unreleased

## 0.9.0 - 2026-07-22

- **BREAKING:** Unify direct and nested execution on parameterized recipes, one ordered recipe index, and one recursive executor; remove the separate reusable graph CLI/runtime.
- Emit `recipe-resolution.json` plus exact digest-keyed reachable recipes and expose recipe list/describe discovery.
- Preflight nested parameters, depth, trust, and dependency paths before side effects; resolution failures include stable recovery guidance.
- Validate composed artifact packages from their retained dependency graph without requiring the source library.
- Discover an adjacent `recipe-library/` for task-authored recipes.

## 0.8.0 - 2026-07-19

- Added provenance-aware preflight/execution planning that blocks restricted capabilities from unknown or untrusted sources before side effects; approvals bind to the exact resolved plan digest
- Included automatic HUD execution in the approved plan
- Bound approvals to the project root, artifact destination, and effective run environment
- Fixed source-swap and symlink boundary bypasses across custom implementations, project reads, flow catalogs, and artifact/video writes
- Fixed managed-run approval recovery instructions and caller-selected library trust defaults
- Added an explicit-environment mode so host wrappers can exclude internal control variables from recipe execution and approval identity

## 0.7.0 - 2026-07-19

- Added `flows describe <ref>` with resolved provenance, parameter schema/defaults, the complete flow definition, and an authored call node or clearly labeled template in human and stable JSON output.

## 0.6.0 - 2026-07-13

- fix: require Yarn's `node_modules/.yarn-state.yml` install surface when `nodeLinker: node-modules`, so a leftover `.yarn/install-state.gz` cannot report removed dependencies as current

## 0.5.0 - 2026-07-12

- feat: record passive UI observations for default and node-level observe policies in recipe traces, including replayable controls inside open shadow roots without exposing input values as labels.
- fix: dependency readiness trusts install markers newer than dependency inputs even when an older recorded baseline exists, preventing unnecessary reinstall prompts in managed slots.
- fix: use workspace-linked `@farmslot/protocol` during local development so package builds cannot resolve a stale published sibling package.

## 0.4.3 - 2026-07-09

- fix: dependency readiness no longer treats an old recorded baseline as stale when install markers are newer than `package.json`/`yarn.lock`, avoiding repeated unnecessary reinstall prompts in managed slots

## 0.4.2 - 2026-07-09

- feat: a run that composes flows now emits `resolved-recipe.json` — the authored recipe with every reachable flow (inline, `uses`, or library, transitively) inlined under `flows`. This artifact is self-contained and validates as a complete recipe without the library
- feat: export `composeRecipe` / `buildResolvedRecipe` — the shared composition step used by the runner (executed path) and the CLI static resolve-check to derive the same `resolved-recipe.json`

## 0.4.1 - 2026-07-08

- `watch_logs` now defaults to run-scoped matching using file offsets captured at recipe start across the main workflow and called flows, so markers written before the run cannot satisfy log assertions. Use `scope: "file"` to explicitly scan the whole file

## 0.4.0 - 2026-07-07

- Add a standard outer `app.lifecycle` adapter for Android and iOS simulator launch/foreground/terminate/restart lifecycle control, with Android background support for performance recipes. Exported as `@farmslot/recipe-harness/adapters/app-lifecycle`.

## 0.3.3 - 2026-07-03

- `resolved-flows.json` is emitted whenever a run had any library resolution activity (used, overridden, or shadowed flows) — previously a run that overrode every library flow with recipe-local declarations produced no artifact even though `summary.json` recorded the overrides
- `flows promote` fails loudly, naming every offending catalog file, when the target library already declares the ref in more than one catalog (pre-existing corruption); `--force` no longer overwrites just one of the duplicates and leaves the library unloadable
- Multi-source recipe library resolution: `call` refs can resolve from ordered, named library sources (`--library name=path`, `RECIPE_LIBRARY_PATH`, or the personal library at `<farmslot home>/recipe-library`). First source wins; recipe-local flows always win. Nothing resolves silently for any consumer: cross-source shadowing and recipe-local overrides are recorded in `summary.json` `flowResolution` (`shadowed`, `overrides`) and in the `resolved-flows.json` artifact alongside the used definitions, in addition to logging
- `farmslot-recipe flows list` — list library flows with source, description, required params, and last-verified date across configured sources; exits non-zero when no source is configured
- `farmslot-recipe validate --library` — validate accepts library-resolved `call` refs with the same source resolution as run
- `farmslot-recipe flows promote` — promote an inline flow from a per-change recipe into a recipe library (default: the personal library, created on first promote). Enforces the catalog contract (description required, postcondition required for `ensure_*`), stamps `provenance.promotedFrom`/`promotedAt`, and stamps `lastVerified` only from a passing run's artifacts (`--run <dir>`)

## 0.3.2 - 2026-06-30

- Document `orchestrateRuntimeUp` `build` decision as terminal — hosts must call again after native build finishes.
- Use the installed `capture-helper` package for capture runs.

## 0.3.1 - 2026-06-26

- Add `runtime/orchestrate-up` — generic install → relaunch decision loop (`orchestrateRuntimeUp`) for product runners to wrap with shell/platform actions.

## 0.3.0 - 2026-06-26

- Add shared runtime-readiness helpers under `@farmslot/recipe-harness/runtime/*`:
  - `deps-readiness` — install fingerprint, baseline recording, product-marker partial checks, decision state persistence
  - `log-analysis` — Metro/RN bundle log boundaries, unresolved-module scoping, persistent bundle-error detection
  - `metro-probe` — packager `/status` reachability probe
  - `decision-types` — portable `RuntimeDecisionReport` / `RuntimeDecisionAction` shapes
- Product runners (e.g. MetaMask) should import these modules instead of copying readiness logic locally.

## 0.2.2 - 2026-06-10

- Publish with npm-resolvable `@farmslot/protocol` dependency metadata instead of workspace-only protocol references.

## 0.2.1 - 2026-06-10

- Drive CDP text inputs with trusted keyboard insertion instead of direct DOM value assignment so React-controlled inputs receive real input/change handling.
- Drive CDP clicks with real mouse events and expose `ui.key_press` through the standard UI adapter.

## 0.2.0 - 2026-06-02

- Define the v0 public harness package surface with explicit core, adapter, node, CLI, and runtime entry points.
- Publish recipe runner runtime helpers under explicit `runtime/*` subpaths for browser extension, CDP, and React Native bridge clients.
- Keep CLI and writer implementation details behind explicit subpath exports instead of wildcard package exports.

## 0.1.0 - 2026-05-31

- Initial public active-development release.
