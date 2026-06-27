# farmslot-farm local guidance

- This demo project exists to validate Farmslot orchestration against the command-center workspace itself.
- Default prepare (`sandbox` / `attach`) starts **gateway + UI only** — no simulator, Metro, or companion app.
- Companion mobile (isolated sim/adb/Metro) is **opt-in** when the task touches `apps/companion`; see the
  companion-mobile agent fixture when `FLOW_TYPE` includes it.
- Prefer no-emit validation only:
  - `cd apps/command-center && yarn typecheck`
  - `cd apps/command-center && yarn exec tsx ../../services/gateway/src/*.test.ts`
- Never run emitting TypeScript builds that write `.js`, `.d.ts`, or `.map` files into source trees.
