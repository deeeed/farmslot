import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NATIVE_WORKER_ENSURE, NATIVE_WORKER_RESUME } from '@farmslot/agent-runtime/native';
import { Methods } from '@farmslot/protocol';

test('native creation and worker recovery refuse a model missing from the selected node', async (t) => {
  const pool = await mkdtemp(path.join(tmpdir(), 'native-model-pool-'));
  const previous = process.env.FARMSLOT_POOL_DIR;
  process.env.FARMSLOT_POOL_DIR = pool;
  t.after(async () => {
    if (previous === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = previous;
    await rm(pool, { recursive: true, force: true });
  });
  for (const [machine, host] of [
    ['model-mini', 'mini.invalid'],
    ['model-local', 'localhost'],
  ])
    await writeFile(
      path.join(pool, `${machine}.json`),
      JSON.stringify({ machine, host, slots: [] }),
    );
  const { nodeModelCatalogs } = await import('../model-catalog.js');
  const { nativeModelNodeBlocker } = await import('../../methods/native-workspace.js');
  const { routeNativeExecution } = await import('./node.js');
  nodeModelCatalogs.record('pi', 'model-macpro', ['litellm/glm-5p3']);
  for (const machine of ['model-mini', 'model-local'])
    nodeModelCatalogs.record('pi', machine, ['xai/grok-4.7']);
  for (const executionNodeId of ['model-mini', 'local']) {
    assert.equal(await nativeModelNodeBlocker('pi', 'xai/grok-4.7', executionNodeId), null);
    for (const method of [
      Methods.NATIVE_SESSION_CREATE,
      Methods.NATIVE_SESSION_ENSURE,
      NATIVE_WORKER_ENSURE,
      NATIVE_WORKER_RESUME,
    ])
      await assert.rejects(
        routeNativeExecution('owner', method, {
          executionNodeId,
          runner: 'pi',
          model: 'litellm/glm-5p3',
        }),
        /pi model litellm\/glm-5p3 is not listed on model-(mini|local); only on model-macpro/,
      );
  }
});
