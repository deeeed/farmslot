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

Connected Android/iOS dev builds expose React Native CDP through Metro (`GET /json/list` on the slot/worktree-configured `METRO_PORT`). For in-app state probes:

```bash
bash -c 'source scripts/agentic/agentic.conf && exec node scripts/agentic/cdp-eval.mjs "$@"' _ '({ dev: __DEV__ })'
```

For physical devices, the helper auto-tries loopback and LAN origins; override with `FARMSLOT_METRO_ORIGIN=http://<lan-ip>:$METRO_PORT` when needed.

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

## Jank check (every UI PR)

A PR that touches `apps/companion/src/**` runs the jank recipe on an Android device before review and attaches its report. CI has no device, so the run is part of the PR's recipe evidence.

```bash
# Device in the slot (ADB_SERIAL), the development variant installed, the gateway reachable.
GATEWAY_PORT=<slot port> METRO_PORT=<slot port> APP_VARIANT=development \
  ADB_SERIAL=<serial> FARMSLOT_RECIPE_APP_ID=net.siteed.farmslot.development \
  yarn recipe:run:jank:android --artifacts-dir <dir>
```

- It presses the four bottom tabs three times, scrolls the Review and Terminals lists and leaves Review idle on live data. Every flow is read-only on the gateway.
- `--param run_id=<id>` also opens that run from the Review queue and goes back (pick a run the queue shows; `none`, the default, skips it).
- `--param terminal_open=sandbox --param terminal_text=<row text>` also opens a terminal and goes back. Opening a terminal resizes its tmux pane, so run it only against a sandbox gateway (for example `projects/farmslot-farm/setup/sandbox-dev.sh start --gateway-port <port>`), never the live one.
- It fails when a flow sustains under 30 fps (lowest FPS over any 500 ms of rendering) or a tab press, from the touch to the mount frame that shows the tab (gfxinfo), is over 210 ms at p95 or 250 ms at most. 60 fps and 100 ms are the targets: reported, never failed on. Each failure names the metric, the limit, the measured value, the tab and main's baseline.
- Main's baseline is recorded in the recipe's end nodes: build 4da00ad80, Pixel 6 at 90 Hz, tab-press p95 159 ms and max 192 ms (worst of two release runs; per-tab values and first-frame counts included).
- Ratchet: when the median tab-press p95 of at least 3 fresh release runs on main is more than 20 ms under the recorded baseline (worst valid run, 158.9 ms), lower the caps by that margin and record the new baseline in the same change. One run cannot trigger it: two runs on the same build differed by 26 ms.
- The limits are recipe parameters; change them in `jank.recipe.json`'s `paramsSchema` defaults (with the baseline), not per run.
- Measure on a release build of the development variant (`APP_VARIANT=development`, `assembleRelease`) for budget numbers. A debug client runs it too; label those numbers as debug.
- Attach `<dir>/performance/report.md` (the per-flow table, with the display refresh rate of each flow) and the run package to the PR, with the head SHA it ran on.

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
