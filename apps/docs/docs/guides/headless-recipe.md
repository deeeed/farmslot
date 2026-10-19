---
title: Headless Recipe integration
---

# Headless Recipe integration

Use a headless recipe when commands, API responses, logs, or files can prove the behavior without a UI.

## Install

```sh
yarn add -D @farmslot/recipe-runner @farmslot/protocol
```

The verification commands below come from the `farmslot` CLI.

Keep the project surface small:

```text
scripts/agentic/recipe/action-manifest.json
scripts/agentic/recipe/recipes/smoke.recipe.json
scripts/agentic/validate-recipe.sh
```

## Integrate

1. Declare only the official actions the project can execute.
2. Register the matching standard core adapters.
3. Add namespaced project adapters only for durable project capabilities.
4. Add one real smoke recipe.
5. Expose a runner hook that accepts the recipe and artifact directory.

Minimal runner construction:

```ts
import { getRecipeActionManifestActionNames } from '@farmslot/protocol';
import { createRecipeRunner, createStandardCoreAdapters } from '@farmslot/recipe-runner';

const runner = createRecipeRunner({
  actionManifest,
  adapters: createStandardCoreAdapters({
    actions: getRecipeActionManifestActionNames(actionManifest),
  }),
});
```

Use the canonical recipe skeleton in [Write a recipe](./write-a-recipe.md). Exact action schemas come from the active runner manifest, not this guide.

## Verify

```sh
export RECIPE_LIBRARY_PATH="app=$PWD/scripts/agentic/recipe"
farmslot recipe run --list --project-root . --platform core
farmslot recipe run smoke --describe --project-root . --platform core
farmslot recipe run smoke --project-root . --adapter core \
  --action-manifest scripts/agentic/recipe/action-manifest.json \
  --artifacts-dir artifacts/recipe-run
```

A library recipe that runs shell commands stops at its plan first; review it, then rerun with `--approve-plan <digest>` ([Recipe discovery](../reference/recipe-discovery.md)). Once the project is registered with Farmslot, its binding supplies the library, manifest and artifact directory: `farmslot recipe run --list --adapter core` and `farmslot recipe run smoke --adapter core`.

Verify the human outcome plus `recipe-resolution.json`, `summary.json`, `trace.json`, and `artifact-manifest.json`.

Add a project action only when it is atomic, reusable, and materially cheaper than composing existing capabilities. Ticket-specific assertions belong in recipes.

See [Recipe Runner Protocol](../reference/recipe-runner-protocol.md) for trust and artifact guarantees.
