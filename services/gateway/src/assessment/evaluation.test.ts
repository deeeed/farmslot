import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AssessmentRecord, AssessmentReport, ResultPackageManifest } from '@farmslot/protocol';

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
