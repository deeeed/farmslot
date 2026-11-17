// Read-only production proof that every review-fix round of a respawning runner keeps
// its own usage receipt, so the run total counts each fix session.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runId = process.env.FARMSLOT_PI_REVIEW_PROOF_RUN_ID;
assert.ok(runId, 'Set FARMSLOT_PI_REVIEW_PROOF_RUN_ID to a run with review-fix rounds');

const raw = execFileSync(
  process.execPath,
  [
    path.join(root, 'apps/command-center/scripts/cdp.mjs'),
    'gateway',
    'run.get',
    JSON.stringify({ runId }),
  ],
  { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
);
const { run } = JSON.parse(raw);
const runner = run.metrics.runner;
const fix = run.agentContexts.find((entry) => entry.role === 'review-fix');
assert.ok(fix?.reviewFixAttempt, 'The proof run must have at least one review-fix round');
assert.equal(fix.runner, runner, 'Review fix must run on the worker runner');

const reviewRoles = new Set(['review', 'summary']);
const workerReceipts = (run.sessionUsage ?? []).filter(
  (row) =>
    row.runner === runner &&
    row.runnerSessionId &&
    row.identityKind !== 'request' &&
    !(row.roles ?? [row.role]).every((role) => reviewRoles.has(role)),
);
const sessions = new Set(workerReceipts.map((row) => row.runnerSessionId));
// The worker session plus one respawned session per fix round.
const expected = 1 + fix.reviewFixAttempt;
assert.ok(
  sessions.size >= expected,
  `Expected ${expected} ${runner} worker sessions (worker + ${fix.reviewFixAttempt} fix rounds), found ${sessions.size}`,
);
for (const row of workerReceipts) {
  assert.ok(row.totalTokens > 0, `Receipt ${row.runnerSessionId} must carry measured tokens`);
}
const costUsd = workerReceipts.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
console.log(
  JSON.stringify({
    runId,
    runner,
    fixRounds: fix.reviewFixAttempt,
    workerSessions: sessions.size,
    workerCostUsd: Number(costUsd.toFixed(6)),
  }),
);
