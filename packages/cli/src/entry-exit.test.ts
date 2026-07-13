import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageDir, '../..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const entry = path.join(packageDir, 'src', 'entry.ts');

test('unknown command exits non-zero (the 2026-07-09 `farmslot prepare` regression)', () => {
  // Isolated home so the CLI bootstrap never touches the operator's real state.
  const home = mkdtempSync(path.join(os.tmpdir(), 'farmslot-cli-exit-'));
  try {
    const result = spawnSync(tsxBin, [entry, 'prepare'], {
      cwd: packageDir,
      env: { ...process.env, FARMSLOT_HOME: home },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
