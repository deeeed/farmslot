# Changelog

All notable changes to `@farmslot/adapter-sdk` are tracked here.

## Unreleased

## 0.8.6 - 2026-10-11

- Align published runtime dependencies with recipe-runner 0.29.0 for shared cancellation and execution.

## 0.8.5 - 2026-10-11

- Align Farmslot runtime dependencies with protocol 0.37.0 and recipe-runner 0.28.5 so consumers resolve one copy of each package.

## 0.8.4 - 2026-10-10

- Publish with protocol 0.36.0 and recipe-runner 0.28.4 so consumers share one dependency copy. No code change.

## 0.8.3 - 2026-10-10

- `HealBoundViolation.retryable` (optional): an infra failure a caller may rerun as is. recipe-cli emits it as the violation's `retryable`.
- Publish with protocol 0.35.2 and recipe-runner 0.28.3 so consumers share one protocol and one recipe-runner copy.

## 0.8.2 - 2026-10-09

- Publish with protocol 0.35.1 and recipe-runner 0.28.2 so consumers share one protocol and one recipe-runner copy. No code change.

## 0.8.1 - 2026-10-09

- Publish with protocol 0.35.0 and recipe-runner 0.28.1 so consumers share one recipe-runner copy. No code change.

## 0.8.0 - 2026-10-09

- Add `adapterDetectFromSpec(spec)` and `AdapterDetectSpec`: the `AdapterDetect` predicates a recipe library's `detect` declaration describes. `remote` matches when the origin URL contains any entry; `files` matches when every path exists (a trailing `/` requires a directory) and package.json lists every `packageDependencies` entry. A path (package.json included) counts only when its real path stays inside the checkout, so a symlink out of it matches nothing.
- `PlatformAdapter.detect` documents the host rule recipe-cli now applies: any remote match beats any file match, an adapter beats one it extends, and more than one match left is ambiguous (it was registration order).
- Publish with protocol 0.35.0 and recipe-runner 0.28.0.

## 0.7.2 - 2026-10-09

- Publish with protocol 0.34.0 and recipe-runner 0.27.1 so consumers share one recipe-runner copy. No code change.

## 0.7.1 - 2026-10-08

- Publish with protocol 0.34.0 and recipe-runner 0.27.0 so consumers share one recipe-runner copy. No code change.

## 0.7.0 - 2026-10-08

- **BREAKING:** remove `devServer.portFlags`. `--watcher-port` is the one option that gives `run` and `call` the dev-server port; a platform names its port environment with `devServer.portEnv`.
- **BREAKING (implementers only):** `CommandEventStream` gains `stage(name, { index, total })`, a setup stage with `progress({ waitingFor, message, percent, current, total, unit, screen })`, `done(detail)` and `failed(detail)`. A platform calls it from `launch` to say what it is waiting for; the host prints it with the elapsed time and notes when nothing has changed for a while. It never fails the command. Another `CommandEventStream` implementation adds `stage: noopStage`. Also exports `StageHandle` and `StageProgress`.
- `AdapterReadiness.fixes[].apply` may return a promise; `doctor --fix` awaits it, so a long fix that works asynchronously keeps the stage heartbeat going. Synchronous fixes work as before.
- **BREAKING:** Add the optional `PlatformAdapter.readiness` member (`AdapterReadiness`): what `doctor`, `status` and `prepare` ask a platform: `checks`, `liveChecks`, `environment`, `lines`, `orphanDevServers`, `captureProviders`, `fixes`, `runtimeBlock`, `pinnedFlags`, `statusRuntime`, `readyIndicator` (the `doctor --print-ready` stdout), `devices` (`AdapterDevices`: one view, one live probe, their rendering) and `prepare` (`AdapterPrepare`: `clearMetro`, `devicePlatform`, `ambiguousTarget`). Also exports `AdapterDevice`, `AdapterDeviceView`, `AdapterDeviceLiveView`, `AdapterPaint` and `AdapterPinnedFlags`.
  - Breaking for host types only: a host type that extends `PlatformAdapter` and declares its own `readiness` member no longer compiles unless that member extends `AdapterReadiness`. Migrate by typing it as `AdapterReadiness & { … }` (or an interface that extends `AdapterReadiness`). Runtime behaviour is unchanged.
- Publish with protocol 0.34.0 and recipe-runner 0.26.0.

## 0.6.0 - 2026-10-07

- Add `AdapterFailurePatterns.environment` (`pattern`, `message`, `userAction`): a failure the target's environment causes (a missing runtime dependency or build output), which neither healing nor the app can fix.
- Publish with protocol 0.34.0 and recipe-runner 0.26.0.

## 0.5.1 - 2026-10-06

- Publish with protocol 0.34.0 and recipe-runner 0.26.0 so consumers share one recipe-runner copy.

## 0.5.0 - 2026-10-06

- **BREAKING:** `observation.performance.start` no longer receives `ports`. The run's ports are in `env`, which now carries the slot's ports, `--cdp-port`/`--watcher-port` and the platform's run environment. `run.runtimeCheck` also runs on the run's ports and environment.
- Add the optional members a library plugin needs: `PlatformAdapter.extends` (the adapter it composes on), `PlatformAdapter.doctor(target)` returning `AdapterDoctorCheck[]` (checks `doctor` reports after the shared ones), `actions.manifestPaths()` (every action manifest the platform declares, parent first) and `actions.adapters()` (action implementations shipped in code).
- Publish with protocol 0.34.0 and recipe-runner 0.25.0.

## 0.4.0 - 2026-10-05

- Add the optional `PlatformAdapter` member `observation` (`AdapterObservation`), moved from the metamask-harness surface: `network.backend(target, env, artifactsDir)` returns the platform's `NetworkCaptureBackend` and `network.actions` lets recipes call `app.network_capture`/`app.network_assert`; `performance.start(context)` returns a `RunObserver` (`onActionEvent`, `finalize`) for the run.
- Publish with protocol 0.34.0 and recipe-runner 0.24.0.

## 0.3.1 - 2026-10-05

- Publish with protocol 0.34.0 and recipe-runner 0.24.0 so consumers share one recipe-runner copy.

## 0.3.0 - 2026-10-05

- **BREAKING:** `AdapterRecording.framed` requires `activePidEnv`, the environment variable that names the recorded browser pid to actions while the recording runs.
- **BREAKING:** `AdapterDiagnostics.walletLog` is replaced by `requestLog: { path(projectRoot), findings(lines) }`; the platform turns its log lines into findings.
- Add the optional `PlatformAdapter` member `run` (`AdapterRun`), moved from the metamask-harness surface: what `run` and `call` need from a platform (`platformOptions`, `pinnedEnv`, `activateEnv`, `envKeys`, `childEnv`, `autoHud`, `teardown`, `prepareRuntime`, `runtimeCheck`, `dependencyBlock`, `violationUserAction`, `launchedBrowser`, `browserProvenance`). `PlatformAdapter<TPlatform, TBrowser>` and `AdapterRun<TPlatform, TBrowser>` take the platform's own run options and browser record as type parameters; `run` members are methods, so such an adapter still fits a registry of `PlatformAdapter`.
- Add the run types `CommandOptions`, `RecipeNodeEvent`, `RecipeRunOptions<TPlatform>`, `AdapterBrowser`, `AdapterRunPrepareContext`, `AdapterDependencyBlock` and `AdapterLogFinding`.
- Add optional `devServer.portFlags`: option names that give the dev-server port to `run` and `call` after `--watcher-port`.
- Publish with protocol 0.34.0 and recipe-runner 0.23.0.

## 0.2.0 - 2026-10-04

- **BREAKING:** `PlatformAdapter` requires `launch(context: AdapterLaunchContext)`: the platform's part of `launch` after the host resolved the adapter, `--heal`, the checkout lock and the `--json-stream` envelope.
- Add optional `PlatformAdapter` members `detect` (match a checkout by `remote.origin.url` or files; any remote match beats any file match), `targets` (positional platform targets such as `ios` that also select the adapter), `flags` (boolean flags the platform adds to `launch` and the other commands) and `failurePatterns` (patterns that classify a failure for bounded healing).
- Add optional `devServer.portEnv`: more environment names the dev server reads its port from, set when a port is given explicitly.
- Add the shared types `AdapterLaunchContext`, `CommandEventStream` (the `--json-stream` events platforms emit: `phase`, `mutation`, `recovery`, `error`, `complete`), `HealPolicy`, `HealState`, `HealMutation` and `HealBoundViolation`.
- Publish with protocol 0.34.0 and recipe-runner 0.23.0.

## 0.1.0 - 2026-10-04

- Add the platform adapter contract: `PlatformAdapter` and its member types, `defineAdapter`, and `createAdapterRegistry`. A registry refuses a duplicate id and any adapter written for another `sdkVersion`. Extracted from the metamask-harness adapter surface; a host extends `PlatformAdapter` with its own members.
- Publish with protocol 0.34.0 and recipe-runner 0.23.0.
