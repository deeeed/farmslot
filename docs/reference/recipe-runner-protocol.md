# Recipe Runner Protocol

> This document is runner-focused guidance for Recipe Protocol v1. The canonical field-level source of truth is [Recipe Protocol v1](recipe-protocol-v1.md).

Command Center treats project recipe runners as pluggable commands, but v1
standardizes the recipe **orchestration envelope** and the **artifact package**
that every runner emits. A project still owns how actions execute: an action can
be a Farmslot portable action, a Example Browser App CDP action, a Example Mobile App
agentic action, a shell command, a pytest run, a Playwright flow, a Maestro flow,
or any other project-owned adapter.

The goal is one review loop: Farmslot can visualize the same recipe graph,
follow the same trace, and render the same artifact package across browser,
mobile, web, backend, macOS/native, and Farmslot's own self-validation recipes.

## Contract layers

| Layer            | Required for Farmslot recipes                                                                                           | Owned by                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Graph envelope   | `schema_version`, `validate.workflow.entry`, `validate.workflow.nodes`, and node `intent` for every non-terminal step   | Farmslot protocol                     |
| Runner hook      | `hooks.recipe_run` receives `{{recipe_path}}` and `{{artifacts_dir}}`                                                   | Project config                        |
| Action semantics | Official actions (`command`, `ui.press`, `ui.wait_for`) plus runner-declared custom actions                             | Protocol registry + adapter validator |
| Artifact package | `summary.json`, `trace.json`, `artifact-manifest.json`, resolved `recipe.json` when practical, optional `workflow.json` | Runner + Farmslot protocol            |
| UI replay        | Required for UI-class projects when feasible; not required for backend/batch jobs                                       | Project adapter + Command Center      |

The protocol standardizes orchestration and evidence. It does **not** force every
project to rewrite its native tests as primitive Farmslot UI actions.

## Recipe graph envelope

The canonical graph envelope, composition fields, phases, proof-target mapping, trace shape, artifact manifest, and validation rules are defined in [Recipe Protocol v1](recipe-protocol-v1.md).

This runner-focused document does not restate those schemas. Its job is to explain how project runners expose the protocol through project hooks, action manifests, doctor/verify surfaces, and project-specific adapters.

## Project hook

`projects/<project>/project.json` exposes the recipe runner command:

```json
{
  "hooks": {
    "recipe_run": "node temp/recipes/validate-recipe.js --recipe {{recipe_path}} --cdp-port {{cdp_port}} --artifacts-dir {{artifacts_dir}}"
  }
}
```

Command Center replaces:

- `{{recipe_path}}` — selected recipe or bundled flow path on the slot.
- `{{artifacts_dir}}` — dedicated output directory for this execution.
- Normal slot variables such as `{{repo}}`, `{{cdp_port}}`, `{{port}}`,
  `{{runtime_dir}}`, `{{slot_id}}`, and `{{artifact_dir}}`.

V1 hooks MUST include `{{recipe_path}}` and `{{artifacts_dir}}` explicitly so
runner I/O is visible in project config.

### Runner readiness / doctor hook

`/recipe-doctor` is the setup/readiness side of the same contract. Projects may
expose a `hooks.recipe_doctor` command that prints a JSON readiness report:

```json
{
  "hooks": {
    "recipe_doctor": "node scripts/agentic/recipe-doctor.js --json"
  }
}
```

Minimum readiness report shape:

```json
{
  "runner_protocol_version": 1,
  "status": "pass",
  "checks": [
    {
      "id": "runtime.ready",
      "status": "pass",
      "category": "runtime",
      "message": "App control bridge is reachable."
    }
  ]
}
```

Recommended check categories:

- `tools` — required local tools and versions;
- `skills` — installed recipe skills and templates;
- `harness` — overlay/bridge files and static verification;
- `runtime` — app/browser/simulator/CDP readiness;
- `fixtures` — wallet/profile/seed fixture readiness;
- `isolation` — browser profile, temp directory, or device isolation;
- `secrets` — redacted secret-reference availability.

Readiness checks should use the same `failure_kind` vocabulary as recipe runs:
`setup`, `environment`, `fixture`, `product`, `assertion`, or `unknown`.
This lets agents distinguish "the app failed the proof" from "the harness is
not ready to run the proof."

### Runner action manifest discovery

The harness validates action names before execution by loading the runner action
manifest from project config or runner options.

The manifest is a concrete protocol document, not only prose. The shared protocol
package exposes it as `RecipeActionManifestDocument`, and the validator
contract should accept it explicitly:

```ts
validateRecipeDocument(recipe, {
  actionManifest,
  officialActions: OFFICIAL_RECIPE_ACTIONS,
});
```

At the CLI/project-hook boundary this should surface as:

```bash
yarn farmslot recipe validate recipe.json --action-manifest project-manifest.json
```

The validator responsibilities are:

1. validate the recipe envelope and graph;
2. validate the manifest envelope;
3. validate every `node.action` against
   `supported_official_actions ∪ custom_actions[].name`;
4. validate official/custom action metadata shape enough for agent discovery;
5. leave action-specific field validation to runner adapters unless an official
   JSON Schema is present.

Preferred static form:

```json
{
  "recipe_action_manifest": {
    "runner_protocol_version": 1,
    "action_registry_version": 1,
    "supported_official_actions": ["command", "assert_json", "index_artifacts", "end"],
    "action_metadata": {},
    "custom_actions": []
  }
}
```

For runners whose supported actions depend on installed tools or runtime flags, project config may expose a manifest hook that prints the same JSON to stdout:

```json
{
  "hooks": {
    "recipe_action_manifest": "node scripts/agentic/print-action-manifest.js"
  }
}
```

Validation rule: if an action is not listed in `supported_official_actions` and is not declared in `custom_actions[].name`, it is invalid for that runner.

### `RecipeActionManifestDocument`

Conceptual TypeScript shape:

```ts
interface RecipeActionManifestDocument {
  runner_protocol_version: 1;
  action_registry_version: 1;
  supported_official_actions: OfficialActionName[];
  action_metadata?: Partial<Record<OfficialActionName, ActionCatalogEntry>>;
  custom_actions?: CustomActionDeclaration[];
  custom_assertion_operators?: CustomAssertionOperatorDeclaration[];
  state_refs?: StateRefDeclaration[];
  pre_conditions?: PreconditionDeclaration[];
  native_bindings?: NativeBindingDeclaration[];
}

interface ActionCatalogExample {
  description?: string;
  node: Record<string, unknown>;
}

interface ActionCatalogEntry {
  description?: string;
  schema?: Record<string, unknown>;
  examples?: ActionCatalogExample[];
  when_to_use?: string;
  avoid_when?: string;
  proof_effect?: string;
  safety_notes?: string;
}

interface CustomActionDeclaration extends ActionCatalogEntry {
  name: string;
  owner: string;
  description: string;
  schema: Record<string, unknown>;
  examples: ActionCatalogExample[];
}

interface StateRefDeclaration {
  ref: string;
  description: string;
  schema?: Record<string, unknown>;
  examples?: Array<{ description?: string; value: unknown }>;
}

interface PreconditionDeclaration {
  id: string;
  description: string;
  params_schema?: Record<string, unknown>;
  failure_kind?: 'setup' | 'environment' | 'fixture' | 'product' | 'assertion' | 'unknown';
}

interface CustomAssertionOperatorDeclaration {
  name: string;
  owner: string;
  description: string;
  schema?: Record<string, unknown>;
  examples?: Array<{ description?: string; assert: Record<string, unknown> }>;
}

interface NativeBindingDeclaration {
  action: OfficialActionName | string;
  implementation: string;
  description?: string;
}
```

`state_refs` is the safe replacement for raw eval discovery. If a recipe uses
`state_read`, the `ref` should be listed in the manifest unless it is a generic
runner-provided ref. Arbitrary eval escape hatches must be declared as custom
debug actions, for example `example.debug.eval`, with safety notes and a clear
"not primary proof" warning.

### Action manifest as agent-facing catalog

The action manifest is not only validator input. It is also the agent-facing action catalog used by `/recipe-cook` and future recipe-generation agents. In practice, it becomes the project runner's discoverable agentic toolkit: instead of relying on hidden prompt knowledge or source-code reading, the agent receives the allowed actions, schemas, examples, and runner-specific bindings directly from the manifest.

Runners SHOULD expose this catalog through a CLI or project hook, for example:

```bash
recipe-runner manifest --json
recipe-runner actions --json
recipe-runner actions --action ui.press --json
```

The exact command name is project-owned; the required property is that the
selected runner can reveal the same manifest/schema information it will validate
at run time.

A recipe authoring agent should be able to read the manifest and answer:

1. Which official Farmslot actions does this runner support?
2. Which project/domain custom actions does this runner add?
3. What does each custom action do?
4. Which fields are required?
5. What does a valid node look like?
6. When should the action be preferred over portable primitives?

For official actions, the agent catalog inherits the canonical descriptions from
the Farmslot protocol registry in this document. Runners SHOULD add
`action_metadata` entries when an official action has runner-specific field
bindings, route names, selectors, supported condition shapes, or examples.
That means official actions can still be richly discoverable: `ui.navigate`
stays portable, while the manifest can teach the agent that this runner accepts
targets such as `PerpsMarkets` or `Settings`.

Custom action declarations MUST include `name`, `owner`, `description`,
`schema`, and `examples`. The same catalog metadata can be supplied for
official actions through `action_metadata`:

| Field         | Applies to | Purpose                                                           |
| ------------- | ---------- | ----------------------------------------------------------------- |
| `name`        | custom     | Canonical action name used in `node.action`.                      |
| `owner`       | custom     | Project/domain owner, such as `example-app`.                      |
| `description` | both       | Agent-readable explanation of what the action proves or performs. |
| `schema`      | both       | JSON Schema for action-specific node fields.                      |
| `examples`    | both       | One or more valid recipe nodes using the action.                  |
| `when_to_use` | both       | Short guidance for when an authoring agent should pick it.        |
| `avoid_when`  | both       | Short guidance for when to use a more portable primitive instead. |

Recommended official action metadata shape:

```json
{
  "ui.navigate": {
    "description": "Navigate by app route name through the injected app control bridge.",
    "schema": {
      "type": "object",
      "properties": {
        "target": { "type": "string" },
        "routeParams": { "type": "object" },
        "next": { "type": "string" }
      },
      "required": ["target"],
      "additionalProperties": false
    },
    "examples": [
      {
        "description": "Open the Perps markets screen by route name.",
        "node": {
          "action": "ui.navigate",
          "target": "PerpsMarkets",
          "next": "wait-for-markets"
        }
      }
    ],
    "when_to_use": "Use for route/page navigation that can be expressed without product-domain semantics."
  }
}
```

Recommended custom action shape:

```json
{
  "name": "example.wallet.unlock",
  "owner": "example",
  "description": "Unlock a debug Example App wallet through the real unlock path.",
  "when_to_use": "Use when a recipe requires an unlocked Example App wallet before visible UI or state proof.",
  "schema": {
    "type": "object",
    "properties": {
      "account": { "type": "string" },
      "next": { "type": "string" }
    },
    "additionalProperties": false
  },
  "examples": [
    {
      "description": "Unlock the primary debug wallet before opening Perps.",
      "node": {
        "action": "example.wallet.unlock",
        "account": "primary",
        "next": "open-perps"
      }
    }
  ]
}
```

Agent rule: recipe-generation agents should load the manifest before drafting a recipe, build the allowed action set from `supported_official_actions ∪ custom_actions[].name`, prefer official portable actions first, then use custom actions when the manifest description says the concept is product/domain-specific or when the example matches the proof target.

Runner requirements:

1. Accept a recipe path or descriptor.
2. Accept an artifacts directory.
3. Execute the `validate.workflow` graph using project/adapter semantics.
4. Return a meaningful process exit status.
5. Write the artifact package described below.
6. Copy or resolve the executed `recipe.json` into artifacts when practical;
   emit `workflow.json` too when a normalized workflow view is useful.

When a project sets `recipe_run_supports_playback_slow: true`, the UI may append
runner options such as `--slow <ms>` for human-readable live playback. Projects
that do not opt in keep replay commands free of playback flags. The gateway
accepts slow-down values from `100` through `60_000` milliseconds.

## Action registry and artifact package

The canonical action vocabulary, assertion operators, phase/record values, artifact-manifest schema, and validation rules live in [Recipe Protocol v1](recipe-protocol-v1.md).

Runner-specific responsibilities in this document are limited to:

- declaring supported official actions and custom project actions through `RecipeActionManifestDocument`;
- exposing action metadata/examples for agent discoverability;
- implementing action adapters and native bindings;
- writing the protocol-required `summary.json`, `trace.json`, `artifact-manifest.json`, and resolved recipe artifacts;
- surfacing doctor/verify information for installed runners;
- preserving project-native action semantics behind the shared protocol.

If this document conflicts with `reference/recipe-protocol-v1.md`, the canonical spec wins.

### Artifact package writing

A runner must write the files required by Recipe Protocol v1. The artifact manifest schema is not restated here; use `reference/recipe-protocol-v1.md` and the `RecipeArtifactManifestDocument` type from `@farmslot/protocol`.

### Automatic issue capture and gating

Project runners may capture unexpected logs, screenshots, failed assertions, and product/runtime failures as artifacts. Gating policy such as `fail_on_unexpected` is project-owned, but summary/trace must make the policy and result explicit so reviewers know whether an issue was blocking, diagnostic, or ignored.

## Visual vs background work

Runners should do setup, controller probes, API assertions, log collection, and
state snapshots in the background. Only meaningful UI interactions and proof
states should be slowed down or displayed in a live HUD. This keeps live review
readable while preserving complete machine-readable evidence in artifacts.

UI-class projects should support live replay/slow playback when feasible:

- browser extension UI
- mobile UI
- web UI
- macOS/native UI where visual review matters

Use about `2000ms` as the default human-readable delay for live visualization.
Backend, API, CLI, or batch recipes are not required to provide visual replay,
but they still emit `summary.json`, `trace.json`, `artifact-manifest.json`, and
relevant reports/logs.

## Reference implementations

Use the project runners below as source references for v1 adapter design:

| Project             | Reference surface                                                                                                                               | Notes                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Example Browser App | `projects/example-browser-farm/fixtures/agentic/recipes/validate-flow-schema.js`, `validate-recipe.js`, `validate-recipe.sh`, `lib/workflow.js` | Mature graph validator/runner with CDP/UI replay actions.                                                                             |
| Example Mobile App  | `projects/example-mobile-farm/templates/worker/*` references to app-local `scripts/perps/agentic/validate-recipe.sh`                            | Mobile runner contract and flow/action guidance live in the mobile project.                                                           |
| Audiolab            | `projects/audiolab-farm/templates/worker/*` references to `scripts/agentic/validate-flow-schema.sh` and `validate-recipe.sh`                    | Non-Example App reference for project-native validation.                                                                              |
| Core monorepo       | `projects/example-core-farm/fixtures/agentic/recipes/validate-recipe.js`                                                                        | Headless/CLI reference: `command` + `assert_output` + `type: "log"` artifacts. No browser, no simulator.                              |
| Farmslot itself     | `docs/examples/recipes/farmslot/` self-validation recipes and artifact packages                                                                 | Dogfoods this same protocol for Command Center, Gateway, Mobile Companion, artifact viewer, recipe replay, and onboarding validation. |

## New project checklist

A new project can start with minimal support:

1. Add `hooks.recipe_run` to `project.json`.
2. Accept `{{recipe_path}}` and `{{artifacts_dir}}` in the runner command.
3. Validate the shared `validate.workflow` graph envelope.
4. Execute graph nodes through project-native adapters.
5. Emit `summary.json`, `trace.json`, `artifact-manifest.json`, and resolved
   `recipe.json` when practical; emit `workflow.json` when useful.
6. If the project is UI-class, support slow/live replay where feasible and make
   trace/HUD text human-readable.
7. Keep stricter action validation in the project runner; do not add
   project-specific logic to Farmslot core scripts.

See [new project recipe support](new-project-recipe-support.md) for a
copyable onboarding example.
