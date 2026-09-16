import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { PRMonitorIncident, Run } from '@farmslot/protocol';

import { makeRun } from '../family-observability/test-fixtures.js';

import {
  annotateFeedbackConsumption,
  buildFeedbackCandidates,
  type FeedbackCandidateInput,
  feedbackIdentityFromUrl,
  feedbackSourceKey,
  feedbackTargetForRun,
  githubRepositorySlugFromUrl,
  summarizeFeedbackCandidates,
  unconsumedHumanFeedback,
} from './feedback-candidates.js';
import type { FeedbackLedger } from './feedback-ledger.js';

const TARGET = { host: 'github.com', repository: 'MetaMask/metamask-mobile', prNumber: 34865 };
const URL = 'https://github.com/MetaMask/metamask-mobile/pull/34865#discussion_r3916065775';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function incident(overrides: Partial<PRMonitorIncident> & { signal: PRMonitorIncident['signal'] }) {
  return {
    id: 'inc',
    firstObservedAt: '2026-09-01T00:00:00.000Z',
    lastObservedAt: '2026-09-02T00:00:00.000Z',
    attemptCount: 0,
    ...overrides,
  } as PRMonitorIncident;
}

function monitor(
  incidents: PRMonitorIncident[],
  headSha = 'a93b2a48b007b9f4ca0c0d4b3fb8b8ea66cf4b08',
): FeedbackCandidateInput['monitors'][number] {
  return {
    config: {
      pr: { host: 'github.com', repo: 'MetaMask/metamask-mobile', number: 34865 },
    } as FeedbackCandidateInput['monitors'][number]['config'],
    incidents,
    observation: { headSha } as FeedbackCandidateInput['monitors'][number]['observation'],
    originatingRunIds: ['monitor-origin-run'],
  };
}

const EMPTY_LEDGER: FeedbackLedger = { version: 1, entries: [] };

function family(...runs: Run[]): Run[] {
  return runs;
}

const ROOT = makeRun({
  id: 'root',
  familyId: 'root',
  flowType: 'fix-bug',
  ticketOrPr: 'MetaMask/metamask-mobile#34865',
});
const FOLLOW = makeRun({
  id: 'follow',
  familyId: 'root',
  parentRunId: 'root',
  flowType: 'pr-complete',
  ticketOrPr: 'MetaMask/metamask-mobile#34865',
});
const REVIEW = makeRun({
  id: 'review',
  familyId: 'review',
  flowType: 'review-pr',
  ticketOrPr: 'MetaMask/metamask-mobile#34865',
});

const HUMAN_TRIAGE = {
  comment_id: 3916065775,
  author_login: 'reviewer-a',
  author_type: 'User',
  source_kind: 'human',
  review_state: 'CHANGES_REQUESTED',
  path: 'app/components/UI/Perps/hooks/usePerpsOrderForm.ts',
  body: 'Late defaults overwrite what the user typed.',
  triage: 'REAL',
  fixed_in_commit: null,
};

test('identity is the provider comment id, so duplicate scans and repair pushes yield one candidate', () => {
  const first = incident({
    signal: {
      kind: 'feedback',
      key: 'PRRC_1',
      revision: 'rev-1',
      summary: 'reviewer-a: Late defaults overwrite what the user typed.',
      url: URL,
      reviewedCommit: 'a93b2a48b007b9f4ca0c0d4b3fb8b8ea66cf4b08',
    },
  });
  const candidates = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(ROOT, FOLLOW),
    // The same comment triaged by two follow-up runs AND observed by the monitor twice.
    triage: [
      { runId: 'follow', entries: [HUMAN_TRIAGE] },
      { runId: 'follow-2', entries: [HUMAN_TRIAGE] },
    ],
    monitors: [monitor([first]), monitor([first], 'b7cc4ff3000000000000000000000000000000ff')],
    ledger: EMPTY_LEDGER,
  });
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  assert.equal(candidate!.sourceKey, feedbackSourceKey(TARGET, 'review-comment', '3916065775'));
  assert.equal(candidate!.id, sha256(candidate!.sourceKey));
  assert.deepEqual(candidate!.sources, ['comments-triage', 'pr-monitor']);
  assert.deepEqual(candidate!.runIds, ['follow', 'follow-2', 'monitor-origin-run']);
  assert.equal(candidate!.authorKind, 'human');
  assert.equal(candidate!.reviewedCommit, 'a93b2a48b007b9f4ca0c0d4b3fb8b8ea66cf4b08');
  // Provider revision wins over the body hash when the monitor observed the comment.
  assert.equal(candidate!.revision, 'rev-1');
  assert.equal(candidate!.bodyRevision, sha256('Late defaults overwrite what the user typed.'));
  assert.equal(candidate!.attribution.kind, 'family-change');
  assert.deepEqual(candidate!.familyChangeRunIds, ['root', 'follow']);
});

test('an edited comment changes the revision but keeps its consumed-rule link and is flagged revised', () => {
  const ledger: FeedbackLedger = {
    version: 1,
    entries: [
      {
        sourceKey: feedbackSourceKey(TARGET, 'review-comment', '3916065775'),
        candidateId: 'x',
        revision: 'rev-1',
        bodyRevision: sha256('Late defaults overwrite what the user typed.'),
        destination:
          'git@github.com:MetaMask/experimental-metamask-recipe-perps.git:review/antipatterns.md',
        rule: 'Late defaults overwrite a user choice',
        recordedAt: '2026-09-15T00:00:00.000Z',
        source: 'approved-audit',
      },
    ],
  };
  const unchanged = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(ROOT),
    triage: [{ runId: 'root', entries: [HUMAN_TRIAGE] }],
    monitors: [],
    ledger,
  })[0]!;
  assert.equal(unchanged.consumedBy?.length, 1);
  assert.equal(unchanged.revisedSinceConsumed, undefined, 'same body via triage is not a revision');

  const edited = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(ROOT),
    triage: [],
    monitors: [
      monitor([
        incident({
          signal: {
            kind: 'feedback',
            key: 'PRRC_1',
            revision: 'rev-2',
            summary: 'reviewer-a: Late defaults overwrite what the user typed (edited).',
            url: URL,
          },
        }),
      ]),
    ],
    ledger,
  })[0]!;
  assert.equal(edited.revision, 'rev-2');
  assert.equal(edited.consumedBy?.[0]?.rule, 'Late defaults overwrite a user choice');
  assert.equal(edited.revisedSinceConsumed, true);
  assert.equal(
    unconsumedHumanFeedback([unchanged, edited]).length,
    1,
    'only the edited one re-enters curation',
  );
});

test('a new reviewed SHA does not create a second candidate; head and reviewed commit stay separate', () => {
  const candidates = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(ROOT),
    triage: [],
    monitors: [
      monitor(
        [
          incident({
            signal: {
              kind: 'feedback',
              key: 'PRRC_1',
              revision: 'rev-1',
              summary: 'reviewer-a: body',
              url: URL,
              reviewedCommit: '47dfbf15ed95d0f2ce4ce11d502476d3766b1e57',
            },
          }),
        ],
        'ffffffffffffffffffffffffffffffffffffffff',
      ),
    ],
    ledger: EMPTY_LEDGER,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.reviewedCommit, '47dfbf15ed95d0f2ce4ce11d502476d3766b1e57');
  assert.equal(candidates[0]!.observedHead, 'ffffffffffffffffffffffffffffffffffffffff');
});

test('bot, human and unknown feedback stay distinguishable and are summarised separately', () => {
  const candidates = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(ROOT),
    triage: [
      {
        runId: 'root',
        entries: [
          HUMAN_TRIAGE,
          {
            comment_id: 1,
            author_login: 'cursor[bot]',
            author_type: 'Bot',
            source_kind: 'bugbot',
            triage: 'REAL',
            fixed_in_commit: 'abc123',
          },
          { comment_id: 2, author_login: 'someone', triage: 'OUT_OF_SCOPE' },
        ],
      },
    ],
    monitors: [
      monitor([
        incident({
          signal: {
            kind: 'review',
            key: 'PRR_1',
            revision: 'r',
            summary: 'dependabot[bot] requested changes',
            url: 'https://github.com/MetaMask/metamask-mobile/pull/34865#pullrequestreview-99',
          },
        }),
      ]),
    ],
    ledger: EMPTY_LEDGER,
  });
  const byKind = Object.fromEntries(
    candidates.map((c) => [c.sourceKey.split(':').slice(1).join(':'), c.authorKind]),
  );
  assert.deepEqual(byKind, {
    'review-comment:3916065775': 'human',
    'review-comment:1': 'bot',
    'review-comment:2': 'unknown',
    'review:99': 'bot',
  });
  assert.deepEqual(summarizeFeedbackCandidates(candidates), {
    total: 4,
    human: 1,
    bot: 2,
    unknown: 1,
    consumed: 0,
    open: 3,
  });
  const fixed = candidates.find((c) => c.sourceKey.endsWith(':1'))!;
  assert.deepEqual(fixed.resolution, { state: 'fixed', triage: 'REAL', fixedInCommit: 'abc123' });
  // Human first, then open before fixed — the curation order.
  assert.equal(candidates[0]!.authorKind, 'human');
});

test('attribution: review-only and follow-up-only families are never blamed for the implementation', () => {
  const reviewOnly = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(REVIEW),
    triage: [{ runId: 'review', entries: [HUMAN_TRIAGE] }],
    monitors: [],
    ledger: EMPTY_LEDGER,
  })[0]!;
  assert.equal(reviewOnly.attribution.kind, 'review-only');
  assert.deepEqual(reviewOnly.familyChangeRunIds, []);

  const followUpOnly = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(
      makeRun({
        id: 'pc',
        familyId: 'pc',
        flowType: 'pr-complete',
        ticketOrPr: 'MetaMask/metamask-mobile#34865',
      }),
    ),
    triage: [{ runId: 'pc', entries: [HUMAN_TRIAGE] }],
    monitors: [],
    ledger: EMPTY_LEDGER,
  })[0]!;
  assert.equal(followUpOnly.attribution.kind, 'follow-up-only');
  assert.match(followUpOnly.attribution.note, /attribution incomplete/);

  const unknown = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: [],
    triage: [{ runId: 'ghost', entries: [HUMAN_TRIAGE] }],
    monitors: [],
    ledger: EMPTY_LEDGER,
  })[0]!;
  assert.equal(unknown.attribution.kind, 'unknown');
});

test('monitors for other PRs are ignored and unkeyable triage rows are skipped', () => {
  const candidates = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(ROOT),
    triage: [{ runId: 'root', entries: [{ author_login: 'x', body: 'no id' }] }],
    monitors: [
      {
        ...monitor([
          incident({
            signal: {
              kind: 'feedback',
              key: 'k',
              revision: 'r',
              summary: 'a: b',
              url: 'https://github.com/o/r/pull/1#discussion_r5',
            },
          }),
        ]),
        config: {
          pr: { host: 'github.com', repo: 'other/repo', number: 1 },
        } as FeedbackCandidateInput['monitors'][number]['config'],
      },
    ],
    ledger: EMPTY_LEDGER,
  });
  assert.equal(candidates.length, 0);
});

test('helpers parse provider identities and run PR targets', () => {
  assert.deepEqual(feedbackIdentityFromUrl(URL), {
    kind: 'review-comment',
    providerId: '3916065775',
  });
  assert.deepEqual(feedbackIdentityFromUrl('https://github.com/o/r/pull/1#pullrequestreview-77'), {
    kind: 'review',
    providerId: '77',
  });
  assert.equal(feedbackIdentityFromUrl('https://github.com/o/r/pull/1'), null);
  assert.equal(
    githubRepositorySlugFromUrl('git@github.com:MetaMask/metamask-mobile.git'),
    'MetaMask/metamask-mobile',
  );
  assert.equal(
    githubRepositorySlugFromUrl('https://github.com/MetaMask/metamask-mobile'),
    'MetaMask/metamask-mobile',
  );
  assert.equal(githubRepositorySlugFromUrl('https://gitlab.com/o/r.git'), null);
  // PR-bound flows may carry the PR in ticketOrPr; a fix-bug ticket ref is an issue, not a PR.
  assert.deepEqual(feedbackTargetForRun(FOLLOW, [], null), TARGET);
  assert.equal(feedbackTargetForRun(ROOT, [], null), null);
  assert.deepEqual(feedbackTargetForRun(ROOT, [FOLLOW], null), TARGET);
  // A discovered PR number with the project repo wins over any ticket reference.
  assert.deepEqual(
    feedbackTargetForRun(
      makeRun({ ticketOrPr: 'o/r#1', flowType: 'pr-complete', prNumber: 34865 }),
      [],
      'MetaMask/metamask-mobile',
    ),
    TARGET,
  );
  assert.deepEqual(
    feedbackTargetForRun(
      makeRun({ ticketOrPr: 'TAT-1', prNumber: 12 }),
      [],
      'MetaMask/metamask-extension',
    ),
    { host: 'github.com', repository: 'MetaMask/metamask-extension', prNumber: 12 },
  );
  assert.equal(feedbackTargetForRun(makeRun({ ticketOrPr: 'TAT-1' }), [], null), null);
});

test('the latest monitor observation of a comment wins over its retained earlier incidents', () => {
  const stale = incident({
    id: 'old',
    lastObservedAt: '2026-09-01T00:00:00.000Z',
    resolvedAt: '2026-09-02T00:00:00.000Z',
    signal: {
      kind: 'feedback',
      key: 'PRRC_1',
      revision: 'rev-1',
      summary: 'reviewer-a: original text',
      url: URL,
    },
  });
  const edited = incident({
    id: 'new',
    lastObservedAt: '2026-09-03T00:00:00.000Z',
    signal: {
      kind: 'feedback',
      key: 'PRRC_1',
      revision: 'rev-2',
      summary: 'reviewer-a: edited text',
      url: URL,
      reviewedCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  });
  const [candidate] = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(ROOT),
    triage: [],
    monitors: [monitor([stale, edited])],
    ledger: EMPTY_LEDGER,
  });
  assert.equal(candidate!.revision, 'rev-2');
  assert.equal(candidate!.excerpt, 'edited text');
  assert.equal(candidate!.reviewedCommit, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(candidate!.resolution.state, 'open', 'an edited open comment is not stale-resolved');
  // The provider summary is truncated, so it is never a body fingerprint.
  assert.equal(candidate!.bodyRevision, undefined);
});

test('equal-rank merge keeps the richer triage fields over a sparse provider record', () => {
  const [candidate] = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(ROOT),
    triage: [{ runId: 'root', entries: [HUMAN_TRIAGE] }],
    monitors: [
      monitor([
        incident({
          signal: {
            kind: 'feedback',
            key: 'PRRC_1',
            revision: 'rev-1',
            summary: 'reviewer-a: x',
            url: URL,
          },
        }),
      ]),
    ],
    ledger: EMPTY_LEDGER,
  });
  assert.deepEqual(candidate!.resolution, { state: 'open', triage: 'REAL' });
});

test('annotateFeedbackConsumption re-reads consumption for stored candidates', () => {
  const [candidate] = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(ROOT),
    triage: [{ runId: 'root', entries: [HUMAN_TRIAGE] }],
    monitors: [],
    ledger: EMPTY_LEDGER,
  });
  assert.equal(candidate!.consumedBy, undefined);
  const ledger: FeedbackLedger = {
    version: 1,
    entries: [
      {
        sourceKey: candidate!.sourceKey,
        candidateId: candidate!.id,
        revision: candidate!.revision,
        destination: 'lib:review/antipatterns.md',
        rule: 'r',
        recordedAt: 'now',
        source: 'learnings-draft',
      },
    ],
  };
  const [refreshed] = annotateFeedbackConsumption([candidate!], ledger);
  assert.equal(refreshed!.consumedBy?.[0]?.rule, 'r');
  assert.equal(refreshed!.revisedSinceConsumed, undefined);
  // Annotation never freezes consumption in: against an empty ledger it is unconsumed again.
  assert.equal(annotateFeedbackConsumption([refreshed!], EMPTY_LEDGER)[0]!.consumedBy, undefined);
});

test('a triage body copied before an edit cannot mask the newer provider revision', () => {
  const ledger: FeedbackLedger = {
    version: 1,
    entries: [
      {
        sourceKey: feedbackSourceKey(TARGET, 'review-comment', '3916065775'),
        candidateId: 'x',
        revision: 'rev-1',
        bodyRevision: sha256('Late defaults overwrite what the user typed.'),
        destination: 'lib:review/antipatterns.md',
        rule: 'r',
        recordedAt: 'now',
        source: 'approved-audit',
      },
    ],
  };
  const [candidate] = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(ROOT),
    // Old body in the family artifact, edited comment on the provider.
    triage: [{ runId: 'root', entries: [HUMAN_TRIAGE] }],
    monitors: [
      monitor([
        incident({
          signal: {
            kind: 'feedback',
            key: 'PRRC_1',
            revision: 'rev-2',
            summary: 'reviewer-a: edited body',
            url: URL,
          },
        }),
      ]),
    ],
    ledger,
  });
  assert.equal(candidate!.revision, 'rev-2');
  assert.equal(
    candidate!.excerpt,
    'edited body',
    'display follows the provider, not the stale artifact',
  );
  assert.equal(candidate!.revisedSinceConsumed, true);
  assert.equal(unconsumedHumanFeedback([candidate!]).length, 1);
});

test('the newest observation wins across several monitors of the same PR, whatever their order', () => {
  const newer = monitor([
    incident({
      id: 'newer',
      lastObservedAt: '2026-09-05T00:00:00.000Z',
      signal: {
        kind: 'feedback',
        key: 'PRRC_1',
        revision: 'rev-2',
        summary: 'reviewer-a: edited',
        url: URL,
      },
    }),
  ]);
  const stale = monitor([
    incident({
      id: 'stale',
      lastObservedAt: '2026-09-01T00:00:00.000Z',
      resolvedAt: '2026-09-02T00:00:00.000Z',
      signal: {
        kind: 'feedback',
        key: 'PRRC_1',
        revision: 'rev-1',
        summary: 'reviewer-a: original',
        url: URL,
      },
    }),
  ]);
  for (const monitors of [
    [newer, stale],
    [stale, newer],
  ]) {
    const [candidate] = buildFeedbackCandidates({
      target: TARGET,
      familyRuns: family(ROOT),
      triage: [],
      monitors,
      ledger: EMPTY_LEDGER,
    });
    assert.equal(candidate!.revision, 'rev-2');
    assert.equal(candidate!.resolution.state, 'open');
    assert.equal(candidate!.excerpt, 'edited');
  }
});

test('the newest family triage copy of a comment wins, whatever order the runs were read', () => {
  const rootRun = makeRun({
    id: 'root',
    familyId: 'root',
    flowType: 'fix-bug',
    completedAt: '2026-09-01T00:00:00.000Z',
    ticketOrPr: 'MetaMask/metamask-mobile#34865',
  });
  const laterRun = makeRun({
    id: 'later',
    familyId: 'root',
    parentRunId: 'root',
    flowType: 'pr-complete',
    completedAt: '2026-09-05T00:00:00.000Z',
    ticketOrPr: 'MetaMask/metamask-mobile#34865',
  });
  const ledger: FeedbackLedger = {
    version: 1,
    entries: [
      {
        sourceKey: feedbackSourceKey(TARGET, 'review-comment', '3916065775'),
        candidateId: 'x',
        revision: sha256('Late defaults overwrite what the user typed.'),
        bodyRevision: sha256('Late defaults overwrite what the user typed.'),
        destination: 'lib:review/antipatterns.md',
        rule: 'r',
        recordedAt: 'now',
        source: 'approved-audit',
      },
    ],
  };
  const edited = {
    ...HUMAN_TRIAGE,
    body: 'Late defaults overwrite what the user typed — and MAX too.',
  };
  for (const triage of [
    [
      { runId: 'root', entries: [HUMAN_TRIAGE] },
      { runId: 'later', entries: [edited] },
    ],
    [
      { runId: 'later', entries: [edited] },
      { runId: 'root', entries: [HUMAN_TRIAGE] },
    ],
  ]) {
    const [candidate] = buildFeedbackCandidates({
      target: TARGET,
      familyRuns: family(rootRun, laterRun),
      triage,
      monitors: [],
      ledger,
    });
    assert.match(candidate!.excerpt ?? '', /and MAX too/);
    assert.equal(candidate!.revisedSinceConsumed, true);
  }
});

test('the candidate cap keeps feedback still awaiting curation ahead of consumed entries', () => {
  const entries = Array.from({ length: 81 }, (_, index) => ({
    comment_id: 1000 + index,
    author_login: 'reviewer-a',
    author_type: 'User',
    source_kind: 'human',
    body: `comment ${index}`,
    triage: 'REAL',
  }));
  // Every comment except the last one was already consumed.
  const ledger: FeedbackLedger = {
    version: 1,
    entries: entries.slice(0, 80).map((entry) => ({
      sourceKey: feedbackSourceKey(TARGET, 'review-comment', String(entry.comment_id)),
      candidateId: 'x',
      revision: sha256(entry.body),
      bodyRevision: sha256(entry.body),
      destination: 'lib:review/antipatterns.md',
      rule: 'r',
      recordedAt: 'now',
      source: 'approved-audit' as const,
    })),
  };
  const candidates = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(ROOT),
    triage: [{ runId: 'root', entries }],
    monitors: [],
    ledger,
  });
  assert.equal(candidates.length, 80);
  assert.equal(candidates[0]!.sourceKey.endsWith(':1080'), true, 'the unconsumed comment leads');
  assert.equal(unconsumedHumanFeedback(candidates).length, 1);
});

test('a provider fingerprint appearing after a triage-only consumption does not re-open unchanged feedback', () => {
  const body = 'Late defaults overwrite what the user typed.';
  const ledger: FeedbackLedger = {
    version: 1,
    entries: [
      {
        sourceKey: feedbackSourceKey(TARGET, 'review-comment', '3916065775'),
        candidateId: 'x',
        revision: sha256(body),
        bodyRevision: sha256(body),
        destination: 'lib:review/antipatterns.md',
        rule: 'r',
        recordedAt: 'now',
        source: 'learnings-draft',
      },
    ],
  };
  const triagedRun = makeRun({
    id: 'root',
    familyId: 'root',
    flowType: 'pr-complete',
    completedAt: '2026-09-01T00:00:00.000Z',
    ticketOrPr: 'MetaMask/metamask-mobile#34865',
  });
  const observedLater = monitor([
    incident({
      lastObservedAt: '2026-09-05T00:00:00.000Z',
      signal: {
        kind: 'feedback',
        key: 'PRRC_1',
        revision: 'provider-rev',
        summary: `reviewer-a: ${body}`,
        url: URL,
      },
    }),
  ]);
  const [unchanged] = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(triagedRun),
    triage: [{ runId: 'root', entries: [HUMAN_TRIAGE] }],
    monitors: [observedLater],
    ledger,
  });
  // The short body equals the provider summary, so it is provably current.
  assert.equal(unchanged!.revision, 'provider-rev');
  assert.equal(unchanged!.bodyRevision, sha256(body));
  assert.equal(unchanged!.revisedSinceConsumed, undefined);

  // A long body can only be proven current by the provider, whatever the run timestamps
  // say (a comment may be edited between triage capture and run completion): it
  // re-enters curation rather than risking a silent drop.
  const longBody = `${body} ${'x'.repeat(200)}`;
  const completedLater = makeRun({ ...triagedRun, completedAt: '2026-09-09T00:00:00.000Z' });
  const [unproven] = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(completedLater),
    triage: [{ runId: 'root', entries: [{ ...HUMAN_TRIAGE, body: longBody }] }],
    monitors: [
      monitor([
        incident({
          lastObservedAt: '2026-09-05T00:00:00.000Z',
          signal: {
            kind: 'feedback',
            key: 'PRRC_1',
            revision: 'provider-rev',
            summary: `reviewer-a: ${longBody.slice(0, 180)}`,
            url: URL,
          },
        }),
      ]),
    ],
    ledger: {
      version: 1,
      entries: [
        { ...ledger.entries[0]!, revision: sha256(longBody), bodyRevision: sha256(longBody) },
      ],
    },
  });
  assert.equal(unproven!.bodyRevision, undefined);
  assert.equal(unproven!.revisedSinceConsumed, true);
});

test('a later triage that reopens an edited comment resets the resolution', () => {
  const rootRun = makeRun({
    id: 'root',
    familyId: 'root',
    flowType: 'fix-bug',
    completedAt: '2026-09-01T00:00:00.000Z',
    ticketOrPr: 'MetaMask/metamask-mobile#34865',
  });
  const laterRun = makeRun({
    id: 'later',
    familyId: 'root',
    parentRunId: 'root',
    flowType: 'pr-complete',
    completedAt: '2026-09-05T00:00:00.000Z',
    ticketOrPr: 'MetaMask/metamask-mobile#34865',
  });
  const [candidate] = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(rootRun, laterRun),
    triage: [
      {
        runId: 'later',
        entries: [{ ...HUMAN_TRIAGE, body: 'still broken after the fix', fixed_in_commit: null }],
      },
      { runId: 'root', entries: [{ ...HUMAN_TRIAGE, fixed_in_commit: 'abc123' }] },
    ],
    monitors: [],
    ledger: EMPTY_LEDGER,
  });
  assert.deepEqual(candidate!.resolution, { state: 'open', triage: 'REAL' });
  assert.match(candidate!.excerpt ?? '', /still broken/);
});

test('a triage fix on a comment the reviewer has since rewritten becomes unknown, keeping the commit', () => {
  const fixedTriage = { ...HUMAN_TRIAGE, fixed_in_commit: 'abc123' };
  const rewritten = monitor([
    incident({
      lastObservedAt: '2026-09-05T00:00:00.000Z',
      signal: {
        kind: 'feedback',
        key: 'PRRC_1',
        revision: 'rev-2',
        summary: 'reviewer-a: Still broken after abc123, MAX is ignored.',
        url: URL,
      },
    }),
  ]);
  const [edited] = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(ROOT),
    triage: [{ runId: 'root', entries: [fixedTriage] }],
    monitors: [rewritten],
    ledger: EMPTY_LEDGER,
  });
  assert.deepEqual(edited!.resolution, {
    state: 'unknown',
    triage: 'REAL',
    fixedInCommit: 'abc123',
  });

  const unchanged = monitor([
    incident({
      lastObservedAt: '2026-09-05T00:00:00.000Z',
      signal: {
        kind: 'feedback',
        key: 'PRRC_1',
        revision: 'rev-1',
        summary: `reviewer-a: ${HUMAN_TRIAGE.body}`,
        url: URL,
      },
    }),
  ]);
  const [same] = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(ROOT),
    triage: [{ runId: 'root', entries: [fixedTriage] }],
    monitors: [unchanged],
    ledger: EMPTY_LEDGER,
  });
  assert.equal(same!.resolution.state, 'fixed');
});

test('repair completion is not a per-comment fix, and a later resolution outranks a stale open sighting', () => {
  const [handled] = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(ROOT),
    triage: [],
    monitors: [
      monitor([
        incident({
          handledAt: '2026-09-04T00:00:00.000Z',
          signal: {
            kind: 'feedback',
            key: 'PRRC_1',
            revision: 'rev-1',
            summary: 'reviewer-a: body',
            url: URL,
          },
        }),
      ]),
    ],
    ledger: EMPTY_LEDGER,
  });
  assert.equal(handled!.resolution.state, 'unknown');

  const resolvedLater = monitor([
    incident({
      lastObservedAt: '2026-09-01T00:00:00.000Z',
      resolvedAt: '2026-09-03T00:00:00.000Z',
      signal: {
        kind: 'feedback',
        key: 'PRRC_1',
        revision: 'rev-1',
        summary: 'reviewer-a: body',
        url: URL,
      },
    }),
  ]);
  const staleOpen = monitor([
    incident({
      lastObservedAt: '2026-09-02T00:00:00.000Z',
      signal: {
        kind: 'feedback',
        key: 'PRRC_1',
        revision: 'rev-1',
        summary: 'reviewer-a: body',
        url: URL,
      },
    }),
  ]);
  for (const monitors of [
    [resolvedLater, staleOpen],
    [staleOpen, resolvedLater],
  ]) {
    const [candidate] = buildFeedbackCandidates({
      target: TARGET,
      familyRuns: family(ROOT),
      triage: [],
      monitors,
      ledger: EMPTY_LEDGER,
    });
    assert.equal(candidate!.resolution.state, 'resolved');
  }
});

test('a repair completing after an edit does not resurrect the older revision', () => {
  const original = incident({
    id: 'orig',
    lastObservedAt: '2026-09-01T00:00:00.000Z',
    handledAt: '2026-09-04T00:00:00.000Z',
    signal: {
      kind: 'feedback',
      key: 'PRRC_1',
      revision: 'rev-1',
      summary: 'reviewer-a: original',
      url: URL,
    },
  });
  const edited = incident({
    id: 'edit',
    lastObservedAt: '2026-09-03T00:00:00.000Z',
    signal: {
      kind: 'feedback',
      key: 'PRRC_1',
      revision: 'rev-2',
      summary: 'reviewer-a: edited',
      url: URL,
    },
  });
  const [candidate] = buildFeedbackCandidates({
    target: TARGET,
    familyRuns: family(ROOT),
    triage: [],
    monitors: [monitor([original, edited])],
    ledger: EMPTY_LEDGER,
  });
  assert.equal(candidate!.revision, 'rev-2');
  assert.equal(candidate!.excerpt, 'edited');
  assert.equal(candidate!.resolution.state, 'open', "the older revision's handling does not apply");
});
