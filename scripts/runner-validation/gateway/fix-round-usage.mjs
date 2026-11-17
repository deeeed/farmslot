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
// Measured worker-runner receipts. Unavailable rows (a respawn that never answered) and
// reviewer rows count for nothing.
const measured = (run.sessionUsage ?? []).filter(
  (row) =>
    row.runner === runner &&
    row.runnerSessionId &&
    row.identityKind !== 'request' &&
    row.totalTokens > 0 &&
    !(row.roles ?? [row.role]).every((role) => reviewRoles.has(role)),
);
const has = (row, contextId) => (row.contextIds ?? []).includes(contextId);
const worker = run.agentContexts.find((entry) => entry.role === 'dev');
assert.ok(worker, 'The proof run must have a dev worker context');
// The worker's own session is bound to the worker context only. On the broken path the
// review fix adopted it, so its receipt carries the review-fix context for good.
// A CI-fix session is bound to the worker context too, so "alone" means no other context.
const workerOnly = measured.filter(
  (row) => (row.contextIds ?? []).length > 0 && row.contextIds.every((id) => id === worker.id),
);
assert.ok(workerOnly.length > 0, `No measured ${runner} receipt for the worker session alone`);
// Each respawned fix session is bound to the review-fix context. CI-fix sessions carry
// their own context, and a session recovered at slot release carries none.
const fixSessions = measured.filter((row) => has(row, fix.id));
assert.ok(
  fixSessions.length >= fix.reviewFixAttempt,
  `Expected ${fix.reviewFixAttempt} measured ${runner} review-fix sessions, found ${fixSessions.length}`,
);
const counted = [...workerOnly, ...fixSessions];
const costUsd = counted.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
console.log(
  JSON.stringify({
    runId,
    runner,
    fixRounds: fix.reviewFixAttempt,
    workerSessions: workerOnly.map((row) => row.runnerSessionId),
    fixSessions: fixSessions.map((row) => row.runnerSessionId),
    workerAndFixCostUsd: Number(costUsd.toFixed(6)),
  }),
);
