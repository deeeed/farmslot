# Changelog

All notable changes to `@farmslot/command-center-ui` are tracked here.

## Unreleased

- Clarify intelligence incidents copy for skipped monitor advisories (no false "Step timed out" or "Sent keys" wording).
- Add ready-gate-style tab navigation to the review gate (Review, Evidence, Quality, Recipe, Learnings) with `?tab=` URL sync.
- Load release notes from generated JSON at build time so What's New works in Vite dev and production builds.
- Show What's New modal on the auth gate screen as well as the connected shell.
- Active-development baseline; add user-facing changes here before release or package publication.

## 0.1.1 - 2026-07-02

- Add a What's New modal driven by release-cut release-notes.json when the built app version is newer than the last seen version
