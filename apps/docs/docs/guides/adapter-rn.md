---
title: React Native adapter (Expo)
---

# React Native adapter (Expo)

`@farmslot/adapter-rn` is the convenience Expo/React Native package on top of `@farmslot/recipe-runner`. It does not define a separate protocol or custom base actions; it scaffolds an Expo app so it can use the same Recipe Protocol v1 and official harness actions as other Farmslot-compatible projects. The Companion app in this repository is the canonical Expo example.

For backend, CLI, library, or other non-UI projects, start with the
[Headless Recipe integration](./headless-recipe.md) guide instead.

The generated files use **Recipe Protocol v1**, but paths and package scripts are intentionally versionless:

```text
scripts/agentic/recipe/
yarn recipe:doctor
yarn recipe:validate
yarn recipe:dry-run
yarn recipe:run
```

That keeps app code stable when the protocol evolves.

## How it composes with Farmslot

- `@farmslot/protocol` defines Recipe Protocol v1 schemas, official action names, and artifact contracts.
- `@farmslot/recipe-runner` implements the generic runner, official core/UI actions, and CDP/React Native transport helpers.
- `@farmslot/adapter-rn` wraps those pieces for Expo projects by installing scripts, a default manifest/recipe, and optional dev-only bridge/HUD components.

That means Expo projects should not reimplement generic actions like `ui.press`, `ui.set_input`, `ui.scroll`, `app.hud`, or `app.status`. Add only project/domain actions in the app-specific layer when the official actions are not enough.

## Install into an Expo app

```bash
yarn add -D @farmslot/adapter-rn @farmslot/recipe-runner @farmslot/protocol
farmslot-adapter-rn init
yarn recipe:doctor
```

The package manager resolves the current published versions. Do not use the Yarn workspace protocol outside the Farmslot monorepo; it only works for local workspace packages.

## Default mode: headless and safe

The default scaffold declares only actions it can execute immediately:

- `command`
- `assert_output`
- `wait`
- `end`

This is enough to prove the runner, recipe validation, and artifact package without requiring app changes.

```bash
yarn recipe:validate
yarn recipe:dry-run
yarn recipe:run
```

`recipe:dry-run` still runs core/headless commands; it only stubs live UI, CDP,
and app bridge actions. Command output is sanitized before recipe artifacts are
written so public Expo config secrets do not leak into `trace.json`.

Recipes that execute Metro-backed actions such as `app.status`, `app.hud`, or
`app.trace` must set `FARMSLOT_RECIPE_METRO_PORT` or `METRO_PORT` to the
assigned port (1–65535). `FARMSLOT_RECIPE_METRO_PORT` takes precedence. There
is no default port or `WATCHER_PORT` fallback. The port is resolved only when a
Metro-backed action runs, so headless and native-only recipes do not need it.

When asserting command output that may be redacted, prefer stable substrings or structured fields over exact pretty-printed JSON whitespace.

## Optional dev-only bridge and HUD

If a project wants in-app status or a human-readable HUD, install the bridge scaffold:

```bash
farmslot-adapter-rn init --with-bridge
```

Then wrap the app root:

```tsx
import { RecipeBridgeProvider } from './src/farmslot';

export default function App() {
  return <RecipeBridgeProvider>{/* app */}</RecipeBridgeProvider>;
}
```

The generated provider is guarded by both:

- `__DEV__`
- `EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE=1`

The bridge and HUD are copied into local source files by design, so each app can customize `bridgeName`, bridge enablement, or HUD rendering without forking `@farmslot/recipe-runner`. Farmslot Companion uses this path as the in-repo Expo example: it keeps the generated `src/farmslot/` bridge local and wraps the root layout with `RecipeBridgeProvider`.

The HUD contract is deliberately strict: one concise intent line for the human from the current recipe node. Avoid repeating action names, node IDs, or debug noise in the visible text.

Run `yarn recipe:doctor` after enabling bridge actions. The doctor fails if the manifest declares app/HUD actions but the bridge provider is missing or not dev-gated.

## Performance capture (Android)

`app.performance_capture` measures native UI frames on the slot's Android device. It polls `adb shell dumpsys gfxinfo <FARMSLOT_RECIPE_APP_ID> framestats`, so the app needs no patch and the build can be a release one. Declare it in the project manifest with `"execution_capabilities": []` and the runner registers it:

```json
{
  "action": "app.performance_capture",
  "phase": "start",
  "id": "tab-presses",
  "intent": "Start measuring the tab presses.",
  "next": "press-review"
}
```

- `phase: "start"` opens a window. One window is open at a time.
- `phase: "end"` closes it and writes `performance/<id>-summary.json`: the frame summary (`activeFps`, p50/p95/p99, `longestFrameMs`, `overBudgetFramePercent`, `refreshRateHz`), `sustainedFps`, and the latency of every `ui.press` and `ui.key_press` inside the window, overall and per press target. An optional `budget` (`min_sustained_fps`, `max_press_p95_ms`, `max_press_ms`, `min_frames`) gives the window a verdict; optional `targets` (`fps`, `press_ms`) are reported, never failed on. An optional `baseline` (`label`, `sustained_fps`, `press_p95_ms`, `press_max_ms`, `frames`, `refresh_hz`, plus any fields to keep) is echoed in the summary and quoted in each failure; a measured refresh rate more than 5% off `refresh_hz` is noted. A window with a coverage gap (a failed poll, frames gfxinfo overwrote between polls, an overrun `max_duration_ms`) is `inconclusive` whatever else it failed, never a pass: a lost device would otherwise read as missing frames or untimed presses. A window that rendered nothing and has no gap (an idle screen) passes.
- `phase: "report"` writes `performance/report.json` and `report.md`: the device (model, Android release, serial), the app (package, version, debug or release build, install time), the checkout's HEAD, and one row per window with its refresh rate. It fails the node when a window broke its budget, or with an environment cause when one is inconclusive. Each failure names the metric, the limit, the measured value, where, and the baseline: `press p95 (gfxinfo input->mount frame) 231 ms > 210 ms (tab-presses; slowest companion-tab-terminals 262 ms); main 4da00ad80 @90Hz baseline p95 159 ms`. Bind the recipe's proof to an `assert_output` on the report's `$.verdict`.

How the numbers are read:

- **Sustained FPS** is recipe-runner's `lowestWindowedFps`: the lowest frame rate over any `sustained_window_ms` (500 ms by default) of continuous rendering. Frames less than 100 ms apart (or a gap that a slow frame explains) are one stretch, so a slow cadence such as every fourth vsync at 90 Hz (22.5 fps) counts, and so do steady slow frames however few fit in a window. A window counts only when its stretch lasts the whole window: a short burst or an idle screen has no sustained FPS and does not fail.
- **Press latency** runs from the first frame that handled the touch to the end of the frame that answered it: the first later frame within 1.5 `response_window_ms` (900 ms by default) that stands out, with at least 4 ms of UI-thread work and either a whole frame budget of it or three times the median of the other frames in reach. That is the frame that mounts and draws the new screen. It answers even after a pause, so a mount a JavaScript stall delays reads as slow, never as instant. Touch ripples run on the render thread and are not counted. Only when no frame in reach stands out is the press timed to the first frame within `response_window_ms` and marked `first-frame`; the new screen did no measurable UI-thread work. A press with no input frame or no frame after it is untimed, and `max_press_ms` fails it. On devices before Android 12, framestats has no `InputEventId` column and every press is untimed with that reason. Each window also writes `performance/<id>-frames.json`, the frames and node spans the latencies were read from.

Run performance recipes with video off (`--record-video=off --recording-reason=...`): `screenrecord`'s encoder competes with the app for the frames being measured. Hosts that open their own capture windows (mm-harness) import the sources from `@farmslot/adapter-rn/performance-observer`: `createAndroidGfxinfoPerformanceBackend({ serial, packageId, adbPath })` and, for a CDP host such as Hermes on iOS, `createReactNativeTracePerformanceBackend(client, { kind, platform, markerPrefix })`.

## Farmslot hook

Expose the runner through a thin project hook:

```json
{
  "hooks": {
    "recipe_run": "bash scripts/agentic/validate-recipe.sh --recipe {{recipe_path}} --artifacts-dir {{artifacts_dir}} --platform {{platform}} --metro-port {{port}}"
  }
}
```

The reusable behavior belongs in `@farmslot/adapter-rn`. Project-specific behavior belongs in small domain manifests and bridge actions owned by that project.

## Quality rules

- Keep manifests small and discoverable.
- Prefer one parameterized custom action over many near-duplicates.
- Never add task-specific or ticket-specific actions to reusable manifests.
- Use official UI actions only when the proof should show real user-visible interaction.
- Use commands/controllers for setup, diagnostics, or non-visual checks.
- Fail closed when live bridge support is unavailable.
