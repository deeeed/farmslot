# Changelog

## Unreleased

- feat: publish the canonical Recipe Protocol v1 JSON Schema (`schemas/recipe-v1.schema.json`, exported via `./schemas/*`) and enforce a `recipe.$schema` URL contract in `validateRecipeDocument` (`RECIPE_PROTOCOL_SCHEMA_URL`, `recipeProtocolSchemaUrlForVersion`, opt-in `requireSchemaRef`). The published schema matches the validator (`schema_version`/`validate` required, `flows` allowed, `additionalProperties`); artifact-package validation is envelope-only (`skipFlowCallResolution`) so library-composed recipes are not rejected at ingestion.
- feat: `validateRecipeArtifactPackage` accepts an optional `resolvedRecipe` (the fully-composed `resolved-recipe.json`) and validates it in full — including `call.ref` resolution — proving the composition is complete and self-contained, while the authored `recipe` stays envelope-only.
- Active-development baseline; add user-facing changes here before release or package publication.

## 0.7.5 - 2026-07-08

- feat: export `DEFAULT_GATEWAY_TLS_PORT` (7778) — the shared default port the gateway serves `wss://` on when TLS is configured, so the gateway daemon and CLI reference one source of truth instead of duplicating the literal

## 0.7.4 - 2026-07-06

- Add `@farmslot/protocol/checklist-target` as the canonical checklist filename registry (worker, self-review, ci-fix) with signal derivation, nested-loop progress filtering, and UI progress label helpers; optional `ChecklistTargetRegistry` supports dynamic overrides.

## 0.7.3 - 2026-07-06
