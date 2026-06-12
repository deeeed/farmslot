---
title: Recipe skills adoption kit
---

# Recipe skills adoption kit

The easiest way to try Farmslot should be **recipe-first**, not full-platform-first.

A team should be able to add a small set of agent skills to an existing project and ask:

> Create a recipe that proves this bug is fixed.

No Command Center, gateway, pool file, or multi-machine setup should be required for that first win. The skills teach the agent how to create proof: choose the right validation target, write a small recipe, run it locally when possible, and produce artifacts a reviewer can trust.

## Product thesis

`@farmslot/skills` should be the low-friction adoption kit for Farmslot.

It is not the recipe runtime. It is the agent-facing layer that helps a project adopt the recipe concept with minimal setup:

- install skills into Claude, Codex, Cursor, or repo-local agent folders;
- guide the agent to write high-quality recipes;
- check whether the project can produce recipe evidence;
- explain the smallest next integration step;
- grow from recipe-only proof into the full Farmslot framework only when useful.

## Proposed package

```text
packages/skills/
  package.json              # @farmslot/skills
  README.md
  bin/
    farmslot-skills.mjs     # install/list/doctor
  skills/
    recipe-cook/
      SKILL.md
    recipe-quality/
      SKILL.md
    recipe-doctor/
      SKILL.md
    recipe-harness/
      SKILL.md
    project-adopt/
      SKILL.md
  schemas/
  templates/
```

Planned package flow once `@farmslot/skills` is published:

```bash
npx @farmslot/skills init
```

or selectively:

```bash
npx @farmslot/skills install --target . --include recipe-cook,recipe-doctor
```

## Initial skills

| Skill            | Purpose                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `recipe-doctor`  | Check whether the project can run or author recipes; report missing package, script, artifact, or UI-proof support. |
| `recipe-cook`    | Turn acceptance criteria into a small recipe with setup, action, assertion, teardown, and proof artifacts.          |
| `recipe-harness` | Explain or execute the local recipe command for the project without requiring Command Center.                       |
| `recipe-quality` | Review recipe and evidence quality; enforce no fake proof and no hidden state injection.                            |
| `project-adopt`  | Recommend the smallest useful Farmslot integration level for the project type.                                      |

## Incremental adoption ladder

### Level 0 — Skills only

Install the skills and use them to write or review recipes. The project may not have a runner yet. The output can be a proposed recipe and proof plan.

### Level 1 — Recipe runner only

Add a small local script that can run one recipe and emit proof artifacts.

```bash
npx @farmslot/recipe-harness run recipes/example.recipe.json
```

For Expo / React Native projects, this may start with:

```bash
npx @farmslot/expo-recipe init
```

### Level 2 — Project recipe layer

Add a recipe folder, a runner manifest, optional project actions, and artifact output conventions. UI projects can add HUD or visual proof support; headless projects can rely on logs, traces, assertions, and summaries.

### Level 3 — Farmslot project integration

Add `project.json` hooks so Command Center can run the recipe through a project slot.

### Level 4 — Full framework

Adopt multi-slot dispatch, live steering, cross-runner review, Companion supervision, and retrospective improvement loops.

## Design constraints

- **Recipe-first:** never require full Farmslot setup for the first proof artifact.
- **Project-owned:** projects keep their own commands, fixtures, and custom actions.
- **Agent-friendly:** skills should explain what to do, what not to fake, and how to verify the output.
- **Multi-surface:** install into Claude, Codex, Cursor, and generic `.agents/skills` targets.
- **No private assumptions:** no hardcoded company paths, Jira projects, device names, or wallet-specific actions.
- **Composable:** project-specific skill packs can layer on top, similar to how domain-specific skills layer project knowledge over generic recipe concepts.

## Why this matters

This makes Farmslot useful before it is fully installed. A project can start with one recipe and one proof artifact, then grow into the broader framework only after the value is clear.

That is the adoption wedge: **start with recipes, grow into the framework.**
