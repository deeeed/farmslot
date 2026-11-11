// runs/list-trim.ts — keep run.list small enough to bootstrap the UI. The gateway trims
// with this; clients read a trimmed row with `runHasTrimmedDetail`.
//
// A run list of a few hundred runs carried ~85 MB, 59 MB of it decision
// payloads (input snapshots, PR packages, review markdown, artifact manifests)
// that only the page for that one run ever renders. The UI bootstrap request
// timed out on it, which paused every run-page action (gate approvals, step
// replays) behind "Run refresh failed". The list now drops any decision payload
// value above RUN_LIST_PAYLOAD_VALUE_LIMIT bytes and removes context.checkSnapshot, naming omitted values in
// `payloadTrimmed`; run.get, run.forSlot and run events stay complete.
//
// `runListRow` (step 2 slim rows, 2026-11-11) reduces a row further — from
// ~118 KB to ~9.5 KB on average — by dropping four heavy optional fields
// (resourcePosture, sessionUsage, visualJudgmentReceipts, templateProvenance)
// and projecting steps, decisions, and engineState to only the keys list
// surfaces read. `trimRunForList` is kept as the version basis.
import type {
  ReviewStatus,
  Run,
  RunDecision,
  RunDecisionPayload,
  RunEngineState,
} from '../contracts/runs.js';
import { utf8ByteLength } from '../utf8-byte-length.js';

import { CI_SNAPSHOT_TRIM_KEY } from './ci-decision-context.js';

/** JSON size in UTF-8 bytes above which a single decision payload value is left out of run.list. */
export const RUN_LIST_PAYLOAD_VALUE_LIMIT = 2048;

export function trimDecisionForList(decision: RunDecision): RunDecision {
  const trimmed: string[] = [];
  let context = decision.context;
  if (context?.checkSnapshot !== undefined) {
    context = { ...context };
    delete context.checkSnapshot;
    trimmed.push(CI_SNAPSHOT_TRIM_KEY);
  }
  if (!decision.payload)
    return trimmed.length ? { ...decision, context, payloadTrimmed: trimmed } : decision;
  // A list row's payload is the same shape with some keys left out; Partial is
  // the honest type while keys are removed from the copy.
  const kept = { ...decision.payload } as Partial<RunDecisionPayload>;
  for (const key of Object.keys(kept) as Array<keyof RunDecisionPayload>) {
    const value = kept[key];
    if (
      value !== undefined &&
      utf8ByteLength(JSON.stringify(value)) > RUN_LIST_PAYLOAD_VALUE_LIMIT
    ) {
      delete kept[key];
      trimmed.push(key);
    }
  }
  if (trimmed.length === 0) return decision;
  return { ...decision, context, payload: kept as RunDecisionPayload, payloadTrimmed: trimmed };
}

/** A copy of `run` for run.list; the store's own object is never mutated. */
export function trimRunForList(run: Run): Run {
  const output = run.output?.artifactManifest.length
    ? { ...run.output, artifactManifest: [], artifactManifestOmitted: true }
    : run.output;
  let changed = output !== run.output;
  const decisions = (run.decisions ?? []).map((decision) => {
    const next = trimDecisionForList(decision);
    if (next !== decision) changed = true;
    return next;
  });
  return changed ? { ...run, output, decisions } : run;
}

/**
 * Whether a run.list row left out its output manifest or any decision payload value. A view
 * drawn from such a row reads them from the run's direct `run.get` copy, and shows them as not
 * loaded until then rather than as empty.
 */
export function runHasTrimmedDetail(run: Pick<Run, 'decisions' | 'output'>): boolean {
  return (
    Boolean(run.output?.artifactManifestOmitted) ||
    (run.decisions ?? []).some((decision) => (decision.payloadTrimmed?.length ?? 0) > 0)
  );
}

// ─── Step-2 slim projection ───────────────────────────────────────────────────

/** Step output keys that list surfaces actually read (slot-resolution, run-activity, run-pipeline-mini). */
const STEP_OUTPUT_ALLOWLIST = new Set([
  'awaitingOperator',
  'reason',
  'selectedSlot',
  'runner',
  'model',
  'templateName',
  'gatePrerequisiteDiscardedAt',
  'promptDeliveryUncertain',
  'nativeWorkerOperationUncertain',
]);

function slimStepOutputs(
  outputs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!outputs) return outputs;
  const slim: Record<string, unknown> = {};
  for (const key of Object.keys(outputs)) {
    if (STEP_OUTPUT_ALLOWLIST.has(key)) slim[key] = outputs[key];
  }
  return slim;
}

function slimDecisionPayload(
  payload: RunDecisionPayload | undefined,
): RunDecisionPayload | undefined {
  if (!payload) return payload;
  const { kind } = payload;
  if (kind === 'review') {
    // ReviewGatePayload: keep gateReadiness and session (no reviewRoundBudget on this type)
    const { gateReadiness, session } = payload;
    return {
      kind,
      ...(gateReadiness !== undefined ? { gateReadiness } : {}),
      ...(session !== undefined ? { session } : {}),
    } as RunDecisionPayload;
  }
  if (kind === 'ready') {
    // ReadyGatePayload: keep metadata and display fields; drop the large content fields that only
    // the detail view renders (workerReport, inputSnapshot, prPackage, etc.). Apply slimReviewStatus
    // to reviews so stand-in rendering before run.get arrives has correct verdict/unresolvedCount.
    const {
      // Large content fields dropped from list rows:
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      workerReport,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      inputSnapshot,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      prPackage,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      artifactManifest,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      ciChecks,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      reviewSummary,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      reviewVerdict,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      workerLearnings,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      acceptanceCriteria,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      acceptanceStatus,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      currentDescription,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      draftEdits,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      reviewLineageOptions,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      recipeJson,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      recipeQualityArtifact,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      qualityReport,
      // Keep these:
      reviewRoundBudget,
      reviews,
      ...readyRest
    } = payload;
    const budget = reviewRoundBudget
      ? { used: reviewRoundBudget.used, remaining: reviewRoundBudget.remaining }
      : undefined;
    return {
      ...readyRest,
      ...(budget !== undefined ? { reviewRoundBudget: budget as typeof reviewRoundBudget } : {}),
      ...(reviews !== undefined ? { reviews: reviews.map(slimReviewStatus) } : {}),
    } as RunDecisionPayload;
  }
  if (kind === 'no-change') {
    // NoChangeGatePayload: keep gateReadiness + disposition (required field)
    const { gateReadiness, disposition } = payload;
    return {
      kind,
      disposition,
      ...(gateReadiness !== undefined ? { gateReadiness } : {}),
    } as RunDecisionPayload;
  }
  // All other kinds (slot_picker, branch_affinity_nudge, etc.): keep only kind
  return { kind } as RunDecisionPayload;
}

function slimReviewStatus(review: ReviewStatus): ReviewStatus {
  return {
    id: review.id,
    mode: review.mode,
    loopNumber: review.loopNumber,
    verdict: review.verdict,
    unresolvedCount: review.unresolvedCount,
    ...(review.source !== undefined ? { source: review.source } : {}),
    ...(review.runner !== undefined ? { runner: review.runner } : {}),
    ...(review.model !== undefined ? { model: review.model } : {}),
    ...(review.maxRetriesExhausted !== undefined
      ? { maxRetriesExhausted: review.maxRetriesExhausted }
      : {}),
    ...(review.session !== undefined ? { session: review.session } : {}),
    ...(review.attempts !== undefined
      ? {
          attempts: review.attempts.map((a) => ({
            mode: a.mode,
            loopNumber: a.loopNumber,
            verdict: a.verdict,
            unresolvedCount: a.unresolvedCount,
            ...(a.session !== undefined ? { session: a.session } : {}),
          })),
        }
      : {}),
  };
}

function slimEngineState(engineState: RunEngineState | undefined): RunEngineState | undefined {
  if (!engineState) return engineState;
  const { publishGate } = engineState;
  const slimmedGate = publishGate
    ? {
        ...(publishGate.reviewPolicy !== undefined
          ? {
              reviewPolicy: {
                requestedBy: publishGate.reviewPolicy.requestedBy,
              } as typeof publishGate.reviewPolicy,
            }
          : {}),
        ...(publishGate.reviewSequence !== undefined
          ? { reviewSequence: publishGate.reviewSequence }
          : {}),
        ...(publishGate.reviewLaunchRejection !== undefined
          ? { reviewLaunchRejection: publishGate.reviewLaunchRejection }
          : {}),
        ...(publishGate.reviewRecovery !== undefined
          ? { reviewRecovery: publishGate.reviewRecovery }
          : {}),
        ...(publishGate.reviews !== undefined
          ? { reviews: publishGate.reviews.map(slimReviewStatus) }
          : {}),
      }
    : undefined;
  return {
    ...(engineState.intelligenceAuditDegraded !== undefined
      ? { intelligenceAuditDegraded: engineState.intelligenceAuditDegraded }
      : {}),
    ...(engineState.generation !== undefined ? { generation: engineState.generation } : {}),
    ...(engineState.workspaceReviewDispatchGeneration !== undefined
      ? { workspaceReviewDispatchGeneration: engineState.workspaceReviewDispatchGeneration }
      : {}),
    ...(engineState.evalExperiment !== undefined
      ? { evalExperiment: engineState.evalExperiment }
      : {}),
    ...(slimmedGate !== undefined
      ? { publishGate: slimmedGate as RunEngineState['publishGate'] }
      : {}),
  };
}

/**
 * A slim projection of `run` for `run.list` served rows.
 *
 * Drops heavy optional fields no list surface reads (`resourcePosture`,
 * `sessionUsage`, `visualJudgmentReceipts`, `templateProvenance`) and projects
 * `steps`, `decisions`, and `engineState` to only the keys list consumers
 * actually access. `trimRunForList` stays as the version basis; this function
 * is applied where rows are served.
 *
 * All dropped fields are optional on `Run`, so the return type is `Run` with
 * no casts.
 */
export function runListRow(run: Run): Run {
  // Drop the four heavy fields outright.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { resourcePosture, sessionUsage, visualJudgmentReceipts, templateProvenance, ...rest } =
    run;

  const steps = run.steps.map((step) => ({
    name: step.name,
    status: step.status,
    ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
    ...(step.completedAt !== undefined ? { completedAt: step.completedAt } : {}),
    ...(step.detail !== undefined ? { detail: step.detail } : {}),
    outputs: slimStepOutputs(
      step.outputs as Record<string, unknown> | undefined,
    ) as typeof step.outputs,
  }));

  const decisions = (run.decisions ?? []).map((decision) => {
    const slimmedPayload = slimDecisionPayload(decision.payload);
    // Keep context but drop context.checkSnapshot (same as trimDecisionForList) if present
    let context = decision.context;
    const trimmed = [...(decision.payloadTrimmed ?? [])];
    if (context?.checkSnapshot !== undefined) {
      context = { ...context };
      delete context.checkSnapshot;
      if (!trimmed.includes(CI_SNAPSHOT_TRIM_KEY)) trimmed.push(CI_SNAPSHOT_TRIM_KEY);
    }
    return {
      id: decision.id,
      type: decision.type,
      ...(decision.title !== undefined ? { title: decision.title } : {}),
      ...(decision.createdAt !== undefined ? { createdAt: decision.createdAt } : {}),
      ...(decision.resolvedAt !== undefined ? { resolvedAt: decision.resolvedAt } : {}),
      ...(decision.actions !== undefined
        ? {
            actions: decision.actions.map((a) => ({
              id: a.id,
              label: a.label,
              style: a.style,
            })) as typeof decision.actions,
          }
        : {}),
      ...(context !== undefined ? { context } : {}),
      ...(trimmed.length > 0 ? { payloadTrimmed: trimmed } : {}),
      ...(slimmedPayload !== undefined ? { payload: slimmedPayload } : {}),
    } as RunDecision;
  });

  const engineState = slimEngineState(rest.engineState);

  return {
    ...rest,
    steps,
    decisions,
    ...(engineState !== undefined ? { engineState } : { engineState: undefined }),
  };
}
