---
name: project-adopt
description: Recommend the smallest useful Farmslot recipe adoption level for a project
compatibility: Claude, Codex, Cursor, and Markdown skill runners with repo read access
metadata:
  package: '@farmslot/skills'
allowed-tools: Read Bash(rg:*) Bash(node:*) Bash(git:*)
---

# Project Adopt

Recommend a pragmatic adoption path for recipe-first validation.

## Adoption Levels

0. Skills only: author and review recipes with no runner.
1. Recipe runner: add a local command that executes one recipe and emits artifacts.
2. Project recipe layer: add recipes, runner manifest, project actions, and artifact conventions.
3. Farmslot project integration: add `project.json` hooks for slot-based execution.
4. Full OS: adopt Gateway, Command Center, multi-slot dispatch, Companion, and retrospectives.

## Workflow

1. Identify the project type and current test commands.
2. Identify the proof surfaces the project can already produce.
3. Pick the lowest level that would produce reviewer-trustworthy evidence.
4. List only the next one or two concrete changes.

## Hard Rules

- Do not prescribe the full Farmslot OS when a local recipe runner is enough.
- Do not add domain-specific assumptions.
- Do not require a project to change its test stack before proving the first useful recipe.
