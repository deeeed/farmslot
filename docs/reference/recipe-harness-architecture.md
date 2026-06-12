# Farmslot Recipe Harness Architecture

Status: working architecture for the May 29 productionization pivot.

Related docs:

- [reference/recipe-harness-high-level.md](recipe-harness-high-level.md) — concise visual explainer and interface map
- [reference/recipe-runner-protocol.md](recipe-runner-protocol.md)
- [plans/generic-recipe-protocol.md](../plans/generic-recipe-protocol.md)
- [ROADMAP-next.md](../ROADMAP-next.md)
- [`packages/cli/src/commands/recipe.ts`](../../packages/cli/src/commands/recipe.ts)

## Executive summary

Farmslot should be framed as an **agentic engineering framework and control plane** for running work across projects, machines, models, and human gates.

Terminology boundary:

- **Recipe Harness package** — shared Farmslot runtime library/CLI that validates
  recipes, executes action adapters, and writes evidence artifacts.
- **`/recipe-harness` skill** — Example App operator workflow for installing,
  verifying, launching, and cleaning up Mobile/Extension runtime overlays.
- **Project runner** — project-owned executable behind `hooks.recipe_run`.

The recipe harness is the contract layer that lets projects plug into that OS. A project does not need to adopt every Farmslot feature. It needs to implement the Farmslot recipe contract:

1. a `validate.workflow` graph envelope;
2. a project-owned runner hook;
3. adapter-owned action semantics;
4. a typed artifact package;
5. enough metadata for Command Center, Mobile Companion, and eval/replay surfaces to inspect the evidence generically.

This makes Farmslot the orchestrator and evidence viewer, while projects remain owners of their native app/test/runtime details.

## Architecture positioning

```text
Farmslot framework / OS
  ├─ fleet + slots + dispatch queue
  ├─ runners + tmux/session control
  ├─ backlog/eval/replay/human gates
  ├─ Command Center + Mobile Companion surfaces
  └─ recipe harness contract layer
       ├─ shared protocol and validator
       ├─ runner CLI/API
       ├─ artifact package writer
       └─ project adapter boundary

Compatible project
  ├─ project.json hooks
  ├─ app-native runner/adapters
  ├─ project-owned recipes/templates
  └─ generated artifacts consumed by Farmslot
```

The key distinction:

- **Farmslot owns orchestration, contract validation, and evidence consumption.**
- **Projects own execution semantics.**

That is why the harness should not be a pile of project-specific scripts inside a skill. The production harness is a typed package boundary between the Farmslot OS and compatible projects.

## Layer model

### Layer 1 — Skill / agent instructions

Skills remain thin instructions:

- how to gather source truth;
- how to extract acceptance criteria;
- how to draft recipes;
- when to run validation;
- how to critique weak evidence.

Skills should not own the production runtime harness.

### Layer 2 — Recipe protocol

The shared protocol is already started in `@farmslot/protocol`:

- `validateRecipeDocument`
- `validateArtifactManifestDocument`
- `validateRecipeArtifactPackage`
- recipe document, manifest, artifact, and workflow validators under `packages/protocol/src/recipe/`
- `RecipeArtifactManifestDocument`
- `RECIPE_ARTIFACT_TYPES`

This layer defines the v1 contract and should stay project-neutral.

### Layer 3 — Harness package

The harness package is the production runtime that executes compatible recipes and writes compatible artifacts. It should be TypeScript-first and API-first, with CLI wrappers.

Recommended package name inside Command Center workspace:

```text
packages/recipe-harness
```

Potential published name later:

```text
@farmslot/recipe-harness
```

It depends on `@farmslot/protocol` and implements runtime behavior over the protocol.

### Package exposure model

The implementation should expose two reusable package layers. Start as private
workspace packages inside Farmslot; keep the public API shaped so they can later
be published to npm without rewriting project runners.

| Package                      | Role                                                                                                | Consumers                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `@farmslot/protocol`         | Pure v1 spec types, official action registry, schemas, validators. No filesystem/process execution. | Command Center, Companion, recipe-quality, project runners, adapter packages. |
| `@farmslot/recipe-harness`   | Reusable runner runtime: graph execution, adapter registry, artifact writers, CLI/bin.              | Most backend/CLI projects directly; richer UI projects via adapters.          |
| Project adapter package/repo | Project/runtime bindings and custom actions.                                                        | Example: Example Mobile App/Extension runner packages.                        |

`@farmslot/protocol` should remain safe to import anywhere:

```ts
import {
  OFFICIAL_RECIPE_ACTIONS,
  type RecipeActionManifestDocument,
  type RecipeDocument,
  validateArtifactManifestDocument,
  validateRecipeActionManifestDocument,
  validateRecipeDocument,
  validateRecipeWithManifest,
} from '@farmslot/protocol';
```

`@farmslot/recipe-harness` should be the minimal production runner that projects
can use directly:

```ts
import {
  createRecipeRunner,
  createStandardCoreAdapters,
  defineActionAdapter,
} from '@farmslot/recipe-harness';

const runner = createRecipeRunner({
  actionManifest,
  adapters: [
    ...createStandardCoreAdapters(),
    defineActionAdapter({
      action: 'ui.navigate',
      schema: actionManifest.action_metadata?.['ui.navigate']?.schema,
      async execute(node, context) {
        await context.controls.navigate(String(node.target), node.params);
        return { ok: true, next: node.next };
      },
    }),
  ],
});

await runner.run({
  recipePath: process.argv[2],
  artifactsDir: process.argv[3],
});
```

This makes the base package useful for simple projects immediately:

- backend/CLI projects can use the built-in `command`, `assert_*`,
  `watch_logs`, and `index_artifacts` adapters with no custom runner code;
- UI/native/browser projects can provide only the control bridge adapters they
  need (`ui.*`, `app.*`, `cdp.*`);
- product/domain projects can add namespaced custom actions through the same
  adapter registration path.

The package boundary should make adapter extension boring: a custom action is
valid only when both the manifest and an adapter declare it.

### Layer 4 — Project adapters

Adapters bind recipe actions to app-native execution:

- command/shell;
- CDP/Playwright for browser and extension flows;
- Maestro/Detox/ADB/XCTest for mobile;
- pytest/API test runners for backend;
- custom project adapters when needed.

Adapters may be packaged with Farmslot if generic, or owned by projects when domain-specific.

### Layer 5 — Artifact consumers

Command Center, Mobile Companion, eval packages, PR evidence helpers, and reports consume artifact packages generically:

- `summary.json`
- `trace.json`
- `artifact-manifest.json`
- resolved `recipe.json` / `workflow.json`
- screenshots/videos/logs/reports

Consumers should not guess project behavior from filenames when a typed manifest exists.

## Contract between Farmslot and projects

A Farmslot-compatible project implements this minimum contract.

### `project.json`

```json
{
  "hooks": {
    "recipe_run": "node scripts/agentic/validate-recipe.js --recipe {{recipe_path}} --artifacts-dir {{artifacts_dir}}"
  },
  "recipe_run_supports_playback_slow": true,
  "recipe_run_supports_video_recording": true
}
```

The project hook receives Farmslot variables and executes the project runner. `{{recipe_path}}` is a shell-boundary convenience, not a claim that every internal API must use a file literally named `recipe.json`. In-process APIs may pass a recipe document object directly, and adapters may normalize project-native recipe references. V1 shell hooks must include `{{recipe_path}}` and `{{artifacts_dir}}` explicitly.
Optional replay controls are capability-gated: `recipe_run_supports_playback_slow`
allows the gateway to append `--slow <ms>`, and
`recipe_run_supports_video_recording` allows it to append `--record`.

### Runtime overlay hygiene

Project farms own the hygiene contract for generated harness overlays in their
target repos. If a farm config sets `RECIPE_HARNESS_ROOT` or relies on the
default `temp/recipe/harness`, that path must be ignored by the target repo's
git rules and by any farm-level source-diff filters. Harness installation may
write executable runners, helper manifests, and adapter overlays there; those
files are runtime state, not source changes.

### Recipe document

```json
{
  "schema_version": 1,
  "title": "Human-readable validation title",
  "description": "What this recipe proves",
  "inputs": {},
  "validate": {
    "workflow": {
      "entry": "run-check",
      "nodes": {
        "run-check": { "action": "command", "next": "done" },
        "done": { "action": "end", "status": "pass" }
      },
      "playback": { "mode": "off", "slow_ms": 2000 }
    }
  }
}
```

### Artifact package

Every run writes into `{{artifacts_dir}}`:

```text
artifacts/
  summary.json
  trace.json
  artifact-manifest.json
  recipe.json
  logs/
  screenshots/
  videos/
  reports/
```

`artifact-manifest.json` is the stable typed index:

```json
{
  "version": 1,
  "runStatus": "pass",
  "artifacts": [
    {
      "path": "screenshots/final-state.png",
      "type": "screenshot",
      "label": "Final state after validation",
      "nodeId": "capture-final-state",
      "mimeType": "image/png"
    }
  ]
}
```

### Production output contract

A production-compatible runner emits the same evidence package every time:

| File                     | Required? | Purpose                                                                                |
| ------------------------ | --------- | -------------------------------------------------------------------------------------- |
| `summary.json`           | Yes       | Small status/counts/duration/top-level-error index.                                    |
| `trace.json`             | Yes       | Ordered node/action trace with durations, errors, intent, and artifact links.          |
| `artifact-manifest.json` | Yes       | Typed artifact index for screenshots, videos, logs, reports, recipes, and comparisons. |

`summary.json` is output, not input. It lets Command Center, Companion, PR evidence, and evals show run state without parsing `trace.json` or logs.

Artifact entries should optionally carry `proofTarget` / `covers` so evidence
can be tied back to acceptance criteria and `/recipe-quality` critiques.

`recipe.json` is the selected input document when available. `workflow.json` is
the resolved graph that actually executed after input expansion and runner
normalization. Emit both when practical.

## Harness package responsibilities

The harness package should own:

1. validating recipe documents through `@farmslot/protocol`;
2. loading and normalizing a recipe into a runnable workflow;
3. executing graph nodes through registered action adapters;
4. writing trace entries for every node;
5. writing typed artifact manifest entries for every artifact;
6. writing summary status and counts;
7. copying the resolved recipe/workflow into artifacts;
8. exposing a CLI for project hooks and local use;
9. exposing clear adapter seams for Example App `/recipe-harness` and `/recipe-cook` workflows.

The harness package should **not** own:

- LLM prompting strategy;
- recipe authoring instructions;
- perps-specific flows;
- Example App-specific test IDs in core runtime;
- project-specific fixture semantics;
- Command Center UI rendering;
- dispatch queue or slot scheduling.

## Proposed package shape

```text
packages/recipe-harness/
  package.json
  tsconfig.json
  src/
    index.ts
    types.ts
    errors.ts
    recipe-loader.ts
    graph-runner.ts
    action-adapter.ts
    runner-context.ts
    artifact-writer.ts
    trace-writer.ts
    summary-writer.ts
    cli.ts
    adapters/
      command.ts
      wait.ts
      assert-file.ts
      assert-json.ts
      index-artifacts.ts
      end.ts
      registry.ts
  test/
    fixtures/
    recipe-loader.test.ts
    graph-runner.test.ts
    artifact-writer.test.ts
    cli.test.ts
```

## Core TypeScript interfaces

```ts
export interface CreateRecipeRunnerOptions {
  actionManifest: RecipeActionManifestDocument;
  adapters: ActionAdapter[];
  controls?: Record<string, unknown>;
  logger?: RecipeLogger;
}

export interface RecipeRunRequest {
  recipePath?: string;
  recipeDocument?: RecipeDocument;
  projectRecipeRef?: string;
  artifactsDir: string;
  projectRoot?: string;
  repoRoot?: string;
  env?: Record<string, string>;
  playback?: {
    mode?: 'off' | 'auto' | 'step';
    slowMs?: number;
  };
}

export interface RecipeRunResult {
  status: 'pass' | 'fail' | 'unknown';
  summaryPath: string;
  tracePath: string;
  artifactManifestPath: string;
  recipeCopyPath?: string;
  exitCode: number;
}

export interface RecipeRunnerContext {
  request: RecipeRunRequest;
  recipe: unknown;
  actionManifest: RecipeActionManifestDocument;
  artifacts: ArtifactWriter;
  trace: TraceWriter;
  logger: RecipeLogger;
  controls: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface WorkflowNode {
  id: string;
  action: string;
  next?: string;
  default?: string;
  cases?: unknown;
  status?: 'pass' | 'fail' | 'unknown';
  [key: string]: unknown;
}

export interface ActionAdapter {
  action: string;
  schema?: Record<string, unknown>;
  validate?(node: WorkflowNode, context: RecipeRunnerContext): void | Promise<void>;
  execute(node: WorkflowNode, context: RecipeRunnerContext): Promise<ActionResult>;
}

export interface ActionResult {
  ok: boolean;
  status?: 'pass' | 'fail' | 'unknown';
  next?: string;
  outputs?: Record<string, unknown>;
  artifacts?: Array<{
    path: string;
    type: string;
    label?: string;
    mimeType?: string;
  }>;
  error?: string;
}
```

These runtime interfaces intentionally sit above `@farmslot/protocol`: protocol validates the v1 contract; harness executes.

## Action naming standard

Action names are part of the Farmslot v1 recipe specification. The harness should provide one portable vocabulary across project types, while letting each runner declare custom project/domain actions.

Principles:

1. Portable core actions are unprefixed: `command`, `wait`, `assert_file`, `assert_json`, `assert_exit_code`, `assert_output`, `state_read`, `watch_logs`, `index_artifacts`, `call`, `switch`, `manual`, `end`.
2. Optional capability namespaces are generic: `ui.*`, `app.*`, and `cdp.*`.
3. Product/domain behavior uses project namespaces such as `example.wallet.*` or `example.trade.*`; it is not added to the Farmslot base spec.
4. Runner custom actions are allowed only when declared in the runner manifest with schema/description/examples.
5. Core protocol validates structure, transitions, and whether the action name is allowed; adapter validators validate action-specific fields.
6. New action names should be added deliberately with examples, not invented per recipe.
7. The runner manifest is also the agent-facing action catalog for `/recipe-cook`: official actions come from the v1 registry, and runner-specific official/custom details come from manifest metadata.

Conceptual validation model:

```ts
type OfficialActionName =
  | 'command'
  | 'wait'
  | 'assert_file'
  | 'assert_json'
  | 'assert_exit_code'
  | 'assert_output'
  | 'state_read'
  | 'watch_logs'
  | 'index_artifacts'
  | 'call'
  | 'switch'
  | 'manual'
  | 'end'
  | 'ui.navigate'
  | 'ui.press'
  | 'ui.key_press'
  | 'ui.set_input'
  | 'ui.scroll'
  | 'ui.gesture'
  | 'ui.wait_for'
  | 'ui.screenshot'
  | 'app.lifecycle'
  | 'app.hud'
  | 'app.trace'
  | 'cdp.target'
  | 'cdp.storage'
  | 'cdp.network'
  | 'cdp.emulation'
  | 'cdp.metrics'
  | 'cdp.trace';

interface RunnerActionExample {
  description?: string;
  node: Record<string, unknown>;
}

interface RunnerOfficialActionMetadata {
  description?: string;
  schema?: Record<string, unknown>;
  examples?: RunnerActionExample[];
  when_to_use?: string;
  avoid_when?: string;
  native_binding?: string;
}

interface RunnerActionDeclaration {
  name: string;
  owner: string;
  description: string;
  schema: Record<string, unknown>;
  examples: RunnerActionExample[];
  when_to_use?: string;
  avoid_when?: string;
  proof_effect?: string;
  safety_notes?: string;
}

interface RunnerStateRefDeclaration {
  ref: string;
  description: string;
  schema?: Record<string, unknown>;
}

interface RunnerPreconditionDeclaration {
  id: string;
  description: string;
  params_schema?: Record<string, unknown>;
  failure_kind?: 'setup' | 'environment' | 'fixture' | 'product';
}

interface RunnerActionRegistry {
  runner_protocol_version: 1;
  action_registry_version: 1;
  supported_official_actions: OfficialActionName[];
  action_metadata?: Partial<Record<OfficialActionName, RunnerOfficialActionMetadata>>;
  custom_actions?: RunnerActionDeclaration[];
  state_refs?: RunnerStateRefDeclaration[];
  pre_conditions?: RunnerPreconditionDeclaration[];
  custom_assertion_operators?: RunnerActionDeclaration[];
  native_bindings?: Array<{
    action: OfficialActionName | string;
    implementation: string;
  }>;
}
```

A runner is v1-compatible for the action set it declares. This makes `/recipe-cook` and fine-tuned models much more reliable because the model learns a small stable action vocabulary instead of inventing one-off node actions. The manifest should be complete enough that an authoring agent can choose actions from the catalog without reading adapter source.

This is also the production version of the ad hoc agentic toolkit pattern: the
runner publishes a typed, inspectable toolkit of official-action examples and
custom project actions, and recipe-authoring agents consume that toolkit before
writing executable recipe graphs.

## Initial built-in package adapters

This is the first implementation subset for the shared package, not the full official action registry. The full registry is defined in `reference/recipe-runner-protocol.md`; additional official actions can be implemented by project adapters or later package phases.

### `command`

Runs a shell command with safe cwd/env configuration and captures:

- stdout log;
- stderr log;
- exit code;
- duration;
- optional JSON output.

### `wait`

Sleeps for a fixed duration only. Use `ui.wait_for`, `watch_logs`, or `state_read` + assertion for conditions.

### `assert_file`

Asserts file existence, optional content match, optional JSON parse.

### `assert_json`

Asserts JSON values from a file or prior node output.

### `index_artifacts`

Registers declared files into `artifact-manifest.json`.

### `end`

Terminates graph with `pass`, `fail`, or `unknown`.

## Project-specific adapters

Project adapters can be registered by CLI/module:

```ts
import { createRecipeRunner } from '@farmslot/recipe-harness';
import { exampleBrowserAdapters } from './example-browser-adapters.js';

const runner = createRecipeRunner({
  adapters: [...exampleBrowserAdapters],
});

await runner.run({
  recipePath: process.argv[2],
  artifactsDir: process.argv[3],
});
```

A project adapter can validate action-specific fields without changing the Farmslot core protocol.

### Example App adapter package shape

Example App should build on the base runner rather than forking it:

```text
example-app-skills or an Example App runner package
  src/
    mobile/
      action-manifest.ts
      controls.ts              # injected RN bridge client
      adapters/
        ui-navigate.ts
        ui-wait-for.ts
        app-hud.ts
        wallet-unlock.ts
        perps-enter-amount-keypad.ts
    extension/
      action-manifest.ts
      controls.ts              # CDP target/session client
      adapters/
        cdp-target.ts
        cdp-network.ts
        ui-wait-for.ts
        wallet-select-network.ts
```

The adapter package should export:

```ts
export function createExampleAppMobileRunner(options: {
  projectRoot: string;
  controls: ExampleAppMobileControls;
}): RecipeRunner;

export function createExampleAppExtensionRunner(options: {
  projectRoot: string;
  controls: ExampleAppExtensionControls;
}): RecipeRunner;
```

Each factory composes:

1. `createStandardCoreAdapters()` from `@farmslot/recipe-harness`;
2. the runner's generated `RecipeActionManifestDocument`;
3. Mobile/Extension `ui.*`, `app.*`, or `cdp.*` adapters;
4. Example App custom `example.wallet.*`, `example.trade.*`, and
   `example.debug.*` adapters.

The injected app/CDP bridge is a **controls dependency**, not a forked harness.
That keeps the package reusable: other React Native, web, backend, CLI, or
native projects can reuse the same runner runtime and provide their own
controls/adapters.

## CLI contract

The harness should expose:

```bash
farmslot-recipe run <recipe.json> --artifacts-dir <dir>
farmslot-recipe validate <recipe.json> [--artifact-dir <dir>]
farmslot-recipe explain <recipe.json>
farmslot-recipe init --template command|ui|mobile
```

Inside the Command Center CLI, this can also surface as:

```bash
yarn farmslot recipe validate <recipe.json> --artifact-dir <dir>
yarn farmslot recipe run <recipe.json> --artifact-dir <dir>
```

`validate` already exists in `packages/cli/src/commands/recipe.ts`. `run` is the next production seam.

## Relationship to Example App `/recipe-*` skills

An Example App skill surface should live outside the harness package, for example in a project-local or user-local skills directory. The user-facing skills should be described in three levels:

| Level                     | Skills                                                        | Purpose                                                                                                                     |
| ------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| High-level workflow       | `/recipe-dev`, `/recipe-fix-ticket`                           | End-to-end implementation workflows that should start from task/ticket intent and stop at human review gates with evidence. |
| Mid-level recipe workflow | `/recipe-cook`, `/recipe-quality`, `/recipe-evidence`         | Author proof graphs, critique proof strength, and format reviewer-facing evidence.                                          |
| Low-level runtime/control | `/recipe-doctor`, `/recipe-harness`, `/recipe-wallet-control` | Diagnose setup, install/verify runtime overlays, and provide Example App-aware wallet/runtime primitives.                   |

Use high-level skills first. Drop to low-level skills only for setup, steering, debugging, or explicit runtime proof.

The production harness provides the runtime seam under those skills. Skills remain the workflow layer; the harness package owns v1 execution and evidence.

Production ownership:

| `/recipe-*` responsibility   | Production home                          |
| ---------------------------- | ---------------------------------------- |
| Agent instructions/checklist | Example App skill docs                   |
| Recipe authoring prompt      | `/recipe-cook` skill/template layer      |
| Runtime install/verify       | `/recipe-harness` + project adapters     |
| Recipe v1 validation         | `@farmslot/protocol`                     |
| Graph execution              | `@farmslot/recipe-harness`               |
| Artifact writing             | `@farmslot/recipe-harness`               |
| Evidence critique/formatting | `/recipe-quality` and `/recipe-evidence` |
| Scenario benchmarking        | Farmslot eval/replay layer               |

## Relationship to e2e tests

Recipes are not a blanket replacement for e2e tests.

- E2E tests remain the regression suite.
- Recipes are the agent/human review evidence loop: they prove a specific PR claim, capture artifacts, and can later graduate into regression coverage.
- Shared adapters can power both recipes and e2e-like flows.
- The production harness should make it easier to decide which recipes deserve promotion into durable test suites.

## Implementation phases

### Phase 0 — lock the v1 specification

Deliverable: this document plus `reference/recipe-runner-protocol.md`.

Exit criteria:

- architecture understood as Farmslot OS + v1-compatible projects;
- generic, shared UI, app/runtime, CDP, native, and custom project action namespaces agreed;
- first code seam agreed.

### Phase 1 — protocol consolidation

Work:

- make v1 protocol types explicit enough for the harness package;
- define the official action registry and runner action manifest shape;
- export `RecipeActionManifestDocument`, `OfficialActionName`,
  `validateRecipeActionManifestDocument`, and `validateRecipeWithManifest`;
- ensure examples cover backend command, UI live, and self-validation recipes;
- keep validator project-neutral.

Exit criteria:

- `yarn --cwd apps/command-center test:protocol` passes;
- examples validate as v1;
- undeclared actions are invalid.

### Phase 2 — harness package skeleton

Work:

- add `packages/recipe-harness`;
- export core interfaces;
- expose `createRecipeRunner`, `defineActionAdapter`,
  `createStandardCoreAdapters`, and artifact writer APIs;
- accept a `RecipeActionManifestDocument` at runner construction time;
- fail fast when a registered adapter is missing from the manifest or a recipe
  uses an action that is not manifest-declared;
- implement artifact/trace/summary writers;
- implement graph loader and built-in `end` adapter;
- add tests over tiny recipes.

Exit criteria:

- package typechecks independently;
- a minimal recipe writes `summary.json`, `trace.json`, `artifact-manifest.json`, and copied `recipe.json`.
- a manifest-aware validation test rejects undeclared recipe actions.

### Phase 3 — portable command runner

Work:

- implement `command`, `assert_file`, `assert_json`, `assert_exit_code`, `assert_output`, and `index_artifacts` adapters;
- add CLI `recipe run` through either package bin or Command Center CLI;
- create fixture recipe that executes without app dependencies.

Exit criteria:

- backend/headless recipe runs locally;
- failure path produces useful trace and non-zero exit;
- artifact package validates with the v1 protocol validator.
- simple backend/CLI projects can use the package directly with no project
  adapter code beyond a manifest file.

### Phase 4 — Example App shared adapter spec

Work:

- define Mobile + Extension support for shared `ui.*` actions;
- define Example App custom `example.wallet.*` actions as runner extensions;
- define `cdp.*` actions for browser/devtools-backed projects;
- define `app.*` runtime actions for lifecycle, overlay, and tracing;
- define `example.trade.*` custom action manifest entries where needed.

Exit criteria:

- one Mobile and one Extension recipe can be written only with manifest-declared action names;
- action schemas are explicit;
- product-specific test IDs and fixture details remain outside core runtime.

### Phase 5 — project adapters

Work:

- register Extension and Mobile adapters outside the core harness;
- implement action-specific validation in adapter packages or project repos;
- document adapter authoring.

Exit criteria:

- one Extension and one Mobile proof flow can use the production artifact writer;
- shared `ui.*` actions behave consistently across Mobile and Extension; Example App wallet actions are declared as custom runner actions.

### Phase 6 — Farmslot integration

Work:

- gateway/project hooks invoke the production harness where configured;
- Command Center consumes typed artifacts;
- eval/replay packages record harness version/SHA.

Exit criteria:

- a v1-compatible project can run through Farmslot with no bespoke UI code;
- human gate surfaces graph, summary, trace, screenshots/video/logs from typed artifacts.

## First code seam recommendation

Start with **one base PR** that combines protocol consolidation, the harness
package skeleton, portable core adapters, and the adapter authoring contract:

1. export `RecipeActionManifestDocument`, the official action registry, and
   manifest-aware recipe validation from `@farmslot/protocol`;
2. create `packages/recipe-harness`;
3. expose `createRecipeRunner`, `defineActionAdapter`, and
   `createStandardCoreAdapters`;
4. require `RecipeActionManifestDocument` in `createRecipeRunner`;
5. implement `ArtifactWriter`, `TraceWriter`, `SummaryWriter`;
6. implement `GraphRunner` with portable core adapters such as `end`,
   `command`, assertions, `watch_logs`, and `index_artifacts`;
7. add adapter authoring fixtures and tests for missing manifest declarations
   and missing adapter implementations;
8. validate generated output with `validateRecipeArtifactPackage`.

This creates production harness code without touching Example App-specific runtime
adapters, while still proving that project adapters can be registered cleanly.
The Example App PR that follows should be allowed to feed fixes back into this
shared seam if implementation reveals missing generic behavior.

## Acceptance criteria for the first PR

- A new package exists at `packages/recipe-harness`.
- It exposes typed runtime interfaces.
- It can be consumed as a library and a CLI.
- It requires a manifest and rejects undeclared actions.
- It can run a minimal recipe with `command -> index_artifacts -> end`.
- It writes:
  - `summary.json`
  - `trace.json`
  - `artifact-manifest.json`
  - `recipe.json`
- Its generated artifact package validates with `@farmslot/protocol`.
- Existing Example App `/recipe-*` skill scripts are untouched.
- Existing `farmslot recipe validate` behavior is unchanged.
- `cd apps/command-center && yarn typecheck` passes.
- `cd apps/command-center && yarn test:protocol` passes.

## Non-goals for the first PR

- No Extension/Mobile adapter implementation.
- No skill repo extraction.
- No dispatch queue changes.
- No Command Center UI rewrite.
- No rewrite of the Example App `/recipe-*` skill workflow.
- No new enterprise/platform rollout claim.

## Presentation phrasing

> Farmslot is becoming the local OS for agentic engineering. Projects become compatible by implementing the recipe runner contract: graph in, project-native execution, typed evidence out. The harness is the kernel boundary for proof: it standardizes how work is validated and reviewed without forcing every project to use the same internal test tools.
