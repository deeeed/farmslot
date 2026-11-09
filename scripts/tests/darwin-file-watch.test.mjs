import assert from 'node:assert/strict';
import { on, once } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../services/gateway/package.json', import.meta.url));
const cjs = require('chokidar');

function eventPath(name, details) {
  const watched = details?.watchedPath;
  if (typeof name !== 'string') return watched;
  if (path.isAbsolute(name)) return name;
  if (typeof watched !== 'string') return undefined;
  return path.basename(watched) === name ? watched : path.join(watched, name);
}

async function observe(watcher, file, write, signal, normalized = false) {
  // Raw receipts bypass Chokidar's change/remove throttles. The symlink's
  // one mutation uses normalized events for its logical alias.
  const receipts = on(watcher, normalized ? 'all' : 'raw', { signal });
  try {
    await write();
    for await (const [event, observed, details] of receipts) {
      if (
        normalized
          ? observed === file && ['add', 'change', 'unlink'].includes(event)
          : eventPath(observed, details) === file
      )
        return file;
    }
  } finally {
    await receipts.return();
  }
}

const esm = await import(new URL('esm/index.js', pathToFileURL(require.resolve('chokidar'))).href);

for (const [format, { watch }] of [
  ['CJS', cjs],
  ['ESM', esm],
])
  test(
    `${format} Darwin file observation uses directories, preserves events and closes its native handles`,
    { skip: process.platform !== 'darwin', timeout: 5000 },
    async (t) => {
      // The nonpersistent watcher and Node 22's test timeout are both unrefed.
      // Keep the test alive while awaiting events, without changing watcher behavior.
      const keepAlive = setInterval(() => {}, 1_000);
      t.after(() => clearInterval(keepAlive));
      const root = await mkdtemp(path.join(os.tmpdir(), 'file-watch-volume-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const file = path.join(root, 'TASK.md');
      await writeFile(file, 'before');
      const native = [];
      const original = fs.watch;
      const stub = mock.method(fs, 'watch', (...args) => {
        const handle = original(...args);
        const entry = { path: String(args[0]), handle, closed: false };
        handle.once('close', () => {
          entry.closed = true;
        });
        native.push(entry);
        return handle;
      });
      syncBuiltinESMExports();
      t.after(() => {
        stub.mock.restore();
        syncBuiltinESMExports();
      });
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const watcher = watch(file, { persistent: false, ignoreInitial: true });
      t.after(() => watcher.close());
      await once(watcher, 'ready');
      assert(native.length > 0);
      assert(
        native.every((entry) => fs.statSync(entry.path).isDirectory()),
        'File inode watchers abort in libuv when their volume is revoked',
      );
      const raw = once(watcher, 'raw');
      assert.equal(await observe(watcher, file, () => writeFile(file, 'after'), t.signal), file);
      assert.equal(await fs.promises.readFile(file, 'utf8'), 'after');
      const [, name, details] = await raw;
      assert.equal(path.resolve(path.dirname(details.watchedPath), name), file);
      // Advance Chokidar's timers before observing replacement, with no wall-clock wait.
      t.mock.timers.tick(1001);
      t.mock.timers.reset();
      // Every native Darwin stream watches this directory, even when Chokidar
      // filters it to one basename. Cross each stream before the next receipt
      // baseline, so a late raw event from the first write cannot satisfy it.
      const marker = file + '.watch-drain';
      const drained = native
        .filter((entry) => !entry.closed)
        .map(async ({ handle }) => {
          for await (const [, name] of on(handle, 'change', { signal: t.signal })) {
            if (String(name) === path.basename(marker)) return;
          }
        });
      await writeFile(marker, 'drain');
      await Promise.all(drained);
      await rm(marker);
      assert.equal(
        await observe(
          watcher,
          file,
          async () => {
            await writeFile(file + '.next', 'replacement');
            await rename(file + '.next', file);
          },
          t.signal,
        ),
        file,
      );
      assert.equal(await fs.promises.readFile(file, 'utf8'), 'replacement');
      await watcher.close();
      await new Promise((resolve) => setImmediate(resolve));
      assert(native.every((entry) => entry.closed));
    },
  );

for (const [format, { watch }] of [
  ['CJS', cjs],
  ['ESM', esm],
])
  test(`${format} file symlinks retain target-change observation`, { timeout: 5000 }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'file-watch-link-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const targetDir = path.join(root, 'target');
    await fs.promises.mkdir(targetDir);
    const target = path.join(targetDir, 'physical.md');
    const alias = path.join(root, 'logical.md');
    await writeFile(target, 'before');
    await symlink(target, alias);
    const watcher = watch(alias, { ignoreInitial: true });
    t.after(() => watcher.close());
    await once(watcher, 'ready');
    assert.equal(
      await observe(watcher, alias, () => writeFile(target, 'after'), t.signal, true),
      alias,
    );
    assert.equal(await fs.promises.readFile(alias, 'utf8'), 'after');
  });
