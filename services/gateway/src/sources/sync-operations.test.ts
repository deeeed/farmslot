import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { SourcesSyncResult } from '@farmslot/protocol';

import { SourceSyncOperations } from './sync-operations.js';

test('lost acknowledgement and restarted sync retain the original plan and operation result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-sync-test-'));
  try {
    const params = { operationId: 'operation-1', expectedDeclarationRevision: 1 };
    const original = { locks: [], nodeIds: ['node-a'] };
    let preparations = 0;
    const prepare = async () => {
      preparations++;
      return original;
    };
    const first = new SourceSyncOperations(root);
    await assert.rejects(
      first.execute(params, prepare, async () => {
        throw new Error('lost acknowledgement');
      }),
    );
    const restarted = new SourceSyncOperations(root);
    const result: SourcesSyncResult = {
      operationId: params.operationId,
      configured: true,
      declarations: [],
      resolutions: [],
      locks: [],
      nodes: [],
      errors: [],
    };
    const delivered = await restarted.execute(
      params,
      async () => {
        throw new Error('must not replan');
      },
      async (plan) => {
        assert.deepEqual(plan, original);
        return result;
      },
    );
    assert.deepEqual(delivered, result);
    assert.equal(preparations, 1);
    const retry = await restarted.execute(params, prepare, async () => {
      throw new Error('must not redeliver');
    });
    assert.deepEqual(retry, result);
    await assert.rejects(
      restarted.execute({ ...params, nodeId: 'node-b' }, prepare, async () => result),
      /changed request/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
