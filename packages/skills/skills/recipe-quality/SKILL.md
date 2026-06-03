---
name: recipe-quality
description: Review validation recipes and evidence quality without project-specific assumptions
compatibility: Claude, Codex, Cursor, and Markdown skill runners with read access to recipe artifacts
metadata:
  package: '@farmslot/skills'
  outputs: recipe-quality findings or artifacts/recipe-quality.json when the runner supports artifacts
allowed-tools: Read Bash(rg:*) Bash(node:*) Bash(git:*)
---

# Recipe Quality

Review whether a recipe proves the claims it says it proves.

## Use When

- A PR, ticket, or investigation includes a proposed validation recipe
- Evidence exists but the proof strength is unclear
- A reviewer needs to know whether the recipe fakes state, skips important assertions, or relies on screenshots when state proof is stronger

## Review Checklist

1. Identify the source claims and acceptance criteria.
2. Map each recipe node to the claim it proves.
3. Check that setup, actions, assertions, and teardown are explicit.
4. Verify that evidence is produced by the real user or system path, not injected state.
5. Flag unresolved claims instead of stretching the recipe to cover them.
6. Recommend the smallest recipe delta that would make weak proof reviewable.

## Hard Rules

- Do not accept hidden UI or store mutation as proof of a user flow.
- Do not mark visual claims as proven without visual evidence or an explicit non-visual contract.
- Do not mark state claims as proven by screenshots alone when structured state proof is available.
- Do not require Farmslot Gateway, Command Center, pool files, or slots for a first-pass quality review.

## Output

Return:

- verdict: `pass`, `warn`, or `fail`
- strongest covered claims
- weak or missing claims
- evidence gaps
- concrete recipe delta
