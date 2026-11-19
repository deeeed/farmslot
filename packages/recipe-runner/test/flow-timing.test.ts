import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRecipeInvocationTree } from '../src/core/flow.js';
import {
  createRecipeInvocationTimingProjection,
  projectRecipeInvocationTiming,
} from '../src/core/flow-timing.js';

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

test('out-of-parent and ambiguous repeated windows do not qualify parent self', () => {
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
