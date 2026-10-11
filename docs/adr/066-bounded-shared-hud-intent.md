# ADR-066: bounded shared HUD intent display

Status: Proposed

## Context

The recorded Companion gate review cuts an intent after one line. Native,
web-dapp and runner CDP HUDs impose different character and layout limits.
Arthur's requested correction is one two-line display policy for every project,
with authoring warnings above 80 characters and errors above 120.

## Decision

Own the intent display model and authoring limits in `@farmslot/protocol/recipe`.
Normalize display whitespace without shortening the authored intent. Let the
platform text layout wrap and ellipsize only after two measured lines. Native
and DOM rendering consume the same model, line limit and panel bounds; no
renderer slices the intent by character count.

Bound the native panel to 360 by 88 logical pixels and DOM cards to 360 by 144
CSS pixels, also limited by the viewport. CDP bottom-bar and docked-bottom modes
keep their bar placement but have a fixed 960px maximum width and 144px maximum
height; wide viewports no longer produce an unbounded bar. Error/detail/debug text shares the
bounded panel and cannot grow it across the application. Preserve HUD isolation,
pass-through pointer behavior, status/progress and existing placement modes.

Use one native HUD component in the React Native adapter, re-exported by
Companion and scaffold templates. Retain scaffold text/style options and the
iOS FullWindowOverlay behavior. Companion supplies its installed overlay through
`RecipeHudOptions.overlay`; the scaffold has no screens dependency. Mandatory line, width and height limits apply
after custom styling; HUD text has fixed font scaling. Custom renderHud callbacks
remain supported and must consume the shared helper to conform. Existing copied
project HUDs adopt the package renderer through a deliberate scaffold update;
this change does not overwrite deployed farm files. Web-dapp and CDP keep thin DOM renderers.
The runner's automatic HUD passes the complete normalized intent to adapters.

Validate authored node intents in the existing CLI lint/conformance path using
the recipe protocol validator's explicit authoring option. Ordinary graph
validation, execution and retained-artifact verification keep their v1 behavior,
so old evidence is readable and old farm recipes are not silently rewritten. Count Unicode code points after trimming:
0..80 has no length finding, 81..120 warns, and 121+ fails. Existing goal/action/selector checks remain in force. One plain sentence is the
authoring rule; grammar is guidance rather than a new sentence parser/error.
Shorten committed framework example and validation intents above 120 characters
as part of enabling this authoring rule; no farm repository is changed. Do not rewrite recipes in farm repositories.

## Public surface

- CLI: existing `farmslot recipe validate` and conformance validation; no new
  commands or flags. Warning findings stay nonfatal and error findings fail.
- SDK: `@farmslot/protocol/recipe` exports the display helper and policy constants,
  consumed by the runner, web adapter and native renderer. An explicit authoring
  option is consumed by CLI/conformance validation, never artifact verification. This is an additive
  package API under existing versioning; recipe wire/schema version stays v1.
- Native renderer: `@farmslot/adapter-rn/recipe-hud`, consumed by Companion and
  installed scaffold re-exports. Native peers remain optional for CLI consumers. Preserve RecipeHudOptions,
  including text/style overrides, and the custom renderHud extension point.
- Harnesses, including mm-harness, inherit authoring validation and automatic HUD policy
  through recipe runner/adapters. Existing `app.hud` support remains their
  extension point; app-owned handlers/custom renderHud must adopt the helper
  explicitly. No harness-specific formatter, flag or protocol fork.

## Verification

Unit checks cover full intent preservation, Unicode/whitespace, the shared
two-line ellipsis contract, panel bounds and 80/81/120/121 lint boundaries.
Real Companion and web HUD screenshots show two visible intent lines with
the application still visible. Existing HUD isolation and lifecycle checks pass.
ADR-062 and farm repositories are outside this change.
