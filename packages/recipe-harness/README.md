# @farmslot/recipe-harness

Reusable Recipe Protocol v1 runner for Farmslot.

This package executes portable recipe graphs, validates them against an action
manifest from `@farmslot/protocol`, invokes registered adapters, and writes the
standard artifact package:

- `recipe.json`
- `summary.json`
- `trace.json`
- `artifact-manifest.json`

It is the base runner for backend/CLI projects and the extension point for UI,
React Native, browser extension, native app, and project-domain runners.

## Canonical documents

- [Recipe Protocol v1](https://farmslot.io/docs/reference/recipe-protocol-v1) — source of truth for recipe schema and official actions.
- [Recipe Runner Protocol](https://farmslot.io/docs/reference/recipe-runner-protocol) — runner manifest, adapter, and artifact guidance.
- [Recipe Harness Architecture](https://farmslot.io/docs/architecture/recipe-harness) — package boundary and runtime model.
- [Recipe Composition Quality](https://farmslot.io/docs/reference/recipe-composition-quality) — flow design and proof quality guidance.

If this README conflicts with the public Recipe Protocol v1 reference, the protocol reference wins.

## Install

```bash
yarn add @farmslot/recipe-harness @farmslot/protocol
# or
npm install @farmslot/recipe-harness @farmslot/protocol
```

## Source layout

| Path            | Owns                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `bin/`          | Published `farmslot-recipe` executable shim.                                                                            |
| `src/index.ts`  | Public package export surface.                                                                                          |
| `src/core/`     | Manifest-aware recipe graph execution, flow calls, predicates, HUD node shaping, and harness-local types.               |
| `src/adapters/` | Standard core and UI adapter factories.                                                                                 |
| `src/runtime/`  | Runtime transports (CDP, browser extensions, RN bridge) and shared readiness helpers (deps, log analysis, Metro probe). |
| `src/node/`     | Node-only artifact, trace, and summary writers.                                                                         |
| `src/cli/`      | CLI entrypoint, commands, and shared CLI validation helpers.                                                            |
| `test/`         | Harness package and export-boundary tests mirroring public behavior.                                                    |

## Public import paths

The package exports explicit public subpaths only. Internal modules under
`src/core/`, `src/node/`, and `test/` are implementation details unless
listed here.

| Import path                                            | Use for                                                                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@farmslot/recipe-harness`                             | Preferred root import for runner/adapters.                                                                                                            |
| `@farmslot/recipe-harness/runner`                      | Runner construction helpers.                                                                                                                          |
| `@farmslot/recipe-harness/types`                       | Harness-local runtime types.                                                                                                                          |
| `@farmslot/recipe-harness/adapters/core`               | Standard backend/headless action adapters.                                                                                                            |
| `@farmslot/recipe-harness/adapters/ui`                 | Standard `ui.*` adapter shell.                                                                                                                        |
| `@farmslot/recipe-harness/runtime/cdp`                 | CDP browser transport helpers.                                                                                                                        |
| `@farmslot/recipe-harness/runtime/react-native-bridge` | React Native bridge transport helpers.                                                                                                                |
| `@farmslot/recipe-harness/runtime/browser-extension`   | Browser-extension target helpers.                                                                                                                     |
| `@farmslot/recipe-harness/runtime/deps-readiness`      | Install fingerprint, baseline, product-marker partial checks.                                                                                         |
| `@farmslot/recipe-harness/runtime/log-analysis`        | Bundle-log boundaries, unresolved-module scoping, persistent bundle-error state.                                                                      |
| `@farmslot/recipe-harness/runtime/metro-probe`         | Metro packager `/status` reachability probe.                                                                                                          |
| `@farmslot/recipe-harness/runtime/decision-types`      | Portable `RuntimeDecisionReport` / action shapes for product adapters.                                                                                |
| `@farmslot/recipe-harness/runtime/orchestrate-up`      | Generic install → relaunch orchestration loop for `recipe up` hosts. `build` exits after `onLaunch` — callers re-invoke after native build completes. |
| `@farmslot/recipe-harness/cli`                         | Programmatic CLI entrypoint.                                                                                                                          |
| `@farmslot/recipe-harness/cli/support`                 | Shared CLI input validation helpers.                                                                                                                  |
| `@farmslot/recipe-harness/writers`                     | Node-only JSON artifact writers.                                                                                                                      |

## What belongs here

The harness owns generic execution mechanics:

- runtime-readiness primitives (`runtime/deps-readiness`, `runtime/log-analysis`, `runtime/metro-probe`) — product runners supply adapter-specific markers, log patterns, and shell launch;
- manifest-aware runner construction;
- graph execution, `call` flow composition, setup/start-state/proof/teardown ordering;
- standard core adapters such as `command`, `wait`, `assert_json`, `watch_logs`, and `end`;
- standard UI adapter wiring through a project-provided transport;
- artifact, trace, and summary writers;
- small runtime helpers for CDP, browser-extension pages, and React Native bridge transports.

Project-specific behavior stays outside this package. For example,
`example.trade.place_order`, `checkout.ensure_cart`, or `backend.seed_user`
belong in the project runner that imports this package.

## Changelog

Update [CHANGELOG.md](./CHANGELOG.md) under `## Unreleased` in the same PR as code changes
(Added / Changed / Fixed / Removed). Add a dated version section only when publishing
(`yarn npm publish` — `prepack` checks changelog readiness).

## Minimal runner

```ts
import { createRecipeRunner, createStandardCoreAdapters } from '@farmslot/recipe-harness';
import { getRecipeActionManifestActionNames } from '@farmslot/protocol';

const runner = createRecipeRunner({
  actionManifest,
  adapters: createStandardCoreAdapters({
    actions: getRecipeActionManifestActionNames(actionManifest),
  }),
});

const result = await runner.run({
  recipePath: 'recipes/smoke.recipe.json',
  artifactsDir: 'artifacts/recipe-run',
  projectRoot: process.cwd(),
});

if (result.status !== 'pass') process.exitCode = 1;
```

The manifest is not documentation only. Runner construction fails when:

- a recipe uses an action missing from the manifest;
- a manifest action has no adapter;
- an adapter is registered for an undeclared action, unless it is explicitly test-only;
- a recipe references an undeclared or unimplemented precondition.

## CLI usage

```bash
farmslot-recipe run recipes/smoke.recipe.json \
  --artifacts-dir artifacts/recipe-run \
  --action-manifest action-manifest.json
```

The CLI is useful for backend/CLI projects whose recipes only need core adapters.
UI, CDP, React Native, browser-extension, and domain actions require a project
runner that registers the appropriate adapters.

In this monorepo, build the package before invoking the bin directly from a
clean checkout because the published bin imports compiled `dist/` output:

```bash
yarn workspace @farmslot/recipe-harness build
yarn workspace @farmslot/recipe-harness farmslot-recipe --help
```

## Recipe libraries

A recipe library is a directory (or repo) of reusable flow catalogs a `call`
node can resolve without the recipe declaring a `uses` path:

```text
<library-root>/
  library.json          { "kind": "recipe-library", "schema_version": 1, "name": "personal" }
  flows/*.flows.json    standard recipe-flow-catalog documents
```

Sources are named and ordered; the first source that declares a flow ref wins.
Configure them per run with repeatable `--library name=path` flags or the
`RECIPE_LIBRARY_PATH` environment variable (colon-separated, same entry
format). When neither is set, the harness uses the personal library at
`<farmslot home>/recipe-library` (`FARMSLOT_HOME`, default `~/.farmslot`) if it
exists. Recipe-local declarations (inline `flows` and explicit `uses`
catalogs) always win over library sources.

Resolution is never silent: shadowed declarations are logged, `summary.json`
gains a `flowResolution` block naming each used library flow's source, and the
artifact package includes `resolved-flows.json` with the exact definitions the
run executed, so evidence stays reviewable without access to the libraries.

```bash
farmslot-recipe flows list --library personal=~/.farmslot/recipe-library
farmslot-recipe run recipe.json --artifacts-dir artifacts \
  --action-manifest action-manifest.json \
  --library personal=~/.farmslot/recipe-library --library team=../team-recipes
```

## Custom adapter

```ts
import { defineActionAdapter } from '@farmslot/recipe-harness';

export const echoAdapter = defineActionAdapter({
  action: 'example.echo',
  async execute(node, context) {
    const message = String(node.message ?? '');
    context.logger.info(`echo: ${message}`);
    return { output: { message } };
  },
});
```

The project manifest must declare `example.echo` before the adapter is registered.
Keep action names namespaced and durable; avoid task-specific actions that encode
one Jira ticket or one temporary assertion.

## Standard UI transport

The harness provides the official UI action shell; the project supplies the
transport that knows how to press, scroll, type, navigate, capture screenshots,
or update the HUD in that runtime.

```ts
import { createStandardUiAdapters } from '@farmslot/recipe-harness';

const uiAdapters = createStandardUiAdapters({
  actions: ['ui.press', 'ui.set_input', 'ui.scroll', 'ui.screenshot', 'app.hud'],
  transport: {
    async execute(action, node, context) {
      return projectUiBridge.execute(action, node, context);
    },
  },
});
```

Use `ui.*` for user-visible proof flows. Use project-domain actions for fast
setup/teardown when the goal is state convergence rather than visual proof.
Never mutate UI state directly to manufacture proof.

## HUD guidance

`app.hud` is first-class for UI projects. The HUD should communicate the current
human intent, not internal noise.

Default guidance:

- show one concise intent line;
- keep the default HUD to one concise current-intent line; runners may internally retain parent/child flow context for expanded reviewer/debug views;
- keep debug labels, node ids, and action names out of the default view;
- keep the display minimal enough that it does not hide the proof interaction;
- record detailed metadata in trace instead of crowding the screen.

Projects may configure the HUD layout, but should preserve these semantics so
reviewers can understand what the agent is doing from screenshots or videos.

## Security and portability

- Run recipes from trusted sources only; `command` executes local shell commands.
- Keep artifact paths relative to the artifact directory.
- Do not put secrets in recipe text, HUD text, trace output, screenshots, or
  artifact paths.
- Prefer typed domain actions or state reads over open-ended eval/debug escape
  hatches.
- Treat generated artifacts as reviewer evidence: deterministic, portable, and
  meaningful without access to the original machine.

## Maintenance rules

1. **Keep the harness generic.** No project names, ticket-specific actions, or
   domain behavior in this package.
2. **Adapters are the boundary.** The harness orchestrates; transports and
   domain runners perform runtime-specific work.
3. **Manifest truth is mandatory.** Actions and preconditions must be declared
   before they can run.
4. **Parameterize before multiplying.** Add one flexible adapter/flow before
   adding several near-duplicate files.
5. **Trace details, HUD intent.** Put diagnostics in `trace.json`; reserve HUD
   text for concise human-facing intent.
6. **Fail loudly.** Invalid recipes, unsafe paths, missing adapters, and broken
   artifacts should fail the run with useful trace/summary output.

## Local quality

From the Farmslot repository root:

```bash
yarn workspace @farmslot/recipe-harness quality
yarn test:recipe-harness
```

Before publishing, also run package dry-run checks once publish metadata is in
place. Do not publish unless package docs, canonical docs, exports, and tests all
match the same Recipe Protocol v1 contract.

## License

MIT. See [LICENSE](LICENSE).
