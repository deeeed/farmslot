# Changelog

All notable changes to `@farmslot/adapter-sdk` are tracked here.

## Unreleased

- Depend on `@farmslot/recipe-runner` (renamed from `@farmslot/recipe-harness`).
- Add the platform adapter contract: `PlatformAdapter` and its member types, `defineAdapter`, and `createAdapterRegistry`. A registry refuses a duplicate id and any adapter written for another `sdkVersion`. Extracted from the metamask-harness adapter surface; a host extends `PlatformAdapter` with its own members.
