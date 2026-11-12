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
// 110 KB to 19 KB on average over 81 stored runs — by dropping four heavy optional
// fields (resourcePosture, sessionUsage, visualJudgmentReceipts, templateProvenance),
// keeping only the step outputs list surfaces read, and leaving the heavy keys out of
// decisions, the publish gate, agent contexts, metrics, the ticket, the review result
// and the review subject. `trimRunForList` is kept as the version basis.
import type { Run, RunDecision, RunDecisionPayload } from '../contracts/runs.js';
import { utf8ByteLength } from '../utf8-byte-length.js';

import { CI_SNAPSHOT_TRIM_KEY } from './ci-decision-context.js';
import { summarizeRunEvidence } from './evidence-summary.js';
import type { RunListDecision, RunListDecisionPayload, RunListRow } from './list-row.js';

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
 * Whether a run.list row left out its output manifest, any decision payload value, any step's
 * inputs or outputs, or a heavy per-run detail key. A view drawn from such a row reads them from
 * the run's direct `run.get` copy, and shows them as not loaded until then rather than as empty.
 */
export function runHasTrimmedDetail(
  run: Pick<RunListRow, 'decisions' | 'output'> &
    Partial<Pick<RunListRow, 'steps' | 'detailTrimmed'>>,
): boolean {
  return (
    Boolean(run.output?.artifactManifestOmitted) ||
    (run.decisions ?? []).some((decision) => (decision.payloadTrimmed?.length ?? 0) > 0) ||
    (run.steps ?? []).some((step) => step.outputsTrimmed === true) ||
    run.detailTrimmed === true
  );
}

// ─── Step-2 slim projection ───────────────────────────────────────────────────

/** A string, number, boolean or null; anything else is left out. */
function scalarOutput(value: unknown): unknown {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
    ? value
    : undefined;
}

/** Longest CI check name a list row keeps; a longer one is cut and ends with an ellipsis. */
export const LIST_CHECK_NAME_MAX_CHARS = 120;
/** Longest CI-fix step label a list row keeps; a longer one is cut and ends with an ellipsis. */
export const LIST_FIX_LABEL_MAX_CHARS = 240;

function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The string entries of an array (CI check names), each capped; anything else is left out. */
function stringEntriesOutput(value: unknown): unknown {
  return Array.isArray(value)
    ? value
        .filter((entry) => typeof entry === 'string')
        .map((entry) => capText(entry, LIST_CHECK_NAME_MAX_CHARS))
    : undefined;
}

/** A recorded object whose values are read by key. */
function isKeyed(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A ci-watch check summary: only its counts. */
function checkSummaryOutput(value: unknown): unknown {
  if (!isKeyed(value)) return undefined;
  const counts: Record<string, number> = {};
  for (const key of ['passed', 'failed', 'pending', 'skipped', 'total']) {
    const count = value[key];
    if (typeof count === 'number') counts[key] = count;
  }
  return counts;
}

/** A ci-watch fix's progress: completed and total steps, and the current step's label. */
function fixProgressOutput(value: unknown): unknown {
  if (!isKeyed(value)) return undefined;
  const { completed, total, currentLabel } = value;
  return {
    ...(typeof completed === 'number' ? { completed } : {}),
    ...(typeof total === 'number' ? { total } : {}),
    ...(typeof currentLabel === 'string'
      ? { currentLabel: capText(currentLabel, LIST_FIX_LABEL_MAX_CHARS) }
      : currentLabel === null
        ? { currentLabel }
        : {}),
  };
}

/** A recorded value whose presence lists test, not its body: a scalar, or `{}` for an object. */
function presenceOutput(value: unknown): unknown {
  const scalar = scalarOutput(value);
  return scalar !== undefined ? scalar : value === undefined ? undefined : {};
}

/**
 * One step output as a list row carries it, or undefined when no list surface reads the key.
 * Kept keys, each in the bounded shape its views read: slot resolution and run activity
 * (dispatch keys); the mini pipeline's tone and step tooltip (`verdict`, `reviewVerdict`,
 * `maxRetriesExhausted`, `packageHash`, `reviewSatisfied`, `resolvedAction`,
 * `publicationStatus`); the CI watch line and the CI-fix checklist (ci-watch keys); the
 * active and split-view filters, which test only whether a completion prerequisite was
 * refused (`gatePrerequisiteRefusal`).
 *
 * Each projection is called by name, so the authorization guard can follow run.list's
 * call graph through this function.
 */
function listStepOutput(key: string, value: unknown): unknown {
  switch (key) {
    case 'awaitingOperator':
    case 'reason':
    case 'selectedSlot':
    case 'runner':
    case 'model':
    case 'templateName':
    case 'gatePrerequisiteDiscardedAt':
    case 'promptDeliveryUncertain':
    case 'nativeWorkerOperationUncertain':
      return value;
    case 'gatePrerequisiteRefusal':
      return presenceOutput(value);
    case 'verdict':
    case 'reviewVerdict':
    case 'maxRetriesExhausted':
    case 'packageHash':
    case 'reviewSatisfied':
    case 'resolvedAction':
    case 'publicationStatus':
    case 'phase':
    case 'fixInProgress':
    case 'nextPollAt':
    case 'progressTimeoutAt':
    case 'totalTimeoutAt':
    case 'actionableBotCommentCount':
      return scalarOutput(value);
    case 'checkSummary':
      return checkSummaryOutput(value);
    case 'failedNames':
    case 'failedChecks':
      return stringEntriesOutput(value);
    case 'fixProgress':
      return fixProgressOutput(value);
    default:
      return undefined;
  }
}

/** Whether the list form of a step's outputs left out or reshaped any value. */
function stepOutputsLost(
  outputs: Record<string, unknown> | undefined,
  slim: Record<string, unknown> | undefined,
): boolean {
  if (!outputs || !slim) return false;
  return Object.keys(outputs).some(
    (key) => !(key in slim) || JSON.stringify(slim[key]) !== JSON.stringify(outputs[key]),
  );
}

/** A step's outputs as a list row carries them (see listStepOutput). */
export function listStepOutputs(
  outputs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!outputs) return outputs;
  const slim: Record<string, unknown> = {};
  for (const key of Object.keys(outputs)) {
    const value = listStepOutput(key, outputs[key]);
    if (value !== undefined) slim[key] = value;
  }
  return slim;
}

/** A decision's payload as a list row carries it: the heavy keys of its kind left out. */
function listDecisionPayload(
  payload: RunDecisionPayload | undefined,
): RunListDecisionPayload | undefined {
  /* eslint-disable @typescript-eslint/no-unused-vars -- each kind names what it leaves out */
  if (payload?.kind === 'ready') {
    const {
      prPackage,
      currentDescription,
      recipeJson,
      inputSnapshot,
      gateSummary,
      workerReport,
      ...kept
    } = payload;
    return kept;
  }
  if (payload?.kind === 'review') {
    const { reviewMd, lineComments, ...kept } = payload;
    return kept;
  }
  if (payload?.kind === 'retrospective') {
    const { gateSummary, ...kept } = payload;
    return kept;
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return payload;
}

/**
 * A slim projection of `run` for `run.list` served rows.
 *
 * Drops heavy optional fields no list surface reads (`resourcePosture`,
 * `sessionUsage`, `visualJudgmentReceipts`, `templateProvenance`), leaves the
 * output file manifest out as `trimRunForList` does, keeps the step outputs list
 * surfaces read, serves decisions as `trimRunForList` does minus their heavy keys,
 * leaves the heavy keys out of the publish gate and the per-run detail fields
 * (marked `detailTrimmed`), and attaches `evidenceSummary` computed from the full
 * run. `trimRunForList` stays as the version basis; this function is applied where
 * rows are served.
 */
export function runListRow(run: Run): RunListRow {
  // Drop the heavy fields outright (all optional on Run).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { resourcePosture, sessionUsage, visualJudgmentReceipts, templateProvenance, ...rest } =
    run;

  // Agent contexts, metrics, the ticket, the review result, the review subject, decisions and
  // the publish gate leave out only their heavy keys (see list-row.ts). The row says so
  // (`detailTrimmed`) when one held something.
  const heavy: unknown[] = [];
  const agentContexts = run.agentContexts?.map(
    ({
      pipelineVisualReviewInput,
      pipelineVisualReviewResult,
      runnerSessionArchive,
      usage,
      ...context
    }) => {
      heavy.push(
        pipelineVisualReviewInput,
        pipelineVisualReviewResult,
        runnerSessionArchive,
        usage,
      );
      return context;
    },
  );
  const { subtasks, checklistTiming, ...metrics } = run.metrics;
  heavy.push(subtasks, checklistTiming);
  let ticketData: RunListRow['ticketData'];
  if (run.ticketData) {
    const { description, ...ticket } = run.ticketData;
    heavy.push(description);
    ticketData = ticket;
  }
  let reviewResult: RunListRow['reviewResult'];
  if (run.reviewResult) {
    const { reviewMd, lineComments, ...result } = run.reviewResult;
    heavy.push(reviewMd, lineComments);
    reviewResult = result;
  }
  let reviewWorkspaceSubject: RunListRow['reviewWorkspaceSubject'];
  if (run.reviewWorkspaceSubject) {
    const { body, ...subject } = run.reviewWorkspaceSubject;
    heavy.push(body);
    reviewWorkspaceSubject = subject;
  }

  // Steps keep their timing (list durations, queue waits, progress age) and leave out
  // their inputs; outputs keep only what list surfaces read. A step that lost anything
  // says so (`outputsTrimmed`), so runHasTrimmedDetail reports the row as trimmed.
  const steps = run.steps.map(({ inputs, outputs, ...step }) => {
    const slim = listStepOutputs(outputs);
    const lost = inputs !== undefined || stepOutputsLost(outputs, slim);
    return { ...step, outputs: slim, ...(lost ? { outputsTrimmed: true as const } : {}) };
  });

  // A decision is the one trimRunForList serves, without the resolver's selection, the
  // evidence attestation and its payload's heavy keys, each named in `payloadTrimmed`.
  const decisions: RunListDecision[] = run.decisions.map((stored) => {
    const { selectionData, evidenceAttestation, payload, payloadTrimmed, ...decision } =
      trimDecisionForList(stored);
    heavy.push(selectionData, evidenceAttestation);
    const kept = listDecisionPayload(payload);
    const trimmed = [
      ...(payloadTrimmed ?? []),
      ...Object.keys(payload ?? {}).filter((key) => kept && !(key in kept)),
    ];
    return {
      ...decision,
      ...(kept !== undefined ? { payload: kept } : {}),
      ...(trimmed.length > 0 ? { payloadTrimmed: trimmed } : {}),
    };
  });

  let engineState: RunListRow['engineState'];
  if (run.engineState?.publishGate) {
    const { gateSummary, ...publishGate } = run.engineState.publishGate;
    heavy.push(gateSummary);
    engineState = { ...run.engineState, publishGate };
  }
  const detailTrimmed = heavy.some((value) => value !== undefined);
  const output = listRunOutput(run);

  return {
    ...rest,
    ...(output !== undefined ? { output } : {}),
    steps,
    decisions,
    ...(engineState !== undefined ? { engineState } : {}),
    ...(agentContexts !== undefined ? { agentContexts } : {}),
    metrics,
    ...(ticketData !== undefined ? { ticketData } : {}),
    ...(reviewResult !== undefined ? { reviewResult } : {}),
    ...(reviewWorkspaceSubject !== undefined ? { reviewWorkspaceSubject } : {}),
    ...(detailTrimmed ? { detailTrimmed: true as const } : {}),
    evidenceSummary: summarizeRunEvidence(run),
  };
}
