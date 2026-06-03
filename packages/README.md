# Farmslot packages

`packages/` contains reusable libraries and command-line tools. Long-running runtime processes live under `services/`; product surfaces live under `apps/`.

| Package           | Owns                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `protocol/`       | Shared Farmslot API, event, run, slot, recipe, manifest, and artifact contracts.           |
| `recipe-harness/` | Generic Recipe Protocol v1 runner, adapters, CLI runner support, and artifact writers.     |
| `expo-recipe/`    | Expo/React Native scaffold that wires projects into the generic recipe harness.            |
| `cli/`            | Human/operator CLI for talking to a running Gateway and validating recipe artifacts.       |
| `theme/`          | Shared color, label, lifecycle, flow, and runner presentation tokens for Farmslot clients. |

## Maintenance rules

1. **Packages are reusable.** Keep app/service-specific state and runtime orchestration outside `packages/`.
2. **Protocol is the contract.** Types shared across Gateway, Node, CLI, apps, and recipe tooling belong in `@farmslot/protocol`; implementations do not.
3. **Harness is generic.** Project-specific recipe actions belong in project runners or adapters, not in `recipe-harness`.
4. **Every package has a README.** Each README must include `## Source layout`, `## Maintenance rules`, and `## Local quality` sections that explain ownership, source layout, quality commands, and what does not belong there.
   Every package must also expose `typecheck` and `quality` scripts.
5. **Prefer owner imports.** Import from the package/module that owns the symbol instead of creating convenience re-export piles.
6. **Run package quality before committing package changes:**

```bash
yarn workspace @farmslot/protocol quality
yarn workspace @farmslot/recipe-harness quality
yarn workspace @farmslot/expo-recipe quality
yarn workspace @farmslot/cli quality
yarn workspace @farmslot/theme quality
```

## Package boundary guide

- Put shared schemas, RPC method names, event names, and cross-process data shapes in `protocol/`.
- Put recipe execution mechanics and generic adapters in `recipe-harness/`.
- Put Expo project scaffolding and checks in `expo-recipe/`.
- Put Gateway operator commands in `cli/`.
- Put UI-neutral visual tokens in `theme/`.
- Put daemon/service behavior in `services/*`, not here.
