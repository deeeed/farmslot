# Recipe Protocol v1 rollout

**Status:** Core contract shipped; project adoption continues.

The canonical contract is [Recipe Protocol v1](../reference/recipe-protocol-v1.md). This file tracks adoption only and does not redefine protocol fields.

## Outcome

Every Farmslot-integrated project can:

1. declare atomic actions in a runner manifest;
2. run parameterized Recipe v1 documents;
3. call recipes from ordered libraries through the same resolver as direct runs;
4. emit typed, exact, independently validatable evidence;
5. expose that evidence consistently in Gateway, Command Center, and Companion.

## Project integration

A project provides:

- `recipe_action_manifest` — machine-readable actions, observers, and preconditions;
- `recipe_doctor` — readiness checks;
- `recipe_run` — execution that writes a Recipe v1 artifact package;
- optional domain actions and recipe libraries;
- fixture and runtime setup appropriate to the project.

Farmslot provides graph validation, library resolution, trust, trace/evidence validation, task inheritance, and review surfaces.

## Required evidence

A run package contains:

- `recipe.json`;
- `recipe-resolution.json`;
- exact reachable documents under `resolved-recipes/`;
- `summary.json`;
- `trace.json`;
- `artifact-manifest.json`;
- claim-specific logs, state, screenshots, or recordings.

## Adoption checks

- The project manifest declares only executable capabilities.
- `run --list` and `run <id> --describe` are sufficient to discover recipes and parameters.
- Direct and nested execution resolve the same id/adapter file.
- Defaults are safe; explicit falsy overrides work.
- Missing dependencies, cycles, invalid params, unsafe paths, and trust failures stop before side effects.
- Follow-up runs inherit the complete exact evidence package.
- Command Center and Companion render the root graph, included recipes, trace, and artifacts without project-specific UI logic.
- One real project recipe proves live behavior through project-native actions rather than fabricated state.

## Rollout sequence

1. Keep protocol schema, validator, harness, CLI, examples, and docs aligned.
2. Integrate project hooks and action manifests.
3. Add the smallest useful domain recipe library.
4. Validate one direct and one nested recipe on each supported adapter.
5. Confirm artifact ingestion and UI rendering.
6. Use normal project work to expand libraries only when reuse reduces inference or improves safety.

## Non-goals

- Replacing project-native test frameworks.
- Encoding product domains in Farmslot core.
- Requiring composition or visual evidence for simple proofs.
- Growing a central recipe library for capabilities better expressed as actions or task-local recipes.
