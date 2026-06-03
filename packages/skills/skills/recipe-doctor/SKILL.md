---
name: recipe-doctor
description: Diagnose local readiness for recipe authoring and execution
compatibility: Claude, Codex, Cursor, and Markdown skill runners with shell access
metadata:
  package: '@farmslot/skills'
  outputs: readiness report
allowed-tools: Read Bash(rg:*) Bash(node:*) Bash(npm:*) Bash(yarn:*) Bash(pnpm:*) Bash(git:*)
---

# Recipe Doctor

Check how far a project can go with recipes today.

## Use When

- A project wants to try recipe-first validation
- An agent needs to know whether a local recipe runner exists
- A recipe failed because commands, fixtures, browser control, or artifact paths are unclear

## Workflow

1. Inspect package scripts and repo docs for recipe commands.
2. Look for recipe files, runner manifests, action manifests, schemas, or artifact conventions.
3. Check whether `@farmslot/recipe-harness`, an app-specific runner, or a custom script is installed.
4. Identify proof surfaces: state/log artifacts, screenshots, traces, browser control, mobile bridge, or command output.
5. Report the smallest useful next step.

## Output

Return:

- detected project type
- available recipe commands
- available proof surfaces
- missing blockers
- suggested adoption level from 0 to 4

Do not require Farmslot Gateway, Command Center, pool files, or slots for the first readiness pass.
