---
title: Expo / React Native project integration
---

# Expo / React Native project integration

`@farmslot/expo-recipe` is the thin Expo integration over the shared Recipe v1 harness. It scaffolds project-owned files; it does not define another protocol.

## Install

```sh
yarn add -D @farmslot/expo-recipe @farmslot/recipe-harness @farmslot/protocol
farmslot-expo-recipe init
yarn recipe:doctor
yarn recipe:validate
yarn recipe:run
```

For live UI, bridge, and HUD support:

```sh
farmslot-expo-recipe init --with-bridge
```

Wrap the app root with the generated `RecipeBridgeProvider` and enable it only in development with `EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE=1`.

## Ownership

- `@farmslot/protocol` owns recipe validation.
- `@farmslot/recipe-harness` owns graph execution, evidence, and generic actions.
- `@farmslot/expo-recipe` owns Expo scaffolding and integration checks.
- the app owns its bridge configuration, product actions, fixtures, and recipes.

Do not add wallet, product, or ticket-specific behavior to the Expo package. Put durable product capabilities in the app's namespaced action manifest and reusable journeys in its recipe library.

## Author and verify

Start from the generated smoke recipe or another working recipe:

```sh
farmslot-recipe run --list --adapter mobile --json
farmslot-recipe run <closest-recipe> --describe --adapter mobile --json
farmslot-expo-recipe validate ./proof.recipe.json --param key=value
farmslot-expo-recipe run ./proof.recipe.json --param key=value
```

Task-only dependencies beside `artifacts/recipe.json` belong in `artifacts/recipe-library/`; no library flag is required.

Use device UI actions only for visible behavior. Keep deterministic fixture setup before the proof boundary and declare teardown when a run mutates state. Read captured images and runtime evidence; do not infer success from bridge reachability alone.

See [Write a recipe](./write-a-recipe.md) and [Recipe Protocol v1](../reference/recipe-protocol-v1.md).
