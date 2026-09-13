import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { NativeSessionClient } from './client.js';
import { NativeSessionManager } from './manager.js';

test('native clients refuse state directories and journals from a different execution node', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-affinity-'));
  try {
    writeFileSync(
      join(root, 'host.json'),
      JSON.stringify({
        executionNodeId: 'node-a',
        pid: process.pid,
        socket: join(root, 'socket'),
        token: 'fixture',
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      new NativeSessionClient(root, 'node-b').list('owner'),
      /another execution node/,
    );
    writeFileSync(
      join(root, 'session.journal'),
      JSON.stringify({ info: { id: 'session', executionNodeId: 'node-a' }, context: {} }) + '\n',
      { mode: 0o600 },
    );
    assert.throws(() => new NativeSessionManager(root, 'node-b'), /another execution node/);
    await assert.rejects(
      new NativeSessionManager(join(root, 'fresh'), 'node-a').create('owner', {
        executionNodeId: 'node-b',
        runner: 'codex',
        cwd: root,
      }),
      /another execution node/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
