// Read-only production proof after refreshing a previously stale publication gate.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const runId = process.env.FARMSLOT_PUBLICATION_PROOF_RUN_ID;
assert.ok(runId, 'Set FARMSLOT_PUBLICATION_PROOF_RUN_ID to the recovered run');
const { run } = JSON.parse(
  execFileSync(
    process.execPath,
    [
      path.resolve('apps/command-center/scripts/cdp.mjs'),
      'gateway',
      'run.get',
      JSON.stringify({ runId }),
    ],
    {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        FARMSLOT_RPC_TIMEOUT_MS: process.env.FARMSLOT_RPC_TIMEOUT_MS || '30000',
      },
    },
  ),
);
const gate = run.decisions.find((d) => !d.resolvedAt && d.payload?.kind === 'ready');
assert.ok(gate, 'The publication gate must remain pending for operator approval');
assert.equal(run.engineState.publishGate.publicationStatus, 'not_published');
assert.ok(
  gate.actions.some((a) => a.id === 'approve-publish'),
  'Normal publication must be offered',
);
assert.equal(gate.payload.stale, false);
const summary = gate.payload.gateSummary.review;
assert.ok(summary.passingReviews >= summary.requiredReviews);
const review = run.engineState.publishGate.independentReviews.find(
  (r) => r.source !== 'self-review' && r.verdict === 'pass',
);
assert.ok(review);
assert.equal(review.reviewSnapshot.diffHash, gate.payload.prPackage.reviewSnapshot.diffHash);
assert.equal(review.reviewSnapshot.headSha, gate.payload.prPackage.headSha);
console.log(
  JSON.stringify({
    runId,
    passingReviews: summary.passingReviews,
    requiredReviews: summary.requiredReviews,
    stale: false,
    action: 'approve-publish',
    published: false,
  }),
);
