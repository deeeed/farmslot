// Opt-in real scripted worker/lease retention through an actual budget stop. No model or live farm.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Run,
  RunGetResult,
  RunExtendReviewBudgetResult,
} from '../../../packages/protocol/src/index.ts';
import { recordedReviewRounds } from '../../../packages/protocol/test/recorded-review-rounds.fixture.ts';
import {
  projectPacks,
  REVIEW_PROJECT,
  SEED,
  slotCli,
  reviewRunParams,
} from '../canary/fixtures.mts';
import { startRemoteNodeStack } from '../lib/remote-node-stack.mts';
import { startReaper, cleanupOnExit, poll, listProcesses } from '../lib/isolated-stack.mts';
assert.equal(process.env.FARMSLOT_REVIEW_BUDGET_WORKER_LIVE, '1');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const evidence = process.env.FARMSLOT_REVIEW_BUDGET_WORKER_OUT;
assert(evidence);
await mkdir(evidence, { recursive: true });
const reaper = startReaper();
let stack: Awaited<ReturnType<typeof startRemoteNodeStack>> | undefined;
const cleanup = cleanupOnExit(async () => {
  if (stack) assert.deepEqual(await stack.cleanup(), []);
  reaper.done();
});
try {
  const slotId = REVIEW_PROJECT + '-1';
  stack = await startRemoteNodeStack({
    root,
    evidence,
    machine: 'proof-node',
    slots: [slotId],
    projects: (holds) => projectPacks(holds).filter((p) => p.name === REVIEW_PROJECT),
    seeds: { [REVIEW_PROJECT]: SEED },
    slotFiles: slotCli(root),
    cliSnapshots: path.join(evidence, 'cli-snapshots'),
    ownerTag: 'review-budget-worker-retention',
    reaper,
    log: async (event, detail) => console.log(event, JSON.stringify(detail ?? {})),
  });
  await writeFile(path.join(stack.holds, 'worker'), 'held');
  await writeFile(path.join(stack.holds, 'idle'), 'keep runner alive');
  const { run } = await stack.call<{ run: Run }>('run.create', {
    ...reviewRunParams(slotId),
    mode: 'interactive',
    devInteractiveProfile: 'reviewed',
    ticketOrPr: 'budget worker retention',
    initialContext: 'Retain the existing scripted worker for the review-budget decision.',
    completionPolicy: undefined,
  });
  await poll(
    'monitoring',
    async () => {
      const r = (await stack!.call<RunGetResult>('run.get', { runId: run.id })).run;
      assert(!['failed', 'cancelled', 'blocked'].includes(r.status), r.error);
      return r.status === 'monitoring' ? r : undefined;
    },
    180000,
  );
  await writeFile(path.join(stack.holds, 'monitoring'), 'observed');
  const before = listProcesses().find(
    (p) =>
      (p.command.split(' ')[0].endsWith('/node') || p.command.split(' ')[0] === 'node') &&
      p.command.includes(stack!.slotRepo(slotId) + '/packages/cli/bin/farmslot.mjs'),
  );
  assert(before, 'the real scripted runner is alive before exhaustion');
  await stack.restartGateway({
    whileDown: async () => {
      const file = path.join(stack!.fixture, 'runs', run.id + '.json');
      const saved = JSON.parse(await readFile(file, 'utf8'));
      Object.assign(
        saved,
        recordedReviewRounds(Array.from({ length: 5 }, (_, i) => `saved-verdict-${i}`)),
      );
      await writeFile(file, JSON.stringify(saved));
    },
  });
  await rm(path.join(stack.holds, 'worker'));
  const held = await poll(
    'budget hold',
    async () => {
      const r = (await stack!.call<RunGetResult>('run.get', { runId: run.id })).run;
      assert(!['failed', 'cancelled', 'blocked', 'done'].includes(r.status), r.error);
      return r.status === 'needs-decision' ? r : undefined;
    },
    180000,
  );
  assert.equal(held.slotId, slotId);
  assert(
    listProcesses().some((p) => p.pid === before.pid && p.command === before.command),
    'same runner process retained through the budget stop',
  );
  const lease = JSON.parse(
    await readFile(path.join(stack.fixture, '.farm-status.json'), 'utf8'),
  ).slots.find((r: { slot: string }) => r.slot === slotId);
  assert.equal(lease.current_run_id, run.id);
  const head = execFileSync('git', ['-C', stack.slotRepo(slotId), 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const grant = await stack.call<RunExtendReviewBudgetResult>('run.extendReviewBudget', {
    runId: run.id,
    requestId: 'held-worker-grant',
    expectedLimit: 5,
    limit: 6,
    headSha: head,
    scopeBrief: 'One review of the recorded fixture change.',
  });
  assert.equal(grant.budget.remaining, 1);
  const after = (await stack.call<RunGetResult>('run.get', { runId: run.id })).run;
  assert.equal(after.status, 'needs-decision');
  assert.equal(after.slotId, slotId);
  assert(listProcesses().some((p) => p.pid === before.pid && p.command === before.command));
  const card = after.decisions.find((d) => d.payload?.kind === 'result-decision' && !d.resolvedAt);
  assert(card?.payload?.kind === 'result-decision');
  await writeFile(
    path.join(evidence, 'receipt.json'),
    JSON.stringify(
      {
        pass: true,
        runId: run.id,
        sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: root,
          encoding: 'utf8',
        }).trim(),
        setup:
          'five historical verdict receipts inserted only while the isolated gateway was stopped',
        slotId,
        workerPid: before.pid,
        workerCommand: before.command,
        status: after.status,
        remaining: grant.budget.remaining,
        lease,
        checkoutHead: head,
        gateId: card.id,
        workerAndLeaseRetained: true,
        noModelCalls: true,
      },
      null,
      2,
    ),
  );
  await stack.call('run.resolveDecision', {
    runId: run.id,
    decisionId: card.id,
    actionId: 'close-result',
  });
  assert.equal((await stack.call<RunGetResult>('run.get', { runId: run.id })).run.status, 'done');
  console.log('PASS worker retained until explicit Close', run.id, before.pid);
} finally {
  await cleanup();
}
