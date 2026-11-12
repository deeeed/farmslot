import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const source = new URL('../src/runtime/operation.ts', import.meta.url).href;

/** Runs processStillRunning in a child whose PATH `ps` only records that it was spawned. */
function check(pid: number, startedAt: string | undefined) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operation-liveness-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const marker = path.join(root, 'ps-spawned');
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\ntouch '${marker}'\nexec /bin/ps "$@"\n`, {
    mode: 0o755,
  });
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { processStillRunning } from ${JSON.stringify(source)};
         process.stdout.write(String(processStillRunning(Number(process.argv[1]), process.argv[2] || undefined)));`,
        String(pid),
        startedAt ?? '',
      ],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return { running: result.stdout === 'true', psSpawned: fs.existsSync(marker) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a dead pid is not running and is decided without spawning ps', () => {
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.equal(child.status, 0);
  assert.deepEqual(check(child.pid!, 'Thu Nov 12 10:00:00 2026'), {
    running: false,
    psSpawned: false,
  });
});

test('a live pid matches only its recorded start time', () => {
  const started = spawnSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {
    encoding: 'utf8',
  }).stdout.trim();
  assert.equal(check(process.pid, started).running, true);
  assert.equal(check(process.pid, 'Thu Jan  1 00:00:00 1970').running, false);
  assert.equal(check(process.pid, undefined).running, true);
});
