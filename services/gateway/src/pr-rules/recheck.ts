import { isDeepStrictEqual } from 'node:util';

import type { PRReviewIntent, PRRuleSourceProgress } from '@farmslot/protocol';

import type { PRRuleStoreData } from './store.js';

export type PRRecheckSource = { kind: 'submission' | 'rule'; id: string };

/** A record as the recheck compares it: its own value, or JSON text that drops absent keys. */
type RecheckView = { value: unknown } | { json: string };

/** Completed traversals get new identities each poll; incomplete progress remains observable. */
function progressView(progress: PRRuleSourceProgress | undefined): unknown {
  if (!progress?.completedAt || progress.pendingConnections !== 0) return progress;
  return {
    ...progress,
    id: undefined,
    startedAt: undefined,
    oldestObservationAt: undefined,
    completedAt: 'complete',
    requestsThisAttempt: undefined,
    resumed: undefined,
  };
}

function sameView(previous: RecheckView, draft: RecheckView): boolean {
  // Equal texts parse to equal values. Unequal texts may differ only in key order, so they are
  // parsed and compared as values.
  if ('json' in previous && 'json' in draft && previous.json === draft.json) return true;
  const value = (view: RecheckView): unknown =>
    'json' in view ? JSON.parse(view.json) : view.value;
  return isDeepStrictEqual(value(previous), value(draft));
}

/** Records compare by position, as in arrays of views. */
function sameRecords(
  previous: readonly RecheckView[] | undefined,
  draft: readonly RecheckView[] | undefined,
): boolean {
  if (!previous || !draft) return !previous && !draft;
  return (
    previous.length === draft.length &&
    previous.every((item, index) => sameView(item, draft[index]))
  );
}

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
  // The first intent with each id, as a search of `previous.intents` would find it.
  const oldIntents = new Map<string, PRReviewIntent>();
  for (const intent of previous.intents)
    if (!oldIntents.has(intent.id)) oldIntents.set(intent.id, intent);
  // A valid refresh must repair an obsolete admission fence durably, even if facts match.
  if (oldSubmission)
    for (const intent of draft.intents) {
      const oldIntent = oldIntents.get(intent.id);
      for (const contribution of intent.contributions) {
        if (contribution.submissionId !== source.id || !contribution.eligible) continue;
        const old = oldIntent?.contributions.find((item) => item.submissionId === source.id);
        if (old?.submissionRevision !== oldSubmission.revision) return false;
      }
    }
  const touches = (intent: PRReviewIntent): boolean =>
    intent.contributions.some((item) => item[key] === source.id);
  // Canonicalize just the affected records: builders may include absent optional keys.
  const intentView = (intent: PRReviewIntent): RecheckView =>
    !touches(intent)
      ? { value: intent }
      : {
          json: JSON.stringify({
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
        };
  const view = (data: PRRuleStoreData) => ({
    rest: {
      ...data,
      submissions: undefined,
      rules: undefined,
      intents: undefined,
      actions: undefined,
    },
    submissions: data.submissions?.map(
      (item): RecheckView => ({
        value:
          source.kind === 'submission' && item.id === source.id
            ? { ...item, revision: 0, checkedAt: undefined, updatedAt: undefined }
            : item,
      }),
    ),
    rules: data.rules.map(
      (item): RecheckView =>
        source.kind === 'rule' && item.id === source.id
          ? {
              json: JSON.stringify({
                ...item,
                scan: {
                  ...item.scan,
                  checkedAt: undefined,
                  nextScanAt: undefined,
                  sourceProgress: progressView(item.scan.sourceProgress),
                },
              }),
            }
          : { value: item },
    ),
    intents: data.intents.map(intentView),
    actions: data.actions?.map(
      (item): RecheckView =>
        source.kind === 'rule' && item.ruleId === source.id
          ? {
              json: JSON.stringify({
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
            }
          : { value: item },
    ),
  });
  const before = view(previous);
  const after = view(draft);
  const same =
    isDeepStrictEqual(before.rest, after.rest) &&
    sameRecords(before.submissions, after.submissions) &&
    sameRecords(before.rules, after.rules) &&
    sameRecords(before.intents, after.intents) &&
    sameRecords(before.actions, after.actions);
  if (!same) return false;
  if (oldSubmission && submission) {
    submission.revision = oldSubmission.revision;
    submission.updatedAt = oldSubmission.updatedAt;
  }
  for (const intent of draft.intents) {
    if (!touches(intent)) continue;
    const old = oldIntents.get(intent.id);
    if (!old) throw new Error('Unchanged recheck lost its prior intent');
    intent.updatedAt = old.updatedAt;
    for (const contribution of intent.contributions)
      if (oldSubmission && contribution.submissionId === source.id && contribution.eligible)
        contribution.submissionRevision = oldSubmission.revision;
  }
  return true;
}
