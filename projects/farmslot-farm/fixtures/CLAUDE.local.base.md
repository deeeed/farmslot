# farmslot local guidance

- This demo project exists to validate Farmslot orchestration against the command-center workspace itself.
- Default prepare (`sandbox` / `attach`) starts **gateway + UI only** — no simulator, Metro, or companion app.
- Companion mobile (isolated sim/adb/Metro) is **opt-in** when the task touches `apps/companion`; see the
  companion-mobile agent fixture when `FLOW_TYPE` includes it.
- Prefer no-emit validation only:
  - `cd apps/command-center && yarn typecheck`
  - `cd apps/command-center && yarn exec tsx ../../services/gateway/src/*.test.ts`
- Command Center UI proof uses Recipe v1 + CDP (not typecheck alone):
  - Read `.sandbox/farmslot-farm/agent/recipe-quality.md` after fixture sync (workers).
  - Reviewers also read `.sandbox/farmslot-farm/agent/review-quality.md` and apply `fs-recipe-quality`.
  - Doctor: `node apps/command-center/scripts/agentic/recipe-doctor.mjs --cdp-port <cdp> --gateway-port <gateway> --json`
  - Run: `bash projects/farmslot-farm/setup/validate-recipe.sh --recipe <recipe.json> --artifacts-dir <dir> --cdp-port <cdp> --gateway-port <gateway> --slot-id <slot>`
- Slot helper/script verb ports that shell out belong in gateway methods routed through `route-method.ts` when they need `execOnSlot` / `execLocal`; do not hide connected-node exec behind `@farmslot/slot-config` or `farmslot internal`.
  Match the original script locality: commands previously wrapped in `run_on`/remote execute on the slot host, while local tmux/session-usage style commands stay on the orchestrator. Preserve script hard-fail behavior for missing project config; do not default through swallowed catches. For slow read-heavy verbs, validate with the real `farmslot --url` CLI rather than the 5s `cdp.mjs gateway` client.
- Never run emitting TypeScript builds that write `.js`, `.d.ts`, or `.map` files into source trees.
