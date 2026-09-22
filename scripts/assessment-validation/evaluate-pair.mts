import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type {
  AssessmentReport,
  AssessmentEvaluation,
  ResultPackageManifest,
} from '@farmslot/protocol';
import {
  computePackageHash,
  unavailableDiff,
} from '../../services/gateway/src/evals/package-store.js';
assert.equal(process.env.FARMSLOT_ASSESSMENT_VALIDATION, '1');
assert.ok(process.env.FARMSLOT_GATEWAY);
function rpc<T>(method: string, params: object): T {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['apps/command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(params)],
      { encoding: 'utf8' },
    ),
  );
}
const report = rpc<AssessmentReport>('assessment.report', { id: process.argv[2] });
const pr = report.records[0].subject.pr;
assert.ok(pr);
const packageFor = (assisted: boolean): ResultPackageManifest => {
  const manifest: ResultPackageManifest = {
    version: 1,
    kind: 'result-package',
    packageId: assisted ? 'assisted' : 'baseline',
    packageHash: '',
    status: 'final',
    createdAt: report.createdAt,
    finalizedAt: report.createdAt,
    project: 'synthetic',
    familyId: 'fixture',
    objectiveHash: 'fixture',
    taskProfile: 'fix-bug',
    source: { kind: 'merged-pr', repo: pr.repo, prNumber: pr.number, headSha: pr.headSha },
    runId: assisted ? 'assisted-fixture' : 'baseline-fixture',
    diff: unavailableDiff('synthetic'),
    axes: {
      model: { ref: 'fixture' },
      runner: { ref: 'fixture' },
      review: { ref: 'fixture' },
      ...(assisted ? { assessment: { ref: report.reportId } } : {}),
    },
    visualEvidence: [],
    validationEvidence: [],
    reviewEvidence: [],
    outcomeClaims: [],
    missingData: [],
    metrics: { sessionTotalTokens: assisted ? 50 : 100, durationMs: 1000 },
  };
  manifest.packageHash = computePackageHash(manifest);
  return manifest;
};
const result = rpc<AssessmentEvaluation>('assessment.evaluate', {
  reportId: report.reportId,
  references: [],
  pair: { baseline: packageFor(false), assisted: packageFor(true) },
});
assert.equal(report.summary.uniqueCases, 2, 'Quality separates returned builds');
assert.equal(result.comparison.status, 'comparable', 'Usage compares one requested-model cohort');
assert.equal(result.comparison.assessmentTokensStatus, 'partial');
assert.equal(result.comparison.assessmentAttemptsMissingUsage, 1);
assert.equal(result.comparison.totalTokenDelta, undefined);
console.log(
  JSON.stringify({
    pairedAccounting: 'comparable',
    usage: 'partial',
    qualityCohorts: 2,
    totalSavings: 'unknown',
  }),
);
