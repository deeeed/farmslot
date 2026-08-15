# Command Center Scoped Instructions

These instructions apply to everything under `apps/command-center/`.

## Roadmap gate

- Do not build net-new command-center features unless they map to an existing roadmap item, PRD, or explicit user request.
- Bug fixes and verification work for the active slice are allowed.

## Required UI validation

- Every UI change must be validated in a real browser via **CDP**, not only by typecheck.
- Preferred controller browser launch:
  - `cd apps/command-center && yarn farmdev`
  - launch Chrome with:
    - `--remote-debugging-port=9323`
    - `--user-data-dir=~/.chrome-farmslot`
- Validate the relevant route in-browser and verify:
  - component renders
  - data loads
  - interactions work
  - no obvious console/runtime errors

## Preferred typecheck command

- For command-center validation, use:
  - `cd apps/command-center && yarn typecheck`
- Do **not** use `tsc -b` for routine validation in this repo.
- Reason: some workspace packages do not emit into a safe build dir, so emitting builds can leak `.js`, `.d.ts`, and `.map` files into source trees.

## Type reuse

- Reuse shared protocol types from `../../packages/protocol` instead of redefining shapes inline.
- If a type is used across packages, put it in `../../packages/protocol/src/types.ts`.

## Isolation-first development

- Prefer dev-harness/mock routes for UI-focused validation before or alongside gateway-integrated checks.
- Do not break bash-script coexistence while changing gateway behavior.
