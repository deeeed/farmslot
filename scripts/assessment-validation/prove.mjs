// Run against the isolated gateway after seed.mts and again after gateway restart.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
assert.equal(process.env.FARMSLOT_ASSESSMENT_VALIDATION, '1');
assert.ok(process.env.FARMSLOT_GATEWAY, 'Select the isolated gateway explicitly');
function rpc(method, params = {}) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['apps/command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(params)],
      { encoding: 'utf8' },
    ),
  );
}
let history = rpc('assessment.list');
const records = [...history.records];
while (history.nextCursor) {
  history = rpc('assessment.list', { before: history.nextCursor });
  records.push(...history.records);
}
const rows = records.filter((r) => r.subject.pr?.repo === 'example/assessment-fixture');
for (const state of ['completed', 'disabled', 'skipped', 'unavailable', 'interrupted'])
  assert.ok(
    rows.some((r) => r.status === state),
    `Missing ${state}`,
  );
const completed = rows.find((r) => r.status === 'completed');
assert.equal(completed.recommendation.route, 'needs-review');
assert.equal(completed.result.answers.visualReview.probability, 0.53);
const updated = rpc('assessment.feedback', {
  id: completed.id,
  expectedRevision: completed.feedback.length,
  questionId: 'visualReview',
  verdict: 'incorrect',
  adviceUsed: false,
  adviceShown: true,
  correctedAnswer: true,
  evidenceRef: 'fixture:rendered-ui',
});
assert.equal(updated.feedback.at(-1).correctedAnswer, true);
assert.equal(rpc('assessment.get', { id: completed.id }).feedback.length, updated.feedback.length);
const summary = rpc('assessment.summary');
assert.ok(summary.calls >= 5);
assert.equal(summary.savings, null);
const report = rpc('assessment.report');
assert.deepEqual(rpc('assessment.report', { id: report.reportId }), report);
const evaluation = rpc('assessment.evaluate', { reportId: report.reportId, references: [] });
assert.equal(evaluation.status, 'inconclusive');
assert.equal(evaluation.comparison.status, 'inconclusive');
assert.ok(evaluation.questions.some((q) => q.unlabeled > 0));
console.log(
  JSON.stringify({
    recordId: completed.id,
    reportId: report.reportId,
    feedbackRevision: updated.feedback.length,
    states: [...new Set(rows.map((r) => r.status))],
    comparison: evaluation.comparison.status,
  }),
);
