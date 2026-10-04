# Changelog

All notable changes to `@farmslot/adapter-sdk` are tracked here.

## Unreleased

- **BREAKING:** `PlatformAdapter` requires `launch(context: AdapterLaunchContext)`: the platform's part of `launch` after the host resolved the adapter, `--heal`, the checkout lock and the `--json-stream` envelope.
- Add optional `PlatformAdapter` members `detect` (match a checkout by `remote.origin.url` or files; any remote match beats any file match), `targets` (positional platform targets such as `ios` that also select the adapter), `flags` (boolean flags the platform adds to `launch` and the other commands) and `failurePatterns` (patterns that classify a failure for bounded healing).
- Add optional `devServer.portEnv`: more environment names the dev server reads its port from, set when a port is given explicitly.
- Add the shared types `AdapterLaunchContext`, `CommandEventStream` (the `--json-stream` events platforms emit: `phase`, `mutation`, `recovery`, `error`, `complete`), `HealPolicy`, `HealState`, `HealMutation` and `HealBoundViolation`.

## 0.1.0 - 2026-10-04

- Add the platform adapter contract: `PlatformAdapter` and its member types, `defineAdapter`, and `createAdapterRegistry`. A registry refuses a duplicate id and any adapter written for another `sdkVersion`. Extracted from the metamask-harness adapter surface; a host extends `PlatformAdapter` with its own members.
- Publish with protocol 0.34.0 and recipe-runner 0.23.0.
