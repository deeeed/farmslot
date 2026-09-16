import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { PRMonitorIncident } from '@farmslot/protocol';

import { makeRun, writeArtifact } from '../family-observability/test-fixtures.js';
import {
  refreshRetrospectiveFeedback,
  setFeedbackMonitorSource,
} from '../intelligence/feedback-candidates.js';

import { buildRetrospectivePayload, readCommentsTriageEntries } from './retrospective.js';

const TRIAGE = [
  {
    comment_id: 3916065775,
    author_login: 'reviewer-a',
    author_type: 'User',
    source_kind: 'human',
    review_state: 'CHANGES_REQUESTED',
    path: 'app/components/UI/Perps/hooks/usePerpsOrderForm.ts',
    body: 'Late defaults overwrite what the user typed.',
    triage: 'REAL',
    fixed_in_commit: null,
  },
  {
    comment_id: 44,
    author_login: 'cursor[bot]',
    author_type: 'Bot',
    source_kind: 'bugbot',
    triage: 'REAL',
    fixed_in_commit: 'deadbeef',
  },
];

test('retrospective payload carries deduplicated feedback candidates from triage and PR monitor evidence', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'retro-feedback-'));
  const ledgerDir = await mkdtemp(path.join(os.tmpdir(), 'retro-feedback-ledger-'));
  process.env.FARMSLOT_FEEDBACK_LEDGER = path.join(ledgerDir, 'ledger.json');
  const taskDir = path.join(base, 'task');
  await writeArtifact(taskDir, 'TASK.md', '# task');
  await writeArtifact(taskDir, 'artifacts/comments-triage.json', JSON.stringify(TRIAGE));
  await writeArtifact(taskDir, 'artifacts/learnings.md', '- reviewer caught a late default');
  const run = makeRun({
    id: 'retro-feedback-run',
    familyId: 'retro-feedback-run',
    flowType: 'pr-complete',
    project: 'example-mobile-farm',
    ticketOrPr: 'MetaMask/metamask-mobile#34865',
    taskFile: path.join(taskDir, 'TASK.md'),
  });
  const monitorIncident: PRMonitorIncident = {
    id: 'inc-1',
    signal: {
      kind: 'feedback',
      key: 'PRRC_1',
      revision: 'provider-rev-1',
      summary: 'reviewer-a: Late defaults overwrite what the user typed.',
      url: 'https://github.com/MetaMask/metamask-mobile/pull/34865#discussion_r3916065775',
      reviewedCommit: 'a93b2a48b007b9f4ca0c0d4b3fb8b8ea66cf4b08',
    },
    firstObservedAt: '2026-09-01T00:00:00.000Z',
    lastObservedAt: '2026-09-02T00:00:00.000Z',
    attemptCount: 0,
  };
  setFeedbackMonitorSource(() => [
    {
      config: {
        pr: { host: 'github.com', repo: 'MetaMask/metamask-mobile', number: 34865 },
      } as never,
      incidents: [monitorIncident],
      observation: { headSha: 'ffffffffffffffffffffffffffffffffffffffff' } as never,
      originatingRunIds: [],
    },
  ]);
  t.after(() => {
    setFeedbackMonitorSource(null);
    delete process.env.FARMSLOT_FEEDBACK_LEDGER;
  });

  assert.equal((await readCommentsTriageEntries(taskDir))?.length, 2);
  const payload = await buildRetrospectivePayload(run, null, 'success', { familyRuns: [run] });
  assert.equal(payload.feedbackCandidates?.length, 2);
  assert.deepEqual(payload.feedbackSummary, {
    total: 2,
    human: 1,
    bot: 1,
    unknown: 0,
    consumed: 0,
    open: 1,
  });
  const human = payload.feedbackCandidates!.find((c) => c.authorKind === 'human')!;
  assert.equal(
    human.sourceKey,
    'github.com/metamask/metamask-mobile#34865:review-comment:3916065775',
  );
  assert.deepEqual(human.sources, ['comments-triage', 'pr-monitor']);
  assert.equal(human.revision, 'provider-rev-1');
  assert.equal(human.reviewedCommit, 'a93b2a48b007b9f4ca0c0d4b3fb8b8ea66cf4b08');
  assert.equal(human.observedHead, 'ffffffffffffffffffffffffffffffffffffffff');
  assert.equal(human.attribution.kind, 'follow-up-only');
  assert.deepEqual(human.runIds, ['retro-feedback-run']);

  // A stored payload is rebuilt from current evidence: an edit observed after it
  // was persisted supersedes the frozen snapshot.
  setFeedbackMonitorSource(() => [
    {
      config: {
        pr: { host: 'github.com', repo: 'MetaMask/metamask-mobile', number: 34865 },
      } as never,
      incidents: [
        {
          ...monitorIncident,
          lastObservedAt: '2026-09-06T00:00:00.000Z',
          signal: {
            ...monitorIncident.signal,
            revision: 'provider-rev-2',
            summary: 'reviewer-a: edited',
          },
        },
      ],
      observation: { headSha: 'ffffffffffffffffffffffffffffffffffffffff' } as never,
      originatingRunIds: [],
    },
  ]);
  const rebuilt = await refreshRetrospectiveFeedback(payload, run);
  assert.equal(
    rebuilt.feedbackCandidates!.find((c) => c.authorKind === 'human')!.revision,
    'provider-rev-2',
  );

  // A payload persisted before feedback capture existed is backfilled from the run.
  const legacy = await refreshRetrospectiveFeedback(
    { kind: 'retrospective', outcome: 'success', whatThisIs: 'legacy', actionEffects: [] },
    run,
  );
  assert.equal(legacy.feedbackCandidates?.length, 2);
  assert.equal(legacy.feedbackSummary?.human, 1);

  // Building the payload again (a repeated scan) yields the same identities.
  const again = await buildRetrospectivePayload(run, null, 'success', { familyRuns: [run] });
  assert.deepEqual(
    again.feedbackCandidates!.map((c) => c.id),
    payload.feedbackCandidates!.map((c) => c.id),
  );
});

test('runs without a PR carry no feedback candidates', async () => {
  const payload = await buildRetrospectivePayload(
    makeRun({ id: 'no-pr', ticketOrPr: 'TAT-1', project: 'example-mobile-farm' }),
    null,
    'success',
    { familyRuns: [] },
  );
  assert.equal(payload.feedbackCandidates, undefined);
  assert.equal(payload.feedbackSummary, undefined);
});
