import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readOperations } from '../src/runtime/operation.js';

test('operation files remain readable under a restrictive inherited umask', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operation-permissions-'));
  const source = new URL('../src/runtime/operation.ts', import.meta.url).href;
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { OperationRecord } from ${JSON.stringify(source)};
      import path from 'node:path';
      process.umask(0o777);
      const root = process.argv[1];
      const record = new OperationRecord(path.join(root, 'runtime', 'operations'), 'build', root, {
        mirrorDirectory: path.join(root, 'task', 'artifacts', 'operations'),
      });
      record.stage('compile');
      record.output('compiler output\\n');
      record.finish(0);
    `,
        root,
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const local = readOperations(path.join(root, 'runtime', 'operations'));
    const mirrored = readOperations(path.join(root, 'task', 'artifacts', 'operations'));
    assert.equal(local.length, 1);
    assert.deepEqual(mirrored, local);
    assert.equal(local[0].status, 'pass');
    assert.equal(fs.readFileSync(local[0].logPath, 'utf8'), 'compiler output\n');
    for (const file of [
      path.join(root, 'runtime', 'operations', `${local[0].id}.json`),
      path.join(root, 'task', 'artifacts', 'operations', `${local[0].id}.json`),
      path.join(root, 'task', 'artifacts', 'operations-updated.json'),
      local[0].logPath,
    ])
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
