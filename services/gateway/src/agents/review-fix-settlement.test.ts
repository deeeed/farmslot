import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { farmslotRoot } from '../fleet/state.js';
import { deleteTestRunIfPresent } from '../run-engine/test-fixtures.js';
import { createRun, getRun, updateRun } from '../runs/store.js';

import { settleFinishedReviewFixContext } from './review-fix-settlement.js';

const ATTEMPT = 'bf04f28a-b448-4127-8c0d-a273712e91d0';
const SIGNAL_FILE = 'temp/tasks/feat/tat-4145/REVIEW-FIX-SIGNAL.json';

/** A local slot whose checkout holds a review-fix signal, and a run whose fix context is working. */
async function runWithFixSignal(t: test.TestContext, signal: Record<string, unknown> | null) {
  const id = `review-fix-settle-${process.pid}-${Date.now()}`;
  const repo = await mkdtemp(path.join(os.tmpdir(), `${id}-`));
  const poolFile = path.join(farmslotRoot, 'pool', `${id}.json`);
  const slotId = `${id}-slot`;
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: 'TAT-4145-LIKE',
    runner: 'claude',
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
    await rm(poolFile, { force: true });
    await rm(repo, { recursive: true, force: true });
  });
  await writeFile(
    poolFile,
    JSON.stringify({
      machine: 'localhost',
      project: 'farmslot-farm',
      platform: 'cli',
      host: 'localhost',
      ssh_user: os.userInfo().username,
      slots: [{ id: slotId, enabled: true, repo, session: slotId }],
    }),
  );
  if (signal) {
    await mkdir(path.join(repo, path.dirname(SIGNAL_FILE)), { recursive: true });
    await writeFile(path.join(repo, SIGNAL_FILE), JSON.stringify(signal));
  }
  updateRun(run.id, {
    slotId,
    agentContexts: [
      {
        id: 'review-fix',
        role: 'review-fix',
        label: 'Review fix',
        status: 'working',
        runner: 'claude',
        model: 'opus',
        signalFile: SIGNAL_FILE,
        signalAttemptId: ATTEMPT,
        runId: run.id,
        slotId,
        updatedAt: '2026-10-20T03:47:35.650Z',
      },
    ],
  });
  return run;
}

const complete = (attemptId: string) => ({
  attemptId,
  step: '8. Signal',
  timestamp: '2026-10-20T03:47:43.386Z',
  status: 'complete',
  outcome: 'success',
  disposition: 'fixed',
});

test('a review-fix context settles from its own attempt read off the slot', async (t) => {
  const run = await runWithFixSignal(t, complete(ATTEMPT));
  assert.equal(await settleFinishedReviewFixContext(run.id), true);
  const context = getRun(run.id)!.agentContexts?.[0];
  assert.equal(context?.status, 'complete');
  assert.equal(context?.lastSignalAt, '2026-10-20T03:47:43.386Z');
});

test('a review-fix context stays working without a terminal signal of its own attempt', async (t) => {
  for (const signal of [
    null,
    complete('another-attempt'),
    { ...complete(ATTEMPT), status: 'running', outcome: undefined },
  ]) {
    const run = await runWithFixSignal(t, signal);
    assert.equal(await settleFinishedReviewFixContext(run.id), false);
    assert.equal(getRun(run.id)!.agentContexts?.[0]?.status, 'working');
  }
});
