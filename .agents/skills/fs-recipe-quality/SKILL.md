---
name: fs-recipe-quality
description: Judge recipe quality and evidence quality for recipe-cook style workflows. Use when an agent or developer needs a focused critique of recipe structure, AC coverage, evidence fit, flake risks, and the next best improvements.
---

# FS Recipe Quality

`fs-recipe-quality` is a reusable critique skill for recipe-driven validation work.

Use it when you need to evaluate:

- a generated `recipe.json`
- a generated `recipe-cook.json`
- a generated `recipe-quality.json`
- bundled task-local subflows / recipe bundles
- the relationship between recipe steps and ACs / proof targets
- screenshots / logs / validation output produced by the recipe

This skill exists so recipe quality becomes a **first-class reusable loop**, not an implicit side effect inside other skills.

## Modes

### 1. Recipe-Only Mode

Inputs:

- `recipe.json`
- optional `recipe-cook.json`
- optional `recipe-quality.json`
- optional bundled subflow files
- optional task / AC / proof-target context

Questions to answer:

- Are ACs covered?
- Are proof targets small, concrete, and executable?
- Does the recipe reuse existing flows/evals where it should?
- Is it duplicating work or re-inventing known flows?
- Are waits/asserts/screenshot steps well placed?
- Is the recipe likely flaky?

### 2. Recipe + Evidence Mode

Inputs:

- recipe files
- `recipe-quality.json`
- bundled subflow files
- screenshots
- logs
- validation output
- optional before/after media

Questions to answer:

- Does the evidence actually match the intended step?
- Are screenshots showing the real intended state, or a loading/empty/intermediate state?
- Do before/after assets actually prove the claimed difference?
- Where would debug markers or stronger assertions help?

## Required Output Sections

Always return these sections:

1. `Verdict`
2. `Coverage Gaps`
3. `Flow Decomposition`
4. `Composition / Reuse Issues`
5. `Evidence Mismatches`
6. `Flake Risks`
7. `Suggested Fixes`
8. `Suggested Debug Markers`

Within `Suggested Fixes`, prioritize:

- top 3 highest-value fixes first
- then optional or lower-ROI polish after that

## Recipe Composition Contract

When judging Recipe Protocol v1 recipes, treat `docs/RECIPE-COMPOSITION-QUALITY.md` as the canonical Farmslot recipe-quality contract. In particular, check that production recipes preserve the original recipe model:

- each acceptance criterion maps to a focused proof flow;
- setup/navigation/teardown are reusable parameterized `ensure_*` flows, not duplicated inline nodes;
- the recipe declares a domain starting state before the proof window;
- visual evidence records the smallest user-visible intent path, while full setup remains visible in trace/summary artifacts;
- project/domain flows such as `example.trade.position_open` are domain extensions, not generic Farmslot actions.

## Critique Standards

### Coverage

Check whether:

- every required AC has a proof target
- every proof target has a recipe path
- unresolved or untestable targets are explicit, not hidden

### Composition / Reuse

Check whether:

- existing flows/evals should have been reused
- raw steps duplicate known reusable surfaces
- recipe nodes are too broad or too coupled
- bundled subflows have clear ownership boundaries
- evidence belongs to the correct flow/subflow instead of leaking across boundaries

### Flow Decomposition

Check whether:

- the recipe is too complex to remain a single file
- repeated node clusters should become subflows
- the bundle split is meaningful rather than arbitrary fragmentation
- setup/action/assert/teardown boundaries are clean
- flow names describe their responsibility clearly

Recommend extraction when you see patterns like:

- repeated setup or teardown clusters
- repeated navigation clusters
- multiple proof targets sharing only weakly coupled setup
- one recipe file mixing several distinct user stories in one graph

Recommend merging when:

- a split adds no clarity
- tiny subflows only forward control without reducing duplication
- evidence ownership becomes more confusing after the split

### Evidence Fit

Check whether:

- screenshots are taken at the right time
- screenshots actually prove the intended claim
- the evidence label matches what the screenshot/log/video shows
- before/after comparisons are meaningful

Prefer UI-state proof over backend/network proof whenever the user-facing success state is already sufficient.

### Flake Risk

Check whether:

- waits are too weak or too generic
- assertions rely on ambiguous intermediate UI
- recipes assume a settled state without proving it
- runtime state/setup assumptions are missing

## Debug Marker Guidance

This skill should explicitly recommend temporary debug markers when evidence is ambiguous.

Examples:

- add a temporary marker to distinguish loading vs settled state
- add a marker for a feature-flagged branch
- add a marker in the rendering path to confirm the intended component actually mounted
- add a marker to distinguish empty state vs data-not-yet-loaded

The goal is not just to say "this screenshot is weak," but to say **what to instrument next** to make it strong.

### Probe Bias Rule

Prefer these, in order:

1. UI-state assertions
2. UI-state debug markers
3. local runtime state capture
4. backend/network probes only if the user explicitly asks for backend-level debugging

Do not recommend backend or network probes as the primary proof when the UI success state already proves the user-facing behavior.
Do not suggest backend or network probes at all unless the user explicitly wants backend-level debugging.

## Actionability Rule

Do not return vague critique only.

Every issue should try to end with a concrete next delta, such as:

- replace raw steps with existing flow `X`
- extract nodes `A/B/C` into subflow `Y`
- merge subflows `A` and `B` because the split adds no value
- split proof target `PT-3` into two separate claims
- move screenshot after node `Y`
- add an assertion on state `Z`
- add a temporary debug marker in component `A`

When possible, prefix suggested fixes mentally as:

- `must-fix`
- `should-fix`
- `nice-to-have`

Even if you do not print those exact labels, the ordering should reflect that severity.

## Good Use Cases

- after `recipe-cook` generates a recipe but before calling it "good"
- after a recipe run produced screenshots that look suspicious
- when a live run is flaky and needs structure/evidence critique
- as a self-improvement loop for benchmarked review/fixbug skills

## Artifact Preference Rule

Prefer these sources in order:

1. `recipe-quality.json`
2. `recipe.json` + bundled subflows
3. `recipe-cook.json`
4. screenshots / logs / validation output

`recipe-quality.json` should be treated as the canonical critique artifact when present.
