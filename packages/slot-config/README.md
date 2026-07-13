# @farmslot/slot-config

Slot/pool/project config resolution and hook/template expansion — the
TypeScript decision core originally ported from `scripts/lib/slot-common.sh`.

Shared by the gateway (`services/gateway/src/core/{config,hooks}.ts` re-export
from here) and the CLI's gateway-free `farmslot internal …` verbs, so bash
lifecycle scripts and RPC paths expand the same `{{var}}` vocabulary from one
implementation.

## Source layout

| Path               | Owns                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`     | Public package export surface.                                                                                                                          |
| `src/config.ts`    | Pool/slot resolution (`resolveSlot`, `resolveSlotByRepo`, `loadSlotVars`), project config (`loadProjectVars`, `getProjectField`), validators.           |
| `src/hooks.ts`     | `{{var}}` template expansion (`expandTemplate`, `expandHook`, `expandDispatchCmd`, `expandRecycleCmd`, `expandPlatformField`, `renderFixtureTemplate`). |
| `src/repo-root.ts` | Farmslot checkout discovery (`FARMSLOT_ROOT` override + marker walk).                                                                                   |
| `src/error.ts`     | `SlotConfigError` — code/userAction/details, serialized by the gateway like `GatewayMethodError`.                                                       |
| `src/*.test.ts`    | Unit tests moved with the extraction.                                                                                                                   |

## Maintenance rules

1. **One `{{var}}` vocabulary.** Every placeholder added here must NOT be re-implemented in `scripts/lib/slot-common.sh` — scripts call `farmslot internal expand-template`/`expand-hook` instead.
2. **Gateway-free.** No gateway imports, no RPC, no long-lived state — this package must work when the gateway is down (`teardown-slot.sh` contract).
3. **Teach the escape.** Resolution failures throw `SlotConfigError` with a `userAction` naming the exact next command.
4. **Protocol types only.** Shared shapes come from `@farmslot/protocol`; do not fork schemas here.

## Local quality

```bash
yarn --cwd packages/slot-config quality   # prettier + eslint + tsc + tests
```
