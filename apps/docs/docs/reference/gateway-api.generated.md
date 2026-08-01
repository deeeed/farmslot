---
title: Gateway API generated reference (raw)
unlisted: true
---

# Gateway API generated reference (raw)

This advanced reference is generated from `@farmslot/protocol` capability metadata plus TSDoc comments on protocol interfaces. Do not edit it by hand. For public onboarding, start with [Gateway API capability surface](./gateway-api.md). This raw table is intentionally unlisted because some low-level methods still have generated summaries while public-safe capability grouping and TSDoc coverage mature.

Protocol version: `0.15.0`

## WebSocket frame shape

### `RequestFrame`

Source: `packages/protocol/src/transport/frames.ts`

| Field    | Required | Comment |
| -------- | -------- | ------- |
| `type`   | yes      | —       |
| `id`     | yes      | —       |
| `method` | yes      | —       |
| `params` | no       | —       |

### `ResponseFrame`

Source: `packages/protocol/src/transport/frames.ts`

| Field     | Required | Comment |
| --------- | -------- | ------- |
| `type`    | yes      | —       |
| `id`      | yes      | —       |
| `ok`      | yes      | —       |
| `payload` | no       | —       |
| `error`   | no       | —       |

### `EventFrame`

Source: `packages/protocol/src/transport/frames.ts`

| Field     | Required | Comment |
| --------- | -------- | ------- |
| `type`    | yes      | —       |
| `event`   | yes      | —       |
| `payload` | no       | —       |
| `seq`     | no       | —       |

## Method capabilities

| Method                               | Category         | Safety        | Params | Result | Summary                                            |
| ------------------------------------ | ---------------- | ------------- | ------ | ------ | -------------------------------------------------- |
| `analytics.backfill`                 | analytics        | bounded-write | —      | —      | Analytics Backfill gateway method.                 |
| `analytics.query`                    | analytics        | bounded-write | —      | —      | Analytics Query gateway method.                    |
| `auth.connect`                       | auth             | bounded-write | —      | —      | Auth Connect gateway method.                       |
| `backlog.archive`                    | backlog          | bounded-write | —      | —      | Backlog Archive gateway method.                    |
| `backlog.autoDispatchTick`           | backlog          | bounded-write | —      | —      | Backlog AutoDispatchTick gateway method.           |
| `backlog.closeShipped`               | backlog          | bounded-write | —      | —      | Backlog CloseShipped gateway method.               |
| `backlog.create`                     | backlog          | bounded-write | —      | —      | Backlog Create gateway method.                     |
| `backlog.delete`                     | backlog          | high-impact   | —      | —      | Backlog Delete gateway method.                     |
| `backlog.dequeue`                    | backlog          | bounded-write | —      | —      | Backlog Dequeue gateway method.                    |
| `backlog.enqueue`                    | backlog          | bounded-write | —      | —      | Backlog Enqueue gateway method.                    |
| `backlog.list`                       | backlog          | read-only     | —      | —      | Backlog List gateway method.                       |
| `backlog.markReady`                  | backlog          | bounded-write | —      | —      | Backlog MarkReady gateway method.                  |
| `backlog.reconcileRun`               | backlog          | bounded-write | —      | —      | Backlog ReconcileRun gateway method.               |
| `backlog.spec.get`                   | backlog          | read-only     | —      | —      | Backlog Spec Get gateway method.                   |
| `backlog.upcoming`                   | backlog          | bounded-write | —      | —      | Backlog Upcoming gateway method.                   |
| `backlog.update`                     | backlog          | bounded-write | —      | —      | Backlog Update gateway method.                     |
| `chat.abort`                         | chat             | bounded-write | —      | —      | Chat Abort gateway method.                         |
| `chat.clear`                         | chat             | bounded-write | —      | —      | Chat Clear gateway method.                         |
| `chat.confirmAction`                 | chat             | bounded-write | —      | —      | Chat ConfirmAction gateway method.                 |
| `chat.context`                       | chat             | bounded-write | —      | —      | Chat Context gateway method.                       |
| `chat.history`                       | chat             | bounded-write | —      | —      | Chat History gateway method.                       |
| `chat.listActions`                   | chat             | read-only     | —      | —      | Chat ListActions gateway method.                   |
| `chat.new`                           | chat             | bounded-write | —      | —      | Chat New gateway method.                           |
| `chat.observerEvidence`              | chat             | bounded-write | —      | —      | Chat ObserverEvidence gateway method.              |
| `chat.saveMemory`                    | chat             | bounded-write | —      | —      | Chat SaveMemory gateway method.                    |
| `chat.screenEvidence`                | chat             | bounded-write | —      | —      | Chat ScreenEvidence gateway method.                |
| `chat.send`                          | chat             | bounded-write | —      | —      | Chat Send gateway method.                          |
| `chat.sessionContext`                | chat             | bounded-write | —      | —      | Chat SessionContext gateway method.                |
| `chat.sessionCreate`                 | chat             | bounded-write | —      | —      | Chat SessionCreate gateway method.                 |
| `chat.sessionDelete`                 | chat             | bounded-write | —      | —      | Chat SessionDelete gateway method.                 |
| `chat.sessionPin`                    | chat             | bounded-write | —      | —      | Chat SessionPin gateway method.                    |
| `chat.sessions`                      | chat             | bounded-write | —      | —      | Chat Sessions gateway method.                      |
| `chat.sessionsBulkDelete`            | chat             | bounded-write | —      | —      | Chat SessionsBulkDelete gateway method.            |
| `config.pool`                        | config           | bounded-write | —      | —      | Config Pool gateway method.                        |
| `config.pool.raw`                    | config           | bounded-write | —      | —      | Config Pool Raw gateway method.                    |
| `config.pool.update`                 | config           | bounded-write | —      | —      | Config Pool Update gateway method.                 |
| `config.pools`                       | config           | bounded-write | —      | —      | Config Pools gateway method.                       |
| `config.project`                     | config           | bounded-write | —      | —      | Config Project gateway method.                     |
| `config.project.autoRecovery.update` | config           | bounded-write | —      | —      | Config Project AutoRecovery Update gateway method. |
| `config.project.backlog.update`      | config           | bounded-write | —      | —      | Config Project Backlog Update gateway method.      |
| `config.projects`                    | config           | bounded-write | —      | —      | Config Projects gateway method.                    |
| `config.slot.update`                 | config           | bounded-write | —      | —      | Config Slot Update gateway method.                 |
| `config.templateOptions`             | config           | bounded-write | —      | —      | Config TemplateOptions gateway method.             |
| `config.templatePreview`             | config           | bounded-write | —      | —      | Config TemplatePreview gateway method.             |
| `config.templates`                   | config           | bounded-write | —      | —      | Config Templates gateway method.                   |
| `copilot.formatInstruction`          | copilot          | bounded-write | —      | —      | Copilot FormatInstruction gateway method.          |
| `decision.list`                      | decision         | read-only     | —      | —      | Decision List gateway method.                      |
| `decision.resolve`                   | decision         | high-impact   | —      | —      | Decision Resolve gateway method.                   |
| `diagnostics.run`                    | diagnostics      | bounded-write | —      | —      | Diagnostics Run gateway method.                    |
| `dispatch.candidates`                | dispatch         | bounded-write | —      | —      | Dispatch Candidates gateway method.                |
| `dispatch.matchProject`              | dispatch         | bounded-write | —      | —      | Dispatch MatchProject gateway method.              |
| `dispatch.preview`                   | dispatch         | bounded-write | —      | —      | Dispatch Preview gateway method.                   |
| `dispatch.queue.add`                 | dispatch         | bounded-write | —      | —      | Dispatch Queue Add gateway method.                 |
| `dispatch.queue.list`                | dispatch         | read-only     | —      | —      | Dispatch Queue List gateway method.                |
| `dispatch.queue.remove`              | dispatch         | bounded-write | —      | —      | Dispatch Queue Remove gateway method.              |
| `dispatch.queue.removeOrphan`        | dispatch         | bounded-write | —      | —      | Dispatch Queue RemoveOrphan gateway method.        |
| `dispatch.queue.reorder`             | dispatch         | bounded-write | —      | —      | Dispatch Queue Reorder gateway method.             |
| `dispatch.queue.update`              | dispatch         | bounded-write | —      | —      | Dispatch Queue Update gateway method.              |
| `eval.experiment.create`             | eval             | bounded-write | —      | —      | Eval Experiment Create gateway method.             |
| `eval.suite.cap.get`                 | eval             | read-only     | —      | —      | Eval Suite Cap Get gateway method.                 |
| `eval.suite.cap.update`              | eval             | bounded-write | —      | —      | Eval Suite Cap Update gateway method.              |
| `eval.trial.result.get`              | eval             | read-only     | —      | —      | Eval Trial Result Get gateway method.              |
| `eval.trial.start`                   | eval             | bounded-write | —      | —      | Eval Trial Start gateway method.                   |
| `family.observability.get`           | family           | read-only     | —      | —      | Family Observability Get gateway method.           |
| `family.report.generate`             | family           | bounded-write | —      | —      | Family Report Generate gateway method.             |
| `finetune.exportDPO`                 | finetune         | bounded-write | —      | —      | Finetune ExportDPO gateway method.                 |
| `finetune.exportSFT`                 | finetune         | bounded-write | —      | —      | Finetune ExportSFT gateway method.                 |
| `finetune.index`                     | finetune         | bounded-write | —      | —      | Finetune Index gateway method.                     |
| `fleet.prSummary`                    | fleet            | bounded-write | —      | —      | Fleet PrSummary gateway method.                    |
| `fleet.refresh`                      | fleet            | bounded-write | —      | —      | Fleet Refresh gateway method.                      |
| `fleet.refreshSlots`                 | fleet            | bounded-write | —      | —      | Fleet RefreshSlots gateway method.                 |
| `fleet.refreshSlots.cancel`          | fleet            | bounded-write | —      | —      | Fleet RefreshSlots Cancel gateway method.          |
| `fleet.status`                       | fleet            | read-only     | —      | —      | Fleet Status gateway method.                       |
| `fs.delete`                          | fs               | high-impact   | —      | —      | Fs Delete gateway method.                          |
| `fs.hash`                            | fs               | bounded-write | —      | —      | Fs Hash gateway method.                            |
| `fs.list`                            | fs               | read-only     | —      | —      | Fs List gateway method.                            |
| `fs.mkdir`                           | fs               | bounded-write | —      | —      | Fs Mkdir gateway method.                           |
| `fs.read`                            | fs               | read-only     | —      | —      | Fs Read gateway method.                            |
| `fs.rename`                          | fs               | bounded-write | —      | —      | Fs Rename gateway method.                          |
| `fs.reveal`                          | fs               | bounded-write | —      | —      | Fs Reveal gateway method.                          |
| `fs.write`                           | fs               | bounded-write | —      | —      | Fs Write gateway method.                           |
| `gateway.doctor`                     | gateway          | read-only     | —      | —      | Gateway Doctor gateway method.                     |
| `gateway.ping`                       | gateway          | read-only     | —      | —      | Gateway Ping gateway method.                       |
| `gateway.status`                     | gateway          | read-only     | —      | —      | Gateway Status gateway method.                     |
| `git.branchDiff`                     | git              | bounded-write | —      | —      | Git BranchDiff gateway method.                     |
| `git.diff`                           | git              | bounded-write | —      | —      | Git Diff gateway method.                           |
| `git.discard`                        | git              | high-impact   | —      | —      | Git Discard gateway method.                        |
| `git.files`                          | git              | bounded-write | —      | —      | Git Files gateway method.                          |
| `git.log`                            | git              | bounded-write | —      | —      | Git Log gateway method.                            |
| `git.show`                           | git              | bounded-write | —      | —      | Git Show gateway method.                           |
| `git.stage`                          | git              | bounded-write | —      | —      | Git Stage gateway method.                          |
| `git.status`                         | git              | read-only     | —      | —      | Git Status gateway method.                         |
| `git.unstage`                        | git              | bounded-write | —      | —      | Git Unstage gateway method.                        |
| `improvement.apply`                  | improvement      | bounded-write | —      | —      | Improvement Apply gateway method.                  |
| `improvement.chat`                   | improvement      | bounded-write | —      | —      | Improvement Chat gateway method.                   |
| `intelligence.actions.summary`       | intelligence     | bounded-write | —      | —      | Intelligence Actions Summary gateway method.       |
| `llm.auth.add`                       | llm              | bounded-write | —      | —      | Llm Auth Add gateway method.                       |
| `llm.auth.import`                    | llm              | bounded-write | —      | —      | Llm Auth Import gateway method.                    |
| `llm.auth.list`                      | llm              | read-only     | —      | —      | Llm Auth List gateway method.                      |
| `llm.auth.login`                     | llm              | bounded-write | —      | —      | Llm Auth Login gateway method.                     |
| `llm.auth.refresh`                   | llm              | bounded-write | —      | —      | Llm Auth Refresh gateway method.                   |
| `llm.auth.remove`                    | llm              | bounded-write | —      | —      | Llm Auth Remove gateway method.                    |
| `llm.auth.test`                      | llm              | bounded-write | —      | —      | Llm Auth Test gateway method.                      |
| `llm.config.get`                     | llm              | read-only     | —      | —      | Llm Config Get gateway method.                     |
| `llm.config.set`                     | llm              | bounded-write | —      | —      | Llm Config Set gateway method.                     |
| `llm.tiers`                          | llm              | bounded-write | —      | —      | Llm Tiers gateway method.                          |
| `node.health`                        | node             | bounded-write | —      | —      | Node Health gateway method.                        |
| `node.health.all`                    | node             | bounded-write | —      | —      | Node Health All gateway method.                    |
| `nodes.deploy`                       | nodes            | bounded-write | —      | —      | Nodes Deploy gateway method.                       |
| `nodes.list`                         | nodes            | read-only     | —      | —      | Nodes List gateway method.                         |
| `operator.snapshot`                  | operator         | bounded-write | —      | —      | Operator Snapshot gateway method.                  |
| `pairing.candidates`                 | pairing          | bounded-write | —      | —      | Pairing Candidates gateway method.                 |
| `pairing.create`                     | pairing          | bounded-write | —      | —      | Pairing Create gateway method.                     |
| `pairing.exchange`                   | pairing          | bounded-write | —      | —      | Pairing Exchange gateway method.                   |
| `pr.addComment`                      | pr               | bounded-write | —      | —      | Pr AddComment gateway method.                      |
| `pr.deleteComment`                   | pr               | high-impact   | —      | —      | Pr DeleteComment gateway method.                   |
| `pr.editComment`                     | pr               | bounded-write | —      | —      | Pr EditComment gateway method.                     |
| `pr.forSlot`                         | pr               | bounded-write | —      | —      | Pr ForSlot gateway method.                         |
| `pr.list`                            | pr               | read-only     | —      | —      | Pr List gateway method.                            |
| `pr.monitor`                         | pr               | bounded-write | —      | —      | Pr Monitor gateway method.                         |
| `pr.resolveThread`                   | pr               | high-impact   | —      | —      | Pr ResolveThread gateway method.                   |
| `pr.reviewComments`                  | pr               | bounded-write | —      | —      | Pr ReviewComments gateway method.                  |
| `pr.status`                          | pr               | read-only     | —      | —      | Pr Status gateway method.                          |
| `pr.submitReview`                    | pr               | bounded-write | —      | —      | Pr SubmitReview gateway method.                    |
| `providerAccounts.snapshot`          | providerAccounts | bounded-write | —      | —      | ProviderAccounts Snapshot gateway method.          |
| `recipe.cancel`                      | recipe           | bounded-write | —      | —      | Recipe Cancel gateway method.                      |
| `recipe.command`                     | recipe           | bounded-write | —      | —      | Recipe Command gateway method.                     |
| `recipe.projectHookCommand`          | recipe           | bounded-write | —      | —      | Recipe ProjectHookCommand gateway method.          |
| `recipe.projectHookRun`              | recipe           | bounded-write | —      | —      | Recipe ProjectHookRun gateway method.              |
| `recipe.rerun`                       | recipe           | bounded-write | —      | —      | Recipe Rerun gateway method.                       |
| `resource.cleanup`                   | resource         | bounded-write | —      | —      | Resource Cleanup gateway method.                   |
| `resource.control`                   | resource         | bounded-write | —      | —      | Resource Control gateway method.                   |
| `resource.health`                    | resource         | bounded-write | —      | —      | Resource Health gateway method.                    |
| `resource.list`                      | resource         | read-only     | —      | —      | Resource List gateway method.                      |
| `resource.watch.setEnabled`          | resource         | bounded-write | —      | —      | Resource Watch SetEnabled gateway method.          |
| `roadmap.delete`                     | roadmap          | high-impact   | —      | —      | Roadmap Delete gateway method.                     |
| `roadmap.get`                        | roadmap          | read-only     | —      | —      | Roadmap Get gateway method.                        |
| `roadmap.list`                       | roadmap          | read-only     | —      | —      | Roadmap List gateway method.                       |
| `roadmap.promote`                    | roadmap          | bounded-write | —      | —      | Roadmap Promote gateway method.                    |
| `roadmap.promotionDraft.get`         | roadmap          | read-only     | —      | —      | Roadmap PromotionDraft Get gateway method.         |
| `roadmap.promotionDraft.list`        | roadmap          | read-only     | —      | —      | Roadmap PromotionDraft List gateway method.        |
| `roadmap.promotionDraft.save`        | roadmap          | bounded-write | —      | —      | Roadmap PromotionDraft Save gateway method.        |
| `roadmap.prompt.get`                 | roadmap          | read-only     | —      | —      | Roadmap Prompt Get gateway method.                 |
| `roadmap.refine`                     | roadmap          | bounded-write | —      | —      | Roadmap Refine gateway method.                     |
| `roadmap.refinementSession.get`      | roadmap          | read-only     | —      | —      | Roadmap RefinementSession Get gateway method.      |
| `roadmap.save`                       | roadmap          | bounded-write | —      | —      | Roadmap Save gateway method.                       |
| `run.activateOnSlot`                 | run              | bounded-write | —      | —      | Run ActivateOnSlot gateway method.                 |
| `run.archive`                        | run              | bounded-write | —      | —      | Run Archive gateway method.                        |
| `run.autoRecovery.stop`              | run              | bounded-write | —      | —      | Run AutoRecovery Stop gateway method.              |
| `run.backfillSummaries`              | run              | bounded-write | —      | —      | Run BackfillSummaries gateway method.              |
| `run.bulkDelete`                     | run              | bounded-write | —      | —      | Run BulkDelete gateway method.                     |
| `run.bundle.export`                  | run              | bounded-write | —      | —      | Run Bundle Export gateway method.                  |
| `run.bundle.import`                  | run              | bounded-write | —      | —      | Run Bundle Import gateway method.                  |
| `run.bundle.list`                    | run              | read-only     | —      | —      | Run Bundle List gateway method.                    |
| `run.cancel`                         | run              | bounded-write | —      | —      | Run Cancel gateway method.                         |
| `run.ciWatch.poke`                   | run              | bounded-write | —      | —      | Run CiWatch Poke gateway method.                   |
| `run.cleanup`                        | run              | bounded-write | —      | —      | Run Cleanup gateway method.                        |
| `run.contextBundle`                  | run              | bounded-write | —      | —      | Run ContextBundle gateway method.                  |
| `run.create`                         | run              | bounded-write | —      | —      | Run Create gateway method.                         |
| `run.delete`                         | run              | high-impact   | —      | —      | Run Delete gateway method.                         |
| `run.forSlot`                        | run              | bounded-write | —      | —      | Run ForSlot gateway method.                        |
| `run.forceComplete`                  | run              | bounded-write | —      | —      | Run ForceComplete gateway method.                  |
| `run.get`                            | run              | read-only     | —      | —      | Run Get gateway method.                            |
| `run.getGrade`                       | run              | read-only     | —      | —      | Run GetGrade gateway method.                       |
| `run.grade`                          | run              | bounded-write | —      | —      | Run Grade gateway method.                          |
| `run.interactiveDev.resolve`         | run              | high-impact   | —      | —      | Run InteractiveDev Resolve gateway method.         |
| `run.list`                           | run              | read-only     | —      | —      | Run List gateway method.                           |
| `run.pause`                          | run              | lifecycle     | —      | —      | Run Pause gateway method.                          |
| `run.probeWorkerSignal`              | run              | bounded-write | —      | —      | Run ProbeWorkerSignal gateway method.              |
| `run.proposeImprovement`             | run              | bounded-write | —      | —      | Run ProposeImprovement gateway method.             |
| `run.recipeRunsForRun`               | run              | bounded-write | —      | —      | Run RecipeRunsForRun gateway method.               |
| `run.recipeRunsForSlot`              | run              | bounded-write | —      | —      | Run RecipeRunsForSlot gateway method.              |
| `run.recoveryProposal`               | run              | bounded-write | —      | —      | Run RecoveryProposal gateway method.               |
| `run.refreshMirror`                  | run              | bounded-write | —      | —      | Run RefreshMirror gateway method.                  |
| `run.refreshPublishPackage`          | run              | bounded-write | —      | —      | Run RefreshPublishPackage gateway method.          |
| `run.refreshReviewGate`              | run              | bounded-write | —      | —      | Run RefreshReviewGate gateway method.              |
| `run.rehydratePrNumber`              | run              | bounded-write | —      | —      | Run RehydratePrNumber gateway method.              |
| `run.replayStep`                     | run              | bounded-write | —      | —      | Run ReplayStep gateway method.                     |
| `run.resolveDecision`                | run              | high-impact   | —      | —      | Run ResolveDecision gateway method.                |
| `run.resume`                         | run              | lifecycle     | —      | —      | Run Resume gateway method.                         |
| `run.slotHistory`                    | run              | bounded-write | —      | —      | Run SlotHistory gateway method.                    |
| `run.tags.list`                      | run              | read-only     | —      | —      | Run Tags List gateway method.                      |
| `run.tags.set`                       | run              | bounded-write | —      | —      | Run Tags Set gateway method.                       |
| `screen.subscribe`                   | screen           | bounded-write | —      | —      | Screen Subscribe gateway method.                   |
| `screen.thumbnail`                   | screen           | bounded-write | —      | —      | Screen Thumbnail gateway method.                   |
| `screen.unsubscribe`                 | screen           | bounded-write | —      | —      | Screen Unsubscribe gateway method.                 |
| `search.query`                       | search           | bounded-write | —      | —      | Search Query gateway method.                       |
| `slot.action.list`                   | slot             | read-only     | —      | —      | Slot Action List gateway method.                   |
| `slot.action.run`                    | slot             | bounded-write | —      | —      | Slot Action Run gateway method.                    |
| `slot.autoRefresh`                   | slot             | bounded-write | —      | —      | Slot AutoRefresh gateway method.                   |
| `slot.check`                         | slot             | bounded-write | —      | —      | Slot Check gateway method.                         |
| `slot.cleanup`                       | slot             | bounded-write | —      | —      | Slot Cleanup gateway method.                       |
| `slot.fixtureRefresh`                | slot             | bounded-write | —      | —      | Slot FixtureRefresh gateway method.                |
| `slot.monitor`                       | slot             | bounded-write | —      | —      | Slot Monitor gateway method.                       |
| `slot.openEditor`                    | slot             | bounded-write | —      | —      | Slot OpenEditor gateway method.                    |
| `slot.prepare`                       | slot             | lifecycle     | —      | —      | Slot Prepare gateway method.                       |
| `slot.prepareStatus`                 | slot             | lifecycle     | —      | —      | Slot PrepareStatus gateway method.                 |
| `slot.recycle`                       | slot             | lifecycle     | —      | —      | Slot Recycle gateway method.                       |
| `slot.refresh`                       | slot             | bounded-write | —      | —      | Slot Refresh gateway method.                       |
| `slot.release`                       | slot             | lifecycle     | —      | —      | Slot Release gateway method.                       |
| `slot.reopen`                        | slot             | bounded-write | —      | —      | Slot Reopen gateway method.                        |
| `slot.show`                          | slot             | bounded-write | —      | —      | Slot Show gateway method.                          |
| `slot.softRefresh`                   | slot             | bounded-write | —      | —      | Slot SoftRefresh gateway method.                   |
| `stream.snapshot`                    | stream           | bounded-write | —      | —      | Stream Snapshot gateway method.                    |
| `stream.subscribe`                   | stream           | bounded-write | —      | —      | Stream Subscribe gateway method.                   |
| `stream.unsubscribe`                 | stream           | bounded-write | —      | —      | Stream Unsubscribe gateway method.                 |
| `task.progress`                      | task             | bounded-write | —      | —      | Task Progress gateway method.                      |
| `terminal.input`                     | terminal         | bounded-write | —      | —      | Terminal Input gateway method.                     |
| `terminal.reinit`                    | terminal         | bounded-write | —      | —      | Terminal Reinit gateway method.                    |
| `terminal.resize`                    | terminal         | bounded-write | —      | —      | Terminal Resize gateway method.                    |
| `terminal.send`                      | terminal         | bounded-write | —      | —      | Terminal Send gateway method.                      |
| `terminal.snapshot`                  | terminal         | bounded-write | —      | —      | Terminal Snapshot gateway method.                  |
| `terminal.subscribe`                 | terminal         | bounded-write | —      | —      | Terminal Subscribe gateway method.                 |
| `terminal.unsubscribe`               | terminal         | bounded-write | —      | —      | Terminal Unsubscribe gateway method.               |
| `terminal.worker.input`              | terminal         | bounded-write | —      | —      | Terminal Worker Input gateway method.              |
| `terminal.worker.resize`             | terminal         | bounded-write | —      | —      | Terminal Worker Resize gateway method.             |
| `terminal.worker.snapshot`           | terminal         | bounded-write | —      | —      | Terminal Worker Snapshot gateway method.           |
| `terminal.worker.subscribe`          | terminal         | bounded-write | —      | —      | Terminal Worker Subscribe gateway method.          |
| `terminal.worker.unsubscribe`        | terminal         | bounded-write | —      | —      | Terminal Worker Unsubscribe gateway method.        |
| `tmux.killPane`                      | tmux             | bounded-write | —      | —      | Tmux KillPane gateway method.                      |
| `tmux.list`                          | tmux             | read-only     | —      | —      | Tmux List gateway method.                          |
| `tmux.newWindow`                     | tmux             | bounded-write | —      | —      | Tmux NewWindow gateway method.                     |
| `tmux.renameWindow`                  | tmux             | bounded-write | —      | —      | Tmux RenameWindow gateway method.                  |
| `tmux.selectPane`                    | tmux             | bounded-write | —      | —      | Tmux SelectPane gateway method.                    |
| `tmux.selectWindow`                  | tmux             | bounded-write | —      | —      | Tmux SelectWindow gateway method.                  |
| `tmux.sendKeys`                      | tmux             | bounded-write | —      | —      | Tmux SendKeys gateway method.                      |
| `tmux.split`                         | tmux             | bounded-write | —      | —      | Tmux Split gateway method.                         |
| `tmux.synchronizePanes`              | tmux             | bounded-write | —      | —      | Tmux SynchronizePanes gateway method.              |
| `tmux.worker.list`                   | tmux             | read-only     | —      | —      | Tmux Worker List gateway method.                   |
| `tmux.worker.restore`                | tmux             | bounded-write | —      | —      | Tmux Worker Restore gateway method.                |
| `tmux.zoomPane`                      | tmux             | bounded-write | —      | —      | Tmux ZoomPane gateway method.                      |
| `workGraph.activate`                 | workGraph        | bounded-write | —      | —      | WorkGraph Activate gateway method.                 |
| `workGraph.addEdge`                  | workGraph        | bounded-write | —      | —      | WorkGraph AddEdge gateway method.                  |
| `workGraph.addNode`                  | workGraph        | bounded-write | —      | —      | WorkGraph AddNode gateway method.                  |
| `workGraph.create`                   | workGraph        | bounded-write | —      | —      | WorkGraph Create gateway method.                   |
| `workGraph.gateResolve`              | workGraph        | bounded-write | —      | —      | WorkGraph GateResolve gateway method.              |
| `workGraph.get`                      | workGraph        | read-only     | —      | —      | WorkGraph Get gateway method.                      |
| `workGraph.list`                     | workGraph        | read-only     | —      | —      | WorkGraph List gateway method.                     |
| `workGraph.pause`                    | workGraph        | lifecycle     | —      | —      | WorkGraph Pause gateway method.                    |
| `workGraph.removeEdge`               | workGraph        | bounded-write | —      | —      | WorkGraph RemoveEdge gateway method.               |
| `workGraph.removeNode`               | workGraph        | bounded-write | —      | —      | WorkGraph RemoveNode gateway method.               |
| `workGraph.schedulerTick`            | workGraph        | bounded-write | —      | —      | WorkGraph SchedulerTick gateway method.            |
| `workGraph.updateNode`               | workGraph        | bounded-write | —      | —      | WorkGraph UpdateNode gateway method.               |
| `worker.session.history.get`         | worker           | read-only     | —      | —      | Worker Session History Get gateway method.         |
| `worker.session.history.subscribe`   | worker           | bounded-write | —      | —      | Worker Session History Subscribe gateway method.   |
| `worker.session.history.unsubscribe` | worker           | bounded-write | —      | —      | Worker Session History Unsubscribe gateway method. |
| `workspace.metro.subscribe`          | workspace        | bounded-write | —      | —      | Workspace Metro Subscribe gateway method.          |
| `workspace.metro.unsubscribe`        | workspace        | bounded-write | —      | —      | Workspace Metro Unsubscribe gateway method.        |

## Documented params/results

## Events

| Event                           | Category  | Summary                                      |
| ------------------------------- | --------- | -------------------------------------------- |
| `backlog.updated`               | backlog   | Backlog Updated gateway event.               |
| `chat.memory.saved`             | chat      | Chat Memory Saved gateway event.             |
| `chat.response`                 | chat      | Chat Response gateway event.                 |
| `ci.check.updated`              | ci        | Ci Check Updated gateway event.              |
| `copilot.observer.notification` | copilot   | Copilot Observer Notification gateway event. |
| `decision.new`                  | decision  | Decision New gateway event.                  |
| `decision.resolved`             | decision  | Decision Resolved gateway event.             |
| `decision.updated`              | decision  | Decision Updated gateway event.              |
| `fleet.refresh.scheduled`       | fleet     | Fleet Refresh Scheduled gateway event.       |
| `fleet.refresh.slot-update`     | fleet     | Fleet Refresh Slot Update gateway event.     |
| `fleet.refresh.summary`         | fleet     | Fleet Refresh Summary gateway event.         |
| `fleet.thumbnails.updated`      | fleet     | Fleet Thumbnails Updated gateway event.      |
| `fleet.updated`                 | fleet     | Fleet Updated gateway event.                 |
| `github.rateLimit`              | github    | Github RateLimit gateway event.              |
| `hello`                         | hello     | Hello gateway event.                         |
| `llm.auth.login.progress`       | llm       | Llm Auth Login Progress gateway event.       |
| `monitor.violation`             | monitor   | Monitor Violation gateway event.             |
| `node.connected`                | node      | Node Connected gateway event.                |
| `node.disconnected`             | node      | Node Disconnected gateway event.             |
| `node.health.updated`           | node      | Node Health Updated gateway event.           |
| `node.version.mismatch`         | node      | Node Version Mismatch gateway event.         |
| `pr.updated`                    | pr        | Pr Updated gateway event.                    |
| `queue.updated`                 | queue     | Queue Updated gateway event.                 |
| `resource.relaunched`           | resource  | Resource Relaunched gateway event.           |
| `resource.status.updated`       | resource  | Resource Status Updated gateway event.       |
| `run.completed`                 | run       | Run Completed gateway event.                 |
| `run.created`                   | run       | Run Created gateway event.                   |
| `run.decision.new`              | run       | Run Decision New gateway event.              |
| `run.decision.resolved`         | run       | Run Decision Resolved gateway event.         |
| `run.decision.updated`          | run       | Run Decision Updated gateway event.          |
| `run.deleted`                   | run       | Run Deleted gateway event.                   |
| `run.improvement.failed`        | run       | Run Improvement Failed gateway event.        |
| `run.step.completed`            | run       | Run Step Completed gateway event.            |
| `run.updated`                   | run       | Run Updated gateway event.                   |
| `script.complete`               | script    | Script Complete gateway event.               |
| `script.output`                 | script    | Script Output gateway event.                 |
| `slot.changed`                  | slot      | Slot Changed gateway event.                  |
| `slot.prepare.done`             | slot      | Slot Prepare Done gateway event.             |
| `slot.prepare.step`             | slot      | Slot Prepare Step gateway event.             |
| `stream.frame`                  | stream    | Stream Frame gateway event.                  |
| `stream.status`                 | stream    | Stream Status gateway event.                 |
| `task.progress.updated`         | task      | Task Progress Updated gateway event.         |
| `terminal.data`                 | terminal  | Terminal Data gateway event.                 |
| `terminal.exited`               | terminal  | Terminal Exited gateway event.               |
| `terminal.mode`                 | terminal  | Terminal Mode gateway event.                 |
| `tmux.worker.inventory.updated` | tmux      | Tmux Worker Inventory Updated gateway event. |
| `workGraph.updated`             | workGraph | WorkGraph Updated gateway event.             |
| `worker.session.history.delta`  | worker    | Worker Session History Delta gateway event.  |
| `worker.signal`                 | worker    | Worker Signal gateway event.                 |
| `workspace.metro.data`          | workspace | Workspace Metro Data gateway event.          |
