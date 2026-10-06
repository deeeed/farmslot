# Changelog

All notable changes to `@farmslot/adapter-sdk` are tracked here.

## Unreleased

- Active-development baseline; add user-facing changes here before release or package publication.

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
