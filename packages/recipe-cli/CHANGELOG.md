# Changelog

All notable changes to `@farmslot/recipe-cli` are tracked here.

## Unreleased

- Add `@farmslot/recipe-cli/harness`, the generic support a harness CLI runs its commands on: the host identity (`configureHarnessHost`: name, env prefix, package, executable, journaled commands), runtime paths (`recipeRuntimeDir`, `recipeRuntimePath`, `recipeHarnessRoot`, `recipeHarnessPath`, `harnessExecutable`), the resumability journal (`withCommandJournal`, `readCommandJournal`, argument redaction), the checkout lock (`acquireCheckoutLock`, `trackCheckoutChild`), `JsonStreamWriter`, colour helpers, contained artifact writes, Git library provenance and shell-leaf invocation. Moved from mm-harness; a product preset keeps its own env names (`MM_HARNESS_*`) through the host identity.

## 0.1.2 - 2026-10-04

- Export the action catalog helpers a host CLI needs on top of its own action manifest: `actionCategory`, `fuzzyResolveActions`, `shortActionNames`, `searchActions`, `findRelatedActions`, `summarizeActionCategories`, `actionCapabilityMatrix`, `resolveActionCapabilityRefusal` and `missingActionCapabilities`. `search` ranks with the same scorer, so its results are unchanged.

## 0.1.1 - 2026-10-03

- Publish with recipe-harness 0.22.1 so `require('@farmslot/recipe-cli')` works from CommonJS.

## 0.1.0 - 2026-10-02

- Add the `farmslot-recipe` front door, moved from `@farmslot/recipe-harness`: `run` and `validate` as before, plus library-wide discovery with stable `--json` envelopes. `actions`, `list`, `describe`, `explain`, `search`, `template` and `completions` resolve every library on `RECIPE_LIBRARY_PATH` and `--library`, show precedence, shadows, namespaced `<library>.<ref>` ids and library digests, and work for a library with no platform adapter. Discovery and `run` resolve refs, platform aliases and ids identically; every failure prints the `--json` error envelope, and usage errors (malformed `--library` included) exit 2. `search` finds shadowed recipes by id, `explain --strict` exits 3 on gaps, and each command loads a library set once per platform.
- `assessRecipe` accepts any `RecipeReadinessView` (`{ resolution, manifest }`), so a host can judge readiness on its own single-platform resolution against the manifest its runner executes. `buildDiscoveryIndex` vouches only for the `packageVersions` the host passes, so a library's `requires` gives discovery and the host's `run` the same answer; `farmslot-recipe` still vouches for itself.
- Export `assessRecipe` so host CLIs can judge any resolved recipe, a qualified alias included, with the same readiness rule as `list`.
- `search` without `--platform` finds shadowed platform-only recipes by their `<library>.<ref>` id, listing each id once.
- Publish with protocol 0.34.0 and recipe-harness 0.22.0 so consumers share one protocol and runtime.
