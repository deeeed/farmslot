# Recipe composition quality

The canonical contract is [Recipe Protocol v1](recipe-protocol-v1.md). This guide covers authoring judgment.

## Use the smallest useful layer

- Use an **action** for one atomic runner capability.
- Use a **recipe** for a deterministic graph that proves an outcome.
- Call another recipe when it removes repeated discovery or enforces a shared safety invariant.

Do not add a reusable recipe for a one-line action invocation. Do not add an action when existing actions can express the behavior clearly.

## Start with discovery

```bash
farmslot-recipe run --list --adapter mobile
farmslot-recipe run wallet.smoke --describe --adapter mobile
```

Then inspect the runner's action manifest. Call the closest recipe when its graph fits. Copy it only when the workflow itself must change, then edit only what the acceptance criteria require.

## Prefer parameters over variants

One well-named recipe with typed parameters is easier to discover than many near-duplicates.

Good:

```text
perps.ensure_market market=ETH positions=none
perps.ensure_market market=BTC positions=present
```

Avoid separate ids for each market, account, or expected state unless their graphs actually differ.

Defaults should make the common safe case runnable with no arguments. Mutation defaults should target an isolated test environment. Required parameters should represent choices that cannot be made safely.

## Compose by contract

A called recipe should:

- have a focused outcome stated in `description`;
- validate its own parameters;
- converge idempotently when named `ensure_*`;
- prove its final state with normal read/assert nodes;
- leave task-specific assertions in the parent recipe;
- avoid hidden environment assumptions.

The parent passes only the values that differ from the dependency defaults:

```json
{
  "action": "call",
  "ref": "wallet.ensure_unlocked",
  "params": { "account": "dev1" },
  "intent": "Prepare the proof account",
  "next": "verify"
}
```

For a task recipe at `artifacts/recipe.json`, keep task-only dependencies in the sibling `artifacts/recipe-library/`; runners discover it automatically. Promote recipes to a shared library only after reuse is proven.

## Keep proof readable

Each node intent should explain the current human-visible goal, not repeat the action name, selector, or node id. Use setup for preparation, proof nodes for the claim, and teardown only when cleanup is part of the contract.

Prefer state/log assertions for non-visual claims. For visual claims, wait for the claimed target and inspect the captured image. One artifact should map clearly to one proof target.

## Library review checklist

- The id follows the `recipes/` path and is easy to guess.
- Title, description, parameters, defaults, and enums are sufficient for `--describe`.
- Generic and adapter-specific files do not duplicate the same graph unnecessarily.
- Calls resolve statically and the graph is acyclic.
- The recipe is safe with defaults and explicit about mutations.
- The same recipe runs directly and as a nested call.
- A passing run emits exact dependency evidence in `recipe-resolution.json`.

If a recipe does not reduce inference, improve safety, or encode a reusable proof contract, keep it task-local.
