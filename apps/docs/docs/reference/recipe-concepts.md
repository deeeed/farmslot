---
title: Recipe concepts
---

# Recipe concepts

A project supplies a **ProjectRuntime** for readiness, owned lifecycle, actions and supported capture. Its **ActionCatalog** pairs action declarations with code. The shared **RecipeEngine** resolves the recipe graph and runs its **ActionHandlers**. Recipes compose actions and assertions into retained evidence.

Use `farmslot doctor --conformance` to check a binding now. The `recipe run` path below is the next delivery step.

```mermaid
flowchart LR
  CLI[farmslot recipe run] --> Binding[Resolved binding]
  Binding --> Runtime[ProjectRuntime]
  Runtime --> Engine[RecipeEngine preflight]
  Engine --> Actions[ActionHandlers]
  Actions --> Artifacts[Artifact package]
  Artifacts --> Evidence[Assertions and evidence]
```

`pack.json` describes onboarding, `project.json` describes behavior, and pool bindings describe machine targets. The binding resolves project, app, domain, runtime, target, libraries, ports and output paths. Flags win over checkout bindings, then pool slots, unique detection and configured defaults. An ambiguous target refuses execution.

Team libraries compose in declaration order. Each keeps its owner, source revision and version requirements. Namespaced references identify the library; the first source wins for a bare reference. Preflight checks cross-library dependencies and parameters. Reports name the winning sources and any shadows.

Metadata discovery grants no permission to import code. Runtime sources must be installed or explicitly authorized. Execution checks the complete plan, including action authority. The gateway owns hosted resource leases.

Capabilities are scoped to a project, app, runtime and target, with `declared`, `verified`, `failed` or `unknown` results. `registered` records declaration availability. `recipe-verified` requires current positive evidence. Unsupported operations are explicit.

Conformance reports record code, configuration, target and timestamp. Changed checkout, provider or library bytes make them stale. Static checks prove preflight; live checks prove bounded effects and teardown. Missing required evidence cannot pass. HUD and capture checks apply where supported.

Run `farmslot doctor <checkout> --conformance` to check the provider, catalog and full preflight without launching the app or executing actions. The report records the checked invocation and source digests. It writes `conformance-report.json` under the configured artifact directory. By default it checks every catalog recipe; `--recipe <ref>` and repeatable `--param key=value` select a specific invocation.

Declare `recipe.provider` and an ordered `recipe.libraries` list in `project.json`. Each library has `name`, `source` and `owner`; repository sources also require an exact `revision`. The provider exports `createProvider(context)` and returns its runtime, plus an optional engine. The shared engine is the default. Registered configuration or an installed package authorizes loading. Discovered executable sources require the operator's exact `--authorize-provider <module>` approval.

Executable library sources need registered project configuration, `--library name=path`, `RECIPE_LIBRARY_PATH`, or the operator's configured personal library. Authorizing a discovered provider alone does not authorize libraries found in checkout metadata. Engine trust checks still apply to every source.

Provider `root` and library `source` can reuse portable `{ "env": "EXAMPLE_PACKAGE_ROOT" }` or `{ "projectPath": "recipe-library" }` references. The first reads the operator environment or selected pool env; the second resolves from the checkout. Discovered metadata cannot resolve those references until the project is registered. This supports globally installed provider packages without home-path defaults.

Recipe state uses `--runtime-dir`, then `RECIPE_RUNTIME_DIR`, then `temp/recipe/runtime` relative to the target. The farm worker directory in `paths.runtime_dir` is separate. The artifact directory in `paths.artifact_dir` resolves from the checkout root, including when an app is selected.

Reports include native checkout sources as well as application code. A direct recipe file and its adjacent task library are bound to the checked invocation, including its parameters. Changing any of those inputs requires a new check.
