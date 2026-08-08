# fix-bug agent guidance

- Read `.sandbox/farmslot-farm/agent/recipe-quality.md` before authoring recipe proof.
- Keep the diff narrowly scoped to the reported issue.
- Recipe proof is required for **all** bug fixes, not just UI changes. Use the right endpoint:
  - UI bugs: `ui.*` actions — recipe must fail before fix, pass after; promote evidence + `evidence-manifest.json`.
  - CLI / gateway / protocol bugs: `command` nodes hitting the CLI, gateway RPC, or `watch_logs` — assert the corrected output/state, not just that the call returned.
  - Backend-only changes have no screen but are fully reachable via `command` + `assert_output`; "no UI" is not a valid reason to omit recipe proof.
- When fixing a regression class (e.g., error mapping, resource bounds, silent exits), cover all affected call sites — not just the one in the bug report.
- Re-run `yarn typecheck` and focused gateway tests before finishing.
- Run `check-task-artifact-contract.mjs` when `recipe.json` exists.
