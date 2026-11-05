import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import { DEFAULT_TASK_DIR } from '@farmslot/protocol';

// mock.module replaces a module wholesale; spreading the real namespaces keeps
// every export the import graph needs and overrides only what this test fixes.
import type { ExecOptions } from '../core/exec.js';
import { fakeSshTools } from '../core/ssh-test-fixtures.js';

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
      id === 'run-1' ? { id, slotId: 'slot-1', project: 'demo', taskFile } : undefined,
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
