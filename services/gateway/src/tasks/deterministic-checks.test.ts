import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  deterministicChecklistTaskFileForPublication,
  syncTerminalContractForFlowOnSlot,
  validateDeterministicChecksForRun,
} from './worker-terminal-contract.js';

async function task(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ci-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'inputs'));
  return { root, run: { taskFile: path.join(root, 'TASK.md'), slotId: null } as Run };
}

test('a declared check cannot reach package preparation without its frozen contract', async (t) => {
  const { root, run } = await task(t);
  await writeFile(path.join(root, 'CHECKLIST.md'), '- [x] CI [DETERMINISTIC: ci.local_check]\n');
  await assert.rejects(validateDeterministicChecksForRun(run), /no frozen task contract/);
});

test('a frozen check cannot be silently accepted after the checkout is lost', async (t) => {
  const { root, run } = await task(t);
  await writeFile(
    path.join(root, 'inputs', 'worker-terminal-contract.json'),
    JSON.stringify({
      deterministicChecks: [
        { checklist: 'CHECKLIST.md', stepNumber: 1, reference: 'ci.local_check', command: 'true' },
      ],
    }),
  );
  await assert.rejects(validateDeterministicChecksForRun(run), /slot is missing/);
});

test('legacy tasks without declarations retain their package behavior', async (t) => {
  const { root, run } = await task(t);
  await writeFile(path.join(root, 'CHECKLIST.md'), '- [x] Complete\n');
  assert.deepEqual(await validateDeterministicChecksForRun(run), []);
});

test('publication uses the last completed source-fix checklist after role cleanup', () => {
  const run = {
    taskFile: '/tasks/proof/TASK.md',
    activeTaskFile: null,
    agentContexts: [
      {
        role: 'self-review-fix',
        status: 'complete',
        taskFile: '.task/proof/SELF-REVIEW-FIX.md',
        completedAt: '2026-01-01T10:00:00Z',
      },
      {
        role: 'self-review',
        status: 'complete',
        taskFile: '.task/proof/SELF-REVIEW.md',
        completedAt: '2026-01-01T11:00:00Z',
      },
      {
        role: 'ci-fix',
        status: 'failed',
        taskFile: '.task/proof/CI-FIX.md',
        completedAt: '2026-01-01T12:00:00Z',
      },
    ],
  } as unknown as Run;
  assert.equal(deterministicChecklistTaskFileForPublication(run), '.task/proof/SELF-REVIEW-FIX.md');
  run.activeTaskFile = '.task/proof/CI-FIX.md';
  assert.equal(deterministicChecklistTaskFileForPublication(run), run.activeTaskFile);
});

test('restoring an interactive parent preserves its initialized TASK.md command', async (t) => {
  const { root } = await task(t);
  const contractFile = path.join(root, 'inputs', 'worker-terminal-contract.json');
  const checks = [
    { checklist: 'TASK.md', stepNumber: 1, reference: 'ci.local_check', command: 'printf frozen' },
  ];
  await writeFile(contractFile, JSON.stringify({ deterministicChecks: checks }));
  await writeFile(path.join(root, 'CHECKLIST.md'), '- [ ] Operator plan\n');
  const vars = {
    projectName: 'farmslot-farm',
    remoteRepo: path.dirname(root),
    host: 'localhost',
    machine: 'local',
  } as Parameters<typeof syncTerminalContractForFlowOnSlot>[0];
  await syncTerminalContractForFlowOnSlot(vars, path.basename(root), 'dev', 'interactive');
  const { readFile } = await import('node:fs/promises');
  assert.deepEqual(JSON.parse(await readFile(contractFile, 'utf8')).deterministicChecks, checks);
  await writeFile(
    path.join(root, 'SELF-REVIEW-FIX.md'),
    '- [ ] CI [DETERMINISTIC: ci.local_check]\n',
  );
  await syncTerminalContractForFlowOnSlot(
    vars,
    path.basename(root),
    'dev',
    null,
    undefined,
    'SELF-REVIEW-FIX.md',
  );
  const role = JSON.parse(
    await readFile(path.join(root, 'inputs/worker-terminal-contract.SELF-REVIEW-FIX.json'), 'utf8'),
  );
  assert.equal(role.deterministicChecks[0].checklist, 'SELF-REVIEW-FIX.md');
  assert.equal(role.deterministicChecks[0].command, 'yarn ci:local');
});
