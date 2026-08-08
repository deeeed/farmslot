# farmslot local guidance

- This demo project exists to validate Farmslot orchestration against the command-center workspace itself.
- Default prepare (`sandbox` / `attach`) starts **gateway + UI only** — no simulator, Metro, or companion app.
- Companion mobile (isolated sim/adb/Metro) is **opt-in** when the task touches `apps/companion`; see the
  companion-mobile agent fixture when `FLOW_TYPE` includes it.
- Prefer no-emit validation only:
  - `cd apps/command-center && yarn typecheck`
  - Gateway tests — the non-recursive glob `services/gateway/src/*.test.ts` matches **nothing** under zsh.
    Use the repository test runner with explicit affected files instead:
    ```bash
    node scripts/quality/run-tsx-tests.mjs services/gateway/src/<relevant>.test.ts
    ```
    If `@farmslot/agent-runtime` is declared as a workspace dependency of the test file, build it first:
    ```bash
    yarn workspace @farmslot/agent-runtime build
    ```
- Command Center UI proof uses Recipe v1 + CDP (not typecheck alone):
  - Read `.sandbox/farmslot-farm/agent/recipe-quality.md` after fixture sync (workers).
  - Reviewers also read `.sandbox/farmslot-farm/agent/review-quality.md` and apply `fs-recipe-quality`.
  - Doctor: `node apps/command-center/scripts/agentic/recipe-doctor.mjs --cdp-port <cdp> --gateway-port <gateway> --json`
  - Run: `bash projects/farmslot-farm/setup/validate-recipe.sh --recipe <recipe.json> --artifacts-dir <dir> --cdp-port <cdp> --gateway-port <gateway> --slot-id <slot>`
- **Recipe proof applies to all surfaces — not only UI:** CLI (`command` → `yarn farmslot <cmd>`), gateway RPC
  (`command` → `node apps/command-center/scripts/cdp.mjs gateway <method> '<params>'`), and log assertions
  are first-class recipe nodes. “Backend-only” is not a valid reason to omit a recipe.
- **CLI-only recipes (no CDP page running):** use the core-only action manifest rather than the full Command Center manifest. The full manifest enables HUD before executing the first node, which fails when no browser page is attached:
  ```bash
  # wrong for command-only recipes — enables HUD from the full manifest:
  # --action-manifest docs/examples/recipes/farmslot-v1.action-manifest.json
  # correct: supply the core-only manifest or omit HUD-gated actions
  ```
  Confirm with `recipe-doctor.mjs --json` before running — it reports whether a CDP page is reachable.
- Slot helper/script verb ports that shell out belong in gateway methods routed through `route-method.ts` when they need `execOnSlot` / `execLocal`; do not hide connected-node exec behind `@farmslot/slot-config` or `farmslot internal`.
  Match the original script locality: commands previously wrapped in `run_on`/remote execute on the slot host, while local tmux/session-usage style commands stay on the orchestrator. Preserve script hard-fail behavior for missing project config; do not default through swallowed catches. For slow read-heavy verbs, validate with the real `farmslot --url` CLI rather than the 5s `cdp.mjs gateway` client.
- Never run emitting TypeScript builds that write `.js`, `.d.ts`, or `.map` files into source trees.
- **Interactive-mode terminal signal:** “operator-owned completion” does not mean withholding the worker terminal
  signal. In human-gate tasks, publish artifacts after explicit operator approval, then emit the normal terminal
  signal so Farmslot can record the held handoff. The operator makes the final disposition (merge, close, defer)
  — the signal is not a merge trigger, it is a completion acknowledgment.

## Recipe authoring pitfalls

- **Worktree REPO env-var:** `validate-recipe.sh` resolves `REPO_ROOT` from `FARMSLOT_SLOT_REPO` →
  `REPO` → script directory (primary checkout). For any manual invocation outside a hook, always
  export `FARMSLOT_SLOT_REPO=<worktree-path>` (or `REPO=<worktree-path>`) so the runner sees the
  branch under test, not the operator's primary checkout.
- **CDP Chrome is always required — even for `command`-only / backend-only recipes.** The Command
  Center recipe runner enables `app.hud` whenever the action is in the manifest. A recipe containing
  only `command` nodes still fails at HUD startup if no CDP Chrome is listening. Always run
  `bash apps/command-center/scripts/debug-chrome.sh` (or confirm Chrome is already listening on
  the configured CDP port) before any recipe run, regardless of platform.
- **`yarn farmslot` cold-start cost (~10–15 s per node):** a recipe with many `command` nodes that
  shell out via `yarn farmslot` will take 6–7 min even when the gateway RPC is fast. Prefer
  `node apps/command-center/scripts/cdp.mjs gateway <method> '<params>'` for gateway RPC
  assertions inside recipes; reserve `yarn farmslot` for CLI verbs that genuinely need the full
  CLI entry-point.
- **Recipe graphs are structurally immutable once execution starts.** `pause` suspends execution
  but does **not** re-open structural editing. The node list and edges are fixed at planning time.
  If you need to add or remove nodes after a run has begun, create a new `recipe.json` — do not
  attempt to edit the running graph.
- **`node -e` for inline proof scripts, not `node - <<'HEREDOC'`.** The heredoc form
  (`node - <<'HEREDOC' file`) does not populate `process.argv[1]` with `file`; only
  `node -e '...' -- "$file"` does. Use the `-e` form (or write a temp script file) whenever
  envelope or schema assertions read the target path from argv.
