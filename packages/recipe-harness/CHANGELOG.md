# Changelog

All notable changes to `@farmslot/recipe-harness` are tracked here.

## Unreleased

## 0.2.2 - 2026-06-10

- Publish with npm-resolvable `@farmslot/protocol` dependency metadata instead of workspace-only protocol references.

## 0.2.1 - 2026-06-10

- Drive CDP text inputs with trusted keyboard insertion instead of direct DOM value assignment so React-controlled inputs receive real input/change handling.
- Drive CDP clicks with real mouse events and expose `ui.key_press` through the standard UI adapter.

## 0.2.0 - 2026-06-02

- Define the v0 public harness package surface with explicit core, adapter, node, CLI, and runtime entry points.
- Publish recipe runner runtime helpers under explicit `runtime/*` subpaths for browser extension, CDP, and React Native bridge clients.
- Keep CLI and writer implementation details behind explicit subpath exports instead of wildcard package exports.

## 0.1.0 - 2026-05-31

- Initial public active-development release.
