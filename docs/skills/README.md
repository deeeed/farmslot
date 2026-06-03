# Skills Layout

This directory documents the **runner-neutral** skill contracts that are shared across multiple runners.

## Purpose

Use `docs/skills/` for **SSOT-style specifications** when a skill needs one shared contract across:

- Claude command surfaces
- Codex global skills
- repo-local `.agents/skills` implementations

Do **not** move every skill here by default.

## Current Rule Of Thumb

### Keep implementation in `.agents/skills/`

Use `.agents/skills/` for:

- actual Codex/OMX skill implementations
- workflow instructions
- task templates
- repo-local implementation details

This is the default home for skill behavior while iterating.

### Use `docs/skills/` selectively

Use `docs/skills/` only when a skill needs a shared cross-runner contract.

Good candidates:

- runner-neutral utility skills where Claude and Codex should follow the same behavioral spec

## Runner Surfaces

### Codex / OMX

- repo-local implementation:
  - `.agents/skills/<name>/SKILL.md`
- optional global skill:
  - `~/.codex/skills/<name>/SKILL.md`

### Claude

- visible command surface:
  - `~/.claude/commands/<name>.md`
- supporting global skill only when needed:
  - `~/.claude/skills/<name>/SKILL.md`

Avoid duplicate visible Claude surfaces with the same name when one command is enough.

## Single-Surface Principle

For Claude specifically, prefer:

- one visible slash command
- optional hidden/shared spec behind it

Example:

- visible command:
  - `/recipe-quality`
- implementation/spec source:
  - `.agents/skills/fs-recipe-quality/SKILL.md` for repo-local Farmslot agents
  - `packages/skills/skills/recipe-quality/SKILL.md` for the packaged adoption kit

This prevents duplicated menu entries and keeps the command UX clean. Add a
`docs/skills/<name>.md` SSOT only when multiple runner surfaces need one shared
contract.

## Practical Guidance

When creating a new skill:

1. start in `.agents/skills/`
2. only add `docs/skills/<name>.md` if you truly need a cross-runner SSOT
3. for Claude, prefer a single visible command name
4. for Codex, use a normal global skill shim if needed
5. avoid duplicating the same user-facing surface under multiple runner files unless there is a clear benefit
