# Changelog

All notable changes to `@farmslot/expo-recipe` are tracked here.

## Unreleased

## 0.4.1 - 2026-08-01

- Require an explicit Metro bridge port only when a recipe executes Metro-backed UI actions.
- Publish against `@farmslot/recipe-harness` 0.11.1 so Expo consumers receive idempotent iOS lifecycle restarts.

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
