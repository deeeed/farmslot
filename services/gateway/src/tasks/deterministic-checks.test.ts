import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AgentContext, Run } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');

const {
  deterministicChecklistTaskFileForPublication,
  readFrozenWorkerTerminalContractForRun,
  resolveWorkerTerminalContract,
  syncTerminalContractForFlowOnSlot,
  validateDeterministicChecksForRun,
} = await import('./worker-terminal-contract.js');

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
        role: 'review-fix',
        status: 'complete',
        taskFile: '.task/proof/REVIEW-FIX.md',
        completedAt: '2026-01-01T10:00:00Z',
      },
      {
        role: 'review',
        status: 'complete',
        taskFile: '.task/proof/REVIEW.md',
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
  assert.equal(deterministicChecklistTaskFileForPublication(run), '.task/proof/REVIEW-FIX.md');
  run.activeTaskFile = '.task/proof/CI-FIX.md';
  assert.equal(deterministicChecklistTaskFileForPublication(run), run.activeTaskFile);
});

test('a later completed primary worker supersedes an older fix CI receipt', () => {
  const context = (
    role: AgentContext['role'],
    taskFile: string,
    lastSignalAt: string,
  ): AgentContext => ({
    id: role,
    role,
    taskFile,
    lastSignalAt,
    status: 'complete',
    runId: 'run',
    slotId: 'slot',
    label: role,
    runner: 'claude',
    model: 'opus',
    target: null,
    startedAt: lastSignalAt,
    updatedAt: lastSignalAt,
  });
  const run: Parameters<typeof deterministicChecklistTaskFileForPublication>[0] = {
    flowType: 'dev',
    taskFile: '/tasks/proof/TASK.md',
    agentContexts: [
      context('review-fix', '.task/proof/REVIEW-FIX.md', '2026-01-01T10:00:00Z'),
      context('dev', '.task/proof/TASK.md', '2026-01-01T11:00:00Z'),
      context('review', '.task/proof/REVIEW.md', '2026-01-01T12:00:00Z'),
    ],
  };
  assert.equal(deterministicChecklistTaskFileForPublication(run), '.task/proof/TASK.md');
  run.agentContexts![1].status = 'blocked';
  assert.equal(deterministicChecklistTaskFileForPublication(run), '.task/proof/REVIEW-FIX.md');
});

test('role cleanup preserves the entire frozen parent contract byte for byte', async (t) => {
  const { root } = await task(t);
  const contractFile = path.join(root, 'inputs', 'worker-terminal-contract.json');
  const checks = [
    { checklist: 'TASK.md', stepNumber: 1, reference: 'ci.local_check', command: 'printf frozen' },
  ];
  const initialized = JSON.stringify({
    ...resolveWorkerTerminalContract({ acceptance: { require: true } }, 'dev', {
      mode: 'interactive',
      now: '2026-01-01T00:00:00Z',
    }),
    claimReviewGate: true,
    recordedEvidenceContractVersion: 1,
    deterministicChecks: checks,
  });
  await writeFile(contractFile, initialized);
  await writeFile(path.join(root, 'CHECKLIST.md'), '- [ ] Operator plan\n');
  const vars = {
    projectName: 'farmslot-farm',
    remoteRepo: path.dirname(root),
    host: 'localhost',
    machine: 'local',
  } as Parameters<typeof syncTerminalContractForFlowOnSlot>[0];
  await syncTerminalContractForFlowOnSlot(vars, path.basename(root), 'dev', 'interactive');
  assert.equal(await readFile(contractFile, 'utf8'), initialized);
  await writeFile(path.join(root, 'REVIEW-FIX.md'), '- [ ] CI [DETERMINISTIC: ci.local_check]\n');
  await syncTerminalContractForFlowOnSlot(
    vars,
    path.basename(root),
    'dev',
    null,
    undefined,
    'REVIEW-FIX.md',
    [],
    'a'.repeat(40),
  );
  const role = JSON.parse(
    await readFile(path.join(root, 'inputs/worker-terminal-contract.REVIEW-FIX.json'), 'utf8'),
  );
  assert.equal(role.claimReviewGate, true);
  assert.equal(role.recordedEvidenceContractVersion, 1);
  assert.equal(role.flowType, 'dev');
  assert.equal(role.deterministicChecks[0].checklist, 'REVIEW-FIX.md');
  assert.equal(await readFile(contractFile, 'utf8'), initialized);
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'yarn'), '#!/bin/sh\nprintf "%s" "$FARMSLOT_CI_BASE_REF"\n');
  await chmod(path.join(bin, 'yarn'), 0o755);
  const result = spawnSync('bash', ['-c', role.deterministicChecks[0].command], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FARMSLOT_CI_BASE_REF: 'other-base' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'a'.repeat(40));
});

test('every nested role inherits only the frozen parent review authority', async (t) => {
  const { root } = await task(t);
  const contractFile = path.join(root, 'inputs', 'worker-terminal-contract.json');
  const vars = {
    projectName: 'farmslot-farm',
    remoteRepo: path.dirname(root),
    host: 'localhost',
    machine: 'local',
  } as Parameters<typeof syncTerminalContractForFlowOnSlot>[0];
  for (const claimReviewGate of [true, false, undefined]) {
    const parent = JSON.stringify({
      ...resolveWorkerTerminalContract(null, 'dev'),
      claimReviewGate,
      publicationReview: claimReviewGate,
      recordedEvidenceContractVersion: claimReviewGate === undefined ? undefined : 1,
    });
    await writeFile(contractFile, parent);
    for (const role of ['review', 'review-fix', 'ci-fix']) {
      const checklist = `${role.toUpperCase()}.md`;
      await writeFile(path.join(root, checklist), '- [ ] Role work\n');
      await syncTerminalContractForFlowOnSlot(
        vars,
        path.basename(root),
        role,
        undefined,
        'artifacts/role-report.md',
        checklist,
      );
      const scoped = JSON.parse(
        await readFile(
          path.join(root, `inputs/worker-terminal-contract.${role.toUpperCase()}.json`),
          'utf8',
        ),
      );
      assert.equal(scoped.claimReviewGate, claimReviewGate);
      assert.equal(scoped.publicationReview, claimReviewGate);
      assert.equal(
        scoped.recordedEvidenceContractVersion,
        claimReviewGate === undefined ? undefined : 1,
      );
      assert.equal(scoped.flowType, role);
      assert.equal(scoped.commands.complete.report, 'artifacts/role-report.md');
      assert.equal(await readFile(contractFile, 'utf8'), parent);
    }
  }
});

test('retained replay reads only the matching frozen dispatch contract', async (t) => {
  const { root } = await task(t);
  const run = {
    id: 'retained-run',
    project: 'farmslot-farm',
    flowType: 'dev' as const,
    mode: 'autonomous' as const,
    taskFile: path.join(root, 'TASK.md'),
    recordedEvidenceContractVersion: 1,
    steps: [],
  };
  const contractPath = path.join(root, 'inputs/worker-terminal-contract.json');
  const handoffPath = path.join(root, 'inputs/handoff.json');
  const contract = {
    ...resolveWorkerTerminalContract(null, 'dev', { mode: run.mode }),
    claimReviewGate: true,
    recordedEvidenceContractVersion: 1,
  };
  const handoff = { attemptId: run.id, project: run.project, flow: run.flowType };
  await assert.rejects(
    readFrozenWorkerTerminalContractForRun(run),
    /dispatch terminal contract is missing/,
  );
  assert.equal(
    await readFrozenWorkerTerminalContractForRun({ ...run, recordedEvidenceContractVersion: 0 }),
    null,
  );
  await writeFile(contractPath, JSON.stringify(contract));
  await writeFile(handoffPath, JSON.stringify(handoff));
  assert.equal(await readFrozenWorkerTerminalContractForRun(run), JSON.stringify(contract));
  await writeFile(handoffPath, JSON.stringify({ ...handoff, attemptId: 'another-run' }));
  await assert.rejects(readFrozenWorkerTerminalContractForRun(run), /does not belong to this run/);
  await writeFile(handoffPath, JSON.stringify(handoff));
  for (const different of [
    { ...contract, flowType: 'qa' },
    { ...contract, mode: 'interactive' },
    { ...contract, recordedEvidenceContractVersion: 0 },
  ]) {
    await writeFile(contractPath, JSON.stringify(different));
    await assert.rejects(
      readFrozenWorkerTerminalContractForRun(run),
      /does not belong to this run/,
    );
  }
  await writeFile(contractPath, '{broken');
  await assert.rejects(readFrozenWorkerTerminalContractForRun(run), SyntaxError);
  const noGate = JSON.stringify({ ...contract, claimReviewGate: false });
  await writeFile(contractPath, noGate);
  assert.equal(await readFrozenWorkerTerminalContractForRun(run), noGate);
});

test('a removed slot preserves legacy refresh but refuses retained deterministic declarations', async (t) => {
  const { root, run } = await task(t);
  const pool = path.join(root, 'empty-pool');
  await mkdir(pool);
  const script = `
    import assert from 'node:assert/strict';
    import { writeFile } from 'node:fs/promises';
    import { validateDeterministicChecksForRun } from ${JSON.stringify(new URL('./worker-terminal-contract.ts', import.meta.url).href)};
    const run = ${JSON.stringify({ ...run, slotId: 'removed-ci-fixture' })};
    assert.deepEqual(await validateDeterministicChecksForRun(run), []);
    await writeFile(${JSON.stringify(path.join(root, 'inputs/worker-terminal-contract.json'))}, JSON.stringify({ deterministicChecks: [{ checklist: 'CHECKLIST.md', stepNumber: 1, reference: 'ci.local_check', command: 'true' }] }));
    await assert.rejects(validateDeterministicChecksForRun(run), /slot is missing or unavailable/);
    console.log('Removed-slot legacy refresh passes; declared checks fail closed');
  `;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--experimental-test-module-mocks',
      '--import',
      new URL('../runtime/mock-pty.test-support.ts', import.meta.url).href,
      '--input-type=module',
      '-e',
      script,
    ],
    {
      env: { ...process.env, FARMSLOT_POOL_DIR: pool },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /declared checks fail closed/);
});
