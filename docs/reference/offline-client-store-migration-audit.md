# Offline client store migration audit

This tracks roadmap item `ri_b1bb5ad00e17`. The [specification](gateway-change-notifications.md)
owns the contract. Acceptance remains incomplete while any applicable reader, writer or
platform proof below is pending.

## Current query owners

| Query                                  | Dependencies                          | Persistence             | Current consumers                                                                                                                                                       |
| -------------------------------------- | ------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources.status`                       | `sources/farm`                        | 2 MB                    | Sources controllers in Command Center and Companion                                                                                                                     |
| `run.list`                             | `runs/farm`                           | 20 MB across variants   | Browser active/history/tag/family lists and comparison baseline picker; native active and explicit history collections                                                  |
| `run.get`                              | `run/{runId}`, `runs/farm`            | 50 entries, 20 MB total | Browser detail/comparison/family, publication workspace and selected dispatch baseline; native detail, diff, artifact viewer, family, gates, decisions and saved review |
| `decision.list`                        | `decisions/farm`                      | 10 MB across variants   | Browser inbox; native inbox, decision workspace and gate action guards                                                                                                  |
| `run.recipeRunsForRun`                 | `run/{runId}`, `artifacts/{runId}`    | Memory                  | Browser run detail, SlotView and frozen publication workspace; native run detail, diff, frozen artifact viewer, decision workspace and gate acceptance evidence         |
| `family.observability.get`             | `family/{familyId}`, `decisions/farm` | Memory                  | Browser comparison and family view; native family workspace                                                                                                             |
| `run.slotHistory`                      | `runs/farm`, `slots/farm`             | Memory                  | Browser slot history                                                                                                                                                    |
| `run.forSlot`, `run.recipeRunsForSlot` | `runs/farm`, `slot/{slotId}`          | Memory                  | Browser SlotView selection through `run.forSlot`; `run.recipeRunsForSlot` consumers remain to migrate                                                                   |
| `run.tags.list`                        | `runs/farm`                           | Memory                  | Browser tag filters                                                                                                                                                     |

The protocol registry is `packages/protocol/src/client-cache/registry.ts`. Parameters form
part of query identity. Native active/history/decision deadlines remain 20/60/30 seconds;
history remains explicit and bounded to 80 rows until the version-list migration.

## Freshness audit

| Consumer                                   | Removed mechanism                                                                                                                             | Replacement                                                           | Proof                                                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Sources controllers                        | Client refresh scheduling and settle reads                                                                                                    | Shared `sources.status` observation                                   | Sources live recipes                                                                                                              |
| Browser run collections and inbox          | Domain event payload adoption                                                                                                                 | Shared `run.list` and `decision.list` observations                    | `command-center-offline-runs.recipe.json`                                                                                         |
| Browser full run detail                    | Direct payload adoption, trimmed-detail retries, post-write reads and mirror-delay guess                                                      | Shared `run.get` and recipe observations                              | Same recipe, full-detail and artifact-arrival assertions                                                                          |
| Browser batch archive                      | Treating one catch-up response as current authority                                                                                           | Wait on shared observations until all selected query inputs are ready | Same recipe, explicit batch archive assertions                                                                                    |
| Browser run comparison                     | Direct full-run, sibling and family reads tied to app snapshots                                                                               | Shared full-run, family-list and family-snapshot observations         | `command-center-offline-runs.recipe.json`, comparison assertions and notification negative control                                |
| Native active/history/inbox collections    | Run/decision event payload adoption and queued decision refresh                                                                               | Shared active/history/decision observations                           | `runs-live.recipe.json`                                                                                                           |
| Native full run detail                     | Separate full-run/recipe reads, run event adoption and replay-result adoption                                                                 | Shared full-run and recipe observations                               | `runs-live.recipe.json`, including cold app restart                                                                               |
| Native saved review                        | Independent full-run refresh, list-row replacement and post-publication settle read                                                           | Shared full-run observation; explicit retry after read failure        | `runs-context-live.recipe.json`; iOS and Android component proofs pass                                                            |
| Native decision workspace                  | Local decision/full-run copies, domain event adoption and reconnect recipe reads                                                              | Shared inbox, full-run and recipe observations                        | Same context recipe; iOS and Android component proofs pass                                                                        |
| Native gate review and acceptance evidence | Local full-run copy, domain event adoption and independent recipe-evidence read                                                               | Shared full-run and parameterized recipe observations                 | Same context recipe; iOS and Android component proofs pass                                                                        |
| Family views in both clients               | Native 30-second poll, 400-ms settle timer, per-event reads and local full-run adoption; browser connection/post-write reads and full-run map | Shared family, selected-run and per-run recipe observations           | Browser offline run recipe and native `family-live.recipe.json`; combined browser 35/35 and native family 13/13 on both platforms |

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

## Run writer coverage

| Writer                       | Notification owner                                                  | Covered behavior                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run persistence and deletion | `services/gateway/src/runs/store.ts`, `resources/run-changes.ts`    | Run, collection, decision, family and artifact dependencies                                                                                              |
| Worker decision files        | `observability/fleet-monitor.ts`                                    | Creation, content change, removal and read failure/recovery                                                                                              |
| File decision resolution     | `methods/decisions.ts`, file-decision owner                         | Physical deletion before acknowledgement; failures propagate                                                                                             |
| Artifact acquisition         | `run-completion/artifact-mirror.ts`                                 | Actual copy/prune/pointer changes notify; unchanged acquisitions stay quiet                                                                              |
| Feedback consumption         | `intelligence/feedback-ledger.ts`                                   | Inbox and retrospective derivations change after consumption                                                                                             |
| PR monitor observations      | `pr-monitoring/store.ts`                                            | Run-derived monitor decisions invalidate when their inputs change                                                                                        |
| Slot binding and membership  | `core/state.ts`, `fleet/state.ts`, `resources/slot-run-bindings.ts` | Direct/CAS/claim/mark/transition/reset/rewrite commits and external file changes invalidate affected slot and run projections; failed reads stay visible |
| Inbox expiry                 | `runs/decision-inbox.ts`, resource deadline owner                   | Existing 48-hour expiry invalidates the inbox without rewriting the run                                                                                  |

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

## Remaining acceptance

- Finish workspace source controls and the combined browser proof; dispatch controls are accepted.
  Complete the remaining native conversation platform matrix. iOS component proof and controls pass; terminal, visual-review and artifact reader component evidence is recorded.
- Migrate the remaining consumers of `run.forSlot` and `run.recipeRunsForSlot`; binding writers and dependencies now have isolated tests, live browser history and SlotView evidence.
- Finish native context recipes and negative controls, then the browser, desktop,
  iOS and Android authority/profile and connected-stale command matrix.
- Re-measure reconnect bytes and time against the baseline.
- Complete the fleet/session, configuration/planning and upstream migrations, followed
  by content reads, content caching, conditional edits and gated version lists.

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
