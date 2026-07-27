# Changelog

All notable changes to `@farmslot/command-center-ui` are tracked here.

## Unreleased

- feat(ui): the roadmap screen lists items as single-line rows (stage, item id, title, backlog links, edit) instead of stacked cards, and the capture form is behind a `New item` button rather than permanently occupying the top of the page. Titles wrap instead of truncating. Project, target projects, tags and file path continue to show in the detail pane.
- fix(ui): show the backlog/roadmap item ref (`MANUAL-000055`, a Jira key, a PR ref) next to the title in the backlog list and detail, work-graph nodes, the execution overlay and the roadmap composer. Every surface previously rendered the ref only as a fallback for a missing title, so it disappeared exactly when the item was well-formed — and work-graph nodes fell back to the opaque backlogItemId uuid rather than the ref the CLI and specs actually use.
- feat: preview execution templates as an outline or exact source with provenance and optional selection guidance; keep selectors stable while catalogs refresh and remember domain, mode, and template choices per dispatch context.
- feat: select compatible execution templates by project, flow, mode, platform, and domain in the dispatch wizard.
- fix: show namespaced runtime evidence when inspecting nodes from a composed recipe dependency.
- feat: dispatch wizard candidate rows that FIND_SLOT would reject (branch ownership, missing companion resources) render disabled with a NOT ELIGIBLE badge and reason tooltip, are excluded from auto-pick, and suppress nudge/fresh actions (`DispatchCandidate.ineligibleReason`).

- refactor: unified independent-review language (MANUAL-000008) — review timeline, gate summary, ready-workspace modal/shell, dispatch wizard and dispatch-config surfaces label every automated pass **Independent review** (operator-requested passes as _Independent review (requested)_); runner diversity renders as policy metadata (`runner: <id>` / `runner diversity`) via the new `reviewPolicyLabel` helper instead of the retired _External review_ / _Extra review_ kinds. Persisted decision-action ids are unchanged.

- feat: the backlog panel status filter is a multi-select chip set (was single-select), defaulting to the live view — candidate/ready/queued/dispatching/running/failed/needs-attention visible, done/archived opt-in. The selection round-trips through the `backlogStatus` hash param (comma-separated, canonical order; default writes no param; legacy single-status links still parse).

- fix: PR cards render path-skipped CI checks with the `statusUnknown` dot instead of the pending color, and CI-timeout recovery / auto-resolve no longer require `passed === total` — skipped checks count toward the total but do not block a green verdict. Persisted ci-watch summaries carry the `skipped` count through snapshot reload.
- feat: flow selector, run filters, and flow-graph executor-lane labels render the renamed `update-branch` branch-maintenance flow (was `merge-main` / "Merge Main").
- fix: filter nested-loop task progress by active checklist basename so self-review panels do not accept stale events during fix or CI-fix phases; clear progress when `activeTaskFile` changes and label fix vs review progress from the protocol checklist registry.

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.3.0 - 2026-07-13

- fix: slot lifecycle actions are unavailable for ghost slots missing from live pools (dev-harness gallery gained a ghost card)
- feat: add a Slot View reviewer tab that surfaces worker/reviewer context and mock review context data
- feat: add Slot View controls to reconcile runtime state and restore worker tmux sessions after gateway crashes
- feat: operator manual Dispatch enqueues a work-graph node even when its backlog item has autoDispatch off; the work-graph side panel now scrolls with its content

## 0.2.2 - 2026-07-09

- feat: backlog archive/delete/restore actions with a confirm guard; archived items are hidden from the default backlog list but stay reachable via the explicit `archived` status filter
- feat: add `grok-4.5-fast-xhigh` to the Cursor Agent model picker alongside default `composer-2.5`
- fix: lead the browser-blocked (https origin, insecure `ws://` gateway) disconnected message with the one-time `farmslot certs setup` + `farmslot up` fix that makes the gateway reachable over `wss://`, keeping the local-http-origin workaround as a secondary fallback
- fix: show Mark ready for failed and needs-attention backlog items so operators can clear stale run linkage without editing state files
- fix: reset failed graph-linked backlog items to `ready` when their run is deleted or missing, and retry graph enqueue when a prior completed scheduler ledger entry is stale
- fix: stop the gateway connection from spinning a doomed reconnect loop when the only candidate is an insecure `ws://` endpoint reached from an https origin (Chrome 150 blocks these as mixed content, including localhost); detect that state up front, tear down WebSocket listeners between retries so they no longer accumulate, and show a state-aware disconnected message that distinguishes a browser-blocked origin (open the Command Center from a local origin, or use a `wss://` gateway) from a gateway that is simply down (`farmslot up`, check `~/.farmslot/gateway.log`)

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
