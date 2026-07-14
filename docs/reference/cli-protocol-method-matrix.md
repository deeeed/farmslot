# CLI Protocol Method Matrix

Generated from [`cli-protocol-method-matrix.json`](cli-protocol-method-matrix.json) —
edit the JSON, then run `node scripts/quality/check-method-matrix.mjs --write-markdown`.
CI fails when a registry method is missing from the matrix or this file is stale.

- **typed-command** — Reachable through a dedicated farmslot subcommand (envelope-emitting).
- **tui** — Driven from a farmslot tui surface.
- **rpc-only** — Reachable via `farmslot rpc <method>`; no dedicated command yet.
- **na** — Not a CLI target (web-UI-internal or transport-level); note explains why.

## analytics.\*

| Method               | Surface       | CLI command          | TUI | Note |
| -------------------- | ------------- | -------------------- | --- | ---- |
| `analytics.query`    | typed-command | `farmslot analytics` |     |      |
| `analytics.backfill` | typed-command | `farmslot analytics` |     |      |

## auth.\*

| Method         | Surface       | CLI command      | TUI | Note                                                                            |
| -------------- | ------------- | ---------------- | --- | ------------------------------------------------------------------------------- |
| `auth.connect` | typed-command | `farmslot login` |     | Also the implicit transport handshake on every authenticated client connection. |

## backlog.\*

| Method                     | Surface       | CLI command        | TUI | Note |
| -------------------------- | ------------- | ------------------ | --- | ---- |
| `backlog.create`           | typed-command | `farmslot backlog` |     |      |
| `backlog.list`             | typed-command | `farmslot backlog` | yes |      |
| `backlog.update`           | typed-command | `farmslot backlog` |     |      |
| `backlog.delete`           | rpc-only      |                    |     |      |
| `backlog.markReady`        | typed-command | `farmslot backlog` | yes |      |
| `backlog.archive`          | rpc-only      |                    |     |      |
| `backlog.enqueue`          | typed-command | `farmslot backlog` | yes |      |
| `backlog.dequeue`          | rpc-only      |                    |     |      |
| `backlog.autoDispatchTick` | typed-command | `farmslot backlog` | yes |      |
| `backlog.upcoming`         | rpc-only      |                    |     |      |
| `backlog.spec.get`         | typed-command | `farmslot backlog` |     |      |
| `backlog.closeShipped`     | typed-command | `farmslot backlog` | yes |      |

## chat.\*

| Method                    | Surface | CLI command | TUI | Note                                  |
| ------------------------- | ------- | ----------- | --- | ------------------------------------- |
| `chat.send`               | na      |             |     | Command Center chat surface (web UI). |
| `chat.history`            | na      |             |     | Command Center chat surface (web UI). |
| `chat.clear`              | na      |             |     | Command Center chat surface (web UI). |
| `chat.new`                | na      |             |     | Command Center chat surface (web UI). |
| `chat.sessions`           | na      |             |     | Command Center chat surface (web UI). |
| `chat.sessionCreate`      | na      |             |     | Command Center chat surface (web UI). |
| `chat.sessionDelete`      | na      |             |     | Command Center chat surface (web UI). |
| `chat.sessionsBulkDelete` | na      |             |     | Command Center chat surface (web UI). |
| `chat.sessionPin`         | na      |             |     | Command Center chat surface (web UI). |
| `chat.screenEvidence`     | na      |             |     | Command Center chat surface (web UI). |
| `chat.observerEvidence`   | na      |             |     | Command Center chat surface (web UI). |
| `chat.saveMemory`         | na      |             |     | Command Center chat surface (web UI). |
| `chat.confirmAction`      | na      |             |     | Command Center chat surface (web UI). |
| `chat.listActions`        | na      |             |     | Command Center chat surface (web UI). |
| `chat.abort`              | na      |             |     | Command Center chat surface (web UI). |
| `chat.context`            | na      |             |     | Command Center chat surface (web UI). |
| `chat.sessionContext`     | na      |             |     | Command Center chat surface (web UI). |

## config.\*

| Method                               | Surface       | CLI command       | TUI | Note |
| ------------------------------------ | ------------- | ----------------- | --- | ---- |
| `config.pools`                       | typed-command | `farmslot config` |     |      |
| `config.pool`                        | rpc-only      |                   |     |      |
| `config.projects`                    | typed-command | `farmslot config` |     |      |
| `config.project`                     | rpc-only      |                   |     |      |
| `config.pool.raw`                    | rpc-only      |                   |     |      |
| `config.templates`                   | rpc-only      |                   |     |      |
| `config.templatePreview`             | rpc-only      |                   |     |      |
| `config.templateOptions`             | rpc-only      |                   |     |      |
| `config.slot.update`                 | rpc-only      |                   |     |      |
| `config.pool.update`                 | rpc-only      |                   |     |      |
| `config.project.autoRecovery.update` | rpc-only      |                   |     |      |
| `config.project.backlog.update`      | rpc-only      |                   |     |      |

## copilot.\*

| Method                      | Surface | CLI command | TUI | Note                                     |
| --------------------------- | ------- | ----------- | --- | ---------------------------------------- |
| `copilot.formatInstruction` | na      |             |     | Command Center copilot surface (web UI). |

## decision.\*

| Method             | Surface  | CLI command | TUI | Note |
| ------------------ | -------- | ----------- | --- | ---- |
| `decision.list`    | rpc-only |             |     |      |
| `decision.resolve` | rpc-only |             |     |      |

## diagnostics.\*

| Method            | Surface  | CLI command | TUI | Note |
| ----------------- | -------- | ----------- | --- | ---- |
| `diagnostics.run` | rpc-only |             |     |      |

## dispatch.\*

| Method                        | Surface       | CLI command         | TUI | Note |
| ----------------------------- | ------------- | ------------------- | --- | ---- |
| `dispatch.preview`            | typed-command | `farmslot dispatch` |     |      |
| `dispatch.matchProject`       | rpc-only      |                     |     |      |
| `dispatch.candidates`         | rpc-only      |                     |     |      |
| `dispatch.queue.add`          | rpc-only      |                     |     |      |
| `dispatch.queue.list`         | rpc-only      |                     |     |      |
| `dispatch.queue.remove`       | rpc-only      |                     |     |      |
| `dispatch.queue.removeOrphan` | rpc-only      |                     |     |      |
| `dispatch.queue.update`       | rpc-only      |                     |     |      |
| `dispatch.queue.reorder`      | rpc-only      |                     |     |      |

## eval.\*

| Method                   | Surface  | CLI command | TUI | Note |
| ------------------------ | -------- | ----------- | --- | ---- |
| `eval.experiment.create` | rpc-only |             |     |      |
| `eval.trial.start`       | rpc-only |             |     |      |
| `eval.trial.result.get`  | rpc-only |             |     |      |
| `eval.suite.cap.get`     | rpc-only |             |     |      |
| `eval.suite.cap.update`  | rpc-only |             |     |      |

## family.\*

| Method                     | Surface  | CLI command | TUI | Note |
| -------------------------- | -------- | ----------- | --- | ---- |
| `family.observability.get` | rpc-only |             |     |      |
| `family.report.generate`   | rpc-only |             |     |      |

## finetune.\*

| Method               | Surface  | CLI command | TUI | Note |
| -------------------- | -------- | ----------- | --- | ---- |
| `finetune.index`     | rpc-only |             |     |      |
| `finetune.exportSFT` | rpc-only |             |     |      |
| `finetune.exportDPO` | rpc-only |             |     |      |

## fleet.\*

| Method                      | Surface       | CLI command      | TUI | Note |
| --------------------------- | ------------- | ---------------- | --- | ---- |
| `fleet.status`              | typed-command | `farmslot fleet` | yes |      |
| `fleet.refresh`             | typed-command | `farmslot fleet` |     |      |
| `fleet.refreshSlots`        | rpc-only      |                  |     |      |
| `fleet.refreshSlots.cancel` | rpc-only      |                  |     |      |
| `fleet.prSummary`           | rpc-only      |                  |     |      |

## fs.\*

| Method      | Surface | CLI command | TUI | Note                                   |
| ----------- | ------- | ----------- | --- | -------------------------------------- |
| `fs.list`   | na      |             |     | Slot Workspace IDE file view (web UI). |
| `fs.read`   | na      |             |     | Slot Workspace IDE file view (web UI). |
| `fs.hash`   | na      |             |     | Slot Workspace IDE file view (web UI). |
| `fs.write`  | na      |             |     | Slot Workspace IDE file view (web UI). |
| `fs.rename` | na      |             |     | Slot Workspace IDE file view (web UI). |
| `fs.delete` | na      |             |     | Slot Workspace IDE file view (web UI). |
| `fs.reveal` | na      |             |     | Slot Workspace IDE file view (web UI). |
| `fs.mkdir`  | na      |             |     | Slot Workspace IDE file view (web UI). |

## gateway.\*

| Method           | Surface  | CLI command | TUI | Note |
| ---------------- | -------- | ----------- | --- | ---- |
| `gateway.status` | rpc-only |             |     |      |
| `gateway.doctor` | rpc-only |             |     |      |

## git.\*

| Method           | Surface | CLI command | TUI | Note                              |
| ---------------- | ------- | ----------- | --- | --------------------------------- |
| `git.status`     | na      |             |     | Slot Workspace git view (web UI). |
| `git.diff`       | na      |             |     | Slot Workspace git view (web UI). |
| `git.log`        | na      |             |     | Slot Workspace git view (web UI). |
| `git.show`       | na      |             |     | Slot Workspace git view (web UI). |
| `git.branchDiff` | na      |             |     | Slot Workspace git view (web UI). |
| `git.stage`      | na      |             |     | Slot Workspace git view (web UI). |
| `git.unstage`    | na      |             |     | Slot Workspace git view (web UI). |
| `git.discard`    | na      |             |     | Slot Workspace git view (web UI). |
| `git.files`      | na      |             |     | Slot Workspace git view (web UI). |

## improvement.\*

| Method              | Surface  | CLI command | TUI | Note |
| ------------------- | -------- | ----------- | --- | ---- |
| `improvement.chat`  | rpc-only |             |     |      |
| `improvement.apply` | rpc-only |             |     |      |

## intelligence.\*

| Method                         | Surface  | CLI command | TUI | Note |
| ------------------------------ | -------- | ----------- | --- | ---- |
| `intelligence.actions.summary` | rpc-only |             |     |      |

## llm.\*

| Method             | Surface  | CLI command | TUI | Note |
| ------------------ | -------- | ----------- | --- | ---- |
| `llm.auth.list`    | rpc-only |             |     |      |
| `llm.auth.add`     | rpc-only |             |     |      |
| `llm.auth.remove`  | rpc-only |             |     |      |
| `llm.auth.test`    | rpc-only |             |     |      |
| `llm.auth.import`  | rpc-only |             |     |      |
| `llm.auth.refresh` | rpc-only |             |     |      |
| `llm.auth.login`   | rpc-only |             |     |      |
| `llm.config.get`   | rpc-only |             |     |      |
| `llm.config.set`   | rpc-only |             |     |      |
| `llm.tiers`        | rpc-only |             |     |      |

## node.\*

| Method            | Surface  | CLI command | TUI | Note |
| ----------------- | -------- | ----------- | --- | ---- |
| `node.health`     | rpc-only |             |     |      |
| `node.health.all` | rpc-only |             |     |      |

## nodes.\*

| Method         | Surface       | CLI command        | TUI | Note |
| -------------- | ------------- | ------------------ | --- | ---- |
| `nodes.list`   | typed-command | `farmslot gateway` |     |      |
| `nodes.deploy` | typed-command | `farmslot node`    |     |      |

## operator.\*

| Method              | Surface  | CLI command | TUI | Note |
| ------------------- | -------- | ----------- | --- | ---- |
| `operator.snapshot` | rpc-only |             |     |      |

## pairing.\*

| Method               | Surface       | CLI command             | TUI | Note |
| -------------------- | ------------- | ----------------------- | --- | ---- |
| `pairing.create`     | typed-command | `farmslot pair`         |     |      |
| `pairing.candidates` | rpc-only      |                         |     |      |
| `pairing.exchange`   | typed-command | `farmslot login --code` |     |      |

## pr.\*

| Method              | Surface       | CLI command   | TUI | Note |
| ------------------- | ------------- | ------------- | --- | ---- |
| `pr.status`         | typed-command | `farmslot pr` |     |      |
| `pr.list`           | typed-command | `farmslot pr` |     |      |
| `pr.monitor`        | rpc-only      |               |     |      |
| `pr.reviewComments` | rpc-only      |               |     |      |
| `pr.addComment`     | rpc-only      |               |     |      |
| `pr.resolveThread`  | rpc-only      |               |     |      |
| `pr.forSlot`        | rpc-only      |               |     |      |
| `pr.editComment`    | rpc-only      |               |     |      |
| `pr.deleteComment`  | rpc-only      |               |     |      |
| `pr.submitReview`   | rpc-only      |               |     |      |

## recipe.\*

| Method                      | Surface       | CLI command       | TUI | Note |
| --------------------------- | ------------- | ----------------- | --- | ---- |
| `recipe.rerun`              | rpc-only      |                   |     |      |
| `recipe.cancel`             | rpc-only      |                   |     |      |
| `recipe.command`            | rpc-only      |                   |     |      |
| `recipe.projectHookCommand` | typed-command | `farmslot recipe` |     |      |
| `recipe.projectHookRun`     | typed-command | `farmslot recipe` |     |      |

## resource.\*

| Method                      | Surface  | CLI command | TUI | Note |
| --------------------------- | -------- | ----------- | --- | ---- |
| `resource.list`             | rpc-only |             |     |      |
| `resource.control`          | rpc-only |             |     |      |
| `resource.health`           | rpc-only |             |     |      |
| `resource.cleanup`          | rpc-only |             |     |      |
| `resource.watch.setEnabled` | rpc-only |             |     |      |

## roadmap.\*

| Method                          | Surface  | CLI command | TUI | Note |
| ------------------------------- | -------- | ----------- | --- | ---- |
| `roadmap.list`                  | rpc-only |             |     |      |
| `roadmap.get`                   | rpc-only |             |     |      |
| `roadmap.save`                  | rpc-only |             |     |      |
| `roadmap.delete`                | rpc-only |             |     |      |
| `roadmap.refine`                | rpc-only |             |     |      |
| `roadmap.refinementSession.get` | rpc-only |             |     |      |
| `roadmap.prompt.get`            | rpc-only |             |     |      |
| `roadmap.promotionDraft.list`   | rpc-only |             |     |      |
| `roadmap.promotionDraft.get`    | rpc-only |             |     |      |
| `roadmap.promotionDraft.save`   | rpc-only |             |     |      |
| `roadmap.promote`               | rpc-only |             |     |      |

## run.\*

| Method                       | Surface       | CLI command     | TUI | Note |
| ---------------------------- | ------------- | --------------- | --- | ---- |
| `run.bundle.export`          | rpc-only      |                 |     |      |
| `run.bundle.import`          | typed-command | `farmslot runs` |     |      |
| `run.bundle.list`            | rpc-only      |                 |     |      |
| `run.create`                 | typed-command | `farmslot run`  |     |      |
| `run.get`                    | typed-command | `farmslot run`  |     |      |
| `run.contextBundle`          | rpc-only      |                 |     |      |
| `run.recoveryProposal`       | rpc-only      |                 |     |      |
| `run.list`                   | typed-command | `farmslot run`  | yes |      |
| `run.slotHistory`            | rpc-only      |                 |     |      |
| `run.cancel`                 | typed-command | `farmslot run`  |     |      |
| `run.forceComplete`          | rpc-only      |                 |     |      |
| `run.pause`                  | rpc-only      |                 |     |      |
| `run.resume`                 | rpc-only      |                 |     |      |
| `run.replayStep`             | rpc-only      |                 |     |      |
| `run.activateOnSlot`         | rpc-only      |                 |     |      |
| `run.autoRecovery.stop`      | rpc-only      |                 |     |      |
| `run.ciWatch.poke`           | rpc-only      |                 |     |      |
| `run.refreshReviewGate`      | rpc-only      |                 |     |      |
| `run.refreshPublishPackage`  | rpc-only      |                 |     |      |
| `run.refreshMirror`          | rpc-only      |                 |     |      |
| `run.rehydratePrNumber`      | rpc-only      |                 |     |      |
| `run.interactiveDev.resolve` | rpc-only      |                 |     |      |
| `run.forSlot`                | rpc-only      |                 |     |      |
| `run.resolveDecision`        | typed-command | `farmslot run`  | yes |      |
| `run.probeWorkerSignal`      | rpc-only      |                 |     |      |
| `run.grade`                  | rpc-only      |                 |     |      |
| `run.getGrade`               | rpc-only      |                 |     |      |
| `run.proposeImprovement`     | rpc-only      |                 |     |      |
| `run.delete`                 | typed-command | `farmslot runs` |     |      |
| `run.archive`                | typed-command | `farmslot run`  |     |      |
| `run.bulkDelete`             | rpc-only      |                 |     |      |
| `run.cleanup`                | rpc-only      |                 |     |      |
| `run.tags.set`               | rpc-only      |                 |     |      |
| `run.tags.list`              | rpc-only      |                 |     |      |
| `run.backfillSummaries`      | rpc-only      |                 |     |      |
| `run.recipeRunsForSlot`      | rpc-only      |                 |     |      |
| `run.recipeRunsForRun`       | rpc-only      |                 |     |      |

## screen.\*

| Method               | Surface | CLI command | TUI | Note                                        |
| -------------------- | ------- | ----------- | --- | ------------------------------------------- |
| `screen.subscribe`   | na      |             |     | Binary screen-capture relay for the web UI. |
| `screen.unsubscribe` | na      |             |     | Binary screen-capture relay for the web UI. |
| `screen.thumbnail`   | na      |             |     | Binary screen-capture relay for the web UI. |

## search.\*

| Method         | Surface | CLI command | TUI | Note                                 |
| -------------- | ------- | ----------- | --- | ------------------------------------ |
| `search.query` | na      |             |     | Slot Workspace code search (web UI). |

## slot.\*

| Method                | Surface       | CLI command     | TUI | Note |
| --------------------- | ------------- | --------------- | --- | ---- |
| `slot.check`          | typed-command | `farmslot slot` |     |      |
| `slot.prepare`        | typed-command | `farmslot slot` | yes |      |
| `slot.release`        | typed-command | `farmslot slot` |     |      |
| `slot.recycle`        | typed-command | `farmslot slot` |     |      |
| `slot.refresh`        | typed-command | `farmslot slot` |     |      |
| `slot.cleanup`        | rpc-only      |                 |     |      |
| `slot.prepareStatus`  | rpc-only      |                 |     |      |
| `slot.fixtureRefresh` | typed-command | `farmslot slot` |     |      |
| `slot.monitor`        | typed-command | `farmslot slot` |     |      |
| `slot.show`           | typed-command | `farmslot slot` |     |      |
| `slot.softRefresh`    | typed-command | `farmslot slot` |     |      |
| `slot.reopen`         | typed-command | `farmslot slot` |     |      |
| `slot.autoRefresh`    | typed-command | `farmslot slot` |     |      |
| `slot.openEditor`     | typed-command | `farmslot slot` |     |      |
| `slot.action.list`    | typed-command | `farmslot slot` |     |      |
| `slot.action.run`     | typed-command | `farmslot slot` |     |      |

## stream.\*

| Method               | Surface | CLI command | TUI | Note                                |
| -------------------- | ------- | ----------- | --- | ----------------------------------- |
| `stream.subscribe`   | na      |             |     | Binary stream relay for the web UI. |
| `stream.unsubscribe` | na      |             |     | Binary stream relay for the web UI. |
| `stream.snapshot`    | na      |             |     | Binary stream relay for the web UI. |

## task.\*

| Method          | Surface  | CLI command | TUI | Note |
| --------------- | -------- | ----------- | --- | ---- |
| `task.progress` | rpc-only |             |     |      |

## terminal.\*

| Method                        | Surface | CLI command | TUI | Note                                       |
| ----------------------------- | ------- | ----------- | --- | ------------------------------------------ |
| `terminal.subscribe`          | na      |             |     | Web terminal PTY surface (Command Center). |
| `terminal.unsubscribe`        | na      |             |     | Web terminal PTY surface (Command Center). |
| `terminal.send`               | na      |             |     | Web terminal PTY surface (Command Center). |
| `terminal.snapshot`           | na      |             |     | Web terminal PTY surface (Command Center). |
| `terminal.input`              | na      |             |     | Web terminal PTY surface (Command Center). |
| `terminal.resize`             | na      |             |     | Web terminal PTY surface (Command Center). |
| `terminal.reinit`             | na      |             |     | Web terminal PTY surface (Command Center). |
| `terminal.worker.subscribe`   | na      |             |     | Web terminal PTY surface (Command Center). |
| `terminal.worker.unsubscribe` | na      |             |     | Web terminal PTY surface (Command Center). |
| `terminal.worker.input`       | na      |             |     | Web terminal PTY surface (Command Center). |
| `terminal.worker.resize`      | na      |             |     | Web terminal PTY surface (Command Center). |
| `terminal.worker.snapshot`    | na      |             |     | Web terminal PTY surface (Command Center). |

## tmux.\*

| Method                  | Surface  | CLI command | TUI | Note |
| ----------------------- | -------- | ----------- | --- | ---- |
| `tmux.split`            | rpc-only |             |     |      |
| `tmux.selectPane`       | rpc-only |             |     |      |
| `tmux.killPane`         | rpc-only |             |     |      |
| `tmux.zoomPane`         | rpc-only |             |     |      |
| `tmux.newWindow`        | rpc-only |             |     |      |
| `tmux.selectWindow`     | rpc-only |             |     |      |
| `tmux.list`             | rpc-only |             |     |      |
| `tmux.worker.list`      | rpc-only |             |     |      |
| `tmux.worker.restore`   | rpc-only |             |     |      |
| `tmux.renameWindow`     | rpc-only |             |     |      |
| `tmux.sendKeys`         | rpc-only |             |     |      |
| `tmux.synchronizePanes` | rpc-only |             |     |      |

## worker.\*

| Method                               | Surface  | CLI command | TUI | Note |
| ------------------------------------ | -------- | ----------- | --- | ---- |
| `worker.session.history.get`         | rpc-only |             |     |      |
| `worker.session.history.subscribe`   | rpc-only |             |     |      |
| `worker.session.history.unsubscribe` | rpc-only |             |     |      |

## workGraph.\*

| Method                    | Surface  | CLI command | TUI | Note |
| ------------------------- | -------- | ----------- | --- | ---- |
| `workGraph.create`        | rpc-only |             |     |      |
| `workGraph.get`           | rpc-only |             |     |      |
| `workGraph.list`          | rpc-only |             |     |      |
| `workGraph.addNode`       | rpc-only |             |     |      |
| `workGraph.addEdge`       | rpc-only |             |     |      |
| `workGraph.removeNode`    | rpc-only |             |     |      |
| `workGraph.removeEdge`    | rpc-only |             |     |      |
| `workGraph.updateNode`    | rpc-only |             |     |      |
| `workGraph.activate`      | rpc-only |             |     |      |
| `workGraph.pause`         | rpc-only |             |     |      |
| `workGraph.gateResolve`   | rpc-only |             |     |      |
| `workGraph.schedulerTick` | rpc-only |             |     |      |

## workspace.\*

| Method                        | Surface | CLI command | TUI | Note                              |
| ----------------------------- | ------- | ----------- | --- | --------------------------------- |
| `workspace.metro.subscribe`   | na      |             |     | Slot Workspace IDE view (web UI). |
| `workspace.metro.unsubscribe` | na      |             |     | Slot Workspace IDE view (web UI). |
