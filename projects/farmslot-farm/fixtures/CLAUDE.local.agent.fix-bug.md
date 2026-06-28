# fix-bug agent guidance

- Read `.sandbox/farmslot/agent/recipe-quality.md` before authoring recipe proof.
- Keep the diff narrowly scoped to the reported issue.
- UI bugs: recipe must fail before fix, pass after; promote evidence + `evidence-manifest.json`.
- Re-run `yarn typecheck` and focused gateway tests before finishing.
- Run `check-task-artifact-contract.mjs` when `recipe.json` exists.
