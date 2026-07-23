---
title: Recipe composition quality
description: How to compose small, discoverable, deterministic Recipe v1 graphs.
---

# Recipe composition quality

The canonical contract is [Recipe Protocol v1](./recipe-protocol-v1.md).

Use an **action** for one atomic capability and a **recipe** for a deterministic graph that proves an outcome. Call another recipe only when reuse removes repeated discovery or enforces a shared safety invariant.

## Authoring loop

1. Discover the closest recipe with `run --list` and `run <id> --describe`.
2. Inspect declared actions only when no recipe fits.
3. Call it when its graph fits. Copy it only when the workflow itself must change, then edit only what the acceptance criteria require.
4. Prefer one parameterized recipe over many near-duplicates.
5. Run the recipe directly and as a nested call.

Task recipes can compose from a sibling `recipe-library/` without extra flags. Promote a recipe only after reuse is proven.

Defaults should make the common safe case runnable with no arguments. Required parameters should represent choices that cannot be made safely.

A called recipe should have a focused description, validate its own parameters, converge idempotently when named `ensure_*`, prove its final state with normal read/assert nodes, and avoid hidden environment assumptions.

Each node intent explains the current human-visible goal, not the action name, selector, or node id. Use state/log assertions for non-visual claims and inspected screenshots for visual claims.

Before sharing a recipe, verify that its id is easy to guess, `--describe` explains its parameters/defaults, its static call graph is acyclic, defaults are safe, and passing evidence includes exact dependency documents plus `recipe-resolution.json`.

If reuse does not reduce inference, improve safety, or encode a durable proof contract, keep the recipe task-local.
