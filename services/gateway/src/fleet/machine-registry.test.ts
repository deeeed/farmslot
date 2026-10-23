import assert from 'node:assert/strict';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { resourceDependenciesForRead } from '@farmslot/protocol/client-cache';

import { readWithResourceState, resourceRevisions } from '../resources/revisions.js';

import { getAllNodes, registerNode, unregisterByWs } from './machine-registry.js';

test('node inventory commits stamp replacements and removals; an old transport cannot remove its replacement', async (t) => {
  const machine = 'inventory-observation-proof';
  const first = {} as WebSocket;
  const replacement = {} as WebSocket;
  t.after(() => unregisterByWs(replacement));
  const keys = resourceDependenciesForRead('nodes.list', {});
  assert.deepEqual(keys, [{ family: 'node', scope: 'farm' }]);
  const key = keys![0];
  const before = resourceRevisions.revision(key);
  registerNode(machine, 100, first, 'old-version', 'current-version');
  const initial = await readWithResourceState(keys!, async () => ({ nodes: getAllNodes() }));
  assert.equal(initial.resourceState.dependencies[0].revision, before + 1);
  assert.equal(initial.payload.nodes.find((node) => node.machine === machine)?.pid, 100);
  registerNode(machine, 200, replacement, 'current-version', 'current-version');
  const changed = await readWithResourceState(keys!, async () => ({ nodes: getAllNodes() }));
  assert.equal(changed.resourceState.dependencies[0].revision, before + 2);
  const current = changed.payload.nodes.find((node) => node.machine === machine)!;
  assert.equal(current.pid, 200);
  assert.equal(current.versionMatch, true);
  assert.equal(unregisterByWs(first), null);
  assert.equal(resourceRevisions.revision(key), before + 2);
  assert.equal(unregisterByWs(replacement), machine);
  const removed = await readWithResourceState(keys!, async () => ({ nodes: getAllNodes() }));
  assert.equal(removed.resourceState.dependencies[0].revision, before + 3);
  assert(!removed.payload.nodes.some((node) => node.machine === machine));
  assert.equal(unregisterByWs(replacement), null);
  assert.equal(resourceRevisions.revision(key), before + 3);
});
