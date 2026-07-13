import assert from 'node:assert/strict';
import test from 'node:test';

import { FLOW_STEPS, type FlowType, type Run, type RunDecision } from '@farmslot/protocol';

import {
  canReplayCollisionDecision,
  findLatestResolvedDecision,
  isReplayableResolvedHumanGateDecision,
  latestResolvedHumanGateDecision,
  markResolvedHumanGateReviewRequestConsumed,
  requiresCollisionPrecheck,
} from './decision-replay.js';
import { makeCollisionDecision } from './test-fixtures.js';

test('canReplayCollisionDecision replays when dir set is identical', () => {
  const prior = makeCollisionDecision(['proj-1-a', 'proj-1-b']);
  assert.equal(canReplayCollisionDecision(prior, ['proj-1-a', 'proj-1-b']), true);
});

test('canReplayCollisionDecision replays when dir set is identical regardless of order', () => {
  // Sorting protects against filesystem readdir order drift between precheck
  // and WRITE_TASK — same dirs, different order is still "same collision".
  const prior = makeCollisionDecision(['proj-1-b', 'proj-1-a']);
  assert.equal(canReplayCollisionDecision(prior, ['proj-1-a', 'proj-1-b']), true);
});

test('canReplayCollisionDecision forces re-prompt when a new dir appears', () => {
  // Core race fix — a concurrent dispatch created proj-1-c between precheck and
  // WRITE_TASK. The operator's prior create-new resolution does not apply to
  // the new dir; engine must surface the fresh information.
  const prior = makeCollisionDecision(['proj-1-a']);
  assert.equal(canReplayCollisionDecision(prior, ['proj-1-a', 'proj-1-c']), false);
});

test('canReplayCollisionDecision forces re-prompt when a dir disappears', () => {
  // Symmetric case — same handler should not paper over a state change in
  // either direction; the resolved action might no longer apply.
  const prior = makeCollisionDecision(['proj-1-a', 'proj-1-b']);
  assert.equal(canReplayCollisionDecision(prior, ['proj-1-a']), false);
});

test('canReplayCollisionDecision falls back to legacy replay when prior payload is missing', () => {
  // Backwards compat: pre-canReplay decisions have no collision payload.
  // Replay legacy behavior so old runs surviving gateway restart resume cleanly.
  const prior: RunDecision = {
    id: 'dec-1',
    type: 'engine_collision',
    title: 'collision',
    description: '',
    actions: [],
    createdAt: '2026-05-13T00:00:00Z',
    resolvedAt: '2026-05-13T00:00:01Z',
    resolvedAction: 'create-new',
  };
  assert.equal(canReplayCollisionDecision(prior, ['proj-1-a']), true);
});

test('findLatestResolvedDecision returns the last appended resolved decision for a reason', () => {
  // Helper walks array end→start (not by resolvedAt) — dedup uses append order.
  // Regression guard: createEngineDecision dedup MUST honor that order so a fresh
  // decision appended after a canReplay-rejected prior one drives replay.
  const older = makeCollisionDecision(['proj-1-a']);
  older.id = 'dec-old';
  const newer = makeCollisionDecision(['proj-1-a', 'proj-1-b']);
  newer.id = 'dec-new';
  newer.resolvedAt = '2026-05-13T00:01:00Z';
  newer.resolvedAction = 'start-comparison';
  const result = findLatestResolvedDecision([older, newer], 'collision');
  assert.equal(result?.id, 'dec-new');
  assert.equal(result?.resolvedAction, 'start-comparison');
});

test('findLatestResolvedDecision skips unresolved decisions', () => {
  const resolved = makeCollisionDecision(['proj-1-a']);
  const pending: RunDecision = {
    id: 'dec-pending',
    type: 'engine_collision',
    title: 'collision',
    description: '',
    actions: [],
    createdAt: '2026-05-13T00:02:00Z',
  };
  const result = findLatestResolvedDecision([resolved, pending], 'collision');
  assert.equal(result?.id, 'dec-1');
});

test('findLatestResolvedDecision returns undefined when no decision matches reason', () => {
  const unrelated = makeCollisionDecision(['proj-1-a']);
  unrelated.type = 'engine_other' as unknown as RunDecision['type'];
  assert.equal(findLatestResolvedDecision([unrelated], 'collision'), undefined);
});

test('requiresCollisionPrecheck exempts only maintenance flows that reuse task dirs', () => {
  // Iterate FLOW_STEPS so a new flow added to the protocol auto-participates —
  // an explicit allow list of exempt flows + the inverse via FLOW_STEPS keys
  // guarantees the predicate stays aligned with both call sites.
  const EXEMPT: ReadonlySet<FlowType> = new Set(['merge-main', 'pr-complete']);
  for (const flow of Object.keys(FLOW_STEPS) as FlowType[]) {
    assert.equal(
      requiresCollisionPrecheck(flow),
      !EXEMPT.has(flow),
      `requiresCollisionPrecheck(${flow}) drifted from the exempt list`,
    );
  }
});

test('latestResolvedHumanGateDecision prefers latest approval after review request loop', () => {
  const decisions = [
    {
      id: 'request-extra',
      type: 'engine_human_gate',
      title: 'request',
      description: '',
      actions: [],
      createdAt: '2026-05-07T00:00:00.000Z',
      resolvedAt: '2026-05-07T00:01:00.000Z',
      resolvedAction: 'request-extra-review',
      selectionData: { feedback: 'please review again' },
    },
    {
      id: 'approval',
      type: 'engine_human_gate',
      title: 'approval',
      description: '',
      actions: [],
      createdAt: '2026-05-07T00:02:00.000Z',
      resolvedAt: '2026-05-07T00:03:00.000Z',
      resolvedAction: 'approve-publish',
      selectionData: { publicationTarget: 'ready' },
    },
  ] satisfies Run['decisions'];

  assert.equal(latestResolvedHumanGateDecision(decisions)?.id, 'approval');
  assert.equal(latestResolvedHumanGateDecision(decisions, true)?.id, 'approval');
  assert.equal(latestResolvedHumanGateDecision([decisions[0]], true)?.id, undefined);
});

test('human gate review requests replay once after stale engine resume', () => {
  const decision: RunDecision = {
    id: 'request-extra',
    type: 'engine_human_gate',
    title: 'request',
    description: '',
    actions: [],
    createdAt: '2026-05-07T00:00:00.000Z',
    resolvedAt: '2026-05-07T00:01:00.000Z',
    resolvedAction: 'request-extra-review',
    selectionData: { reviewRequest: { extraLoopsRequested: 1 } },
  };
  const actions: RunDecision['actions'] = [
    { id: 'request-extra-review', label: 'Request Extra Review', style: 'secondary' },
  ];

  assert.equal(isReplayableResolvedHumanGateDecision(decision, actions), true);
  assert.equal(
    markResolvedHumanGateReviewRequestConsumed(decision, '2026-05-07T00:02:00.000Z'),
    true,
  );
  assert.equal(isReplayableResolvedHumanGateDecision(decision, actions), false);
  assert.equal(
    markResolvedHumanGateReviewRequestConsumed(decision, '2026-05-07T00:03:00.000Z'),
    false,
  );
  assert.equal(decision.context?.reviewRequestConsumedAt, '2026-05-07T00:02:00.000Z');
});

test('human gate approvals remain replayable after resume', () => {
  const decision: RunDecision = {
    id: 'approval',
    type: 'engine_human_gate',
    title: 'approval',
    description: '',
    actions: [],
    createdAt: '2026-05-07T00:00:00.000Z',
    resolvedAt: '2026-05-07T00:01:00.000Z',
    resolvedAction: 'approve-publish',
    context: { reviewRequestConsumedAt: '2026-05-07T00:02:00.000Z' },
  };

  assert.equal(
    isReplayableResolvedHumanGateDecision(decision, [
      { id: 'approve-publish', label: 'Approve Publish', style: 'primary' },
    ]),
    true,
  );
});

test('latestResolvedHumanGateDecision(approvalOnly) accepts close-as-shipped resolutions', () => {
  const decisions = [
    {
      id: 'gate-1',
      type: 'engine_human_gate',
      title: 'gate',
      description: '',
      actions: [],
      createdAt: '2026-07-13T00:00:00Z',
      resolvedAt: '2026-07-13T00:05:00Z',
      resolvedAction: 'close-as-shipped',
    },
  ] as unknown as RunDecision[];
  const latest = latestResolvedHumanGateDecision(decisions, true);
  assert.equal(latest?.resolvedAction, 'close-as-shipped');
});
