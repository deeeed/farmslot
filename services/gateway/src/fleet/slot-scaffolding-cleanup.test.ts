import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import { runnerRuntimeDir } from '../../../../scripts/lib/runner-runtime.cjs';
import type { SlotVars } from '../core/config.js';

// The slot side becomes unreachable after the main archive downloaded: deleting the staging
// directory fails, which used to skip removing the unfinished archive on the gateway (F310).
const staging: string[] = [];
const realSlotIo = await import('../core/slot-io.js');
mock.module('../core/slot-io.js', {
  namedExports: {
    ...realSlotIo,
    slotDeletePath: async (vars: SlotVars, target: string) => {
      if (/\/tmp\.[^/]+$/.test(target)) {
        staging.push(target);
        throw new Error('No node connected for machine fixture-node');
      }
      return realSlotIo.slotDeletePath(vars, target);
    },
  },
});
await import('../runtime/mock-pty.test-support.js');
const { archiveSlotScaffolding } = await import('./slot-scaffolding.js');

test('an unfinished archive is removed even when the slot cannot delete its staging copy', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'slot-scaffolding-cleanup-'));
  t.after(() => {
    for (const dir of [...staging, root]) rmSync(dir, { recursive: true, force: true });
  });
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, '.task/qa/example'), { recursive: true });
  writeFileSync(path.join(repo, '.task/qa/example/TASK.md'), 'completed task');
  // Runner observations that cannot be packed fail the collection after the download.
  const observations = path.join(runnerRuntimeDir(repo), '.observability');
  mkdirSync(observations, { recursive: true });
  writeFileSync(path.join(observations, 'unreadable.jsonl'), 'observations');
  chmodSync(path.join(observations, 'unreadable.jsonl'), 0o000);
  const destination = path.join(root, 'run-archive');
  const vars = {
    slotId: 'fixture-slot',
    host: 'localhost',
    machine: 'fixture-node',
    sshTarget: '',
    remoteRepo: repo,
  } as SlotVars;
  await assert.rejects(
    archiveSlotScaffolding(
      vars,
      {},
      { destination, taskRelativeDir: 'qa/example', beforeRemove: async () => undefined },
    ),
    /No node connected|Cannot pack runner observations/,
  );
  assert.equal(staging.length, 1, 'the staging delete was attempted');
  assert.deepEqual(existsSync(destination) ? readdirSync(destination) : [], []);
});
