# feature/dev agent guidance

- Read `.sandbox/farmslot-farm/agent/recipe-quality.md` before authoring `recipe.json`.
- Command Center UI: doctor pass, baseline recipe fail (or document N/A), proof run with `--record-video=full-run --task-dir`.
- Read promoted screenshots with the Read tool before claiming visual ACs pass.
- The engine writes recipe evidence; write `recipe-coverage.md` and run the artifact contract check.
- Never inject UI/store state for proof — drive real recipe/CDP flows.
- **Cross-surface completeness:** when the feature touches both Command Center and Companion, fresh
  recipe output is required from **both** surfaces — inherited Command Center evidence does not
  satisfy a Companion AC. Run `--platform cli` for Command Center and `--platform ios`/`android`
  (after `companion-full` prepare) for Companion. Retain both executions for review;
  the publication package selects its recorded attempt.
- **Recipe-runner changes:** `validate-recipe.sh` runs the runner from the primary checkout, not
  the slot worktree. If your change modifies `apps/command-center/scripts/agentic/run-recipe.mjs`
  or any recipe-runner file, replay the recipe directly via `node <worktree>/apps/command-center/
  scripts/agentic/run-recipe.mjs` before running the wrapper, and document the runner path in
  the proof report.
- **Transport decorator completeness:** when wrapping a transport, ensure all optional capabilities
  (e.g. `observe`) are forwarded to the base transport. A decorator that silently drops an optional
  capability breaks features that rely on it even when the base transport supports it correctly.

## Recipe authoring quick-checks

- **`command` action keys:** use `cwd` (relative path) + `cmd` — not absolute paths, not a `command` key.
- **`ui.set_input` / `ui.press`:** target by `test_id` (snake_case `data-testid` value) — not camelCase.
- **Resume / attach proof:** after launch the UI navigates to the worker terminal. Re-navigate to the
  originating panel (e.g. `#backlog`), assert **Continue existing** is visible, press it, and assert
  the gateway RPC payload contains `attachedExisting: true`. Do not rely on transient toast messages.
- **Before/after evidence:** capture the true before frame separately from the old
  implementation and retain it in `artifacts/`. The engine retains current recipe
  captures in their original attempt. Optional task-root declarations can pair
  that baseline with selected-attempt captures; no sync or copying step is needed.
