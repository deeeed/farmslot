# `@farmslot/theme`

`@farmslot/theme` owns UI-neutral Farmslot presentation tokens: colors, flow labels, lifecycle colors, decision-kind colors, and runner colors.

It intentionally exports simple constants/functions instead of a component library. Product UI components belong in `apps/*`; service and protocol behavior belong elsewhere.

## Source layout

| File           | Owns                                                  |
| -------------- | ----------------------------------------------------- |
| `palette.ts`   | Base color tokens.                                    |
| `flow.ts`      | Flow-type colors and compact labels.                  |
| `lifecycle.ts` | Slot lifecycle colors.                                |
| `kind.ts`      | Decision/kind colors used by shared visual summaries. |
| `runner.ts`    | Runner identity colors.                               |
| `index.ts`     | Package export surface.                               |

## Maintenance rules

1. **Keep tokens semantic.** Prefer `statusOk` or `flowColor('fix-bug')` over app-specific color names.
2. **No components here.** Components, layout, CSS, and rendering behavior stay in the app that owns the surface.
3. **No protocol authority.** If a flow/lifecycle/runner value becomes contractual, define it in `@farmslot/protocol` and map it here for presentation.
4. **Keep exports explicit.** Add new token owners as focused files and export only the supported surface from `index.ts`.

## Local quality

```bash
yarn workspace @farmslot/theme quality
```
