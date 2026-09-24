import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  advance,
  blindReviewPacketHash,
  blindReviewRows,
  compareSessions,
  initialPrompt,
  navigationReferenceHash,
  nextPrompt,
  sealPlan,
  startSession,
} from './workflow-navigation.mts';
import type { BlindJudgment, NavigationReference, Session } from './workflow-navigation.mts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const cases = [
  {
    id: 'case-one',
    failure: 'Worker quit after starting the run.',
    sources: [
      { id: 'runner.stderr', title: 'Runner stderr', text: 'exec: command not found: worker' },
      { id: 'slot.health', title: 'Slot health', text: 'healthy' },
    ],
  },
];
const receipt = (id: string, tokens = 10) => ({
  responseId: id,
  receiptHash: hash(id),
  inputTokens: tokens,
  outputTokens: 5,
  costUsd: 0.0001,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  providerDurationMs: 80,
  elapsedMs: 100,
});
const advice = [
  {
    caseId: 'case-one',
    text: 'Inspect runner stderr before choosing a cause.',
    receipt: {
      responseId: 'advice',
      receiptHash: hash('advice'),
      inputTokens: 3,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      providerDurationMs: 80,
      costUsd: 0.0001,
      elapsedMs: 100,
    },
  },
];
const reference: NavigationReference = {
  version: 1,
  status: 'frozen',
  references: [
    {
      caseId: 'case-one',
      label: 'environment',
      requiredReadIds: ['runner.stderr'],
      nextCheck: 'Inspect runner config.',
      family: 'runner-start',
    },
  ],
};
const provenance = {
  advicePlanHash: hash('advice-plan'),
  configHash: hash('advice-config'),
  provider: 'typesafe',
  model: 'jev',
  journalSha256: hash('advice-journal'),
  methodologyHash: hash('advice-method'),
};
const plan = () =>
  sealPlan(
    cases,
    advice,
    { maxTurns: 3, maxReads: 2 },
    {
      referenceHash: navigationReferenceHash(reference),
      adviceProvenance: provenance,
    },
  );
const judgment = (
  sealed: ReturnType<typeof plan>,
  sessions: Session[],
  decision: BlindJudgment['decisions'][number]['decision'] = 'accepted',
): BlindJudgment => ({
  version: 1,
  packetHash: blindReviewPacketHash(sealed, sessions),
  methodologyHash: hash('blind-review-method'),
  reviewer: 'reviewer-one',
  decisions: blindReviewRows(sealed, sessions).map((row) => ({
    blindId: row.blindId,
    decision,
    reason: `Reviewed ${row.blindId}`,
  })),
});

test('provider abstention adds no worker instruction, including after an evidence read', () => {
  const sealed = sealPlan(
    cases,
    [{ ...advice[0], text: null }],
    { maxTurns: 3, maxReads: 2 },
    { referenceHash: navigationReferenceHash(reference), adviceProvenance: provenance },
  );
  assert.equal(
    initialPrompt(sealed, 'case-one', 'assisted'),
    initialPrompt(sealed, 'case-one', 'baseline'),
  );
  const baseline = advance(
    sealed,
    startSession(sealed, 'case-one', 'baseline'),
    { type: 'read_evidence', id: 'runner.stderr' },
    receipt('shared-read'),
  ).session;
  const assisted = advance(
    sealed,
    startSession(sealed, 'case-one', 'assisted'),
    { type: 'read_evidence', id: 'runner.stderr' },
    receipt('shared-read'),
  ).session;
  assert.equal(nextPrompt(sealed, assisted), nextPrompt(sealed, baseline));
});

test('the worker sees a source index but receives evidence text only after a named read', () => {
  const sealed = plan();
  const prompt = initialPrompt(sealed, 'case-one', 'baseline');
  assert(!prompt.includes('command not found'));
  assert(!prompt.includes('advice'));
  assert(initialPrompt(sealed, 'case-one', 'assisted').includes('Inspect runner stderr'));
  const start = startSession(sealed, 'case-one', 'baseline');
  assert(!nextPrompt(sealed, start).includes('command not found'));
  const result = advance(
    sealed,
    start,
    { type: 'read_evidence', id: 'runner.stderr' },
    receipt('read'),
  );
  assert.equal(result.evidence?.text, 'exec: command not found: worker');
  assert(nextPrompt(sealed, result.session).includes('command not found'));
  assert.equal(result.session.status, 'active');
  const done = advance(
    sealed,
    result.session,
    {
      type: 'answer',
      label: 'environment',
      nextCheck: 'inspect runner config',
      evidenceIds: ['runner.stderr'],
    },
    receipt('answer'),
  );
  assert.equal(done.session.status, 'answered');
  assert.throws(
    () =>
      advance(sealed, done.session, { type: 'read_evidence', id: 'slot.health' }, receipt('late')),
    /already ended/,
  );
});

test('extra answer keys are rejected and unknown evidence cannot support an answer', () => {
  assert.throws(
    () =>
      sealPlan(
        [{ ...cases[0], reference: { label: 'environment' } } as never],
        advice,
        { maxTurns: 3, maxReads: 2 },
        { referenceHash: navigationReferenceHash(reference), adviceProvenance: provenance },
      ),
    /Unexpected case field/,
  );
  const sealed = plan();
  const session = startSession(sealed, 'case-one', 'baseline');
  const result = advance(
    sealed,
    session,
    {
      type: 'answer',
      label: 'environment',
      nextCheck: 'inspect config',
      evidenceIds: ['runner.stderr'],
    },
    receipt('unsupported'),
  );
  assert.equal(result.session.status, 'invalid');
  assert.equal(
    compareSessions(sealed, [result.session], reference, judgment(sealed, [result.session]))
      .equalQualityPairs,
    0,
  );
});

test('assisted first-use totals charge advice; absent matched quality cannot claim savings', () => {
  const sealed = plan();
  const run = (arm: 'baseline' | 'assisted', id: string) => {
    const first = advance(
      sealed,
      startSession(sealed, 'case-one', arm),
      { type: 'read_evidence', id: 'runner.stderr' },
      receipt(`${id}-read`),
    );
    return advance(
      sealed,
      first.session,
      {
        type: 'answer',
        label: 'environment',
        nextCheck: 'inspect the configured executable',
        evidenceIds: ['runner.stderr'],
      },
      receipt(`${id}-answer`),
    ).session;
  };
  const baseline = { ...run('baseline', 'base'), wallElapsedMs: 210 };
  const assisted = { ...run('assisted', 'assist'), wallElapsedMs: 220 };
  const blinded = blindReviewRows(sealed, [baseline, assisted]);
  assert(
    blinded.every(
      (row) =>
        !JSON.stringify(row).includes('assisted') &&
        !JSON.stringify(row).includes('Inspect runner stderr') &&
        !Object.keys(row).includes('caseId'),
    ),
  );
  const sessions = [baseline, assisted];
  const quality = judgment(sealed, sessions);
  const comparison = compareSessions(sealed, sessions, reference, quality);
  assert.equal(comparison.equalQualityPairs, 1);
  assert.deepEqual(
    {
      referenceHash: comparison.provenance.referenceHash,
      packetHash: comparison.provenance.packetHash,
      methodologyHash: comparison.provenance.methodologyHash,
      reviewer: comparison.provenance.reviewer,
      advice: comparison.provenance.advice,
    },
    {
      referenceHash: navigationReferenceHash(reference),
      packetHash: blindReviewPacketHash(sealed, sessions),
      methodologyHash: hash('blind-review-method'),
      reviewer: 'reviewer-one',
      advice: provenance,
    },
  );
  assert.match(comparison.provenance.judgmentHash, /^[a-f0-9]{64}$/);
  assert.equal(comparison.pairs[0].recommendation, advice[0].text);
  assert.deepEqual(comparison.pairs[0].baseline.readIds, ['runner.stderr']);
  assert.equal(comparison.pairs[0].assisted.answer?.label, 'environment');
  assert.match(comparison.pairs[0].assisted.judgment!.reason, /^Reviewed /);
  assert.deepEqual(comparison.totals?.tokens, { baseline: 30, assisted: 38 });
  assert.deepEqual(comparison.pairs[0].tokens, { baseline: 30, assisted: 38 });
  assert.deepEqual(comparison.pairs[0].elapsedMs, { baseline: 210, assisted: 320 });
  assert.equal(
    compareSessions(sealed, sessions, reference, judgment(sealed, sessions, 'unresolved'))
      .equalQualityPairs,
    0,
  );
  const rejected = advance(
    sealed,
    startSession(sealed, 'case-one', 'assisted'),
    {
      type: 'answer',
      label: 'environment',
      nextCheck: 'inspect config',
      evidenceIds: ['runner.stderr'],
    },
    receipt('invalid'),
  ).session;
  const rejectedSessions = [baseline, rejected];
  assert.equal(
    compareSessions(sealed, rejectedSessions, reference, judgment(sealed, rejectedSessions))
      .regressions,
    1,
  );
  assert.equal(
    compareSessions(
      sealed,
      [{ ...baseline, wallElapsedMs: undefined }, assisted],
      reference,
      judgment(sealed, [{ ...baseline, wallElapsedMs: undefined }, assisted]),
    ).completeMetricsPairs,
    0,
  );

  assert.throws(
    () =>
      compareSessions(
        sealed,
        [{ ...baseline, elapsedMs: 0 }, assisted],
        reference,
        judgment(sealed, [{ ...baseline, elapsedMs: 0 }, assisted]),
      ),
    /journal replay/,
  );
});

test('reference checks override a false-positive blind acceptance and bind every scoring gate', () => {
  const sealed = plan();
  const run = (arm: 'baseline' | 'assisted', label: 'environment' | 'implementation') => {
    const read = advance(
      sealed,
      startSession(sealed, 'case-one', arm),
      { type: 'read_evidence', id: 'runner.stderr' },
      receipt(`${arm}-${label}-read`),
    );
    return {
      ...advance(
        sealed,
        read.session,
        {
          type: 'answer',
          label,
          nextCheck: 'inspect the configured executable',
          evidenceIds: ['runner.stderr'],
        },
        receipt(`${arm}-${label}-answer`),
      ).session,
      wallElapsedMs: 250,
    };
  };
  const sessions = [run('baseline', 'implementation'), run('assisted', 'environment')];
  const accepted = judgment(sealed, sessions);
  const comparison = compareSessions(sealed, sessions, reference, accepted);
  assert.equal(comparison.pairs[0].quality, 'assisted-better');
  assert.equal(comparison.pairs[0].tokens, null);
  assert.equal(comparison.pairs[0].baseline.quality, 'rejected');
  assert.equal(comparison.pairs[0].baseline.referenceMatch, false);
  assert.equal(comparison.pairs[0].assisted.referenceMatch, true);
  assert.equal(comparison.pairs[0].baseline.judgment?.decision, 'accepted');

  assert.throws(
    () => compareSessions(sealed, sessions, reference, { ...accepted, packetHash: hash('other') }),
    /does not match review packet/,
  );
  assert.throws(
    () =>
      compareSessions(sealed, sessions, reference, {
        ...accepted,
        decisions: accepted.decisions.slice(1),
      }),
    /exactly match/,
  );
  const changedReference: NavigationReference = {
    ...reference,
    references: [{ ...reference.references[0], label: 'implementation' }],
  };
  assert.throws(
    () => compareSessions(sealed, sessions, changedReference, accepted),
    /does not match frozen plan/,
  );
});
