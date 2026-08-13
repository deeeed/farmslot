# Farmslot recipe quality — Command Center / gateway tasks

Read this before authoring `{{TASK_DIR}}/artifacts/recipe.json`.

## Contract

- Graph envelope: canonical `$schema`, required `description`, `workflow.entry`, `workflow.nodes`, and `intent` on every non-terminal executable node.
- Runner: `{{recipe_validate_wrapper}}` with `{{recipe_manifest_path}}`.
- Discovery: before authoring, inspect action names in `{{recipe_manifest_path}}`, then read only the relevant metadata/examples and existing recipes under `{{farmslot_dir}}/docs/examples/recipes/farmslot/`; reuse declared capabilities instead of guessing action names.
- Capability prerequisite: before a Command Center doctor or recipe run, use the control-plane Gateway's `runtime.capability.list` and `runtime.capability.acquire` RPCs to lease `sandbox-gateway-ui` and `browser-cdp` for the current slot/run and declared visual proof requirements. Require both acquire responses to report `ok: true`; do not launch `sandbox-dev.sh` or `debug-chrome.sh` directly.
- Doctor after capability acquisition: `cd {{REPO}} && node apps/command-center/scripts/agentic/recipe-doctor.mjs --cdp-port {{CDP_PORT}} --gateway-port {{WATCHER_PORT}} --json`

> **Worktree proof — set FARMSLOT_SLOT_REPO:** When validating a branch in a slot worktree,
> `validate-recipe.sh` resolves `REPO_ROOT` as `FARMSLOT_SLOT_REPO → REPO → primary_repo`.
> If neither env var is set the script targets the operator primary checkout and recipe
> `command` nodes see the wrong branch.  Always set the variable before calling the runner:
> ```bash
> export FARMSLOT_SLOT_REPO={{REPO}}   # the slot worktree checkout
> ```
> The `recipe_run` hook in `project.json` already injects this; manual invocations must do so too.

> **CDP / HUD pre-condition:** The Command Center recipe runner enables `app.hud` only when the
> recipe uses UI actions or `--record-video` is set; a pure `command`/RPC recipe without video
> runs with the HUD auto-disabled and needs no browser page. Whenever either condition holds
> (any UI node, or video evidence), a CDP-enabled Chrome instance **must** be listening on
> `--cdp-port` before the run. If a run fails with an `app.hud` error before the first
> `command` node, Chrome is not listening (or video was requested unintentionally). Inspect the
> `browser-cdp` lease with `runtime.capability.status`, then acquire or retry it through
> `runtime.capability.acquire`; never bypass lease ownership with a direct Chrome launch. Confirm
> with doctor before retrying the recipe.

- Fast validation run (no video):
  ```bash
  cd {{REPO}}
  bash {{recipe_validate_wrapper}} \
    --recipe {{TASK_DIR}}/artifacts/recipe.json \
    --artifacts-dir {{TASK_DIR}}/artifacts/recipe-run \
    --runtime-dir {{RUNTIME_DIR}} \
    --platform {{PLATFORM}} \
    --cdp-port {{CDP_PORT}} \
    --gateway-port {{WATCHER_PORT}} \
    --slot-id {{SLOT}}
  ```
- **PR-grade proof run** (slow + full-run MP4 — required for Command Center UI changes):
  ```bash
  cd {{REPO}}
  # First acquire sandbox-gateway-ui and browser-cdp through runtime.capability.acquire as above.
  bash {{recipe_validate_wrapper}} \
    --recipe {{TASK_DIR}}/artifacts/recipe.json \
    --artifacts-dir {{TASK_DIR}}/artifacts/recipe-run \
    --runtime-dir {{RUNTIME_DIR}} \
    --platform {{PLATFORM}} \
    --cdp-port {{CDP_PORT}} \
    --gateway-port {{WATCHER_PORT}} \
    --slot-id {{SLOT}} \
    --slow 2000 \
    --record-video=full-run \
    --task-dir {{TASK_DIR}}
  ```
  (`validate-recipe.sh` auto-promotes screenshots + `after.mp4` when `--task-dir` is set; or run `{{recipe_sync_evidence_cmd}} --task-dir {{TASK_DIR}} --require-video` manually.)
- Gateway replay uses the same hook via `hooks.recipe_run` in `projects/farmslot-farm/project.json`. The hook routes `cli`/web runs to Command Center and `ios`/`android` runs to Companion, but both routes must emit the same Recipe v1 package under `--artifacts-dir`: `summary.json`, `trace.json`, and `artifact-manifest.json`; copy the resolved `recipe.json` when practical.
- If you need to inspect the package directly, run `cd {{REPO}} && yarn --cwd apps/command-center farmslot recipe artifacts validate {{TASK_DIR}}/artifacts/recipe-run` (append `--recipe {{TASK_DIR}}/artifacts/recipe-run/recipe.json` only when that file was copied).

> **⚠ Runner resolution:** `validate-recipe.sh` always loads `run-recipe.mjs` from the
> **primary checkout** (`PRIMARY_REPO`), not the slot worktree. If the PR modifies
> `apps/command-center/scripts/agentic/run-recipe.mjs` or any file it imports, the worktree
> version will **not** be exercised via `validate-recipe.sh`. In that case replay the recipe
> directly with the worktree-local runner before publishing proof:
> ```bash
> node <WORKTREE>/apps/command-center/scripts/agentic/run-recipe.mjs \
>   {{TASK_DIR}}/artifacts/recipe.json \
>   --artifacts-dir {{TASK_DIR}}/artifacts/recipe-run \
>   --action-manifest {{TASK_DIR}}/../../../docs/examples/recipes/farmslot-v1.action-manifest.json \
>   --project-root <WORKTREE> \
>   --cdp-port {{CDP_PORT}} --gateway-port {{WATCHER_PORT}}
> ```

## What a recipe proves

A recipe proves a **protocol action** works in the running system, driven through a **real client
endpoint**. Not a UI tool — "does this have a screen?" is the wrong question.

| Endpoint | Recipe surface | Assert with |
|----------|----------------|-------------|
| Command Center | `ui.navigate` / `ui.press` / `ui.wait_for` / `ui.screenshot` | viewport-visible + screenshot |
| CLI | `command` → `yarn --cwd apps/command-center farmslot <cmd>` | `assert_output` / `assert_json` |
| Gateway RPC | `command` → `node apps/command-center/scripts/cdp.mjs gateway <method> '<params>'` | `assert_output` |
| Runtime logs | `watch_logs` | `contains` on the emitted line |
| Companion | `ios`/`android` route | device screenshot |

Assert at the level that proves the claim: screenshots prove rendering; log/RPC reads prove state and
cross-store effects. If the claim is "cancelling settles the backlog", read the backlog back — do not
screenshot a button.

> **CLI cold-start cost:** Each `yarn farmslot` (or `yarn --cwd apps/command-center farmslot`) cold
> start takes ~10–15 s.  A recipe that chains multiple verbs (e.g. `run`, `pause`, `resume`) in
> separate `command` nodes pays this cost every node; a 4-verb sequence easily dominates recipe
> runtime (~6–7 min) even when the gateway RPC itself is fast.  Prefer a single gateway RPC call
> via `node apps/command-center/scripts/cdp.mjs gateway <method> '<params>'` for read/mutate
> operations where possible; reserve multi-verb CLI chains for flows that must exercise the CLI UX.

Never proof:

- "Backend-only, so no recipe" — CLI, gateway RPC, and logs all reach it.
- Unit tests with mocked collaborators — they prove the function, not the wired system.
- A `#dev/*` harness fixture when the claim is that the gateway *derives* the value.
- Asserting a call returned when the claim is its side effect on another aggregate.

## Proof rules

1. Cover every acceptance criterion in `recipe-coverage.md` with `state`, `visual`, or `mixed` proof mode.
2. Identify the protocol action(s) the change touches, then the client endpoint(s) that reach them.
   Drive at least one end to end.
3. UI changes require real navigation via `ui.navigate` / `ui.wait_for` / `ui.screenshot` — never inject store/DOM state.
4. Visual ACs need **viewport-visible** assertions (`expected: "visible"` or absent/hidden negatives) before screenshots.
5. Screenshot filenames should encode proof: `before-<claim>.png`, `after-<claim>.png`.
6. Assert the actual feature: if you remove the code, the recipe must fail. This is the test of whether
   the recipe proves anything — run the baseline with your change stashed.
7. State-mode proof still runs against the **running gateway**, not a test harness. `command` +
   `assert_output` against the live CLI/RPC is a first-class recipe, not a fallback.
8. **Revalidate and extend on every change.** The recipe is living proof, not a one-time gate. Any
   behaviour change — including fixes made during review rounds — needs a node covering the new claim
   and a re-run. Then act on the result: a failing node means fix the code, or fix an assertion that
   over-claims. A review fix with no recipe node is unproven.
9. **Unit tests are not a substitute for wiring.** A pure helper can be fully unit-tested while the
   code that calls it is dead. If the claim is "the panel refreshes" or "the effect fires", the recipe
   must exercise the wiring in the running app.
10. **Graph structural edits are planning-only.** Once a graph has been submitted/started, its
    structure (nodes, edges) cannot be changed — not even after `pause`.  `pause` suspends execution
    but does not re-open structural editing.  If a recipe or CLI teaching step says "pause then edit
    the graph", that is wrong: create a new graph instead.
11. **Node inline scripts: prefer `node -e` over HEREDOC for proof scripts.** When writing a `command`
    node that runs a short Node.js assertion inline, use `node -e '…' <file>` rather than
    `node - <<'HEREDOC'\n…\nHEREDOC <file>`.  The HEREDOC form does **not** put `<file>` on
    `process.argv[1]`; `node -e` does.  For multi-line scripts use a temporary file or the
    dedicated cdp.mjs / recipe-doctor.mjs helpers.
12. **`ui.wait_for` text must not be text the HUD itself renders.** The HUD renders recipe `intent`
    strings and labels into the DOM, so an assertion on that text can pass without the real UI ever
    rendering. Choose assertion text that appears in no recipe `intent` or label.

## PR evidence package (gateway embeds this in created PRs)

After the proof run, `artifacts/` must contain promotable media the gateway can upload:

| File | Source |
|------|--------|
| `artifacts/before-*.png` | recipe `screenshots/before-*` |
| `artifacts/after-*.png` | recipe `screenshots/after-*` or `demo-*` |
| `artifacts/after.mp4` | `recipe-run/videos/recipe-run.mp4` via `sync-recipe-evidence.sh` |

Write `{{TASK_DIR}}/artifacts/evidence-manifest.json`:

```json
{
  "version": 1,
  "preferred_mode": "screenshots",
  "summary": "One line describing what reviewers should see.",
  "before_after_pairs": [
    {
      "label": "Demo banner absent vs present",
      "covers": ["ac1", "ac2"],
      "before": "artifacts/before-demo-banner.png",
      "after": "artifacts/after-demo-banner.png"
    }
  ],
  "videos": {
    "after": "artifacts/after.mp4",
    "preferred": true,
    "note": "Full recipe replay with HUD at 2s slow playback"
  }
}
```

Rules:
- Paths must resolve under `artifacts/` (gateway normalizes `artifacts/foo.png`).
- Do not reference files that `sync-recipe-evidence.sh` did not promote.
- For UI features, `videos.after` is **required** unless capture-helper doctor fails (document the doctor error in `videos.note` and keep screenshots).
- When capture-helper or CDP screencast fails and screenshots are promoted as the fallback
  (e.g. taken via CDP `Page.captureScreenshot` rather than native capture-helper), set
  `preferred_mode: "screenshots"` and describe the fallback source in `videos.note`:
  `"CDP screencast unavailable in tmux/sandbox; screenshots sourced from CDP Page.captureScreenshot."`
  Do **not** leave the note blank or claim native capture-helper proof when it was not used —
  reviewers must be able to evaluate media provenance.
- `pr-description.md` **Screenshots/Recordings** section stays a placeholder — gateway replaces it from this manifest.

Also write `{{TASK_DIR}}/artifacts/recipe-coverage.md`. Do **not** author `recipe-quality.json` — the gateway computes recipe quality from your `recipe.json` + coverage.

Validate before done:

```bash
node {{farmslot_dir}}/scripts/quality/check-task-artifact-contract.mjs {{TASK_DIR}} --require-recipe-coverage-if-recipe
```

## Examples

- Workspace smoke: `{{farmslot_dir}}/docs/examples/recipes/farmslot/command-center-ui.recipe.json`
- Demo banner: `{{recipe_example_banner}}`
