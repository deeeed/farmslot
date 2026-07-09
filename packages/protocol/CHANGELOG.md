# Changelog

## Unreleased

- docs: note `grok-4.5-fast-xhigh` as a Cursor Agent model example on `SlotStatus.model`.
- feat: publish the canonical Recipe Protocol v1 JSON Schema (`schemas/recipe-v1.schema.json`, exported via `./schemas/*`) and validate a `recipe.$schema` URL contract in `validateRecipeDocument` (`RECIPE_PROTOCOL_SCHEMA_URL`, `recipeProtocolSchemaUrlForVersion`; `$schema` must match `schema_version` when present, or is required under opt-in `requireSchemaRef`). The published schema matches the validator (`schema_version`/`validate` required, `flows` allowed, `additionalProperties`).
- feat: `validateRecipeArtifactPackage` takes `resolvedRecipe` (the fully-composed `resolved-recipe.json`) and `runPassed`. For a passing run the composition must be proven: `resolvedRecipe`, when present, is validated in full and `recipe` is then checked envelope-only; otherwise `recipe` is validated in full — and because `uses` catalogs are not in the package, a `uses`/library composition with no `resolved-recipe.json` is rejected. `validateFlowCalls` gains `skipResolution` (skip `unresolved_call_ref` only; call-shape checks always run) and `externalCatalogsResolvable`. A failed run keeps `recipe` envelope-only and skips `resolvedRecipe`, so a graceful failure is not turned into a rejection.
- Active-development baseline; add user-facing changes here before release or package publication.

## 0.7.5 - 2026-07-08

- feat: export `DEFAULT_GATEWAY_TLS_PORT` (7778) — the shared default port the gateway serves `wss://` on when TLS is configured, so the gateway daemon and CLI reference one source of truth instead of duplicating the literal

## 0.7.4 - 2026-07-06

- Add `@farmslot/protocol/checklist-target` as the canonical checklist filename registry (worker, self-review, ci-fix) with signal derivation, nested-loop progress filtering, and UI progress label helpers; optional `ChecklistTargetRegistry` supports dynamic overrides.

## 0.7.3 - 2026-07-06
