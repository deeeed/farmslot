# Add recipe support to a project

Use the smallest integration that can prove one real project behavior.

## 1. Define the runner boundary

Provide a command that accepts:

- recipe path or library id;
- project root;
- artifact directory;
- adapter/platform selection when it cannot be inferred;
- recipe parameters.

The command must support plan-only validation before side effects.

## 2. Declare actions

Create a strict action manifest. Start with generic actions already implemented by the harness. Add a namespaced project action only when an existing action or reusable recipe cannot express the capability efficiently.

Each declaration needs a concise description, strict schema, capabilities, finite result cases when applicable, and a runnable example.

## 3. Implement adapters

Implement exactly the declared actions. Return output, observations, artifacts, and an optional result case. Do not return graph destinations or final recipe status.

Reuse the project's real runtime interfaces: process commands for headless projects, CDP for browser clients, and the selected device bridge for native clients.

## 4. Add one smoke recipe

```json
{
  "$schema": "https://farmslot.io/schemas/recipe-v1.schema.json",
  "description": "Prove the project runtime is reachable.",
  "workflow": {
    "entry": "status",
    "nodes": {
      "status": {
        "action": "app.status",
        "intent": "Confirm the selected runtime is ready.",
        "next": "done"
      },
      "done": { "action": "end", "status": "pass" }
    }
  }
}
```

Use a parameterized recipe instead of adding near-duplicates. Add teardown only when the recipe mutates state.

## 5. Verify the contract

Validate:

1. manifest syntax and every example;
2. recipe schema and graph semantics;
3. plan-only resolution of the complete dependency DAG;
4. one real run against the selected runtime;
5. trace, resolution provenance, and artifact package;
6. the human-visible outcome, not only command exit status.

## 6. Publish discovery

Ensure an agent can reach working code with four commands:

```sh
mm-harness run --list --json
mm-harness run <closest-recipe> --describe --json
mm-harness actions <task-term> --json
mm-harness actions --action <exact-name> --json
```

Broad output must remain compact. Put full schemas and examples only in exact detail.

For field definitions and runtime guarantees, use [Recipe Protocol v1](recipe-protocol-v1.md) and [Recipe Runner Protocol](recipe-runner-protocol.md).
