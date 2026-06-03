---
title: Recipe composition quality
---

# Recipe Composition Quality

Recipe Protocol v1 is a graph model, not just a linear automation script. Good
recipes compose reusable setup, focused proof flows, assertions, and teardown so
reviewers see the smallest useful proof while trace keeps the full story.

For the field-level schema, see [Recipe Protocol v1](./recipe-protocol-v1.md).

## Good recipe end state

A production-quality recipe should:

1. map each acceptance criterion to an explicit proof target;
2. use named setup/start-state flows instead of repeating boilerplate;
3. begin proof from a declared domain baseline;
4. record the smallest user-visible path that proves the claim;
5. assert state before capturing evidence;
6. keep setup in trace even when it is outside the proof video;
7. avoid mid-recipe state mutation that fabricates proof.

## Composition fields

| Field          | Scope         | Purpose                                                   |
| -------------- | ------------- | --------------------------------------------------------- |
| `uses`         | recipe        | Flow catalogs the recipe can call.                        |
| `proofTargets` | recipe        | Claims or acceptance criteria proven by the recipe.       |
| `startState`   | recipe        | Optional pre-proof `call` that converges baseline state.  |
| `call`         | node action   | Official action for invoking a reusable flow.             |
| `phase`        | node/flow     | `setup`, `start_state`, `proof`, `assert`, or `teardown`. |
| `proofTarget`  | node/artifact | Maps proof, assertion, or evidence to a claim.            |
| `record`       | node/flow     | `none`, `trace_only`, `proof_window`, or `failure_only`.  |

Flat recipes remain valid. Composition is additive: use it when reuse, branching,
or focused proof windows make the result easier to maintain.

## Start-state and ensure flows

Setup should be idempotent. A domain should expose one parameterized convergence
flow instead of many near-duplicate variants.

```json
{
  "startState": {
    "action": "call",
    "ref": "checkout.ensure_cart",
    "phase": "start_state",
    "record": "trace_only",
    "params": {
      "items": [{ "sku": "test-shirt", "quantity": 1 }],
      "user": "returning"
    }
  }
}
```

An `ensure_*` flow should:

- inspect current state when possible;
- perform only the transitions needed to reach the requested state;
- expose typed parameters;
- declare a postcondition;
- fail if the postcondition cannot be proved.

## Parameterize before multiplying

Prefer one flexible flow:

```json
{ "ref": "perps.ensure_positions", "params": { "state": "open", "market": "BTC" } }
```

Avoid growing many aliases with the same implementation:

```text
ensure_no_position
ensure_long_position
ensure_short_position
assert_no_position
assert_position
```

Aliases are acceptable only when they materially improve safety or readability.
Otherwise they make action discovery harder for agents and reviewers.

## Proof versus setup

Use domain actions for convergence and `ui.*` actions for reviewer-visible proof:

| Phase         | Preferred action style                | Evidence policy                  |
| ------------- | ------------------------------------- | -------------------------------- |
| `setup`       | domain/fixture/core actions           | `trace_only`                     |
| `start_state` | parameterized `ensure_*` flows        | `trace_only`                     |
| `proof`       | user-visible `ui.*` actions           | `proof_window`                   |
| `assert`      | typed domain assertions + screenshots | `proof_window` or `failure_only` |
| `teardown`    | safe cleanup flows                    | `trace_only`                     |

Do not write a custom action for one temporary task assertion. Put the assertion
in the recipe, or add a reusable parameterized domain action if many recipes need
that capability.

## HUD quality

For UI projects, `app.hud` communicates what the agent is doing to the human
watching the run. It should be concise:

- one short intent line by default;
- optional second line only for parent-flow/subflow context;
- no default node ids, action names, or debug labels;
- no duplicate title/detail text;
- no overlay that hides the UI state being proved;
- full diagnostics belong in `trace.json`, not in the HUD.

A good HUD answers: "what is the agent trying to prove right now?"
