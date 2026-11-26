import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  retainTaskExecution,
  verifyTaskExecutionProvenance,
} from '../../../../packages/agent-runtime/src/task-init/execution-provenance.js';
import { taskInputDigest } from '../../../../packages/agent-runtime/src/task-init/pin.js';
import { makeRun } from '../methods/run/test-fixtures.js';
import {
  readTaskPins,
  shareTaskPins,
  stageTaskPins,
  sweepContentStore,
  sweepTaskPins,
} from '../runs/task-pins.cjs';

import {
  NODE_PIN_RETENTION_DEPS,
  nodeTaskPinRetentionPass,
  taskPinProtection,
} from './node-task-pins.js';

const HOUR = 60 * 60 * 1000;
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const objectsOf = (root: string) => path.join(root, '.content', 'sha256');

async function storeEntries(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const shard of await readdir(objectsOf(root)).catch(() => []))
    for (const name of await readdir(path.join(objectsOf(root), shard)))
      found.push(path.join(objectsOf(root), shard, name));
  return found;
}

/** Two real pins written by the task producer from one installed CLI with shared and own files. */
async function realPins(t: test.TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'task-pin-store-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = path.join(home, 'farm');
  t.after(async () => {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    await chmodTree(home);
    await rm(home, { recursive: true, force: true });
  });
  const distributionRoot = path.join(home, 'installed');
  const executable = path.join(distributionRoot, 'bin', 'farmslot.mjs');
  await mkdir(path.join(distributionRoot, 'node_modules', 'dep'), { recursive: true });
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, '#!/usr/bin/env node\nconsole.log("1.0.0");\n');
  await chmod(executable, 0o755);
  await writeFile(
    path.join(distributionRoot, 'package.json'),
    JSON.stringify({ name: '@farmslot/cli', version: '1.0.0' }),
  );
  await writeFile(path.join(distributionRoot, 'node_modules', 'dep', 'index.js'), 'x'.repeat(9000));
  const provider = path.join(home, 'provider');
  await mkdir(provider);
  await writeFile(path.join(provider, 'action.mjs'), 'export default 1;\n');
  const input = {
    executable,
    packageRoot: distributionRoot,
    distributionRoot,
    bindingIdentity: null,
    inputs: [provider],
  };
  const tasks = [path.join(home, 'tasks', 'a'), path.join(home, 'tasks', 'b')];
  const receipts = tasks.map((task) => retainTaskExecution(task, input));
  const root = path.dirname(receipts[0]!.pin);
  return { home, root, tasks, receipts };
}

/** Restore owner write bits so the fixture's own cleanup can remove read-only store files. */
async function chmodTree(dir: string): Promise<void> {
  for (const name of await readdir(dir).catch(() => [])) {
    const file = path.join(dir, name);
    const info = await lstat(file);
    if (info.isDirectory()) await chmodTree(file);
    else if (info.isFile()) await chmod(file, info.mode | 0o200);
  }
}

function verifiesExactly(task: string, receipt: ReturnType<typeof retainTaskExecution>) {
  assert.deepEqual(verifyTaskExecutionProvenance(task, null), receipt);
  // The executed entry and the package tree still hash to the receipt's recorded bytes.
  assert.equal(sha256(receipt.resolvedExecutable), receipt.entrySha256);
  assert.equal(taskInputDigest(receipt.retainedInputs[0]!.path), receipt.retainedInputs[0]!.sha256);
}

/** Raw pin directories with a provenance record and a small cli/ tree, for bound checks. */
async function rawPins(t: test.TestContext, count: number) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'task-pin-store-raw-'));
  t.after(async () => {
    await chmodTree(home);
    await rm(home, { recursive: true, force: true });
  });
  const root = path.join(home, 'pins');
  for (let i = 0; i < count; i++) {
    const pin = path.join(root, `pin-${String(i).padStart(2, '0')}`);
    await mkdir(path.join(pin, 'cli'), { recursive: true });
    await writeFile(
      path.join(pin, 'provenance.json'),
      JSON.stringify({ taskDir: `${home}/t/${i}` }),
    );
    await writeFile(path.join(pin, 'cli', 'shared.js'), 'shared bytes');
  }
  return { home, root };
}

test('two real pins share identical files through one read-only entry and verify byte-exactly', async (t) => {
  const { root, tasks, receipts } = await realPins(t);
  const result = await shareTaskPins({ root, limit: 8 });
  assert.deepEqual(result.pins.sort(), receipts.map((r) => path.basename(r.pin)).sort());
  assert.deepEqual(result.unverified, []);
  assert.ok(result.shared > 0 && result.inserted > 0);
  for (const receipt of receipts) {
    const dep = path.join(receipt.pin, 'cli', 'node_modules', 'dep', 'index.js');
    const info = lstatSync(dep);
    assert.equal(info.nlink, 3, 'pin a, pin b and the store entry');
    assert.equal(info.mode & 0o222, 0, 'shared bytes are read-only');
    const entry = lstatSync(path.join(receipt.pin, 'cli', 'bin', 'farmslot.mjs'));
    assert.equal(entry.mode & 0o111, 0o111, 'exec bits survive');
  }
  receipts.forEach((receipt, i) => verifiesExactly(tasks[i]!, receipt));
  // A second pass has nothing left to share.
  assert.deepEqual((await shareTaskPins({ root, limit: 8 })).pins, []);
});

test('purging one pin never breaks another pin sharing its entries', async (t) => {
  const { root, tasks, receipts } = await realPins(t);
  await shareTaskPins({ root, limit: 8 });
  const owner = makeRun({ status: 'done', taskFile: path.join(tasks[0]!, 'TASK.md') });
  const removed = await sweepTaskPins({
    root,
    now: Date.now() + 30 * 24 * HOUR,
    ageMs: 0,
    ...taskPinProtection({ held: [], released: [owner] }),
  });
  assert.deepEqual(removed.removed, [path.basename(receipts[0]!.pin)]);
  verifiesExactly(tasks[1]!, receipts[1]!);
  const dep = path.join(receipts[1]!.pin, 'cli', 'node_modules', 'dep', 'index.js');
  assert.equal(lstatSync(dep).nlink, 2, 'pin b and the store entry');
});

test('the sweep removes only entries no pin links, after the grace, and never one a creator links', async (t) => {
  const { root, receipts } = await realPins(t);
  await shareTaskPins({ root, limit: 8 });
  const now = Date.now();
  assert.equal(await sweepContentStore(root, now + 2 * HOUR), 0, 'every entry is still linked');
  for (const receipt of receipts) {
    await chmodTree(receipt.pin);
    await rm(receipt.pin, { recursive: true, force: true });
  }
  const orphans = await storeEntries(root);
  assert.ok(orphans.length > 0);
  assert.equal(await sweepContentStore(root, now), 0, 'within the grace of the last unlink');
  // A creator links an entry the sweep just chose: the re-check sees it linked and keeps it.
  const raced = orphans[0]!;
  const keep = path.join(root, 'keeper');
  const swept = await sweepContentStore(root, now + 2 * HOUR, {
    beforeSweep: async (entry) => {
      if (entry === raced) await link(entry, keep);
    },
  });
  assert.equal(swept, orphans.length - 1);
  assert.deepEqual(await storeEntries(root), [raced]);
});

test('an entry swept between lookup and link is replaced by the creator’s own copy', async (t) => {
  const { root, tasks, receipts } = await realPins(t);
  await shareTaskPins({ root, limit: 1 });
  const result = await shareTaskPins(
    { root, limit: 1 },
    {
      // The sweep wins the race for every entry the second pin looks up.
      beforeLink: (entry) => unlink(entry),
    },
  );
  assert.equal(result.pins.length, 1);
  assert.equal(result.shared, 0);
  assert.ok(result.inserted > 0);
  receipts.forEach((receipt, i) => verifiesExactly(tasks[i]!, receipt));
});

for (const code of ['EXDEV', 'EPERM'])
  test(`a ${code} hard link keeps a private read-only copy and says so`, async (t) => {
    const { root, tasks, receipts } = await realPins(t);
    const result = await shareTaskPins(
      { root, limit: 8 },
      {
        link: async () => {
          throw Object.assign(new Error(`${code}: hard link refused`), { code });
        },
      },
    );
    assert.equal(result.pins.length, 2);
    assert.ok((result.private[code] ?? 0) > 0);
    assert.deepEqual(await storeEntries(root), []);
    for (const receipt of receipts) {
      const dep = lstatSync(path.join(receipt.pin, 'cli', 'node_modules', 'dep', 'index.js'));
      assert.equal(dep.nlink, 1);
      assert.equal(dep.mode & 0o222, 0);
    }
    receipts.forEach((receipt, i) => verifiesExactly(tasks[i]!, receipt));
  });

test('a store entry whose bytes no longer match its name is quarantined; the pin keeps its copy', async (t) => {
  const { root, tasks, receipts } = await realPins(t);
  const dep = path.join(receipts[0]!.pin, 'cli', 'node_modules', 'dep', 'index.js');
  const key = `${sha256(dep)}-0`;
  const entry = path.join(objectsOf(root), key.slice(0, 2), key);
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, 'y'.repeat(9000));
  const result = await shareTaskPins({ root, limit: 8 });
  assert.equal(result.private.mismatch, 1);
  assert.equal(lstatSync(dep).nlink, 1, 'kept private, never linked to the damaged entry');
  assert.equal(lstatSync(dep).mode & 0o222, 0);
  assert.equal((await readdir(path.join(root, '.content', 'quarantine'))).length, 1);
  receipts.forEach((receipt, i) => verifiesExactly(tasks[i]!, receipt));
});

test('a write into a shared pinned file fails loudly and changes no other copy', async (t) => {
  const { root, tasks, receipts } = await realPins(t);
  await shareTaskPins({ root, limit: 8 });
  const [a, b] = receipts.map((receipt) =>
    path.join(receipt.pin, 'cli', 'node_modules', 'dep', 'index.js'),
  );
  await assert.rejects(writeFile(a!, 'tampered'), (error: NodeJS.ErrnoException) =>
    ['EACCES', 'EPERM'].includes(error.code ?? ''),
  );
  assert.equal(await readFile(b!, 'utf8'), 'x'.repeat(9000));
  receipts.forEach((receipt, i) => verifiesExactly(tasks[i]!, receipt));
  // The owner can still chmod and write; that changes the one shared inode, so every pin that
  // shares it fails its launch re-verify instead of running changed bytes.
  await chmod(a!, 0o644);
  await writeFile(a!, 'z'.repeat(9000));
  for (const task of tasks)
    assert.throws(() => verifyTaskExecutionProvenance(task, null), {
      code: /^TASK_(INPUT|EXECUTABLE)_CHANGED$/,
    });
});

test('store bookkeeping never counts toward the 32-pin stage budget', async (t) => {
  const { root } = await rawPins(t, 32);
  await shareTaskPins({ root, limit: 32 });
  const staged = await stageTaskPins({
    root,
    now: Date.now(),
    ageMs: HOUR,
    protection: { taskDirs: [], taskNames: [], pinIds: [] },
  });
  assert.equal(staged.inspected, 32);
  // Every one of the 32 pins was inspected: the cursor ends on the last pin, not before it.
  assert.equal(await readFile(path.join(root, '.retention-cursor'), 'utf8'), 'pin-31');
  assert.equal((await readTaskPins(root)).length, 32);
  assert.ok((await readdir(root)).includes('.content'));
});

test('a pass shares at most its limit of pins and records each once', async (t) => {
  const { root } = await rawPins(t, 10);
  assert.equal((await shareTaskPins({ root, limit: 8 })).pins.length, 8);
  assert.equal((await shareTaskPins({ root, limit: 8 })).pins.length, 2);
  assert.equal((await shareTaskPins({ root, limit: 8 })).pins.length, 0);
  const shared = path.join(root, 'pin-00', 'cli', 'shared.js');
  assert.equal(lstatSync(shared).nlink, 11, 'ten pins and one entry');
});

test('the shipped node program shares pins through the real command boundary', async (t) => {
  const { root } = await rawPins(t, 2);
  // Keep the pins: only sharing applies, so give them a live owner that holds them.
  const holder = makeRun({ taskFile: path.join(path.dirname(root), 't', '0', 'TASK.md') });
  await utimes(path.join(root, 'pin-00', 'provenance.json'), new Date(), new Date());
  await nodeTaskPinRetentionPass(Date.now(), 30 * 24 * HOUR, {
    ...NODE_PIN_RETENTION_DEPS,
    targets: async () => [{ machine: 'local', host: 'localhost', sshUser: '', root }],
    split: async () => ({ held: [holder], released: [] }),
  });
  assert.equal(lstatSync(path.join(root, 'pin-01', 'cli', 'shared.js')).nlink, 3);
  assert.match(await readFile(path.join(root, '.content', 'migrated'), 'utf8'), /pin-00\npin-01/);
});

test('a pin that changes while it is shared is not recorded and is logged as unverified', async (t) => {
  const { root, receipts } = await realPins(t);
  await shareTaskPins({ root, limit: 1 });
  const result = await shareTaskPins(
    { root, limit: 1 },
    {
      // Something writes into the pin mid-pass: the recomputed fingerprint must catch it.
      beforeLink: async () => {
        for (const receipt of receipts)
          await writeFile(path.join(receipt.pin, 'cli', 'stray.txt'), 'appeared').catch(() => {});
      },
    },
  );
  assert.equal(result.pins.length, 0);
  assert.equal(result.unverified.length, 1);
  assert.doesNotMatch(
    await readFile(path.join(root, '.content', 'migrated'), 'utf8'),
    new RegExp(result.unverified[0]!),
  );
});
