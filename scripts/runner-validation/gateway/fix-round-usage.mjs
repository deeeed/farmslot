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
// reviewer rows do not count for any round.
const measured = (run.sessionUsage ?? []).filter(
  (row) =>
    row.runner === runner &&
    row.runnerSessionId &&
    row.identityKind !== 'request' &&
    row.totalTokens > 0 &&
    Date.parse(row.startedAt) > 0 &&
    !(row.roles ?? [row.role]).every((role) => reviewRoles.has(role)),
);
// Review rounds in admission order: [pipeline, round, admittedAt] -> verdict time.
const rounds = Object.entries(run.reviewRoundSettlements ?? {})
  .map(([key, settlement]) => ({
    admittedAt: Date.parse(JSON.parse(key)[2]),
    settledAt: Date.parse(settlement.at),
  }))
  .sort((a, b) => a.admittedAt - b.admittedAt);
assert.ok(rounds.length > 1, 'The proof run must have a fix round between two reviews');
// Each fix round runs between one verdict and the next admission, so its respawned
// session must start inside that window. CI-fix sessions start after review ends.
const windows = [{ name: 'worker', from: -Infinity, to: rounds[0].admittedAt }];
for (let i = 1; i < rounds.length; i += 1)
  windows.push({ name: `fix round ${i}`, from: rounds[i - 1].settledAt, to: rounds[i].admittedAt });
const covered = windows.map((window) => ({
  ...window,
  receipt: measured.find((row) => {
    const at = Date.parse(row.startedAt);
    return at >= window.from && at < window.to;
  }),
}));
const missing = covered.filter((window) => !window.receipt).map((window) => window.name);
assert.deepEqual(missing, [], `No measured ${runner} session started in: ${missing.join(', ')}`);
const ids = covered.map((window) => window.receipt.runnerSessionId);
assert.equal(new Set(ids).size, ids.length, 'Each round must have its own session');
const costUsd = covered.reduce((sum, window) => sum + (window.receipt.costUsd ?? 0), 0);
console.log(
  JSON.stringify({
    runId,
    runner,
    fixRounds: rounds.length - 1,
    sessions: covered.map((window) => [window.name, window.receipt.runnerSessionId]),
    workerAndFixCostUsd: Number(costUsd.toFixed(6)),
  }),
);
