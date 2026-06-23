import { strict as assert } from 'node:assert';

import type { AgentContext } from '../../src/contracts/agents.js';
import type { ChatSession } from '../../src/contracts/chat.js';
import type { TemplatePreview } from '../../src/contracts/config.js';
import type {
  EvalExperimentManifest,
  ResultPackageManifest as ContractsIndexResultPackageManifest,
  ResultPackageManifest as DomainResultPackageManifest,
} from '../../src/contracts/evals.js';
import {
  type FamilyObservabilityArtifact,
  type FamilyObservabilitySnapshot,
  isFamilyDiffProvenance,
  type RunFamilyReadinessSummary,
} from '../../src/contracts/family.js';
import {
  hasLiveRecipeEvidence,
  LIVE_RECIPE_EVIDENCE_FILES,
  type LiveRecipeContext,
  type RecipeRunArtifactGroup,
} from '../../src/contracts/recipes.js';
import type { ResourceDefinition } from '../../src/contracts/resources.js';
import {
  type IndependentReviewStatus,
  isReviewValidationDepth,
  type ReviewGatePayload,
} from '../../src/contracts/reviews.js';
import {
  type EvidenceManifestEntry,
  FLOW_STEPS,
  isTerminalRunStatus,
  type Run,
  type RunMeta,
} from '../../src/contracts/runs.js';
import type {
  SlotActionSummary,
  SlotRunHistoryEntry,
  SlotStatus,
} from '../../src/contracts/slots.js';
import { ChatMethods } from '../../src/rpc/chat.js';
import { ConfigMethods } from '../../src/rpc/config.js';
import { DispatchMethods } from '../../src/rpc/dispatch.js';
import {
  type EvalExperimentCreateParams as DomainEvalExperimentCreateParams,
  EvalMethods,
} from '../../src/rpc/eval.js';
import { FleetMethods } from '../../src/rpc/fleet.js';
import { Methods } from '../../src/rpc/index.js';
import {
  type EvalExperimentCreateParams as RpcIndexEvalExperimentCreateParams,
  Methods as DomainIndexMethods,
} from '../../src/rpc/index.js';
import { ResourceMethods } from '../../src/rpc/resources.js';
import { type RunContextBundleParams, RunMethods } from '../../src/rpc/run.js';
import {
  type SlotFixtureRefreshParams,
  SlotMethods,
  type SlotRunHistoryParams,
} from '../../src/rpc/slot.js';

const runMethodName: typeof Methods.RUN_CREATE = RunMethods.create;
const dispatchMethodName: typeof Methods.DISPATCH_PREVIEW = DispatchMethods.preview;
const fleetMethodName: typeof Methods.FLEET_STATUS = FleetMethods.status;

assert.equal(DomainIndexMethods.RUN_CREATE, Methods.RUN_CREATE);
assert.equal(runMethodName, Methods.RUN_CREATE);
assert.equal(dispatchMethodName, Methods.DISPATCH_PREVIEW);
assert.equal(fleetMethodName, Methods.FLEET_STATUS);
assert.ok(FLOW_STEPS['fix-bug'].includes('grade'));
assert.equal(isTerminalRunStatus('done'), true);

const packageRuns = await import('@farmslot/protocol/contracts/runs');
const packageRunMethods = await import('@farmslot/protocol/rpc/run');
const packageRecipeTypes = await import('@farmslot/protocol/contracts/recipes');
const packageReviewTypes = await import('@farmslot/protocol/contracts/reviews');
const packageFamilyTypes = await import('@farmslot/protocol/contracts/family');
const packageSlotTypes = await import('@farmslot/protocol/contracts/slots');
const packageSlotMethods = await import('@farmslot/protocol/rpc/slot');
const packageRootTypes = await import('@farmslot/protocol/contracts');
const packageRootMethods = await import('@farmslot/protocol/rpc');

assert.ok(packageRuns.FLOW_STEPS['fix-bug'].includes('grade'));
assert.equal(packageRunMethods.RunMethods.create, Methods.RUN_CREATE);
assert.equal(packageRecipeTypes.LIVE_RECIPE_EVIDENCE_FILES.has('summary.json'), true);
assert.equal(packageReviewTypes.isReviewValidationDepth('full-live'), true);
assert.equal(
  packageFamilyTypes.isFamilyDiffProvenance({
    additions: 2,
    available: true,
    deletions: 1,
    files: 1,
    kind: 'contribution',
    source: 'artifact',
  }),
  true,
);
assert.equal(typeof packageSlotTypes, 'object');
assert.equal(packageSlotMethods.SlotMethods.check, Methods.SLOT_CHECK);
assert.ok(packageRootTypes.FLOW_STEPS['fix-bug'].includes('grade'));
assert.equal(packageRootMethods.Methods.RUN_CREATE, Methods.RUN_CREATE);
assert.equal(LIVE_RECIPE_EVIDENCE_FILES.has('summary.json'), true);
assert.equal(
  hasLiveRecipeEvidence({
    artifactManifest: null,
    qualityReport: null,
    recipeJson: null,
    recipeQualityArtifact: null,
    workerLearnings: null,
  }),
  false,
);
assert.equal(isReviewValidationDepth('full-live'), true);
assert.equal(
  isFamilyDiffProvenance({
    additions: 2,
    available: true,
    deletions: 1,
    files: 1,
    kind: 'contribution',
    source: 'artifact',
  }),
  true,
);

for (const [name, actual, expected] of [
  [
    'ChatMethods',
    ChatMethods,
    {
      operatorSnapshot: Methods.OPERATOR_SNAPSHOT,
      send: Methods.CHAT_SEND,
      history: Methods.CHAT_HISTORY,
      clear: Methods.CHAT_CLEAR,
      newSession: Methods.CHAT_NEW,
      sessions: Methods.CHAT_SESSIONS,
      sessionCreate: Methods.CHAT_SESSION_CREATE,
      sessionDelete: Methods.CHAT_SESSION_DELETE,
      sessionsBulkDelete: Methods.CHAT_SESSIONS_BULK_DELETE,
      sessionPin: Methods.CHAT_SESSION_PIN,
      screenEvidence: Methods.CHAT_SCREEN_EVIDENCE,
      observerEvidence: Methods.CHAT_OBSERVER_EVIDENCE,
      saveMemory: Methods.CHAT_SAVE_MEMORY,
      confirmAction: Methods.CHAT_CONFIRM_ACTION,
      listActions: Methods.CHAT_LIST_ACTIONS,
      abort: Methods.CHAT_ABORT,
      context: Methods.CHAT_CONTEXT,
      sessionContext: Methods.CHAT_SESSION_CONTEXT,
    },
  ],
  [
    'ConfigMethods',
    ConfigMethods,
    {
      pools: Methods.CONFIG_POOLS,
      pool: Methods.CONFIG_POOL,
      projects: Methods.CONFIG_PROJECTS,
      project: Methods.CONFIG_PROJECT,
      poolRaw: Methods.CONFIG_POOL_RAW,
      templates: Methods.CONFIG_TEMPLATES,
      templatePreview: Methods.CONFIG_TEMPLATE_PREVIEW,
      templateOptions: Methods.CONFIG_TEMPLATE_OPTIONS,
      slotUpdate: Methods.CONFIG_SLOT_UPDATE,
      poolUpdate: Methods.CONFIG_POOL_UPDATE,
      projectAutoRecoveryUpdate: Methods.CONFIG_PROJECT_AUTO_RECOVERY_UPDATE,
      projectBacklogUpdate: Methods.CONFIG_PROJECT_BACKLOG_UPDATE,
    },
  ],
  [
    'DispatchMethods',
    DispatchMethods,
    {
      preview: Methods.DISPATCH_PREVIEW,
      matchProject: Methods.DISPATCH_MATCH_PROJECT,
      candidates: Methods.DISPATCH_CANDIDATES,
      queueAdd: Methods.DISPATCH_QUEUE_ADD,
      queueList: Methods.DISPATCH_QUEUE_LIST,
      queueRemove: Methods.DISPATCH_QUEUE_REMOVE,
      queueUpdate: Methods.DISPATCH_QUEUE_UPDATE,
      queueReorder: Methods.DISPATCH_QUEUE_REORDER,
    },
  ],
  [
    'EvalMethods',
    EvalMethods,
    {
      experimentCreate: Methods.EVAL_EXPERIMENT_CREATE,
      trialStart: Methods.EVAL_TRIAL_START,
      trialResultGet: Methods.EVAL_TRIAL_RESULT_GET,
      suiteCapGet: Methods.EVAL_SUITE_CAP_GET,
      suiteCapUpdate: Methods.EVAL_SUITE_CAP_UPDATE,
    },
  ],
  [
    'FleetMethods',
    FleetMethods,
    {
      status: Methods.FLEET_STATUS,
      refresh: Methods.FLEET_REFRESH,
      refreshSlots: Methods.FLEET_REFRESH_SLOTS,
      refreshSlotsCancel: Methods.FLEET_REFRESH_SLOTS_CANCEL,
      prSummary: Methods.FLEET_PR_SUMMARY,
    },
  ],
  [
    'ResourceMethods',
    ResourceMethods,
    {
      list: Methods.RESOURCE_LIST,
      control: Methods.RESOURCE_CONTROL,
      health: Methods.RESOURCE_HEALTH,
      cleanup: Methods.RESOURCE_CLEANUP,
      watchSetEnabled: Methods.RESOURCE_WATCH_SET_ENABLED,
      streamSubscribe: Methods.STREAM_SUBSCRIBE,
      streamUnsubscribe: Methods.STREAM_UNSUBSCRIBE,
      streamSnapshot: Methods.STREAM_SNAPSHOT,
      screenSubscribe: Methods.SCREEN_SUBSCRIBE,
      screenUnsubscribe: Methods.SCREEN_UNSUBSCRIBE,
      screenThumbnail: Methods.SCREEN_THUMBNAIL,
    },
  ],
  [
    'RunMethods',
    RunMethods,
    {
      create: Methods.RUN_CREATE,
      get: Methods.RUN_GET,
      list: Methods.RUN_LIST,
      slotHistory: Methods.RUN_SLOT_HISTORY,
      contextBundle: Methods.RUN_CONTEXT_BUNDLE,
      recoveryProposal: Methods.RUN_RECOVERY_PROPOSAL,
      cancel: Methods.RUN_CANCEL,
      forceComplete: Methods.RUN_FORCE_COMPLETE,
      pause: Methods.RUN_PAUSE,
      resume: Methods.RUN_RESUME,
      replayStep: Methods.RUN_REPLAY_STEP,
      activateOnSlot: Methods.RUN_ACTIVATE_ON_SLOT,
      autoRecoveryStop: Methods.RUN_AUTO_RECOVERY_STOP,
      ciWatchPoke: Methods.RUN_CI_WATCH_POKE,
      refreshReviewGate: Methods.RUN_REFRESH_REVIEW_GATE,
      refreshPublishPackage: Methods.RUN_REFRESH_PUBLISH_PACKAGE,
      refreshMirror: Methods.RUN_REFRESH_MIRROR,
      rehydratePrNumber: Methods.RUN_REHYDRATE_PR_NUMBER,
      interactiveDevResolve: Methods.RUN_INTERACTIVE_DEV_RESOLVE,
      forSlot: Methods.RUN_FOR_SLOT,
      resolveDecision: Methods.RUN_RESOLVE_DECISION,
      grade: Methods.RUN_GRADE,
      getGrade: Methods.RUN_GET_GRADE,
      proposeImprovement: Methods.RUN_PROPOSE_IMPROVEMENT,
      delete: Methods.RUN_DELETE,
      archive: Methods.RUN_ARCHIVE,
      bulkDelete: Methods.RUN_BULK_DELETE,
      cleanup: Methods.RUN_CLEANUP,
      setTags: Methods.RUN_TAGS_SET,
      listTags: Methods.RUN_TAGS_LIST,
      backfillSummaries: Methods.RUN_BACKFILL_SUMMARIES,
      recipeRunsForSlot: Methods.RUN_RECIPE_RUNS_FOR_SLOT,
      recipeRunsForRun: Methods.RUN_RECIPE_RUNS_FOR_RUN,
    },
  ],
  [
    'SlotMethods',
    SlotMethods,
    {
      check: Methods.SLOT_CHECK,
      prepare: Methods.SLOT_PREPARE,
      release: Methods.SLOT_RELEASE,
      recycle: Methods.SLOT_RECYCLE,
      refresh: Methods.SLOT_REFRESH,
      cleanup: Methods.SLOT_CLEANUP,
      fixtureRefresh: Methods.SLOT_FIXTURE_REFRESH,
      runHistory: Methods.RUN_SLOT_HISTORY,
      forSlot: Methods.RUN_FOR_SLOT,
      recipeRunsForSlot: Methods.RUN_RECIPE_RUNS_FOR_SLOT,
      recipeRerun: Methods.RECIPE_RERUN,
      recipeCancel: Methods.RECIPE_CANCEL,
      recipeCommand: Methods.RECIPE_COMMAND,
      recipeProjectHookCommand: Methods.RECIPE_PROJECT_HOOK_COMMAND,
      recipeProjectHookRun: Methods.RECIPE_PROJECT_HOOK_RUN,
      actionList: Methods.SLOT_ACTION_LIST,
      actionRun: Methods.SLOT_ACTION_RUN,
    },
  ],
] as const) {
  assert.deepEqual(actual, expected, `${name} must mirror Methods constants`);
}

const _typeSmoke: {
  run?: Run;
  runMeta?: RunMeta;
  slot?: SlotStatus;
  chat?: ChatSession;
  agent?: AgentContext;
  config?: TemplatePreview;
  eval?: EvalExperimentManifest;
  evalCreate?: DomainEvalExperimentCreateParams;
  legacyEvalCreate?: RpcIndexEvalExperimentCreateParams;
  resultPackage?: DomainResultPackageManifest;
  legacyResultPackage?: ContractsIndexResultPackageManifest;
  family?: FamilyObservabilitySnapshot;
  familyArtifact?: FamilyObservabilityArtifact;
  recipe?: EvidenceManifestEntry;
  liveRecipe?: LiveRecipeContext;
  recipeGroup?: RecipeRunArtifactGroup;
  resource?: ResourceDefinition;
  review?: IndependentReviewStatus;
  reviewGate?: ReviewGatePayload;
  familyReadiness?: RunFamilyReadinessSummary;
  slotHistory?: SlotRunHistoryEntry;
  slotAction?: SlotActionSummary;
  runContext?: RunContextBundleParams;
  fixtureRefresh?: SlotFixtureRefreshParams;
  slotHistoryParams?: SlotRunHistoryParams;
} = {};
assert.equal(typeof _typeSmoke, 'object');
