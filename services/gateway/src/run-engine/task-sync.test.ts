import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test, type TestContext } from 'node:test';

import { DEFAULT_TASK_DIR } from '@farmslot/protocol';

// mock.module replaces a module wholesale; spreading the real namespaces keeps
// every export the import graph needs and overrides only what this test fixes.
import type { ExecOptions } from '../core/exec.js';
import { fakeSshTools } from '../core/ssh-test-fixtures.js';

const isolated = mkdtempSync(path.join(tmpdir(), 'task-sync-retained-'));
process.env.FARMSLOT_HOME = path.join(isolated, 'home');
process.env.FARMSLOT_RUNS_DIR = path.join(isolated, 'runs');
after(() => rmSync(isolated, { recursive: true, force: true }));

await import('../runtime/mock-pty.test-support.js');
const realConfig = await import('../core/config.js');
const realExec = await import('../core/exec.js');
const realRunStore = await import('../runs/store.js');
const realProjectVars = await import('./project-vars.js');

const tools = fakeSshTools();
after(() => tools.cleanup());

const SSH_TARGET = 'operator@fake-remote.invalid';
const REMOTE_REPO = '/remote/repo';
const taskDir = path.join(tools.root, 'tasks', 'dev', 'T-1');
const taskFile = path.join(taskDir, 'TASK.md');

mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    loadSlotVars: async () => ({
      host: 'fake-remote.invalid',
      machine: 'fake-remote',
      sshTarget: SSH_TARGET,
      remoteRepo: REMOTE_REPO,
    }),
  },
});
mock.module('../core/exec.js', {
  namedExports: {
    ...realExec,
    // Real bash, with ssh/scp/rsync resolving to the recording stand-ins.
    execLocal: (cmd: string, opts?: ExecOptions) =>
      realExec.execLocal(tools.withFakePath(cmd), opts),
  },
});
mock.module('../runs/store.js', {
  namedExports: {
    ...realRunStore,
    getRun: (id: string) =>
      id === 'run-1'
        ? { id, slotId: 'slot-1', project: 'demo', taskFile }
        : realRunStore.getRun(id),
  },
});
mock.module('./project-vars.js', {
  namedExports: { ...realProjectVars, loadProjectVarsOrNull: async () => null },
});

const { copyTaskFilesToSlot } = await import('./task-sync.js');

// mm-harness #384: a host name whose first address never answers (a link-local
// IPv6 one) must not fail the copy. Every remote call bounds its connect and
// never prompts.
test('the remote task-file copy runs every ssh, scp and rsync with ConnectTimeout=10 and BatchMode=yes', async () => {
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(path.join(taskDir, 'mark'), '#!/usr/bin/env bash\n');
  writeFileSync(path.join(taskDir, 'inputs', 'handoff.json'), '{}\n');

  await copyTaskFilesToSlot('run-1');

  const opts = ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes'];
  const workerTaskAbs = `${REMOTE_REPO}/${DEFAULT_TASK_DIR}/dev/T-1`;
  assert.deepEqual(tools.calls(), [
    ['ssh', ...opts, SSH_TARGET, `mkdir -p '${workerTaskAbs}'`],
    ['scp', '-q', ...opts, taskFile, `${SSH_TARGET}:${workerTaskAbs}/TASK.md`],
    [
      'rsync',
      '-az',
      '-e',
      'ssh -o ConnectTimeout=10 -o BatchMode=yes',
      `${taskDir}/inputs/`,
      `${SSH_TARGET}:${workerTaskAbs}/inputs/`,
    ],
    ['ssh', ...opts, SSH_TARGET, `rm -f '${workerTaskAbs}/checklist-target.json'`],
    ['scp', '-q', ...opts, path.join(taskDir, 'mark'), `${SSH_TARGET}:${workerTaskAbs}/mark`],
    ['ssh', ...opts, SSH_TARGET, `chmod 755 '${workerTaskAbs}/mark'`],
  ]);
});

test('a failed input transfer leaves no marker and retry publishes it after task data', async (t) => {
  const rsync = path.join(tools.root, 'bin', 'rsync');
  const original = readFileSync(rsync, 'utf8');
  t.after(() => writeFileSync(rsync, original));
  writeFileSync(rsync, original + '\nexit 12\n');
  const before = tools.calls().length;
  await assert.rejects(copyTaskFilesToSlot('run-1'), /rsync inputs.*failed/);
  const failed = tools.calls().slice(before);
  const copiesMarker = (call: string[]) =>
    call[0] === 'scp' && call.includes(path.join(taskDir, 'mark'));
  assert.equal(failed.some(copiesMarker), false);
  writeFileSync(rsync, original);
  const retryStart = tools.calls().length;
  await copyTaskFilesToSlot('run-1');
  const retry = tools.calls().slice(retryStart);
  assert.ok(retry.findIndex(copiesMarker) > retry.findIndex((call) => call[0] === 'rsync'));
});

// A release removed the worker tree; later review captures retained only generated review files.
// A present marker does not mean the immutable runtime receipt or worker evidence survived.
test('rebind restores retained worker artifacts behind a partial recapture without replacing newer reviews', async (t) => {
  const { captureRunOutput } = await import('../run-completion/output.js');
  const run = realRunStore.createRun({
    flowType: 'dev',
    project: 'demo',
    ticketOrPr: 'RESTORE-1',
    slotId: 'slot-1',
  });
  const dir = path.join(tools.root, 'tasks', 'dev', run.id);
  t.after(async () => {
    realRunStore.updateRun(run.id, { status: 'done' });
    await realRunStore.deleteRun(run.id);
  });
  await mkdir(path.join(dir, 'artifacts/recipe-runs/proof'), { recursive: true });
  await mkdir(path.join(dir, 'inputs'), { recursive: true });
  await writeFile(path.join(dir, 'TASK.md'), '# Original task\n');
  await writeFile(path.join(dir, 'mark'), '#!/usr/bin/env bash\n');
  await writeFile(path.join(dir, 'inputs/handoff.json'), '{"attemptId":"original"}\n');
  await writeFile(path.join(dir, 'artifacts/harness-provenance.json'), '{"pin":"original"}\n');
  await writeFile(path.join(dir, 'artifacts/report.md'), 'Original worker report\n');
  await writeFile(path.join(dir, 'artifacts/recipe-runs/proof/trace.json'), '{"steps":[]}\n');
  await writeFile(path.join(dir, 'artifacts/review-result.current.json'), 'Old review\n');
  realRunStore.updateRun(run.id, { status: 'failed', taskFile: path.join(dir, 'TASK.md') });
  await captureRunOutput(run.id, false, true);
  await rm(path.join(dir, 'artifacts'), { recursive: true });
  await mkdir(path.join(dir, 'artifacts'));
  await writeFile(path.join(dir, 'artifacts/review-result.current.json'), 'New review\n');
  await captureRunOutput(run.id, false, true);
  const beforeSync = tools.calls().length;
  await copyTaskFilesToSlot(run.id, { artifactsOnly: true });
  assert.equal(
    tools
      .calls()
      .slice(beforeSync)
      .some((call) => call[0] === 'scp'),
    false,
    'artifact rebind does not reset task inputs or checklist progress',
  );
  assert.ok(
    tools
      .calls()
      .slice(beforeSync)
      .some(
        (call) =>
          call[0] === 'rsync' &&
          call.includes('--ignore-existing') &&
          call.includes(`${dir}/artifacts/`),
      ),
  );
  assert.equal(
    await readFile(path.join(dir, 'artifacts/harness-provenance.json'), 'utf8'),
    '{"pin":"original"}\n',
  );
  assert.equal(
    await readFile(path.join(dir, 'artifacts/report.md'), 'utf8'),
    'Original worker report\n',
  );
  assert.equal(
    await readFile(path.join(dir, 'artifacts/recipe-runs/proof/trace.json'), 'utf8'),
    '{"steps":[]}\n',
  );
  assert.equal(
    await readFile(path.join(dir, 'artifacts/review-result.current.json'), 'utf8'),
    'New review\n',
  );
});

async function retainedFixture(t: TestContext) {
  const { captureRunOutput } = await import('../run-completion/output.js');
  const run = realRunStore.createRun({
    flowType: 'dev',
    project: 'demo',
    ticketOrPr: 'RESTORE-NEGATIVE',
    slotId: 'slot-1',
  });
  const dir = path.join(tools.root, 'tasks/dev', run.id);
  t.after(async () => {
    realRunStore.updateRun(run.id, { status: 'done' });
    await realRunStore.deleteRun(run.id);
  });
  await mkdir(path.join(dir, 'artifacts'), { recursive: true });
  await mkdir(path.join(dir, 'inputs'));
  await writeFile(path.join(dir, 'TASK.md'), '# Task\n');
  await writeFile(path.join(dir, 'inputs/handoff.json'), '{}\n');
  await writeFile(path.join(dir, 'artifacts/harness-provenance.json'), '{}\n');
  realRunStore.updateRun(run.id, { taskFile: path.join(dir, 'TASK.md'), status: 'failed' });
  await captureRunOutput(run.id, false, true);
  const current = realRunStore.getRun(run.id)!;
  await rm(path.join(dir, 'artifacts'), { recursive: true });
  return { run: current, dir };
}

test('task restoration rejects changed frozen inputs before publishing artifacts', async (t) => {
  const f = await retainedFixture(t);
  await writeFile(path.join(f.dir, 'inputs/handoff.json'), '{"attemptId":"replacement"}\n');
  await assert.rejects(copyTaskFilesToSlot(f.run.id), /Retained task inputs differ/);
  await assert.rejects(readFile(path.join(f.dir, 'artifacts/harness-provenance.json')), /ENOENT/);
});

test('task restoration rejects a redirected artifact directory', async (t) => {
  const f = await retainedFixture(t);
  const outside = path.join(tools.root, `outside-${f.run.id}`);
  await mkdir(outside);
  await symlink(outside, path.join(f.dir, 'artifacts'));
  await assert.rejects(copyTaskFilesToSlot(f.run.id), /artifact directory is redirected/);
  await assert.rejects(readFile(path.join(outside, 'harness-provenance.json')), /ENOENT/);
});

test('task restoration refuses corrupted retained bytes without publishing a receipt', async (t) => {
  const f = await retainedFixture(t);
  const { retainedRunTaskDirectory } = await import('../run-completion/retained-artifacts.js');
  const stored = path.join(
    await retainedRunTaskDirectory(f.run),
    'artifacts/harness-provenance.json',
  );
  await chmod(stored, 0o600);
  await writeFile(stored, '[]\n');
  await assert.rejects(copyTaskFilesToSlot(f.run.id), /Retained artifact bytes changed/);
  await assert.rejects(readFile(path.join(f.dir, 'artifacts/harness-provenance.json')), /ENOENT/);
});
