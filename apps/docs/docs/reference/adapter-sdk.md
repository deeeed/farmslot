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

| member                                       | owns                                                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `sdkVersion`, `headless`               | registry key and `--adapter` value; SDK version; whether the platform runs an app or dev server                                                                         |
| `resolveSlotPorts(target)`                   | slot ports and device into the environment                                                                                                                              |
| `runtimeStatus(target)`                      | read-only readiness for `doctor`                                                                                                                                        |
| `devServer`                                  | label, description, `stop`, extra port env names (`portEnv?`) and port options (`portFlags?`)                                                                           |
| `logSources(target)`, `appLogSource(target)` | the log files `logs` tails                                                                                                                                              |
| `hints`                                      | platform-phrased next steps                                                                                                                                             |
| `actions`                                    | the bundled action manifest, live-script rules, the `cdp.target` probe and the `ui.*` transport                                                                         |
| `harness`                                    | `install`, `verify` and `cleanup` leaves                                                                                                                                |
| `runtimeContext`                             | what the platform records in `agentic-runtime.json`                                                                                                                     |
| `launch(context)`                            | the platform's part of `launch`, after the host resolved the adapter, `--heal` and the lock                                                                             |
| `detect?`                                    | recognise the platform's checkout by `remote.origin.url` or by its files                                                                                                |
| `targets?`                                   | positional platform targets (`launch ios`) that also select the adapter as `--platform`                                                                                 |
| `flags?`                                     | boolean flags the platform adds to `launch` and to the other commands                                                                                                   |
| `failurePatterns?`                           | output patterns that classify a failure for bounded healing                                                                                                             |
| `run?`                                       | what `run` and `call` need: the platform's run options (`platformOptions`), env, runtime prep and checks, the browser it drove (`launchedBrowser`, `browserProvenance`) |
| `recording?`                                 | the `--record-video` target; `framed` names the browser pid and the env var actions read it from (`activePidEnv`)                                                       |
| `diagnostics?`                               | the console collector, a request log read from the run's start (`requestLog`), the in-app issue buffer                                                                  |
| `observation?`                               | network capture around a run (`network.backend`, `network.actions` for `app.network_capture`/`app.network_assert`) and the performance observer (`performance.start`)   |
| `reload?`, `sourceFingerprint?`              | optional run support                                                                                                                                                    |

## Rules

- A host extends `PlatformAdapter` with its own members and types its registry with that type.
- `PlatformAdapter<TPlatform, TBrowser>` types the platform's own run options and browser record. `run` members are methods, so such an adapter still registers in a registry of plain `PlatformAdapter`.
- `register` refuses a duplicate id, an empty id, and any `sdkVersion` other than `ADAPTER_SDK_VERSION`.
- A behavior one platform needs is an optional member, not a command branch.
- Detection: any adapter's remote match beats any adapter's file match; within a pass, registration order decides.
- Observation: the host owns the run's network session (the automatic whole-run capture and the `app.network_capture` windows); the platform supplies the capture backend. `performance.start` returns a `RunObserver` that sees every node event and writes its artifacts when the run ends.
- Failure classes are tested in order (capture-protected, transport-first, wallet state, transport) against every registered adapter's patterns; an unmatched failure is app logic and is never healed.
- The SDK also defines the types the host and platforms share: `AdapterLaunchContext`, `CommandEventStream`, `HealPolicy`, `HealState`, `HealBoundViolation`, and for runs `CommandOptions`, `RecipeRunOptions`, `RecipeNodeEvent`, `AdapterBrowser`, `AdapterRunPrepareContext`, `AdapterDependencyBlock`, `AdapterLogFinding`, `RunObserver` and `NetworkCaptureBackend`.
