---
title: Adapter SDK
---

# Adapter SDK

`@farmslot/adapter-sdk` defines the contract a recipe harness drives a platform through. A platform adapter owns everything one target kind needs, so the harness commands (`launch`, `doctor`, `logs`, `run`, `install`, `verify`, `cleanup`) never branch on the adapter id.

```ts
import { createAdapterRegistry, defineAdapter, type PlatformAdapter } from '@farmslot/adapter-sdk';

export const web = defineAdapter({
  id: 'web',
  sdkVersion: 1,
  headless: false,
  // resolveSlotPorts, runtimeStatus, devServer, logSources, appLogSource,
  // hints, actions, harness, runtimeContext, launch; optional reload, detect,
  // targets, flags, failurePatterns, run, recording, diagnostics, observation,
  // sourceFingerprint
});

const registry = createAdapterRegistry<PlatformAdapter>();
registry.register(web);
```

## Members

| member                                            | owns                                                                                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `sdkVersion`, `headless`                    | registry key and `--adapter` value; SDK version; whether the platform runs an app or dev server                                                                         |
| `resolveSlotPorts(target)`                        | slot ports and device into the environment                                                                                                                              |
| `runtimeStatus(target)`                           | read-only readiness for `doctor`                                                                                                                                        |
| `devServer`                                       | label, description, `stop` and extra port env names (`portEnv?`)                                                                                                        |
| `logSources(target)`, `appLogSource(target)`      | the log files `logs` tails                                                                                                                                              |
| `hints`                                           | platform-phrased next steps                                                                                                                                             |
| `actions`                                         | the bundled action manifest, live-script rules, the `cdp.target` probe and the `ui.*` transport                                                                         |
| `harness`                                         | `install`, `verify` and `cleanup` leaves                                                                                                                                |
| `runtimeContext`                                  | what the platform records in `agentic-runtime.json`                                                                                                                     |
| `launch(context)`                                 | the platform's part of `launch`, after the host resolved the adapter, `--heal` and the lock                                                                             |
| `detect?`                                         | recognise the platform's checkout by `remote.origin.url` or by its files                                                                                                |
| `targets?`                                        | positional platform targets (`launch ios`) that also select the adapter as `--platform`                                                                                 |
| `flags?`                                          | boolean flags the platform adds to `launch` and to the other commands                                                                                                   |
| `failurePatterns?`                                | output patterns that classify a failure for bounded healing                                                                                                             |
| `run?`                                            | what `run` and `call` need: the platform's run options (`platformOptions`), env, runtime prep and checks, the browser it drove (`launchedBrowser`, `browserProvenance`) |
| `recording?`                                      | the `--record-video` target; `framed` names the browser pid and the env var actions read it from (`activePidEnv`)                                                       |
| `diagnostics?`                                    | the console collector, a request log read from the run's start (`requestLog`), the in-app issue buffer                                                                  |
| `observation?`                                    | network capture around a run (`network.backend`, `network.actions` for `app.network_capture`/`app.network_assert`) and the performance observer (`performance.start`)   |
| `reload?`, `sourceFingerprint?`                   | optional run support                                                                                                                                                    |
| `extends?`                                        | the adapter this one composes on (a library plugin's `extends`)                                                                                                         |
| `doctor?(target)`                                 | platform checks `doctor` reports after the shared ones (`AdapterDoctorCheck`)                                                                                           |
| `readiness?`                                      | what `doctor`, `status` and `prepare` ask the platform (`AdapterReadiness`): checks, `--fix` repairs, the `--print-ready` indicator, devices, `prepare` hooks           |
| `actions.manifestPaths?()`, `actions.adapters?()` | every action manifest the platform declares, parent first; action implementations the platform ships in code                                                            |

## Rules

- A host extends `PlatformAdapter` with its own members and types its registry with that type.
- `PlatformAdapter<TPlatform, TBrowser>` types the platform's own run options and browser record. `run` members are methods, so such an adapter still registers in a registry of plain `PlatformAdapter`.
- `register` refuses a duplicate id, an empty id, and any `sdkVersion` other than `ADAPTER_SDK_VERSION`.
- A behavior one platform needs is an optional member, not a command branch.
- Detection: any adapter's remote match beats any adapter's file match; within a pass, registration order decides.
- Observation: the host owns the run's network session (the automatic whole-run capture and the `app.network_capture` windows); the platform supplies the capture backend. `performance.start` returns a `RunObserver` that sees every node event and writes its artifacts when the run ends.
- Failure classes are tested in order (capture-protected, environment, transport-first, wallet state, transport) against every registered adapter's patterns; an unmatched failure is app logic and is never healed. `captureProtected` and `environment` carry the platform's message and next step: an environment match (a missing runtime dependency or build output) is reported as `ENVIRONMENT_NOT_READY` and never healed.
- Recording: `run`, `run --plan` and `call` check the adapter's own `recording` member. On an adapter without it they refuse `--record-video` before recipe execution (`run` any mode but `off`; `call` the bare `--record-video`/`--record` flag, since it reads an inline `--record-video=<mode>` after the action as an action input): `RECORDING_UNSUPPORTED`, exit 2, with a next step: rerun without `--record-video`, or use the adapter's own screenshot action or an adapter that records. A host that supplies its own `recording.targetProvider` to the runner for such an adapter is refused too. A run that still reaches the missing target (a programmatic caller that skips this check) fails with the same code and exit 4, not as app logic.
- Library plugins: a recipe library declares adapters in `recipe-library.json` `adapters` (`{ "<id>": { "module", "export"?, "extends"? } }`). A host loads one only when a command selects it (`@farmslot/recipe-cli/harness` `ensureAdapterLoaded`): the module must resolve inside the library root, export an adapter whose `id` is the declared key and whose `sdkVersion` is `ADAPTER_SDK_VERSION`, and may not reuse a built-in id or one another library declares. A plain object is a valid adapter; `defineAdapter` is optional.
- `extends`: the child's members replace the parent's, except `actions.manifestPaths`, `actions.adapters` and `doctor`, which append to the parent's, and `readiness`, which merges member by member. A plugin that extends an adapter inherits the members it doesn't declare; one that extends nothing declares every required member. Its live action scripts fall back to each ancestor's: within each actions root, all of the child's files (`<actions>/<child>/…`) come first, then the parent's (roots keep a built-in's order, so an operator's `RECIPE_LIVE_ADAPTER_DIR` still comes first), with `shared/` in the order a built-in uses. Recipe variants (`recipes/<platform>/`) do not follow `extends`.
- Trust: plugins load only from the operator's libraries (`--library`, the `RECIPE_LIBRARY_PATH` the operator set or else the personal library, and the libraries the host configures; pass `env` with the operator's environment when the host extends `RECIPE_LIBRARY_PATH` itself), never from a task-local library or a host-discovered one, so loading one is trusted like installing it: its top level and lifecycle members run without a recipe approval. The actions a plugin ships in code carry the plugin's digest (`adapterPlugin(id).digest`: its library, the files under its module's directory, the library's `actions/`, and its parent plugin's digest), so an approved plan no longer matches once that code changes, and the plugin may import from disk only those files (a `module.registerHooks` resolve hook; Node.js 22.15 or later). Bare packages resolve from the host's install, and scripts a plugin starts as processes must live in its module directory, where the digest covers them. `adapterPluginChecks()` names each loaded plugin, its library and digest for `doctor`. See [the recipe library manifest](./recipe-discovery.md#adapter-plugins-and-trust) for the exact rules, and ADR risk 5 (trust boundary for plugins).
- The SDK also defines the types the host and platforms share: `AdapterLaunchContext`, `CommandEventStream`, `HealPolicy`, `HealState`, `HealBoundViolation`, and for runs `CommandOptions`, `RecipeRunOptions`, `RecipeNodeEvent`, `AdapterBrowser`, `AdapterRunPrepareContext`, `AdapterDependencyBlock`, `AdapterLogFinding`, `RunObserver` and `NetworkCaptureBackend`.
