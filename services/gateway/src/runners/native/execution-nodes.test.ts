import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { knownNativeExecutionNodes, rememberNativeExecutionNode } from './execution-nodes.js';

test('native inventory retains machine declarations independently of live sockets and filters ownership', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-node-registry-'));
  try {
    assert.deepEqual(knownNativeExecutionNodes('owner', root), []);
    rememberNativeExecutionNode('node-a', { ownerPrincipalId: 'owner' }, root);
    rememberNativeExecutionNode('node-b', { ownerPrincipalId: 'another-owner' }, root);
    assert.deepEqual(knownNativeExecutionNodes('owner', root), ['node-a']);
    assert.deepEqual(knownNativeExecutionNodes('another-owner', root), ['node-b']);
    rememberNativeExecutionNode('node-a', { ownerPrincipalId: 'another-owner' }, root);
    assert.deepEqual(knownNativeExecutionNodes('owner', root), []);
    assert.deepEqual(knownNativeExecutionNodes('another-owner', root), ['node-a', 'node-b']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
