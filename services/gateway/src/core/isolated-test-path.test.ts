import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./isolated-test-path.ts', import.meta.url));

test('a test process removes its isolated state and sidecars when it exits', (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'isolated-test-path-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const unrelated = path.join(tmp, 'farmslot-test-backlog-1.json');
  // Another process's file sharing the prefix must survive.
  writeFileSync(unrelated, '{}');

  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { mkdirSync, writeFileSync } from 'node:fs';
       import { isolatedTestPath } from ${JSON.stringify(helper)};
       const file = isolatedTestPath('farmslot-test-backlog', '.json');
       writeFileSync(file, '{}');
       writeFileSync(file + '.provenance-v1', '{}');
       mkdirSync(isolatedTestPath('farmslot-test-runs'), { recursive: true });`,
    ],
    { encoding: 'utf8', env: { ...process.env, TMPDIR: tmp } },
  );
  assert.equal(child.status, 0, child.stderr);

  // tsx's transform cache from the child process is not its state.
  assert.deepEqual(
    readdirSync(tmp).filter((entry) => !entry.startsWith('tsx-')),
    ['farmslot-test-backlog-1.json'],
  );
  assert.ok(existsSync(unrelated));
});
