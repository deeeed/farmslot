import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import type {
  PRReviewContribution,
  PRReviewIntent,
  PRRuleActionRecord,
  PRRuleSourceProgress,
  PRTriggerRule,
} from '@farmslot/protocol';

import { freezeStoreState } from '../core/store-snapshot.js';

import { type PRRecheckSource, retainRecheckVersion } from './recheck.js';
import type { PRRuleStoreData } from './store.js';

// Reference: retainRecheckVersion as of 65c767d6f (#2133), which compared views of both whole stores.
function referenceProgressView(progress: PRRuleSourceProgress | undefined): unknown {
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
function referenceRetainRecheckVersion(
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
              scan: {
                ...item.scan,
                checkedAt: undefined,
                nextScanAt: undefined,
                sourceProgress: referenceProgressView(item.scan.sourceProgress),
              },
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

type Random = () => number;
type Mutation = (draft: PRRuleStoreData, source: PRRecheckSource, random: Random) => void;
interface MutationCase {
  name: string;
  /** What the reference must decide when this is the only mutation. */
  expected: boolean;
  apply: Mutation;
}

/** Deterministic cases: the same seed gives the same store and mutations. */
function seeded(seed: number): Random {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}
const stamp = (seconds: number) => new Date(Date.UTC(2026, 10, 14, 12, 0, seconds)).toISOString();
const pick = <Item>(items: readonly Item[], random: Random): Item | undefined =>
  items[Math.floor(random() * items.length)];
const ruleIds = ['rule-a', 'rule-b', 'rule-c'];
const submissionIds = Array.from({ length: 8 }, (_, index) => `submission-${index}`);
const observation = (seconds: number) => ({
  observedAt: stamp(seconds),
  headSha: 'a'.repeat(40),
  state: 'open' as const,
  draft: false,
  decision: null,
  reviewer: 'reviewer',
  requested: false,
  review: null,
});
const pr = (number: number) => ({ host: 'github.com', repo: 'example/app', number });

function baseStore(random: Random): PRRuleStoreData {
  const rules: PRTriggerRule[] = ruleIds.map((id, index) => ({
    id,
    ownerId: 'owner',
    revision: 2,
    config: {
      name: `Rule ${index}`,
      teamId: 'team',
      predicate: { kind: 'compare', field: 'draft', operator: 'equals', value: false },
      actions: [{ kind: 'review', autoStart: false }],
      pollIntervalMs: 60_000,
      maxAdmissionsPerScan: 10,
      rereviewOnHeadChange: true,
    },
    enabled: true,
    createdAt: stamp(0),
    updatedAt: stamp(1),
    scan: {
      baselinePending: false,
      backfillRequested: false,
      checkedAt: stamp(10),
      nextScanAt: stamp(70),
      sourceProgress: {
        id: `progress-${id}`,
        startedAt: stamp(5),
        oldestObservationAt: stamp(5),
        completedAt: stamp(9),
        pages: 3,
        items: 40,
        pendingConnections: 0,
        requestsThisAttempt: 3,
        resumed: false,
      },
      subjects: Object.fromEntries(
        Array.from({ length: 12 }, (_, subject) => [
          `github.com/example/app#${subject}`,
          { revision: `revision-${subject}`, matched: subject % 2 === 0, admitted: false },
        ]),
      ),
    },
  }));
  const submissions = submissionIds.map((id, index) => ({
    id,
    ownerId: 'owner',
    revision: 3 + index,
    request: {
      teamId: 'team',
      pr: pr(100 + index),
      idempotencyKey: `key-${index}`,
      autoStart: false,
      source: { client: 'command-center' },
    },
    intentId: `intent-${index}`,
    checkedAt: stamp(20),
    createdAt: stamp(0),
    updatedAt: stamp(20),
  }));
  const contribution = (sourceIndex: number): PRReviewContribution => {
    const shared = {
      reviewObservation: observation(30),
      teamId: 'team',
      teamRevision: 1,
      ownerId: 'owner',
      reasons: [`reason-${sourceIndex}`],
      project: 'project',
      autoStart: false,
      eligible: random() < 0.7,
      configurationErrors: [],
    };
    if (sourceIndex < ruleIds.length)
      return { ...shared, ruleId: ruleIds[sourceIndex], ruleRevision: 2 };
    const submission = submissions[sourceIndex - ruleIds.length];
    return {
      ...shared,
      submissionId: submission.id,
      submissionRevision: submission.revision,
    };
  };
  const intents: PRReviewIntent[] = Array.from({ length: 80 }, (_, index) => {
    const sources = new Set<number>();
    const count = 1 + Math.floor(random() * 3);
    while (sources.size < count)
      sources.add(Math.floor(random() * (ruleIds.length + submissionIds.length)));
    return {
      id: `intent-${index}`,
      title: `Title ${index}`,
      pr: pr(index),
      headSha: 'a'.repeat(40),
      reviewProfile: 'standard',
      status: index % 5 === 0 ? 'held' : 'withdrawn',
      contributions: [...sources].map(contribution),
      createdAt: stamp(0),
      updatedAt: stamp(30),
      ...(index % 3 === 0 ? { waitingReason: 'Awaiting operator acceptance' } : {}),
    };
  });
  const actions: PRRuleActionRecord[] = Array.from({ length: 9 }, (_, index) => ({
    id: `action-${index}`,
    kind: 'notify',
    ownerId: 'owner',
    ruleId: ruleIds[index % ruleIds.length],
    ruleRevision: 2,
    ruleName: 'Rule',
    teamId: 'team',
    teamRevision: 1,
    teamName: 'Team',
    account: { host: 'github.com', login: 'reader' },
    subject: {
      pr: pr(index),
      headSha: 'a'.repeat(40),
      title: 'Title',
      observedAt: stamp(30),
      facts: { draft: { state: 'known', value: false } },
      reviewObservation: observation(30),
    },
    sourceRevision: `revision-${index}`,
    reasons: [],
    current: true,
    status: 'applied',
    acknowledgedBy: {},
    createdAt: stamp(0),
    updatedAt: stamp(30),
  }));
  return {
    version: 1,
    teams: [
      {
        id: 'team',
        ownerId: 'owner',
        revision: 1,
        config: {
          name: 'Team',
          account: { host: 'github.com', login: 'reader' },
          sources: [{ kind: 'repository', repo: 'example/app' }],
          predicate: { kind: 'compare', field: 'draft', operator: 'equals', value: false },
          repositories: [{ repo: 'example/app', reviewProfile: 'standard', excludedLabels: [] }],
          githubTeams: [],
          notificationPrincipalIds: [],
        },
        createdAt: stamp(0),
        updatedAt: stamp(0),
      },
    ],
    rules,
    intents,
    submissions,
    actions,
  };
}

const touchesIntent = (intent: PRReviewIntent, source: PRRecheckSource) =>
  intent.contributions.some((item) =>
    source.kind === 'rule' ? item.ruleId === source.id : item.submissionId === source.id,
  );
const touchedIntents = (draft: PRRuleStoreData, source: PRRecheckSource) =>
  draft.intents.filter((intent) => touchesIntent(intent, source));
const untouchedIntents = (draft: PRRuleStoreData, source: PRRecheckSource) =>
  draft.intents.filter((intent) => !touchesIntent(intent, source));
const sourceContributions = (draft: PRRuleStoreData, source: PRRecheckSource) =>
  draft.intents.flatMap((intent) =>
    intent.contributions.filter((item) =>
      source.kind === 'rule' ? item.ruleId === source.id : item.submissionId === source.id,
    ),
  );
const sourceRule = (draft: PRRuleStoreData, source: PRRecheckSource) =>
  source.kind === 'rule' ? draft.rules.find((item) => item.id === source.id) : undefined;
const sourceSubmission = (draft: PRRuleStoreData, source: PRRecheckSource) =>
  source.kind === 'submission'
    ? draft.submissions?.find((item) => item.id === source.id)
    : undefined;
const otherRule = (draft: PRRuleStoreData, source: PRRecheckSource, random: Random) =>
  pick(
    draft.rules.filter((item) => source.kind !== 'rule' || item.id !== source.id),
    random,
  );
/** Moves a key to the end: same value, different text. */
function reorderTitle(intent: PRReviewIntent | undefined): void {
  if (!intent || intent.title === undefined) return;
  const title = intent.title;
  delete intent.title;
  intent.title = title;
}

const quiet: MutationCase[] = [
  {
    name: 'rule observation clocks',
    expected: true,
    apply: (draft, source, random) => {
      const rule = sourceRule(draft, source);
      if (!rule) return;
      rule.scan.checkedAt = stamp(100 + Math.floor(random() * 50));
      rule.scan.nextScanAt = stamp(200 + Math.floor(random() * 50));
    },
  },
  {
    name: 'completed source progress gets a new identity',
    expected: true,
    apply: (draft, source, random) => {
      const rule = sourceRule(draft, source);
      if (!rule?.scan.sourceProgress) return;
      rule.scan.sourceProgress = {
        ...rule.scan.sourceProgress,
        id: `progress-${random()}`,
        startedAt: stamp(90),
        completedAt: stamp(95),
        requestsThisAttempt: 7,
        resumed: true,
      };
    },
  },
  {
    name: 'contribution observedAt and intent updatedAt',
    expected: true,
    apply: (draft, source, random) => {
      for (const intent of touchedIntents(draft, source)) {
        if (random() < 0.5) continue;
        intent.updatedAt = stamp(120);
        for (const item of intent.contributions)
          if (
            item.reviewObservation &&
            (source.kind === 'rule' ? item.ruleId : item.submissionId) === source.id
          )
            item.reviewObservation = { ...item.reviewObservation, observedAt: stamp(120) };
      }
    },
  },
  {
    name: 'rule action observation clocks',
    expected: true,
    apply: (draft, source) => {
      for (const action of draft.actions ?? [])
        if (source.kind === 'rule' && action.ruleId === source.id) {
          action.updatedAt = stamp(130);
          action.subject.observedAt = stamp(130);
          if (action.subject.reviewObservation)
            action.subject.reviewObservation.observedAt = stamp(130);
        }
    },
  },
  {
    name: 'submission revision, checkedAt, updatedAt and submissionRevision',
    expected: true,
    apply: (draft, source) => {
      const submission = sourceSubmission(draft, source);
      if (!submission) return;
      submission.revision += 1;
      submission.checkedAt = stamp(140);
      submission.updatedAt = stamp(140);
      for (const item of sourceContributions(draft, source))
        if (item.eligible && item.submissionId !== undefined)
          item.submissionRevision = submission.revision;
    },
  },
  {
    name: 'absent optional keys in touched records',
    expected: true,
    apply: (draft, source) => {
      for (const intent of touchedIntents(draft, source)) intent.author = undefined;
      const rule = sourceRule(draft, source);
      if (rule) rule.scan.error = undefined;
    },
  },
  {
    name: 'key order in a touched record',
    expected: true,
    apply: (draft, source, random) => reorderTitle(pick(touchedIntents(draft, source), random)),
  },
  {
    name: 'key order in an untouched record',
    expected: true,
    apply: (draft, source, random) => reorderTitle(pick(untouchedIntents(draft, source), random)),
  },
];
const touchedChanges: MutationCase[] = [
  {
    name: 'touched contribution reasons',
    expected: false,
    apply: (draft, source, random) => {
      const item = pick(sourceContributions(draft, source), random);
      if (item) item.reasons = [...item.reasons, 'new reason'];
    },
  },
  {
    name: 'touched intent status',
    expected: false,
    apply: (draft, source, random) => {
      const intent = pick(touchedIntents(draft, source), random);
      if (intent) intent.status = intent.status === 'held' ? 'withdrawn' : 'held';
    },
  },
  {
    name: 'touched contribution review observation state',
    expected: false,
    apply: (draft, source, random) => {
      const item = pick(sourceContributions(draft, source), random);
      if (item?.reviewObservation) item.reviewObservation.decision = 'APPROVED';
    },
  },
  {
    name: 'source rule subjects',
    expected: false,
    apply: (draft, source) => {
      const rule = sourceRule(draft, source);
      if (rule) rule.scan.subjects['github.com/example/app#0'].admitted = true;
    },
  },
  {
    name: 'incomplete source progress',
    expected: false,
    apply: (draft, source) => {
      const progress = sourceRule(draft, source)?.scan.sourceProgress;
      if (!progress) return;
      progress.pendingConnections = 1;
    },
  },
  {
    name: 'source submission request',
    expected: false,
    apply: (draft, source) => {
      const submission = sourceSubmission(draft, source);
      if (submission) submission.request.autoStart = true;
    },
  },
  {
    name: 'stale admission fence',
    expected: false,
    apply: (draft, source) => {
      const submission = sourceSubmission(draft, source);
      if (!submission) return;
      const intent = touchedIntents(draft, source)[0];
      const item = intent?.contributions.find((entry) => entry.submissionId === source.id);
      if (!item || item.submissionId === undefined) return;
      item.eligible = true;
      item.submissionRevision = submission.revision + 5;
    },
  },
  {
    name: 'missing source submission',
    expected: false,
    apply: (draft, source) => {
      if (source.kind === 'submission')
        draft.submissions = draft.submissions?.filter((item) => item.id !== source.id);
    },
  },
];
const untouchedChanges: MutationCase[] = [
  {
    name: 'other rule name',
    expected: false,
    apply: (draft, source, random) => {
      const rule = otherRule(draft, source, random);
      if (rule) rule.config.name = `${rule.config.name} renamed`;
    },
  },
  {
    name: 'other rule observation clock',
    expected: false,
    apply: (draft, source, random) => {
      const rule = otherRule(draft, source, random);
      if (rule) rule.scan.checkedAt = stamp(150);
    },
  },
  {
    name: 'untouched intent waiting reason',
    expected: false,
    apply: (draft, source, random) => {
      const intent = pick(untouchedIntents(draft, source), random);
      if (intent) intent.waitingReason = 'Changed';
    },
  },
  {
    name: 'untouched intent updatedAt',
    expected: false,
    apply: (draft, source, random) => {
      const intent = pick(untouchedIntents(draft, source), random);
      if (intent) intent.updatedAt = stamp(160);
    },
  },
  {
    name: 'absent optional key in an untouched record',
    expected: false,
    apply: (draft, source, random) => {
      const intent = pick(untouchedIntents(draft, source), random);
      if (intent) intent.author = undefined;
    },
  },
  {
    name: 'other submission clock',
    expected: false,
    apply: (draft, source, random) => {
      const submission = pick(
        (draft.submissions ?? []).filter((item) => item.id !== source.id),
        random,
      );
      if (submission) submission.checkedAt = stamp(170);
    },
  },
  {
    name: 'other rule action clock',
    expected: false,
    apply: (draft, source, random) => {
      const action = pick(
        (draft.actions ?? []).filter((item) => source.kind !== 'rule' || item.ruleId !== source.id),
        random,
      );
      if (action) action.updatedAt = stamp(180);
    },
  },
  {
    name: 'team revision',
    expected: false,
    apply: (draft) => {
      draft.teams[0].revision += 1;
    },
  },
  {
    name: 'added intent',
    expected: false,
    apply: (draft) => {
      draft.intents.push({ ...structuredClone(draft.intents[1]), id: 'intent-added' });
    },
  },
  {
    name: 'removed untouched intent',
    expected: false,
    apply: (draft, source, random) => {
      const intent = pick(untouchedIntents(draft, source), random);
      draft.intents = draft.intents.filter((item) => item !== intent);
    },
  },
  {
    name: 'intents reordered',
    expected: false,
    apply: (draft) => {
      draft.intents.reverse();
    },
  },
];
const cases = [...quiet, ...touchedChanges, ...untouchedChanges];
const sources: PRRecheckSource[] = [
  ...ruleIds.map((id): PRRecheckSource => ({ kind: 'rule', id })),
  ...submissionIds.map((id): PRRecheckSource => ({ kind: 'submission', id })),
];

/** Runs both implementations on identical drafts; returns the shared decision. */
function compare(
  previous: PRRuleStoreData,
  source: PRRecheckSource,
  mutations: readonly MutationCase[],
  seed: number,
): boolean {
  const drafts = [0, 1].map(() => {
    const draft: PRRuleStoreData = JSON.parse(JSON.stringify(previous));
    const random = seeded(seed);
    for (const mutation of mutations) mutation.apply(draft, source, random);
    return draft;
  });
  const label = `${source.kind} ${source.id}: ${mutations.map((item) => item.name).join(' + ')}`;
  const expected = referenceRetainRecheckVersion(previous, drafts[0], source);
  assert.equal(retainRecheckVersion(previous, drafts[1], source), expected, label);
  // Same retained versions and clocks, including any absent keys the drafts carry.
  assert.deepStrictEqual(drafts[1], drafts[0], label);
  return expected;
}

test('each recheck mutation decides as the whole-store comparison did', () => {
  const previous = freezeStoreState(baseStore(seeded(7)));
  for (const source of sources)
    for (const mutation of cases) {
      const decided = compare(previous, source, [mutation], 11);
      // Mutations that do not apply to this source leave the draft quiet.
      if (decided !== mutation.expected) assert.equal(decided, true, mutation.name);
    }
  // Every mutation case decides as expected for at least one source, so none is vacuous.
  for (const mutation of cases)
    assert.ok(
      sources.some((source) => compare(previous, source, [mutation], 11) === mutation.expected),
      mutation.name,
    );
});

test('random combinations of recheck mutations decide as the whole-store comparison did', () => {
  const decisions = { retained: 0, persisted: 0 };
  for (let seed = 1; seed <= 400; seed += 1) {
    const random = seeded(seed);
    const previous = freezeStoreState(baseStore(random));
    const source = pick(sources, random)!;
    const count = 1 + Math.floor(random() * 3);
    // Quiet mutations are over-represented so many combinations stay observation-only.
    const pool = random() < 0.5 ? quiet : cases;
    const mutations = Array.from({ length: count }, () => pick(pool, random)!);
    if (compare(previous, source, mutations, seed)) decisions.retained += 1;
    else decisions.persisted += 1;
  }
  assert.ok(decisions.retained > 150 && decisions.persisted > 100, JSON.stringify(decisions));
});

test('optional and sparse record arrays decide as the whole-store comparison did', () => {
  const both = (previous: PRRuleStoreData, draft: PRRuleStoreData, source: PRRecheckSource) => {
    const reference = referenceRetainRecheckVersion(previous, structuredClone(draft), source);
    assert.equal(retainRecheckVersion(previous, structuredClone(draft), source), reference);
    return reference;
  };
  for (const source of sources) {
    const base: PRRuleStoreData = baseStore(seeded(3));
    // A rule recheck on a store without actions records `actions ??= []`; that is not quiet.
    const withoutActions: PRRuleStoreData = { ...structuredClone(base), actions: undefined };
    delete withoutActions.actions;
    assert.equal(both(withoutActions, { ...structuredClone(base), actions: [] }, source), false);
    assert.equal(both({ ...structuredClone(base), actions: [] }, withoutActions, source), false);
    const withoutSubmissions: PRRuleStoreData = structuredClone(base);
    delete withoutSubmissions.submissions;
    assert.equal(
      both(withoutSubmissions, { ...structuredClone(base), submissions: [] }, source),
      false,
    );
    // A hole equals only a hole, as in a deep comparison of the arrays.
    const action = base.actions?.[0];
    if (!action) continue;
    const sparse: PRRuleStoreData = { ...structuredClone(base), actions: new Array(2) };
    sparse.actions![1] = structuredClone(action);
    const dense: PRRuleStoreData = {
      ...structuredClone(base),
      actions: [structuredClone(action), structuredClone(action)],
    };
    assert.equal(both(sparse, dense, source), false);
    assert.equal(both(dense, sparse, source), false);
    // Matching holes compare equal in both implementations (both() asserts they agree).
    both(sparse, structuredClone(sparse), source);
  }
});
