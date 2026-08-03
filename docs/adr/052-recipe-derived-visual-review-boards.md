# ADR-052: Recipe-Derived Visual Review Boards

**Status:** Accepted
**Date:** 2026-08-03
**Relates to:** [ADR-019](019-recipe-graph-visualization.md), [ADR-034](034-recipe-protocol-v1.md), [ADR-039](039-run-portable-bundles.md), [ADR-048](048-interactive-operator-packets.md)

## Context

Recipes can capture complete web and native UI surfaces, but a folder of screenshots is not enough
for iterative UI work. Operators need to browse screens and subscreens, mark either a control or a
larger layout region, leave overall feedback, and hand structured comments back to a worker. The
same workflow must work for Companion, Command Center, MetaMask Mobile, MetaMask Extension, and
other farm projects without a global screen registry or a project-specific annotation app.

Screen hierarchy cannot be inferred reliably from workflow order. A recipe may capture sibling tabs
sequentially, while two captures separated by several navigation actions may represent a real
parent/subscreen relationship. Routes and test IDs are also platform implementation details, not
portable review identity.

Native Recipe runs may use Agent Device as their UI transport, but the two tools solve different
problems. Agent Device is an interactive discovery and diagnostics surface: an agent can inspect a
live accessibility tree, obtain short-lived refs, query visible state, act, and continue from a
settled diff. A Recipe is a deterministic proof artifact: it starts with stable selectors and
declared expectations, then preserves an exact graph, trace, and evidence package. Making Recipe v1
mirror every Agent Device command would mix authoring-time exploration with reviewable proof.

## Decision

### Identity and relationships come from the recipe

A review source has a stable, namespaced id:

```text
<farm-project-id>:<catalog-id>
```

Each visual capture node id is the stable surface id within that source. Full surfaces use
`ui.capture_surface`; viewport states may opt in with `ui.screenshot` plus `visual_review`. The
optional core node field declares presentation relationships:

```json
{
  "action": "ui.capture_surface",
  "path": "ios/ready-gate.png",
  "visual_review": {
    "parent": "capture-run",
    "navigation": [{ "from": "capture-run", "kind": "push" }],
    "related": ["capture-evidence"]
  }
}
```

`parent` organizes the review hierarchy. `navigation` records observed directed edges independently,
using `tab`, `push`, `in-place`, `modal`, or `replace`, so one surface may have multiple incoming
paths. `related` keeps non-navigation context links. Every reference targets a visual capture node
in the same recipe; the protocol validates missing targets and parent cycles. `visual_review` is
recipe metadata, not an action parameter, so adapters and runner capability negotiation do not
duplicate or interpret it.

The narrow core field is intentional. A free-form `metadata` bag would avoid future schema changes
but would also make portable validation and rendering impossible. A separate project catalog file
would keep Recipe v1 smaller but duplicate capture ids, paths, and proof targets, allowing the
catalog to drift from the executed recipe. The field is therefore limited to visual capture nodes
and to relationships the shared renderer can validate.

### Capability ownership

| Layer                               | Owns                                                                                                                                                          | Does not own                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Agent Device                        | Interactive snapshot/ref discovery, settled diffs, device mechanics, coordinate fallback, alerts, logs, network, and performance diagnostics                  | Recipe graph semantics, proof claims, or project screen vocabulary     |
| Recipe Protocol / Harness           | Stable UI actions used in proof, action capability negotiation, assertions, full-surface capture, trace, artifacts, and visual-review relationship validation | Ephemeral refs, exploratory navigation policy, or product routes       |
| Domain harness such as `mm-harness` | MetaMask runtime setup, semantic destinations, durable wallet/perps actions, platform capability profiles, and reusable domain recipes                        | Generic UI transports, screenshot stitching, or review-board rendering |
| Farm project                        | Stable test ids, task-local capture recipes, catalog identity, and the observed navigation relationships relevant to that product                             | A new renderer or a fork of the protocol                               |

Agent Device may remain the provider beneath a native Recipe transport. Reuse occurs at that
provider boundary; Recipe documents never store Agent Device refs because they are session- and
snapshot-scoped. Discovery output may help an agent author stable recipe selectors, but it is not
itself proof.

For MetaMask, the portable `ui.capture_surface` implementation belongs in the shared harness.
`mm-harness` should adopt the published capability through its Mobile and Extension manifests and
keep only MetaMask-specific navigation/setup and reusable screen flows. No MetaMask page, route, or
locator belongs in Recipe v1.

### Portable source and feedback documents

`@farmslot/protocol` owns two versioned document shapes:

- `visual-review-source` describes source identity, captured timestamp, surfaces, hierarchy, typed
  navigation edges, related links, platforms, proof targets, and image artifacts.
- `visual-review-feedback` binds feedback to the exact source snapshot and carries overall surface
  notes plus normalized annotations.

Annotations use intrinsic-image coordinates from `0` to `1`. A point marks one control. An area adds
normalized width and height for layout, grouping, or multi-element feedback. Each annotation may
carry a review color. Coordinates therefore survive responsive display, remain movable, and do not
depend on CSS pixels.

This is an artifact-feedback protocol, not an HTML-report contract. A recipe run produces the image
artifacts; the source document selects and relates the reviewable subset and may bind it to a Farmslot
run id; the feedback document records operator intent against that immutable source snapshot.

### One lightweight provided tool

`@farmslot/recipe-harness` owns the renderer and `farmslot-visual-review` tool. It can build a static
offline board or serve one on loopback. Serving defaults to port `0`, letting the operating system
allocate a free port; callers may provide a host or port explicitly. The tool has no gateway state,
database, framework runtime, or project-specific navigation logic.

The `build-recipe` command converts any Recipe v1 artifact directory directly into the portable
source and board. A project supplies only its recipe, artifacts, platform, and namespaced source id.

Farm projects only produce a source document and referenced images. The board derives its index,
hierarchy, breadcrumbs, subscreen links, related links, and annotation canvas from those portable
inputs. A source can contain an entire catalog or one selected surface.

### Evolution boundary

The generated board is the zero-dependency desktop baseline. Farmslot Companion may render the same
source document with touch-first controls and emit the same feedback document; a richer annotation
sub-app may likewise add zoom, pan, drawing, collaboration, or run attachment. Renderers do not own
capture, surface identity, recipe execution, or feedback semantics. Those capabilities are not
prerequisites for portable feedback and must not move workflow or publication state into a renderer.

## Consequences

- Projects share one tool and contract while retaining their own recipe-local UI vocabulary.
- Existing flat capture recipes remain valid; relationships are optional.
- Feedback remains usable if the renderer evolves from static HTML to a canvas application.
- Stable surface IDs preserve comments across recaptures; `capturedAt` identifies the reviewed
  snapshot.
- Recipes must declare meaningful relationships explicitly; the renderer will not guess them.
- Interactive exploration can evolve independently in Agent Device without expanding Recipe v1.

## Rejected alternatives

- **Global screen registry:** couples unrelated products and cannot represent dynamic or task-local
  screens.
- **Infer hierarchy from workflow edges:** confuses execution order with information architecture.
- **Project-specific annotation apps:** duplicates persistence and feedback formats.
- **Gateway-owned review UI:** prevents offline evidence review and makes artifact rendering depend
  on live orchestration state.
- **Mirror Agent Device commands as Recipe actions:** bloats the deterministic protocol with
  session-scoped discovery and diagnostics. Add a standard action only when a repeatable proof flow
  needs it across projects and adapters.
- **Store Agent Device refs in recipes:** refs expire when the captured UI changes; durable recipes
  use project-owned ids or other stable selectors.
