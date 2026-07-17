# Good fixture spec — every criterion carries a concrete check

**Project:** `farmslot-farm`

## Problem

Fixture for spec-lint self-tests: a spec whose acceptance criteria are all verifiable inside one run.

## Deliverables

1. A widget module with unit coverage.
2. Evidence artifacts for the run family.

## Non-goals

- No UI changes.
- No protocol changes.

## Acceptance Criteria

- `node scripts/quality/run-tsx-tests.mjs --cwd services/gateway src/widgets` exits 0 with the new widget tests included.
- Widget selector tests prove `selectWidget` rejects cross-run reuse (`widget-selector.test.ts`).
- Evidence JSON attached (artifact: `artifacts/widget-evidence.json`).
- Recipe regression passes after the fix (recipe: `docs/examples/recipes/farmslot/widget.recipe.json`).
