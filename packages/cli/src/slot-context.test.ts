import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveCurrentSlot, resolveSlotId } from './slot-context.js';

function writePool(root: string, slots: Array<{ id: string; repo: string }>, machine = 'remote') {
  mkdirSync(path.join(root, 'pool'), { recursive: true });
  writeFileSync(
    path.join(root, 'pool', `${machine}.json`),
    JSON.stringify({ machine, host: `${machine}.local`, ssh_user: 'user', slots }, null, 2),
  );
}

test('resolveCurrentSlot infers slot from a slot repo child directory', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-root-'));
  const repo = path.join(root, 'worktrees', 'slot-a');
  const child = path.join(repo, 'src', 'nested');
  mkdirSync(child, { recursive: true });
  writePool(root, [{ id: 'runner-a-1', repo }]);

  assert.deepEqual(resolveCurrentSlot(child, root), {
    slotId: 'runner-a-1',
    repo: realpathSync(repo),
    poolFile: path.join(root, 'pool', 'remote.json'),
  });
});

test('resolveCurrentSlot resolves relative repos against the farmslot root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-root-relative-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'farmslot-outside-'));
  writePool(root, [{ id: 'demo-ff-1', repo: '.' }]);

  assert.equal(resolveCurrentSlot(root, root)?.slotId, 'demo-ff-1');
  assert.equal(resolveCurrentSlot(outside, root), null);
});

test('resolveSlotId keeps an explicit slot id', () => {
  assert.equal(resolveSlotId('runner-a-2'), 'runner-a-2');
});

test('resolveSlotId reports missing current slot', () => {
  const originalRoot = process.env.FARMSLOT_ROOT;
  const isolatedRoot = mkdtempSync(path.join(tmpdir(), 'farmslot-empty-root-'));
  mkdirSync(path.join(isolatedRoot, 'pool'), { recursive: true });
  try {
    process.env.FARMSLOT_ROOT = isolatedRoot;
    assert.throws(() => resolveSlotId(), /Could not infer slot/);
  } finally {
    if (originalRoot === undefined) delete process.env.FARMSLOT_ROOT;
    else process.env.FARMSLOT_ROOT = originalRoot;
  }
});
