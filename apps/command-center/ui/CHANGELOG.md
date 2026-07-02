# Changelog

All notable changes to `@farmslot/command-center-ui` are tracked here.

## Unreleased

- Hide alpha nav items (Intelligence, Evals, and other `maturity: 'alpha'` routes) from the menu and block direct hash navigation to them by default in production (shown by default on a dev launch); toggle via the new Config > Settings "Show alpha features" switch.
- Add ready-gate-style tab navigation to the review gate (Review, Evidence, Quality, Recipe, Learnings) with `?tab=` URL sync.
- Load release notes from generated JSON at build time so What's New works in Vite dev and production builds.
- Show What's New modal on the auth gate screen as well as the connected shell.
- Rename the team overlay concept to "domain" across the UI (labels, params, dispatch selection) to match the engine's domain abstraction.
- Active-development baseline; add user-facing changes here before release or package publication.

## 0.1.1 - 2026-07-02

- Add a What's New modal driven by release-cut release-notes.json when the built app version is newer than the last seen version
