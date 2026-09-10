# @farmslot/recipe-harness

Generic Recipe Protocol v1 runner. It executes parameterized recipe graphs through registered actions and writes portable evidence.

Canonical references:

- [Recipe harness architecture](https://farmslot.io/docs/architecture/recipe-harness)
- [Recipe Protocol v1](https://farmslot.io/docs/reference/recipe-protocol-v1)
- [Recipe Runner Protocol](https://farmslot.io/docs/reference/recipe-runner-protocol)
- [Recipe composition quality](https://farmslot.io/docs/reference/recipe-composition-quality)

## Install

```bash
yarn add @farmslot/recipe-harness @farmslot/protocol
# or
npm install @farmslot/recipe-harness @farmslot/protocol
```

## Model

- An **action** is one atomic runner capability.
- A **recipe** is one executable graph that can run directly or through a `call` node.
- Root and called recipes use the same validator, parameter rules, graph executor, observers, and trace.
- The complete static call graph and trust plan resolve before side effects.

The harness owns graph execution, standard actions, library resolution, trust preflight, and evidence writers. Projects own platform transports and namespaced domain actions.

## Source layout

- `src/core/` — validation, composition, execution, trust, and libraries.
- `src/adapters/` — standard core and UI adapters.
- `src/runtime/` — shared CDP, browser-extension, React Native, and readiness helpers.
- `src/cli/` and `src/node/` — CLI behavior and evidence writers.
- `test/` — public behavior and package-boundary tests.

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
  params: { environment: 'local' },
  artifactsDir: 'artifacts/recipe-run',
  projectRoot: process.cwd(),
});

if (result.status !== 'pass') process.exitCode = 1;
```

Runner construction and preflight fail when a required action, adapter, precondition, dependency recipe, digest, or approval is missing.

## CLI

Discover first:

```bash
farmslot-recipe run --list --adapter core
farmslot-recipe run service.smoke --describe --adapter core
```

Run a library recipe with typed `key=value` parameters:

```bash
farmslot-recipe run service.smoke environment=local retries=2 \
  --adapter core \
  --library team=../team-recipes \
  --action-manifest action-manifest.json \
  --artifacts-dir artifacts/recipe-run
```

A recipe path works in place of a library id. UI, CDP, React Native, browser-extension, and domain actions require a project runner that registers those adapters.

## Recipe libraries

```text
recipes/
  shared/wallet/ensure_unlocked.recipe.json
  extension/checkout/smoke.recipe.json
  mobile/checkout/smoke.recipe.json
```

Recipe ids derive from their path below `recipes/`. Configure a source as
`name=/path` when its provenance label should differ from the directory name.
The first directory is the scope: `core`, `extension`, `mobile`, or `shared`.
Domains sit underneath. Scope does not become part of the id: the shared recipe
is `wallet.ensure_unlocked`, and both platform examples are `checkout.smoke`.
Keep one shared graph when only inputs differ; use an adapter variant when the
behavior differs. An exact adapter variant takes precedence over its shared
counterpart within the same source. Legacy `smoke.mobile.recipe.json` and
`smoke.extension.recipe.json` paths remain readable during migration. A recipe
must not declare its adapter through both forms, and canonical and legacy files
for the same adapter/id are rejected as duplicates. Unscoped generic paths
remain readable, but new libraries use scope-first folders. The four scope
directory names are reserved; a shared recipe cannot also declare an adapter
in its filename.

Sources are ordered and the first source wins. Configure repeatable `--library name=path`, `RECIPE_LIBRARY_PATH`, or the personal library under the Farmslot home. Shadows are reported. Duplicate ids within one source and escaping symlinks are rejected.

A `call` node resolves from the same index as direct `run`:

```json
{
  "action": "call",
  "ref": "wallet.ensure_unlocked",
  "params": { "account": "dev1" },
  "intent": "Prepare the proof account",
  "next": "verify"
}
```

## Evidence

Each run writes:

- `recipe.json` — exact authored root;
- `recipe-resolution.json` — root/dependency digests, selected sources, adapter variants, and call edges;
- `resolved-recipes/<sha256>.recipe.json` — exact reachable dependency documents;
- `summary.json`;
- `trace.json`;
- `artifact-manifest.json`.

Only reachable recipes are retained. Artifact validation verifies every recipe, digest, and edge.

Failed trace entries also record an explicit ownership class. Assertion
mismatches are `subject`; harness-owned machinery and unavailable prerequisites
must emit their structured classes; untyped failures remain `unknown`. Summary
cause counts reconcile exactly with the failed trace entries.

A non-zero `command` exit is untyped and remains `unknown`; callers that can
prove ownership must raise `RecipeExecutionError` with the appropriate class.

## Suite evidence

Freeze scope before executing cases, then finalize already-completed runs. The
finalizer copies retained summaries into one portable suite package; it never
schedules cases or invents non-execution reasons.

```ts
import { finalizeRecipeSuite, freezeRecipeSuiteScope } from '@farmslot/recipe-harness';

const frozen = freezeRecipeSuiteScope(scopeJson);
const suite = await finalizeRecipeSuite({
  scope: frozen,
  outputDir: 'artifacts/suite',
  resolutions: [
    { id: 'smoke', kind: 'verdict', result: completedRun },
    {
      id: 'hardware',
      kind: 'not_executed',
      reason_class: 'needs_manual',
      detail: 'Requires hardware confirmation.',
    },
  ],
});
```

## Custom action

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

Declare `example.echo` in the action manifest. Keep action names durable and namespaced; task-specific claims belong in recipes.

## UI transport

```ts
import { createStandardUiAdapters } from '@farmslot/recipe-harness';

const uiAdapters = createStandardUiAdapters({
  actions: ['ui.press', 'ui.set_input', 'ui.scroll', 'ui.screenshot', 'app.hud'],
  transport: {
    execute(action, node, context) {
      return projectUiBridge.execute(action, node, context);
    },
  },
});
```

Use `ui.*` for user-visible proof and domain actions for deterministic setup/teardown. Never mutate app state to manufacture evidence. HUD text should state the current human intent; detailed diagnostics belong in trace.

## Visual review boards

Turn visual capture nodes from any Recipe v1 run into a static annotation board:

```bash
farmslot-visual-review build-recipe recipe.json \
  --artifacts artifacts \
  --platform ios \
  --source-id metamask-mobile-farm:perps-surfaces \
  --project metamask-mobile-farm
```

The recipe supplies capture paths plus optional `visual_review` hierarchy, related links, and typed
navigation edges (`tab`, `push`, `in-place`, `modal`, or `replace`). The shared tool copies the
images, emits `visual-review-source.json`, and builds the navigation/annotation board; projects do
not need a renderer.

## Public imports

- `@farmslot/recipe-harness`
- `/runner`, `/types`, `/writers`
- `/adapters/core`, `/adapters/ui`
- `/runtime/cdp`, `/runtime/react-native-bridge`, `/runtime/browser-extension`
- `/runtime/deps-readiness`, `/runtime/log-analysis`, `/runtime/metro-probe`
- `/runtime/decision-types`, `/runtime/orchestrate-up`
- `/cli`, `/cli/support`
- `/visual-review`

Other `src/` modules are internal.

## Security

- Unknown or untrusted recipes preflight before side effects.
- Approval binds the resolved recipe graph, action implementations, environment, project root, and artifact destination.
- Approved custom code still has the current user's OS permissions; plan approval is not a sandbox.
- Custom adapters declare source provenance and a pinned or resolved digest.
- Keep secrets out of recipes, HUD text, trace, screenshots, and artifact paths.

## Maintenance rules

Keep generic execution here and product/domain behavior in project adapters. Update the protocol, exports, tests, docs, and `CHANGELOG.md` together when the public contract changes.

## Local quality

```bash
yarn workspace @farmslot/recipe-harness quality
yarn test:recipe-harness
```

Do not publish unless protocol, docs, exports, and tests agree.

## License

MIT. See [LICENSE](LICENSE).
