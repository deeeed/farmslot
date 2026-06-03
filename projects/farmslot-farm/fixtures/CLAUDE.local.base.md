# farmslot-farm local guidance

- This demo project exists to validate Farmslot orchestration against the command-center workspace itself.
- Prefer no-emit validation only:
  - `cd apps/command-center && yarn typecheck`
  - `cd apps/command-center && yarn exec tsx ../../services/gateway/src/*.test.ts`
- Never run emitting TypeScript builds that write `.js`, `.d.ts`, or `.map` files into source trees.
