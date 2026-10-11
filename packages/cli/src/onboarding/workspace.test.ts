import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  workspaceAt,
  workspacePoolDir,
  workspacePoolFile,
  type WorkspaceState,
} from './workspace.js';

const ws = workspaceAt('/tmp/portable-workspace');
const state: WorkspaceState = {
  schema_version: 1,
  source: { mode: 'local', path: '.' },
  machine: 'worker',
  pool_file: 'pool/worker.json',
  packs: {},
  pool_migrations: { applied: [] },
};

test('configured pool validation and registration share a directory and file', () => {
  const original = process.env.FARMSLOT_POOL_DIR;
  try {
    process.env.FARMSLOT_POOL_DIR = './configured-pool';
    assert.equal(workspacePoolDir(ws, state), resolve('./configured-pool'));
    assert.equal(dirname(workspacePoolFile(ws, state)), workspacePoolDir(ws, state));
    assert.equal(workspacePoolFile(ws, state), join(resolve('./configured-pool'), 'worker.json'));
    process.env.FARMSLOT_POOL_DIR = '';
    assert.equal(workspacePoolFile(ws, state), join(ws.farmslotDir, state.pool_file));
  } finally {
    if (original === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = original;
  }
});
