import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
const exec = await import('../core/exec.js');
let taskDir = '';
const declared = {
  checklist: 'CHECKLIST.md',
  stepNumber: 9,
  reference: 'checks.unit',
  command: 'true',
};
let status: 'passed' | 'stale' = 'passed';
let exitCode = 0;
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => ({
      remoteRepo: path.dirname(taskDir),
      host: 'localhost',
      machine: 'local',
      projectName: 'example',
    }),
    loadProjectVars: async () => ({ projectJson: {} }),
    resolveProjectTaskDirName: () => 'task',
    resolveTaskRelDir: () => '',
  },
});
mock.module('../core/exec.js', {
  namedExports: {
    ...exec,
    execOnSlot: async (_vars: unknown, command: string) => {
      assert.ok(command.includes('worker-terminal-contract.cjs'));
      assert.ok(command.includes('deterministicChecks.evaluate'));
      return {
        exitCode,
        stderr: '',
        stdout: JSON.stringify([
          {
            issues: [],
            checks: [
              {
                ...declared,
                status,
                exitCode: 0,
                logPath: 'artifacts/ci.log',
                inputHash: 'frozen',
                message: '',
              },
            ],
          },
        ]),
      };
    },
  },
});
const { validateDeterministicChecksForRun } = await import('./worker-terminal-contract.js');
const { makeRun } = await import('../run-engine/test-fixtures.js');

test('current-checkout CI stays mandatory and independent of an absent follow-up acceptance ledger', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inherited-acceptance-ci-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  taskDir = path.join(root, 'task');
  await mkdir(path.join(taskDir, 'inputs'), { recursive: true });
  await writeFile(
    path.join(taskDir, 'inputs/worker-terminal-contract.json'),
    JSON.stringify({ deterministicChecks: [declared] }),
  );
  const child = makeRun({
    flowType: 'pr-complete',
    slotId: 'fixture',
    taskFile: path.join(taskDir, 'TASK.md'),
  });
  const checks = await validateDeterministicChecksForRun(child);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]!.status, 'passed');
  status = 'stale';
  await assert.rejects(validateDeterministicChecksForRun(child), /no verified receipts/);
  status = 'passed';
  exitCode = 1;
  await assert.rejects(validateDeterministicChecksForRun(child), /Deterministic CI gate blocked/);
});
