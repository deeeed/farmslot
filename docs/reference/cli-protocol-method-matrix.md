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

| Method                          | Surface       | CLI command                           | TUI | Note |
| ------------------------------- | ------------- | ------------------------------------- | --- | ---- |
| `backlog.create`                | typed-command | `farmslot backlog`                    |     |      |
| `backlog.list`                  | typed-command | `farmslot backlog`                    | yes |      |
| `backlog.update`                | typed-command | `farmslot backlog`                    |     |      |
| `backlog.delete`                | typed-command | `farmslot backlog delete`             |     |      |
| `backlog.markReady`             | typed-command | `farmslot backlog`                    | yes |      |
| `backlog.archive`               | typed-command | `farmslot backlog archive`            |     |      |
| `backlog.enqueue`               | typed-command | `farmslot backlog`                    | yes |      |
| `backlog.dequeue`               | typed-command | `farmslot backlog dequeue`            |     |      |
| `backlog.autoDispatchTick`      | typed-command | `farmslot backlog`                    | yes |      |
| `backlog.upcoming`              | typed-command | `farmslot backlog upcoming`           |     |      |
| `backlog.spec.get`              | typed-command | `farmslot backlog`                    |     |      |
| `backlog.reconcileRun`          | typed-command | `farmslot backlog reconcile-run`      |     |      |
| `backlog.closeShipped`          | typed-command | `farmslot backlog`                    | yes |      |
| `backlog.refine`                | typed-command | `farmslot backlog refine`             |     |      |
| `backlog.refinementSession.get` | typed-command | `farmslot backlog refinement-session` |     |      |

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

| Method                               | Surface       | CLI command       | TUI | Note                                                                                           |
| ------------------------------------ | ------------- | ----------------- | --- | ---------------------------------------------------------------------------------------------- |
| `config.pools`                       | typed-command | `farmslot config` |     |                                                                                                |
| `config.pool`                        | rpc-only      |                   |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `config.projects`                    | typed-command | `farmslot config` |     |                                                                                                |
| `config.project`                     | rpc-only      |                   |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `config.pool.raw`                    | rpc-only      |                   |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `config.templates`                   | rpc-only      |                   |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `config.templatePreview`             | rpc-only      |                   |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `config.templateOptions`             | rpc-only      |                   |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `config.slot.update`                 | rpc-only      |                   |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `config.pool.update`                 | rpc-only      |                   |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `config.project.autoRecovery.update` | rpc-only      |                   |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `config.project.backlog.update`      | rpc-only      |                   |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

## copilot.\*

| Method                      | Surface | CLI command | TUI | Note                                     |
| --------------------------- | ------- | ----------- | --- | ---------------------------------------- |
| `copilot.formatInstruction` | na      |             |     | Command Center copilot surface (web UI). |

## credential.\*

| Method              | Surface       | CLI command                  | TUI | Note |
| ------------------- | ------------- | ---------------------------- | --- | ---- |
| `credential.issue`  | typed-command | `farmslot credential issue`  |     |      |
| `credential.list`   | typed-command | `farmslot credential list`   |     |      |
| `credential.revoke` | typed-command | `farmslot credential revoke` |     |      |

## decision.\*

| Method             | Surface       | CLI command                 | TUI | Note |
| ------------------ | ------------- | --------------------------- | --- | ---- |
| `decision.list`    | typed-command | `farmslot decision list`    | yes |      |
| `decision.resolve` | typed-command | `farmslot decision resolve` |     |      |

## diagnostics.\*

| Method                               | Surface  | CLI command | TUI | Note                                                                                           |
| ------------------------------------ | -------- | ----------- | --- | ---------------------------------------------------------------------------------------------- |
| `diagnostics.fileTransfer.smoke`     | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `diagnostics.fileTransfer.remoteE2e` | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `diagnostics.run`                    | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

## dispatch.\*

| Method                        | Surface       | CLI command                    | TUI | Note                                                                                           |
| ----------------------------- | ------------- | ------------------------------ | --- | ---------------------------------------------------------------------------------------------- |
| `dispatch.preview`            | typed-command | `farmslot dispatch`            |     |                                                                                                |
| `dispatch.matchProject`       | rpc-only      |                                |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `dispatch.candidates`         | rpc-only      |                                |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `dispatch.queue.add`          | rpc-only      |                                |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `dispatch.queue.list`         | typed-command | `farmslot dispatch queue list` |     |                                                                                                |
| `dispatch.queue.remove`       | rpc-only      |                                |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `dispatch.queue.removeOrphan` | rpc-only      |                                |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `dispatch.queue.update`       | rpc-only      |                                |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `dispatch.queue.reorder`      | rpc-only      |                                |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

## eval.\*

| Method                   | Surface  | CLI command | TUI | Note                                                                                           |
| ------------------------ | -------- | ----------- | --- | ---------------------------------------------------------------------------------------------- |
| `eval.experiment.create` | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `eval.trial.start`       | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `eval.trial.result.get`  | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `eval.suite.cap.get`     | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `eval.suite.cap.update`  | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

## family.\*

| Method                     | Surface  | CLI command | TUI | Note                                                                                           |
| -------------------------- | -------- | ----------- | --- | ---------------------------------------------------------------------------------------------- |
| `family.observability.get` | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `family.report.generate`   | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

## file.\*

| Method                 | Surface  | CLI command | TUI | Note                                                                                                                                  |
| ---------------------- | -------- | ----------- | --- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `file.transfer.smoke`  | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. Prefer diagnostics.fileTransfer.smoke. |
| `file.transfer.cancel` | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted.                                        |
| `file.transfer.list`   | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted.                                        |

## finetune.\*

| Method               | Surface  | CLI command | TUI | Note                                                                                           |
| -------------------- | -------- | ----------- | --- | ---------------------------------------------------------------------------------------------- |
| `finetune.index`     | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `finetune.exportSFT` | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `finetune.exportDPO` | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

## fleet.\*

| Method                      | Surface       | CLI command      | TUI | Note                                                                                           |
| --------------------------- | ------------- | ---------------- | --- | ---------------------------------------------------------------------------------------------- |
| `fleet.status`              | typed-command | `farmslot fleet` | yes |                                                                                                |
| `fleet.refresh`             | typed-command | `farmslot fleet` |     |                                                                                                |
| `fleet.refreshSlots`        | rpc-only      |                  |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `fleet.refreshSlots.cancel` | rpc-only      |                  |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `fleet.prSummary`           | rpc-only      |                  |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

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

| Method           | Surface  | CLI command | TUI | Note                                                                                           |
| ---------------- | -------- | ----------- | --- | ---------------------------------------------------------------------------------------------- |
| `gateway.ping`   | rpc-only |             |     | Interim: lightweight authenticated liveness probe; use `farmslot rpc gateway.ping`.            |
| `gateway.status` | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `gateway.doctor` | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

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

| Method              | Surface  | CLI command | TUI | Note                                                                                           |
| ------------------- | -------- | ----------- | --- | ---------------------------------------------------------------------------------------------- |
| `improvement.chat`  | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `improvement.apply` | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

## intelligence.\*

| Method                         | Surface  | CLI command | TUI | Note                                                                                           |
| ------------------------------ | -------- | ----------- | --- | ---------------------------------------------------------------------------------------------- |
| `intelligence.actions.summary` | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

## llm.\*

| Method             | Surface  | CLI command | TUI | Note                                                                                           |
| ------------------ | -------- | ----------- | --- | ---------------------------------------------------------------------------------------------- |
| `llm.auth.list`    | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `llm.auth.add`     | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `llm.auth.remove`  | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `llm.auth.test`    | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `llm.auth.import`  | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `llm.auth.refresh` | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `llm.auth.login`   | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `llm.config.get`   | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `llm.config.set`   | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `llm.tiers`        | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

## node.\*

| Method            | Surface  | CLI command | TUI | Note                                                                                           |
| ----------------- | -------- | ----------- | --- | ---------------------------------------------------------------------------------------------- |
| `node.health`     | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `node.health.all` | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

## nodes.\*

| Method         | Surface       | CLI command        | TUI | Note |
| -------------- | ------------- | ------------------ | --- | ---- |
| `nodes.list`   | typed-command | `farmslot gateway` |     |      |
| `nodes.deploy` | typed-command | `farmslot node`    |     |      |

## operator.\*

| Method              | Surface  | CLI command | TUI | Note                                                                                           |
| ------------------- | -------- | ----------- | --- | ---------------------------------------------------------------------------------------------- |
| `operator.snapshot` | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

## pairing.\*

| Method               | Surface       | CLI command             | TUI | Note                                                                                           |
| -------------------- | ------------- | ----------------------- | --- | ---------------------------------------------------------------------------------------------- |
| `pairing.create`     | typed-command | `farmslot pair`         |     |                                                                                                |
| `pairing.candidates` | rpc-only      |                         |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `pairing.exchange`   | typed-command | `farmslot login --code` |     |                                                                                                |

## pr.\*

| Method              | Surface       | CLI command   | TUI | Note                                                                                           |
| ------------------- | ------------- | ------------- | --- | ---------------------------------------------------------------------------------------------- |
| `pr.status`         | typed-command | `farmslot pr` |     |                                                                                                |
| `pr.list`           | typed-command | `farmslot pr` |     |                                                                                                |
| `pr.monitor`        | rpc-only      |               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `pr.reviewComments` | rpc-only      |               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `pr.addComment`     | rpc-only      |               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `pr.resolveThread`  | rpc-only      |               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `pr.forSlot`        | rpc-only      |               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `pr.editComment`    | rpc-only      |               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `pr.deleteComment`  | rpc-only      |               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `pr.submitReview`   | rpc-only      |               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

## principal.\*

| Method                 | Surface       | CLI command                     | TUI | Note |
| ---------------------- | ------------- | ------------------------------- | --- | ---- |
| `principal.create`     | typed-command | `farmslot principal create`     |     |      |
| `principal.list`       | typed-command | `farmslot principal list`       |     |      |
| `principal.grant`      | typed-command | `farmslot principal grant`      |     |      |
| `principal.revokeRole` | typed-command | `farmslot principal revokeRole` |     |      |

## providerAccounts.\*

| Method                      | Surface | CLI command | TUI | Note                                                                                                                       |
| --------------------------- | ------- | ----------- | --- | -------------------------------------------------------------------------------------------------------------------------- |
| `providerAccounts.snapshot` | na      |             |     | Command Center fleet Setup / provider seats surface (web UI). Labels and identity only — never tokens or credential paths. |

## recipe.\*

| Method                      | Surface       | CLI command       | TUI | Note                                                                                           |
| --------------------------- | ------------- | ----------------- | --- | ---------------------------------------------------------------------------------------------- |
| `recipe.rerun`              | rpc-only      |                   |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `recipe.cancel`             | rpc-only      |                   |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `recipe.command`            | rpc-only      |                   |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `recipe.projectHookCommand` | typed-command | `farmslot recipe` |     |                                                                                                |
| `recipe.projectHookRun`     | typed-command | `farmslot recipe` |     |                                                                                                |

## resource.\*

| Method                      | Surface  | CLI command | TUI | Note                                                                                           |
| --------------------------- | -------- | ----------- | --- | ---------------------------------------------------------------------------------------------- |
| `resource.list`             | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `resource.control`          | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `resource.health`           | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `resource.cleanup`          | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `resource.watch.setEnabled` | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

## roadmap.\*

| Method                          | Surface       | CLI command                             | TUI | Note |
| ------------------------------- | ------------- | --------------------------------------- | --- | ---- |
| `roadmap.list`                  | typed-command | `farmslot roadmap list`                 | yes |      |
| `roadmap.get`                   | typed-command | `farmslot roadmap get`                  | yes |      |
| `roadmap.save`                  | typed-command | `farmslot roadmap save`                 | yes |      |
| `roadmap.delete`                | typed-command | `farmslot roadmap delete`               |     |      |
| `roadmap.refine`                | typed-command | `farmslot roadmap refine`               |     |      |
| `roadmap.refinementSession.get` | typed-command | `farmslot roadmap refinement-session`   |     |      |
| `roadmap.prompt.get`            | typed-command | `farmslot roadmap prompt-get`           |     |      |
| `roadmap.promotionDraft.list`   | typed-command | `farmslot roadmap promotion-draft list` |     |      |
| `roadmap.promotionDraft.get`    | typed-command | `farmslot roadmap promotion-draft get`  |     |      |
| `roadmap.promotionDraft.save`   | typed-command | `farmslot roadmap promotion-draft save` |     |      |
| `roadmap.promote`               | typed-command | `farmslot roadmap promote`              |     |      |

## run.\*

| Method                       | Surface       | CLI command                   | TUI | Note                                                                                           |
| ---------------------------- | ------------- | ----------------------------- | --- | ---------------------------------------------------------------------------------------------- |
| `run.bundle.export`          | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.bundle.import`          | typed-command | `farmslot runs`               |     |                                                                                                |
| `run.bundle.list`            | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.create`                 | typed-command | `farmslot run`                |     |                                                                                                |
| `run.get`                    | typed-command | `farmslot run`                |     |                                                                                                |
| `run.contextBundle`          | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.recoveryProposal`       | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.list`                   | typed-command | `farmslot run`                | yes |                                                                                                |
| `run.slotHistory`            | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.cancel`                 | typed-command | `farmslot run`                |     |                                                                                                |
| `run.forceComplete`          | typed-command | `farmslot run force-complete` |     |                                                                                                |
| `run.pause`                  | typed-command | `farmslot run pause`          |     |                                                                                                |
| `run.resume`                 | typed-command | `farmslot run resume`         |     |                                                                                                |
| `run.replayStep`             | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.activateOnSlot`         | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.autoRecovery.stop`      | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.ciWatch.poke`           | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.refreshReviewGate`      | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.refreshPublishPackage`  | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.refreshMirror`          | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.rehydratePrNumber`      | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.interactiveDev.resolve` | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.forSlot`                | typed-command | `farmslot run for-slot`       |     |                                                                                                |
| `run.resolveDecision`        | typed-command | `farmslot run`                | yes |                                                                                                |
| `run.probeWorkerSignal`      | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.grade`                  | typed-command | `farmslot run grade`          |     |                                                                                                |
| `run.getGrade`               | typed-command | `farmslot run get-grade`      |     |                                                                                                |
| `run.proposeImprovement`     | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.delete`                 | typed-command | `farmslot runs`               |     |                                                                                                |
| `run.archive`                | typed-command | `farmslot run`                |     |                                                                                                |
| `run.bulkDelete`             | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.cleanup`                | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.tags.set`               | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.tags.list`              | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.backfillSummaries`      | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.recipeRunsForSlot`      | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `run.recipeRunsForRun`       | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

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

| Method                | Surface       | CLI command     | TUI | Note                                                                                           |
| --------------------- | ------------- | --------------- | --- | ---------------------------------------------------------------------------------------------- |
| `slot.check`          | typed-command | `farmslot slot` |     |                                                                                                |
| `slot.prepare`        | typed-command | `farmslot slot` | yes |                                                                                                |
| `slot.release`        | typed-command | `farmslot slot` |     |                                                                                                |
| `slot.recycle`        | typed-command | `farmslot slot` |     |                                                                                                |
| `slot.refresh`        | typed-command | `farmslot slot` |     |                                                                                                |
| `slot.cleanup`        | rpc-only      |                 |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `slot.prepareStatus`  | rpc-only      |                 |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `slot.fixtureRefresh` | typed-command | `farmslot slot` |     |                                                                                                |
| `slot.monitor`        | typed-command | `farmslot slot` |     |                                                                                                |
| `slot.show`           | typed-command | `farmslot slot` |     |                                                                                                |
| `slot.softRefresh`    | typed-command | `farmslot slot` |     |                                                                                                |
| `slot.reopen`         | typed-command | `farmslot slot` |     |                                                                                                |
| `slot.autoRefresh`    | typed-command | `farmslot slot` |     |                                                                                                |
| `slot.openEditor`     | typed-command | `farmslot slot` |     |                                                                                                |
| `slot.action.list`    | typed-command | `farmslot slot` |     |                                                                                                |
| `slot.action.run`     | typed-command | `farmslot slot` |     |                                                                                                |

## stream.\*

| Method               | Surface | CLI command | TUI | Note                                |
| -------------------- | ------- | ----------- | --- | ----------------------------------- |
| `stream.subscribe`   | na      |             |     | Binary stream relay for the web UI. |
| `stream.unsubscribe` | na      |             |     | Binary stream relay for the web UI. |
| `stream.snapshot`    | na      |             |     | Binary stream relay for the web UI. |

## task.\*

| Method          | Surface  | CLI command | TUI | Note                                                                                           |
| --------------- | -------- | ----------- | --- | ---------------------------------------------------------------------------------------------- |
| `task.progress` | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

## terminal.\*

| Method                        | Surface | CLI command | TUI | Note                                                                                      |
| ----------------------------- | ------- | ----------- | --- | ----------------------------------------------------------------------------------------- |
| `terminal.subscribe`          | na      |             |     | Web terminal PTY surface (Command Center).                                                |
| `terminal.unsubscribe`        | na      |             |     | Web terminal PTY surface (Command Center).                                                |
| `terminal.send`               | na      |             |     | Web terminal PTY surface (Command Center).                                                |
| `terminal.snapshot`           | na      |             |     | Web terminal PTY surface (Command Center).                                                |
| `terminal.input`              | na      |             |     | Web terminal PTY surface (Command Center).                                                |
| `terminal.resize`             | na      |             |     | Web terminal PTY surface (Command Center).                                                |
| `terminal.reinit`             | na      |             |     | Web terminal PTY surface (Command Center).                                                |
| `terminal.attachment.upload`  | na      |             |     | Web terminal image paste/drag-drop (Command Center); carries browser-held image bytes.    |
| `terminal.attachment.deliver` | na      |             |     | Web terminal image paste/drag-drop (Command Center); hands the staged path to the runner. |
| `terminal.attachment.cleanup` | na      |             |     | Web terminal image paste/drag-drop (Command Center); also called by slot release.         |
| `terminal.worker.subscribe`   | na      |             |     | Web terminal PTY surface (Command Center).                                                |
| `terminal.worker.unsubscribe` | na      |             |     | Web terminal PTY surface (Command Center).                                                |
| `terminal.worker.input`       | na      |             |     | Web terminal PTY surface (Command Center).                                                |
| `terminal.worker.resize`      | na      |             |     | Web terminal PTY surface (Command Center).                                                |
| `terminal.worker.snapshot`    | na      |             |     | Web terminal PTY surface (Command Center).                                                |

## tmux.\*

| Method                  | Surface  | CLI command | TUI | Note                                                                                           |
| ----------------------- | -------- | ----------- | --- | ---------------------------------------------------------------------------------------------- |
| `tmux.split`            | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `tmux.selectPane`       | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `tmux.killPane`         | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `tmux.zoomPane`         | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `tmux.newWindow`        | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `tmux.selectWindow`     | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `tmux.list`             | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `tmux.worker.list`      | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `tmux.worker.restore`   | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `tmux.renameWindow`     | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `tmux.sendKeys`         | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `tmux.synchronizePanes` | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

## worker.\*

| Method                               | Surface  | CLI command | TUI | Note                                                                                           |
| ------------------------------------ | -------- | ----------- | --- | ---------------------------------------------------------------------------------------------- |
| `worker.session.history.get`         | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `worker.session.history.subscribe`   | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `worker.session.history.unsubscribe` | rpc-only |             |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |

## workGraph.\*

| Method                    | Surface       | CLI command                   | TUI | Note                                                                                           |
| ------------------------- | ------------- | ----------------------------- | --- | ---------------------------------------------------------------------------------------------- |
| `workGraph.create`        | typed-command | `farmslot graph create`       |     |                                                                                                |
| `workGraph.get`           | typed-command | `farmslot graph show`         |     |                                                                                                |
| `workGraph.list`          | typed-command | `farmslot graph list`         |     |                                                                                                |
| `workGraph.addNode`       | typed-command | `farmslot graph add-node`     |     |                                                                                                |
| `workGraph.addEdge`       | typed-command | `farmslot graph add-edge`     |     |                                                                                                |
| `workGraph.removeNode`    | typed-command | `farmslot graph remove-node`  |     |                                                                                                |
| `workGraph.removeEdge`    | typed-command | `farmslot graph remove-edge`  |     |                                                                                                |
| `workGraph.updateNode`    | rpc-only      |                               |     | Interim: no dedicated typed subcommand yet; use `farmslot rpc <method> [json]` until promoted. |
| `workGraph.activate`      | typed-command | `farmslot graph activate`     |     |                                                                                                |
| `workGraph.pause`         | typed-command | `farmslot graph pause`        |     |                                                                                                |
| `workGraph.gateResolve`   | typed-command | `farmslot graph gate-resolve` |     |                                                                                                |
| `workGraph.schedulerTick` | typed-command | `farmslot graph tick`         |     |                                                                                                |

## workspace.\*

| Method                        | Surface | CLI command | TUI | Note                              |
| ----------------------------- | ------- | ----------- | --- | --------------------------------- |
| `workspace.metro.subscribe`   | na      |             |     | Slot Workspace IDE view (web UI). |
| `workspace.metro.unsubscribe` | na      |             |     | Slot Workspace IDE view (web UI). |
