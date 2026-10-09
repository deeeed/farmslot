import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CheckoutUpdateOperation } from '@farmslot/protocol';

import { readCheckoutUpdate } from './gateway-update.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: 'pipe' },
  ).trim();
}

/** A checkout that has moved from `oldSha` to `headSha` by some route other than the update. */
function checkout(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'gateway-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '--initial-branch=main');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'chore: before');
  const oldSha = git(root, 'rev-parse', 'HEAD');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'chore: after');
  const headSha = git(root, 'rev-parse', 'HEAD');
  const write = (operation: Partial<CheckoutUpdateOperation>) =>
    writeFileSync(
      path.join(root, '.git/farmslot-checkout-update.json'),
      JSON.stringify({
        id: 'op-1',
        targetSha: 'd9e09b8f',
        message: 'Fixture update message.',
        updatedAt: new Date().toISOString(),
        ...operation,
      }),
    );
  return { root, oldSha, headSha, write };
}

test('an error from before HEAD moved is no longer reported', async (t) => {
  const c = checkout(t);
  c.write({ phase: 'error', localSha: c.oldSha.slice(0, 8) });

  assert.equal(await readCheckoutUpdate(c.root), undefined);
});

test('an error is reported while HEAD is still the commit it refused to move', async (t) => {
  const c = checkout(t);
  c.write({ phase: 'error', localSha: c.headSha.slice(0, 8) });

  assert.equal((await readCheckoutUpdate(c.root))?.phase, 'error');
});

test('a running update is reported even though HEAD differs from its start', async (t) => {
  const c = checkout(t);
  c.write({ phase: 'running', localSha: c.oldSha.slice(0, 8), pid: process.pid });

  assert.equal((await readCheckoutUpdate(c.root))?.phase, 'running');
});

test('a completed update is reported only while HEAD is its target', async (t) => {
  const c = checkout(t);
  c.write({ phase: 'complete', localSha: c.oldSha, targetSha: c.headSha });
  assert.equal((await readCheckoutUpdate(c.root))?.phase, 'complete');

  c.write({ phase: 'complete', localSha: c.oldSha, targetSha: c.oldSha });
  assert.equal(await readCheckoutUpdate(c.root), undefined);
});

/** A pid that has already exited, as a crashed update worker's would be. */
const deadPid = () => spawnSync('true').pid;
const stale = () => new Date(Date.now() - 5 * 60_000).toISOString();

test('a dead worker from before HEAD moved is no longer reported', async (t) => {
  const c = checkout(t);
  c.write({ phase: 'running', localSha: c.oldSha, pid: deadPid(), updatedAt: stale() });

  assert.equal(await readCheckoutUpdate(c.root), undefined);
});

test('a dead worker is reported as stopped while HEAD is unchanged', async (t) => {
  const c = checkout(t);
  c.write({ phase: 'running', localSha: c.headSha, pid: deadPid(), updatedAt: stale() });

  const operation = await readCheckoutUpdate(c.root);
  assert.equal(operation?.phase, 'error');
  assert.match(operation?.message ?? '', /update worker stopped/);
});

test('a finished record is kept when HEAD cannot be read', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'gateway-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // An unborn branch: the record path resolves, `rev-parse HEAD` fails.
  git(root, 'init', '-q', '--initial-branch=main');
  writeFileSync(
    path.join(root, '.git/farmslot-checkout-update.json'),
    JSON.stringify({
      id: 'op-1',
      phase: 'error',
      localSha: 'abc1234',
      targetSha: 'def5678',
      message: 'Fixture update message.',
      updatedAt: new Date().toISOString(),
    }),
  );

  assert.equal((await readCheckoutUpdate(root))?.phase, 'error');
});
