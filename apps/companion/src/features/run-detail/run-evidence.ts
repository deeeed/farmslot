import type {
  RunGetResult,
  RunRecipeRunsForRunResult,
  TaskProgressResult,
} from '@farmslot/protocol';
import { type GatewayResourceCache, type ResourceQuery } from '@farmslot/protocol/client-cache';
import { pendingOutputReview } from '@farmslot/review-dispatch';

import {
  acceptanceEvidenceHref,
  explicitRecipeRunId,
  recordedEvidenceQuery,
} from '../../lib/acceptance-evidence';

/** Bind the retained read to the same output snapshot as the report. */
export function runEvidenceQuery(
  runId: string,
  run: RunGetResult['run'] | null,
  requestedRecipeRunId: string | null,
) {
  if (!runId || run?.id !== runId) return undefined;
  const review = pendingOutputReview(run);
  const recipeRunId = explicitRecipeRunId(requestedRecipeRunId);
  return recordedEvidenceQuery(
    runId,
    review ? { id: review.id, evidenceSnapshotHash: review.payload.manifestDigest } : undefined,
    recipeRunId,
  );
}

/**
 * Where a criterion's Review evidence opens from this screen. The viewer reads the same
 * evidence as {@link runEvidenceQuery}: with an output review pending, its snapshot, whose
 * files carry that snapshot's paths, so the path the button passes is one of them.
 */
export function runAcceptanceEvidenceHref(
  run: Pick<NonNullable<RunGetResult['run']>, 'id' | 'decisions'>,
  criterionId: string,
  path: string,
  selectedRecipeRunId: string | null,
  requestedRecipeRunId: string | null,
) {
  const review = pendingOutputReview(run);
  return review
    ? acceptanceEvidenceHref(
        run.id,
        criterionId,
        path,
        undefined,
        review.id,
        explicitRecipeRunId(requestedRecipeRunId),
      )
    : acceptanceEvidenceHref(run.id, criterionId, path, selectedRecipeRunId);
}

interface EvidenceInvocation {
  cache: GatewayResourceCache | undefined;
  currentCache: GatewayResourceCache | undefined;
  contextCurrent: boolean;
  recipeQuery: ResourceQuery<RunRecipeRunsForRunResult> | undefined;
  progressQuery: ResourceQuery<TaskProgressResult> | undefined;
  evidence: RunRecipeRunsForRunResult | undefined;
}

/** Re-read at invocation: a render's ready status cannot authorize a later tap. */
export function assertRunEvidenceReady(input: EvidenceInvocation): void {
  const { cache, currentCache, contextCurrent, recipeQuery, progressQuery, evidence } = input;
  if (!contextCurrent || !cache || cache !== currentCache)
    throw new Error('The review context changed. Open the current evidence before acting.');
  if (!progressQuery || cache.read(progressQuery).status !== 'ready')
    throw new Error('Wait for current acceptance data before acting.');
  const observed = recipeQuery ? cache.read(recipeQuery) : undefined;
  if (observed?.status !== 'ready' || observed.data !== evidence)
    throw new Error('Wait for current evidence before acting.');
}
