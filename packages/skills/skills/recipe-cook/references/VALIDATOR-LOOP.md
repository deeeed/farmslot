# Validator Loop

Use the validator loop when you are comparing `recipe-cook` versions across real runs.

Core split:

- cooking run writes task-local artifacts
- validator run reads them, edits `recipe-cook/`, saves a patch, and updates ledgers

Core artifacts:

- task-local:
  - `artifacts/recipe-cook-learning.json`
  - `artifacts/recipe.json`
  - `artifacts/recipe-cook.json` when supported
- validator state:
  - `.omx/artifacts/recipe-cook-runs/<run-id>.json`
  - `.omx/artifacts/recipe-cook-patches/<timestamp>-<slug>.patch`
  - `.omx/state/recipe-cook/runs.jsonl`
  - `.omx/state/recipe-cook/versions.json`

Score inputs:

- `quality`
- `pass_rate`
- `cost_efficiency`

Selection rules:

- floors:
  - `quality >= 0.80`
  - `pass_rate >= 0.80`
- tie-breaks:
  1. higher `quality`
  2. higher `pass_rate`
  3. higher `cost_efficiency`
- if cost is unknown:
  - `balanced_score = null`
  - compare by `quality`, then `pass_rate`
  - do not promote that version to `keep` until cost coverage exists

Convergence rules:

- stop after 3 consecutive applied patches with no improvement greater than `0.02`
- or when all three lanes reach:
  - `quality >= 0.90`
  - `pass_rate >= 0.90`
  - cost remains within 10% of the current best

Canonical lanes:

- review
- fix
- investigation
