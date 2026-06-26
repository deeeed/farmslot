# Changelog

All notable changes to `@farmslot/recipe-harness` are tracked here.

## Unreleased

- Document `orchestrateRuntimeUp` `build` decision as terminal — hosts must call again after native build finishes.

## 0.3.1 - 2026-06-26

- Add `runtime/orchestrate-up` — generic install → relaunch decision loop (`orchestrateRuntimeUp`) for product runners to wrap with shell/platform actions.

## 0.3.0 - 2026-06-26

- Add shared runtime-readiness helpers under `@farmslot/recipe-harness/runtime/*`:
  - `deps-readiness` — install fingerprint, baseline recording, product-marker partial checks, decision state persistence
  - `log-analysis` — Metro/RN bundle log boundaries, unresolved-module scoping, persistent bundle-error detection
  - `metro-probe` — packager `/status` reachability probe
  - `decision-types` — portable `RuntimeDecisionReport` / `RuntimeDecisionAction` shapes
- Product runners (e.g. MetaMask) should import these modules instead of copying readiness logic locally.

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
