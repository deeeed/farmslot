---
title: Write a recipe
---

# Write a recipe

Start from working code instead of recalling the schema.

```sh
farmslot recipe run --list --adapter <adapter> --json
farmslot recipe run <closest-recipe> --describe --adapter <adapter> --json
```

Call the closest recipe when its graph already fits. Copy it only when the workflow itself must change, then edit only the nodes required by the claim. Use the project's runner to search its strict action manifest and inspect exact action schemas; action discovery is project-owned.

## Minimal recipe

```json
{
  "$schema": "https://farmslot.io/schemas/recipe-v1.schema.json",
  "description": "Prove the selected runtime is ready.",
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

Required root fields are `$schema` and `workflow`. Use optional `description` for human context, `paramsSchema` for reusable inputs, `call` for composition, `proofTargets` for explicit claims, and `workflow.teardown` only when cleanup must be guaranteed.

Every non-terminal node needs a short human-facing `intent`. UI intent describes the visible outcome; selectors, routes, keys, and action names remain in parameters.

Action parameters are sibling fields beside `action`, `intent`, and the transition. Only a `call` node uses `params` to pass values into another recipe.

## Non-UI criteria

Run the project's real test command, then assert its recorded exit code. Put
`proves` on the assertion:

```json
{
  "$schema": "https://farmslot.io/schemas/recipe-v1.schema.json",
  "proofTargets": [{ "id": "AC-1", "claim": "The project tests pass." }],
  "workflow": {
    "entry": "tests",
    "nodes": {
      "tests": {
        "action": "command",
        "cmd": "npm test",
        "allow_failure": true,
        "intent": "Run the project tests.",
        "next": "check"
      },
      "check": {
        "action": "assert_output",
        "source": "tests",
        "assert": { "path": "$.exitCode", "operator": "eq", "value": 0 },
        "intent": "Confirm the tests passed.",
        "proves": ["AC-1"],
        "next": "done"
      },
      "done": { "action": "end", "status": "pass" }
    }
  }
}
```

`allow_failure` retains non-zero results so the assertion can disprove the claim.
Choose the actual project command; printing a success marker is not a test of the
application.

For a log criterion, read the application's log with `command` and follow it with
`assert_output` using `source` and `contains`. Check the actual expected line,
not the command's exit code alone. Navigation and screenshots cannot replace an
assertion of non-UI state.

File-content claim proof through `assert_file` with `contains` is defined in
[Amendment 5](../reference/recipe-protocol-v1.md#amendment-5-file-content-proof-assertions).
Until supporting packages ship, use the executed log-read and output-assertion
pattern. A file's existence alone does not prove its contents.

## Validate

```sh
farmslot recipe validate ./proof.recipe.json --action-manifest <manifest.json>
farmslot recipe run ./proof.recipe.json --adapter <adapter>
```

Read the trace and actual evidence. A passing command is not sufficient when the claim is visual or runtime-specific.

See [Recipe Protocol v1](../reference/recipe-protocol-v1.md) for the complete contract.
