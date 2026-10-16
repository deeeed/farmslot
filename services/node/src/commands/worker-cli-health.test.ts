import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readWorkerCliHealth } from './worker-cli-health.js';

test('worker verification health preserves failure, accepts recovery and fails closed on invalid bytes', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'worker-cli-health-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'node-worker-cli-health.json');
  assert.equal(await readWorkerCliHealth(home), undefined);
  const failure = {
    ok: false,
    checkedAt: new Date().toISOString(),
    reason: 'tmux server unresponsive on fixture',
  };
  await writeFile(file, JSON.stringify(failure));
  assert.deepEqual(await readWorkerCliHealth(home), failure);
  await writeFile(file, JSON.stringify({ ok: true, checkedAt: failure.checkedAt }));
  assert.equal((await readWorkerCliHealth(home))?.ok, true);
  await writeFile(file, '{invalid');
  const invalid = await readWorkerCliHealth(home);
  assert.equal(invalid?.ok, false);
  assert.match(invalid?.reason ?? '', /unreadable or invalid/);
  assert(!invalid?.reason?.includes('{invalid'));
});
