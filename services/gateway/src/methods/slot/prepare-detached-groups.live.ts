// Slow real-process check (measured 10 s per shell, past the default suite's 5 s rule): run with
// `yarn workspace @farmslot/gateway run test:prepare-reap-live`.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { buildPrepareIdentityReapCommand } from './prepare-command.js';

function running(pid: number): boolean {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
  return !!result.stdout.trim() && !result.stdout.trim().startsWith('Z');
}

async function waitFor(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

for (const shell of ['/bin/sh', '/bin/zsh'].filter((candidate) => existsSync(candidate))) {
  test(`prepare cleanup of successive stubborn replacement groups fits the release budget (${shell})`, async (t) => {
    // Each generation ignores SIGTERM and starts the next group: every round needs SIGKILL.
    const root = mkdtempSync(path.join(os.tmpdir(), 'prepare-reap-budget-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scope = randomUUID().replaceAll('-', '');
    const identity = path.join(root, 'preflight.identity');
    const sentinel = spawn('/bin/sh', ['-c', 'while :; do sleep 86400; done'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, FARMSLOT_PREPARE_SCOPE: scope },
    });
    await once(sentinel, 'spawn');
    writeFileSync(identity, `${sentinel.pid}\t${sentinel.pid}\t${scope}\n`);
    const pids = path.join(root, 'generations');
    // A generation records its pid only once its TERM handler is installed.
    const generation = (left: number): string => `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      process.on('SIGTERM', () => {
        if (${left} > 0) {
          spawn(process.execPath, ['-e', ${JSON.stringify('__NEXT__')}], { detached: true, stdio: 'ignore' }).unref();
        }
      });
      fs.appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');
      setInterval(() => {}, 60000);
    `;
    let code = generation(0);
    for (const left of [1, 2])
      code = generation(left).replace(JSON.stringify('__NEXT__'), JSON.stringify(code));
    const first = spawn(process.execPath, ['-e', code], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, FARMSLOT_PREPARE_SCOPE: scope },
    });
    const generations = () =>
      existsSync(pids)
        ? readFileSync(pids, 'utf8').trim().split('\n').filter(Boolean).map(Number)
        : [];
    t.after(() => {
      for (const pid of [sentinel.pid!, first.pid!, ...generations()])
        if (pid > 1 && running(pid)) process.kill(pid, 'SIGKILL');
    });
    await waitFor(() => generations().length === 1, 5_000, 'the first generation');
    const started = Date.now();
    const result = spawnSync(
      shell,
      [
        ...(shell.endsWith('zsh') ? ['-f'] : []),
        '-c',
        buildPrepareIdentityReapCommand(identity, { expectedScope: scope, awaitExit: true }),
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );
    const elapsed = Date.now() - started;
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(generations().length, 3, 'every generation started its replacement');
    assert.ok(
      generations().every((pid) => !running(pid)),
      'a replacement group survived',
    );
    assert.ok(elapsed < 15_000, `reap took ${elapsed} ms, past the 15 s release command budget`);
  });
}
