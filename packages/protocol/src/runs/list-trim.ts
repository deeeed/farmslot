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
import { summarizeRunEvidence } from './evidence-summary.js';
import type {
  RunListDecision,
  RunListDecisionPayload,
  RunListEngineState,
  RunListReadyGatePayload,
  RunListReviewGatePayload,
  RunListRow,
} from './list-row.js';

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

/** The run output a list row carries: the file manifest is left out and marked omitted. */
function listRunOutput(run: Run): Run['output'] {
  return run.output?.artifactManifest.length
    ? { ...run.output, artifactManifest: [], artifactManifestOmitted: true }
    : run.output;
}

/** A copy of `run` for run.list; the store's own object is never mutated. */
export function trimRunForList(run: Run): Run {
  const output = listRunOutput(run);
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
export function runHasTrimmedDetail(run: Pick<RunListRow, 'decisions' | 'output'>): boolean {
  return (
    Boolean(run.output?.artifactManifestOmitted) ||
    (run.decisions ?? []).some((decision) => (decision.payloadTrimmed?.length ?? 0) > 0)
  );
}

// ─── Step-2 slim projection ───────────────────────────────────────────────────

/** A string, number, boolean or null; anything else is left out. */
function scalarOutput(value: unknown): unknown {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
    ? value
    : undefined;
}

/** The string entries of an array (CI check names); anything else is left out. */
function stringEntriesOutput(value: unknown): unknown {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : undefined;
}

/** A ci-watch check summary: only its counts. */
function checkSummaryOutput(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const counts: Record<string, number> = {};
  for (const key of ['passed', 'failed', 'pending', 'skipped', 'total']) {
    const count: unknown = Reflect.get(value, key);
    if (typeof count === 'number') counts[key] = count;
  }
  return counts;
}

/** A ci-watch fix's progress: completed and total steps, and the current step's label. */
function fixProgressOutput(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const completed: unknown = Reflect.get(value, 'completed');
  const total: unknown = Reflect.get(value, 'total');
  const currentLabel: unknown = Reflect.get(value, 'currentLabel');
  return {
    ...(typeof completed === 'number' ? { completed } : {}),
    ...(typeof total === 'number' ? { total } : {}),
    ...(typeof currentLabel === 'string' || currentLabel === null ? { currentLabel } : {}),
  };
}

/** A recorded value whose presence lists test, not its body: a scalar, or `{}` for an object. */
function presenceOutput(value: unknown): unknown {
  const scalar = scalarOutput(value);
  return scalar !== undefined ? scalar : value === undefined ? undefined : {};
}

const keepOutput = (value: unknown) => value;

/**
 * Step output keys list surfaces read, each in the bounded shape those views read:
 * slot resolution and run activity (dispatch keys); the mini pipeline's tone and step
 * tooltip (`verdict`, `reviewVerdict`, `maxRetriesExhausted`, `packageHash`,
 * `reviewSatisfied`, `resolvedAction`, `publicationStatus`); the CI watch line and the
 * CI-fix checklist (ci-watch keys); the active and split-view filters, which test only
 * whether a completion prerequisite was refused (`gatePrerequisiteRefusal`).
 */
const STEP_OUTPUT_PROJECTIONS: Record<string, (value: unknown) => unknown> = {
  awaitingOperator: keepOutput,
  reason: keepOutput,
  selectedSlot: keepOutput,
  runner: keepOutput,
  model: keepOutput,
  templateName: keepOutput,
  gatePrerequisiteDiscardedAt: keepOutput,
  gatePrerequisiteRefusal: presenceOutput,
  promptDeliveryUncertain: keepOutput,
  nativeWorkerOperationUncertain: keepOutput,
  verdict: scalarOutput,
  reviewVerdict: scalarOutput,
  maxRetriesExhausted: scalarOutput,
  packageHash: scalarOutput,
  reviewSatisfied: scalarOutput,
  resolvedAction: scalarOutput,
  publicationStatus: scalarOutput,
  phase: scalarOutput,
  fixInProgress: scalarOutput,
  nextPollAt: scalarOutput,
  progressTimeoutAt: scalarOutput,
  totalTimeoutAt: scalarOutput,
  actionableBotCommentCount: scalarOutput,
  checkSummary: checkSummaryOutput,
  failedNames: stringEntriesOutput,
  failedChecks: stringEntriesOutput,
  fixProgress: fixProgressOutput,
};

/** A step's outputs as a list row carries them (see STEP_OUTPUT_PROJECTIONS). */
export function listStepOutputs(
  outputs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!outputs) return outputs;
  const slim: Record<string, unknown> = {};
  for (const key of Object.keys(outputs)) {
    const project = STEP_OUTPUT_PROJECTIONS[key];
    const value = project ? project(outputs[key]) : undefined;
    if (value !== undefined) slim[key] = value;
  }
  return slim;
}

function slimDecisionPayload(
  payload: RunDecisionPayload | undefined,
): RunListDecisionPayload | undefined {
  if (!payload) return payload;
  const { kind } = payload;
  if (kind === 'review') {
    // ReviewGatePayload: keep gateReadiness and session (no reviewRoundBudget on this type)
    const { gateReadiness, session } = payload;
    const slim: RunListReviewGatePayload = {
      kind,
      ...(gateReadiness !== undefined ? { gateReadiness } : {}),
      ...(session !== undefined ? { session } : {}),
    };
    return slim;
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
    const slim: RunListReadyGatePayload = {
      ...readyRest,
      ...(budget !== undefined ? { reviewRoundBudget: budget } : {}),
      ...(reviews !== undefined ? { reviews: reviews.map(slimReviewStatus) } : {}),
    };
    return slim;
  }
  if (kind === 'no-change') {
    // NoChangeGatePayload: keep gateReadiness + disposition (required field).
    // The slim object satisfies the full NoChangeGatePayload type (both required fields kept).
    const { gateReadiness, disposition } = payload;
    return {
      kind,
      disposition,
      ...(gateReadiness !== undefined ? { gateReadiness } : {}),
    };
  }
  // All other kinds (slot_picker, branch_affinity_nudge, etc.): keep only the discriminant.
  return { kind };
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

function slimEngineState(engineState: RunEngineState | undefined): RunListEngineState | undefined {
  if (!engineState) return engineState;
  const { publishGate } = engineState;
  const slimmedGate: RunListEngineState['publishGate'] = publishGate
    ? {
        ...(publishGate.reviewPolicy !== undefined
          ? {
              reviewPolicy: publishGate.reviewPolicy,
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
    ...(slimmedGate !== undefined ? { publishGate: slimmedGate } : {}),
  };
}

/**
 * A slim projection of `run` for `run.list` served rows.
 *
 * Drops heavy optional fields no list surface reads (`resourcePosture`,
 * `sessionUsage`, `visualJudgmentReceipts`, `templateProvenance`), leaves the
 * output file manifest out as `trimRunForList` does, projects `steps`,
 * `decisions`, and `engineState` to only the keys list consumers actually
 * access, and attaches `evidenceSummary` computed from the full run.
 * `trimRunForList` stays as the version basis; this function is applied where
 * rows are served.
 *
 * Returns the honest `RunListRow` type — no forced casts.
 */
export function runListRow(run: Run): RunListRow {
  // Drop the heavy fields outright (all optional on Run).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { resourcePosture, sessionUsage, visualJudgmentReceipts, templateProvenance, ...rest } =
    run;

  // Steps keep their timing (list durations, queue waits, progress age) and leave out
  // their inputs; outputs keep only what list surfaces read.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const steps = run.steps.map(({ inputs, outputs, ...step }) => ({
    ...step,
    outputs: listStepOutputs(outputs),
  }));

  const decisions: RunListDecision[] = run.decisions.map((decision) => {
    const slimmedPayload = slimDecisionPayload(decision.payload);
    // Keep context but drop context.checkSnapshot (same as trimDecisionForList) if present
    let context = decision.context;
    // Name every payload key the row leaves out, so runHasTrimmedDetail reports the row as
    // trimmed and readers show those values as not loaded rather than empty.
    const trimmed = [...(decision.payloadTrimmed ?? [])];
    for (const key of Object.keys(decision.payload ?? {})) {
      if (slimmedPayload && !(key in slimmedPayload) && !trimmed.includes(key)) trimmed.push(key);
    }
    if (context?.checkSnapshot !== undefined) {
      context = { ...context };
      delete context.checkSnapshot;
      if (!trimmed.includes(CI_SNAPSHOT_TRIM_KEY)) trimmed.push(CI_SNAPSHOT_TRIM_KEY);
    }
    const row: RunListDecision = {
      id: decision.id,
      type: decision.type,
      title: decision.title,
      createdAt: decision.createdAt,
      ...(decision.resolvedAt !== undefined ? { resolvedAt: decision.resolvedAt } : {}),
      actions: decision.actions.map((a) => ({ id: a.id, label: a.label, style: a.style })),
      ...(context !== undefined ? { context } : {}),
      ...(trimmed.length > 0 ? { payloadTrimmed: trimmed } : {}),
      ...(slimmedPayload !== undefined ? { payload: slimmedPayload } : {}),
    };
    return row;
  });

  const engineState = slimEngineState(rest.engineState);
  const output = listRunOutput(run);

  return {
    ...rest,
    ...(output !== undefined ? { output } : {}),
    steps,
    decisions,
    ...(engineState !== undefined ? { engineState } : { engineState: undefined }),
    evidenceSummary: summarizeRunEvidence(run),
  };
}
