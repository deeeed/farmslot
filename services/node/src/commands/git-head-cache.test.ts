import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fsCallbacks, { existsSync } from 'node:fs';
import fs, { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { mock, type TestContext } from 'node:test';

import { GitHeadCache } from './git-head-cache.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-head-cache-'));
  const repo = path.join(root, 'repo with spaces');
  await mkdir(repo);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const git = (...args: string[]) =>
    execFileSync(realGit, ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-qm',
    'test: seed',
  );
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const trace = path.join(root, 'git-calls');
  const shim = path.join(bin, 'git');
  await writeFile(
    shim,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$F81_TEST_TRACE"\nexec "$F81_TEST_GIT" "$@"\n',
  );
  await chmod(shim, 0o755);
  const prior = {
    PATH: process.env.PATH,
    F81_TEST_TRACE: process.env.F81_TEST_TRACE,
    F81_TEST_GIT: process.env.F81_TEST_GIT,
  };
  Object.assign(process.env, {
    PATH: `${bin}:${prior.PATH}`,
    F81_TEST_TRACE: trace,
    F81_TEST_GIT: realGit,
  });
  let now = 1000;
  let changes = 0;
  const cache = new GitHeadCache(
    () => {
      changes++;
    },
    () => now,
  );
  t.after(async () => {
    await cache.close();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    repo,
    cache,
    git,
    shim,
    trace,
    tick: () => {
      now += 10_001;
    },
    changes: () => changes,
    calls: async () =>
      existsSync(trace) ? (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean) : [],
  };
}

async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 1500;
  while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), 'expected observable file/process condition before deadline');
}

test('simultaneous panes share HEAD reads and unchanged TTL checks spawn no Git', async (t) => {
  const f = await fixture(t);
  const labels = await Promise.all(Array.from({ length: 40 }, () => f.cache.read(f.repo)));
  assert.deepEqual(new Set(labels), new Set(['main']));
  assert.equal((await f.calls()).length, 2);
  const subdirectory = path.join(f.repo, 'src');
  await mkdir(subdirectory);
  assert.equal(await f.cache.read(subdirectory), 'main');
  assert.equal(
    (await f.calls()).length,
    3,
    'a second cwd shares the already observed worktree HEAD',
  );
  for (let i = 0; i < 3; i++) {
    f.tick();
    assert.equal(await f.cache.read(f.repo), 'main');
    assert.equal(await f.cache.read(subdirectory), 'main');
  }
  assert.equal((await f.calls()).length, 3);
});

test('atomic HEAD replacement, checkout and detached commits remain observable', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.cache.read(f.repo), 'main');
  const version = f.changes();
  f.git('checkout', '-qb', 'feature/changed');
  await until(() => f.changes() > version);
  assert.equal(await f.cache.read(f.repo), 'feature/changed');
  f.git('checkout', '--detach', '-q', 'HEAD');
  f.tick();
  assert.equal(await f.cache.read(f.repo), f.git('rev-parse', '--short', 'HEAD'));
  const headPath = path.join(f.repo, '.git', 'HEAD');
  const next = path.join(f.repo, '.git', 'new-HEAD');
  await writeFile(next, 'ref: refs/heads/main\n');
  await rename(next, headPath);
  f.tick();
  assert.equal(await f.cache.read(f.repo), 'main');
  f.git('checkout', '--detach', '-q', 'HEAD');
  f.git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-qm',
    'test: detached advance',
  );
  f.tick();
  assert.equal(await f.cache.read(f.repo), f.git('rev-parse', '--short', 'HEAD'));
});

test('linked worktrees and bare repositories keep their own HEAD labels', async (t) => {
  const f = await fixture(t);
  const linked = path.join(f.root, 'linked');
  f.git('worktree', 'add', '-q', '-b', 'feature/linked', linked);
  assert.equal(await f.cache.read(f.repo), 'main');
  assert.equal(await f.cache.read(linked), 'feature/linked');
  const bare = path.join(f.root, 'bare.git');
  f.git('clone', '--bare', '-q', f.repo, bare);
  assert.equal(await f.cache.read(bare), 'main');
});

test('ordinary shell cwd stays spawn-free and later git init is discovered', async (t) => {
  const f = await fixture(t);
  const plain = path.join(f.root, 'plain');
  await mkdir(plain);
  for (let i = 0; i < 3; i++) {
    assert.equal(await f.cache.read(plain), undefined);
    f.tick();
  }
  assert.equal((await f.calls()).length, 0);
  execFileSync(process.env.F81_TEST_GIT!, ['-C', plain, 'init', '-q', '-b', 'new-repo']);
  f.tick();
  assert.equal(await f.cache.read(plain), 'new-repo');
});

test('reftable refreshes branch and detached labels when its compatibility HEAD stays fixed', async (t) => {
  const f = await fixture(t);
  if (f.git('rev-parse', '--show-ref-format') !== 'files') {
    t.skip('installed Git cannot create reftable storage');
    return;
  }
  f.git('refs', 'migrate', '--ref-format=reftable');
  assert.equal(await f.cache.read(f.repo), 'main');
  const compatibilityHead = await readFile(path.join(f.repo, '.git', 'HEAD'), 'utf8');
  f.git('checkout', '-qb', 'feature/reftable');
  assert.equal(await readFile(path.join(f.repo, '.git', 'HEAD'), 'utf8'), compatibilityHead);
  f.tick();
  assert.equal(await f.cache.read(f.repo), 'feature/reftable');
  f.git('checkout', '--detach', '-q', 'HEAD');
  f.tick();
  assert.equal(await f.cache.read(f.repo), f.git('rev-parse', '--short', 'HEAD'));
});

test('unavailable metadata on one cwd preserves the healthy inventory branches', async (t) => {
  const f = await fixture(t);
  const original = fs.stat;
  let code = 'EPERM';
  const badCwd = path.join(f.root, 'unavailable-pane');
  const mocked = mock.method(fs, 'stat', (...args: Parameters<typeof fs.stat>) => {
    if (String(args[0]).startsWith(badCwd)) {
      return Promise.reject(Object.assign(new Error('repository metadata unavailable'), { code }));
    }
    return Reflect.apply(original, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  for (code of ['EPERM', 'EIO', 'ESTALE', 'ETIMEDOUT', 'ELOOP', 'ENAMETOOLONG']) {
    f.tick();
    const branches = await Promise.all([f.cache.read(badCwd), f.cache.read(f.repo)]);
    assert.deepEqual(branches, [undefined, 'main'], code);
  }
});

test('TCC-refused directory watching preserves the bounded HEAD polling fallback', async (t) => {
  const f = await fixture(t);
  const mocked = mock.method(fsCallbacks, 'watch', () => {
    throw Object.assign(new Error('directory watching refused'), { code: 'EPERM' });
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  assert.equal(await f.cache.read(f.repo), 'main');
  f.git('checkout', '-qb', 'feature/unwatched');
  f.tick();
  assert.equal(await f.cache.read(f.repo), 'feature/unwatched');
});

test('shutdown kills only its pending query and waits until the child is reaped', async (t) => {
  const f = await fixture(t);
  const pidFile = path.join(f.root, 'child-pid');
  // A real owned child remains blocked; the cache must close/reap it before returning.
  await writeFile(
    f.shim,
    '#!/bin/sh\nexec "$F81_TEST_NODE" -e \'require("fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},50)\' "$F81_TEST_PID"\n',
  );
  const priorNode = process.env.F81_TEST_NODE;
  const priorPid = process.env.F81_TEST_PID;
  Object.assign(process.env, { F81_TEST_NODE: process.execPath, F81_TEST_PID: pidFile });
  t.after(() => {
    if (priorNode === undefined) delete process.env.F81_TEST_NODE;
    else process.env.F81_TEST_NODE = priorNode;
    if (priorPid === undefined) delete process.env.F81_TEST_PID;
    else process.env.F81_TEST_PID = priorPid;
  });
  const read = f.cache.read(f.repo);
  await until(() => existsSync(pidFile));
  const pid = Number(await readFile(pidFile, 'utf8'));
  await f.cache.close();
  assert.equal(await read, undefined);
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
  );
  assert.equal(await f.cache.read(f.repo), undefined);
});
