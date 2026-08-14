# Changelog

All notable changes to `@farmslot/command-center-ui` are tracked here.

## Unreleased

- fix(review): follow the authoritative active task across retained review/fix rounds, select the reviewer-authored recommendation after artifact refresh, show per-step timing for each round, and collapse directory mirrors to one clearable aggregate transfer.
- feat(copilot): configure and persist the shared runtime runner, model, and gateway autostart policy from the existing drawer.
- feat(slot-view): show planned/acquired runtime capabilities with cost, owner, health, provider provenance, release effects, and an operator release control.
- fix(runners): default Cursor Agent selections to `cursor-grok-4.6-high-fast` and expose the current 4.6 choices.
- fix(review): render review workspaces and the slot source tree from the frozen reviewed SHAs, so later base or PR movement cannot inflate or replace the operator's diff.
- feat(copilot): evolve the existing drawer with shared runtime lifecycle, runner/model/tier, tmux/checkout metadata, pressure visibility, explicit stop/reconnect, and bound dangerous-start confirmation.
- fix(runs): expose Cancel for recoverable blocked runs and Delete for terminal runs directly in run details, reusing the gateway lifecycle used by Manage Runs.
- fix(slot-view): decouple terminal window navigation, primary-worker TASK progress, and reviewer history selection; remove the resize redraw nudge that left duplicate tmux status rows.
- fix(slot-view): remove the redundant agent-context strip above the live terminal; tmux's native window controls remain the single navigation surface.
- fix(review): show reviewer transport failures as "did not run" with their delivery reason instead of presenting them as zero-finding reviews.
- fix(review): present review checks as ordered rounds with intervening worker fixes, let operators switch between chronological and reviewer-grouped history, distinguish stale or undelivered findings, and open nested review diffs above the history before restoring its prior view.

## 0.6.1 - 2026-08-11

- fix(pairing): let operators select the gateway profiles encoded in Companion pairing QR codes, invalidate stale QR codes when pairing inputs change, default to one LAN address instead of syncing every detected interface, choose existing principals from the gateway inventory, and revoke active device credentials from the same access panel.

## 0.6.0 - 2026-08-10

- fix(backlog): share backlog metadata and dispatch controls across create/edit, with explicit run mode and project-owned template selection; keep descriptive metadata editable after execution while locking dispatch ownership.
- fix(backlog): require an owner under multi-project creation scope and clear project-owned dispatch fields when that owner changes.
- fix(transfer): mini pipeline package-refresh segment uses the same purpose filter as the full renderer so finalize uploads and release-artifact mirrors are not misattributed (MANUAL-000095 self-review).
- fix(transfer): bind package-refresh vs finalize pipeline nodes to distinct transfer purposes so one run transfer cannot animate both (MANUAL-000095 self-review).
- fix(transfer): lazy-load gateway in the transfer store (Node renderer tests), resync banner/mini pipeline when runId/run changes, and never swallow listener exceptions (MANUAL-000095 self-review).
- fix(transfer): strict run-scoped pipeline filter (no unscoped bleed), pure model helpers for unit tests, and surface listener errors instead of empty catch (MANUAL-000095 self-review).
- feat(transfer): show live file-transfer progress on the pipeline package-refresh and publish nodes (and mini bar titles), plus a strip under the canvas while a transfer is running for that run (MANUAL-000095).
- feat(transfer): cancel control, multi-file counts, run-detail inline transfer panel (MANUAL-000095 follow-up).
- feat(transfer): determinate file-transfer progress banner (filename, bytes/percent, phase, failed) driven by `file.transfer.progress` events (MANUAL-000095).
- feat(decisions): render learnings-draft cards — domain antipattern drafts with target paths, teaching holds, and the inbox receipt status (MANUAL-000075).
- feat(dispatch): replace the execution-template pills with a reusable filterable catalog picker — Domain/Run-mode filters with visible result counts, per-row source/domain/platform/digest provenance, filter-named empty states, and loud domain-restricted/unavailable source notices (MANUAL-000076).
- style(runs): reformat run-detail-model and review-gate-display test to satisfy the repo Prettier gate (no behavior change).
- fix(runs): allow a blocked run that still holds a slot and has no unresolved operator decisions to replay its pipeline after review recovery, and show the pending worker-fix/re-review phases for exhausted review loops whose findings were never delivered.
- feat(pairing): choose scoped existing-principal or new service-principal authority when creating a pairing code.
- fix(pairing): encode one shared pairing code across every advertised gateway address instead of minting address-specific credentials.
- fix(auth): preserve password-mode transport compatibility with Basic auth on fetch requests and an explicit password query only for headerless resources, without treating passwords as bearer tokens.
- fix(review): default new review requests to a fresh session and report trusted passing, unresolved, and stale-ignored counts in the review-flow modal.
- feat(review): let operators continue same-run reviewer context or start fresh when requesting each independent review, and make package refresh plus the review/rework path explicit in the pre-publication cockpit.
- fix(review): visualize each findings → worker fix → re-review sequence in the shared ready-gate timeline and stop presenting zero-change handoffs as worker fixes.
- feat(review): default PR reviews to static validation and render the prior-review generation, reviewed head, findings, and evidence before continuation.
- feat(review): render the shared cross-generation review chain and reviewer-session continuity in run details.
- fix(runs): show publication review recovery status and its operator-required error in the existing run pipeline details.
- fix(terminal): bind and unbind the terminal's capture-phase image-paste listener on connect/disconnect rather than on first render and terminal disposal, so image paste survives a DOM move or an xterm re-initialization; the non-image Cmd+V path sends through the same unguarded sender as every other intercepted key combo again.
- fix(terminal): pin each image attachment to the terminal target it was added on, hide attachments on worker terminals where the protocol cannot serve them, consume unsupported file drops instead of letting the browser navigate away, and cap the attachment tray height.
- feat(terminal): paste (Ctrl+V/Cmd+V) or drag-and-drop an image onto a slot terminal to attach it to the running worker, with a card showing thumbnail, filename, size, determinate upload progress, distinct upload vs runner-delivery states, retry, and remove.

## 0.5.0 - 2026-08-06

- fix(slot-view): refresh committed-vs-base changes when `HEAD` changes without an ahead-count change, and share PR-base normalization across live, review, and ready workspaces
- fix(slot-view): resolve committed changes against the open PR's actual base while keeping staged, unstaged, and untracked files in their own source-control groups
- fix(dispatch): use one sortable slot-choice table across Dispatch, Backlog, Roadmap, and Work Graph, with shared lifecycle/worker colors and bounded scrolling for long fleets
- fix(runs): clear run-scoped worker progress immediately when the selected run changes and ignore late progress or family responses from the previous selection
- fix(runs): show the live current-package review summary in run details instead of retaining the gate-time snapshot after package or review changes
- feat(runs): selecting a Runs inventory row opens the existing full detail beside the list, preserving filters while operators inspect its pipeline and slot; run and publication descriptions now use readable foreground contrast, with an explicit link to the full run workspace
- fix(runs): label a retained publication-review launch refusal as **review launch paused** instead of implying that an independent reviewer is running
- fix(roadmap): run deletion/archive events invalidate delivery even when the affected run is outside the paginated client run list, preventing stale badges and lineage detail
- fix(roadmap): the delivery revision tracks backlog rows reachable only through `RoadmapItem.promotion`, which carry no `roadmapItemId`; filtering on the canonical link alone dropped a supported lineage case and left its badges stale
- fix(roadmap): the delete confirm snapshots its target instead of re-reading `_selected`, which falls back to the first row and can name one item in the prompt while deleting another. Defence in depth rather than a live bug — `window.confirm` blocks the JS thread — but it becomes a real swap if the prompt ever becomes async, and `_editHash` moves with the selection so the hash guard would not catch it
- fix(runs): the run pipeline's cancel button and the dispatch wizard's conflicting-run cancel report a partially applied cancel instead of ignoring the result — the wizard would otherwise clear the conflict and dispatch into a slot that may still be claimed
- fix(roadmap): full refreshes and delivery-only reloads use independent generations, so a run update can no longer discard an in-flight filter/search change; the delivery revision now ignores runs with no backlog link and backlog items with no roadmap link, ending continuous full-store reloads during unrelated run activity
- fix(roadmap): an explicit refresh drops its own result (and its error) when a newer refresh has claimed the panel, completing the stale-response guard across every read that writes shared roadmap state
- feat(slot-view): IDE-style per-file state chips (C committed / S staged / M unstaged / U untracked) in the unified diff list and changes activity, with one shared git-status palette across the source panel, changes activity, and file tree (untracked is now green everywhere, VSCode-style, instead of gray in the source panel)
- fix(roadmap): the delivery revision folds the fields the projection derives from (run status/PR number, backlog status/roadmap link/shipped ref), so two transitions inside the same millisecond still trigger a refresh instead of leaving badges stale
- fix(roadmap): a superseded delivery reload's failure no longer overwrites the error banner after a newer refresh already succeeded
- fix(roadmap): delivery _detail_ requests are generation-stamped too, so two overlapping `roadmap.get` calls for the same selected item cannot land out of order and restore stale lineage, and a superseded request's error no longer surfaces after the selection moved on
- feat(slot-view): the source-control panel shows every change vs the base branch — committed or not — as one deduped list ("All changes vs main"), with per-file diffs computed against the working tree
- fix(slot-view): branch-diff file list self-heals — the git-status poll reloads it after a transient failure or when the commit count changes, and failures render as "Branch diff unavailable" instead of a false "No changes"
- fix(roadmap): delivery reloads triggered by run updates are coalesced and generation-stamped, so a burst of `RUN_UPDATED` events cannot stack overlapping full projections or let a slow earlier response overwrite newer badges
- fix(roadmap): the delivery revision folds every row's identity, not just the count and newest timestamp, so swapping one linked row for another (or two edits in the same millisecond) no longer leaves badges stale
- fix(roadmap): delivery refresh tracks content, not row counts, so a run reaching `done` updates both list badges and the open item; unreachable evidence (archived-only families, URL-less PRs, deleted backlog items) renders as an inert chip instead of disappearing or linking nowhere
- fix(roadmap): delivery badges refresh when runs or backlog items change while the panel is mounted; backlog backlinks pin the item's status so delivered lineage is not filtered out; archived-only run families render without a dead link
- fix(progress): markdown-fallback step parsing uses the shared protocol enumerator, so informational checkboxes (ACs, pre-merge sections) no longer inflate step counts
- feat(roadmap): roadmap list and detail render the gateway delivery badge plus clickable backlog, run-family, and PR backlinks from the shared projection. The panel no longer joins the loaded run page, so historical runs stay visible
- feat(backlog): **Refine with runner** picker on backlog detail with launch/resume (Continue existing) parity to roadmap refinement
- feat(inventory): extract a domain-neutral shared work-inventory table shell and migrate Backlog, Roadmap, Work Graph, and Runs onto it with shared sort/selection/ARIA/overflow tokens (MANUAL-000074)
- fix(runs): keep the synthetic package-refresh node **pending** (not failed/red) while a post-gate re-review or worker fix is still in flight, even if an earlier review loop ended in issues/failed
- fix(runs): mini-pipeline and canvas share one tone map so reworkable review `issues` and package-change publish failures render **orange** (another loop expected), while terminal failures stay **red**; open issues no longer paint as done/green on the canvas
- fix(review): let operators omit visual evidence when publishing an approval, while preserving the choice across artifact refreshes
- feat(inventory): render Roadmap, Backlog, and Runs as dense sortable work tables with explicit project/state/activity columns, URL-persisted sorting, responsive selection detail, and no empty selection gutter
- feat(backlog): use a sortable work table as the primary scan surface while retaining the selected row's full right-hand detail panel; show status counts, flow/project columns, and exact-ref out-of-band activity. Run inference is activity-only, while detail/history remains anchored to durable linkage
- fix(runs): show active independent review/fix work ahead of the enclosing human gate in compact pipelines; reserve `publish ready` for gates that actually expose approval
- fix(runners): offer only the current `grok-4.5` model for Grok instead of stale model ids that the CLI silently replaces
- feat(runners): model pickers are scoped per runner (no fleet-wide bleed); Codex lists GPT-5.6 Sol/Terra/Luna (default Sol) with legacy 5.5/5.4; Cursor offers real `cursor-grok-4.5-high-fast` / `high` (drops invalid `grok-4.5-fast-xhigh`); default effort for Codex/Grok is `xhigh` when omitted
- fix(fleet): the Setup modal fetches seats for ITS machine only — the all-machines snapshot probes remote nodes and blew the 15s request budget, which is exactly the timeout the modal surfaced. Snapshots live in one client store shared by the fleet map and the machine config page (open either surface, the other renders instantly; concurrent fetches collapse), kept on failure, with a "querying node…" loading state, snapshot-age display, and Refresh buttons that force a live probe with a 45s budget. The config page gains the same runner-seats section (email, remaining quota — rounded, cooling) on pool selection
- fix(fleet): the machine Setup button renders even when the provider-accounts snapshot is empty or failed — hiding it made a merged feature invisible with no trace. The modal now explains an empty seats list (usual cause: node service not connected), shows the last fetch error, offers Retry, and refetches on every open so a node that reconnected after the last fetch shows fresh seats
- fix(roadmap): stop multi-project filters from silently pre-filling every capture target. Unscoped global captures stay visible, and explicit targets survive filter changes
- feat(ui): fleet machine headers gain a quiet **Setup** control that opens a Node setup modal with per-runner seats (identity/quota, bind/ambient) from `providerAccounts.snapshot` — no header chip dump; run detail shows the funding provider account label when present
- fix(roadmap): the delivery lineage panel shows an explicit loading placeholder instead of rendering nothing, so a slow projection read no longer looks identical to "nothing shipped"
- refactor: unified independent-review language (MANUAL-000008) — review timeline, gate summary, ready-workspace modal/shell, dispatch wizard and dispatch-config surfaces label every automated pass **Independent review** (operator-requested passes as _Independent review (requested)_); runner diversity renders as policy metadata (`runner: <id>` / `runner diversity`) via the new `reviewPolicyLabel` helper instead of the retired _External review_ / _Extra review_ kinds. Persisted decision-action ids are unchanged
- fix: PR cards render path-skipped CI checks with the `statusUnknown` dot instead of the pending color, and CI-timeout recovery / auto-resolve no longer require `passed === total` — skipped checks count toward the total but do not block a green verdict. Persisted ci-watch summaries carry the `skipped` count through snapshot reload
- fix: filter nested-loop task progress by active checklist basename so self-review panels do not accept stale events during fix or CI-fix phases; clear progress when `activeTaskFile` changes and label fix vs review progress from the protocol checklist registry

## 0.4.0 - 2026-07-27

- fix(ui): dispatching a backlog item whose graph node already succeeded now says no run was started and how to reset it, instead of reporting `Checked: succeeded` — which read as a confirmation while nothing had been queued
- feat(ui): status badges follow an attention order — failure, then work in flight (`running`/`dispatching`/`queued`, amber with a pulse, matching the fleet map's busy colour), then work merely available. `ready` was previously the only coloured status, so an idle item was the loudest badge on the board while a running one fell through to muted grey. Shared by the backlog and roadmap lists via one `statusTone` helper
- feat(ui): the roadmap screen lists items as single-line rows (stage, item id, title, backlog links, edit) instead of stacked cards, and the capture form is behind a `New item` button rather than permanently occupying the top of the page. Titles wrap instead of truncating. Project, target projects, tags and file path continue to show in the detail pane
- fix(ui): show the backlog/roadmap item ref (`MANUAL-000055`, a Jira key, a PR ref) next to the title in the backlog list and detail, work-graph nodes, the execution overlay and the roadmap composer. Every surface previously rendered the ref only as a fallback for a missing title, so it disappeared exactly when the item was well-formed — and work-graph nodes fell back to the opaque backlogItemId uuid rather than the ref the CLI and specs actually use
- feat: preview execution templates as an outline or exact source with provenance and optional selection guidance; keep selectors stable while catalogs refresh and remember domain, mode, and template choices per dispatch context
- feat: select compatible execution templates by project, flow, mode, platform, and domain in the dispatch wizard
- fix: show namespaced runtime evidence when inspecting nodes from a composed recipe dependency
- feat: dispatch wizard candidate rows that FIND_SLOT would reject (branch ownership, missing companion resources) render disabled with a NOT ELIGIBLE badge and reason tooltip, are excluded from auto-pick, and suppress nudge/fresh actions (`DispatchCandidate.ineligibleReason`)
- feat: the backlog panel status filter is a multi-select chip set (was single-select), defaulting to the live view — candidate/ready/queued/dispatching/running/failed/needs-attention visible, done/archived opt-in. The selection round-trips through the `backlogStatus` hash param (comma-separated, canonical order; default writes no param; legacy single-status links still parse)
- feat: flow selector, run filters, and flow-graph executor-lane labels render the renamed `update-branch` branch-maintenance flow (was `merge-main` / "Merge Main")

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
