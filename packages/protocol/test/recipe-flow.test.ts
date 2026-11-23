import assert from 'node:assert/strict';
import test from 'node:test';

import { isRecipeFlowUpdate, type RecipeFlowUpdate } from '../src/recipe/index.js';

test('progress decoding preserves unknown totals and refuses inconsistent exact counters', () => {
  const update: RecipeFlowUpdate = {
    version: 1,
    recipeRunId: 'execution',
    rootId: '$root',
    activeId: 'first/read',
    progress: { current: 2, completed: 1, total: 4, remaining: 3, qualification: 'exact' },
  };
  assert.equal(isRecipeFlowUpdate(update), true);
  assert.equal(
    isRecipeFlowUpdate({
      ...update,
      progress: { ...update.progress, total: null, remaining: null, qualification: 'unknown' },
    }),
    true,
  );
  assert.equal(
    isRecipeFlowUpdate({ ...update, progress: { ...update.progress, remaining: 0 } }),
    false,
  );
  assert.equal(
    isRecipeFlowUpdate({ ...update, progress: { ...update.progress, total: 0, remaining: 0 } }),
    false,
  );
  assert.equal(isRecipeFlowUpdate({ ...update, recipeRunId: undefined }), false);
});

test('ancestry decoding preserves legacy updates and validates active identity and depth', () => {
  const legacy: RecipeFlowUpdate = {
    version: 1,
    recipeRunId: 'run',
    rootId: '$root',
    activeId: 'call/read',
    progress: { current: 1, completed: 0, total: null, remaining: null, qualification: 'unknown' },
  };
  const ancestry = {
    parentId: 'call',
    depth: 2,
    breadcrumbs: [
      { id: '$root', label: 'Root' },
      { id: 'call', label: 'Call' },
      { id: 'call/read', label: 'Read' },
    ],
  };
  assert.equal(isRecipeFlowUpdate(legacy), true);
  assert.equal(isRecipeFlowUpdate({ ...legacy, ancestry }), true);
  assert.equal(isRecipeFlowUpdate({ ...legacy, activeId: null, ancestry: null }), true);
  for (const invalid of [
    null,
    { ...ancestry, depth: -1 },
    { ...ancestry, depth: 1 },
    { ...ancestry, parentId: '$root' },
    { ...ancestry, breadcrumbs: [] },
    {
      ...ancestry,
      breadcrumbs: [
        { id: '$root', label: 'Root' },
        { id: 'call', label: 'Call' },
        { id: 'other', label: 'Read' },
      ],
    },
    {
      ...ancestry,
      breadcrumbs: [
        { id: '$root', label: 'Root' },
        { id: '$root', label: 'Root' },
        { id: 'call/read', label: 'Read' },
      ],
    },
    {
      ...ancestry,
      breadcrumbs: [
        { id: 'other', label: 'Root' },
        { id: 'call', label: 'Call' },
        { id: 'call/read', label: 'Read' },
      ],
    },
    {
      ...ancestry,
      breadcrumbs: [
        { id: '$root', label: 'Root' },
        { id: 'call', label: 7 },
        { id: 'call/read', label: 'Read' },
      ],
    },
  ])
    assert.equal(isRecipeFlowUpdate({ ...legacy, ancestry: invalid }), false);
  assert.equal(isRecipeFlowUpdate({ ...legacy, activeId: null, ancestry }), false);
});

test('timing decoding preserves measured zero and separately qualified unknown self', () => {
  const update: RecipeFlowUpdate = {
    version: 1,
    recipeRunId: 'execution',
    rootId: '$root',
    activeId: null,
    progress: { current: 1, completed: 1, total: 1, remaining: 0, qualification: 'exact' },
    timing: {
      scope: 'all',
      nodes: {
        $root: {
          inclusiveMs: 10,
          selfMs: null,
          qualification: { inclusive: 'measured', self: 'unknown' },
        },
      },
      claimTimings: {},
      unassignedTiming: { durationMs: 0, qualification: 'measured', invocationIds: ['zero'] },
    },
  };
  assert.equal(isRecipeFlowUpdate(update), true);
  const original = update.timing!;
  assert.equal(
    isRecipeFlowUpdate({ ...update, timing: { scope: 'active', nodes: original.nodes } }),
    true,
  );
  assert.equal(
    isRecipeFlowUpdate({ ...update, timing: { scope: 'all', nodes: original.nodes } }),
    false,
  );
  for (const bad of [
    { inclusiveMs: -1, selfMs: null, qualification: { inclusive: 'measured', self: 'unknown' } },
    { inclusiveMs: null, selfMs: null, qualification: { inclusive: 'measured', self: 'unknown' } },
    { inclusiveMs: 10, selfMs: 11, qualification: { inclusive: 'measured', self: 'measured' } },
    { inclusiveMs: 10, selfMs: 0, qualification: { inclusive: 'measured', self: 'unknown' } },
  ])
    assert.equal(
      isRecipeFlowUpdate({ ...update, timing: { ...original, nodes: { $root: bad } } }),
      false,
    );
});
