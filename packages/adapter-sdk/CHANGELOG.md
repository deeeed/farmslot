# Changelog

All notable changes to `@farmslot/adapter-sdk` are tracked here.

## Unreleased

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.1.0 - 2026-10-04

- Add the platform adapter contract: `PlatformAdapter` and its member types, `defineAdapter`, and `createAdapterRegistry`. A registry refuses a duplicate id and any adapter written for another `sdkVersion`. Extracted from the metamask-harness adapter surface; a host extends `PlatformAdapter` with its own members.
- Publish with protocol 0.34.0 and recipe-runner 0.23.0.
