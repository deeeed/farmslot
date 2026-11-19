import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRecipeInvocationTree, createRecipeFlowProjection } from '../src/core/flow.js';
import {
  createRecipeInvocationTimingProjection,
  projectRecipeInvocationTiming,
} from '../src/core/flow-timing.js';

import { fixtureTree } from './flow.fixture.js';

const tree = buildRecipeInvocationTree({
  rootRef: 'fixture.root',
  recipes: new Map(),
  root: {
    workflow: {
      entry: 'one',
      nodes: {
        one: { action: 'wait', next: 'two', proves: ['AC-1'] },
        two: { action: 'wait', next: 'done', proves: ['AC-1'] },
        done: { action: 'end', status: 'pass' },
      },
    },
  },
});
const time = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
const row = (nodeId: string, start: number, end: number) => ({
  nodeId,
  action: nodeId === 'done' ? 'end' : 'wait',
  startedAt: time(start),
  endedAt: time(end),
  durationMs: end - start,
  ok: true,
});
const summary = { startedAt: time(0), endedAt: time(100) };

test('inclusive/self use the union of child intervals, preserving measured zero and unassigned work', () => {
  const result = projectRecipeInvocationTiming({
    tree,
    summary,
    trace: [row('one', 10, 40), row('two', 30, 60), row('done', 60, 60)],
  });
  assert.deepEqual(result.nodes.$root, {
    inclusiveMs: 100,
    selfMs: 50,
    qualification: { inclusive: 'measured', self: 'measured' },
  });
  assert.deepEqual(result.nodes.done, {
    inclusiveMs: 0,
    selfMs: 0,
    qualification: { inclusive: 'measured', self: 'measured' },
  });
  assert.deepEqual(result.claimTimings['AC-1'], {
    durationMs: 50,
    qualification: 'measured',
    invocationIds: ['one', 'two'],
  });
  assert.deepEqual(result.unassignedTiming, {
    durationMs: 50,
    qualification: 'measured',
    invocationIds: ['$root', 'done'],
  });
});

test('a missing child cannot turn measured inclusive time into guessed self time', () => {
  const result = projectRecipeInvocationTiming({ tree, summary, trace: [row('one', 10, 40)] });
  assert.deepEqual(result.nodes.$root, {
    inclusiveMs: 100,
    selfMs: null,
    qualification: { inclusive: 'measured', self: 'unknown' },
  });
  assert.equal(result.nodes.two?.inclusiveMs, null);
  assert.equal(result.unassignedTiming.durationMs, null);
});

test('invalid occurrences qualify a closed subset as partial; unknowns are never zero', () => {
  const result = projectRecipeInvocationTiming({
    tree,
    summary,
    trace: [
      row('one', 10, 40),
      { ...row('one', 50, 70), endedAt: undefined },
      row('two', 40, 40),
      row('done', 60, 60),
    ],
  });
  assert.deepEqual(result.nodes.one, {
    inclusiveMs: 30,
    selfMs: 30,
    qualification: { inclusive: 'partial', self: 'partial' },
  });
  assert.equal(result.nodes.$root?.selfMs, null);
  assert.equal(result.claimTimings['AC-1']?.qualification, 'partial');
});

test('out-of-parent child windows do not qualify parent self', () => {
  const result = projectRecipeInvocationTiming({
    tree,
    summary,
    trace: [row('one', -5, 40), row('two', 30, 60), row('done', 60, 60)],
  });
  assert.equal(result.nodes.$root?.inclusiveMs, 100);
  assert.equal(result.nodes.$root?.selfMs, null);
});

test('incremental snapshots never reread earlier source occurrences and preserve open-subset qualification', () => {
  const projection = createRecipeInvocationTimingProjection(tree);
  let reads = 0;
  projection.record({
    ...row('one', 10, 40),
    get startedAt() {
      reads++;
      return time(10);
    },
  });
  const afterRecording = reads;
  projection.snapshot();
  projection.snapshot();
  assert.equal(reads, afterRecording);
  projection.start('one');
  assert.deepEqual(projection.snapshot().nodes.one, {
    inclusiveMs: 30,
    selfMs: 30,
    qualification: { inclusive: 'partial', self: 'partial' },
  });
  projection.record(row('one', 50, 60));
  assert.deepEqual(projection.snapshot().nodes.one, {
    inclusiveMs: 40,
    selfMs: 40,
    qualification: { inclusive: 'measured', self: 'measured' },
  });
});

test('duplicate/shared spans count once within each explicit claim, without equal splitting', () => {
  const both = structuredClone(tree);
  both.nodes.find((node) => node.id === 'one')!.claimIds = ['AC-1', 'AC-2'];
  const result = projectRecipeInvocationTiming({
    tree: both,
    summary,
    trace: [row('one', 10, 40), row('one', 10, 40), row('two', 10, 40), row('done', 40, 40)],
  });
  assert.equal(result.nodes.one?.inclusiveMs, 30);
  assert.equal(result.claimTimings['AC-1']?.durationMs, 30);
  assert.equal(result.claimTimings['AC-2']?.durationMs, 30);
  assert.equal(result.unassignedTiming.durationMs, 70);
});

test('HUD timing touches only active ancestry across repeated updates of a large prepared tree', () => {
  const nodes: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < 200; i++)
    nodes['n' + i] = { action: 'wait', next: i < 199 ? 'n' + (i + 1) : 'done' };
  nodes.done = { action: 'end', status: 'pass' };
  const prepared = buildRecipeInvocationTree({
    rootRef: 'bounded',
    recipes: new Map(),
    root: { workflow: { entry: 'n0', nodes } },
  });
  let reads = 0;
  for (const node of prepared.nodes) {
    const id = node.id;
    Object.defineProperty(node, 'id', {
      get() {
        reads++;
        return id;
      },
      enumerable: true,
    });
  }
  const flow = createRecipeFlowProjection(prepared, 'bounded');
  flow.snapshot();
  reads = 0;
  for (let i = 0; i < 20; i++) {
    flow.start('n0');
    const update = flow.snapshot();
    assert.equal(update.timing?.scope, 'active');
    assert.deepEqual(Object.keys(update.timing.nodes), ['$root', 'n0']);
  }
  assert.ok(reads <= 400, `prepared node reads ${reads} exceed the active-ancestry bound`);
});

test('synthetic and ambiguous legacy failed-zero diagnostics are unknown; executed zero remains measured', () => {
  for (const extra of [{ intervalSource: 'diagnostic', ok: false }, { ok: false }]) {
    const result = projectRecipeInvocationTiming({
      tree,
      trace: [{ ...row('one', 10, 10), ...extra }],
    });
    assert.equal(result.nodes.one?.inclusiveMs, null);
  }
  const actual = projectRecipeInvocationTiming({
    tree,
    trace: [{ ...row('one', 10, 10), intervalSource: 'execution', ok: false }],
  });
  assert.deepEqual(actual.nodes.one, {
    inclusiveMs: 0,
    selfMs: 0,
    qualification: { inclusive: 'measured', self: 'measured' },
  });
});

test('incomplete rollups name only qualified contributing intervals', () => {
  const result = projectRecipeInvocationTiming({ tree, summary, trace: [row('one', 10, 40)] });
  assert.deepEqual(result.claimTimings['AC-1']?.invocationIds, ['one']);
  assert.deepEqual(result.unassignedTiming.invocationIds, []);
});

test('overlapping repeated parent windows leave self attribution unknown', () => {
  const prepared = fixtureTree();
  const call = (start: number, end: number) => ({
    ...row('first/nested', start, end),
    action: 'call',
  });
  const result = projectRecipeInvocationTiming({
    tree: prepared,
    trace: [
      call(0, 100),
      call(50, 150),
      { ...row('first/nested/observe', 10, 20), action: 'command' },
      { ...row('first/nested/read', 20, 30), action: 'assert_output' },
      { ...row('first/nested/done', 30, 30), action: 'end' },
    ],
  });
  assert.equal(result.nodes['first/nested']?.inclusiveMs, 150);
  assert.equal(result.nodes['first/nested']?.selfMs, null);
});
