# Mobile Companion — Agent Instructions

Read [docs/plans/companion-ui-architecture-refactor.md](../../docs/plans/companion-ui-architecture-refactor.md) for the full refactor plan. These rules apply to all companion work now, even before the refactor lands.

## Product context

- **PRD:** [docs/PRD-mobile-companion-canonical.md](../../docs/PRD-mobile-companion-canonical.md)
- **Roadmap:** Structural work sits under [ROADMAP-next.md](../../docs/ROADMAP-next.md) operator UI/UX stabilization (item 1)
- **Protocol:** Use `@farmslot/protocol` types — do not redefine gateway payloads inline

## Architecture (target)

```
app/<route>.tsx          → parse params, one controller hook, render *Screen
features/<feature>/
  use-*-controller.ts  → fetch, subscribe, refresh, view model
  *Screen.tsx            → layout only
  components/            → presentational
  styles/                → StyleSheet modules
lib/                     → pure domain (tested, no React)
store/                   → global session only (fleet, decisions, connection)
components/              → app-wide primitives shared across features
```

## Hard rules

### Route files stay thin

`src/app/**/*.tsx` (except `_layout.tsx` bootstrap) must **not** contain:

- `useEffect` (move to controllers)
- `client.request` / `client.subscribe` (move to controllers)
- `StyleSheet.create` (move to `features/*/styles/` or `components/`)
- Business logic beyond param parsing

Target: **< 150 LOC** per route after refactor; **< 100 LOC** for workspace routes.

### One hook per screen

```tsx
const screen = useSlotWorkspaceController(params);
```

The screen component receives `viewModel` + `actions` only. No gateway access in JSX trees.

### Domain logic stays in `lib/`

Before adding logic to a controller or component, check `src/lib/`. Controllers orchestrate; `lib/` transforms. Add unit tests in `lib/` for pure rules.

### No swallowed errors

Match repo-wide rule: do not `catch` and ignore. Controllers surface `status: 'error'` with a message and `actions.refresh`.

### Shared workspace UI

Slot, family, and decision workspaces share cockpit/evidence/gate patterns. New workspace UI goes in `features/workspace-shared/` unless truly feature-specific.

## Adding a new screen

1. Create `features/<name>/use-<name>-controller.ts` with typed `ScreenState` (`loading` | `error` | `ready`).
2. Create `features/<name>/<Name>Screen.tsx` — layout composition only.
3. Split UI into `features/<name>/components/` (< 350 LOC each).
4. Add `features/<name>/styles/` for StyleSheet modules.
5. Route file: params → controller → screen shell.
6. Add controller test with mocked `GatewayClient` **or** extend expo recipe smoke for the primary path.

## Verification

```bash
cd apps/companion
yarn typecheck
yarn test:lib
```

For navigation/workspace changes, run the relevant expo recipe smoke (see plan verification matrix).

UI changes that affect operator flows need manual or recipe validation on a connected gateway — typecheck alone is insufficient.

## File size

CI thresholds (`yarn quality:structure:ci`, `--scope all`, blocking):

| Path                                              | Max LOC |
| ------------------------------------------------- | ------- |
| `src/app/**` workspace routes (not tabs/\_layout) | 200     |
| `src/features/**/**Screen.tsx`                    | 2100    |
| `src/features/**/use-*-controller.ts`             | 1500    |
| `src/features/workspace-shared/**`                | 300     |

Panel files (`*-panels.tsx`) warn at 500 LOC — split over time, not CI-blocking yet.

## Recipe validation (device)

Headless scaffold check:

```bash
yarn recipe:validate
yarn recipe:run
```

Live bridge smoke against a connected Android/iOS dev build:

```bash
# Metro must be running with recipe relay middleware (restart Metro after metro.config.js changes).
# Dev client must be launched with EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE=1 (run-android.sh / start.sh set this).
yarn recipe:run:bridge
```

Legacy warn thresholds for non-workspace paths until PR 2 migration:

| Path                                  | Max LOC |
| ------------------------------------- | ------- |
| `src/app/**/*.tsx`                    | 200     |
| `src/features/**/components/*.tsx`    | 350     |
| `src/features/**/use-*-controller.ts` | 500     |

If you must exceed temporarily, note it in the PR and link a follow-up issue — do not grow god files silently.

## Do not

- Rewrite `src/lib/` during UI refactors
- Add Redux or new global state libraries without plan approval
- Duplicate slot/family cockpit or evidence components
- Add gateway methods from companion UI work
- Inject UI state to fake validation (match repo no-UI-injection rule)

## Reference implementation

When the refactor lands, copy patterns from:

- `features/slot-workspace/` — canonical workspace controller
- `features/workspace-shared/` — shared panels and hooks
- `src/app/(tabs)/inbox.tsx` — acceptable list screen (store-driven, smaller components)

Command Center analogue: `apps/command-center/ui/src/components/slot-view/` breakup per [CODE_QUALITY.md](../command-center/CODE_QUALITY.md).
