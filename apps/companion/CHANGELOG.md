# Changelog

All notable changes to `@farmslot/mobile` are tracked here.

## Unreleased

- Migrate embedded automation recipes and recipe UI terminology to parameterized, composable Recipe v1 documents.
- chore: store-screenshot demo PR data carries the new `skipped` CI check-summary count (protocol `PRStatus.checkSummary` gained the field).
- feat: run filters render the renamed `update-branch` branch-maintenance flow (was `merge-main`), and normalize a legacy persisted `merge-main` filter selection to `update-branch` on load so the saved filter still matches runs.
- Add an executable native settings recipe using the slot-assigned simulator and keep warm Metro services alive after profile preparation.
- Add passive UI observation handling to the Companion recipe bridge.
- Add Enter to Companion tmux shortcuts and a native terminal history view toggle.
- Enable pinch zoom, pan, and double-tap reset in Companion fullscreen image viewers.
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
