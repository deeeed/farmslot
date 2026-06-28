# Changelog

All notable changes to `@farmslot/mobile` are tracked here.

## Unreleased

- Recipe proof HUD now renders above native modal presentations on iOS by wrapping it in `react-native-screens` `FullWindowOverlay` when available; falls back to the root view (occluded by native modals) when the dependency is absent.
- Show app version, variant, and native build on Settings for demos.
- Normalize duplicate imports so the repository-wide import hygiene rule can cover Companion.
- Active-development baseline; add user-facing changes here before release or package publication.
