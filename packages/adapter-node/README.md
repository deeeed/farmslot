# @farmslot/adapter-node

A headless Node platform adapter for recipe harnesses, built on `@farmslot/adapter-sdk`. It has
no app, ports, dev server, logs or launch: installed dependencies are its only runtime signal.
The host supplies the adapter id, detection, hints and wording, its action set and overlay
leaves; product checks stay in the host.

```ts
import { createNodeAdapter } from '@farmslot/adapter-node';

export const core = createNodeAdapter({
  id: 'core',
  detect: { files: (target) => hasFile(target, 'packages/my-controller') },
  hints: {
    launch: 'my-harness run <recipe>',
    relaunch: 'my-harness verify',
    runtimeProbeRecovery: (target) => `my-harness verify --target ${target}`,
  },
  wording: { ready: 'Core is headless; dependencies are installed.' },
  dependencies: { runtimeDeps: ['immer'], requiredFor: (_target, use) => usesController(use) },
  workspacePackages: { '@acme/messenger': 'packages/messenger' },
  actions,
  harness,
});
```

A host adds its own members by spreading the result: `{ ...createNodeAdapter(config), readiness }`.

`runtimeStatus` reads the install through recipe-runner's `depsCheck`, which tracks Yarn's install
state, so it reports `deps-missing` for an npm or pnpm checkout even after `installCommand` ran.
Such a host overrides `runtimeStatus` with its own check: `{ ...createNodeAdapter(config), runtimeStatus }`.

Docs: https://farmslot.io/docs/reference/adapter-node

## Source layout

| path                        | owns                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/node-adapter.ts`       | `createNodeAdapter`, its config and wording types, `HEADLESS_FORBIDDEN_FIELDS`                        |
| `src/dependencies.ts`       | `nodeDependencyBlock` (Yarn PnP, node_modules, bins via `resolveBin`, runtime deps), `pnpNodeOptions` |
| `src/workspace-tsconfig.ts` | `workspaceTsconfig`/`workspaceTsconfigEnv`: tsx paths to unbuilt workspace package `src`              |
| `scripts/cleanup.sh`        | `cleanup.sh --adapter <id> [--target <dir>]`: removes the adapter's overlay directory                 |

`scripts/cleanup.sh` is exported by path (`@farmslot/adapter-node/scripts/cleanup.sh`, also
`NODE_CLEANUP_SCRIPT`). It honours `RECIPE_HARNESS_ROOT` (default `temp/recipe/harness`) and
refuses an absolute value or one with `.`/`..` components.

## Maintenance rules

- No product names. Every line the adapter prints can be replaced through `wording` or `hints`.
- Dependency codes and messages derive from the adapter id (`<ID>_DEPS_MISSING`), so a host keeps
  its codes by keeping its id.
- Recipe actions, readiness checks and install scripts stay in the host.

## Local quality

```sh
yarn workspace @farmslot/adapter-node quality
```
