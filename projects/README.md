# Projects

Each subdirectory is a separate git repo containing project-specific config for farmslot.

## Structure

```
projects/
  <name>-farm/
    project.json      # Hooks, health checks, fixture mappings, platforms
    fixtures/         # Env templates, config files, test data
    templates/        # Worker + orchestrator task templates
      worker/
      orchestrator/
```

## Setup

Clone your project config into this directory:

```bash
cd projects/
git clone git@github.com:you/my-project-farm.git
```

Or create a new one from an existing farm or a minimal `project.json`:

```bash
mkdir my-project-farm && cd my-project-farm
git init
cat > project.json <<'JSON'
{
  "name": "my-project-farm",
  "hooks": {
    "recipe_run": "bash scripts/agentic/validate-recipe.sh --recipe {{recipe_path}} --artifacts-dir {{artifacts_dir}}"
  }
}
JSON
# Add fixtures, templates, setup scripts, and project-specific hooks as needed.
```

## Convention

- Directory name must match `project.json` `"name"` field
- Directory name must match `"project"` field in pool JSONs
- Use `-farm` suffix to distinguish from the actual project repo

## Recipe Support

Adopt only the layer you need:

1. Skills only: install `@farmslot/skills` for recipe authoring/review guidance.
2. Project harness: install a project-specific runner or adapter such as `mm-harness` to execute recipes locally.
3. Agent runtime: add `@farmslot/agent-runtime` when tasks need `./mark`, `SIGNAL.json`, checklist timing, or closeout artifact checks without full Farmslot.
4. Full Farmslot: add `project.json` hooks, pools, slots, Command Center, and gateway orchestration.

Recipe support is the preferred validation loop for projects that need
reviewable proof artifacts. Farmslot v1 standardizes a shared `validate.workflow`
graph envelope plus a typed artifact package, while each project keeps its own
runner and action adapters.

A minimal new v1 recipe-enabled project should provide:

1. A `hooks.recipe_run` command in `project.json`.
2. A runner command that accepts `{{recipe_path}}` and `{{artifacts_dir}}`.
3. A recipe graph with `schema_version`, `validate.workflow.entry`, and
   `validate.workflow.nodes`. Top-level `title`/`description` are optional
   metadata only.
4. `intent` on every non-terminal executable node: one short HUD/trace line
   for what the agent is doing now.
5. Project-owned action handling for native tools such as CDP, Playwright,
   Maestro, pytest, shell commands, XCTest, or custom adapters.
6. Output artifacts under `{{artifacts_dir}}`:
   - `summary.json`
   - `trace.json`
   - `artifact-manifest.json`
   - the resolved `recipe.json` or `workflow.json` when practical
7. Slow/live playback support for UI-class projects when feasible. Set
   `recipe_run_supports_playback_slow: true` only when the runner can honor the
   appended slow-playback option.

Example hook:

```json
{
  "hooks": {
    "recipe_run": "bash scripts/agentic/validate-recipe.sh --recipe {{recipe_path}} --artifacts-dir {{artifacts_dir}}"
  },
  "recipe_run_supports_playback_slow": false
}
```

Keep stricter action validation inside the project runner. Farmslot core should
validate the shared graph/artifact contract, not project-specific semantics.
Command Center can append an artifacts directory for legacy hooks that omit it,
but new v1 project configs should include `{{artifacts_dir}}` explicitly.

Validate the generic contract with the Farmslot CLI:

```bash
cd apps/command-center
yarn farmslot recipe validate ../../docs/examples/recipes/backend-command-v1.recipe.json
yarn farmslot recipe validate path/to/recipe.json --artifact-dir path/to/artifacts
```

Reference implementations:

| Project farm                  | Recipe surface                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `farmslot-farm` (first-party) | Command Center + Companion monorepo — `projects/farmslot-farm/project.json`, `pool/farmslot-demo.json` |
| Browser app farm              | CDP or Playwright runner with a `validate-recipe` wrapper                                              |
| Native app farm               | Maestro/XCTest/Detox runner with mobile action docs                                                    |
| Backend/service farm          | Shell, pytest, or API-test runner with JSON artifact output                                            |

See [Recipe Runner Protocol](../docs/reference/recipe-runner-protocol.md),
[new project recipe support](../docs/reference/new-project-recipe-support.md), and
[recipe examples](../docs/examples/recipes/) for the graph envelope, artifact
package, and onboarding examples.

## Slot Actions

Project farms can expose configured shortcut buttons in Command Center without
allowing arbitrary command entry. Top-level `slot_actions` render in the Slot
View header by default. `resources.<id>.actions` render beside that resource in
the stream/resource panel by default.

Actions support `mode: "run"` (default) or `mode: "copy"`. Copy actions expand
the same templates as run actions, then copy the resolved command so it can be
pasted into the terminal.

```json
{
  "slot_actions": {
    "copy-refresh": {
      "label": "Copy refresh",
      "mode": "copy",
      "command": "bash temp/runtime/safe-refresh.sh",
      "refresh": ["none"]
    }
  },
  "resources": {
    "browser": {
      "actions": {
        "fullscreen": {
          "label": "Full",
          "command": "bash {{farmslot_dir}}/projects/my-browser-farm/setup/launch-browser.sh {{slot_id}} --cdp-port {{cdp_port}}",
          "refresh": ["resources"]
        }
      }
    }
  }
}
```
