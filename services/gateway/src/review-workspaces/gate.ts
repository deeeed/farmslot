import { isDeepStrictEqual } from 'node:util';

import {
  type ReviewGatePayload,
  reviewPublicationPolicyForRun,
  type Run,
} from '@farmslot/protocol';

import { loadProjectConfig } from '../fleet/state.js';
import { captureDirectReviewPublication } from '../review-publication/direct.js';
import { selectedReviewResult } from '../review-publication/selection.js';
import { findLatestResolvedDecision } from '../run-engine/decision-replay.js';
import { createEngineDecision } from '../run-engine/engine-decisions.js';
import { supersedeStaleHumanGateDecisions } from '../run-engine/gate-policy.js';
import { readReviewWorkspaceWorker } from '../runners/native/review-workspace.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';

import { readReviewWorkspaceCompletion } from './task.js';

export function waitingAtReviewGate(run: Run): boolean {
  return run.decisions.some(
    (decision) => decision.type === 'engine_review_posting' && !decision.resolvedAt,
  );
}

/** Reuse the review decision UI; the reviewer remains alive until an explicit finish. */
export async function holdWorkspaceReview(runId: string) {
  let run = getRun(runId)!;
  if (run.prWork?.review?.options.autoFinish === true || run.reviewAutoFinish === true)
    return { skipped: true, reason: 'explicit-auto-finish' };
  if (supersedeStaleHumanGateDecisions(run.decisions))
    await persistRunNow(updateRun(runId, { decisions: run.decisions }), 'review gate reentry');
  let retryError: string | undefined;
  const generation = run.engineState?.generation ?? 0;
  for (;;) {
    if (!run.reviewResult || !run.reviewWorkspaceSubject)
      throw new Error('Review result is unavailable');
    const result = run.reviewResult;
    const subject = run.reviewWorkspaceSubject;
    const policy = reviewPublicationPolicyForRun(run);
    const payload: ReviewGatePayload = {
      kind: 'review',
      repo: subject.repository,
      prNumber: run.prNumber ?? null,

      ...result,
    };
    const action = await createEngineDecision(
      runId,
      'review_posting',
      retryError ??
        (run.reviewWorkspace?.cleanedAt
          ? 'Saved review is ready for your publication decision. The original worktree has already been cleaned.'
          : 'Review is ready. Use the original reviewer terminal or conversation for follow-up questions before finishing.'),
      [
        { id: 'post', label: 'Publish review and finish', style: 'primary' },
        { id: 'dismiss', label: 'Finish without publishing', style: 'secondary' },
      ],
      payload,
      {
        canReplay: (decision) =>
          !retryError &&
          isDeepStrictEqual((decision.payload as ReviewGatePayload)?.reviewMd, result.reviewMd) &&
          isDeepStrictEqual(
            (decision.payload as ReviewGatePayload)?.lineComments,
            result.lineComments,
          ) &&
          isDeepStrictEqual(
            (decision.payload as ReviewGatePayload)?.reviewSnapshot,
            result.reviewSnapshot,
          ),
      },
    );
    run = getRun(runId)!;
    try {
      const decision = findLatestResolvedDecision(run.decisions, 'review_posting');
      if (!decision || !['post', 'dismiss'].includes(action))
        throw new Error('Review gate has no publication decision');
      if (action === 'post' && !run.reviewWorkspace?.cleanedAt) {
        if (run.transport === 'native') {
          const snapshot = await readReviewWorkspaceWorker(runId, { allowGate: true });
          if (snapshot.commands.some((command) => !command.outcome))
            throw new Error('Wait for the reviewer to finish its follow-up before publishing');
        }
        const completion = await readReviewWorkspaceCompletion(runId);
        if (
          !completion?.result ||
          (completion.signal.outcome !== 'success' && completion.signal.status !== 'blocked')
        )
          throw new Error('Reviewer must finish its updated result before publication');
        const presented = decision.payload as ReviewGatePayload;
        if (
          !isDeepStrictEqual(completion.result.reviewMd, presented.reviewMd) ||
          !isDeepStrictEqual(completion.result.lineComments, presented.lineComments) ||
          !isDeepStrictEqual(completion.result.recommendation, presented.recommendation) ||
          !isDeepStrictEqual(completion.result.reviewSnapshot, presented.reviewSnapshot)
        ) {
          await persistRunNow(
            updateRun(runId, { reviewResult: completion.result }),
            'refresh review gate',
          );
          run = getRun(runId)!;
          retryError =
            'The reviewer changed the report. Inspect the updated review before publishing or dismissing it.';
          continue;
        }
      }
      if (action === 'post') selectedReviewResult(run);
      const selected = captureDirectReviewPublication(
        {
          flowType: 'review-pr',
          project: run.project,
          ticketOrPr: run.ticketOrPr,
          publishReview: action === 'post',
          ...(action === 'post' && policy?.teamId ? { reviewTeamId: policy.teamId } : {}),
        },
        await loadProjectConfig(run.project),
        run.nativeOwnerPrincipalId!,
      );
      if (!selected || (action === 'post' && !selected.policy.enabled))
        throw new Error('Review publication needs an authorized account');
      await persistRunNow(
        updateRun(runId, {
          error: undefined,
          reviewPublication: {
            ...run.reviewPublication,
            gate: { decisionId: decision.id, publication: selected },
            checkedAt: new Date().toISOString(),
          },
        }),
        'review publication decision',
      );
      return { action, reviewerRetainedUntilFinish: true };
    } catch (error) {
      run = getRun(runId)!;
      if (
        !run ||
        (run.engineState?.generation ?? 0) !== generation ||
        ['cancelled', 'failed', 'done'].includes(run.status)
      )
        throw error;
      // Keep the reviewer and publish workspace available for a corrected choice.
      retryError = error instanceof Error ? error.message : String(error);
      await persistRunNow(updateRun(runId, { error: retryError }), 'review gate needs attention');
    }
  }
}
