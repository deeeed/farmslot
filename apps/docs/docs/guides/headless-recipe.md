---
title: Headless Recipe integration
---

# Headless Recipe integration

Use headless recipes when a project can prove behavior through commands, logs,
JSON reports, API calls, tests, or build output without driving a UI.

The same pattern should be used inside Farmslot itself. For example, package-level
services such as `services/gateway` or `packages/cli` are natural headless recipe
candidates because they can prove behavior through commands, API probes, and JSON
reports without launching a UI.

Good first targets:

- backend services;
- API packages;
- CLI tools;
- libraries;
- controller/core packages;
- CI-like validation suites that should produce local review artifacts.

The default package is `@farmslot/recipe-harness`. It executes Recipe Protocol v1
graphs, validates actions against a manifest, and writes the standard evidence
package:

- `recipe.json`;
- `summary.json`;
- `trace.json`;
- `artifact-manifest.json`.

## Install

```bash
yarn add -D @farmslot/recipe-harness @farmslot/protocol
```

The package manager resolves the current published versions. Do not use the Yarn workspace protocol outside the Farmslot monorepo; it only works for local workspace packages.

## In-repo example path

Farmslot should document integrations by using its own projects first:

- `apps/companion` is the Expo/React Native example for `@farmslot/expo-recipe`.
- `services/gateway` or `packages/cli` can become the headless examples for `@farmslot/recipe-harness`.
- A future Command Center web recipe can demonstrate browser/CDP proof without changing the headless contract.

When those packages add recipes, they should use the same versionless files shown
below so this guide stays backed by real repository examples instead of synthetic
samples.

## Project files

Use versionless project paths. The protocol version belongs in recipe metadata,
not in folder names.

```text
scripts/agentic/recipe/action-manifest.json
scripts/agentic/recipe/recipes/smoke.recipe.json
scripts/agentic/validate-recipe.sh
```

## Minimal action manifest

Start with the smallest action surface that can run immediately:

```json
{
  "runner_protocol_version": 1,
  "action_registry_version": 1,
  "supported_official_actions": [
    "command",
    "assert_output",
    "assert_json",
    "assert_file",
    "wait",
    "end"
  ],
  "custom_actions": []
}
```

Do not declare UI, CDP, or app bridge actions unless the project has a live
transport that can execute them.

## Minimal recipe

This example runs a project-owned command, asserts output, and emits the
standard artifact package.

```json
{
  "schema_version": 1,
  "title": "Package smoke validation",
  "description": "Verifies the package can run its smoke check and report success.",
  "proofTargets": [
    {
      "id": "package-smoke",
      "claim": "The package smoke check completes successfully."
    }
  ],
  "validate": {
    "workflow": {
      "entry": "run-smoke",
      "nodes": {
        "run-smoke": {
          "action": "command",
          "description": "Run the package smoke check.",
          "cmd": "yarn test:smoke --json",
          "timeout_ms": 120000,
          "next": "assert-smoke",
          "proofTarget": "package-smoke"
        },
        "assert-smoke": {
          "action": "assert_output",
          "description": "Confirm the smoke check reports success.",
          "source": "run-smoke",
          "stream": "stdout",
          "contains": "\"status\":\"pass\"",
          "next": "done",
          "proofTarget": "package-smoke"
        },
        "done": {
          "action": "end",
          "status": "pass"
        }
      }
    }
  }
}
```

## Runner choices

### CLI-only runner

For pure command/assertion recipes, use the package CLI:

```bash
farmslot-recipe validate scripts/agentic/recipe/recipes/smoke.recipe.json \
  --action-manifest scripts/agentic/recipe/action-manifest.json

farmslot-recipe run scripts/agentic/recipe/recipes/smoke.recipe.json \
  --action-manifest scripts/agentic/recipe/action-manifest.json \
  --artifacts-dir artifacts/recipe-run
```

### Custom project runner

Create a project runner only when the project needs domain actions or richer
adapter wiring.

```ts
import { getRecipeActionManifestActionNames } from '@farmslot/protocol';
import { createRecipeRunner, createStandardCoreAdapters } from '@farmslot/recipe-harness';

const actions = getRecipeActionManifestActionNames(actionManifest);
const runner = createRecipeRunner({
  actionManifest,
  adapters: [
    ...createStandardCoreAdapters({ actions }),
    // Add project-owned adapters here.
  ],
});
```

Use this for durable domain actions such as:

- `api.seed_user`;
- `backend.start_service`;
- `package.assert_exports`;
- `perps.fetch_market_data`.

Avoid actions that encode one ticket, one temporary debug assertion, or one
screen-specific failure. Prefer one parameterized action over many narrow
duplicates.

## Farmslot hook

Expose the runner through a thin project hook:

```json
{
  "hooks": {
    "recipe_run": "bash scripts/agentic/validate-recipe.sh --recipe {{recipe_path}} --artifacts-dir {{artifacts_dir}}"
  }
}
```

The wrapper should preserve Farmslot arguments and delegate to the project
runner. It should not contain hidden validation logic that bypasses the recipe.

## When a repo cannot depend on Farmslot

Some external repositories may need a self-contained example because their ADR,
security posture, or dependency policy cannot import `@farmslot/*`. That is a
project constraint, not the default path.

When self-containing a runner, keep the same contract:

- versionless project paths;
- Recipe Protocol v1 metadata;
- explicit action manifest;
- standard artifact package;
- no task-specific action growth.

## Quality rules

- Keep the manifest small and executable.
- Use project-native commands for setup, diagnostics, and non-visual proof.
- Add custom adapters only for reusable project capabilities.
- Put detailed diagnostics in `trace.json`, not in action names.
- Make artifacts understandable outside the original machine.
- Fail loudly when an action is declared but unsupported.
