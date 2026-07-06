# Changelog

All notable changes to `@farmslot/command-center-ui` are tracked here.

## Unreleased

- fix: filter nested-loop task progress by active checklist basename so self-review panels do not accept stale events during fix or CI-fix phases; clear progress when `activeTaskFile` changes and label fix vs review progress from the protocol checklist registry.
- fix: show Mark ready for failed and needs-attention backlog items so operators can clear stale run linkage without editing state files.
- fix: reset failed graph-linked backlog items to `ready` when their run is deleted or missing, and retry graph enqueue when a prior completed scheduler ledger entry is stale.
- Active-development baseline; add user-facing changes here before release or package publication.

## 0.2.1 - 2026-07-03

- Warn and block Companion LAN QR generation when the gateway is loopback-only.
- Surface linked run summaries in roadmap, backlog, and work-graph detail views, and highlight pinned slots when their linked run is selected.
- Improve roadmap, backlog, and work-graph planning UX with shared dispatch configuration controls and spec review modals.
- Render interactive operator packets on run detail with artifact anchors and confirmed actions.
- Add an experimental Slot View worker History tab that renders runner-owned transcript turns with run, model, and session metadata.

## 0.2.0 - 2026-07-03

- Speed up slot-view terminal attach on deep links by mounting the terminal when `slotId` is known, debouncing target churn, and preferring fleet-bound runs over stale URL pins during hydration.
- Skip redundant `tmux.worker.list` polls while node inventory pushes are fresh and back off on list RPC errors.
- Hide alpha nav items (Intelligence, Evals, and other `maturity: 'alpha'` routes) from the menu and block direct hash navigation to them by default in production (shown by default on a dev launch); toggle via the new Config > Settings "Show alpha features" switch.
- Add ready-gate-style tab navigation to the review gate (Review, Evidence, Quality, Recipe, Learnings) with `?tab=` URL sync.
- Load release notes from generated JSON at build time so What's New works in Vite dev and production builds.
- Show What's New modal on the auth gate screen as well as the connected shell.
- Rename the team overlay concept to "domain" across the UI (labels, params, dispatch selection) to match the engine's domain abstraction.

## 0.1.1 - 2026-07-02

- Add a What's New modal driven by release-cut release-notes.json when the built app version is newer than the last seen version
