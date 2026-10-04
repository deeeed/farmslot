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

## Source layout

| path              | owns                                                          |
| ----------------- | ------------------------------------------------------------- |
| `src/types.ts`    | `PlatformAdapter`, its member types and `ADAPTER_SDK_VERSION` |
| `src/registry.ts` | `defineAdapter` and `createAdapterRegistry`                   |

## Maintenance rules

- Types first. The only runtime code is the registry and its shape check.
- No platform or product names. A behavior one platform needs becomes an optional member.
- Removing or renaming a member is a breaking change: bump `ADAPTER_SDK_VERSION`.

## Local quality

```sh
yarn workspace @farmslot/adapter-sdk quality
```
