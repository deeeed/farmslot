// run-route.ts — Gateway RPC dispatch boundary for run/eval/family method families

import {
  type EvalExperimentCreateParams,
  type EvalSuiteCapGetParams,
  type EvalSuiteCapUpdateParams,
  type EvalTrialResultGetParams,
  type EvalTrialStartParams,
  type EventFrame,
  Events,
  type FamilyObservabilityGetParams,
  type FamilyReportGenerateParams,
  type IntelligenceActionsSummaryParams,
  Methods,
  type RunActivateOnSlotParams,
  type RunArchiveParams,
  type RunAutoRecoveryStopParams,
  type RunBulkDeleteParams,
  type RunBundleExportParams,
  type RunBundleImportParams,
  type RunBundleListParams,
  type RunCancelParams,
  type RunCIWatchPokeParams,
  type RunCleanupParams,
  type RunContextBundleParams,
  type RunCreateParams,
  type RunDeleteParams,
  type RunForceCompleteParams,
  type RunForSlotParams,
  type RunGetGradeParams,
  type RunGetParams,
  type RunGradeParams,
  type RunInteractiveDevResolveParams,
  type RunListParams,
  type RunPauseParams,
  type RunProbeWorkerSignalParams,
  type RunProposeImprovementParams,
  type RunRecipeRunsForRunParams,
  type RunRecipeRunsForSlotParams,
  type RunRecoveryProposalParams,
  type RunRefreshMirrorParams,
  type RunRefreshPublishPackageParams,
  type RunRefreshReviewGateParams,
  type RunRehydratePrNumberParams,
  type RunReplayStepParams,
  type RunResolveDecisionParams,
  type RunResumeParams,
  type RunTagsSetParams,
  type SlotRunHistoryParams,
} from '@farmslot/protocol';

import {
  evalExperimentCreate,
  evalSuiteCapGet,
  evalSuiteCapUpdate,
  evalTrialResultGet,
  evalTrialStart,
} from '../methods/eval.js';
import { familyObservabilityGet, familyReportGenerate } from '../methods/family-observability.js';
import { intelligenceActionsSummary } from '../methods/intelligence.js';
import { operatorSnapshot, runContextBundle, runRecoveryProposal } from '../methods/operator.js';
import {
  runCreate,
  runInteractiveDevResolve,
  runProbeWorkerSignal,
  runRehydratePrNumber,
  runResolveDecision,
} from '../methods/run.js';
import {
  runArchive,
  runBackfillSummaries,
  type RunBackfillSummariesParams,
  runBulkDelete,
  runCleanup,
  runDelete,
  runGetGrade,
  runGrade,
  runListTags,
  runSetTags,
} from '../methods/run/admin.js';
import {
  runForSlot,
  runGet,
  runList,
  runRecipeRunsForRun,
  runRecipeRunsForSlot,
} from '../methods/run/context.js';
import {
  runActivateOnSlot,
  runAutoRecoveryStop,
  runCIWatchPoke,
  runRefreshMirror,
  runRefreshPublishPackage,
  runRefreshReviewGate,
} from '../methods/run/engine-ops.js';
import {
  runCancel,
  runForceComplete,
  runPause,
  runResume,
} from '../methods/run/lifecycle-control.js';
import { runProposeImprovement } from '../methods/run/propose-improvement.js';
import { runReplayStep } from '../methods/run/replay-step.js';
import { runSlotHistory } from '../methods/run/slot-history.js';
import { runBundleExport, runBundleImport, runBundleList } from '../methods/run-bundle.js';

export interface RouteRunMethodContext {
  emit: (event: string, payload: unknown) => void;
  broadcast: (frame: EventFrame) => void;
}

export type RouteRunMethodResult = { handled: true; value: unknown } | { handled: false };

async function handled(value: unknown): Promise<RouteRunMethodResult> {
  return { handled: true, value: await value };
}

export async function routeRunMethod(
  method: string,
  p: unknown,
  context: RouteRunMethodContext,
): Promise<RouteRunMethodResult> {
  const { broadcast, emit } = context;

  switch (method) {
    // Runs
    case Methods.RUN_CREATE: {
      const runParams = p as RunCreateParams & {
        backlogItemId?: unknown;
        workGraphId?: unknown;
        workNodeId?: unknown;
        launchPlanId?: unknown;
        launchCandidateId?: unknown;
        launchGroupId?: unknown;
        launchSlotPolicy?: unknown;
      };
      if (
        runParams.backlogItemId !== undefined ||
        runParams.workGraphId !== undefined ||
        runParams.workNodeId !== undefined ||
        runParams.launchPlanId !== undefined ||
        runParams.launchCandidateId !== undefined ||
        runParams.launchGroupId !== undefined ||
        runParams.launchSlotPolicy !== undefined
      ) {
        throw new Error(
          'run.create cannot accept backlog/work-graph launch metadata; use backlog.enqueue or workGraph.schedulerTick',
        );
      }
      return handled(runCreate(runParams, emit));
    }
    case Methods.RUN_BUNDLE_EXPORT:
      return handled(runBundleExport(p as RunBundleExportParams));
    case Methods.RUN_BUNDLE_IMPORT:
      return handled(runBundleImport(p as RunBundleImportParams));
    case Methods.RUN_BUNDLE_LIST:
      return handled(runBundleList(p as RunBundleListParams));
    case Methods.RUN_GET:
      return handled(runGet(p as RunGetParams));
    case Methods.RUN_CONTEXT_BUNDLE:
      return handled(runContextBundle(p as RunContextBundleParams));
    case Methods.RUN_RECOVERY_PROPOSAL:
      return handled(runRecoveryProposal(p as RunRecoveryProposalParams));
    case Methods.RUN_LIST:
      return handled(runList(p as RunListParams));
    case Methods.RUN_SLOT_HISTORY:
      return handled(runSlotHistory(p as SlotRunHistoryParams));
    case Methods.RUN_CANCEL:
      // No emitter: the transition broadcasts globally itself (ADR-052), so every
      // cancel entry point reaches every client identically.
      return handled(runCancel(p as RunCancelParams));
    case Methods.RUN_FORCE_COMPLETE:
      return handled(runForceComplete(p as RunForceCompleteParams, emit));
    case Methods.RUN_PAUSE:
      return handled(runPause(p as RunPauseParams, emit));
    case Methods.RUN_RESUME:
      return handled(runResume(p as RunResumeParams, emit));
    case Methods.RUN_FOR_SLOT:
      return handled(runForSlot(p as RunForSlotParams));
    case Methods.RUN_RECIPE_RUNS_FOR_SLOT:
      return handled(runRecipeRunsForSlot(p as RunRecipeRunsForSlotParams));
    case Methods.RUN_RECIPE_RUNS_FOR_RUN:
      return handled(runRecipeRunsForRun(p as RunRecipeRunsForRunParams));
    case Methods.RUN_PROBE_WORKER_SIGNAL:
      return handled(runProbeWorkerSignal(p as RunProbeWorkerSignalParams));
    case Methods.RUN_RESOLVE_DECISION: {
      const params = p as RunResolveDecisionParams;
      // Forward all per-request emits as broadcasts so RUN_UPDATED, the inner
      // RUN_DECISION_RESOLVED, and any chained-run events (RUN_CREATED /
      // RUN_UPDATED for a chain spawn) reach every connected client. Without
      // this, family-observability and slot-card tabs in other windows derive
      // stale `state.runs` and continue showing the resolved card until some
      // unrelated update arrives. Mirrors DECISION_RESOLVE.
      const broadcastEmit = (event: string, payload: unknown) => {
        broadcast({ type: 'event', event, payload });
      };
      const result = await runResolveDecision(params, broadcastEmit);
      // DECISION_RESOLVED is the inbox-side event surface; runResolveDecision
      // only emits RUN_DECISION_RESOLVED, so we still need this explicit
      // broadcast for clients subscribed to the file-based shape.
      broadcast({
        type: 'event',
        event: Events.DECISION_RESOLVED,
        payload: { id: params.decisionId },
      });
      return handled(result);
    }
    case Methods.RUN_REPLAY_STEP:
      return handled(runReplayStep(p as RunReplayStepParams, emit));
    case Methods.RUN_ACTIVATE_ON_SLOT:
      return handled(runActivateOnSlot(p as RunActivateOnSlotParams, emit));
    case Methods.RUN_AUTO_RECOVERY_STOP:
      return handled(runAutoRecoveryStop(p as RunAutoRecoveryStopParams, emit));
    case Methods.RUN_CI_WATCH_POKE:
      return handled(runCIWatchPoke(p as RunCIWatchPokeParams));
    case Methods.RUN_REFRESH_REVIEW_GATE:
      return handled(runRefreshReviewGate(p as RunRefreshReviewGateParams, emit));
    case Methods.RUN_REFRESH_PUBLISH_PACKAGE:
      return handled(runRefreshPublishPackage(p as RunRefreshPublishPackageParams, emit));
    case Methods.RUN_REFRESH_MIRROR:
      return handled(runRefreshMirror(p as RunRefreshMirrorParams, emit));
    case Methods.RUN_REHYDRATE_PR_NUMBER:
      return handled(runRehydratePrNumber(p as RunRehydratePrNumberParams, emit));
    case Methods.RUN_INTERACTIVE_DEV_RESOLVE:
      return handled(runInteractiveDevResolve(p as RunInteractiveDevResolveParams, emit));
    case Methods.RUN_GRADE:
      return handled(runGrade(p as RunGradeParams, emit));
    case Methods.RUN_GET_GRADE:
      return handled(runGetGrade(p as RunGetGradeParams));
    case Methods.RUN_PROPOSE_IMPROVEMENT:
      return handled(runProposeImprovement(p as RunProposeImprovementParams, emit));
    case Methods.RUN_DELETE:
      return handled(runDelete(p as RunDeleteParams, emit));
    case Methods.RUN_ARCHIVE:
      return handled(runArchive(p as RunArchiveParams, emit));
    case Methods.RUN_BULK_DELETE:
      return handled(runBulkDelete(p as RunBulkDeleteParams, emit));
    case Methods.RUN_CLEANUP:
      return handled(runCleanup(p as RunCleanupParams));
    case Methods.RUN_TAGS_SET:
      return handled(runSetTags(p as RunTagsSetParams, emit));
    case Methods.RUN_TAGS_LIST:
      return handled(runListTags());
    case Methods.RUN_BACKFILL_SUMMARIES:
      return handled(runBackfillSummaries(p as RunBackfillSummariesParams, emit));
    case Methods.EVAL_EXPERIMENT_CREATE:
      return handled(evalExperimentCreate(p as EvalExperimentCreateParams));
    case Methods.EVAL_TRIAL_START:
      return handled(evalTrialStart(p as EvalTrialStartParams, emit));
    case Methods.EVAL_TRIAL_RESULT_GET:
      return handled(evalTrialResultGet(p as EvalTrialResultGetParams));
    case Methods.EVAL_SUITE_CAP_GET:
      return handled(evalSuiteCapGet(p as EvalSuiteCapGetParams));
    case Methods.EVAL_SUITE_CAP_UPDATE:
      return handled(evalSuiteCapUpdate(p as EvalSuiteCapUpdateParams));
    case Methods.FAMILY_OBSERVABILITY_GET:
      return handled(familyObservabilityGet(p as FamilyObservabilityGetParams));
    case Methods.INTELLIGENCE_ACTIONS_SUMMARY:
      return handled(intelligenceActionsSummary(p as IntelligenceActionsSummaryParams));
    case Methods.FAMILY_REPORT_GENERATE:
      return handled(familyReportGenerate(p as FamilyReportGenerateParams));

    case Methods.OPERATOR_SNAPSHOT:
      return { handled: true, value: operatorSnapshot() };

    default:
      return { handled: false };
  }
}
