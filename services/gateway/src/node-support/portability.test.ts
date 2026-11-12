import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { validatePackPortability } from '@farmslot/protocol/node/pack-portability';

import { farmslotRoot } from '../core/config.js';
import { validateProjectPackPortability } from '../host-services/pack-portability.js';

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

/** Puts a `git` running this shell body first on PATH, for both scan drivers, until the test ends. */
async function fakeGit(t: TestContext, body: string): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-git-'));
  await writeFile(path.join(dir, 'git'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  t.after(async () => {
    process.env.PATH = saved;
    await rm(dir, { recursive: true, force: true });
  });
}

test('git output over 1 MiB across stdout and stderr is refused by both scan drivers', async (t) => {
  // Each stream stays under 1 MiB; together they overrun what spawnSync buffers.
  await fakeGit(
    t,
    "head -c 600000 /dev/zero | tr '\\0' a\nhead -c 600000 /dev/zero | tr '\\0' b >&2",
  );
  const pack = await mkdtemp(path.join(tmpdir(), 'pack-overrun-'));
  t.after(() => rm(pack, { recursive: true, force: true }));
  assert.throws(() => validatePackPortability(pack), /Cannot list pack-owned files/);
  await assert.rejects(
    validateProjectPackPortability(pack, 'projects/p', []),
    /Cannot list pack-owned files/,
  );
});

test("gateway pack sync surfaces the primary pack's failure before a support pack's", async (t) => {
  const name = `portability-primary-${process.pid}-farm`;
  const missing = `portability-missing-${process.pid}-farm`;
  const root = path.join(farmslotRoot(), 'projects', name);
  await mkdir(path.join(root, 'templates'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'templates/task.md'), 'Run {{slot_id}}\n');
  await chmod(path.join(root, 'templates/task.md'), 0o000);
  // The primary pack's git calls are slow and its file unreadable; the support pack is missing,
  // and its scan fails sooner.
  const realGit = childProcess.execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  await fakeGit(t, `case "$*" in *${name}*) sleep 0.3 ;; esac\nexec ${realGit} "$@"`);
  await assert.rejects(
    collectNodeSupportBundle(name, [`projects/${missing}/project.json`]),
    new RegExp(`EACCES.*${name}/templates/task.md`),
  );
});
