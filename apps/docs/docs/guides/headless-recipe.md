---
title: Headless Recipe integration
---

# Headless Recipe integration

Use a headless recipe when commands, API responses, logs, or files can prove the behavior without a UI.

## Install

```sh
yarn add -D @farmslot/recipe-harness @farmslot/protocol
```

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
import { createRecipeRunner, createStandardCoreAdapters } from '@farmslot/recipe-harness';

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
farmslot-recipe run --list --adapter core
farmslot-recipe run smoke --describe --adapter core
farmslot-recipe run smoke --adapter core --artifacts-dir artifacts/recipe-run
```

Verify the human outcome plus `recipe-resolution.json`, `summary.json`, `trace.json`, and `artifact-manifest.json`.

Add a project action only when it is atomic, reusable, and materially cheaper than composing existing capabilities. Ticket-specific assertions belong in recipes.

See [Recipe Runner Protocol](../reference/recipe-runner-protocol.md) for trust and artifact guarantees.
