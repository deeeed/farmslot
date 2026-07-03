# Changelog

All notable changes to `@farmslot/mobile` are tracked here.

## Unreleased

- fix: pairing WebSocket failures on LAN gateway URLs explain when the gateway must listen on all interfaces.
- Add quick idea capture in the companion copilot flow.
- Render interactive operator packets on run detail with artifact anchors and auth-aware artifact links.
- Wire local Google Play service account symlink for non-interactive EAS Android submit.
- Route production Android submit to Play internal testing until the first production store release exists.

- Normalize duplicate imports so the repository-wide import hygiene rule can cover Companion.

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.2.0 - 2026-07-03

- Add a What's New modal on app launch when release-cut notes exist for a newer companion version.
- Recipe proof HUD now renders above native modal presentations on iOS by wrapping it in `react-native-screens` `FullWindowOverlay` when available; falls back to the root view (occluded by native modals) when the dependency is absent.
- Show app version, variant, and native build on Settings for demos.
