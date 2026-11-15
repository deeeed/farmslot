## Recipe tooling

Reference for the checklist steps that write or run a recipe. Resolve once, then reuse:

```bash
cd {{REPO}}
RUNNER="node {{recipe_runner_resolve_cmd}}"
MANIFEST="{{recipe_manifest_path}}"
WRAPPER="{{recipe_validate_wrapper}}"
```

The step that writes a recipe requires `{{recipe_quality_path}}`: read it as part of that step.
