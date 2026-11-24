import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runTaskRuntime } from './task-runtime.js';
import {
  alive,
  cliFixture,
  crashingTask,
  killIfPresent,
  until,
} from './task-runtime.test-support.js';

// Bounded by the 5 s node-exec closeout, so it runs outside the default suite:
// yarn test:task-runtime-forced-end-live
test('cancelling a task stops what it runs synchronously', { timeout: 30_000 }, async (t) => {
  const marker = path.join(await realpath(tmpdir()), `task-sync-${process.pid}-${Date.now()}`);
  t.after(() => {
    if (existsSync(marker)) {
      const pid = Number(readFileSync(marker, 'utf8'));
      killIfPresent(pid);
    }
    return rm(marker, { force: true });
  });
  const { root, cli } = await cliFixture(
    t,
    `import { spawnSync } from 'node:child_process';
    export async function runHostedTaskInit() {
      // A synchronous probe the stop message cannot interrupt; only a forced end reaches it.
      spawnSync('/bin/sh', ['-c', 'echo $$ > ${marker}.tmp && mv ${marker}.tmp ${marker} && exec sleep 30'], { stdio: 'ignore' });
      return {};
    }`,
  );
  const controller = new AbortController();
  const pending = runTaskRuntime(
    {
      action: 'init',
      taskPath: path.join(root, 'task.json'),
      supportDir: root,
      env: { FARMSLOT_CLI: path.join(cli, 'bin/farmslot.mjs') },
    },
    root,
    process.env,
    controller.signal,
  );
  assert.ok(await until(() => existsSync(marker), 20_000), 'the probe started');
  const probe = Number(readFileSync(marker, 'utf8'));
  controller.abort();
  assert.equal((await pending).exitCode, 130);
  assert.ok(
    await until(() => !alive(probe), 5000),
    'the synchronous probe is stopped with its task',
  );
});

// Also bounded by the closeout: the group only dies at its SIGKILL.
test(
  'a crashed task’s group that ignores SIGTERM is still killed',
  { timeout: 90_000 },
  async (t) => {
    const { pending, pipe } = await crashingTask(
      t,
      `const child = spawn('/bin/sh', ['-c', 'trap "" TERM; while :; do sleep 1; done'], { stdio: ['ignore', 'ignore', 'ignore', pipe] });`,
    );
    const result = await pending;
    assert.notEqual(result.exitCode, 0);
    // The census runs until the closeout's SIGKILL is due, then kills what is left.
    await pipe.closed();
  },
);
