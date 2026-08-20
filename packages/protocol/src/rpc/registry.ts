// RPC method name constants. Keep values stable: they are the public JSON-RPC contract.
export const Methods = {
  // Gateway self-status
  GATEWAY_PING: 'gateway.ping',
  GATEWAY_STATUS: 'gateway.status',
  GATEWAY_DOCTOR: 'gateway.doctor',

  // Fleet
  FLEET_STATUS: 'fleet.status',
  FLEET_REFRESH: 'fleet.refresh',

  // Auth
  AUTH_CONNECT: 'auth.connect',
  PAIRING_CREATE: 'pairing.create',
  PAIRING_CANDIDATES: 'pairing.candidates',
  PAIRING_EXCHANGE: 'pairing.exchange',
  PRINCIPAL_CREATE: 'principal.create',
  PRINCIPAL_LIST: 'principal.list',
  PRINCIPAL_GRANT: 'principal.grant',
  PRINCIPAL_REVOKE_ROLE: 'principal.revokeRole',
  CREDENTIAL_ISSUE: 'credential.issue',
  CREDENTIAL_LIST: 'credential.list',
  CREDENTIAL_REVOKE: 'credential.revoke',

  // Slot lifecycle
  SLOT_CHECK: 'slot.check',
  SLOT_PREPARE: 'slot.prepare',
  SLOT_RELEASE: 'slot.release',
  SLOT_RECYCLE: 'slot.recycle',
  SLOT_REFRESH: 'slot.refresh',
  SLOT_CLEANUP: 'slot.cleanup',
  SLOT_PREPARE_STATUS: 'slot.prepareStatus',
  SLOT_FIXTURE_REFRESH: 'slot.fixtureRefresh',
  SLOT_MONITOR: 'slot.monitor',
  SLOT_SHOW: 'slot.show',
  SLOT_SOFT_REFRESH: 'slot.softRefresh',
  SLOT_REOPEN: 'slot.reopen',
  SLOT_AUTO_REFRESH: 'slot.autoRefresh',

  // Fleet-bulk
  FLEET_REFRESH_SLOTS: 'fleet.refreshSlots',
  FLEET_REFRESH_SLOTS_CANCEL: 'fleet.refreshSlots.cancel',
  FLEET_PR_SUMMARY: 'fleet.prSummary',

  // Dispatch
  DISPATCH_PREVIEW: 'dispatch.preview',
  DISPATCH_MATCH_PROJECT: 'dispatch.matchProject',
  DISPATCH_CANDIDATES: 'dispatch.candidates',
  DISPATCH_QUEUE_ADD: 'dispatch.queue.add',
  DISPATCH_QUEUE_LIST: 'dispatch.queue.list',
  DISPATCH_QUEUE_REMOVE: 'dispatch.queue.remove',
  DISPATCH_QUEUE_REMOVE_ORPHAN: 'dispatch.queue.removeOrphan',
  DISPATCH_QUEUE_UPDATE: 'dispatch.queue.update',
  DISPATCH_QUEUE_REORDER: 'dispatch.queue.reorder',

  // Backlog
  BACKLOG_CREATE: 'backlog.create',
  BACKLOG_LIST: 'backlog.list',
  BACKLOG_UPDATE: 'backlog.update',
  BACKLOG_DELETE: 'backlog.delete',
  BACKLOG_MARK_READY: 'backlog.markReady',
  BACKLOG_ARCHIVE: 'backlog.archive',
  BACKLOG_ENQUEUE: 'backlog.enqueue',
  BACKLOG_DEQUEUE: 'backlog.dequeue',
  BACKLOG_AUTO_DISPATCH_TICK: 'backlog.autoDispatchTick',
  BACKLOG_UPCOMING: 'backlog.upcoming',
  BACKLOG_SPEC_GET: 'backlog.spec.get',
  BACKLOG_RECONCILE_RUN: 'backlog.reconcileRun',
  BACKLOG_CLOSE_SHIPPED: 'backlog.closeShipped',
  BACKLOG_REFINE: 'backlog.refine',
  BACKLOG_REFINEMENT_SESSION_GET: 'backlog.refinementSession.get',

  // Work Graph
  WORK_GRAPH_CREATE: 'workGraph.create',
  WORK_GRAPH_GET: 'workGraph.get',
  WORK_GRAPH_LIST: 'workGraph.list',
  WORK_GRAPH_ADD_NODE: 'workGraph.addNode',
  WORK_GRAPH_ADD_EDGE: 'workGraph.addEdge',
  WORK_GRAPH_REMOVE_NODE: 'workGraph.removeNode',
  WORK_GRAPH_REMOVE_EDGE: 'workGraph.removeEdge',
  WORK_GRAPH_UPDATE_NODE: 'workGraph.updateNode',
  WORK_GRAPH_ACTIVATE: 'workGraph.activate',
  WORK_GRAPH_PAUSE: 'workGraph.pause',
  WORK_GRAPH_GATE_RESOLVE: 'workGraph.gateResolve',
  WORK_GRAPH_SCHEDULER_TICK: 'workGraph.schedulerTick',

  // Roadmap
  ROADMAP_LIST: 'roadmap.list',
  ROADMAP_GET: 'roadmap.get',
  ROADMAP_SAVE: 'roadmap.save',
  ROADMAP_DELETE: 'roadmap.delete',
  ROADMAP_REFINE: 'roadmap.refine',
  ROADMAP_REFINEMENT_SESSION_GET: 'roadmap.refinementSession.get',
  ROADMAP_PROMPT_GET: 'roadmap.prompt.get',
  ROADMAP_PROMOTION_DRAFT_LIST: 'roadmap.promotionDraft.list',
  ROADMAP_PROMOTION_DRAFT_GET: 'roadmap.promotionDraft.get',
  ROADMAP_PROMOTION_DRAFT_SAVE: 'roadmap.promotionDraft.save',
  ROADMAP_PROMOTE: 'roadmap.promote',

  // File transfer (progress-aware large copies)
  FILE_TRANSFER_SMOKE: 'file.transfer.smoke', // alias — prefer DIAGNOSTICS_FILE_TRANSFER_SMOKE
  DIAGNOSTICS_FILE_TRANSFER_SMOKE: 'diagnostics.fileTransfer.smoke',
  DIAGNOSTICS_FILE_TRANSFER_REMOTE_E2E: 'diagnostics.fileTransfer.remoteE2e',
  FILE_TRANSFER_CANCEL: 'file.transfer.cancel',
  FILE_TRANSFER_LIST: 'file.transfer.list',

  // Terminal
  TERMINAL_SUBSCRIBE: 'terminal.subscribe',
  TERMINAL_UNSUBSCRIBE: 'terminal.unsubscribe',
  TERMINAL_SEND: 'terminal.send',
  TERMINAL_SNAPSHOT: 'terminal.snapshot',
  TERMINAL_INPUT: 'terminal.input',
  TERMINAL_RESIZE: 'terminal.resize',
  TERMINAL_REINIT: 'terminal.reinit',
  TERMINAL_ATTACHMENT_UPLOAD: 'terminal.attachment.upload',
  TERMINAL_ATTACHMENT_DELIVER: 'terminal.attachment.deliver',
  TERMINAL_ATTACHMENT_CLEANUP: 'terminal.attachment.cleanup',
  TERMINAL_WORKER_SUBSCRIBE: 'terminal.worker.subscribe',
  TERMINAL_WORKER_UNSUBSCRIBE: 'terminal.worker.unsubscribe',
  TERMINAL_WORKER_INPUT: 'terminal.worker.input',
  TERMINAL_WORKER_RESIZE: 'terminal.worker.resize',
  TERMINAL_WORKER_SNAPSHOT: 'terminal.worker.snapshot',

  // Worker session history (read-only transcript projection)
  WORKER_SESSION_HISTORY_GET: 'worker.session.history.get',
  WORKER_SESSION_HISTORY_SUBSCRIBE: 'worker.session.history.subscribe',
  WORKER_SESSION_HISTORY_UNSUBSCRIBE: 'worker.session.history.unsubscribe',

  // PR
  PR_STATUS: 'pr.status',
  PR_LIST: 'pr.list',
  PR_MONITOR: 'pr.monitor',
  PR_REVIEW_COMMENTS: 'pr.reviewComments',
  PR_ADD_COMMENT: 'pr.addComment',
  PR_RESOLVE_THREAD: 'pr.resolveThread',
  PR_FOR_SLOT: 'pr.forSlot',
  PR_EDIT_COMMENT: 'pr.editComment',
  PR_DELETE_COMMENT: 'pr.deleteComment',
  PR_SUBMIT_REVIEW: 'pr.submitReview',

  // Decisions
  DECISION_LIST: 'decision.list',
  DECISION_RESOLVE: 'decision.resolve',

  // Nodes (per-machine daemon)
  NODES_LIST: 'nodes.list',
  NODE_DEPLOY: 'nodes.deploy',

  // Task
  TASK_PROGRESS: 'task.progress',

  // Tmux control
  TMUX_SPLIT: 'tmux.split',
  TMUX_SELECT_PANE: 'tmux.selectPane',
  TMUX_KILL_PANE: 'tmux.killPane',
  TMUX_ZOOM_PANE: 'tmux.zoomPane',
  TMUX_NEW_WINDOW: 'tmux.newWindow',
  TMUX_SELECT_WINDOW: 'tmux.selectWindow',
  TMUX_LIST: 'tmux.list',
  TMUX_WORKER_LIST: 'tmux.worker.list',
  TMUX_WORKER_RESTORE: 'tmux.worker.restore',
  TMUX_RENAME_WINDOW: 'tmux.renameWindow',
  TMUX_SEND_KEYS: 'tmux.sendKeys',
  TMUX_SYNCHRONIZE_PANES: 'tmux.synchronizePanes',

  // Editor
  SLOT_OPEN_EDITOR: 'slot.openEditor',

  // Config
  CONFIG_POOLS: 'config.pools',
  CONFIG_POOL: 'config.pool',
  CONFIG_PROJECTS: 'config.projects',
  CONFIG_PROJECT: 'config.project',
  CONFIG_POOL_RAW: 'config.pool.raw',
  CONFIG_TEMPLATES: 'config.templates',
  CONFIG_TEMPLATE_PREVIEW: 'config.templatePreview',
  CONFIG_TEMPLATE_OPTIONS: 'config.templateOptions',
  CONFIG_SLOT_UPDATE: 'config.slot.update',
  CONFIG_POOL_UPDATE: 'config.pool.update',
  CONFIG_PROJECT_AUTO_RECOVERY_UPDATE: 'config.project.autoRecovery.update',
  CONFIG_PROJECT_BACKLOG_UPDATE: 'config.project.backlog.update',

  // Filesystem
  FS_LIST: 'fs.list',
  FS_READ: 'fs.read',
  FS_HASH: 'fs.hash',
  FS_WRITE: 'fs.write',
  FS_RENAME: 'fs.rename',
  FS_DELETE: 'fs.delete',
  FS_REVEAL: 'fs.reveal',
  FS_MKDIR: 'fs.mkdir',

  // Git
  GIT_STATUS: 'git.status',
  GIT_DIFF: 'git.diff',
  GIT_LOG: 'git.log',
  GIT_SHOW: 'git.show',
  GIT_BRANCH_DIFF: 'git.branchDiff',

  // Git actions
  GIT_STAGE: 'git.stage',
  GIT_UNSTAGE: 'git.unstage',
  GIT_DISCARD: 'git.discard',

  // Search
  SEARCH_QUERY: 'search.query',
  GIT_FILES: 'git.files',

  // Diagnostics
  DIAGNOSTICS_RUN: 'diagnostics.run',

  // Workspace — Metro logs
  WORKSPACE_METRO_SUBSCRIBE: 'workspace.metro.subscribe',
  WORKSPACE_METRO_UNSUBSCRIBE: 'workspace.metro.unsubscribe',

  // Stream
  STREAM_SUBSCRIBE: 'stream.subscribe',
  STREAM_UNSUBSCRIBE: 'stream.unsubscribe',
  STREAM_SNAPSHOT: 'stream.snapshot',

  // Screen (node-mediated capture)
  SCREEN_SUBSCRIBE: 'screen.subscribe',
  SCREEN_UNSUBSCRIBE: 'screen.unsubscribe',

  // Resources
  RESOURCE_LIST: 'resource.list',
  RESOURCE_CONTROL: 'resource.control',
  RESOURCE_HEALTH: 'resource.health',
  RESOURCE_CLEANUP: 'resource.cleanup',
  RESOURCE_WATCH_SET_ENABLED: 'resource.watch.setEnabled',
  RESOURCE_PRESSURE_SNAPSHOT: 'resource.pressure.snapshot',
  SLOT_ACTION_LIST: 'slot.action.list',
  SLOT_ACTION_RUN: 'slot.action.run',

  // Machine-scoped run parking
  MACHINE_PAUSE_PREVIEW: 'machine.pause.preview',
  MACHINE_PAUSE_EXECUTE: 'machine.pause.execute',
  MACHINE_PAUSE_STATUS: 'machine.pause.status',
  MACHINE_PAUSE_RESTORE: 'machine.pause.restore',

  // Proof-plan-driven runtime capability leases
  RUNTIME_CAPABILITY_LIST: 'runtime.capability.list',
  RUNTIME_CAPABILITY_ACQUIRE: 'runtime.capability.acquire',
  RUNTIME_CAPABILITY_RELEASE: 'runtime.capability.release',
  RUNTIME_CAPABILITY_STATUS: 'runtime.capability.status',

  // Runs
  RUN_BUNDLE_EXPORT: 'run.bundle.export',
  RUN_BUNDLE_IMPORT: 'run.bundle.import',
  RUN_BUNDLE_LIST: 'run.bundle.list',
  RUN_CREATE: 'run.create',
  RUN_GET: 'run.get',
  RUN_CONTEXT_BUNDLE: 'run.contextBundle',
  RUN_RECOVERY_PROPOSAL: 'run.recoveryProposal',
  RUN_LIST: 'run.list',
  RUN_SLOT_HISTORY: 'run.slotHistory',
  RUN_CANCEL: 'run.cancel',
  RUN_FORCE_COMPLETE: 'run.forceComplete',
  RUN_PAUSE: 'run.pause',
  RUN_RESUME: 'run.resume',
  RUN_REPLAY_STEP: 'run.replayStep',
  RUN_ACTIVATE_ON_SLOT: 'run.activateOnSlot',
  RUN_AUTO_RECOVERY_STOP: 'run.autoRecovery.stop',
  RUN_CI_WATCH_POKE: 'run.ciWatch.poke',
  RUN_REFRESH_REVIEW_GATE: 'run.refreshReviewGate',
  RUN_REFRESH_PUBLISH_PACKAGE: 'run.refreshPublishPackage',
  RUN_REFRESH_MIRROR: 'run.refreshMirror',
  RUN_REHYDRATE_PR_NUMBER: 'run.rehydratePrNumber',
  RUN_INTERACTIVE_DEV_RESOLVE: 'run.interactiveDev.resolve',
  RUN_FOR_SLOT: 'run.forSlot',
  RUN_RESOLVE_DECISION: 'run.resolveDecision',
  RUN_PROBE_WORKER_SIGNAL: 'run.probeWorkerSignal',
  RUN_GRADE: 'run.grade',
  RUN_GET_GRADE: 'run.getGrade',
  RUN_PROPOSE_IMPROVEMENT: 'run.proposeImprovement',
  RUN_DELETE: 'run.delete',
  RUN_ARCHIVE: 'run.archive',
  RUN_BULK_DELETE: 'run.bulkDelete',
  RUN_CLEANUP: 'run.cleanup',
  RUN_TAGS_SET: 'run.tags.set',
  RUN_TAGS_LIST: 'run.tags.list',
  RUN_BACKFILL_SUMMARIES: 'run.backfillSummaries',

  // Pipeline-ops analytics (read-only over the decoupled analytics sink)
  ANALYTICS_QUERY: 'analytics.query',
  ANALYTICS_BACKFILL: 'analytics.backfill',
  EVAL_EXPERIMENT_CREATE: 'eval.experiment.create',
  EVAL_TRIAL_START: 'eval.trial.start',
  EVAL_TRIAL_RESULT_GET: 'eval.trial.result.get',
  EVAL_SUITE_CAP_GET: 'eval.suite.cap.get',
  EVAL_SUITE_CAP_UPDATE: 'eval.suite.cap.update',
  FAMILY_OBSERVABILITY_GET: 'family.observability.get',
  FAMILY_REPORT_GENERATE: 'family.report.generate',
  INTELLIGENCE_ACTIONS_SUMMARY: 'intelligence.actions.summary',

  // Fine-tuning data export
  FINETUNE_INDEX: 'finetune.index',
  FINETUNE_EXPORT_SFT: 'finetune.exportSFT',
  FINETUNE_EXPORT_DPO: 'finetune.exportDPO',

  // Provider subscription accounts (operator seats; labels only)
  PROVIDER_ACCOUNTS_SNAPSHOT: 'providerAccounts.snapshot',

  // LLM Auth
  LLM_AUTH_LIST: 'llm.auth.list',
  LLM_AUTH_ADD: 'llm.auth.add',
  LLM_AUTH_REMOVE: 'llm.auth.remove',
  LLM_AUTH_TEST: 'llm.auth.test',
  LLM_AUTH_IMPORT: 'llm.auth.import',
  LLM_AUTH_REFRESH: 'llm.auth.refresh',
  LLM_AUTH_LOGIN: 'llm.auth.login',

  // Improvement
  IMPROVEMENT_CHAT: 'improvement.chat',
  IMPROVEMENT_APPLY: 'improvement.apply',

  // LLM Config
  LLM_CONFIG_GET: 'llm.config.get',
  LLM_CONFIG_SET: 'llm.config.set',
  LLM_TIERS: 'llm.tiers',

  // Co-Pilot Chat
  OPERATOR_SNAPSHOT: 'operator.snapshot',
  CHAT_SEND: 'chat.send',
  CHAT_HISTORY: 'chat.history',
  CHAT_CLEAR: 'chat.clear',
  CHAT_NEW: 'chat.new',
  CHAT_SESSIONS: 'chat.sessions',
  CHAT_SESSION_CREATE: 'chat.sessionCreate',
  CHAT_SESSION_DELETE: 'chat.sessionDelete',
  CHAT_SESSIONS_BULK_DELETE: 'chat.sessionsBulkDelete',
  CHAT_SESSION_PIN: 'chat.sessionPin',
  CHAT_SCREEN_EVIDENCE: 'chat.screenEvidence',
  CHAT_OBSERVER_EVIDENCE: 'chat.observerEvidence',
  CHAT_SAVE_MEMORY: 'chat.saveMemory',
  CHAT_CONFIRM_ACTION: 'chat.confirmAction',
  CHAT_LIST_ACTIONS: 'chat.listActions',
  CHAT_ABORT: 'chat.abort',
  CHAT_CONTEXT: 'chat.context',
  CHAT_SESSION_CONTEXT: 'chat.sessionContext',
  COPILOT_FORMAT_INSTRUCTION: 'copilot.formatInstruction',
  COPILOT_STATUS: 'copilot.status',
  COPILOT_CONFIGURE: 'copilot.configure',
  COPILOT_START: 'copilot.start',
  COPILOT_STOP: 'copilot.stop',

  // Node Health
  NODE_HEALTH: 'node.health',
  NODE_HEALTH_ALL: 'node.health.all',

  // Screen Thumbnails
  SCREEN_THUMBNAIL: 'screen.thumbnail',

  // Recipe
  RECIPE_RERUN: 'recipe.rerun',
  RECIPE_CANCEL: 'recipe.cancel',
  RECIPE_COMMAND: 'recipe.command',
  RECIPE_PROJECT_HOOK_COMMAND: 'recipe.projectHookCommand',
  RECIPE_PROJECT_HOOK_RUN: 'recipe.projectHookRun',
  RUN_RECIPE_RUNS_FOR_SLOT: 'run.recipeRunsForSlot',
  RUN_RECIPE_RUNS_FOR_RUN: 'run.recipeRunsForRun',
} as const;
