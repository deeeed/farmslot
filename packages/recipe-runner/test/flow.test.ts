import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRecipeInvocationAncestry, createRecipeFlowProjection } from '../src/core/flow.js';

import { fixtureTree } from './flow.fixture.js';

function completeCall(
  flow: ReturnType<typeof createRecipeFlowProjection>,
  name: string,
  next: string,
) {
  flow.start(name);
  flow.start(name + '/nested');
  flow.start(name + '/nested/observe');
  flow.complete(name + '/nested/observe', true, name + '/nested/read');
  flow.start(name + '/nested/read');
  flow.complete(name + '/nested/read', true, name + '/nested/done');
  flow.complete(name + '/nested', true, name + '/leaf');
  flow.start(name + '/leaf');
  flow.complete(name + '/leaf', true, name + '/done');
  flow.start(name + '/release', 'teardown');
  flow.complete(name + '/release', true, name + '/clean');
  flow.complete(name, true, next);
}

test('one prepared tree preserves nested/repeated call identities and graph edges', () => {
  const tree = fixtureTree();
  assert.equal(tree.rootId, '$root');
  const first = tree.nodes.find((node) => node.id === 'first/nested/read')!;
  const second = tree.nodes.find((node) => node.id === 'second/nested/read')!;
  assert.equal(first.parentId, 'first/nested');
  assert.equal(first.recipeRef, 'fixture.inner');
  assert.equal(first.nodeId, 'read');
  assert.equal(first.label, 'Read shared state');
  assert.deepEqual(first.claimIds, ['AC-1']);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(tree.nodes.find((node) => node.id === 'pick')!.cases, {
    yes: 'accept',
    no: 'reject',
  });
  assert.equal(tree.nodes.find((node) => node.id === 'first')!.teardown, 'first/release');
});

for (const branch of ['accept', 'reject'] as const) {
  test(`overall progress qualifies the ${branch} branch without counting call containers`, () => {
    const flow = createRecipeFlowProjection(fixtureTree(), 'execution-one');
    assert.equal(flow.snapshot().progress.total, null);
    completeCall(flow, 'first', 'second');
    completeCall(flow, 'second', 'pick');
    flow.start('pick');
    assert.equal(flow.snapshot().progress.current, 9);
    flow.complete('pick', true, branch);
    assert.deepEqual(flow.snapshot().progress, {
      current: 9,
      completed: 9,
      total: branch === 'accept' ? 11 : 12,
      remaining: branch === 'accept' ? 2 : 3,
      qualification: 'exact',
    });
    flow.start(branch);
    assert.equal(flow.snapshot().progress.current, 10);
    flow.complete(branch, true, branch === 'accept' ? 'done' : 'reject_extra');
    if (branch === 'reject') {
      flow.start('reject_extra');
      flow.complete('reject_extra', true, 'done');
    }
    flow.start('cleanup', 'teardown');
    flow.complete('cleanup', true, 'clean');
    flow.finish('pass');
    const last = flow.snapshot();
    assert.equal(last.recipeRunId, 'execution-one');
    assert.equal(last.activeId, null);
    assert.equal(last.progress.current, branch === 'accept' ? 11 : 12);
    assert.equal(last.progress.remaining, 0);
  });
}

test('failure and partial completion preserve unknown totals through teardown', () => {
  const flow = createRecipeFlowProjection(fixtureTree(), 'failure');
  flow.start('first');
  flow.start('first/nested');
  flow.start('first/nested/read');
  flow.complete('first/nested/read', false);
  flow.start('cleanup', 'teardown');
  flow.complete('cleanup', true, 'clean');
  flow.finish('fail');
  assert.deepEqual(flow.snapshot().progress, {
    current: 2,
    completed: 2,
    total: null,
    remaining: null,
    qualification: 'unknown',
  });
  const partial = createRecipeFlowProjection(fixtureTree(), 'partial');
  completeCall(partial, 'first', 'second');
  partial.finish('pass', true);
  assert.equal(partial.snapshot().progress.total, null);
  assert.equal(partial.snapshot().progress.completed, 4);
});

test('active ancestry supplies root depth and distinct labeled repeated-call breadcrumbs', () => {
  const flow = createRecipeFlowProjection(fixtureTree(), 'ancestry-execution');
  assert.equal(flow.snapshot().ancestry, null);
  flow.start('$root');
  assert.deepEqual(flow.snapshot().ancestry, {
    parentId: null,
    depth: 0,
    breadcrumbs: [{ id: '$root', label: 'Composed flow fixture' }],
  });
  for (const call of ['first', 'second']) {
    flow.start(call + '/nested/read');
    assert.deepEqual(flow.snapshot().ancestry, {
      parentId: call + '/nested',
      depth: 3,
      breadcrumbs: [
        { id: '$root', label: 'Composed flow fixture' },
        { id: call, label: call === 'first' ? 'First invocation' : 'Repeated invocation' },
        { id: call + '/nested', label: 'Inspect state' },
        { id: call + '/nested/read', label: 'Read shared state' },
      ],
    });
  }
  flow.start('first/release', 'teardown');
  assert.equal(flow.snapshot().ancestry?.depth, 2);
  assert.equal(flow.snapshot().ancestry?.parentId, 'first');
  flow.invalidate();
  assert.equal(flow.snapshot().progress.total, null);
  assert.equal(flow.snapshot().ancestry?.depth, 2);
  flow.finish('fail');
  assert.equal(flow.snapshot().ancestry, null);
});

test('the public ancestry index does not depend on prepared node order', () => {
  const tree = fixtureTree();
  tree.nodes.reverse();
  const index = buildRecipeInvocationAncestry(tree);
  assert.equal(index.size, tree.nodes.length);
  assert.deepEqual(index.get('second/nested/read'), {
    parentId: 'second/nested',
    depth: 3,
    breadcrumbs: [
      { id: '$root', label: 'Composed flow fixture' },
      { id: 'second', label: 'Repeated invocation' },
      { id: 'second/nested', label: 'Inspect state' },
      { id: 'second/nested/read', label: 'Read shared state' },
    ],
  });
});
