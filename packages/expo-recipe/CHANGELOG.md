# Changelog

All notable changes to `@farmslot/expo-recipe` are tracked here.

## Unreleased

## 0.7.2 - 2026-08-14

- fix: route standard Back, Escape, Enter, and Return key presses through the native device keyboard on opaque Android and iOS runtimes, then wait for the resulting UI transition.
- fix: verify Android `ui.set_input` replacement, preserve exact whitespace, distinguish labels from values, and prove masked-field clearing before retrying.

## 0.7.1 - 2026-08-03

- fix: expose the canonical native UI action set from the package root so consumers can verify provider capability wiring without duplicating it.

## 0.7.0 - 2026-08-03

- fix: make native full-surface capture reliably target explicit scroll views, tolerate dropped iOS swipes, and stop at the requested end marker.
- feat: add opt-in `ui.capture_surface` support for native Expo recipes, including targetable scroll surfaces, bounded full-height stitching, virtualized-list end detection, and position restoration. Publish against `@farmslot/protocol` 0.18.0 and `@farmslot/recipe-harness` 0.14.0.

## 0.6.0 - 2026-08-02

- feat: drive swipe, pan, drag, and `hold_ms` long-press recipe actions through the assigned native device, select Android devices by ADB serial, retry failed tool/device discovery, reject unsupported native paths before execution, and retain resolved coordinate phases. Publish against `@farmslot/protocol` 0.16.0 and `@farmslot/recipe-harness` 0.12.0.

## 0.5.0 - 2026-08-01

- **BREAKING:** Remove the `WATCHER_PORT` fallback and implicit port `7677`; Metro-backed actions now require `FARMSLOT_RECIPE_METRO_PORT` or `METRO_PORT` set to an integer from 1 through 65535. Port resolution remains lazy, so headless and native-only runs do not require either variable.
- Publish against `@farmslot/protocol` 0.15.0 and `@farmslot/recipe-harness` 0.11.1 so Expo consumers receive structured suite evidence and idempotent iOS lifecycle restarts.

## 0.4.0 - 2026-07-24

- Accept root recipe parameters and task-local composed recipes.
- Enforce assigned-device context for native actions anywhere in the resolved recipe graph.
- Generate strict keyed Action Manifest v1 templates.

## 0.3.0 - 2026-07-19

- Security: recipe runs honor inherited source provenance before device actions

## 0.2.0 - 2026-07-12

- Drive Expo and React Native recipe UI actions through Agent Device on the simulator or device assigned by Farmslot, including passive native UI observations and screenshot artifacts.

## 0.1.2 - 2026-07-09

- chore: stamp the generated Expo config recipe with the canonical Recipe Protocol v1 `$schema` URL.

## 0.1.1

- Make the generated HUD compact, wrapping, and configurable for client apps.

## 0.1.0

- Initial public release of the Expo recipe adapter, CLI, and template assets.
