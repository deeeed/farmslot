---
id: qa/default
title: Farmslot runtime validation
flow: qa
platforms: [cli, web, ios, android]
---

# Farmslot QA checklist

Validate the assigned source and acceptance criteria. This is QA in validation
mode: keep source and branch unchanged. Do not commit, push or publish a PR.
Use `{{TASK_DIR}}/mark N` after each completed step. A blocked prerequisite or
failed smoke must remain a failure with retained evidence.

## Checklist

### Scope

- [ ] Read TASK.md, `inputs/qa.json`, root CLAUDE.md and the project quality contracts at `{{recipe_quality_path}}` and `{{review_quality_path}}`. Freeze base/head SHAs, requested criteria and included/excluded changes in `artifacts/qa-scope.json`. Verify the prepared HEAD matches the admitted source; refuse drift. Start this task with `{{TASK_DIR}}/mark start`.
- [ ] Map each criterion to a CLI/RPC, Command Center or Companion recipe assertion. Select only the required surfaces and record their allocated ports and borrowed/run-owned resources. Health-check them using the declared project hooks. Acquire required runtime capabilities through the public gateway before starting them; missing authority or unhealthy prerequisites block QA. Never copy operator credentials or reset borrowed state.

### Runtime proof

- [ ] Author `artifacts/recipe.json` using the existing Recipe v1 manifest at `{{recipe_manifest_path}}`. Run a non-financial smoke through `{{recipe_validate_wrapper}}` with `FARMSLOT_SLOT_REPO={{REPO}}`, this slot's ports and a fresh task artifact directory. Inspect assertions, trace and captures; UI evidence must show the recipe HUD. CLI/RPC proof must assert the resulting state, not just a successful call. Retain a failed smoke and stop before broader validation.
- [ ] Freeze the selected cases and criterion mapping, then execute each attainable case through the same wrapper. Keep separate complete packages and cleanup evidence for each case. Use the existing `@farmslot/recipe-runner` exports `freezeRecipeSuiteScope` and `finalizeRecipeSuite` to retain the standard suite scope/result. Reuse these writers rather than creating another suite format. Record uncovered criteria and unavailable surfaces explicitly; an empty suite cannot pass.

### Deterministic checks

{{CI_PARITY_STEP}}

### Results

- [ ] Assess the frozen criteria as PASS, FAIL or UNTESTABLE against executed assertions and inspected evidence. Write `artifacts/recipe-coverage.md`, `artifacts/evidence-manifest.json` and `artifacts/report.html`, including source/provider revisions, failed attempts, coverage gaps and cleanup. Write `artifacts/qa-result.json` exactly as the generated TASK.md QA-input contract requires, binding the admitted profile/inputs, source, packages, smoke proof target and scope/suite digests. Use the installed protocol's `digestRecipeDocument` for digests; do not invent evidence or counters.
- [ ] Confirm HEAD and tracked files remain unchanged and run-owned cleanup completed while borrowed resources remain intact. Retain `artifacts/retrospective.md` and `artifacts/learnings.md`. Complete with `{{TASK_DIR}}/mark complete --mark-last` only when the QA artifact contract and deterministic check pass. Otherwise write the partial report and mark blocked with the exact missing prerequisite or failed criterion.
