# Changelog

All notable changes to `@farmslot/adapter-rn` (published as `@farmslot/expo-recipe` up to 0.14.0) are tracked here.

## Unreleased

## 0.19.10 - 2026-10-11

- Align published runtime dependencies with recipe-runner 0.29.0 for shared cancellation and execution.

## 0.19.9 - 2026-10-11

- Align Farmslot runtime dependencies with protocol 0.37.0 and recipe-runner 0.28.5 so consumers resolve one copy of each package.

## 0.19.8 - 2026-10-10

- Publish with protocol 0.36.0 and recipe-runner 0.28.4 so consumers share one dependency copy. No code change.

## 0.19.7 - 2026-10-10

- Publish with protocol 0.35.2 and recipe-runner 0.28.3 so consumers share one protocol and one recipe-runner copy. No code change.

## 0.19.6 - 2026-10-09

- `hasMatchingRoute` and `matchesBridgeTarget` accept the manufacturer-prefixed name a physical Android device reports in its bridge snapshot ("Google Pixel 6a" for the pin "Pixel 6a"). They accepted only the Metro form ("Pixel 6a - 17 - API 37"), so wait-for-bridge never saw the Pixel 6a as ready and launch failed after its full timeout. The model must be whole trailing words ("Pixel 6" does not match "Google Pixel 6a"), the serial must not be an `emulator-` serial, and two manufacturer-prefixed entries on one Metro (counting one that has not reported a platform yet) count as no match. `manufacturerNameMatches(deviceName, androidName, adbSerial)` is exported so mm-harness applies the same rule.
- Publish with protocol 0.35.1 and recipe-runner 0.28.2.

## 0.19.5 - 2026-10-09

- Publish with protocol 0.35.1 and recipe-runner 0.28.2 so consumers share one protocol and one recipe-runner copy. No code change.

## 0.19.4 - 2026-10-09

- Publish with protocol 0.35.0 and recipe-runner 0.28.1 so consumers share one recipe-runner copy. No code change.

## 0.19.3 - 2026-10-09

- Publish with protocol 0.35.0 and recipe-runner 0.28.0 so consumers share one protocol and one recipe-runner copy. No code change.

## 0.19.2 - 2026-10-09

- Publish with protocol 0.34.0 and recipe-runner 0.27.1 so consumers share one recipe-runner copy. No code change.

## 0.19.1 - 2026-10-08

- Publish with protocol 0.34.0 and recipe-runner 0.27.0 so consumers share one recipe-runner copy. No code change.

## 0.19.0 - 2026-10-08

- Add `metroBundleProgress(line)`: the percent and module counts of a Metro or Expo bundle progress line, ready for a stage's `progress`.
- Publish with protocol 0.34.0 and recipe-runner 0.26.0.

## 0.18.0 - 2026-10-06

- **Breaking:** `summarizeFrames`, `FrameSample` and `FrameMetricSummary` are no longer exported from the index. They moved to `@farmslot/recipe-runner/runtime/cdp-trace`, unchanged; import them from there.
- Publish with protocol 0.34.0 and recipe-runner 0.26.0.

## 0.17.1 - 2026-10-06

- Publish with protocol 0.34.0 and recipe-runner 0.25.0 so consumers share one recipe-runner copy.

## 0.17.0 - 2026-10-05

- Add `bridge-runtime/bridge-core.cjs`, the generic Hermes CDP bridge CLI moved from mm-harness. `runBridgeCli(config)` runs the built-in commands (navigation, eval, UI gestures and input, scrolling and scroll-transition timing, Sentry debug, HUD steps, profiler, in-app issues, network capture), target selection over the CDP broker or a direct connection, the debugger-slot lock and typed errors. The host supplies its own commands, route table, recovery hints, help lines, perf markers and readiness check; a host command that reuses a built-in name throws at startup. The iOS and Android key and tap fallbacks read `RECIPE_RN_IDB_PATH` / `RECIPE_RN_ADB_PATH`.
- Publish with protocol 0.34.0 and recipe-runner 0.24.0.

## 0.16.0 - 2026-10-05

- Add the generic React Native runtime, moved from mm-harness:
  - **Bridge runtime:** the Hermes CDP libraries in `bridge-runtime/lib/*.cjs` (target discovery, ws client, devtools proxy, eval, error codes, port config, console format, in-app issue buffer snippets) and `bridge-runtime/console-forwarder.cjs`.
  - **Metro:** the config wrapper, detached launcher and log helpers in `metro/*.cjs`.
  - **From the index:** adb/idb discovery (`resolveMobileToolPath`, overridable with `RECIPE_RN_ADB_PATH`/`RECIPE_RN_IDB_PATH`), `listConnectedDevices`, the Android and iOS-simulator video recorders, `summarizeFrames`, and Metro-env and source fingerprints with recorded baselines. The project supplies the input lists and marker paths. Hosts set `RECIPE_RN_EXPLICIT_PLATFORM` and `RECIPE_RN_METRO_*` for the bridge and the Metro wrapper.
- `--help` and `doctor` now print "Farmslot React Native adapter" (they still said "Farmslot Expo Recipe").
- Publish with protocol 0.34.0 and recipe-runner 0.24.0.

## 0.15.0 - 2026-10-05

- **Breaking:** renamed from `@farmslot/expo-recipe`, with no alias package. The bin is now `farmslot-adapter-rn` (was `farmslot-expo-recipe`), and `init` writes `recipe:*` scripts that call it. Run provenance and the bundled recipe source report `@farmslot/adapter-rn`. `runExpoRecipeCli` and `EXPO_RECIPE_PACKAGE_VERSIONS` are now `runAdapterRnCli` and `ADAPTER_RN_PACKAGE_VERSIONS`. Expo-specific APIs (`installExpoRecipeScaffold`, `runExpoRecipeDoctor`, `runExpoRecipeDocument`, …) keep their names.
- Publish with protocol 0.34.0 and recipe-runner 0.23.0.

## 0.14.0 - 2026-10-04

- Depend on `@farmslot/recipe-runner` (renamed from `@farmslot/recipe-harness`).
- Publish with protocol 0.34.0 and recipe-runner 0.23.0.

## 0.13.1 - 2026-10-03

- Publish with recipe-harness 0.22.1 so consumers share one recipe-harness copy.

## 0.13.0 - 2026-10-02

- Provide `@farmslot/expo-recipe` to recipe libraries that declare it in `requires`.
- Publish with protocol 0.34.0 and recipe-harness 0.22.0 so consumers share one protocol and runtime.

## 0.12.2 - 2026-09-29

- Publish with protocol 0.33.0 and recipe-harness 0.21.1 so consumers share one protocol and runtime.

## 0.12.1 - 2026-09-28

- Publish against protocol 0.32.0 and recipe-harness 0.20.0 so downstream installs share one protocol and recording runtime.

## 0.12.0 - 2026-09-27

- Agent Device `ui.scroll` maps one-axis `delta_x`/`delta_y` to a relative direction and pixel scroll, and rejects absolute `offset_x`/`offset_y` instead of ignoring them.

## 0.11.0 - 2026-09-20

- Published against `@farmslot/protocol` 0.30.0 so one protocol copy serves every dependent (child checklist units and the acceptance ledger arrive through that pin).

## 0.10.0 - 2026-09-18

- Publish against `@farmslot/protocol` 0.29.0 so downstream installs resolve one protocol version.

## 0.9.2 - 2026-09-17

- Publish against `@farmslot/protocol` 0.28.0 so a consumer that also installs `@farmslot/agent-runtime` 0.10.0 resolves one protocol copy.

## 0.9.1 - 2026-09-13

- Publish against `@farmslot/protocol` 0.26.0 so a consumer that also installs `@farmslot/agent-runtime` 0.9.0 resolves one protocol copy.

## 0.9.0 - 2026-09-07

- Expose transport-owned `open()` so native consumers can inspect before interacting without reopening the same session; pair it with `close()`.

## 0.8.2 - 2026-08-14

- fix: require `test_id` for verifiable Android input replacement, retry empty placeholders with bounded chunked clearing, and fail closed when the field cannot be observed.
- fix: send `Back` through native navigation, require observable keyboard effects for `Escape`, `Enter`, and `Return` on Android and iOS, and honor the recipe node timeout while waiting for the resulting UI to settle.

## 0.8.1 - 2026-08-14

- Publish against `@farmslot/recipe-harness` 0.15.0 so consumers use one Recipe Protocol 0.21.0 runtime.

## 0.8.0 - 2026-08-14

- fix: route standard Back, Escape, Enter, and Return key presses through the native device keyboard on opaque Android and iOS runtimes, then wait for the resulting UI transition.
- fix: verify Android `ui.set_input` replacement, preserve exact whitespace, distinguish labels from values, and prove masked-field clearing before retrying.
- Publish against `@farmslot/protocol` 0.21.

## 0.7.1 - 2026-08-03

- fix: expose the canonical native UI action set from the package root so consumers can verify provider capability wiring without duplicating it.

## 0.7.0 - 2026-08-03

- fix: make native full-surface capture reliably target explicit scroll views, tolerate dropped iOS swipes, and stop at the requested end marker.
- feat: add opt-in `ui.capture_surface` support for native Expo recipes, including targetable scroll surfaces, bounded full-height stitching, virtualized-list end detection, and position restoration. Publish against `@farmslot/protocol` 0.18.0 and `@farmslot/recipe-harness` 0.14.0.

## 0.6.0 - 2026-08-02

- feat: drive swipe, pan, drag, and `hold_ms` long-press recipe actions through the assigned native device, select Android devices by ADB serial, retry failed tool/device discovery, reject unsupported native paths before execution, and retain resolved coordinate phases. Publish against `@farmslot/protocol` 0.16.0 and `@farmslot/recipe-harness` 0.12.0.

## 0.5.0 - 2026-08-01

- **BREAKING:** Remove the `WATCHER_PORT` fallback and implicit port `7677`; Metro-backed actions now require `FARMSLOT_RECIPE_METRO_PORT` or `METRO_PORT` set to an integer from 1 through 65535. Port resolution remains lazy, so headless and native-only runs do not require either variable.
- Publish against `@farmslot/protocol` 0.15.0 and `@farmslot/recipe-harness` 0.11.1 so Expo consumers receive structured suite evidence and idempotent iOS lifecycle restarts.

## 0.4.0 - 2026-07-24

- Accept root recipe parameters and task-local composed recipes.
- Enforce assigned-device context for native actions anywhere in the resolved recipe graph.
- Generate strict keyed Action Manifest v1 templates.

## 0.3.0 - 2026-07-19

- Security: recipe runs honor inherited source provenance before device actions

## 0.2.0 - 2026-07-12

- Drive Expo and React Native recipe UI actions through Agent Device on the simulator or device assigned by Farmslot, including passive native UI observations and screenshot artifacts.

## 0.1.2 - 2026-07-09

- chore: stamp the generated Expo config recipe with the canonical Recipe Protocol v1 `$schema` URL.

## 0.1.1

- Make the generated HUD compact, wrapping, and configurable for client apps.

## 0.1.0

- Initial public release of the Expo recipe adapter, CLI, and template assets.
