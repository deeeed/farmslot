# fix-bug agent guidance

- Read `.sandbox/farmslot-farm/agent/recipe-quality.md` before authoring recipe proof.
- Keep the diff narrowly scoped to the reported issue.
- UI bugs: recipe must fail before fix, pass after; promote evidence + `evidence-manifest.json`.
- Re-run `yarn typecheck` and focused gateway tests before finishing.
  - Do **not** use the bare glob `services/gateway/src/*.test.ts` — it matches nothing under zsh.
    Run focused tests via the repository test runner:
    ```bash
    node scripts/quality/run-tsx-tests.mjs services/gateway/src/<relevant>.test.ts
    ```
  - If the test file imports `@farmslot/agent-runtime`, build it first:
    ```bash
    yarn workspace @farmslot/agent-runtime build
    ```
- When publishing a rebased or amended branch, use a branch-qualified force-with-lease to protect against
  unexpected remote updates:
  ```bash
  git push --force-with-lease origin <branch-name>
  ```
- Run `check-task-artifact-contract.mjs` when `recipe.json` exists.
