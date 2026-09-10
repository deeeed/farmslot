import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import {
  reviewResultForRun,
  type PRReviewRequestResult,
  type Run,
} from '../packages/protocol/src/index.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
assert(
  process.env.REVIEW_REQUEST_ID,
  'Supply REVIEW_REQUEST_ID for an existing completed worker request',
);
const connection = await new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 120_000,
}).connect();
try {
  const receipt = await connection.call<PRReviewRequestResult>('prReview.get', {
    id: process.env.REVIEW_REQUEST_ID,
  });
  assert(receipt.intent?.runId, 'Request must have its actual assigned run');
  const { run } = await connection.call<{ run: Run }>('run.get', { runId: receipt.intent.runId });
  assert.equal(run.status, 'done');
  assert.equal(run.completionPolicy, 'artifact-only');
  assert.equal(
    receipt.intent.status,
    'completed',
    receipt.intent.waitingReason ?? 'Request must reflect completed review evidence',
  );
  const result = reviewResultForRun(run);
  assert(result?.reviewMd.trim(), 'Worker report must be retained');
  assert(result.reviewSnapshot?.headSha, 'Actual reviewed commit must be retained');
  assert.equal(receipt.intent.reviewedSha, result.reviewSnapshot.headSha);
  const dispatchedAt = run.steps.find((step) => step.name === 'dispatch')?.startedAt;
  assert(
    dispatchedAt && Date.parse(result.reviewSnapshot.capturedAt) <= Date.parse(dispatchedAt),
    'Result must use the pre-dispatch snapshot',
  );
  assert(
    result.artifactManifest?.some((ref) => ref.path === 'artifacts/review.md'),
    'Report must be copied to operator artifacts',
  );
  assert(
    !run.decisions.some((decision) => decision.payload?.kind === 'review'),
    'Completion must not manufacture a publication decision',
  );
  console.log(
    JSON.stringify({
      passed: true,
      runId: run.id,
      reviewedSha: receipt.intent.reviewedSha,
      verdict: result.recommendation,
      findings: result.lineComments.length,
      publicationDecision: false,
    }),
  );
} finally {
  connection.close();
}
