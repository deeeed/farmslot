import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  DEFAULT_PR_REVIEW_OPTIONS,
  monitoredPRKey,
  type PRReviewContribution,
  type PRReviewRequest,
  type PRReviewSubmission,
  type PRRulePreviewItem,
} from '@farmslot/protocol';

import { reconcileReviewIntent, reviewIntentId } from './intents.js';
import type { PRRuleStoreData } from './store.js';

export function createReviewSubmission(
  data: PRRuleStoreData,
  ownerId: string,
  request: PRReviewRequest,
): PRReviewSubmission {
  const normalized = structuredClone(request);
  normalized.pr = {
    ...request.pr,
    host: request.pr.host.toLowerCase(),
    repo: request.pr.repo.toLowerCase(),
  };
  const existing = data.submissions?.find(
    (item) => item.ownerId === ownerId && item.request.idempotencyKey === request.idempotencyKey,
  );
  if (existing) {
    if (!isDeepStrictEqual(existing.request, normalized))
      throw new Error('Idempotency key was already used for a different review request');
    return existing;
  }
  const team = data.teams.find((item) => item.id === request.teamId && item.ownerId === ownerId);
  if (!team) throw new Error('Team profile not found');
  if (request.pr.host.toLowerCase() !== team.config.account.host.toLowerCase())
    throw new Error('Review PR host must match the team account');
  const now = new Date().toISOString();
  const submission: PRReviewSubmission = {
    id: randomUUID(),
    ownerId,
    revision: 1,
    request: normalized,
    priorExecutionIds: data.intents
      .filter(
        (intent) =>
          intent.runId &&
          monitoredPRKey(intent.pr) === monitoredPRKey(normalized.pr) &&
          intent.contributions.some((source) => source.ownerId === ownerId),
      )
      .map((intent) => intent.id),
    createdAt: now,
    updatedAt: now,
  };
  (data.submissions ??= []).push(submission);
  return submission;
}

/** Updates the same intent collection used by rules; submission receipts retain replay identity. */
export function applyReviewSubmission(
  data: PRRuleStoreData,
  ownerId: string,
  id: string,
  revision: number,
  teamRevision: number,
  result: { item: PRRulePreviewItem } | { error: string },
): PRReviewSubmission {
  const submission = data.submissions?.find(
    (entry) => entry.id === id && entry.ownerId === ownerId,
  );
  if (!submission) throw new Error('Review request not found');
  if (submission.cancelledAt) return submission;
  const team = data.teams.find(
    (item) => item.id === submission.request.teamId && item.ownerId === ownerId,
  );
  if (submission.revision !== revision || team?.revision !== teamRevision)
    throw new Error('Review request or team policy changed; refresh before admission');
  const linked = data.intents.find((item) => item.id === submission.intentId);
  if (linked?.runId || ['running', 'completed', 'failed'].includes(linked?.status ?? ''))
    return submission;
  const previous = linked?.contributions.find((source) => source.submissionId === id);
  for (const intent of data.intents) {
    for (const source of intent.contributions)
      if (source.submissionId === id) source.eligible = false;
  }
  submission.revision += 1;
  submission.checkedAt = new Date().toISOString();
  submission.updatedAt = submission.checkedAt;
  if ('error' in result) submission.error = result.error;
  else {
    const { item } = result;
    if (monitoredPRKey(item.subject.pr) !== monitoredPRKey(submission.request.pr))
      throw new Error('Review observation returned a different PR');
    delete submission.error;
    if (item.match.state !== 'match')
      submission.error =
        item.match.reasons.join('; ') || 'PR does not match the team review policy';
    else {
      const rounds = data.intents.filter(
        (entry) =>
          monitoredPRKey(entry.pr) === monitoredPRKey(item.subject.pr) &&
          entry.headSha === item.subject.headSha &&
          entry.reviewProfile === item.reviewProfile,
      );
      // A receipt that predates execution is still concurrent intake when its
      // provider read finishes late. Only identical authorized requirements can
      // join that running assignment; never change its execution configuration.
      const concurrent = rounds.find(
        (entry) =>
          entry.runId &&
          submission.priorExecutionIds &&
          !submission.priorExecutionIds.includes(entry.id) &&
          entry.contributions.some((source) => source.eligible) &&
          entry.contributions
            .filter((source) => source.eligible)
            .every(
              (source) =>
                source.project === item.project &&
                isDeepStrictEqual(source.execution, item.execution) &&
                isDeepStrictEqual(
                  source.review ?? DEFAULT_PR_REVIEW_OPTIONS,
                  item.review ?? DEFAULT_PR_REVIEW_OPTIONS,
                ),
            ),
      );
      let intent =
        concurrent ??
        rounds.find(
          (entry) => !entry.runId && !['running', 'completed', 'failed'].includes(entry.status),
        );
      if (!intent) {
        const round = Math.max(0, ...rounds.map((entry) => entry.round ?? 1)) + 1;
        intent = {
          id: reviewIntentId(item, round),
          round,
          pr: item.subject.pr,
          headSha: item.subject.headSha,
          reviewProfile: item.reviewProfile,
          status: 'held',
          contributions: [],
          createdAt: submission.checkedAt,
          updatedAt: submission.checkedAt,
        };
        data.intents.push(intent);
      }
      const source: PRReviewContribution = {
        submissionId: id,
        submissionRevision: submission.revision,
        ownerId,
        teamId: team.id,
        teamRevision: team.revision,
        reasons: item.match.reasons,
        project: item.project,
        execution: item.execution,
        review: item.review,
        autoStart: submission.request.autoStart,
        eligible: true,
        configurationErrors: item.configurationErrors,
        ...(previous?.teamRevision === team.revision
          ? { acceptedAt: previous.acceptedAt, deferredAt: previous.deferredAt }
          : {}),
      };
      intent.contributions = intent.contributions
        .filter((entry) => entry.submissionId !== id)
        .concat(source);
      intent.updatedAt = submission.checkedAt;
      submission.intentId = intent.id;
    }
  }
  for (const intent of data.intents) reconcileReviewIntent(intent);
  return submission;
}
