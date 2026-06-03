---
title: Project-type onboarding
---

# Project-type onboarding

Farmslot can integrate with many project types because the core contract is not
"use one test framework." The core contract is:

1. define the work in an isolated project/slot context;
2. run project-native validation through a hook or runner;
3. emit a Recipe Protocol v1 evidence package that reviewers can inspect.

Start with the smallest integration that produces reviewable evidence. Add
stronger automation only after the first evidence loop is useful.

## Recommended first project types

| Project type              | Why it fits Farmslot                                                                                         | Minimal first integration                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Expo / React Native       | Cross-platform UI, simulator/device evidence, screenshots, logs, and recipe replay are especially valuable.  | Use `@farmslot/expo-recipe`; `apps/companion` is the in-repo example.                        |
| Web app                   | Browser automation, CDP/Playwright evidence, visual diffs, and PR review artifacts map naturally to recipes. | Wrap Playwright or app-specific smoke checks in a v1 recipe.                                 |
| Backend/API               | Recipes can prove API behavior with pytest/Jest/curl/load-test output without UI evidence.                   | Use `@farmslot/recipe-harness`; `services/gateway` is the natural in-repo example candidate. |
| CLI/package/library       | Recipes can prove commands, build output, type checks, and fixture snapshots.                                | Use `@farmslot/recipe-harness`; `packages/cli` and package workspaces are natural examples.  |
| Native desktop / macOS UI | Useful for future UI proof where screenshots, traces, and native automation matter.                          | Start with command/build/test recipes; add UI automation only when the toolchain is stable.  |

## Integration levels

### Lightweight Farmslot support

This is the public/default path for new or existing projects.

Use it when you want Farmslot dispatch, recipes, and evidence without adopting
organization-specific deployment conventions.

It should include:

- a `project.json` hook such as `hooks.recipe_run`;
- a minimal recipe runner script;
- Recipe Protocol v1 artifacts:
  - `summary.json`;
  - `trace.json`;
  - `artifact-manifest.json`;
- an optional action manifest for project-specific actions;
- optional HUD/overlay support for UI projects.

It should not require:

- organization-specific bundle identifiers;
- store deployment setup;
- hardcoded device names;
- custom icon or variant branding;
- private release scripts.

### Opinionated app frameworks

A team may layer additional conventions on top of lightweight Farmslot support: app identity, variants, device pools, store deployment, release automation, and branding. Keep those conventions in project-owned docs so the public onboarding path remains portable.

## Suggested onboarding order

1. Pick the project type.
2. Identify one review bottleneck.
3. Choose the smallest proof artifact.
4. Add a project recipe runner.
5. Emit the v1 evidence package.
6. Register the project hook.
7. Run the recipe once and inspect artifacts.
8. Expand only after the first loop is useful.

## Project-type guide map

- [Expo / React Native project integration](./expo-project-integration.md)
- [Expo Recipe integration](./expo-recipe.md)
- [Headless Recipe integration](./headless-recipe.md)
- [Write a recipe](./write-a-recipe.md)
- [Import a project](./import-a-project.md)
- [Recipe Protocol v1](../reference/recipe-protocol-v1.md)

Future guide candidates:

- Web app integration;
- native desktop/macOS UI integration.
