# Offline client store migration audit

This tracks roadmap item `ri_b1bb5ad00e17`. The [specification](gateway-change-notifications.md)
owns the contract. Acceptance remains incomplete while any applicable reader, writer or
platform proof below is pending.

## Current query owners

| Query                                                  | Dependencies                                                              | Persistence                       | Current consumers                                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources.status`                                       | `sources/farm`                                                            | 2 MB                              | Sources controllers in Command Center and Companion                                                                                                                     |
| `run.list`                                             | `runs/farm`                                                               | 20 MB across variants             | Browser active/history/tag/family lists and comparison baseline picker; native active and explicit history collections                                                  |
| `run.get`                                              | `run/{runId}`, `runs/farm`                                                | 50 entries, 20 MB total           | Browser detail/comparison/family, publication workspace and selected dispatch baseline; native detail, diff, artifact viewer, family, gates, decisions and saved review |
| `decision.list`                                        | `decisions/farm`                                                          | 10 MB across variants             | Browser inbox; native inbox, decision workspace and gate action guards                                                                                                  |
| `run.recipeRunsForRun`                                 | `run/{runId}`, `artifacts/{runId}`                                        | Memory                            | Browser run detail, SlotView and frozen publication workspace; native run detail, diff, frozen artifact viewer, decision workspace and gate acceptance evidence         |
| `family.observability.get`                             | `family/{familyId}`, `decisions/farm`                                     | Memory                            | Browser comparison and family view; native family workspace                                                                                                             |
| `run.slotHistory`                                      | `runs/farm`, `slots/farm`                                                 | Memory                            | Browser and native slot-history views; selected entries use shared full-run and recipe observations                                                                     |
| `run.forSlot`, `run.recipeRunsForSlot`                 | `runs/farm`, `slot/{slotId}`                                              | Memory                            | Slot selection uses `run.forSlot`, followed by the selected full run and per-run recipe query; no direct client consumer remains for `run.recipeRunsForSlot`            |
| `run.tags.list`                                        | `runs/farm`                                                               | Memory                            | Browser tag filters                                                                                                                                                     |
| `fleet.status`                                         | `slots/farm`                                                              | 2 MB                              | Both clients' fleet and slot facts; one canonical query, explicit force-refresh remains imperative                                                                      |
| `nodes.list`                                           | `node/farm`                                                               | 2 MB                              | Fleet node badges, node detail and version inventory                                                                                                                    |
| `runtime.capability.list`, `runtime.capability.status` | `capabilities`, `sources/farm`                                            | 2 MB per method                   | Runtime capability panels in both clients                                                                                                                               |
| `task.progress`                                        | `progress/{runId}`, `run/{runId}`, `artifacts/{runId}` or `slot/{slotId}` | 2 MB                              | Lists, details, slot/family/terminal progress and retained selections; admission follows the actual source owner                                                        |
| `tmux.worker.list`                                     | `workers/farm`, selected `workers/{nodeId}`                               | Memory                            | Pinned workspaces, split terminals, Companion Workers, keyboard context and worker controls                                                                             |
| Native session history and profile reads               | Authenticated reader's owner collection or exact node/session/worker      | History 200 messages, 10 sessions | Command Center and Companion use authorized source observations and stamped reads; platform cold/action proofs remain pending                                           |

The protocol registry is `packages/protocol/src/client-cache/registry.ts`. Parameters form
part of query identity. Native active/history/decision deadlines remain 20/60/30 seconds;
history remains explicit and bounded to 80 rows until the version-list migration.

## Freshness audit

| Consumer                                   | Removed mechanism                                                                                                                             | Replacement                                                                                                                                                 | Proof                                                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Sources controllers                        | Client refresh scheduling and settle reads                                                                                                    | Shared `sources.status` observation                                                                                                                         | Sources live recipes                                                                                                              |
| Browser run collections and inbox          | Domain event payload adoption                                                                                                                 | Shared `run.list` and `decision.list` observations                                                                                                          | `command-center-offline-runs.recipe.json`                                                                                         |
| Browser full run detail                    | Direct payload adoption, trimmed-detail retries, post-write reads and mirror-delay guess                                                      | Shared `run.get` and recipe observations                                                                                                                    | Same recipe, full-detail and artifact-arrival assertions                                                                          |
| Browser batch archive                      | Treating one catch-up response as current authority                                                                                           | Wait on shared observations until all selected query inputs are ready                                                                                       | Same recipe, explicit batch archive assertions                                                                                    |
| Browser run comparison                     | Direct full-run, sibling and family reads tied to app snapshots                                                                               | Shared full-run, family-list and family-snapshot observations                                                                                               | `command-center-offline-runs.recipe.json`, comparison assertions and notification negative control                                |
| Native active/history/inbox collections    | Run/decision event payload adoption and queued decision refresh                                                                               | Shared active/history/decision observations                                                                                                                 | `runs-live.recipe.json`                                                                                                           |
| Native full run detail                     | Separate full-run/recipe reads, run event adoption and replay-result adoption                                                                 | Shared full-run observation and recipe query bound to the pending decision and manifest digest; explicit execution selection remains part of query identity | `runs-live.recipe.json` and `recorded-visual-runs-live.recipe.json`; iOS visual5/5 and cold18/18 pass                             |
| Native saved review                        | Independent full-run refresh, list-row replacement and post-publication settle read                                                           | Shared full-run observation; explicit retry after read failure                                                                                              | `runs-context-live.recipe.json`; iOS and Android component proofs pass                                                            |
| Native decision workspace                  | Local decision/full-run copies, domain event adoption and reconnect recipe reads                                                              | Shared inbox, full-run and recipe observations                                                                                                              | Same context recipe; iOS and Android component proofs pass                                                                        |
| Native gate review and acceptance evidence | Local full-run copy, domain event adoption and independent recipe-evidence read                                                               | Shared full-run and parameterized recipe observations                                                                                                       | Same context recipe; iOS and Android component proofs pass                                                                        |
| Family views in both clients               | Native 30-second poll, 400-ms settle timer, per-event reads and local full-run adoption; browser connection/post-write reads and full-run map | Shared family, selected-run and per-run recipe observations                                                                                                 | Browser offline run recipe and native `family-live.recipe.json`; combined browser 35/35 and native family 13/13 on both platforms |

| Native diff context | Direct full-run and recipe reads, event payload adoption, 30-second poll and background-pause retry | Shared full-run and recipe observations; owner-bound live workspace side read remains for fleet slice | `runs-context-live.recipe.json`; iOS and Android pass 21/21, cold render and age negatives fail, exact restoration and 21/21 recovery each |

| Native artifact viewer | Independent full-run/recipe reads, list/event payload adoption, 30-second poll, background retry, reconnect/post-write reads and 5.5-second settle timer | Shared full-run and frozen decision/hash/recipe observations; explicit artifact sync remains a guarded command | `runs-context-live.recipe.json`; iOS and Android full context recipes pass 28/28; query/inventory/readiness negatives restore exactly |

| Browser load-run dialog | Independent project run.list read on open/retry and local result copy | Shared project collection, saved age, current-run/branch/project checks and slot hydration guard | Recorded browser37/37; notification/readiness/confirmation negatives each restore3/3; cold slot launch remains for fleet matrix |

| Browser slot history | Independent history reads on open/retry and local result copies | Shared history observation, binding/membership dependencies, saved age and current-input prepare checks | Focused history3/3 and three exact-restoration controls pass; current/read-error/offline/refused screenshots inspected. Combined r23 failed on a matching native OPFS crash and is excluded |

| Browser SlotView run and recipe inventory | Trimmed list-row adoption, direct run.get/run.forSlot/recipe reads, run/state-event refreshes, mirror post-command reads and the 1.5-second recipe settle timer | Shared slot-run, pinned full-run and per-run recipe observations; current-input mutation guards and explicit artifact sync | Focused slot-run proof3/3; notification and readiness controls fail intended assertions, restore exactly and recover3/3; recorded combined browser43/43, all24criteria and eleven browser phases |

| Browser dispatch comparison picker and baseline | Independent picker run.list reads and async result copies; selected-parent hydration from app-list rows | Shared filtered run.list and selected full run.get, saved age and current-input checks for selection and dispatch/queue/cancellation | Focused dispatch-runs-live-r2 passes3/3; notification r2 and readiness r1 restore exactly and recover3/3each. Cold picker and full command matrix remain pending |

| Native slot workspace | Independent history, full-run, family and per-history run/recipe reads; event payload adoption | Shared canonical run, history, family and recipe observations; current binding marker and scoped recipe/task-progress selection | `slot-runs-live.recipe.json`; recorded iOS6/6 and Android6/6. Cold pinned full run, exact timestamp, age and restored current reads pass; notification and cold-render controls fail their intended assertions and restore exactly |

| Native slot diff | Independent run/recipe reads and run-event payload adoption/refetch | Shared slot-run selection, persisted full run and recipe observation; Git diff stays with its content owner and scoped replies | Same native slot recipe proves actual current diff projection on both platforms. Cold unpinned slot selection/content remain for later slices |

| Native slot terminal | Independent run.get/run.forSlot and recipe reads, run-event adoption, subscribe and command-time rereads | Shared canonical run selection and recipe observation; current command preconditions and owner/target-bound terminal view; stream subscription retains its own owner | `terminal-runs-live.recipe.json`; iOS and Android7/7 with verified recording timelines prove a real private-shell key, updates without stream restart, cold exact SQLite timestamp/age, no replay, actor refusal and clearing the previous pane. Notification, readiness and pane-scope controls fail their intended assertions, restore exactly and recover7/7 |

| Native visual review | Independent full-run and recipe-inventory reads, including command-time run RPCs | Shared source/target full-run and recipe observations; HTTP source/image bytes retain their owner; current canonical command inputs and owner/connection/reply fences | `visual-runs-live.recipe.json`; iOS/Android7/7 with actual note input, external run update, safe finished-run refusal, stale disabled controls and reconnect without replay. Notification and disabled-Send product controls fail intended assertions, restore exactly and recover7/7; cold source/image bytes remain for content caching |

| Native conversation run context | Full-run lookup on every transcript poll and a local worker-binding copy | Shared full-run observation, exact current task binding before commands and after journal writes, fenced cursor replies and contextual run Retry | `conversation-runs-live.recipe.json`; iOS7/7 with actual accepted worker input, stale disabled Send, cursor continuity and a real late page rejected after run removal. Poll/readiness/late-page controls fail intended assertions, restore exactly and recover7/7. Android and broader platform acceptance remain; native session list/read polling and transcript persistence remain in the fleet/session slice |

Explicit mutations such as refreshing a publication package retain their command owners.
They do not adopt returned run data. A shared observation supplies the resulting state.
Local age clocks repaint saved timestamps without issuing network reads.
Visual feedback keeps the connection bound during ordinary observation invalidation,
so a reply already in flight still settles its original delivery. Source readiness
pauses new commands without retiring that reply. An accepted draft requires an edit
before another send. `visual-wire-live.recipe.json` covers an actual delayed gateway
refusal across same-connection invalidation; successful worker delivery remains in
the broader command acceptance matrix.
Artifact sync acknowledgements require their captured connection and evidence scope.
Busy cleanup also checks the specific request identity, so a lost reply cannot leave
the current scope busy or clear a newer request. Recipe output remains under its
command owner; completion does not reread or adopt a run snapshot.

Family views observe their derived summary in memory and persist the selected full run.
The selected run is recorded in the actual route, including default selections from a
plain family link. A cold offline family page offers **Open saved run**, which navigates
to its cached detail. Explicit retry targets failed family, detail and recipe reads.

Accepted snapshots remain eligible for persistence when a connection pauses or the last
view observer leaves. Authority changes clear the accepted value and cancel queued writes.
The browser family proof checks the actual SQLite timestamp before closing its document.

Slot workspaces now project each current fleet row instead of keeping the first
copy or adopting `slot.changed` payloads separately. Removed slots and cleared
authority retire the copied facts. `command-center-slot-writer.recipe.json`
checks real mode writes, the rendered lifecycle and canonical query revisions.
The living fleet-store recipe proves browser cold SQLite restoration, saved age, disabled stale actions, node replacement and gateway restart. Native/desktop fleet acceptance and the remaining workspace/session reads are still pending.

## Native report evidence identity

`features/run-detail/run-evidence.ts` derives the evidence query from the current full
run, pending output-review decision, manifest digest and explicit recipe selection.
Both judgment callers reread the current progress and evidence observations when the
operator invokes an action. A retained callback cannot authorize a different cache,
profile, connection authority or review context. The report hook binds visible content
and late reads to that same profile, authority and package identity.

## Run writer coverage

| Writer                       | Notification owner                                                  | Covered behavior                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run persistence and deletion | `services/gateway/src/runs/store.ts`, `resources/run-changes.ts`    | Run, collection, decision, family and artifact dependencies                                                                                                                                                                         |
| Worker decision files        | `observability/fleet-monitor.ts`                                    | Creation, content change, removal and read failure/recovery                                                                                                                                                                         |
| File decision resolution     | `methods/decisions.ts`, file-decision owner                         | Physical deletion before acknowledgement; failures propagate                                                                                                                                                                        |
| Artifact acquisition         | `run-completion/artifact-mirror.ts`                                 | Actual copy/prune/pointer changes notify; unchanged acquisitions stay quiet                                                                                                                                                         |
| Feedback consumption         | `intelligence/feedback-ledger.ts`                                   | Inbox and retrospective derivations change after consumption                                                                                                                                                                        |
| PR monitor observations      | `pr-monitoring/store.ts`                                            | Run-derived monitor decisions invalidate when their inputs change                                                                                                                                                                   |
| Slot facts and membership    | `core/state.ts`, `fleet/state.ts`, `resources/slot-run-bindings.ts` | Direct/CAS/claim/mark/transition/reset/rewrite commits and external file changes invalidate slot facts and former project/node scopes. Membership or run-pointer changes also invalidate run projections; failed reads stay visible |
| Inbox expiry                 | `runs/decision-inbox.ts`, resource deadline owner                   | Existing 48-hour expiry invalidates the inbox without rewriting the run                                                                                                                                                             |

`runs/store-resource-changes.test.ts` exercises the actual store writers, filtered
membership, writes during reads, durable outcomes, archive/deletion and derived views.
`resources/run-changes.test.ts` covers former family/decision keys and inbox deadlines.
`observability/fleet-monitor-resource-changes.test.ts` covers file decision changes and
failure/recovery; `intelligence/feedback-ledger.test.ts` and
`pr-monitoring/store.test.ts` cover their owning persisted writes. Actual artifact
arrival/pruning and unchanged acquisitions are covered by
`run-completion/artifact-mirror.test.ts`. Slot binding/membership invalidations are
covered by `resources/slot-run-bindings.test.ts`.

Gateway writer tests and the real-endpoint run recipe support these rows. They do not
establish coverage for unmigrated cross-family inputs.

## Browser publication workspace checkpoint

The workspace observes canonical full `run.get` and frozen
`run.recipeRunsForRun` with its decision and package hash. It no longer adopts
compact prop metadata, independent evidence reads, post-judgment rereads or
package-refresh reply records. Explicit package refresh and lost-decision
outcome reporting remain; the latter reads through the shared observation.
Owner, view, connection and request scopes guard command replies and cleanup.
Confirmations retire on invalidation or package changes. Existing Git/TASK
content reads remain with their content owners and scoped replies.

Focused browser `ready-workspace-live-r6` passes 3/3 with actual external tags,
a real removed-action refusal, cold offline gate facts, saved age, exact SQLite
observation time and current evidence recovery without replay. Notification and readiness controls each fail their intended assertion, restore the
exact source bytes and recover 3/3. Current/refused and cold/age screenshots are
inspected. The combined recording is pending. This slot-free gate proof does not
establish packaged publication, actual visual judgments or the full command matrix.

## Run and decision acceptance

Command Center's combined run-family recipe passes 43/43. The bundled desktop client restores saved run lists, opened full runs and Inbox offline with original observation times, disabled mutation controls and current recovery without replay. The closed-client role-revocation proof clears rendered run data and its stored queries before a history reply applies.

Companion iOS cold Runs/Inbox passes 18/18: a new offline process renders the same saved IDs and SQLite observation times, visible ages and a disabled actual decision action, then recovers without replay. Its visual recipe passes 5/5: two current confirmed/rejected judgments match their independent delegated receipts and projections; a stale tap issues zero commands. The retained media and ledger remain byte-identical. The proof adds no native product change.

The baseline records five current browser reconnect samples, median 1151 ms and 5,585,675 bytes for 62 rows versus the original 67. These are raw measurements without a normalized speedup claim. The original 7.56 MB baseline still requires version lists.

## Remaining acceptance

- Complete fleet/session, configuration/planning and upstream migrations, followed by content reads, content caching, conditional edits and version lists.
- Complete final platform validation, CI and independent reviews on the finished head.

Recipe files live under `docs/examples/recipes/farmslot/` for Command Center and
`apps/companion/scripts/agentic/recipe/recipes/` for Companion. Unit tests support the
recipes; they do not replace rendered or endpoint acceptance.

## Native read recovery

`run-read-recovery.recipe.json` covers idle slots with no current or retained run,
plus failed refreshes in Artifact Viewer and Run Diff. A slot's live Git read
requires a current slot binding; a full-run observation is required only when
a run exists. Contextual Retry renders when either shared observation has an
error and retries only queries that still have an error at the time of the click.
The recipe faults only an owned private bundle manifest, restores its exact bytes
and file mode, and verifies recovery on the same gateway connection. Each case
has a failing pre-fix real-client proof. The new device runs use screenshots and
traces with an explicit recording-off reason after the lead's recording retry cap.
They do not claim new video evidence or whole-family acceptance.

## Browser review workspace

The review workspace observes the canonical full run, including its pending decision
or saved review result. It preserves curation across unrelated metadata updates,
clears confirmations on invalidation, and checks current actions before dispatch.
Admitted commands retain their view and connection through ordinary observation
staleness. Former-view replies and cleanup cannot modify a successor. Checkout also
requires the shared current slot-run binding. Explicit artifact refresh and improvement
operations retain their existing owners; Git reads remain content-owned and fence
their replies. Native-session polling and Git freshness migration remain later slices.

The browser recipe proves actual comment selection, external run updates, confirmation
retirement before its normal timeout, visible protocol refusal, exact saved observation
time on a cold offline document, readable saved report and disabled commands, and
reconnect with neither owned fixture decision resolved. Confirmation, readiness and visible-refusal controls fail
their intended assertions, restore the exact source and recover. This slot-free legacy
review context cannot publish or start a worker; successful publication and Git content
acceptance and wire-level command replay counting remain in the broader command and content matrices.

## Worker observation admission

Worker inventory readers share `tmux.worker.list` queries. Pinned workspaces and split terminals no longer poll every ten seconds or adopt inventory event payloads. Companion Workers, keyboard context and worker terminals use the same cache. Worker commands require a current inventory at invocation; saved selection preferences remain separate.

The existing node sampler publishes structured failure and recovery on its existing cadence. The gateway accepts only the current registered socket and capability. Its owner publishes farm and node worker keys after readable snapshots, relevant run/slot/config changes and finite status-age transitions. Marked reads use the sampled source rather than issuing a new pane RPC. An old gateway or node is explicitly unsupported; there is no polling fallback. File-backed progress and branch enrichment similarly check their actual producer, while gateway-owned retained progress uses its run/artifact writers.

`resources/worker-changes.test.ts`, `worker-observations.test.ts`, `node-file-observations.test.ts`, `progress-observations.test.ts`, retained/workspace/reviewer tests and the node sampler tests cover these boundaries. Actual worker source failure/recovery and both-client inventory acceptance remain pending.

Native consumers now use the shared bounded history projection and error-specific Retry controls. Duplicate node-event settle scheduling is removed. History reduction counts user and assistant messages after fragment merging; tool/status records do not consume the 200-message limit. Native live definitions require authenticated source admission and stamped reads. Cache tests support retention, cold age, lease isolation and late-response fencing; they do not establish platform acceptance.

## Fleet, workspace and native observation mapping

The gateway brackets observed reads with source admission and current authority checks.
Its publication filter reauthorizes each private key for the interested connection.
The protocol registry defines canonical parameters, dependencies and persistence bounds.
Both client adapters pass observations to the same shared cache; commands keep their
existing owners.

| Owning writers                                                                                                                                                                                                                  | Read/query                                                                                           | Changed keys                                                                                                              | Consumers and focused coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleet/state.ts`, `fleet/resource-manager.ts`, pool/config changes and `resources/slot-run-bindings.ts`; run commits through `resources/run-changes.ts`                                                                         | `fleet.status`; slot facts are part of the fleet snapshot                                            | `slots/farm`, affected `slot/{slotId}` and former membership scopes                                                       | Browser fleet/slot views and Companion fleet/slot workspace; `fleet-writer-publication.test.ts` covers real status commits, guarded claim/reset, overlay set/clear, resource ownership and pool/project file watchers; slot-run binding tests cover failure/recovery, old scopes and deadlines                                                                                                                                                                                |
| `fleet/machine-registry.ts` registration, metadata replacement and current-socket disconnect                                                                                                                                    | `nodes.list`                                                                                         | `node/farm`, `node/{nodeId}`; worker dependencies also change                                                             | Browser node badges and version inventory; `machine-registry.test.ts` asserts exact farm/detail node and farm/node worker publications on registration, replacement and removal, with late old-socket close quiet. Companion renders node facts from fleet, without a separate `nodes.list` consumer                                                                                                                                                                          |
| `tasks/watcher.ts`, `review/progress.ts`, `review-workspaces/progress.ts`, retained run/artifact writers and actual node file receipts                                                                                          | `task.progress`, selected by run/context or slot                                                     | `progress/{runId}`, exact context progress, `slot/{slotId}`, retained `run/{runId}` and `artifacts/{runId}`               | Both clients' list/detail/terminal progress; actual checklist and signal-only writes in `watcher-subtask.test.ts`, review tracker commits in `review/progress.test.ts` and slot-free mark/view projection in `subtask-parity.test.ts` assert exact keys; existing source tests cover replacement, errors and recovery                                                                                                                                                         |
| `automation/branch-watcher.ts`; filesystem/Git writers and external workspace changes through `workspace-observations.ts`, `workspace-node-observations.ts`, `capabilities/workspace-watch.ts` and node `workspace-watch.ts`    | `fs.list/read`, `git.status/diff/show/branchDiff`, `native.session.workspace.list/read/changes/diff` | Branch facts invalidate fleet/slot; workspace keys bind exact slot/run or authenticated native reader/node/session/worker | Browser workspace/SlotView/native workspace and Companion live diff views; workspace, authorization, observed-Git and file-watch tests cover external writes, index/HEAD changes, held replies and failed sources. `workspace-writer-publication.test.ts` exercises all supported local file/Git writers and symbolic/detached HEAD; `workspace-node-publication.test.ts` joins current remote receipts, failure/recovery and replaced sockets to exact workspace aliases     |
| Node tmux sampler, `worker-observations.ts`, registry/config changes, `tmux-workers.ts` explicit commands, run/slot bindings and `worker-changes.ts` status deadlines                                                           | `tmux.worker.list`                                                                                   | `workers/farm`, affected `workers/{nodeId}`                                                                               | Browser split terminals and Companion Workers/terminal/keyboard context; `worker-observations.test.ts` joins accepted ready/failure/recovery receipts to exact farm/node keys; `worker-command-publication.test.ts` checks snapshot publication and confirmed removal, with stale or unconfirmed requests quiet; sampler and shared-observer tests retain their separate claims                                                                                               |
| Runtime native journal/session/command writers through `native/observation.ts`; actual local host and current remote-node receipts                                                                                              | `native.session.list/read/catalog`                                                                   | Authenticated `native-session` owner collection or exact reader/node/session/worker key                                   | Browser/desktop native workspace and Companion native controller; native observation, catalog, runtime and history tests cover admission, private aliases, message/session bounds and late replies; real manager recovery/queued cancellation and source stop now join durable source changes to exact gateway packets                                                                                                                                                        |
| Runtime `profile-service.ts` and `account-profiles.ts` durable profile writes, shared account sampling and `native/observation.ts`; catalog preference writes/watch through `visible-models.ts` and `native-catalog-changes.ts` | `native.profile.list/status`; native catalog                                                         | Exact authenticated `profiles/{ownerId}/{nodeId}` or owner collection; catalog invalidates its reader's native collection | Both clients' native profile selectors; runtime source tests, catalog tests and the profile-interest regression cover source ownership and key derivation. the catalog writer test joins durable preferences to its actual gateway packet; account-only source sampling publishes only profile keys. Actual pool/project file writes also reach the private catalog key through the running server capability bridge. Endpoint profile fan-out is a separate acceptance check |

Fleet and node collections each have a 2 MiB persistence bound. Slot facts share the
fleet collection. `fleet-retention.test.ts` exercises actual canonical queries at
2 MiB minus one byte, exactly 2 MiB and one byte over, using multibyte UTF-8 data.
An oversized replacement stays readable in memory, removes its older stored value
and preserves the other collection. Native histories retain 200 complete messages
for ten sessions; tool/status records do not consume that message count.

`workspace-writer-publication.test.ts` passes ten owning-writer cases using real
temporary linked worktrees and production source watchers. File create/replace,
rename, recursive delete, mkdir, stage, unstage and discard publish both opened
workspace aliases while leaving an unrelated workspace unchanged. Symbolic branch
and detached HEAD changes publish the fleet and slot keys through the actual branch
owner. Every case rejects the former source fence and admits a fresh read. Fixture
roots use canonical paths so teardown releases the same source identity it armed.

| Consumer                                                                      | Removed reader scheduling                                                                 | Replacement                                                                                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Browser SlotView live, pinned, review and source panels; standalone workspace | Independent fs/Git reads and panel-specific refresh/event scheduling                      | Shared canonical workspace queries and exact slot/run dependencies; explicit file/Git commands remain commands |
| Browser native history and profiles                                           | Transcript/profile polling and node-event settle reads                                    | Source-admitted native history, inventory, catalog and profile queries with reader-bound keys                  |
| Companion native conversation/setup/profile selection                         | Independent history/profile reads, transcript polling and duplicate node-event scheduling | The same native query definitions; current-input checks fence Send and Resume                                  |
| Companion live slot/run diff                                                  | Independent live Git reads and event-triggered refreshes                                  | Shared workspace `git.diff` with scoped replies; frozen review artifacts retain their separate owner           |
| Browser split terminal and Companion Workers/terminal/keyboard context        | Periodic worker inventory reads and direct event payload adoption                         | Shared `tmux.worker.list`, farm/node worker keys and source-owned status deadlines                             |
| Both clients' progress readers                                                | Per-panel progress reads, settle timers and polling                                       | Shared `task.progress` with actual file/run/artifact producer dependencies                                     |

The individual D06 removals are listed below. Key names refer to the typed
derivations in the owner table above. Error-only Retry uses the same query owner.

| Reader                             | Removed mechanism or control                                                                     | Query and key                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Web app-shell                      | Ten-second worker inventory timer and initial/connection direct refresh                          | `tmux.worker.list`, `workers/farm`                                                                |
| Web split terminal                 | Independent inventory refresh and ordinary Refresh sessions                                      | `tmux.worker.list`, farm/node worker keys                                                         |
| Companion Workers                  | Focus-triggered direct inventory read and ordinary Refresh                                       | `tmux.worker.list`, `workers/farm`                                                                |
| Companion WorkerTerminalScreen     | Direct inventory request on binding                                                              | Machine-filtered `tmux.worker.list`, farm/node worker keys                                        |
| Companion usePaneRunnerContext     | Fifteen-second timer and direct runner-key inventory read                                        | Machine-filtered `tmux.worker.list`, farm/node worker keys                                        |
| Web SlotView live effects          | Thirty-second Git-status timer, branch-diff refresh and independent directory/file/Git reads     | `WorkspaceReads` canonical fs/Git queries, exact slot/run workspace key                           |
| Web SlotView pinned effects        | Independent root and expanded-directory reads                                                    | Canonical `fs.list`, pinned workspace key                                                         |
| Web SlotView review effects        | Independent branch/per-file diff reads and refresh paths                                         | Canonical `git.branchDiff`/`git.diff`, exact workspace pin                                        |
| Web SlotView file commands         | Post-command Git-status reread                                                                   | Workspace source invalidation; the mutation keeps its command owner                               |
| Web SlotView URL restoration       | Three delayed file/diff restore attempts at 750 ms and their timer state                         | Canonical workspace subscription and scoped replies                                               |
| Web standalone slot workspace      | Thirty-second Git-status timer and independent directory/file/diff reads                         | Canonical fs/Git workspace queries                                                                |
| Web native workspace               | Independent list/changes/read/diff and ordinary Refresh                                          | `native.session.workspace.*`, authenticated reader/node/session/pin workspace key                 |
| Companion SlotDiffScreen           | Independent initial/event refreshDiff requests and local request ownership                       | Canonical `git.diff`, exact slot/run workspace key                                                |
| Companion RunDiffScreen            | Direct live Git diff read                                                                        | Canonical `git.diff`, exact slot/run workspace key; retained artifacts keep their owner           |
| Web native model/view              | Independent inventory/history reads and 100-ms node-event settle scheduling                      | Canonical native inventory/history keys; bounded cursor drain stays inside its owner              |
| Web native session header          | Ordinary Refresh sessions                                                                        | Native collection query; error-only Retry remains                                                 |
| Web native profiles                | Ordinary gateway-backed Refresh profiles                                                         | `native.profile.list/status`, reader/node profile keys; non-gateway compatibility refresh remains |
| Companion native controller        | Selected-history 1,200-ms and inventory 5,000-ms polling, refreshRef queue and direct page reads | Canonical native history/inventory owner and scoped cursor drain                                  |
| Companion NativeConversationScreen | Ordinary Refresh                                                                                 | Native query error-only Retry                                                                     |
| Companion NativeProfilePicker      | Independent profile scheduling and ordinary Refresh profiles                                     | Canonical profile list/status keys; login/settings actions remain commands                        |
| Companion NativeSessionSetup       | Direct catalog read on refresh and ordinary Refresh workspaces                                   | `native.session.catalog`, authenticated reader collection key                                     |

The earlier progress-reader cutover has its own source/recipe evidence; unchanged
progress readers are not additional D06 timer removals. Fleet/node consumers that
already used shared queries similarly establish current ownership rather than a
new removal. Worker-age repaint clocks, resource-panel layout restoration,
transport reconnect/timeouts, source-owned deadlines and provider collectors
retain their distinct purposes. They are not panel-read polling replacements.

The canonical browser fleet recipe is `command-center-offline-fleet.recipe.json`.
Its bytes match the earlier executed fleet-store recipe; the rename changes no
actions or assertions. The unchanged recipe passed 8/8 under its prior filename.
Workspace passes 9/9 and farm/native-only history recipes 10/10 each.
A production gateway/local-host/remote-node endpoint proof verifies
two-owner native-session isolation, ten SQLite histories of 200 messages, integrity
and zero idle history refetches. A separate three-connection proof exercises each
owner's actual profile writer and private profile-key delivery. The unrelated admin
receives no profile keys; foreign reads disclose neither payload nor revision stamps.
Both disposable profiles are retired through their owning routes. Schema-reset/draft-preservation
and assignment-removal regressions pass after their fixture corrections. Companion additionally proves native cold retention, disabled actions and recovery,
plus real node/Git/progress changes on mounted panels without Refresh. D06 is accepted
under the lead disposition while desktop cold remains explicitly held and unproved. The combined endpoint proof
opens eleven canonical queries with three observers each. Its eleven-second idle window
has zero reads. During 36 real workspace writes, six 200-ms source publications cause
at most one refetch per workspace query and publication. This does not prove platform
cold rendering or provider/worker/profile mutation bursts.

`read-failure-races.test.ts` covers a source change that races a failed read. The
cache retains that pending invalidation and schedules one replacement read. A
failure without a new change stays visible for explicit Retry; authority,
not-found and unsupported refusals do not retry. This uses the existing scheduler
and source events, without adding a timer or a second read owner.

The shared native-history reader checks the basic `AbortSignal.aborted` contract
before I/O and after every reply. Modern signals retain their explicit abort reason;
older React Native signals receive an `AbortError` without requiring `throwIfAborted`
or `DOMException`. Regression cases cover normal page draining, zero-request pre-abort
and rejection of a late page without starting another request.

Native producer tests join the real manager's journal recovery and queued-command
cancellation to exact native history keys through the runtime source and gateway
publisher. The account collector's structured test seam changes login status without
changing journal or registration bytes; only profile keys publish. Stopping that
runtime source invalidates both private families and rejects a later read before
its route executes. These are source-owner tests, not account-login or device proofs.

## Configuration and planning query ownership

Configuration readers require observed-read support and retain their existing admin
permissions. Query selectors reject paths, command payloads and credential fields.
Every configuration query depends on `configuration/farm` and `sources/farm`;
project selectors also depend on `configuration/farm/{project}`.

| Read                                                                    | Persistence                     | Readers                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `config.projects`                                                       | One collection, aggregate 2 MiB | Both clients' project choices; web configuration, dispatch, graph, backlog, evaluation and PR metadata |
| `config.pools`, `config.pool`, `config.pool.raw`                        | Memory                          | Web configuration/editor, dispatch, PR and scoped slot/workspace metadata                              |
| `config.project`                                                        | Memory                          | Web project learnings; its content is not an additional durable project payload                        |
| `config.templates`, `config.templateOptions`, `config.templatePreview`  | Memory                          | Mounted web template/flow views, both clients' template choices and explicit execution previews        |
| `llm.config.get`, `llm.auth.list`, `llm.tiers`                          | Memory                          | Web provider configuration, redacted registration metadata and model context                           |
| `backlog.list`, `roadmap.list`, `workGraph.list`, `dispatch.queue.list` | Aggregate 2 MiB per collection  | Web planning panels; Companion's existing backlog/roadmap readers and PR queue                         |
| `roadmap.get`, `workGraph.get`                                          | Memory                          | Authored detail and derived delivery/context readers                                                   |

`config.projects`, `config.project` and project mutation replies omit declared
GitHub/Jira webhook secrets. Internal project loading retains those source values
for webhook verification. Registration observations contain redacted metadata;
login, refresh, tests and configuration writes remain imperative commands.

| Configuration owner                                                       | Publication after readable commit                                                      |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `config.slot.update`, `config.pool.update`                                | Farm configuration key after pool/status writes                                        |
| `config.project.backlog.update`, `config.project.autoRecovery.update`     | Farm and project configuration keys after settings/config writes and memo invalidation |
| `setLLMConfig`, including `llm.config.set`                                | Farm configuration key after file and memo update                                      |
| `saveAuthProfileStore` for selected Farmslot/OpenClaw registration stores | Farm configuration key after the existing owning store write                           |
| Existing pool file watcher                                                | Farm configuration key for JSON creation/change/deletion                               |
| Existing project and source runtime-settings watcher                      | Farm/project configuration keys after project memo invalidation                        |
| Existing watcher extended to project templates and learnings              | Farm/project configuration keys for template Markdown and `LEARNINGS.md` changes       |
| Existing watcher extended to selected LLM and registration files          | Farm configuration key; LLM file edits also clear the owning memo                      |

These producers extend existing observation boundaries and add no polling.
Planning stores retain their collection/item publications. Roadmap directory
observation also covers raw creation, edits, atomic replacement and deletion;
observation failure refuses fresh reads. Notification keys contain no credentials
or filesystem paths.

Web controllers and Companion query hooks own active observations. Demand-only
configuration reads share the same cache and reject replies after an owner
change. Local option arrays and forms are projections, not freshness owners.
Clean configuration forms follow a new read; actual unsaved policy edits survive
it. Companion backlog commands require the displayed current collection and
capture profile, principal and connection authority before dispatch. An explicit
backlog spec preview remains nonpersisted and fences late replies by its owner
and selected item; content persistence belongs to the later content slice.

`command-center-configuration-writers.recipe.json` proves actual slot/pool writes,
atomic template replacement and private registration-file writes on mounted
controls. The raw pool editor observes `config.pool.raw`: clean text follows new
revisions while real typed drafts survive invalidation. Selection and authority
changes fence editor reads and save replies. The old one-shot editor fails the
external-write assertion; restoring the observer passes all six recipe steps.
The seventh step corrupts the private registration file, requires the original
visible provider facts and observation time beside an error with actions
disabled, then repairs the file through the actual watcher. Registration-list
RPCs reject malformed or unreadable selected stores without exposing parser
excerpts; missing optional files remain valid absence. Internal credential
resolution keeps its existing fallback behavior. Other lifecycle variants
remain unaccepted.

The [browser planning recipe](../examples/recipes/farmslot/command-center-offline-planning.recipe.json)
covers external writers, real read failure with draft
retention, five cold collections with original SQLite times and age, disabled
writes, and actual project collections on both sides of the aggregate bound.
Cache regressions cover revocation while each persisted collection has a reply
in flight. Companion planning runtime proof and the remaining automation,
assessment, analytics and copilot migrations remain acceptance gates. Existing
manual Retry/Refresh controls remain until their replacement proof is accepted;
upstream collectors remain outside this slice.

### Planning transport and idle-observer checks

`command-center-planning-observers.recipe.json` keeps a real Backlog panel and two additional read-only canonical observers attached for a measured sixteen-second window. The existing CDP frame counter requires zero planning reads while the document, connection and principal stay unchanged. A private Vite transform that adds a periodic read must fail that assertion; restored source must pass.

`command-center-planning-lifecycle.recipe.json` suspends only the owned browser proxy tunnel while the gateway remains running. An independent gateway client changes the actual backlog source. The mounted page retains its saved row and age with its previously enabled Mark ready control disabled, then one current observed read restores the new source value under the same gateway epoch, document and principal. Watched browser command counters remain zero; fixture writers use a separate direct connection. Controls suppressing disconnected-state updates or reconnect synchronization must fail their respective guards, and restoration must pass. The original held-read/duplicate-notice race remains a separate regression. These checks do not establish native, desktop or sustained busy-writer acceptance.

PR push writer-key regressions exercise delivery reservation, delivery updates/failures, token replacement and acknowledgement through the actual private-file store. Each changed write publishes only after its disk bytes and readable snapshot agree; keys exclude private device/token/owner data. Stale reservations, duplicate acknowledgements and refused writes remain revision-quiet.

## D07 memory-only domain migration

Implementation and local regression coverage do not accept the draft. Mounted-client writer, authority, late-read and recovery evidence remains required for these domains. Companion planning/configuration runtime proof and desktop cold proof are still pending.

`command-center-domain-cache.recipe.json` now covers six browser claims through real mounted views: monitor lifecycle, external rule-file replacement, malformed-rule refusal/recovery, assessment feedback and summary updates, another project's analytics backfill while filtered, and stopped copilot configuration. Launch fixtures are explicit; no provider result or runner execution is claimed. Source bytes, canonical observations, rendered controls and owning revision changes are retained. Each producer has a causal control that fails its intended assertion when disabled. The cache's specified conservative invalidation fallback can refresh an unrelated query, so a visible update alone is insufficient: these assertions also require the matching owning revision to advance. Other writers, authority/lifecycle scenarios, native and desktop coverage remain separate acceptance gates.

`command-center-planning-authority.recipe.json` exercises all five persisted planning collections through real views and normal account controls. A disposable service principal replaces the original browser account; the old scope has no saved rows. An admin-to-operator downgrade retains farm access: backlog, work graphs and queue require fresh authorized reads, while roadmap and project facts disappear from cache, SQLite and their actual views. Removing the remaining operator role clears all five collections. Backlog and roadmap sources change while access is absent; restored authority renders those new titles through fresh reads. Cleanup verifies actual principal retirement, credential revocation, temporary-profile removal, no saved rows for the retired account and unchanged original account metadata. A no-op SQLite deletion fault fails the account-switch assertion. A separate fault retaining operator-bound stores passes account switching but fails the partial-authority assertion; normal cleanup clears that retired scope. The original global deletion fault's retained test scope was cleaned separately through the restored storage API, without changing its negative verdict.

`command-center-planning-race.recipe.json` holds a real observed reply across two owning writes, duplicates an unchanged source notification and verifies that the old reply stays stale before exactly one follow-up supplies current data. Bypassing revision coverage fails the obsolete-ready assertion. `command-center-planning-late-authority.recipe.json` delivers an unchanged captured admin reply on the same actor's verified operator connection. A later permitted response binds stream progress to the current canonical data; old request retirement and forbidden UI/cache/SQLite absence are checked. Retaining settled transport entries fails the retirement assertion, without claiming an actual data leak from that fault. Original authority coverage and existing-owner tab reuse also pass. These are browser proofs; native and desktop remain separate.

Companion has read-only work-graph and standalone dispatch-queue consumers, opened from Backlog. Both use one canonical collection query and local project filtering. Graphs expose node/dependency facts through a local expansion; queue rows retain their server ordering and show status, priority and waiting reasons. Retained farm scope permits offline reads; owner changes clear old facts through the shared hook. These consumers add no command, dispatch or replay path and offer Retry only after a read error.

The Companion cold-start recipe remains a preparation candidate, not native acceptance. It requires all five persisted collections, actual graph/queue warm and cold views and saved-age captions. While their views remain mounted, the graph writer pauses a planning graph and the queue writer changes only priority through their owning APIs. The proof requires an advanced owning revision, a successful app read after the write request, matching persisted reply bytes and unchanged runtime/profile/owner. Queue persistence is awaited before recording cleanup hashes; source receipts distinguish request time from receipt-recording time. Explicit host guards also cover canonical cache readiness, collection retention bounds, complete viewport/scroll clipping and paired OCR bounds. The development-only snapshot reads existing PR/copilot cache entries without observing or fetching them. Backlog source changes use the owning API on the isolated backend; roadmap and project changes use their supported file observers. Native artifact compatibility, controller integration and actual device evidence remain required. Static implementation and host checks do not establish cold UI behavior.

D07 fixture version 2 binds the actual authorized source commit to a Git checkout.
Before preparation or runtime imports, every tracked source file's bytes and mode
must match that commit, with no untracked files or substituted symlinks. This
check does not rely on Git's stat cache or assume-unchanged flags. The prepared
fixture records the verified tree and setup receipts use the same commit;
legacy fixture/source pins are refused. Generated native files, installed
dependencies and compiled JavaScript remain separate compatibility inputs.

All 17 added queries are memory-only, require observed reads and use the current owner cache. No new persistence class is introduced. Existing projects/planning persistence is unchanged.

| Canonical read                  | Selectors and dependencies                                                                 | Actual client consumers                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| prWatch.list / prWatch.get      | Empty / id. PR farm, runs farm, planning dispatch-queue, configuration farm                | Both PR controllers consume list. Detail remains existing RPC/CLI read                                          |
| prRules.list / prReview.get     | Empty / id. Same dependencies                                                              | Both PR controllers consume list. Existing request-detail RPC/CLI                                               |
| prPush.list                     | Empty. Same dependencies                                                                   | Both PR controllers; Companion registration admission                                                           |
| assessment.list / get / summary | before/limit/consumer; id; empty. Assessment farm                                          | Web assessment history/detail/summary. No direct Companion caller exists                                        |
| run.get for assessment outcomes | Exact run id, run key; existing run-detail policy                                          | Expanded or selected web assessment outcomes; released on collapse, selection, owner change and teardown        |
| assessment.report               | Existing id only. Assessment farm                                                          | Existing RPC read. No-id/cohort report generation stays an explicit command                                     |
| assessment.status               | Empty. Assessment farm + configuration farm                                                | Existing RPC/provider-status consumers; no direct screen call                                                   |
| decision.advice.get             | runId/decisionId. Assessment farm, run, decisions farm, configuration farm                 | Web decision-advice panel. No Companion GET caller                                                              |
| intelligence.triage.get         | runId/step/includeEvidence. Assessment farm, run/artifacts, configuration farm             | Web failure-triage panel. No Companion GET caller                                                               |
| analytics.query                 | project/host/flowType/runner/model/lane/since/until. Analytics farm                        | Web analytics panel. Companion has no analytics.query consumer; run-list summaries retain their run-cache owner |
| copilot.status                  | Empty. Shared copilot owner gateway-copilot, runs/slots/workers/configuration/sources farm | Web chat runtime and Companion copilot controller                                                               |
| chat.sessionContext             | Normalized sessionId. Shared copilot runtime + exact session                               | Web usage drawer. No Companion caller                                                                           |
| chat.context                    | Empty. Shared copilot + runs/slots/decisions/dispatch-queue                                | Existing RPC/tools. Neither screen directly calls it                                                            |
| chat.observerEvidence           | Bounded window/limit + severity/type/runId/slotId                                          | Existing RPC/tools. Shared copilot key. Neither screen directly calls it                                        |

Global-admin method authorization remains authoritative for these families. PR and assessment handlers preserve principal/generation filtering. Notifications use farm-only PR/assessment keys, exposing no private monitor, team, record, owner or source path. Copilot keys authorize only the actual shared gateway-copilot identity through existing global-admin reads. Arbitrary native/foreign owners are refused. Cache authority metadata continues to drop old-owner/role replies. Ordinary errors retain stale data and explicit errors; authorized missing details are NOT_FOUND, never empty successes.

### Owning publications

PR stores, assessment records/artifacts, analytics appends and copilot runtime persistence publish after a successful durable commit is readable; refused or failed commits do not publish success. Chat usage keys follow readable in-memory append/clear/delete/restore changes, while session persistence or durable deletion may finish later. No-op PR transactions stay quiet.

| Boundary                           | Actual writers and derived results                                                                                                                       | Key/event                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| PRMonitorStore.change              | subscribe/enrollRule/enrollPublication/configure/lifecycle/observe/acknowledge/policy/repair/history/update                                              | PR farm; existing decisions publication retained                                                                                        |
| PRRuleStore.change                 | team/rule/enable/webhook admission/submission/cancel/apply/decide/dispatch/action validation/completion/acknowledgement/replaced-contribution withdrawal | PR farm                                                                                                                                 |
| PRPushStore.change                 | register/disable/acknowledge/reserve/delivery update/failure/token replacement                                                                           | PR farm; no token in payload                                                                                                            |
| PR derived owners                  | Three scheduler errors, two dispatcher errors, enrollment failure/recovery, monitor activeRuns, changed owner-scoped push attention                      | PR farm only on readable transition. Existing D08 schedules unchanged                                                                   |
| PRRuleStore.reloadFromFile         | Actual external scripts/migrate-review-configuration.mjs rename, through the existing farm-directory watcher                                             | Serialized decode/swap; PR farm after change. Invalid/deleted source latches SOURCE_UNAVAILABLE; valid recovery invalidates error       |
| Assessment store                   | begin/reserve/finish/feedback, active-to-interrupted completion failure, expiry prune, observed retention deadline, audit-health failure                 | Assessment farm, no private detail IDs                                                                                                  |
| Assessment artifacts               | Input/report/evaluation atomic save and expiry prune                                                                                                     | Assessment farm. No-id report generation remains live                                                                                   |
| Analytics appendAnalyticsRecord    | Terminal/archive/delete run analytics, recovery held result, explicit backfill                                                                           | Analytics farm + safe project key after appendFile succeeds. Query still depends farm because dimensions/scannedRuns cover all projects |
| Copilot persist                    | Initialize/reconcile/configure/start/reconnect/send/stop/ambiguous/runtime failure                                                                       | Shared copilot, material saved-session differences only. Read timestamp/transcript offset alone do not self-invalidate                  |
| Copilot checkout                   | Existing WorkspaceObservations.capture around trusted checkout inspection                                                                                | Shared copilot. Realpath and post-read confirmation; no path in key. Git status disables optional locks                                 |
| Chat store                         | append/clear/delete/restore readable usage changes                                                                                                       | Exact copilot session key                                                                                                               |
| Observer log                       | Existing source event append and bounded-window expiry; pending decision age boundary                                                                    | Shared copilot. Infrastructure resource.changed cannot create observer evidence                                                         |
| Existing saved-memory writer/watch | Actual bootstrap MEMORY.md cache/watch plus memory/session-summary writes; SOUL/SKILLS loaders have no current caller                                    | Shared copilot after readable change. No new saved-memory endpoint or UI                                                                |

All domain publications use existing resource.changed and pre-handler revision stamps. There is no invented event transport or added polling. Copilot uses the existing 200ms publication pattern for busy source writes.

### Deliberately uncached operations and limits

PR refresh/scan/repair/request/publish, assessment analyze/test/evaluate/feedback/report creation, analytics backfill and copilot configure/start/stop remain direct live operations. prRules.preview invokes upstream collectors and is left explicit under D08 ownership. assessment.suggestion.preview is read-only but takes full operator context/evidence/source refs; it stays explicit and memory-only because putting those raw inputs in canonical IDs would violate key constraints. No alternate API or digest protocol is invented.

Launch plans/delivery are embedded backlog/roadmap reads; no independent read endpoint intrinsic to these four families was found. Existing planning readers retain their separate migration ownership. Upstream account observations, GitHub polling/CI monitor source schedules, source checkpoints and provider collectors remain excluded.

The existing farm-directory observer reloads the exact `.pr-rules.json` path across replacements and recreation. The selected-home observer invalidates assessment reads for `assessment-config.json`, `assessment-suggestion-policy.json`, `decision-advice-policy.json` and `triage-policy.json`. Its selected triage observation follows only the admitted manifest and eight fixed evaluation artifacts, including readable arrival, replacement, removal and selected directory/file symlinks. Policy changes retire the former watcher; unrelated files and unselected/retired directories do not invalidate it. Reads are bounded, exact receipt hashes remain authoritative, and observation loss refuses current read admission rather than fabricating a fresh empty result. `command-center-triage-receipts.recipe.json` proves actual mounted prerequisite updates and recovery without Refresh or provider execution; disabling the publication fails its intended assertion. Triage retains error-only Retry. The file observer imports only the source contract and pure policy identity helpers, avoiding a dependency on assessment execution or runner initialization. The recipe initializes the production transport entry before its browser steps so that this module boundary is also exercised. Arbitrary manual analytics NDJSON and assessment-record edits are outside the admitted writer contract.

### Configuration read errors

Client project collection/detail reads use strict decoding so a malformed project cannot become an authoritative empty collection or an authorized-not-found eviction. The internal fleet loader retains its tolerant default. A real-file regression covers list/detail failure and recovery, while the browser recipe checks retained rows, exact saved timestamps, visible errors and disabled writes. Its cold reference is captured after the gateway stops so delayed valid notifications cannot invalidate the reference timestamp.

PR dashboard data belongs to its query observers. Transport loss keeps their stale projections; owner or authority changes clear them through the cache lifecycle. Assessment history observes its canonical summary; displayed run outcomes observe the exact run and release their observers on collapse, selection/owner change and teardown. Retention reads arm one owning gateway deadline for the next expiry, including detail-only reads and overdue-read catchup, without pruning or rewriting records. `command-center-assessment-observations.recipe.json` checks real feedback, run deletion, read-error Retry, more than fifteen idle seconds and a pre-client fixture crossing its actual retention boundary. Those checks cover this consumer; other permanent Refresh controls remain until their replacement client evidence is accepted.

Analytics observes `analytics.query` under the farm analytics key. Owning appends update the mounted result without Refresh or a forced retry of an unchanged query. Relative windows keep an explicit **Update time window** selector action; read errors expose **Retry** for the same query. Backfill remains a live command that requires a current read. `command-center-analytics-observations.recipe.json` checks an actual terminal-run deletion and sink append, the rendered relative-window action, and recovery from a real source-read error. This query remains memory-only; its proof makes no cold-storage claim.

PR automation observes `prWatch.list`, `prRules.list` and `prPush.list` under the farm PR automation key. Healthy configuration has no Refresh control. Read errors expose **Retry configuration** in management and per-PR views; it retries only failed observations on a live transport, while mutations still need all current reads. `command-center-pr-automation-observations.recipe.json` checks external rule replacement, a disabled private push registration, failed-source Retry and repair. Explicit upstream scans, repairs, previews and account discovery keep their command owners.

Gateway writer regressions join existing launch-plan enqueue/materialization and run settlement to backlog/queue keys, and graph gate/scheduler commits to both collection and selected-graph keys. Saved-memory regressions cover the actual bootstrap MEMORY watcher and owning memory/session-summary writes, readable bytes at publication, privacy and failed-write quietness. The summary model is an external test seam; no provider execution is claimed. `loadSoul` and `loadSkills` are pre-existing unused prompt loaders, not canonical client reads, and are not migration acceptance evidence. Bootstrap memory loading remains with its explicit command owner.

Automatic reads also respect each dependency family's declared publication interval. A slow reply's follow-up cannot trigger another read immediately before the next notification. Explicit Retry remains immediate; unobserve, connection changes and disposal cancel deferred reads. Families without a declared interval retain microtask coalescing. `gateway-copilot-cache-cadence.recipe.json` exercises the production cache and transport over an authenticated WebSocket, real private `chat.clear` writes, an unchanged held reply, final revision coverage and idle quietness. Its client-delay negative control retains normal gateway publication timing and fails the read-spacing assertion. This is endpoint evidence, not native or browser copilot rendering acceptance.
