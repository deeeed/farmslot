import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { buildPrepareIdentityReapCommand } from './prepare-command.js';

function running(pid: number): boolean {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
  return !!result.stdout.trim() && !result.stdout.trim().startsWith('Z');
}

function own(t: TestContext, child: ChildProcess): number {
  assert.ok(child.pid && child.pid > 1);
  const pid = child.pid;
  t.after(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error)) throw error;
      // macOS can report EPERM for an already empty process group.
      const census = spawnSync('ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8' });
      assert.equal(census.status, 0, census.stderr);
      const alive = census.stdout.split('\n').some((row) => {
        const [group, state] = row.trim().split(/\s+/);
        return Number(group) === pid && !state?.startsWith('Z');
      });
      if (alive || (error.code !== 'ESRCH' && error.code !== 'EPERM')) throw error;
    }
  });
  return pid;
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'prepare-detached-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const identity = path.join(root, 'preflight.identity');
  const scope = randomUUID().replaceAll('-', '');
  const sentinel = spawn(
    '/bin/sh',
    ['-c', 'while :; do sleep 86400; done', 'farmslot-prepare-scope', scope],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, FARMSLOT_PREPARE_SCOPE: scope },
    },
  );
  const pgid = own(t, sentinel);
  await once(sentinel, 'spawn');
  writeFileSync(identity, `${pgid}\t${pgid}\t${scope}\n`);
  const borrowed = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
    detached: true,
    stdio: 'ignore',
  });
  own(t, borrowed);
  await once(borrowed, 'spawn');
  const listenerCode = 'console.log(process.pid); setInterval(() => {}, 60000)';
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(listenerCode)}], { stdio: ['ignore', 'inherit', 'ignore'] });
    setInterval(() => {}, 60000);
  `,
    ],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, FARMSLOT_PREPARE_SCOPE: scope },
    },
  );
  own(t, child);
  const [data] = await once(child.stdout!, 'data', { signal: AbortSignal.timeout(2000) });
  const descendant = Number(String(data).trim());
  assert.ok(descendant > 1);
  const reap = (expectedScope = scope, extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync(
      '/bin/sh',
      ['-c', buildPrepareIdentityReapCommand(identity, { expectedScope, awaitExit: true })],
      { encoding: 'utf8', timeout: 2500, env: { ...process.env, ...extraEnv } },
    );
  return { root, identity, scope, child, descendant, borrowed, reap };
}

test('prepare cleanup stops detached groups and preserves a borrowed group', async (t) => {
  const f = await fixture(t);
  const result = f.reap();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(running(f.descendant), false, 'detached preflight descendant survived release');
  assert.equal(running(f.borrowed.pid!), true, 'borrowed resource must survive');
  assert.equal(existsSync(f.identity), false);
});

test('prepare cleanup stops group members after their detached leader exits', async (t) => {
  const f = await fixture(t);
  const exited = once(f.child, 'exit');
  f.child.kill('SIGKILL');
  await exited;
  assert.equal(running(f.descendant), true);
  const result = f.reap();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(running(f.descendant), false, 'dead leader must not hide live group members');
});

test('prepare cleanup preserves a successor scope and its detached groups', async (t) => {
  const f = await fixture(t);
  const before = readFileSync(f.identity, 'utf8');
  const result = f.reap('b'.repeat(32));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(running(f.descendant), true);
  assert.equal(readFileSync(f.identity, 'utf8'), before);
});

test('prepare cleanup retains ownership and refuses release when its census fails', async (t) => {
  const f = await fixture(t);
  const before = readFileSync(f.identity, 'utf8');
  const bin = path.join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, 'ps'),
    '#!/bin/sh\nif [ "$1" = axeww ]; then exit 1; fi\nexec /bin/ps "$@"\n',
    { mode: 0o755 },
  );
  const result = f.reap(f.scope, { PATH: bin + path.delimiter + process.env.PATH });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Prepare process census unavailable/);
  assert.equal(running(f.descendant), true);
  assert.equal(readFileSync(f.identity, 'utf8'), before);
});
