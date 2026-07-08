# Recipe Composition and Quality Contract v1

> This document is quality guidance for authoring and reviewing Recipe Protocol v1 recipes. The canonical protocol source of truth is [Recipe Protocol v1](recipe-protocol-v1.md).

## Purpose

Recipe v1 is not only a flat automation format. It is a small, composable validation program that turns acceptance criteria into proof with the least possible user-visible noise. The core model is still a directed graph: recipes branch, call reusable subgraphs, assert state, collect evidence, and finish as one traceable execution package.

The default stays simple: a valid v1 recipe can be a single `validate.workflow.entry` plus `nodes` graph. Composition is additive. Use it when a recipe needs reusable setup, a declared domain starting state, or focused proof-window evidence.

## Normative v1 composition fields

The fields below are Recipe Protocol v1 schema, not only skill guidance:

| Field          | Scope                     | Purpose                                                           | Required by default?                                |
| -------------- | ------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| `uses`         | recipe                    | Flow catalog refs the recipe may call.                            | No                                                  |
| `proofTargets` | recipe                    | AC/proof claims that proof/assert/evidence nodes map to.          | No, but required for production AC proof recipes    |
| `startState`   | recipe                    | Optional named flow call that converges the project before proof. | No                                                  |
| `call`         | node action               | Canonical official action for invoking a cataloged flow by `ref`. | Only when composing flows                           |
| `phase`        | setup item, node, or flow | `setup`, `start_state`, `proof`, `assert`, or `teardown`.         | Defaults by location/action                         |
| `proofTarget`  | node/artifact             | Maps proof/assert/evidence to `proofTargets[].id`.                | Required for production proof/assert/evidence nodes |
| `record`       | node/flow                 | `none`, `trace_only`, `proof_window`, or `failure_only`.          | Phase-defaulted                                     |

Existing flat v1 recipes remain valid. They simply do not use the composition fields.

## Good recipe end state

A production-quality recipe should have these properties:

1. **Each acceptance criterion maps to a proof flow.** The final recipe can bundle multiple proof flows, but each claim stays small and reviewable.
2. **Setup is named, parameterized, and reusable.** Wallet import, unlock, network/provider selection, navigation, cleanup, and fixture creation should not be rewritten inline in every recipe.
3. **The recipe declares a domain starting state when proof depends on hidden state.** The proof begins from an explicit contract such as `example.trade.ensure_positions({ state })`.
4. **The visual path is minimal.** Record the user interactions that prove the claim, not every setup step needed to reach the screen.
5. **Assertions come before evidence.** Screenshots and video segments are captured after the recipe proves the UI is on the intended settled state.
6. **Trace remains complete.** Setup can be excluded from the main proof video, but it still appears in trace/summary artifacts.
7. **No mid-recipe state fabrication.** Start-state setup may seed fixtures or prepare app launch state. The proof flow must drive real user/app behavior through runner actions.

## Composition model

Think of recipe authoring like normal programming over a graph:

- small parameterized functions/subgraphs are easier to review than one large graph or many duplicate variants;
- repeated setup becomes a reusable helper subgraph;
- each acceptance criterion gets its own focused proof subgraph;
- branches remain explicit through graph transitions;
- the final executable recipe imports/calls those subgraphs as one graph execution.

Recipe v1 distinguishes these layers:

| Layer                  | Purpose                                                 | Example                                                                                                                             |
| ---------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Fixture setup**      | Prepare deterministic app data before the proof window. | import wallet, set feature flags, fund account                                                                                      |
| **Ensure setup flows** | Idempotently converge prerequisites.                    | `example.wallet.ensure_unlocked()`, `example.trade.start_state({ network: "testnet", provider: "hyperliquid", page: "positions" })` |
| **Domain start state** | Put the app at a named baseline.                        | `example.trade.ensure_positions({ network: "testnet", market: "BTC", state: "none" })`                                              |
| **Proof flow**         | Execute the smallest visible path that proves one AC.   | open close modal, submit close, verify position disappears                                                                          |
| **Eval/assertion**     | Prove the claim with UI-first checks.                   | `example.trade.assert_positions({ market: "BTC", state: "none" })`                                                                  |
| **Teardown**           | Return shared environments to safe state.               | close created position if proof failed after open                                                                                   |
| **Final recipe graph** | Bundle setup + one or more proof flows + teardown.      | PAY-3215 full validation recipe                                                                                                     |

## Flow catalog schema

A flow catalog is a runner/domain-owned JSON document referenced by `uses`. It makes reusable flows discoverable and machine-checkable.

Illustrative flow declaration; the canonical schema is in `reference/recipe-protocol-v1.md`:

```json
{
  "$schema": "https://farmslot.io/schemas/recipe-v1.schema.json",
  "schema_version": 1,
  "kind": "recipe-flow-catalog",
  "owner": "example.trade",
  "flows": {
    "example.trade.start_state": {
      "version": 1,
      "description": "Converge Perps to a requested network/provider/page/market/position baseline.",
      "paramsSchema": { "type": "object", "required": ["network", "provider", "page"] },
      "outputsSchema": { "type": "object" },
      "defaultPhase": "start_state",
      "defaultRecord": "trace_only",
      "requiresActions": ["example.wallet.ensure_unlocked", "example.trade.navigate"],
      "postcondition": {
        "all": [
          { "path": "$.network", "operator": "eq", "param": "network" },
          { "path": "$.provider", "operator": "eq", "param": "provider" },
          { "path": "$.page", "operator": "eq", "param": "page" }
        ]
      },
      "workflow": {
        "entry": "ensure-wallet",
        "nodes": {}
      }
    }
  }
}
```

A v1 validator should fail unresolved flow refs, missing catalogs, invalid params, recursive/cyclic calls beyond the configured depth, output namespace collisions, and `ensure_*` flows that do not declare a postcondition.

## Ensure setup flows

Setup should be expressed as **idempotent `ensure_*` flows**. An ensure flow is different from a raw action:

- it may inspect current state first;
- it only performs the transitions needed to reach the requested state;
- it has typed parameters and explicit postconditions;
- it fails if the postcondition cannot be proved;
- it is safe to call from many recipes without duplicating setup logic.

For Example App this means recipe authors should not inline “unlock wallet, navigate to Perps, select provider, choose testnet/mainnet” in every recipe. They request a start-state contract:

```json
{
  "uses": ["example-app/wallet.flows.json", "example-app/perps.flows.json"],
  "startState": {
    "action": "call",
    "ref": "example.trade.start_state",
    "phase": "start_state",
    "record": "trace_only",
    "params": {
      "network": "testnet",
      "provider": "hyperliquid",
      "page": "positions",
      "market": "BTC",
      "position": "none"
    }
  }
}
```

`example.trade.start_state` is a domain convergence point, not an opaque script. It should compose smaller contracts such as wallet unlocked, network selected, provider selected, market selected, page reached, and position precondition proved. Presets may be documented as examples, but the reusable catalog should prefer parameterized contracts such as `example.trade.ensure_positions({ state, market, side?, notional? })`.

| Parameter  | Meaning                                                 | Examples                                                                         |
| ---------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `network`  | Trading network/mode for the Perps provider.            | `mainnet`, `testnet`                                                             |
| `provider` | Perps provider when the product supports more than one. | `hyperliquid`                                                                    |
| `page`     | Starting Perps screen for the proof flow.               | `home`, `markets`, `market_detail`, `positions`, `trade_form`                    |
| `market`   | Optional selected market.                               | `BTC`, `ETH`                                                                     |
| `position` | Optional position precondition.                         | `none`, `{ "state": "open", "market": "BTC", "side": "long", "notional": "10" }` |

Each team can publish the same kind of domain start-state catalog. A backend team might expose `orders.ensure_seeded`; a CLI team might expose `cli.ensure_logged_in`; a web team might expose `checkout.ensure_cart`. Farmslot owns composition/trace/evidence mechanics; teams own domain-specific ensure flows and defaults.

## Recipe bundle shape

This is the normative v1 composition shape. `call`, `uses`, `startState`, `proofTargets`, `phase`, `proofTarget`, and `record` are protocol schema, not skill convention.

```json
{
  "schema_version": 1,
  "title": "PAY-3215 close position proof",
  "description": "Proves the user can close an existing BTC Perps position.",
  "uses": ["example-app/wallet.flows.json", "example-app/perps.flows.json"],
  "proofTargets": [
    {
      "id": "AC1",
      "claim": "The user can close an existing BTC Perps position from the position card."
    }
  ],
  "startState": {
    "action": "call",
    "ref": "example.trade.ensure_positions",
    "phase": "start_state",
    "record": "trace_only",
    "params": {
      "network": "testnet",
      "market": "BTC",
      "state": "open",
      "side": "long",
      "notional": "10"
    }
  },
  "validate": {
    "workflow": {
      "entry": "AC1-close-position",
      "nodes": {
        "AC1-close-position": {
          "action": "call",
          "ref": "example.trade.close_positions",
          "params": { "market": "BTC" },
          "phase": "proof",
          "proofTarget": "AC1",
          "record": "proof_window",
          "next": "AC1-assert-closed"
        },
        "AC1-assert-closed": {
          "action": "example.trade.assert_positions",
          "market": "BTC",
          "state": "none",
          "phase": "assert",
          "proofTarget": "AC1",
          "next": "AC1-screenshot"
        },
        "AC1-screenshot": {
          "action": "ui.screenshot",
          "path": "screenshots/AC1-position-closed.png",
          "phase": "assert",
          "proofTarget": "AC1",
          "next": "done"
        },
        "done": { "action": "end", "status": "pass" }
      }
    }
  }
}
```

The runner should emit nested trace entries showing the start-state flow, its params, outputs, child node path, artifacts, and postcondition result. Reviewers see a concise proof story while trace remains complete.

## Duplicate flow avoidance

A good domain catalog is small. Do not add separate flows for every polarity or route when parameters express the same concept. For Perps, prefer contracts like `ensure_positions({ state: "none" | "open", market, side?, notional? })` and `assert_positions({ state, market, side? })` over separate `ensure_no_position`, `ensure_long_position`, `assert_position`, and `assert_no_position` families unless the alias materially improves safety.

Recipe-quality review should flag domain catalogs or recipes that grow duplicate flow names instead of reusing a parameterized contract.

## Evidence and recording phases

Every node or flow belongs to one phase. `record` controls evidence media capture; trace is always captured.

| Phase         | Default `record` | Purpose                                        |
| ------------- | ---------------- | ---------------------------------------------- |
| `setup`       | `trace_only`     | Deterministic preparation.                     |
| `start_state` | `trace_only`     | Move from raw app to declared domain baseline. |
| `proof`       | `proof_window`   | User-visible interactions proving the AC.      |
| `assert`      | `trace_only`     | Confirm settled UI state before evidence.      |
| `teardown`    | `trace_only`     | Clean shared state.                            |

Supported `record` values:

- `none` — no media or extra evidence beyond trace;
- `trace_only` — trace/summary/artifact metadata only;
- `proof_window` — capture proof-window media for this node/flow;
- `failure_only` — capture extra evidence only when the node/flow fails.

A recipe can use `record: "proof_window"` on setup only when setup itself is the feature under test.

### HUD / overlay quality checks

For UI proof, a HUD/overlay is useful when it makes the proof readable to a reviewer. It should annotate intent and proof target, not become another assertion mechanism.

Check that:

- HUD text is human-readable and maps to the current `proofTarget`;
- overlay content does not hide the UI state or element being proved;
- a raw/non-obscured screenshot or video exists when the overlay could cover the claim;
- recipes do not add task-specific overlay styling/actions as reusable project capabilities;
- setup remains mostly trace-only unless the setup UI itself is the claim.

## Trace and output semantics

A composed trace entry should include enough structure for validation and review:

- parent node id / flow call id;
- child node path such as `AC1-close-position/place-confirm`;
- flow ref and version;
- redacted params;
- phase and record policy;
- namespaced outputs under the call id;
- artifacts produced by each child;
- postcondition result for `ensure_*` flows;
- `failure_kind` (`setup`, `environment`, `fixture`, `product`, `assertion`, or `unknown`) and summary rollup.

A caller references flow outputs through the call node namespace. The validator should reject collisions or references to missing outputs.

## Quality checklist

Use this checklist before calling a recipe production-ready:

- **AC coverage:** every AC has a proof target and at least one assertion/evidence artifact.
- **Start-state contract:** hidden wallet/account/network/provider/page assumptions are explicit, preferably through idempotent `ensure_*` flows.
- **Composability:** repeated setup/navigation/cleanup is a reusable flow, not inline duplicated nodes.
- **Domain ownership:** project/domain flows live with the owning runner/domain, not in task-specific skill glue.
- **Minimal visual intent:** the proof window contains only the interactions needed to understand the claim.
- **UI-first proof:** prefer visible UI assertions and screenshots over backend probes unless backend behavior is the claim.
- **Flake resistance:** waits are tied to settled UI or domain assertions, not arbitrary sleeps.
- **Failure debuggability:** trace includes setup outputs, flow boundaries, screenshots on failure, and enough context to reproduce.
- **No hidden mutation:** the proof path does not write directly into UI/app state to manufacture the result.

## Implementation implication for Recipe v1

Action execution and manifest discoverability are necessary but not sufficient for production-quality recipes. The next quality step is to implement composition/start-state semantics in Recipe Protocol v1 before large project-specific flow catalogs are built.

Implementation work should now follow the canonical spec:

1. update protocol docs/types/tests from `reference/recipe-protocol-v1.md`;
2. implement `call` flow semantics, flow catalog validation, parameter binding, output namespacing, and nested trace;
3. implement `phase`, `proofTarget`, `record`, and artifact manifest validation;
4. migrate Mobile/Extension Perps concepts into parameterized Example App-owned `ensure_*` and proof-flow catalogs;
5. update recipe-cook and recipe-quality skills to enforce the protocol contract.
