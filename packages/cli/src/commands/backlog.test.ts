import assert from 'node:assert/strict';
import test from 'node:test';

import type { CommandContext } from '../context.js';

import { reconcileBacklogItemRun, resolveItem } from './backlog.js';

function ctxWithItems(items: Array<{ id: string; sourceRef?: string }>): CommandContext {
  return {
    client: { call: async () => ({ items }) },
    output: {},
    target: {},
  } as unknown as CommandContext;
}

test('resolveItem prefers exact sourceRef/id matches', async () => {
  const ctx = ctxWithItems([
    { id: 'aaa111', sourceRef: 'MANUAL-000001' },
    { id: 'aaa222', sourceRef: 'MANUAL-000002' },
  ]);
  assert.equal((await resolveItem(ctx, 'MANUAL-000002')).id, 'aaa222');
  assert.equal((await resolveItem(ctx, 'aaa111')).id, 'aaa111');
});

test('resolveItem rejects ambiguous id prefixes with a teach-the-escape error', async () => {
  const ctx = ctxWithItems([
    { id: 'aaa111', sourceRef: 'MANUAL-000001' },
    { id: 'aaa222', sourceRef: 'MANUAL-000002' },
  ]);
  await assert.rejects(
    () => resolveItem(ctx, 'aaa'),
    (err: unknown) => {
      const rich = err as { code?: string; userAction?: string };
      assert.equal(rich.code, 'BACKLOG_ITEM_AMBIGUOUS');
      assert.ok(rich.userAction && rich.userAction.length > 0);
      return true;
    },
  );
  await assert.rejects(
    () => resolveItem(ctx, 'zzz'),
    (err: unknown) => (err as { code?: string }).code === 'BACKLOG_ITEM_NOT_FOUND',
  );
});

test('reconcileBacklogItemRun calls the shared typed gateway action', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const result = {
    item: { id: 'backlog-1', status: 'done' },
    run: { id: 'run-1', status: 'done' },
  };
  const ctx = {
    client: {
      call: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return result;
      },
    },
  } as unknown as CommandContext;

  assert.equal(await reconcileBacklogItemRun(ctx, { id: 'backlog-1' } as never, 'run-1'), result);
  assert.deepEqual(calls, [
    {
      method: 'backlog.reconcileRun',
      params: { itemId: 'backlog-1', runId: 'run-1' },
    },
  ]);
});
