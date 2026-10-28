import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('the shell status helper refuses direct writes and preserves the lease bytes', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'status-writer-refusal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const status = path.join(root, '.farm-status.json');
  const original = '{"slots":[{"slot":"owned","current_run_id":"review","slot_epoch":76}]}\n';
  writeFileSync(status, original);
  const helper = fileURLToPath(new URL('../lib/slot-common.sh', import.meta.url));
  const result = spawnSync(
    'bash',
    [
      '-c',
      'source "$1"; PROJECT_DIR="$2"; update_farm_status owned slot_epoch 0',
      'proof',
      helper,
      root,
    ],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: root, FARMSLOT_CLI: '/not-executed' },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /use gateway lifecycle RPCs/);
  assert.equal(readFileSync(status, 'utf8'), original);
});
