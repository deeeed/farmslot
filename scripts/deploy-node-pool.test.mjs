import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('node pool sync copies gateway contents over stale node-local links', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pool-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'release');
  const gateway = path.join(root, 'gateway/pool');
  const target = path.join(root, 'node');
  const stale = path.join(root, 'node-checkout/pool');
  for (const dir of [path.join(source, 'pool'), gateway, path.join(target, 'pool'), stale]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const current = JSON.stringify({
    host: 'worker.local',
    env: { PROVIDER_ROOT: '/gateway-selected/provider' },
    slots: [{ id: 'worker-mmt-1' }, { id: 'worker-mmt-3' }, { id: 'worker-mmt-6' }],
  });
  const old = JSON.stringify({ host: 'worker.local', slots: [{ id: 'worker-mmt-1' }] });
  const file = 'worker.json';
  fs.writeFileSync(path.join(gateway, file), current);
  fs.writeFileSync(path.join(stale, file), old);
  fs.symlinkSync(path.join(gateway, file), path.join(source, 'pool', file));
  fs.symlinkSync(path.join(stale, file), path.join(target, 'pool', file));

  // Run the production pool phase with real rsync and private local paths.
  const deploy = fs.readFileSync(path.join(repo, 'scripts/deploy-node.sh'), 'utf8');
  const start = deploy.indexOf('echo "[deploy] syncing pool configs..."');
  const end = deploy.indexOf('\necho "[deploy] syncing project configs', start);
  assert.ok(start >= 0 && end > start);
  execFileSync(
    'bash',
    ['-c', `set -euo pipefail\nrun() { bash -c "$1"; }\n${deploy.slice(start, end)}`],
    {
      env: { ...process.env, REPO_ROOT: source, REMOTE_DIR: target, RSYNC_PREFIX: '' },
      stdio: 'pipe',
      timeout: 5000,
    },
  );
  const installed = path.join(target, 'pool', file);
  assert.equal(fs.lstatSync(installed).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(installed, 'utf8'), current);
  assert.equal(fs.readFileSync(path.join(stale, file), 'utf8'), old);
  assert.equal(fs.readFileSync(path.join(gateway, file), 'utf8'), current);
});
