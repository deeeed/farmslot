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
