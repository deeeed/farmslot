// Read-only proof of recovery from saved artifacts, without another dispatch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { acceptedReviewStartAt } from './review-report-recovery-start.mjs';

const runId = process.env.FARMSLOT_REVIEW_PROOF_RUN_ID;
const expectedHash = process.env.FARMSLOT_REVIEW_EXPECT_REPORT_SHA256;
assert.ok(runId && expectedHash, 'Provide the recovered run ID and original report hash');
const { run } = JSON.parse(
  execFileSync(
    process.execPath,
    ['apps/command-center/scripts/cdp.mjs', 'gateway', 'run.get', JSON.stringify({ runId })],
    { encoding: 'utf8' },
  ),
);
assert.ok(['blocked', 'done'].includes(run.status));
assert.ok(!run.error);
assert.equal(run.steps.find((step) => step.name === 'monitor')?.outputs?.recovered, true);
assert.equal(createHash('sha256').update(run.reviewResult.reviewMd).digest('hex'), expectedHash);
assert.equal(run.reviewResult.reviewSnapshot.headSha, run.reviewWorkspaceSubject.headSha);
assert.ok(run.reviewWorkspace.cleanedAt);
const gate = run.decisions.find((decision) => decision.type === 'engine_review_posting');
assert.ok(gate);
assert.equal(gate.payload.reviewMd, run.reviewResult.reviewMd);
const acceptedAt = acceptedReviewStartAt(run);
assert.ok(acceptedAt, 'Review worker has no accepted attempt');
assert.ok(
  Date.parse(acceptedAt) < Date.parse(run.steps.find((step) => step.name === 'monitor').startedAt),
);
console.log(
  JSON.stringify({
    pass: true,
    runId,
    status: run.status,
    findings: run.reviewResult.lineComments.length,
    reportUnchanged: true,
    publicationDecision: gate.resolvedAction ?? 'pending',
  }),
);
