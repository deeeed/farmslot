# @farmslot/adapter-sdk

The platform adapter contract for recipe harnesses. A platform adapter owns everything one
target kind needs (ports, readiness, logs, the action set, install/verify/cleanup, recording and
diagnostics), so the commands that drive it never compare adapter ids.

```ts
import { createAdapterRegistry, defineAdapter } from '@farmslot/adapter-sdk';

const web = defineAdapter({ id: 'web', sdkVersion: 1, headless: false /* … */ });
const registry = createAdapterRegistry();
registry.register(web);
registry.get('web');
```

A host extends `PlatformAdapter` with its own members and types its registry with that:
`createAdapterRegistry<HostAdapter>()`. A registry refuses a duplicate id and any adapter whose
`sdkVersion` differs from `ADAPTER_SDK_VERSION`.

Docs: https://farmslot.io/docs/reference/adapter-sdk

## Recorded evidence

`createDefaultRecipeEngine` owns recording, claim derivation and cleanup for both SDK hosts and
the recipe CLI. A provider supplies `recording.target` and an optional platform `videoRecorder`;
recipes declare expectations through `proofTargets` and node `proves`. UI recipes record by
default. State-only headless recipes acquire no recorder. Explicit recording off requires a reason.

Hosted callers supply `recordingAdmission` once to the factory. The public
`createRuntimeCapabilityRecordingAdmission(authority, owner)` delegates to the existing runtime
capability acquire/release RPCs. The runner validates and freezes the provider target before
acquisition, then passes that same identity to capture. It releases its owned lease on stop,
cancellation or failed start, and preserves an idempotently reused lease.

`validateRecordedEvidencePackage` from `@farmslot/adapter-sdk/evidence` is portable. Readers supply
the retained recipe, execution inputs, trace, summary, claims, resolved dependencies, timelines and
actual-byte media digests. An invalid package cannot supply proof. A valid legacy package remains
explicitly untimed; validation does not invent a verdict or certify that a gate is satisfied.

Breaking migration: the engine factory/options move from `@farmslot/recipe-cli/harness` to this
package. Other supported harness exports remain. Recorder results contain ordered original
`segments`; string-prefixed device targets and the separate framed lifecycle are removed. Adopt
the typed target and shared lifecycle in one coordinated release, with no compatibility aliases.
See [ADR-062](../../docs/adr/062-recorded-run-evidence.md) and its
[specification](../../docs/reference/recorded-run-evidence.md).

## Source layout

| path                         | owns                                                          |
| ---------------------------- | ------------------------------------------------------------- |
| `src/types.ts`               | `PlatformAdapter`, its member types and `ADAPTER_SDK_VERSION` |
| `src/registry.ts`            | `defineAdapter` and `createAdapterRegistry`                   |
| `src/engine.ts`              | Shared recipe engine factory and executable host contracts    |
| `src/recording-admission.ts` | Bridge to the existing lease authority                        |
| `src/evidence.ts`            | Portable retained-package validation                          |

## Maintenance rules

- Keep capture and verdict derivation in the shared runner; the SDK composes providers and hosts.
- No platform or product names. A behavior one platform needs becomes an optional member.
- Removing or renaming a member is a breaking change: bump `ADAPTER_SDK_VERSION`.

## Local quality

```sh
yarn workspace @farmslot/adapter-sdk quality
```
