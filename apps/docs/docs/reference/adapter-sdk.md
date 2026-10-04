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
  // hints, actions, harness, runtimeContext; optional reload, recording,
  // diagnostics, sourceFingerprint
});

const registry = createAdapterRegistry<PlatformAdapter>();
registry.register(web);
```

## Members

| member                                                        | owns                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `id`, `sdkVersion`, `headless`                                | registry key and `--adapter` value; SDK version; whether the platform runs an app or dev server |
| `resolveSlotPorts(target)`                                    | slot ports and device into the environment                                                      |
| `runtimeStatus(target)`                                       | read-only readiness for `doctor`                                                                |
| `devServer`                                                   | label, description and `stop` for the platform's dev server                                     |
| `logSources(target)`, `appLogSource(target)`                  | the log files `logs` tails                                                                      |
| `hints`                                                       | platform-phrased next steps                                                                     |
| `actions`                                                     | the bundled action manifest, live-script rules, the `cdp.target` probe and the `ui.*` transport |
| `harness`                                                     | `install`, `verify` and `cleanup` leaves                                                        |
| `runtimeContext`                                              | what the platform records in `agentic-runtime.json`                                             |
| `reload?`, `recording?`, `diagnostics?`, `sourceFingerprint?` | optional run support                                                                            |

## Rules

- A host extends `PlatformAdapter` with its own members and types its registry with that type.
- `register` refuses a duplicate id, an empty id, and any `sdkVersion` other than `ADAPTER_SDK_VERSION`.
- A behavior one platform needs is an optional member, not a command branch.
