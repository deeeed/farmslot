import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  type AssessmentRecord,
  type AssessmentReport,
  failureTriageCause,
  type ResultPackageManifest,
} from '@farmslot/protocol';

import { computePackageHash, unavailableDiff } from '../evals/package-store.js';

import { evaluateAssessmentReport } from './evaluation.js';
import { assessmentReport } from './report.js';
import { beginAssessment, finishAssessment } from './store.js';
import { summarizeAssessments } from './summary.js';

const pr = { host: 'github.com', repo: 'example/app', number: 1, headSha: 'a'.repeat(40) };
function row(id = randomUUID()): AssessmentRecord {
  return {
    version: 1,
    id,
    ownerId: 'alice',
    consumer: 'review-intake',
    subject: { pr },
    startedAt: '2026-01-01T00:00:00Z',
    status: 'completed',
    policyVersion: 'v2',
    feedback: [],
    result: {
      status: 'completed',
      provider: 'fake',
      requestedModel: 'fixed',
      questionSchemaHash: 'b'.repeat(64),
      answers: { visualReview: { type: 'boolean', probability: 0.1 } },
    },
    recommendation: {
      assessment: { status: 'completed' },
      route: 'standard-review',
      visualReviewRequired: false,
      reasons: [],
    },
  };
}
function report(records: AssessmentRecord[]): AssessmentReport {
  return {
    version: 1,
    reportId: 'd'.repeat(64),
    createdAt: '2026-01-01T00:00:00Z',
    scope: 'observational',
    records,
    summary: summarizeAssessments(records),
    limitations: [],
  };
}

test('triage history is visible and run snapshots form distinct cases', () => {
  const triage = row();
  triage.consumer = 'failure-triage';
  triage.subject = {
    run: { id: 'r1', project: 'fixture', step: 'validation', snapshotHash: 'a'.repeat(64) },
  };
  delete triage.recommendation;
  triage.result!.answers = {
    cause: {
      type: 'choice',
      choice: 'implementation',
      probabilities: { implementation: 1, unclear: 0 },
    },
  };
  const repeated = { ...triage, id: randomUUID(), startedAt: '2026-01-02T00:00:00Z' };
  const changed = {
    ...triage,
    id: randomUUID(),
    subject: { run: { ...triage.subject.run!, snapshotHash: 'b'.repeat(64) } },
  };
  const summary = summarizeAssessments([row(), triage, repeated, changed]);
  assert.equal(summary.calls, 4);
  assert.equal(summary.uniqueCases, 3);
  assert.deepEqual(
    new Set(summary.groups.map((g) => g.consumer)),
    new Set(['review-intake', 'failure-triage']),
  );
  const result = evaluateAssessmentReport(report([triage]), {
    reportId: 'd'.repeat(64),
    references: [
      {
        assessmentId: triage.id,
        questionId: 'cause',
        expected: 'implementation',
        evidenceRef: 'fixture:controlled-fault',
        source: 'human',
        blinded: true,
      },
    ],
  });
  assert.equal(result.questions[0].correct, 1);
  assert.equal(result.questions[0].abstained, 0);
  assert.equal(result.comparison.status, 'inconclusive');
});
test('predictions are deduplicated before feedback; repeated answers cannot borrow labels', () => {
  const first = row(),
    repeated = { ...row(), startedAt: '2026-01-02T00:00:00Z' };
  repeated.feedback = [
    {
      revision: 1,
      recordedAt: '2026-01-03T00:00:00Z',
      questionId: 'visualReview',
      verdict: 'correct',
      adviceUsed: false,
      adviceShown: true,
      evidenceRef: 'fixture:ref',
    },
  ];
  const s = summarizeAssessments([repeated, first]);
  assert.equal(s.calls, 2);
  assert.equal(s.uniqueCases, 1);
  assert.equal(s.correctQuestions, 0);
  assert.equal(s.unlabeledQuestions, 1);
});
test('scoring reports visual false negatives, missing labels, abstention and separate model cohorts', () => {
  const first = row(),
    second = row();
  second.startedAt = '2026-01-02T00:00:00Z';
  second.result!.requestedModel = 'other';
  second.recommendation!.route = 'needs-review';
  const r = report([first, second]);
  const references = [
    {
      assessmentId: first.id,
      questionId: 'visualReview',
      expected: true,
      blinded: true,
      source: 'human' as const,
      evidenceRef: 'fixture:reference',
    },
  ];
  const result = evaluateAssessmentReport(r, { reportId: r.reportId, references });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.questions.length, 2);
  assert.equal(result.questions[0].falseNegatives, 1);
  assert.equal(result.questions[1].unlabeled, 1);
  assert.equal(result.questions[0].eligible, 1);
  assert.ok(result.questions[0].interval95);
  references.push({ ...references[0], assessmentId: second.id });
  assert.equal(
    evaluateAssessmentReport(r, { reportId: r.reportId, references }).questions[1].abstained,
    1,
  );
  assert.equal(result.comparison.status, 'inconclusive');
  assert.throws(
    () =>
      evaluateAssessmentReport(r, {
        reportId: r.reportId,
        references: [...references, references[0]],
      }),
    /Duplicate/,
  );
});
test('unrelated or same-session packages cannot establish a comparison', () => {
  const r = report([row()]);
  const makePackage = (packageId: string): ResultPackageManifest => {
    const p: ResultPackageManifest = {
      version: 1,
      kind: 'result-package',
      packageId,
      packageHash: '',
      status: 'final',
      createdAt: r.createdAt,
      finalizedAt: r.createdAt,
      project: 'example',
      familyId: 'family',
      objectiveHash: 'objective',
      taskProfile: 'fix-bug',
      source: { kind: 'merged-pr', repo: pr.repo, prNumber: pr.number, headSha: pr.headSha },
      runId: 'same',
      diff: unavailableDiff('fixture'),
      axes: { model: { ref: 'strong' }, runner: { ref: 'reviewer' }, review: { ref: 'medium' } },
      visualEvidence: [],
      validationEvidence: [],
      reviewEvidence: [],
      outcomeClaims: [],
      missingData: [],
      metrics: { sessionTotalTokens: 100, durationMs: 1000 },
    };
    p.packageHash = computePackageHash(p);
    return p;
  };
  const baseline = makePackage('baseline'),
    assisted = makePackage('assisted');
  assisted.axes.assessment = { ref: r.reportId };
  assisted.packageHash = computePackageHash(assisted);
  assert.equal(
    evaluateAssessmentReport(r, {
      reportId: r.reportId,
      references: [],
      pair: { baseline, assisted },
    }).comparison.status,
    'inconclusive',
  );
  assisted.runId = 'distinct';
  assisted.packageHash = computePackageHash(assisted);
  assert.equal(
    evaluateAssessmentReport(r, {
      reportId: r.reportId,
      references: [],
      pair: { baseline, assisted },
    }).comparison.status,
    'comparable',
  );
  assisted.axes.assessment.ref = 'unrelated';
  assisted.packageHash = computePackageHash(assisted);
  assert.equal(
    evaluateAssessmentReport(r, {
      reportId: r.reportId,
      references: [],
      pair: { baseline, assisted },
    }).comparison.status,
    'inconclusive',
  );
});
test('reports are immutable and owner scoped; altered content is rejected', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'assessment-report-')),
    old = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = home;
  t.after(async () => {
    if (old === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = old;
    await rm(home, { recursive: true, force: true });
  });
  const record = await beginAssessment({
    ownerId: 'alice',
    consumer: 'review-intake',
    subject: { pr },
  });
  await finishAssessment(record, { status: 'disabled' });
  const frozen = await assessmentReport('alice');
  assert.deepEqual(await assessmentReport('alice', frozen.reportId), frozen);
  await assert.rejects(assessmentReport('bob', frozen.reportId), /ENOENT/);
  const { createHash } = await import('node:crypto');
  const file = path.join(
    home,
    'assessment-reports',
    createHash('sha256').update('alice').digest('hex'),
    `${frozen.reportId}.json`,
  );
  const content = JSON.parse(await readFile(file, 'utf8'));
  content.summary.calls++;
  await writeFile(file, JSON.stringify(content));
  await assert.rejects(assessmentReport('alice', frozen.reportId), /changed/);
});

test('unlabeled abstentions and rejected references keep distinct denominators', () => {
  const record = row();
  record.recommendation!.route = 'needs-review';
  const frozen = report([record]);
  const empty = evaluateAssessmentReport(frozen, { reportId: frozen.reportId, references: [] });
  assert.equal(empty.questions[0].abstained, 1);
  assert.equal(empty.questions[0].unlabeled, 1);
  const rejected = evaluateAssessmentReport(frozen, {
    reportId: frozen.reportId,
    references: [
      {
        assessmentId: record.id,
        questionId: 'visualReview',
        expected: true,
        blinded: false,
        evidenceRef: 'fixture:unblinded',
        source: 'human',
      },
    ],
  });
  assert.equal(rejected.rejectedReferences, 1);
  assert.equal(rejected.unusedReferences, 0);
  assert.equal(rejected.excluded, 0);
  assert.equal(rejected.unsupportedQuestions, 0);
});

test('owner can freeze a single case after assessing other PRs without borrowing their usage', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'assessment-select-')),
    old = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = home;
  t.after(async () => {
    if (old === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = old;
    await rm(home, { recursive: true, force: true });
  });
  const ids: string[] = [];
  for (const number of [1, 2, 1]) {
    const fixture = row();
    const record = await beginAssessment({
      ownerId: 'alice',
      consumer: 'review-intake',
      subject: { pr: { ...pr, number } },
    });
    ids.push(record.id);
    await finishAssessment(
      record,
      {
        ...fixture.result!,
        requestedModel: 'alias',
        returnedModel: ids.length === 3 ? 'fixed-v2' : 'fixed',
        usage: {
          provider: 'fake',
          requestedModel: 'alias',
          durationMs: 1,
          inputTokens: number === 2 ? 1000 : 10,
          outputTokens: 1,
        },
      },
      fixture.recommendation,
    );
  }
  const all = await assessmentReport('alice');
  assert.equal(all.records.length, 3);
  const selected = await assessmentReport('alice', undefined, ids[0]);
  assert.equal(selected.records.length, 2);
  assert.equal(selected.summary.tokens, 22);
  assert.equal(selected.summary.uniqueCases, 2);
  assert.ok(selected.records.every((r) => r.subject.pr?.number === 1));
  assert.deepEqual(await assessmentReport('alice', selected.reportId), selected);
  await assert.rejects(assessmentReport('bob', undefined, ids[0]), /not found/);
  const packageFor = (assisted: boolean, reportId = selected.reportId): ResultPackageManifest => {
    const p: ResultPackageManifest = {
      version: 1,
      kind: 'result-package',
      packageId: assisted ? 'assisted' : 'baseline',
      packageHash: '',
      status: 'final',
      createdAt: all.createdAt,
      finalizedAt: all.createdAt,
      project: 'example',
      familyId: 'family',
      objectiveHash: 'objective',
      taskProfile: 'fix-bug',
      source: { kind: 'merged-pr', repo: pr.repo, prNumber: pr.number, headSha: pr.headSha },
      runId: assisted ? 'run-a' : 'run-b',
      diff: unavailableDiff('fixture'),
      axes: {
        model: { ref: 'fixed' },
        runner: { ref: 'reviewer' },
        review: { ref: 'medium' },
        ...(assisted ? { assessment: { ref: reportId } } : {}),
      },
      visualEvidence: [],
      validationEvidence: [],
      reviewEvidence: [],
      outcomeClaims: [],
      missingData: [],
      metrics: { sessionTotalTokens: assisted ? 50 : 100, durationMs: 1000 },
    };
    p.packageHash = computePackageHash(p);
    return p;
  };
  const evaluation = evaluateAssessmentReport(selected, {
    reportId: selected.reportId,
    references: [],
    pair: { baseline: packageFor(false), assisted: packageFor(true) },
  });
  assert.equal(evaluation.comparison.status, 'comparable');
  assert.equal(evaluation.comparison.assessmentTokens, 22);
  assert.equal(evaluation.comparison.totalTokenDelta, -28);
  assert.equal(evaluation.comparison.assessmentTokensStatus, 'complete');
  for (const model of ['alias', 'unrelated']) {
    const failed = await beginAssessment({
      ownerId: 'alice',
      consumer: 'review-intake',
      subject: { pr },
      requestedIdentity: { provider: 'fake', model, questionSchemaHash: 'b'.repeat(64) },
    });
    await finishAssessment(failed, {
      status: 'unavailable',
      provider: 'fake',
      requestedModel: model,
      questionSchemaHash: 'b'.repeat(64),
    });
  }
  const partial = await assessmentReport('alice', undefined, ids[0]);
  assert.equal(partial.records.length, 3);
  assert.equal(partial.summary.callsWithUsage, 2);
  assert.ok(
    partial.records.some((r) => r.status === 'unavailable' && r.result?.requestedModel === 'alias'),
  );
  assert.ok(
    partial.records.every(
      (r) => r.subject.pr?.number === 1 && r.result?.requestedModel === 'alias',
    ),
  );
  const incomplete = evaluateAssessmentReport(partial, {
    reportId: partial.reportId,
    references: [],
    pair: {
      baseline: packageFor(false, partial.reportId),
      assisted: packageFor(true, partial.reportId),
    },
  });
  assert.equal(incomplete.comparison.status, 'comparable');
  assert.equal(incomplete.comparison.assessmentTokensStatus, 'partial');
  assert.equal(incomplete.comparison.assessmentAttemptsMissingUsage, 1);
  assert.equal(incomplete.comparison.totalTokenDelta, undefined);
  assert.match(incomplete.comparison.reason, /usage is incomplete/);
});

test('triage cause display requires matched evidence in both clients', () => {
  const r = row();
  r.consumer = 'failure-triage';
  r.subject = {
    run: {
      id: 'r1',
      project: 'fixture',
      step: 'validation',
      snapshotHash: 'a'.repeat(64),
      sources: [{ id: 'e1', sourceId: 'log1', digest: 'b'.repeat(64) }],
    },
  };
  r.result!.answers = {
    cause: { type: 'choice', choice: 'environment', probabilities: { environment: 1 } },
    evidence: { type: 'choice', choice: 'e2', probabilities: { e2: 1 } },
  };
  assert.equal(failureTriageCause(r), undefined);
  r.result!.answers.evidence = { type: 'choice', choice: 'e1', probabilities: { e1: 1 } };
  assert.equal(failureTriageCause(r), 'environment');
  r.status = 'unavailable';
  assert.equal(failureTriageCause(r), undefined);
});

test('legacy cost amounts are not relabeled as provider-reported', () => {
  const legacy = row(),
    estimated = row(),
    reported = row();
  legacy.result!.usage = {
    provider: 'fake',
    requestedModel: 'fixed',
    durationMs: 1,
    costUsd: 0.01,
  };
  estimated.result!.usage = {
    provider: 'fake',
    requestedModel: 'fixed',
    durationMs: 1,
    costUsd: 0.02,
    costKind: 'estimated',
  };
  reported.result!.usage = {
    provider: 'fake',
    requestedModel: 'fixed',
    durationMs: 1,
    costUsd: 0.03,
    costKind: 'reported',
  };
  const result = summarizeAssessments([legacy, estimated, reported]);
  assert.equal(result.knownReportedUsd, 0.03);
  assert.equal(result.knownEstimatedUsd, 0.02);
  assert.equal(result.knownUnclassifiedUsd, 0.01);
});

test('plain LLM booleans and choices are scored without inventing probabilities', () => {
  const plain = row();
  plain.result!.answers = {
    visualReview: { type: 'boolean', value: true },
    risk: { type: 'choice', choice: 'high', choices: ['low', 'high'] },
  };
  const saved = report([plain]);
  const evaluated = evaluateAssessmentReport(saved, {
    reportId: saved.reportId,
    references: [
      {
        assessmentId: plain.id,
        questionId: 'visualReview',
        expected: false,
        evidenceRef: 'fixture:known-no-visual-change',
        source: 'human',
        blinded: true,
      },
      {
        assessmentId: plain.id,
        questionId: 'risk',
        expected: 'low',
        evidenceRef: 'fixture:known-low-risk',
        source: 'human',
        blinded: true,
      },
    ],
  });
  const visual = evaluated.questions.find((q) => q.questionId === 'visualReview')!;
  assert.equal(visual.falsePositives, 1);
  assert.equal(visual.correct, 0);
  assert.equal(visual.judged, 1);
  assert.equal(evaluated.questions.find((q) => q.questionId === 'risk')?.judged, 1);
});

test('decision advice counts an admitted action and a deliberate abstention separately', () => {
  const accepted = row();
  accepted.consumer = 'decision-advice';
  accepted.subject = {
    run: {
      id: 'synthetic-run-1',
      project: 'fixture',
      step: 'decision-advice',
      snapshotHash: 'e'.repeat(64),
    },
  };
  delete accepted.recommendation;
  accepted.result!.answers = {
    action: { type: 'choice', choice: 'prepare', probabilities: { prepare: 1, abstain: 0 } },
  };
  const abstained = {
    ...accepted,
    id: randomUUID(),
    subject: { run: { ...accepted.subject.run!, id: 'synthetic-run-2' } },
    result: {
      ...accepted.result!,
      answers: {
        action: {
          type: 'choice' as const,
          choice: 'abstain',
          probabilities: { prepare: 0, abstain: 1 },
        },
      },
    },
  };
  const frozen = report([accepted, abstained]);
  assert.equal(frozen.summary.calls, 2);
  assert.equal(frozen.summary.uniqueCases, 2);
  const result = evaluateAssessmentReport(frozen, {
    reportId: frozen.reportId,
    references: [
      {
        assessmentId: accepted.id,
        questionId: 'action',
        expected: 'prepare',
        evidenceRef: 'fixture:case-1',
        source: 'human',
        blinded: true,
      },
      {
        assessmentId: abstained.id,
        questionId: 'action',
        expected: 'prepare',
        evidenceRef: 'fixture:case-2',
        source: 'human',
        blinded: true,
      },
    ],
  });
  assert.equal(result.questions[0].eligible, 2);
  assert.equal(result.questions[0].judged, 2);
  assert.equal(result.questions[0].abstained, 1);
  assert.equal(result.questions[0].correct, 1);
  assert.equal(result.comparison.status, 'inconclusive');
});

test('decision advice counts a reserved paid-output attempt with missing usage as unknown charge', () => {
  const advice = row();
  advice.consumer = 'decision-advice';
  advice.subject = {
    run: {
      id: 'synthetic-unknown-usage',
      project: 'fixture',
      step: 'decision-advice',
      snapshotHash: 'c'.repeat(64),
    },
  };
  delete advice.recommendation;
  advice.result!.answers = {
    action: { type: 'choice', choice: 'prepare', probabilities: { prepare: 1, abstain: 0 } },
  };
  advice.result!.attempted = true;
  advice.result!.usage = {
    provider: 'fixture',
    requestedModel: 'paid-output',
    inputTokens: 80,
    durationMs: 5,
  };
  advice.reservation = { key: 'd'.repeat(64), priceHash: 'e'.repeat(64), maxUsd: 0.01 };
  const summary = summarizeAssessments([advice]);
  assert.equal(summary.calls, 1);
  assert.equal(summary.attemptedCalls, 1);
  assert.equal(summary.unknownCharges, 1);
  assert.equal(summary.reservedUsd, 0.01);
  assert.equal(summary.knownEstimatedUsd, 0);
});

test('decision advice scores labeled abstentions without counting missing references', () => {
  const make = (choice: string, hash: string) => {
    const record = row();
    record.consumer = 'decision-advice';
    record.subject = {
      run: { id: hash, project: 'fixture', step: 'decision-advice', snapshotHash: hash.repeat(64) },
    };
    delete record.recommendation;
    record.result!.answers = {
      action: { type: 'choice', choice, probabilities: { continue: 0.5, abstain: 0.5 } },
    };
    return record;
  };
  const correctAbstain = make('abstain', 'a');
  const falseAbstain = make('abstain', 'b');
  const mistakenAction = make('continue', 'c');
  const missing = make('abstain', 'd');
  const result = evaluateAssessmentReport(
    report([correctAbstain, falseAbstain, mistakenAction, missing]),
    {
      reportId: 'd'.repeat(64),
      references: [
        {
          assessmentId: correctAbstain.id,
          questionId: 'action',
          expected: 'abstain',
          source: 'human',
          blinded: true,
          evidenceRef: 'synthetic:unknown',
        },
        {
          assessmentId: falseAbstain.id,
          questionId: 'action',
          expected: 'continue',
          source: 'human',
          blinded: true,
          evidenceRef: 'synthetic:clear',
        },
        {
          assessmentId: mistakenAction.id,
          questionId: 'action',
          expected: 'abstain',
          source: 'human',
          blinded: true,
          evidenceRef: 'synthetic:unknown',
        },
      ],
    },
  );
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].eligible, 4);
  assert.equal(result.questions[0].abstained, 3);
  assert.equal(result.questions[0].judged, 3);
  assert.equal(result.questions[0].correct, 1);
  assert.equal(result.questions[0].unlabeled, 1);
});
