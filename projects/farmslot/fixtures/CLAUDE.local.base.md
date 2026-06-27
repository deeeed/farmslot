# farmslot local guidance

- This demo project exists to validate Farmslot orchestration against the command-center workspace itself.
- Default prepare (`sandbox` / `attach`) starts **gateway + UI only** — no simulator, Metro, or companion app.
- Companion mobile (isolated sim/adb/Metro) is **opt-in** when the task touches `apps/companion`; see the
  companion-mobile agent fixture when `FLOW_TYPE` includes it.
- Prefer no-emit validation only:
  - `cd apps/command-center && yarn typecheck`
  - `cd apps/command-center && yarn exec tsx ../../services/gateway/src/*.test.ts`
- Command Center UI proof uses Recipe v1 + CDP (not typecheck alone):
  - Read `.sandbox/farmslot/agent/recipe-quality.md` after fixture sync.
  - Doctor: `node apps/command-center/scripts/agentic/recipe-doctor.mjs --cdp-port <cdp> --gateway-port <gateway> --json`
  - Run: `bash projects/farmslot/setup/validate-recipe.sh --recipe <recipe.json> --artifacts-dir <dir> --cdp-port <cdp> --gateway-port <gateway> --slot-id <slot>`
- Never run emitting TypeScript builds that write `.js`, `.d.ts`, or `.map` files into source trees.
