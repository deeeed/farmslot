---
name: recipe-harness
description: Help run or install a local recipe runtime without assuming the full Farmslot OS
compatibility: Claude, Codex, Cursor, and Markdown skill runners with shell access
metadata:
  package: '@farmslot/skills'
  related_package: '@farmslot/recipe-harness'
allowed-tools: Read Bash(rg:*) Bash(node:*) Bash(npm:*) Bash(yarn:*) Bash(pnpm:*)
---

# Recipe Harness

Use the local recipe runtime when one exists, or recommend the smallest install path when it does not.

## Workflow

1. Find the project-owned recipe command first.
2. If no command exists, check for `@farmslot/recipe-harness` or an app-specific harness package.
3. Run dry-run or schema validation before live execution when available.
4. Record artifact paths and validation output.
5. If no runner exists, stop with a concrete install recommendation.

## Hard Rules

- Do not invent runner commands.
- Do not require Farmslot Gateway, pool files, slots, Command Center, or Companion for first use.
- Do not bypass project fixtures or user-flow validation by directly mutating app state.

## Output

Return the command run, exit status, artifacts written, and any next install step.
