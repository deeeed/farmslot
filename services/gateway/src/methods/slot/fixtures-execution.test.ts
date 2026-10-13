import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

import type { ExecOptions, ExecResult } from '../../core/exec.js';
import type { SlotVars } from '../../core/index.js';

import type { PrepareCommandError } from './shared.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'fixture-execution-'));
await mkdir(path.join(root, 'scripts'));
await writeFile(
  path.join(root, 'scripts/sync-fixtures.sh'),
  'printf "fixture args: %s\\n" "$*"; printf "fixture diagnostic\\n" >&2',
);
after(() => rm(root, { recursive: true, force: true }));

const realCore = await import('../../core/index.js');
const calls: Array<{ command: string; options?: ExecOptions }> = [];
let execute = realCore.execLocal;
mock.module('../../core/index.js', {
  namedExports: {
    ...realCore,
    farmslotRoot: root,
    execLocal: (command: string, options?: ExecOptions) => {
      calls.push({ command, options });
      return execute(command, options);
    },
  },
});
// Reproduce the original failure if fixture sync returns to the PTY setup
// path. Never start or inspect a tmux server from this regression.
mock.module('./prepare-command.js', {
  namedExports: {
    runPrepareCommand: async (): Promise<ExecResult> => ({
      stdout: '',
      stderr: 'tmux pipe-pane failed: command timed out after 10000ms',
      exitCode: 124,
    }),
  },
});
const { runFixtureSync, FIXTURE_SYNC_TIMEOUT_ENV_VAR } = await import('./fixtures.js');
beforeEach(() => {
  calls.length = 0;
  execute = realCore.execLocal;
});
const remote = { host: 'node.example', machine: 'node', slotId: 'node-slot' } as SlotVars;
const logPath = path.join(root, 'fixture.log');

for (const [host, timeout] of [
  ['node.example', 180_000],
  ['localhost', 300_000],
] as const) {
  test(`fixture sync for ${host} uses its command backstop without tmux setup`, async () => {
    await runFixtureSync(
      { ...remote, host },
      {
        slotId: remote.slotId,
        logPath,
        flowType: 'dev',
        selectedApp: 'apps/example',
        domain: 'blue',
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options?.timeout, timeout);
    assert.equal(calls[0].options?.cwd, root);
    const log = await readFile(logPath, 'utf8');
    assert.match(
      log,
      /fixture args: --slot node-slot --flow-type dev --app apps\/example --domain blue/,
    );
    assert.match(log, /fixture diagnostic/);
    assert.match(log, /exit: 0/);
  });
}

test('a remote command timeout preserves its actual deadline and failure log', async (t) => {
  const previous = process.env[FIXTURE_SYNC_TIMEOUT_ENV_VAR];
  process.env[FIXTURE_SYNC_TIMEOUT_ENV_VAR] = '45000';
  t.after(() => {
    if (previous === undefined) delete process.env[FIXTURE_SYNC_TIMEOUT_ENV_VAR];
    else process.env[FIXTURE_SYNC_TIMEOUT_ENV_VAR] = previous;
  });
  execute = async () => ({
    stdout: 'transfer started',
    stderr: 'command timed out',
    exitCode: 124,
  });
  await assert.rejects(runFixtureSync(remote, { slotId: remote.slotId, logPath }), (error) => {
    const failure = error as PrepareCommandError;
    assert.match(failure.message, /backstop 45000ms/);
    assert.equal(failure.failedLogPath, logPath);
    assert.equal(failure.failedCommand, calls[0].command);
    return true;
  });
  assert.equal(calls[0].options?.timeout, 45_000);
  assert.match(await readFile(logPath, 'utf8'), /transfer started/);
  assert.match(await readFile(logPath, 'utf8'), /command timed out/);
});

test('remote transfer errors stay failures instead of becoming sync timeouts', async () => {
  execute = async () => ({ stdout: '', stderr: 'scp: connection lost', exitCode: 1 });
  await assert.rejects(
    runFixtureSync(remote, { slotId: remote.slotId, logPath }),
    /failed \(exit 1\)/,
  );
  assert.match(await readFile(logPath, 'utf8'), /scp: connection lost/);
});

test('an already-cancelled remote fixture request never executes the script', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runFixtureSync(remote, { slotId: remote.slotId, logPath, signal: controller.signal }),
    /failed \(exit 130\)/,
  );
  assert.equal(calls[0].options?.signal?.aborted, true);
  assert.match(await readFile(logPath, 'utf8'), /Command cancelled before execution/);
});
