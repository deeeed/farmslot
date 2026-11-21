import { randomUUID } from 'node:crypto';

import {
  coldPipelineReviewSessions,
  type ReviewStatus,
  type Run,
  type RunnerSessionUsage,
} from '@farmslot/protocol';
import { pipelineReviewReceipts } from '@farmslot/review-dispatch';

type AccountingInputs = Pick<
  Run,
  | 'id'
  | 'sessionUsage'
  | 'engineState'
  | 'decisions'
  | 'agentContexts'
  | 'repeatReviewContext'
  | 'reviewResult'
  | 'flowType'
  | 'steps'
>;

const revisions = new WeakMap<
  AccountingInputs,
  { keys: AccountingKey; inputs: readonly unknown[]; revision: string }
>();

const actorRevisions = new WeakMap<NonNullable<Run['agentContexts']>, string>();
const actorKeys = new WeakMap<NonNullable<Run['agentContexts']>[number], string>();

function actorKey(actor?: NonNullable<Run['agentContexts']>[number]): string | undefined {
  if (!actor) return undefined;
  let key = actorKeys.get(actor);
  if (key === undefined) {
    key = JSON.stringify([
      actor.id,
      actor.role,
      actor.runner,
      actor.runnerSessionId,
      actor.target?.target,
      actor.nativeSession?.handoffFrom?.runId,
    ]);
    actorKeys.set(actor, key);
  }
  return key;
}

function actorAccountingKey(actors: Run['agentContexts']): string | undefined {
  if (!actors?.length) return undefined;
  let key = actorRevisions.get(actors);
  if (key === undefined) {
    key = JSON.stringify(actors.map(actorKey));
    actorRevisions.set(actors, key);
  }
  return key;
}

export function noteCostActorUpsert(
  previous: NonNullable<Run['agentContexts']>,
  next: NonNullable<Run['agentContexts']>,
  before: NonNullable<Run['agentContexts']>[number] | undefined,
  after: NonNullable<Run['agentContexts']>[number],
): void {
  const key = actorRevisions.get(previous);
  if (key === undefined) return;
  actorRevisions.set(next, actorKey(before) === actorKey(after) ? key : randomUUID());
}

const readyIndexes = new WeakMap<Run['decisions'], number>();

export function noteCostReadyIndex(decisions: Run['decisions'], index: number): void {
  readyIndexes.set(decisions, index);
}

function latestReadyIndex(decisions: Run['decisions']): number {
  const known = readyIndexes.get(decisions);
  if (known !== undefined) return known;
  for (let index = decisions.length - 1; index >= 0; index--) {
    if (decisions[index]?.payload?.kind === 'ready') {
      readyIndexes.set(decisions, index);
      return index;
    }
  }
  readyIndexes.set(decisions, -1);
  return -1;
}

const receiptKeys = new WeakMap<RunnerSessionUsage, string>();

function receiptKey(row?: RunnerSessionUsage) {
  if (!row) return undefined;
  const known = receiptKeys.get(row);
  if (known !== undefined) return known;
  const unavailable = row.source === 'unavailable' || !!row.error;
  const key = JSON.stringify([
    row.runner,
    row.runnerSessionId,
    row.requestId,
    row.kind,
    row.identityKind,
    row.nativeSession?.sessionId,
    row.nativeSession?.executionNodeId,
    row.nativeSession?.ownerPrincipalId,
    row.runId,
    row.role,
    row.roles,
    row.contextIds,
    row.usageLeaseIds,
    row.pendingUsageLeaseIds,
    row.scope,
    row.startedAt,
    row.completedAt,
    row.source,
    unavailable,
    row.costStatus,
    row.pricingScope,
    row.includesPriorRunLifetime,
    row.costUsd,
    row.totalTokens,
    unavailable ? undefined : row.measuredAt,
  ]);
  receiptKeys.set(row, key);
  return key;
}

type AccountingKey = string | undefined | readonly AccountingKey[];

function sameKey(left: AccountingKey, right: AccountingKey): boolean {
  if (left === right) return true;
  if (typeof left === 'string' || !left || typeof right === 'string' || !right) return false;
  return left.length === right.length && left.every((key, index) => sameKey(key, right[index]));
}

/** Existing records keep their keys when the writer replaces a collection. */
function collectionKey<Row>(
  project: (row: Row) => AccountingKey,
): (rows: readonly Row[] | undefined) => AccountingKey {
  const collections = new WeakMap<readonly Row[], readonly AccountingKey[]>();
  return (rows) => {
    if (!rows?.length) return undefined;
    let key = collections.get(rows);
    if (key === undefined) {
      key = rows.map(project);
      collections.set(rows, key);
    }
    return key;
  };
}

const snapshotUsageKey = collectionKey(receiptKey);
const usageKeys = new WeakMap<readonly RunnerSessionUsage[], AccountingKey>();

function usageKey(rows?: readonly RunnerSessionUsage[]): AccountingKey {
  if (!rows) return undefined;
  if (!usageKeys.has(rows)) usageKeys.set(rows, snapshotUsageKey(rows));
  return usageKeys.get(rows);
}

/** The canonical writer already knows which receipt it replaced. */
export function noteCostUsageUpsert(
  previous: readonly RunnerSessionUsage[],
  next: readonly RunnerSessionUsage[],
  before?: RunnerSessionUsage,
  after?: RunnerSessionUsage,
): void {
  if (!usageKeys.has(previous)) return;
  if (previous.length !== next.length || receiptKey(before) !== receiptKey(after)) {
    usageKeys.set(next, randomUUID());
  } else {
    usageKeys.set(next, usageKey(previous));
  }
}
type ReviewAttempt = NonNullable<ReviewStatus['attempts']>[number];
const attemptKeys = new WeakMap<ReviewAttempt, AccountingKey>();
const attemptsKey = collectionKey((attempt: ReviewAttempt) => {
  let key = attemptKeys.get(attempt);
  if (!key) {
    key = [attempt.mode, JSON.stringify(attempt.session), receiptKey(attempt.usage)];
    attemptKeys.set(attempt, key);
  }
  return key;
});
const reviewKeys = new WeakMap<ReviewStatus, AccountingKey>();
const reviewsKey = collectionKey((review: ReviewStatus) => {
  let key = reviewKeys.get(review);
  if (!key) {
    key = [
      review.mode,
      review.runner ?? undefined,
      review.reviewerSessionId ?? undefined,
      JSON.stringify(review.session),
      receiptKey(review.usage),
      attemptsKey(review.attempts),
    ];
    reviewKeys.set(review, key);
  }
  return key;
});

const stepKeys = new WeakMap<Record<string, unknown>, { runId: string; key: AccountingKey }>();

function pipelineKeys(run: AccountingInputs): AccountingKey {
  return run.steps.flatMap((step) => {
    if (!step.name.includes('review') || !step.outputs) return [];
    const outputs = step.outputs;
    const cached = stepKeys.get(outputs);
    if (cached?.runId === run.id) return [cached.key];
    const source = { id: run.id, steps: [step] };
    const key = [
      usageKey(pipelineReviewReceipts(source)),
      JSON.stringify([...coldPipelineReviewSessions(source)]),
    ];
    stepKeys.set(outputs, { runId: run.id, key });
    return [key];
  });
}

/** Prepare the revision when an accounting source is loaded or changes. */
export function noteCostAccountingWrite(run: AccountingInputs): void {
  costAccountingRevision(run);
}

/** Serve a prepared revision only for a view with the same accounting inputs. */
export function readCostAccountingRevision(
  owner: AccountingInputs,
  view: AccountingInputs,
): string | undefined {
  const prepared = revisions.get(owner);
  if (!prepared) return undefined;
  if (
    owner.sessionUsage !== view.sessionUsage ||
    owner.agentContexts !== view.agentContexts ||
    owner.steps !== view.steps ||
    owner.engineState?.publishGate?.reviews !== view.engineState?.publishGate?.reviews ||
    owner.engineState?.flags?.nudgeReuse !== view.engineState?.flags?.nudgeReuse ||
    owner.engineState?.flags?.warmHandoffSucceeded !==
      view.engineState?.flags?.warmHandoffSucceeded ||
    owner.repeatReviewContext?.session !== view.repeatReviewContext?.session ||
    owner.repeatReviewContext?.priorRunId !== view.repeatReviewContext?.priorRunId ||
    owner.reviewResult?.session !== view.reviewResult?.session ||
    owner.flowType !== view.flowType
  )
    return undefined;
  if (!owner.engineState?.publishGate?.reviews?.length && owner.decisions !== view.decisions) {
    const index = readyIndexes.get(owner.decisions);
    if (index === undefined || owner.decisions.length !== view.decisions.length) return undefined;
    if (index >= 0) {
      const stored = owner.decisions[index];
      const served = view.decisions[index];
      if (
        stored?.id !== served?.id ||
        stored?.payload?.kind !== 'ready' ||
        served?.payload?.kind !== 'ready' ||
        stored.payload.reviews !== served.payload.reviews
      )
        return undefined;
    }
  }
  return prepared.revision;
}

/** The store replaces the receipt and review collections when their records change. */
export function costAccountingRevision(owner: AccountingInputs, view = owner): string {
  const live = view.engineState?.publishGate?.reviews;
  let reviews = live?.length ? live : undefined;
  if (!live?.length) {
    // Read-time gate enrichment preserves decision order. Index the stored
    // list, but take the reviews from the payload that the client will see.
    const index = latestReadyIndex(owner.decisions);
    const served = view.decisions[index];
    const payload =
      owner.decisions.length === view.decisions.length &&
      served?.id === owner.decisions[index]?.id &&
      (index < 0 || served?.payload?.kind === 'ready')
        ? served?.payload
        : view.decisions[latestReadyIndex(view.decisions)]?.payload;
    if (payload?.kind === 'ready' && payload.reviews?.length) reviews = payload.reviews;
  }
  const dispatch = view.steps.find((step) => step.name === 'dispatch' && step.status === 'done');
  const keys = [usageKey(view.sessionUsage), reviewsKey(reviews), pipelineKeys(view)];
  const inputs = [
    actorAccountingKey(view.agentContexts),
    view.repeatReviewContext?.session,
    view.repeatReviewContext?.priorRunId,
    view.reviewResult?.session,
    view.flowType,
    dispatch?.outputs?.nudged,
    dispatch?.outputs?.warmHandoff,
    dispatch?.outputs?.workerTarget,
    view.engineState?.flags?.nudgeReuse,
    view.engineState?.flags?.warmHandoffSucceeded,
  ];
  const previous = revisions.get(owner);
  if (
    previous &&
    inputs.every((input, index) => input === previous.inputs[index]) &&
    sameKey(keys, previous.keys)
  )
    return previous.revision;
  const revision = randomUUID();
  revisions.set(owner, { keys, inputs, revision });
  return revision;
}
