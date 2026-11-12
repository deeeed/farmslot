import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { farmslotRoot } from '../core/config.js';

import { collectNodeSupportBundle } from './ensure.js';

test('gateway pack sync rejects nonportable templates even when only config is bundled', async (t) => {
  const name = `portability-test-${process.pid}-farm`;
  const root = path.join(farmslotRoot(), 'projects', name);
  await mkdir(path.join(root, 'templates'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'project.json'),
    JSON.stringify({
      qa: {
        default_profile: 'smoke',
        profiles: [{ id: 'smoke', title: 'Smoke', template_id: 'qa/default' }],
      },
    }),
  );
  await writeFile(path.join(root, 'templates/task.md'), 'Run checks\nssh macwork.local\n');
  await assert.rejects(
    collectNodeSupportBundle(name, [`projects/${name}/project.json`]),
    new RegExp(`projects/${name}/templates/task.md:2:.*pool/slot`),
  );
  await assert.rejects(collectNodeSupportBundle(name, []), /templates\/task.md:2:/);
  await writeFile(path.join(root, 'templates/task.md'), 'Run {{slot_id}} checks using {{repo}}');
  assert.equal(
    (await collectNodeSupportBundle(name, [`projects/${name}/project.json`])).files.length,
    1,
  );
});

test('gateway pack sync runs its git ownership scan off the event loop', async (t) => {
  const name = `portability-async-${process.pid}-farm`;
  const root = path.join(farmslotRoot(), 'projects', name);
  await mkdir(path.join(root, 'templates'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'templates/task.md'), 'ssh macwork.local\n');
  const blocking: string[][] = [];
  const spawnSync = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', (...args: Parameters<typeof spawnSync>) => {
    if (args[0] === 'git') blocking.push([...(Array.isArray(args[1]) ? args[1] : [])]);
    return spawnSync(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  // The scan still reads the pack's files and refuses the nonportable one.
  await assert.rejects(collectNodeSupportBundle(name, []), /templates\/task.md:1:.*pool\/slot/);
  assert.deepEqual(blocking, [], 'no git call blocks the event loop');
});

test('gateway pack sync requires QA even when config is not in the support bundle', async (t) => {
  const name = `qa-test-${process.pid}-farm`;
  const root = path.join(farmslotRoot(), 'projects', name);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'project.json'), '{}');
  await assert.rejects(
    collectNodeSupportBundle(name, []),
    new RegExp(`projects/${name}/project.json:1: missing required qa flow`),
  );
});
