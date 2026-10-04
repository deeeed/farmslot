# Farmslot packages

`packages/` contains reusable libraries and command-line tools. Long-running runtime processes live under `services/`; product surfaces live under `apps/`.

| Package          | Owns                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `protocol/`      | Shared Farmslot API, event, run, slot, recipe, manifest, and artifact contracts.           |
| `recipe-runner/` | Generic Recipe Protocol v1 runner, adapters, CLI runner support, and artifact writers.     |
| `recipe-cli/`    | The `farmslot-recipe` command: run, validate, and library-wide recipe/action discovery.    |
| `adapter-sdk/`   | The platform adapter contract: `PlatformAdapter`, `defineAdapter`, the adapter registry.   |
| `adapter-web/`   | Web platform pieces: browser resolve/launch, CDP-port ownership, extension loading, focus. |
| `expo-recipe/`   | Expo/React Native scaffold that wires projects into the generic recipe harness.            |
| `cli/`           | Human/operator CLI for talking to a running Gateway and validating recipe artifacts.       |
| `theme/`         | Shared color, label, lifecycle, flow, and runner presentation tokens for Farmslot clients. |

## Maintenance rules

1. **Packages are reusable.** Keep app/service-specific state and runtime orchestration outside `packages/`.
2. **Protocol is the contract.** Types shared across Gateway, Node, CLI, apps, and recipe tooling belong in `@farmslot/protocol`; implementations do not.
3. **Runner is generic.** Project-specific recipe actions belong in project runners or adapters, not in `recipe-runner`.
4. **Every package has a README.** Each README must include `## Source layout`, `## Maintenance rules`, and `## Local quality` sections that explain ownership, source layout, quality commands, and what does not belong there.
   Every package must also expose `typecheck` and `quality` scripts.
5. **Prefer owner imports.** Import from the package/module that owns the symbol instead of creating convenience re-export piles.
6. **Run package quality before committing package changes:**

```bash
yarn workspace @farmslot/protocol quality
yarn workspace @farmslot/recipe-runner quality
yarn workspace @farmslot/recipe-cli quality
yarn workspace @farmslot/adapter-sdk quality
yarn workspace @farmslot/adapter-web quality
yarn workspace @farmslot/expo-recipe quality
yarn workspace @farmslot/cli quality
yarn workspace @farmslot/theme quality
```

## Package boundary guide

- Put shared schemas, RPC method names, event names, and cross-process data shapes in `protocol/`.
- Put recipe execution mechanics and generic adapters in `recipe-runner/`.
- Put the `farmslot-recipe` command and recipe/action discovery in `recipe-cli/`.
- Put the platform adapter contract in `adapter-sdk/`.
- Put browser process and CDP mechanics for web platforms in `adapter-web/`.
- Put Expo project scaffolding and checks in `expo-recipe/`.
- Put Gateway operator commands in `cli/`.
- Put UI-neutral visual tokens in `theme/`.
- Put daemon/service behavior in `services/*`, not here.
