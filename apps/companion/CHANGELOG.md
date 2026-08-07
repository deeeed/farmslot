# Changelog

All notable changes to `@farmslot/mobile` are tracked here.

## Unreleased

- fix(pairing): reject mixed-code multi-address QRs before exchanging any credential.
- fix(pairing): exchange a multi-address QR once so every imported profile shares one revocable device credential.
- chore(deps): upgrade Companion to Expo SDK 57 / React Native 0.86 (expo@57.0.10, aligned expo-\* modules via `expo install --fix`).
- chore: store-screenshot demo PR data carries the new `skipped` CI check-summary count (protocol `PRStatus.checkSummary` gained the field).
- Route production Android submit to Play internal testing until the first production store release exists.

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.3.0 - 2026-08-06

- fix(sync): trust complete run-decision projections, coalesce fallback reconciliation for malformed or incomplete retrospective events, and offer an explicit retry for decision sync timeouts
- fix(ux-catalog): model Review, Terminals, Advanced, and Settings as sibling bottom-tab roots in the generated navigation map
- feat(companion): generate recipe-derived, optionally focused UX review boards with a typed navigation map, hierarchical Ready Gate subscreens, overall notes, and normalized point or area annotations
- feat(companion): add a LAN-proven backlog capture sheet plus an offline iOS/Android UX catalog for the main workspaces, run packages, and decision gates
- feat(companion): add a resettable dev-only continuous-gesture proof surface and one target-parameterized recipe with repeatable before/after evidence
- fix(workflows): reuse shared decision actions and surface active independent-review/fix work in run details instead of a premature publication gate
- feat(companion): add foreground-aware gateway liveness, mixed-version fallback, bounded profile validation, explicit slot-derived Metro configuration, and recoverable connection-profile UX
- fix(companion): a slow Metro cold boot no longer latches its port into permanent prepare failure. The readiness marker is only written on success, so a boot that outran the wait left Metro running and unmarked, and every later attempt refused it as "unknown or different slot configuration" with the recovery kill unreachable. Our own unconfirmed session is now replaced, a timed-out boot is stopped instead of orphaned, and the wait is 120s and overridable via `METRO_READY_TIMEOUT_SECS`. A Metro this script did not start is still left alone
- Align embedded recipes and actions with the strict Action Manifest v1 contract
- Migrate embedded automation recipes and recipe UI terminology to parameterized, composable Recipe v1 documents
- feat: run filters render the renamed `update-branch` branch-maintenance flow (was `merge-main`), and normalize a legacy persisted `merge-main` filter selection to `update-branch` on load so the saved filter still matches runs
- Add an executable native settings recipe using the slot-assigned simulator and keep warm Metro services alive after profile preparation
- Add passive UI observation handling to the Companion recipe bridge
- Add Enter to Companion tmux shortcuts and a native terminal history view toggle
- Enable pinch zoom, pan, and double-tap reset in Companion fullscreen image viewers
- fix: pairing WebSocket failures on LAN gateway URLs explain when the gateway must listen on all interfaces
- Add quick idea capture in the companion copilot flow
- Render interactive operator packets on run detail with artifact anchors and auth-aware artifact links
- Wire local Google Play service account symlink for non-interactive EAS Android submit
- Normalize duplicate imports so the repository-wide import hygiene rule can cover Companion

## 0.2.0 - 2026-07-03

- Add a What's New modal on app launch when release-cut notes exist for a newer companion version.
- Recipe proof HUD now renders above native modal presentations on iOS by wrapping it in `react-native-screens` `FullWindowOverlay` when available; falls back to the root view (occluded by native modals) when the dependency is absent.
- Show app version, variant, and native build on Settings for demos.
