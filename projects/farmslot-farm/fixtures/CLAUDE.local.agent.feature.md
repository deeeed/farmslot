# feature/dev agent guidance

- Read `.sandbox/farmslot-farm/agent/recipe-quality.md` before authoring `recipe.json`.
- Command Center UI: doctor pass, baseline recipe fail (or document N/A), proof run with `--record-video=full-run --task-dir`.
- Read promoted screenshots with the Read tool before claiming visual ACs pass.
- Write `evidence-manifest.json`, `recipe-coverage.md` (gateway computes recipe-quality); run artifact contract check.
- Never inject UI/store state for proof — drive real recipe/CDP flows.
- **Cross-surface completeness:** when the feature touches both Command Center and Companion, fresh
  recipe output is required from **both** surfaces — inherited Command Center evidence does not
  satisfy a Companion AC. Run `--platform cli` for Command Center and `--platform ios`/`android`
  (after `companion-full` prepare) for Companion, then reference both artifact sets in
  `evidence-manifest.json`.
- **Recipe-runner changes:** `validate-recipe.sh` runs the runner from the primary checkout, not
  the slot worktree. If your change modifies `apps/command-center/scripts/agentic/run-recipe.mjs`
  or any recipe-runner file, replay the recipe directly via `node <worktree>/apps/command-center/
  scripts/agentic/run-recipe.mjs` before running the wrapper, and document the runner path in
  `evidence-manifest.json`.
- **Transport decorator completeness:** when wrapping a transport, ensure all optional capabilities
  (e.g. `observe`) are forwarded to the base transport. A decorator that silently drops an optional
  capability breaks features that rely on it even when the base transport supports it correctly.

## Recipe authoring quick-checks

- **`command` action keys:** use `cwd` (relative path) + `cmd` — not absolute paths, not a `command` key.
- **`ui.set_input` / `ui.press`:** target by `test_id` (snake_case `data-testid` value) — not camelCase.
- **Resume / attach proof:** after launch the UI navigates to the worker terminal. Re-navigate to the
  originating panel (e.g. `#backlog`), assert **Continue existing** is visible, press it, and assert
  the gateway RPC payload contains `attachedExisting: true`. Do not rely on transient toast messages.
- **Before/after evidence:** label all recipe-run screenshots `after-*` (or `demo-*`). Never emit a
  `before-*` file from a recipe run targeting the already-fixed codebase — `sync-recipe-evidence.sh`
  will copy it verbatim and overwrite any hand-captured true-before frame. Capture the true before
  frame separately (reverted code or off-main) and place it directly in `artifacts/`.
- **One evidence sync per proof run:** do not invoke `sync-recipe-evidence.sh` more than once; repeat
  calls risk overwriting the hand-crafted `before-*` frames.
