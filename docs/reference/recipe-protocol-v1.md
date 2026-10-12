# Recipe Protocol v1

Recipe Protocol v1 has two public concepts:

- **action** — one atomic capability implemented by a runner;
- **recipe** — one parameterized executable graph that can run directly or be called by another recipe.

The authoritative schema is `https://farmslot.io/schemas/recipe-v1.schema.json`.

The owning decision is [ADR-034](../adr/034-recipe-protocol-v1.md). Its accepted
amendments cover the bounded HUD policy, implemented in
[#944](https://github.com/deeeed/farmslot/pull/944), and bounded log observations,
implemented in [#969](https://github.com/deeeed/farmslot/pull/969).

## Minimal recipe

```json
{
  "$schema": "https://farmslot.io/schemas/recipe-v1.schema.json",
  "description": "Prove that the service is healthy.",
  "workflow": {
    "entry": "status",
    "nodes": {
      "status": {
        "action": "command",
        "cmd": "curl --fail http://127.0.0.1:3000/health",
        "intent": "Confirm the local service is healthy.",
        "next": "done"
      },
      "done": { "action": "end", "status": "pass" }
    }
  }
}
```

Required root fields are `$schema` and `workflow`. Optional root fields are `title`, `description`, `paramsSchema`, and `proofTargets`. Unknown fields are errors.

## Workflow

`workflow` contains:

- `entry` — first main-graph node;
- `nodes` — every executable node;
- `teardown` — optional cleanup-graph entry that runs after main success or failure.

Every non-terminal node requires:

- `action`;
- `intent` — one short sentence describing the human-visible goal;
- exactly `next`, or `cases` together with `default`.

`call` always uses `next`; result-based branching belongs to other actions with declared cases.

An action may return a declared `case`; the recipe maps that case to the next node:

```json
{
  "action": "switch",
  "value": "{{params.mode}}",
  "equals": "strict",
  "intent": "Choose the requested execution mode.",
  "cases": { "match": "ready" },
  "default": "not-ready"
}
```

Actions return observations and outputs, never graph destinations or final recipe status. `end.status` is `pass`, `fail`, or `unknown`.

The main and teardown graphs are acyclic, reachable, and disjoint. Bounded polling or repetition belongs inside an action. Setup is not a separate protocol phase: place preparation actions or recipe calls at the start of the main graph. Teardown is separate because the runner guarantees it after success or failure.

### Intent

`intent` is shown in HUD and trace evidence. It explains why the step matters to a human, not how the adapter implements it.

Write one plain sentence. Validation warns above 80 Unicode code points and fails
above 120, counted after trimming surrounding whitespace. These checks apply to authoring lint/conformance validation. Warnings are
nonfatal; errors fail validation. Execution and retained-artifact verification
keep their existing v1 behavior, so old recorded evidence remains readable.
One plain sentence is authoring guidance, not a new grammar parser. Existing intent checks also reject action names,
selectors and other implementation-only copy.

HUDs preserve the full intent until platform layout wraps it, show at most two
lines, and use a trailing ellipsis only when more than two lines would be needed.
The shared intent display policy limits native panels to 360 by 88 logical pixels
and DOM cards to 360 by 144 CSS pixels, further bounded by the viewport.
CDP bottom-bar and docked-bottom modes have fixed maximums of 960 by 144 CSS
pixels while retaining their existing position/space-reservation behavior. Auxiliary
HUD copy cannot enlarge the panel across the application.

Display whitespace MUST be normalized without shortening the authored intent.
Renderers MUST NOT slice it by character count. Native HUD text has fixed font
scaling; mandatory line, width and height limits MUST apply after custom styling.
Existing HUD isolation, pointer pass-through, status/progress and placement modes
remain supported. The automatic runner HUD passes the complete normalized intent
to adapters.

`app.hud` accepts `display.position: "top" | "bottom"`. Every adapter MUST honor
the selected edge and clear the opposite anchor. Native renderers use the same
vertical edge for existing corner values and respect the host's safe-area
insets. Omitted placement retains the adapter's existing default. The selection
MUST persist through subsequent automatic progress, screenshot repaint and the
final outcome of that execution; a new execution starts with its configured
default. HUD evidence remains required at either edge. Custom harnesses MUST
forward this setting to the shared renderer rather than provide another one.
HUD acknowledgement MUST wait for the updated caption to paint before a
subsequent capture or recorder stop. The shared `waitForHudPaint` helper uses
render frames, not a fixed sleep; this adds no clock or timing-precision contract.
Native bridge providers MUST await the committed state through shared
`useRecipeHudState`, exported from `@farmslot/adapter-rn/recipe-hud`, before
acknowledging the command. Companion and scaffold providers are its consumers.

SDK callers configure existing `RecipeHudOptions.display.position`; recipe
authors use the existing `app.hud` action. `hudPlacement` and its
`RecipeHudPlacement` return type are additive exports from
`@farmslot/protocol/recipe`, consumed by the native bridge and web adapter. Verify
both placements on real native/web targets, preservation through capture and
completion, and reset on a second execution. No additional CLI flag is needed.

#### Public surface

The existing `farmslot recipe validate` and recipe conformance path emit these
findings; there are no new CLI flags. The additive `@farmslot/protocol/recipe`
display helper and policy constants are consumed by Companion's shared native
HUD, the web adapter and the runner CDP HUD. Native projects consume the shared
renderer through `@farmslot/adapter-rn/recipe-hud`; CLI consumers need no native
runtime. Harnesses such as mm-harness inherit this policy through the runner and
adapter, retaining `app.hud` as the extension point. Custom app-owned renderers
must adopt the shared helper explicitly. Existing copied HUDs can adopt the
shared native export through a deliberate scaffold update; no farm files are
overwritten by this change. Recipe schema version stays v1.

Companion and scaffold templates re-export the same native HUD component. Preserve
`RecipeHudOptions`, including text/style overrides and custom `renderHud` callbacks.
Companion supplies its installed iOS FullWindowOverlay through
`RecipeHudOptions.overlay`; the scaffold has no screens dependency. Companion
uses `RecipeHudProps.onLayout` for safe-area footer placement when the measured
panel fits, otherwise placing it above the default tab controls. Custom callbacks
MUST consume the shared helper to conform. Native peers remain optional for CLI
consumers.

Framework examples and validation recipes adopt the 120-character authoring
limit; farm recipes MUST NOT be rewritten by this correction. Verification covers
full intent preservation, Unicode/whitespace, two-line ellipsis, panel bounds and
80/81/120/121 boundaries, plus real native/web screenshots with the app visible and
existing HUD isolation/lifecycle checks. This bounded policy alone does not
establish complete [recorded-evidence conformance](recorded-run-evidence.md#hud-requirements).

For UI actions, prefer `"Open the purchase path for the selected asset."` over `"Press buy"` or a selector name. Selectors, routes, keys, and test IDs stay in action parameters.

## Parameters and outputs

Recipes declare inputs with JSON-Schema-shaped `paramsSchema`. Defaults apply before validation; explicit values win, including `false`, `0`, and empty strings.

```json
{
  "paramsSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "market": { "type": "string", "enum": ["ETH", "BTC"], "default": "ETH" }
    }
  }
}
```

Use `{{params.market}}` for inputs and `{{outputs.nodeId.path}}` for a prior node's output. `[n]` or `.n` indexes an array: `{{outputs.positions.positions[0].size}}`; on an object both read the key `n`. An exact template preserves its value type; an embedded template becomes a string. A `{{params.` or `{{outputs.` that does not parse as a template fails validation (`workflow.invalid_template`) and resolution; it is never passed on as text. Data does not leak between parent and child recipes.

Action parameters are sibling fields on the node. The `params` object is reserved for a `call` boundary.

## Composition

`call` invokes another recipe from the resolved library:

```json
{
  "action": "call",
  "ref": "wallet.ensure_unlocked",
  "params": { "account": "{{params.account}}" },
  "intent": "Prepare the selected wallet account for proof.",
  "next": "proof"
}
```

`ref` is static. `params` is the only parent-to-child input boundary. The child applies its defaults, validates its parameters, runs its own teardown, and returns one output under the call node. Missing recipes, cycles, excessive depth, or invalid child parameters fail before side effects.

## Proof targets

Proof targets make claims explicit without changing execution:

```json
{
  "proofTargets": [
    { "id": "balance-visible", "claim": "The selected account balance is visible." }
  ],
  "workflow": {
    "entry": "capture",
    "nodes": {
      "capture": {
        "action": "ui.screenshot",
        "intent": "Capture the selected account balance.",
        "proves": ["balance-visible"],
        "next": "done"
      },
      "done": { "action": "end", "status": "pass" }
    }
  }
}
```

Every declared target must be covered by at least one node. Every `proves` id must be declared.

## Visual review surfaces

`ui.capture_surface` nodes and explicitly annotated `ui.screenshot` nodes may declare optional
recipe-owned review relationships without changing adapter parameters:

```json
{
  "action": "ui.capture_surface",
  "path": "screens/run-detail.png",
  "intent": "Preserve the complete run detail for visual feedback.",
  "visual_review": {
    "parent": "capture-run-list",
    "navigation": [{ "from": "capture-run-list", "kind": "push" }],
    "related": ["capture-evidence"]
  },
  "next": "done"
}
```

`parent` controls hierarchy; `navigation` records one or more observed incoming paths with
`tab | push | in-place | modal | replace`; and `related` records non-navigation context. All ids
reference visual capture nodes in the same recipe, and parent relationships must be acyclic. Review
renderers use these explicit relationships; they do not infer information architecture from
workflow order. See
[ADR-052](../adr/052-recipe-derived-visual-review-boards.md).

These relationships describe reviewable evidence, not device automation internals. Interactive
accessibility refs, selector discovery, settled UI diffs, alerts, logs, network capture, and
performance diagnostics remain provider/authoring capabilities. A Recipe records only stable
selectors and actions needed to reproduce the proof. Domain harnesses may add semantic navigation
and setup actions, but project routes and screen names are not part of Recipe v1.

## Actions and manifests

The existing `watch_logs` action's optional bounded observation window, run/file
scope and pre-producer offsets are specified in
[Recipe log observations](recipe-log-observations.md). That contract is owned by
[ADR-034 Amendment 2](../adr/034-recipe-protocol-v1.md#amendment-2-2026-10-12-bounded-log-observations).

The protocol owns graph execution, validation, trace, and evidence contracts. Runners own action implementations and platform behavior.

Every action is declared in a runner manifest with a strict parameter schema. Actions with result routing also declare their finite result cases. Project actions use namespaces such as `metamask.wallet.ensure_unlocked`; product behavior does not belong in the official action vocabulary.

Discover before authoring:

```bash
farmslot-recipe run --list --adapter mobile
farmslot-recipe run perps.smoke --describe --adapter mobile
```

Prefer an existing recipe, then an existing action. Add a shared recipe only when reuse removes repeated inference or enforces a safety invariant.

## Libraries

```text
recipes/
  wallet/ensure_unlocked.recipe.json
  extension/perps/smoke.recipe.json
  mobile/perps/smoke.recipe.json
```

Recipe identity comes from its path below `recipes/`. The configured source
alias, or directory name when no alias is provided, identifies provenance.
An initial `core`, `extension`, or `mobile` directory selects an adapter variant
without changing the id. Legacy filename suffixes remain readable during
migration, but a file cannot use both forms and duplicate adapter/id declarations
are rejected. Ordered library sources use first-match precedence; shadows are
reported, duplicates within one source are errors, and symlinks may not escape
the library root. The top-level `core`, `extension`, and `mobile` directory names
below `recipes/` are reserved for adapter selection. Existing generic domains
with one of those names must move to a different top-level domain before
adopting this layout.

## Trust and evidence

Before side effects, the runner resolves the complete call graph and binds approval to recipe and implementation digests, capabilities, environment, project root, and artifact destination.

Every run retains:

```text
recipe.json
recipe-resolution.json
resolved-recipes/<sha256>.recipe.json
summary.json
trace.json
artifact-manifest.json
```

`recipe-resolution.json` is execution provenance, not authored recipe syntax. It records the exact root and dependency digests, selected sources, adapter variants, artifact paths, and call edges. Artifact validation revalidates every recipe and rejects missing, extra, unreachable, or digest-mismatched dependencies.

A retained partial video may carry `interruption` with a nonnegative integer `frames`,
nonnegative `mediaTimeMs`, and a nonempty `cause`. A provider that cannot measure the
retained frame count uses `frames: 0`; that value means unavailable, so reports omit
frame counts and media time rather than presenting zero as a measurement.

### Optional recording timelines

A video artifact may name `timelinePath`, a package-relative JSON file implementing
`RecipeRecordingTimelineDocument` from `@farmslot/protocol`. Recording and timeline
support are optional for every project and runner. A recorder without timing support
keeps its video and may provide `timelineUnavailableReason`; consumers must not invent
timestamps or infer frame rate from `maxFps`.

The timeline contains:

| Field                      | Meaning                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `version`                  | `1`                                                                                                           |
| `videoPath`, `videoDigest` | Package-relative video and `sha256:` digest of its bytes                                                      |
| `traceDigest`              | Canonical recipe digest of the trace entry array, excluding wrapper metadata                                  |
| `framesMs`, `durationMs`   | Increasing measured presentation times and duration on the video's seek clock                                 |
| `clock`                    | `source`, `earliestZeroUnixMs`, `latestZeroUnixMs`: measured bounds for media time zero on the runner's clock |
| `markers`                  | Trace index, namespaced node ID, action, optional intent/proof targets, recorded `ok`, start/end time ranges  |

Each marker's `startRangeMs` and `endRangeMs` are ordered two-number ranges. They
retain clock uncertainty, including negative times and events beyond the footage.
`traceIndex` distinguishes loop visits; the namespaced node ID preserves composed
call paths. Separate video and trace digests distinguish attempts. Markers aid
navigation; they do not establish that a claim passed or that a transient state was
captured. Screenshots and state/log assertions retain their own proof boundaries.

Recorders supply frame times and clock alignment; the recipe runtime derives markers
from the retained execution trace. A continuous real-time recorder can bound media zero
using its observed lifetime and first/last frame presentation times. It must label this
as bounded alignment, not exact first-frame timing. Clock changes, compressed pauses or
invalid frame times make that alignment unavailable. More precise providers may supply
tighter measured bounds. Clients show uncertainty, seek only within recorded footage,
and step using measured frame times. A held final image is not a new observation.
Keep clock calibration uncertainty separate from visual sampling. A marker's midpoint
may fall inside a long held frame from before the action result. Show that frame's
presentation interval rather than implying the clock window measures visual accuracy.

Consumers validate the timeline and its video/trace binding before treating markers
as evidence navigation. Keep frame indexes in their sidecar so agents can consume the
compact trace/summary without loading every frame timestamp. Recipe authors do not
hand-author timestamps, recording clocks or duplicate node markers.

HUD text and navigation labels reuse the executed node's `intent`, `proves`,
namespaced ID and status. The existing `app.hud` adapter renders progress; capture
providers record the selected window and its visible HUD without interpreting it.
Turning off the visible HUD does not remove trace markers. Capture-helper's native
timing sidecar supplies capture facts, including source screenshots that were not
encoded; the recipe runtime adds semantic markers. Neither layer requires agent
narration or a second event system. WebVTT can carry generated portable chapters
when a consumer needs them, but is not the authoritative frame/provenance format.

An active recorder may implement `snapshot(outputPath)`. The shared runtime exposes
this to screenshot actions through `captureRecordingSnapshot`, stages the PNG safely,
and retains its provider event beside the action's evidence. It does not change
document-only `ui.capture_surface` semantics. A screenshot from a native window can
include window chrome or a device mirror; its caption must identify that boundary.

For physical Android, the caller first obtains exclusive device ownership. The
optional Android mirror recorder starts its own non-controlling scrcpy process,
resolves its exact PID and unique window title, and records with capture-helper.
It tears down only its own process. An explicitly supplied fallback recorder is
selected during readiness if the primary tooling is unavailable, and its reason
is retained. A failure after primary capture begins fails the attempt rather than
silently changing capture providers mid-proof.

## Validation order

Before side effects, a conforming runner validates the root document, manifest compatibility, library resolution, complete static call graph, parameters, and trust plan. It then executes the recipe and validates the resulting evidence package.

Simple recipes need no composition, proof targets, or teardown. Use only what the claim requires.
