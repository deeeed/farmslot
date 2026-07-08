# Recipe UI Passive Observations Plan

**Status:** Proposed supporting plan
**Canonical support:** [ROADMAP-next.md](../ROADMAP-next.md) item 3, "Use shipped Recipe Protocol v1 as the evidence substrate"
**Scope:** UI-only passive observations for Recipe v1 runners
**Non-goal:** Redux/store observers, provider abstraction, or new control-flow semantics

## Problem

When an agent writes or debugs a recipe node-by-node, each `ui.*` action currently
returns action-specific output but not a normalized answer to: "what can I do
next on this screen?" The agent often has to ask for a separate screenshot,
manual probe, or project-specific state read before authoring the next node.

The missing capability is a cheap, passive, post-action UI digest that shows the
current screen and visible actionable targets without changing recipe execution.

## Design principle

`observe` is passive context only.

It must not:

- choose `next`;
- set `status`;
- set `case`;
- replace `ui.wait_for`, `assert`, `switch`, or terminal `end` nodes;
- turn a successful action into a failed action by default.

Assertions and graph nodes remain the only source of proof/control flow. Passive
observations help an authoring agent decide what node to write next, and help a
reviewer/debugger understand what happened.

## User outcome

A recipe-authoring agent can run or inspect a node, read the latest passive UI
observation, and author the next portable node from stable handles such as
`test_id`, label, role, and route.

Example authoring loop:

1. Agent authors a node:

   ```json
   {
     "action": "ui.press",
     "intent": "Open the Perps market list",
     "test_id": "perps-tab",
     "next": "select-btc"
   }
   ```

2. Runner executes it and records passive observations:

   ```json
   {
     "ui.screen": { "name": "PerpsMarketListView" },
     "ui.visible": {
       "items": [
         {
           "role": "button",
           "label": "BTC",
           "test_id": "perps-market-row-BTC"
         },
         {
           "role": "button",
           "label": "ETH",
           "test_id": "perps-market-row-ETH"
         }
       ],
       "hidden_or_offscreen": [{ "test_id": "perps-market-row-SOL", "reason": "below viewport" }]
     }
   }
   ```

3. Agent authors the next node from the stable target:

   ```json
   {
     "action": "ui.press",
     "intent": "Select the BTC market row",
     "test_id": "perps-market-row-BTC",
     "next": "open-btc-market"
   }
   ```

## Recipe authoring field

Add an additive Recipe v1 node field:

```ts
type ObservePolicy = boolean | UiObserverRef[];
type UiObserverRef = 'ui.screen' | 'ui.visible' | 'ui.focus';
```

Examples:

```json
{ "action": "ui.press", "test_id": "confirm", "observe": true }
```

```json
{ "action": "ui.press", "test_id": "confirm", "observe": false }
```

```json
{ "action": "ui.press", "test_id": "confirm", "observe": ["ui.visible"] }
```

Default policy:

- `ui.navigate`, `ui.press`, `ui.key_press`, `ui.set_input`, `ui.scroll`, and
  `ui.gesture`: default to `observe: true`.
- `ui.wait_for`: default to `observe: true` after a successful wait, because it
  often establishes the next authoring surface.
- `ui.screenshot`: default to `observe: false`; it is already an explicit
  evidence action. Authors may opt in.
- Non-UI actions: default to `observe: false`.

## Observation output shape

Add a trace-level field, separate from action `output`:

```json
{
  "nodeId": "open-perps",
  "action": "ui.press",
  "ok": true,
  "output": { "ok": true },
  "observations": {
    "ui.screen": {
      "provider": "expo-bridge",
      "name": "PerpsMarketListView",
      "route": "PerpsMarkets"
    },
    "ui.visible": {
      "provider": "expo-bridge",
      "items": [],
      "hidden_or_offscreen": [],
      "truncated": false
    }
  },
  "observationWarnings": []
}
```

Keeping observations separate from `output` preserves the responsibility
boundary: observations are not implicitly available as graph control data. If a
recipe must prove a condition, it should author a follow-up `ui.wait_for`,
`assert_*`, or project-specific assertion node.

A future explicit promotion mechanism can be considered later, but the MVP keeps
observations trace/debug-only.

## UI observer contracts

### `ui.screen`

Purpose: describe the current human/app surface.

Fields:

- `provider`: runner/provider name;
- `name`: best screen/view name;
- `route`: optional route id;
- `title`: optional visible title;
- `url`: optional for browser/extension surfaces.

### `ui.visible`

Purpose: give an agent enough compact structure to choose the next UI node.

Fields:

- `provider`;
- `items`: ordered visible actionable targets;
- `hidden_or_offscreen`: bounded summary of relevant hidden/offscreen targets;
- `truncated`: true when item limits were applied;
- `hints`: optional authoring hints.

Item fields:

- `role` / `type`;
- `label` / `text` / `value`;
- `test_id` / `selector` when available;
- `enabled`, `selected`, `focused` when cheap;
- optional `ref` only when the runner supports immediate ref targeting.

Generated refs are not durable recipe source. Authoring agents should prefer
stable handles such as `test_id`, `selector`, label, and role when writing the
next recipe node.

### `ui.focus`

Purpose: expose current focus/keyboard context after input actions.

Fields:

- focused target label/test id when known;
- keyboard/input state when cheap;
- warnings when focus cannot be determined.

`ui.focus` is optional in the MVP and can ship after `ui.screen` + `ui.visible`.

## Manifest registration

Add an additive action-manifest field:

```json
{
  "observers": [
    {
      "ref": "ui.screen",
      "description": "Current screen/route digest after UI actions.",
      "default_for": ["ui.navigate", "ui.press", "ui.wait_for"],
      "cost": "cheap",
      "redaction": "none"
    },
    {
      "ref": "ui.visible",
      "description": "Visible actionable UI digest for next-node authoring.",
      "default_for": ["ui.*"],
      "cost": "cheap",
      "redaction": "labels-only"
    }
  ]
}
```

This is discovery metadata for authors and runners. The first implementation can
also support built-in observer refs without requiring every manifest to declare
them, but manifests should advertise project-specific availability and limits.

## Trace and size policy

- Observations are stored in `trace.json`, not as standalone artifacts by default.
- `ui.visible.items` should be token-bounded; start with a default cap such as
  20 visible items and 10 hidden/offscreen summaries.
- Observation payloads must omit secrets and private input values by default.
- Large/raw trees should be artifacts only if a runner explicitly adds a debug
  mode later.
- Observation failures are recorded as `observationWarnings` and do not fail the
  node unless a future strict mode is explicitly requested.

## Runner implementation plan

### Phase 1 — protocol/docs contract

- Document `observe` in Recipe Protocol v1 as an additive node field.
- Document `observers` in the action manifest reference.
- Add TypeScript protocol types for observer declarations.
- Add validation for observer declarations and valid built-in observer refs.
- Keep node-level `observe` permissive at first to preserve runner-owned action
  fields.

### Phase 2 — harness observation middleware

- Extend `ActionResult` / `TraceEntry` with optional `observations` and
  `observationWarnings`.
- Add a small observer runner in `@farmslot/recipe-harness` that runs after a
  successful node when policy resolves to enabled.
- Ensure observer results never mutate `status`, `next`, `case`, or artifacts.
- Make observer failures warning-only.

### Phase 3 — Expo bridge observer implementation

- Add a bridge command such as `discoverUi` or `observeUi`.
- Implement `ui.screen` with route/screen/title when available.
- Implement `ui.visible` with React Native/testID/fiber/HUD-safe data.
- Return visible/actionable items first, then a bounded hidden/offscreen summary.

### Phase 4 — authoring UX consumption

- Render latest observations in recipe run trace/detail surfaces.
- In recipe-authoring prompts/templates, tell agents to use latest
  `ui.visible.items` to choose the next node target.
- Add recipe-quality guidance: observations can inform node authoring, but proof
  still requires `ui.wait_for`, assertions, screenshots, or explicit evidence.

### Phase 5 — optional stricter future work

Only after the MVP proves useful:

- agent-device-backed observer for native accessibility proof;
- strict observation mode for proof-window nodes;
- durable ref support if Farmslot wants `@ref`-style next actions;
- explicit promotion of an observation into assertion input.

## Acceptance criteria

- A `ui.press` node with no `observe` field records `ui.screen` and `ui.visible`
  observations by default.
- `observe: false` records no observations.
- `observe: ["ui.visible"]` records only the visible UI observer.
- Observation failure records a warning and does not fail the node.
- Observations never alter `next`, `status`, `case`, or branch selection.
- A recipe authoring agent can read the latest `ui.visible.items` and author the
  next node using stable `test_id`/selector/label handles.
- Trace payloads stay bounded and public-safe.

## Open questions

1. Should `ui.wait_for` default observation include the matched target first?
2. Should `ui.screenshot` opt-in observations share screenshot overlay refs later?
3. Should `observe` be allowed on non-UI actions as a no-op, or should validators
   warn when it is used outside `ui.*`?
4. What is the first target app for live validation: Farmslot Companion demo app,
   example mobile app, or MetaMask Mobile harness?
