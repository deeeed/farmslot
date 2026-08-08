# fix-bug agent guidance

- Read `.sandbox/farmslot-farm/agent/recipe-quality.md` before authoring recipe proof.
- Keep the diff narrowly scoped to the reported issue.
- Recipe proof is required for **all** bug fixes, not just UI changes. Use the right endpoint:
  - UI bugs: `ui.*` actions — recipe must fail before fix, pass after; promote evidence + `evidence-manifest.json`.
  - CLI / gateway / protocol bugs: `command` nodes hitting the CLI, gateway RPC, or `watch_logs` — assert the corrected output/state, not just that the call returned.
  - Backend-only changes have no screen but are fully reachable via `command` + `assert_output`; "no UI" is not a valid reason to omit recipe proof.
- When fixing a regression class (e.g., error mapping, resource bounds, silent exits), cover all affected call sites — not just the one in the bug report.
- CLI/TUI bugs: preserve machine-mode byte integrity (`--json`/machine output stays pure stdout). Gate human spinners/notices on the shared machine-mode predicate, write progress to stderr only, use immediate stream-progress for streaming commands before the first output byte, and use a one-shot notice (not an interval spinner) before synchronous blocking work. Proof can be `node:test` + forced-TTY/mock-timer checks + live `--json` envelope probes — do not force Recipe/CDP proof when there is no browser Command Center surface.
- For `scripts/` fixture/compose bugs, inspect the actual failing rendered path/log line before changing loop structure; keep template text expansion separate from fixture path expansion, preserve generic `project.json` compose vars via env, and only log `[OK]` after the shell side effect succeeds. Mirror existing bash flag-vs-env precedence exactly: inherited env stays unless the flag is passed.
- For identifier renames, write normalization/migration tests before broad search-replace sweeps; preserve legacy literals inside migration code.
- Re-run `yarn typecheck` and focused gateway tests before finishing.
- Run `check-task-artifact-contract.mjs` when `recipe.json` exists.
