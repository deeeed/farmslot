# Changelog

All notable changes to `@farmslot/mobile` are tracked here.

## Unreleased

- Open every native run conversation beside slot terminals and show open gates, structured review and fix history, and recovered review failures from the shared models.

- Show the existing shared review history panel on run detail while rounds run, as well as at the gate.

- Verify exact reviewed line selection for line comments using the shared source context.

- Open the current worker or reviewer directly from the run header. Terminal requests retain the exact actor binding; finished runs show a disabled action and reason. Worktree terminals reuse the existing terminal screen.
- Publication blockers show finding details and inline actions from the shared gate model. WARM locks retained reviewer settings and refuses unavailable sessions. Evidence judgments stay pending until the gateway responds.
- Run pipelines and run-detail headers share the current worker/reviewer activity with Command Center, including the review round and elapsed time.

- The gate review and the decision workspace's gate show What's blocking publish at the top, with the same one-action-per-blocker list as desktop: Skip this criterion…, Accept findings and publish…, Give it another round. Mark untestable is now Skip this criterion…, with a styled reason sheet and a clear confirm. A criterion's state reads as a status badge rather than a button. Blockers, tabs and expanded reason sheets scroll together so long lists keep the publication footer reachable.
- The gate review offers Accept Review Findings and Publish when the gateway allows it: it lists the open findings and asks for the reason before sending.
- Run detail, the gate review, the decision workspace's prerequisites and the evidence view show the reason a person can act on, for example `Review rounds spent: 4 issues open`, instead of 'Fix and pass review' when fixing is not offered.
- A run waiting at its open human gate shows `Needs your decision` with the gate's readiness reason in the runs list badge, the mini pipeline and the run header, and the run detail pipeline no longer marks its gate blocked.
- The decision workspace and gate review show reviewer attempts that ended without a verdict next to the review rounds once there is one, for example `Review rounds 4/5 · 1/3 no-verdict`.

- A cancelled run that still holds its slot shows it in run detail with Replay from <step> and Release slot side by side, and the fleet card reads "held by cancelled run <id>" with Release slot. Release resets the checkout, as deleting the run does, after a confirmation; a refusal shows its reason.

- Run acceptance: a run that is still working no longer shows its evidence as Invalid before the worker finishes. A criterion row shows More and Review evidence only when they have something to open, and while nothing is assessed the panel shows only its counts line, with the list on demand; it opens once a criterion is assessed and not all are proven. Check details lists a criterion's recipe nodes, as Command Center does.

- Terminal and replay checks use the shared terminal status helper.

- A blocked run shows its reason and the step it stopped at. The run detail badge and the runs list read `Blocked: <reason>` on one line, and the pipeline and the step list mark that step amber, the step list with the reason as its detail. Before, it read as done.

- Reload a run's recorded evidence each time the gateway reconnects, as run detail already does for the run itself. Run detail, the artifact viewer and the decision workspace opened before the connection was ready, or during a gateway restart, now show the run's report and recipe evidence without being reopened, and a reconnect keeps an open viewer and its position. A failed re-read no longer empties the decision workspace's recipe evidence, and the artifact viewer's recipe error clears after the next successful read.

- Show a Run results card on run detail with the run's retained report, the same results Command Center shows. The report bytes are verified against the retained bundle, and an HTML report (a QA run's per-criterion verdicts, coverage gaps and evidence) renders as a page with scripts off. Tapping an evidence link in it opens that retained artifact in Companion, a web link opens in the browser, and nothing else loads; recorded case claims show beneath it. The decision workspace opens reports through the same viewer. The acceptance tally now matches Command Center and shows no proven count before any criterion is assessed.

- Count a family's active runs with the same rule as Command Center and the Review queue, and download every active run.

- List the same active runs as Command Center: failed runs that still hold their slot stay in the Review queue, filters use the shared run-list view model, and archived runs leave the list at once.

- Show Send back to agent as the gate's primary action.
- Sources panel updates itself from the gateway's source revision: no Refresh, hidden when nothing is configured or pinned, and one summary line with details on demand.

- Stop listing host paths and log lines from step outputs as Evidence files.

- Show captured run output in output review Evidence when no step lists it, and keep every publish approval, overrides included, unavailable in the decision workspace while review findings or a fix are open.
- Show evidence loading and Retry independently of acceptance criteria, retaining loaded evidence if a refresh fails.

- Withhold publication approval while review findings or a fix remain unresolved, and show the shared review status until the fixed head passes review.

- Use compact shared acceptance rows, inline judgment progress and evidence-first gate tabs with a persistent approval action; keep supporting details on demand.

- A run that needs a decision shows it in the decision workspace with the same reason, findings or refused prerequisite, delivered head or report, and three actions as Command Center; an action that can't be taken shows why, and Accept needs a written reason. The Review queue labels it Needs decision, opens it with Open decision, and skips the held output review. When the gateway re-presents the decision (new output, a granted review round, a restart), the open workspace follows the new one and stays on it. Its run card says Needs decision instead of Failed.
- The evidence workspace reads a `review` criterion as "Checked in review" or "Awaiting code review" instead of its raw verdict (ADR-062 Amendment 18).

## 0.8.2 - 2026-10-16

- Show the shared no-code-review warning at publication gates.

- Reserve loading layouts and retries for gate, output-review acceptance, evidence and run views with shared skeleton shapes.
- Use one publication decision panel for gate and decision workspaces with explicit AC evidence actions.
- Remember person logins through gateway device sessions and confirm revocation before sign-out, while preserving service profiles.
- Keep recorded comparisons, gate galleries and AC evidence on their captured bundle when newer output is retained.
- Open Unassigned comparison media through its recorded selection, replacing the previous proof gallery.
- Show selected AC proof first and keep supporting files and checks collapsed in run reviews.
- Keep report and evidence links bound to their gateway-retained snapshot, including read-only stale reports.
- Use the shared timeline groups in the existing video viewer, keeping node details collapsed and failures expanded.
- Stop loading checkout authentication in Companion development scripts.
- Use the shared compact worker checklist view and preserve child-unit expansion.
- Show who an active run is waiting on in run lists and detail status.
- Confirm the secondary Settings sign-out action and retain sign-in with the shared 30-day expiry policy.
- Show and submit the resolved QA profile, require a choice for ambiguous farms, and retain admitted profile identity in run detail.
- Direct device setup to person pairing instead of build-time gateway token presets.
- Add the shared Sign out / switch account control to forget this device login and disconnect until explicit login or pairing.
- Render video comparisons with the shared media preview and open recorded moments and ordinary artifacts from their matching viewer selection.
- Reuse the shared criterion comparison model and synchronized Before/After zoom in the existing evidence workspace and player.
- Show the shared visual-review proof kind, delegation and reviewer identity.
- Remove the generic gateway-token fallback from automation configuration.
- Show authenticated visual claim reviews through the shared evidence model.
- Use the shared run evidence contract in package status and recovery guidance.
- Use shared verified claim overrides in publish and output review while preserving engine verdicts.
- Use the shared evidence-policy attestation action and reason input in the existing gate workspace.
- Show shared source status and scoped pin controls in farm, node and run views, with PR completion selections, persistent operation diagnostics and recovery from stale pin revisions.
- Honor HUD top/bottom placement through automatic progress and capture the painted final outcome.
- Show shared package status and collapsed diagnostics, with neutral legacy evidence and independent retained report access.
- Use shared plain run titles with two-line display and full accessible text across run and decision views.
- Keep saved reviews readable on the phone after publication closes and across app switches, with the original verdict, reviewed SHA and full report. Requested choices stay separate from confirmed publication.
- Use the shared evidence review model for claim/step navigation and bounded clips; initialize only the selected video player (ADR-062).
- Show review rounds as N/5 and disable another review when the budget is spent.
- Group delivered roadmap work separately with PR links and delivery outcome filters.
- Show shared gate prerequisite reasons and run lifecycle labels for correction, review failure and reconciliation.
- Inspect each review finding at its reviewed revision and select which finding comments to publish. Android report dialogs retain the shared recipe HUD.
- Release cuts ship production Android to Play internal and closed testing, verify both tracks, and require an explicit iOS platform.
- Preserve literal query values in phone deep links. Prepared dev leases watch source edits and clear first-run chrome; recipe sessions promptly release idle simulator runners through the provider lifecycle.
- Add a live recipe for admin people reading service-owned review workspaces.
- Use shared runner/model chips for new conversations, keep custom models behind Other model, and retain conversation-specific catalogs and profiles.

## 0.8.1 - 2026-10-11

- Compare CI decision snapshots with current PR checks and refresh without leaving the decision.
- Show local CI commands, exit codes and execution logs in gate review using the existing file viewer.
- Configure gate requests, backlog reviews, and PR execution with runner, model, effort, and WARM/COLD choices. Review sequences preserve selections and lineage; missing or ambiguous WARM context blocks submission without changing mode.
- Keep recipe HUD intent on two bounded lines through the shared display policy, with authoring warnings above 80 characters and errors above 120.
- Review a publish gate on the phone: one screen, reached from run detail and the decision workspace, shows the package, each reviewer's latest verdict, the acceptance criteria with their evidence, and the gate's actions. Approve-publish stays disabled, with the reason, while a criterion has no verdict or a latest review is not an approval, here, on the Gate tab and for worker packets; an unjudged criterion also withholds the review overrides. Hold and review requests stay available. Criterion evidence opens in the artifact viewer and swipes through that criterion's files, and the criteria header turns red while any criterion is unassessed. An action is sent for the package you confirmed and refused if the package changed meanwhile; the gate re-reads after the app reconnects, and text evidence loads at most its first 200,000 bytes.
- Choose an available candidate before using a slot decision; improvement Apply writes and validates the proposal and keeps refused changes pending.
- Portable workspace pool policies render as the configured pool and retain their runner/model defaults; machine selection narrows that pool without requiring a literal machine list in the pack.
- Terminal key bars add a runner row and your own keys. Each pane shows the extra keys of its runner, picked from a saved choice, the linked run's runner, or a single matching pane process, and otherwise only the generic keys; you can pick a runner or return to auto per pane. The Yours row holds up to 8 device-wide keys built from a palette of Shift, Alt or Ctrl arrows and Ctrl+A to Ctrl+Z, added and deleted in the terminal. Both rows send through the same terminal input calls as the generic keys.
- The recipe scripts and Metro bridge use `@farmslot/adapter-rn` and its `farmslot-adapter-rn` bin (renamed from `@farmslot/expo-recipe`); `COMPANION_EXPO_RECIPE_BIN` is now `COMPANION_ADAPTER_RN_BIN`.
- The screenshot catalog script imports `@farmslot/recipe-runner/visual-review` (renamed from `@farmslot/recipe-harness`).

## 0.8.0 - 2026-09-27

- Review a run's recipe-captured screens in Companion: open a visual-review source from the Ready Gate, move between parent, child, and related surfaces, add overall notes and colored point or area annotations by touch (select, drag or nudge, edit, remove), export the same feedback JSON as the HTML board, and send it to the originating run's worker. Sending never approves, publishes, or resolves anything, refuses finished runs and feedback over one worker message, and a failed send keeps the draft. The Ready Gate catalog recipe now nests Evidence, Diff, and Timeline under the Ready Gate.
- Backlog review rounds are static; runtime validation runs separately with QA.
- Keep the manual gateway form reachable above the iOS keyboard on the connection screen.
- Install the iOS dev client on a simulator with a simulator build and `simctl install`, so a booted simulator listed by `devicectl` no longer takes the code-signed device path. Like `expo run:ios`, the simulator path generates the native project when it is missing and starts Metro (the managed session) when none is answering; it also boots the device if needed and rejects extra Expo arguments.
- Show assessed and proven acceptance criteria separately, matching Command Center.

## 0.7.0 - 2026-09-20

- Static review runs show live task progress, with expandable child checklists under their parent steps.
- Run detail shows acceptance criteria, verdicts and evidence, including criteria awaiting a verdict and unreadable-ledger errors.
- Unpaired gateways keep Settings accessible, with QR pairing first and manual URL/token entry available.

## 0.6.0 - 2026-09-16

- Display configured review workspaces, separate review and farm QA profile requests, expose QA in run filters, and show PR publication status with retry controls. Keep repair policies limited to runtime slots.
- The PR dashboard takes the gateway's refreshed list from `pr.list.updated`, shows a gateway-side refresh failure as the list error, and the Refresh button asks the gateway to re-read GitHub.
- Continue native conversations from Co-Pilot and worker runs with streamed history, tool and permission details, approvals, custom question answers and turn controls; preserve focused drafts through reconnect and keep the existing terminal option.
- Choose native runner configurations, resume saved conversations, and expand unavailable-node diagnostics when needed.
- Add persistent PR monitors, review/QA requests, rule attention, device push enrollment and publication-policy controls, with gateway-owned actions and drafts preserved across reconnects.

## 0.5.0 - 2026-09-08

- feat(posture): Run Detail says when a gate-parked run is being restored into a different slot than it was parked from and names both, so an operator does not attach to a slot a successor now holds.
- feat(runs): Run Detail shows one compact line when a run is waiting on a fleet-scoped resource claim — the capability, the claim, the place in line, and the run holding it while it is queued, and that the claim is granted and waiting on its provider once it is this run's.
- feat(posture): Run Detail posture rows show the device each capability lease actually resolved to, so a re-targeted validation is not read as running on the slot's configured device.
- feat(runs): a run parked with `free-slot` shows its parked state, the slot handed back to dispatch, the preserved branch, and the restore target on Run Detail, and the decision workspace says that answering the gate restores the run into that slot first or shows the typed refusal standing against it. The freed slot is described as released by this run rather than free now, a park that failed partway says whether the gate is answerable or owes a restore, and the Slot line drops the restore implication once the run is terminal.
- feat(runs): offer the four resource-posture choices with the Gateway's effect preview when resolving a human gate, and show a compact retained, warm, stopped, failed posture summary on Run Detail.
- feat(notifications): add configurable decision and monitor-violation alerts with independent sound and haptic controls.
- fix(runs): hide Replay on a force-completed run; the gateway rejects those replays.
- fix(recipes): keep the native recipe HUD visible without hiding the app's accessibility tree from live UI actions.
- fix(review): use one swipeable Before/After evidence component across review, run, family, gate, diff, and artifact surfaces.
- fix(recipes): expose a named native-input recipe command for repeatable keyboard and navigation validation.
- fix(recipes): declare native Back, Escape, Enter, and Return key presses in the shipped Companion action manifest.
- fix(review): share the project badge color mapping with Command Center so projects remain visually consistent across clients.
- fix(copilot): replace the chat and idea composer with the persistent Co-Pilot tmux terminal, land active runs on Timeline, preserve contextual drafts, and render step inputs and outputs as readable fields.
- fix(review): show full run titles and summaries, color-code projects, collapse singleton family hierarchy, and surface the active pipeline detail and elapsed time directly in the review queue.
- fix(family): replace long-scroll workspace navigation with persistent tabs and one compact, icon-backed screen header shared across run, slot, family, gate, and retrospective surfaces.
- fix(review): show per-step checklist timing inside each review round.
- fix(review): keep run evidence in shared tabs, add a conditional Gate tab for blockers, review history, freshness, and actions, open reports on demand in the Markdown viewer, and present reviews as rounds separated from worker fixes.
- fix(connection): retry the first foreground decision sync before warning, and ignore failures from superseded connections.

## 0.4.1 - 2026-08-11

- fix(notifications): recognize monitor budget violations while keeping them non-actionable for Companion push notifications (MANUAL-000096).
- fix(connection): keep clean production installs on the pairing screen by rejecting an empty gateway URL before constructing a WebSocket.
- fix(review): expose shared workspace filters on the Review tab and replace its simulated filter modal with the native form-sheet route used by the rest of Companion.

## 0.4.0 - 2026-08-10

- feat(companion): add mobile Roadmap and Backlog detail workspaces, edit complete backlog dispatch parameters before launch, render attached specs, and expose review-attempt history with per-generation reviewed and fix diffs.
- feat(companion): use native form-sheet routes for workspace filters and backlog creation, add a scoped mobile backlog launcher, and make Slot/Terminal/Diff and Run Evidence/Diff/Timeline/Files persistent tabbed workspaces with single-purpose content instead of duplicated progress or artifact surfaces.
- fix(pairing): reject mixed-code multi-address QRs before exchanging any credential.
- fix(pairing): exchange a multi-address QR once so every imported profile shares one revocable device credential.
- chore(deps): upgrade Companion to Expo SDK 57 / React Native 0.86 (expo@57.0.10, aligned expo-\* modules via `expo install --fix`).
- feat(review): show the shared repeat-review generation and reviewer-session chain in run details.
- chore: store-screenshot demo PR data carries the new `skipped` CI check-summary count (protocol `PRStatus.checkSummary` gained the field).
- Route production Android submit to Play internal testing until the first production store release exists.

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
