import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { mock, test, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';

import { parse as shellParse } from 'shell-quote';

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
let status: 'passed' | 'stale' | 'failed' = 'passed';
let exitCode = 0;
let realCheck = false;
const require = createRequire(import.meta.url);
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
      if (realCheck) {
        const [node, mode, script, ...args] = shellParse(command);
        assert.equal(node, 'node');
        assert.equal(mode, '-e');
        assert.equal(typeof script, 'string');
        let stdout = '';
        const execution = {
          argv: [node, ...args],
          exitCode: 0,
          stdout: {
            write: (data: string) => {
              stdout += data;
            },
          },
        };
        try {
          runInNewContext(String(script), { require, process: execution });
          return { exitCode: execution.exitCode, stderr: '', stdout };
        } catch (failure) {
          return { exitCode: 1, stderr: String(failure), stdout };
        }
      }
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
const { DeterministicGateBlockedError, validateDeterministicChecksForRun } =
  await import('./worker-terminal-contract.js');
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

// 961d55d3 (TAT-4769): a stale receipt failed the run. The refusal names each check
// the worker owes, so COMPLETE can send it back to rerun that one mark.
test('a refused receipt names its checklist step, status and command', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'refused-receipt-ci-'));
  t.after(async () => {
    status = 'passed';
    exitCode = 0;
    await rm(root, { recursive: true, force: true });
  });
  taskDir = path.join(root, 'task');
  await mkdir(path.join(taskDir, 'inputs'), { recursive: true });
  await writeFile(
    path.join(taskDir, 'inputs/worker-terminal-contract.json'),
    JSON.stringify({ deterministicChecks: [declared] }),
  );
  const run = makeRun({
    flowType: 'fix-bug',
    slotId: 'fixture',
    taskFile: path.join(taskDir, 'TASK.md'),
  });
  const stale = {
    code: 'deterministic-stale',
    prerequisite: 'deterministic',
    reference: 'checks.unit',
    message:
      'CHECKLIST.md step 9 (checks.unit) is stale. Rerun step 9 (`true`) to record a current receipt.',
    actionId: 'hold',
  };
  status = 'stale';
  // Exit 0 with a non-passing check, and exit 1 with its issue (the 961d55d3 shape).
  for (const code of [0, 1]) {
    exitCode = code;
    await assert.rejects(validateDeterministicChecksForRun(run), (error: unknown) => {
      assert.ok(error instanceof DeterministicGateBlockedError);
      assert.match(error.message, /^Deterministic CI gate blocked/);
      assert.deepEqual(error.reasons, [stale]);
      return true;
    });
  }
  // A failed check is not a mark to rerun: it holds for a person.
  status = 'failed';
  await assert.rejects(validateDeterministicChecksForRun(run), (error: unknown) => {
    assert.ok(error instanceof DeterministicGateBlockedError);
    assert.deepEqual(
      error.reasons.map((reason) => reason.code),
      ['deterministic-failed'],
    );
    return true;
  });
});

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(root: string, message: string) {
  git(root, 'add', 'source.txt');
  git(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    message,
  );
}

async function noChangeRun(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'no-change-slot-ci-'));
  t.after(async () => {
    realCheck = false;
    await rm(root, { recursive: true, force: true });
  });
  taskDir = path.join(root, 'task');
  git(root, 'init', '-q');
  await writeFile(path.join(root, 'source.txt'), 'main already has the fix\n');
  commit(root, 'main');
  const preWorkBaseSha = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'source.txt'), 'the redispatch includes the fix\n');
  commit(root, 'redispatch');
  const base = git(root, 'rev-parse', 'HEAD');
  await mkdir(path.join(taskDir, 'inputs'), { recursive: true });
  await writeFile(
    path.join(taskDir, 'CHECKLIST.md'),
    '- [x] Read the report\n- [ ] Reproduce\n- [ ] Trace\n- [ ] Fix\n' +
      '- [ ] Changed-file CI [DETERMINISTIC: ci.local_check]\n',
  );
  await writeFile(
    path.join(taskDir, 'inputs/worker-terminal-contract.json'),
    JSON.stringify({
      deterministicChecks: [{ ...declared, reference: 'ci.local_check', stepNumber: 5 }],
    }),
  );
  const run = makeRun({
    flowType: 'fix-bug',
    slotId: 'fixture',
    taskFile: path.join(taskDir, 'TASK.md'),
    preWorkBaseSha,
    worktreeHeadAtDispatch: base,
  });
  realCheck = true;
  return {
    root,
    run: { ...run, metrics: { ...run.metrics, disposition: 'already_fixed' as const } },
  };
}

test('a clean checkout can report an already-fixed bug without marking changed-file CI', async (t) => {
  const { run } = await noChangeRun(t);
  const checks = await validateDeterministicChecksForRun(run);
  assert.deepEqual(
    checks.map(({ reference, status }) => [reference, status]),
    [['ci.local_check', 'missing']],
  );
  await assert.rejects(
    validateDeterministicChecksForRun({
      ...run,
      metrics: { ...run.metrics, disposition: undefined },
    }),
    /Deterministic CI gate blocked/,
  );
});

test('no-change cannot waive the check after an uncommitted source edit', async (t) => {
  const { root, run } = await noChangeRun(t);
  await writeFile(path.join(root, 'source.txt'), 'worker edit\n');
  await assert.rejects(validateDeterministicChecksForRun(run), /No-change.*uncommitted/);
});

test('a committed change also refuses the no-change waiver', async (t) => {
  const { root, run } = await noChangeRun(t);
  await writeFile(path.join(root, 'source.txt'), 'worker edit\n');
  commit(root, 'worker edit');
  await assert.rejects(validateDeterministicChecksForRun(run), /No-change.*HEAD/);
});
