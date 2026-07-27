import assert from 'node:assert/strict';
import test from 'node:test';

import type { CommandContext } from '../context.js';

import { resolveRoadmapItem } from './roadmap.js';

function ctxWith(
  items: Array<{ id: string; title?: string; stage?: string }>,
  getExact: boolean = true,
): CommandContext {
  return {
    client: {
      call: async (method: string, params: { itemId?: string }) => {
        if (method === 'roadmap.get') {
          const item = items.find((entry) => entry.id === params.itemId);
          if (item && getExact) return { item };
          throw new Error(`Roadmap item not found: ${params.itemId}`);
        }
        if (method === 'roadmap.list') return { items };
        throw new Error(`unexpected method ${method}`);
      },
    },
    output: {},
    target: {},
  } as unknown as CommandContext;
}

test('resolveRoadmapItem prefers exact roadmap.get id matches', async () => {
  const ctx = ctxWith([
    { id: 'ri_aaa111', title: 'A' },
    { id: 'ri_aaa222', title: 'B' },
  ]);
  assert.equal((await resolveRoadmapItem(ctx, 'ri_aaa222')).id, 'ri_aaa222');
});

test('resolveRoadmapItem accepts unique id prefixes via list fallback', async () => {
  const ctx = ctxWith(
    [
      { id: 'ri_aaa111', title: 'A' },
      { id: 'ri_bbb222', title: 'B' },
    ],
    false,
  );
  assert.equal((await resolveRoadmapItem(ctx, 'ri_bbb')).id, 'ri_bbb222');
});

test('resolveRoadmapItem rethrows non-not-found roadmap.get failures', async () => {
  const ctx = {
    client: {
      call: async () => {
        throw Object.assign(new Error('gateway unauthorized'), { code: 'AUTH' });
      },
    },
    output: {},
    target: {},
  } as unknown as CommandContext;
  await assert.rejects(
    () => resolveRoadmapItem(ctx, 'ri_anything'),
    (err: unknown) => /unauthorized/i.test((err as Error).message),
  );
});

test('resolveRoadmapItem rejects ambiguous id prefixes with a teach-the-escape error', async () => {
  const ctx = ctxWith(
    [
      { id: 'ri_aaa111', title: 'A' },
      { id: 'ri_aaa222', title: 'B' },
    ],
    false,
  );
  await assert.rejects(
    () => resolveRoadmapItem(ctx, 'ri_aaa'),
    (err: unknown) => {
      const rich = err as { code?: string; userAction?: string };
      assert.equal(rich.code, 'ROADMAP_ITEM_AMBIGUOUS');
      assert.ok(rich.userAction && rich.userAction.length > 0);
      return true;
    },
  );
  await assert.rejects(
    () => resolveRoadmapItem(ctx, 'ri_zzz'),
    (err: unknown) => (err as { code?: string }).code === 'ROADMAP_ITEM_NOT_FOUND',
  );
});
