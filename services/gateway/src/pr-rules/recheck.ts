import { isDeepStrictEqual } from 'node:util';

import type { PRReviewIntent } from '@farmslot/protocol';

import type { PRRuleStoreData } from './store.js';

export type PRRecheckSource = { kind: 'submission' | 'rule'; id: string };

/** Only observation clocks and their mechanically advanced submission version are quiet. */
export function retainRecheckVersion(
  previous: PRRuleStoreData,
  draft: PRRuleStoreData,
  source: PRRecheckSource,
): boolean {
  const key = source.kind === 'submission' ? 'submissionId' : 'ruleId';
  const oldSubmission =
    source.kind === 'submission'
      ? previous.submissions?.find((item) => item.id === source.id)
      : undefined;
  const submission =
    source.kind === 'submission'
      ? draft.submissions?.find((item) => item.id === source.id)
      : undefined;
  if (source.kind === 'submission' && (!oldSubmission || !submission)) return false;
  // A valid refresh must repair an obsolete admission fence durably, even if facts match.
  if (oldSubmission)
    for (const intent of draft.intents) {
      const oldIntent = previous.intents.find((item) => item.id === intent.id);
      for (const contribution of intent.contributions) {
        if (contribution.submissionId !== source.id || !contribution.eligible) continue;
        const old = oldIntent?.contributions.find((item) => item.submissionId === source.id);
        if (old?.submissionRevision !== oldSubmission.revision) return false;
      }
    }
  const intentView = (intent: PRReviewIntent): unknown => {
    if (!intent.contributions.some((item) => item[key] === source.id)) return intent;
    // Canonicalize just the affected record: builders may include absent optional keys.
    return JSON.parse(
      JSON.stringify({
        ...intent,
        updatedAt: undefined,
        contributions: intent.contributions.map((item) =>
          item[key] !== source.id
            ? item
            : {
                ...item,
                ...(source.kind === 'submission' ? { submissionRevision: undefined } : {}),
                reviewObservation: item.reviewObservation
                  ? { ...item.reviewObservation, observedAt: undefined }
                  : undefined,
              },
        ),
      }),
    );
  };
  const view = (data: PRRuleStoreData): unknown => ({
    ...data,
    submissions: data.submissions?.map((item) =>
      source.kind === 'submission' && item.id === source.id
        ? { ...item, revision: 0, checkedAt: undefined, updatedAt: undefined }
        : item,
    ),
    rules: data.rules.map((item) =>
      source.kind === 'rule' && item.id === source.id
        ? JSON.parse(
            JSON.stringify({
              ...item,
              scan: { ...item.scan, checkedAt: undefined, nextScanAt: undefined },
            }),
          )
        : item,
    ),
    intents: data.intents.map(intentView),
    actions: data.actions?.map((item) =>
      source.kind === 'rule' && item.ruleId === source.id
        ? JSON.parse(
            JSON.stringify({
              ...item,
              updatedAt: undefined,
              subject: {
                ...item.subject,
                observedAt: undefined,
                reviewObservation: item.subject.reviewObservation
                  ? { ...item.subject.reviewObservation, observedAt: undefined }
                  : undefined,
              },
            }),
          )
        : item,
    ),
  });
  if (!isDeepStrictEqual(view(previous), view(draft))) return false;
  if (oldSubmission && submission) {
    submission.revision = oldSubmission.revision;
    submission.updatedAt = oldSubmission.updatedAt;
  }
  for (const intent of draft.intents) {
    if (!intent.contributions.some((item) => item[key] === source.id)) continue;
    const old = previous.intents.find((item) => item.id === intent.id);
    if (!old) throw new Error('Unchanged recheck lost its prior intent');
    intent.updatedAt = old.updatedAt;
    for (const contribution of intent.contributions)
      if (oldSubmission && contribution.submissionId === source.id && contribution.eligible)
        contribution.submissionRevision = oldSubmission.revision;
  }
  return true;
}
