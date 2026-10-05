---
title: Node Adapter
---

# Node Adapter

`@farmslot/adapter-node` is a headless platform adapter for recipe harnesses, built on the [Adapter SDK](./adapter-sdk.md). A headless platform runs no app, ports, dev server, logs or launch. Installed dependencies are its only runtime signal, and its lifecycle commands teach the headless path. The host supplies the adapter id, detection, hints and wording, its action set and its overlay leaves.

```ts
import { createNodeAdapter } from '@farmslot/adapter-node';

const core = createNodeAdapter({
  id: 'core',
  detect: { files: (target) => hasControllerPackage(target) },
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

// Host members are spread on top.
registry.register({ ...core, readiness });
```

## Config

| field               | default                                                      | owns                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                | required                                                     | registry key, `--adapter` value, dependency codes (`<ID>_DEPS_MISSING`) and labels                                                                                   |
| `hints`             | required                                                     | the platform's next steps                                                                                                                                            |
| `actions`           | required                                                     | the action set                                                                                                                                                       |
| `harness`           | required                                                     | `install`, `verify` and `cleanup` leaves                                                                                                                             |
| `detect`            | none                                                         | recognise the checkout                                                                                                                                               |
| `wording`           | lines naming the id; refusals point at `hints.relaunch`      | `ready`, `notReady`, `devServerStop`, `launch`                                                                                                                       |
| `dependencies`      | every run checks the install (node_modules or PnP)           | `runtimeDeps`, `bins` with `resolveBin(target, bin)` (pass the resolver execution uses), `requiredFor(target, use)`; `runtimeStatus` (doctor) applies the same check |
| `workspacePackages` | none                                                         | package name → checkout-relative dir; wires `actions.tsxLiveScripts` when the host didn't                                                                            |
| `installCommand`    | `cd '<target>' && yarn install --immutable`                  | the next step for missing dependencies                                                                                                                               |
| `runtimeContext`    | `HEADLESS_FORBIDDEN_FIELDS` (ports, simulator, extension id) | what `agentic-runtime.json` must not carry                                                                                                                           |
| `run`               | `dependencyBlock` runs the dependency check                  | host run members; a host `dependencyBlock` replaces the check                                                                                                        |

## Helpers

- `nodeDependencyBlock(target, options)`: under Yarn PnP, `.pnp.cjs` must exist. Otherwise `node_modules`, each bin and each runtime dependency must resolve from the checkout. Returns `{ code, message, userAction }` or null.
- `pnpNodeOptions(target, current)`: appends `--require <target>/.pnp.cjs` for a PnP checkout.
- `workspaceTsconfig(root, packages)` / `workspaceTsconfigEnv(root, tempDir, { packages, fileName })`: tsconfig paths from each unbuilt package (no `dist/index.cjs`) to its `src`, written to a temp file and returned as `TSX_TSCONFIG_PATH` (plus the PnP `NODE_OPTIONS`).
- `scripts/cleanup.sh --adapter <id> [--target <dir>]` (`NODE_CLEANUP_SCRIPT`): removes `<target>/<RECIPE_HARNESS_ROOT>/<id>`, default root `temp/recipe/harness`. It is idempotent and never touches product files. It refuses an absolute `RECIPE_HARNESS_ROOT` or one with `.`/`..` components.
