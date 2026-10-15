import assert from 'node:assert/strict';
import test from 'node:test';

import type { RecipeRecordingMarker } from '@farmslot/protocol';

import {
  evidenceReviewTimelineGroups,
  formatEvidenceReviewVideoTime,
} from '../src/evidence-review-timeline.js';

function marker(
  index: number,
  start: number,
  proves: string[] = [],
  ok = true,
): RecipeRecordingMarker {
  return {
    traceIndex: index,
    nodeId: `node-${index}`,
    action: 'assert_output',
    intent: `Check node ${index}`,
    proves,
    ok,
    startRangeMs: [start, start],
    endRangeMs: [start + 1000, start + 1000],
  };
}

const seek = (node: RecipeRecordingMarker, phase: 'start' | 'end') =>
  phase === 'start' ? node.startRangeMs[0] : node.endRangeMs[1];

test('groups explicit bindings with Setup, Other and Teardown in time order', () => {
  const nodes = [
    marker(6, 90_000),
    marker(3, 61_000, ['AC-1']),
    marker(0, 0),
    marker(5, 75_000, ['AC-2']),
    marker(4, 65_000),
    marker(2, 55_000, ['AC-1']),
  ];
  const before = structuredClone(nodes);
  const groups = evidenceReviewTimelineGroups(nodes, seek);
  assert.deepEqual(
    groups.map((group) => group.label),
    ['Setup', 'AC-1', 'Other', 'AC-2', 'Teardown'],
  );
  assert.deepEqual(
    groups[1]?.markers.map((node) => node.traceIndex),
    [2, 3],
  );
  assert.equal(groups[1]?.summary, 'AC-1 · 0:55–1:02 · 2 checks · 2 pass');
  assert.equal(groups[1]?.defaultOpen, false);
  assert.deepEqual(nodes, before);
});

test('an AC view includes its own group and counts repeated executions separately', () => {
  const first = marker(0, 1000, ['AC-1']);
  const repeated = { ...marker(2, 3000, ['AC-1']), nodeId: first.nodeId };
  const groups = evidenceReviewTimelineGroups(
    [first, marker(1, 2000, ['AC-2']), repeated],
    seek,
    'AC-1',
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.markers.length, 2);
  assert.equal(groups[0]?.startMarker?.traceIndex, 0);
  assert.equal(groups[0]?.endMarker?.traceIndex, 2);
});

test('a shared node belongs once to each declared claim, without inventing bindings', () => {
  const groups = evidenceReviewTimelineGroups([marker(0, 1000, ['AC-1', 'AC-1', 'AC-2'])], seek);
  assert.deepEqual(
    groups.map((group) => [group.claimId, group.markers.length]),
    [
      ['AC-1', 1],
      ['AC-2', 1],
    ],
  );
  assert.deepEqual(evidenceReviewTimelineGroups([marker(0, 1000)], seek, 'AC-1'), []);
});

test('failures open their group and identify the first failing occurrence', () => {
  const group = evidenceReviewTimelineGroups(
    [marker(0, 0, ['AC-1']), marker(1, 1000, ['AC-1'], false), marker(2, 2000, ['AC-1'], false)],
    seek,
  )[0];
  assert.equal(group?.defaultOpen, true);
  assert.equal(group?.firstFailureTraceIndex, 1);
  assert.equal(group?.failed, 2);
  assert.match(group?.summary ?? '', /3 checks · 1 pass · 2 fail/);
});

test('unrecorded markers stay counted and cannot supply a seek range', () => {
  const nodes = [marker(0, 0, ['AC-1']), marker(1, 1000, ['AC-1'])];
  const partial = evidenceReviewTimelineGroups(nodes, (node, phase) =>
    node.traceIndex ? null : seek(node, phase),
  )[0];
  assert.equal(partial?.unrecorded, 1);
  assert.equal(partial?.endMs, 1000);
  assert.match(partial?.summary ?? '', /1 unrecorded/);
  const absent = evidenceReviewTimelineGroups(nodes, () => null)[0];
  assert.equal(absent?.startMs, null);
  assert.equal(absent?.startMarker, null);
  assert.equal(absent?.rangeLabel, 'unrecorded');
});

test('an unbound recording has one Other group; an empty recording has none', () => {
  assert.deepEqual(
    evidenceReviewTimelineGroups([marker(0, 0), marker(1, 1000)], seek).map((group) => group.label),
    ['Other'],
  );
  assert.deepEqual(evidenceReviewTimelineGroups([], seek), []);
});

test('group ranges and existing player counters share one time formatter', () => {
  assert.equal(formatEvidenceReviewVideoTime(61.25), '1:01.25');
  assert.equal(formatEvidenceReviewVideoTime(61.25, false), '1:01');
  assert.equal(formatEvidenceReviewVideoTime(-1), '0:00.00');
  assert.equal(formatEvidenceReviewVideoTime(Infinity, false), '0:00');
});
