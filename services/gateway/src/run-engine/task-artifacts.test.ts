import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import '../runtime/mock-pty.test-support.js';

import { makeVars } from '../runners/test-fixtures.js';
let repo = '';
const config = await import('../core/config.js');
const execution = await import('../core/exec.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => makeVars({ repo, remoteRepo: repo }),
    loadProjectVars: async () => ({ projectJson: { default_branch: 'main' } }),
  },
});
mock.module('../core/exec.js', {
  namedExports: {
    ...execution,
    execOnSlot: async (_vars: unknown, command: string) =>
      execution.execLocal(command, { cwd: repo }),
  },
});
const { getDiffStat } = await import('./task-artifacts.js');
const { captureRunOutput } = await import('../run-completion/output.js');
const { retainedRunTaskDirectory } = await import('../run-completion/retained-artifacts.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { deleteTestRunIfPresent } = await import('./test-fixtures.js');
import { makeRun } from './test-fixtures.js';

test('required completion diff capture refuses unavailable output instead of reporting an empty diff', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'required-output-diff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = makeRun({ slotId: null, taskFile: path.join(dir, 'TASK.md') });
  await assert.rejects(getDiffStat(run, { fresh: true, required: true }), /missing-slot/);
});

test('artifact-only capture retains the real checkout diff before a branch name is recorded', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'branchless-output-diff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  repo = path.join(dir, 'repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(path.join(repo, 'src/value.ts'), 'export const value = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'test: seed');
  const origin = path.join(dir, 'origin.git');
  git('init', '--bare', '-q', origin);
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  git('checkout', '-qb', 'feature/worker-fallback');
  await writeFile(path.join(repo, 'src/value.ts'), 'export const value = 2;\n');
  const taskDir = path.join(dir, 'task');
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(path.join(taskDir, 'artifacts/report.md'), '# Completed output\n');
  const run = createRun({
    flowType: 'dev',
    project: 'generic-project',
    ticketOrPr: 'branchless-output',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, {
    slotId: 'fixture-output',
    branch: null,
    lane: 'comparison',
    completionPolicy: 'artifact-only',
    taskFile: path.join(taskDir, 'TASK.md'),
  });
  assert.deepEqual(await getDiffStat(getRun(run.id)!, { fresh: true, required: true }), {
    files: 1,
    additions: 1,
    deletions: 1,
  });
  await captureRunOutput(run.id, false, true);
  const captured = getRun(run.id)!;
  const retained = await retainedRunTaskDirectory(captured);
  assert.match(
    await readFile(path.join(retained, 'artifacts/diff.txt'), 'utf8'),
    /\+export const value = 2;/,
  );
  const provenance = JSON.parse(
    await readFile(path.join(retained, 'artifacts/diff-stat.json'), 'utf8'),
  );
  assert.equal(provenance.headSha, git('rev-parse', 'HEAD'));
  assert.equal(provenance.headRef, 'HEAD');
  assert.equal(captured.branch, null, 'capturing output does not invent run branch metadata');
});
