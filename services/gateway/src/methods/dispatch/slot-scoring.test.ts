import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotStatus } from '@farmslot/protocol';

import {
  branchContainsJiraKey,
  evaluateSlotIdentityPolicy,
  findBestSlot,
  isCdpLive,
  isFreeSlot,
  slotClaimBlockedByHandoff,
  slotClaimBlockedByLiveOwner,
  slotClaimBlockedByRelease,
  slotScore,
  validateSlot,
} from './slot-scoring.js';

function slot(overrides: Partial<SlotStatus> & { slot: string }): SlotStatus {
  return {
    machine: 'macwork',
    platform: 'ios',
    project: 'demo-farm',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'Wallet', fixtures: 'OK' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: true,
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
    ...overrides,
  } as SlotStatus;
}

test('isFreeSlot gates on ghost, lifecycle, and working agent', () => {
  assert.equal(isFreeSlot(slot({ slot: 'a' })), true);
  assert.equal(isFreeSlot(slot({ slot: 'a', missingFromPool: true })), false);
  assert.equal(isFreeSlot(slot({ slot: 'a', lifecycle: 'busy' })), false);
  assert.equal(isFreeSlot(slot({ slot: 'a', lifecycle: 'held' })), false);
  assert.equal(isFreeSlot(slot({ slot: 'a', agent: 'working' })), false);
});

test('isCdpLive matches the shared protocol semantics', () => {
  assert.equal(isCdpLive('Wallet'), true);
  for (const dead of ['OFF', '-', 'FAIL', 'Other']) assert.equal(isCdpLive(dead), false);
});

test('slotScore: host load dominates, target-branch bonus beats stale penalty', () => {
  const clean = slot({ slot: 'clean' });
  assert.equal(slotScore(clean), 0);

  const redHost = slot({
    slot: 'red',
    hostLoad: { cpuPercent: 95, memoryPercent: 90, diskPercent: 50, headroom: 'red' },
  });
  assert.equal(slotScore(redHost), 100);

  const yellowHost = slot({
    slot: 'yellow',
    hostLoad: { cpuPercent: 70, memoryPercent: 60, diskPercent: 50, headroom: 'yellow' },
  });
  assert.equal(slotScore(yellowHost), 20);

  // A slot already on the PR's head branch gets the decisive bonus …
  const onTarget = slot({ slot: 'on-target', branch: 'feat/pr-branch' });
  assert.equal(slotScore(onTarget, 'feat/pr-branch'), -100);
  // … but not when its host is red.
  const onTargetRed = slot({
    slot: 'on-target-red',
    branch: 'feat/pr-branch',
    hostLoad: { cpuPercent: 95, memoryPercent: 90, diskPercent: 50, headroom: 'red' },
  });
  assert.ok(slotScore(onTargetRed, 'feat/pr-branch') > 0);

  // A stale (non-tracking) branch without target affinity is penalized.
  const stale = slot({ slot: 'stale', branch: 'feat/old-work' });
  assert.ok(slotScore(stale) >= 50);
});

test('slotScore: family affinity bonus and health tiebreakers', () => {
  const familySlot = slot({ slot: 'fam', currentFamilyId: 'family-1' });
  assert.equal(slotScore(familySlot, undefined, { familyId: 'family-1' }), -75);

  const degraded = slot({
    slot: 'deg',
    health: { ssh: 'LOCAL', device: 'sim:OFF', devserver: 'OK', cdp: 'OFF', fixtures: '2/3' },
  });
  // cdp 5 + device 5 + fixtures 1
  assert.equal(slotScore(degraded), 11);
});

test('findBestSlot honors allow-list, identity policy, and CDP preference', () => {
  const best = slot({ slot: 'best' });
  const noCdp = slot({
    slot: 'no-cdp',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OFF', fixtures: 'OK' },
  });
  const otherProject = slot({ slot: 'other', project: 'elsewhere' });
  const claimed = slot({
    slot: 'claimed',
    currentRunId: 'run-1',
    currentTicketOrPr: 'TICKET-1',
    currentFlowType: 'dev',
  });

  assert.equal(findBestSlot([best, noCdp, otherProject], 'demo-farm')?.slot, 'best');
  // Allow-list narrows the candidates.
  assert.equal(
    findBestSlot([best, noCdp], 'demo-farm', { allowedSlots: ['no-cdp'] })?.slot,
    'no-cdp',
  );
  // Non-comparison requests carry no runId, so a claimed slot stays eligible
  // (policy allows); the strict comparison lane blocks the identity mismatch.
  assert.equal(
    findBestSlot([claimed], 'demo-farm', { familyId: 'other-family', lane: 'production' })?.slot,
    'claimed',
  );
  assert.equal(
    findBestSlot([claimed], 'demo-farm', { familyId: 'other-family', lane: 'comparison' }),
    null,
  );
  // CDP-live candidates win even at equal score: noCdp (cdp 5) vs a live slot
  // with a device penalty (5) tie on points; the hard CDP filter decides.
  const liveButDegraded = slot({
    slot: 'live-degraded',
    health: { ssh: 'LOCAL', device: 'sim:OFF', devserver: 'OK', cdp: 'Wallet', fixtures: 'OK' },
  });
  assert.equal(slotScore(liveButDegraded), slotScore(noCdp));
  assert.equal(findBestSlot([noCdp, liveButDegraded], 'demo-farm')?.slot, 'live-degraded');
});

test('validateSlot explains disabled/manual/working/busy and accepts held', () => {
  assert.equal(validateSlot(slot({ slot: 'a' })), null);
  assert.equal(validateSlot(slot({ slot: 'a', lifecycle: 'held' })), null);
  assert.match(validateSlot(slot({ slot: 'a', lifecycle: 'disabled' })) ?? '', /disabled/u);
  assert.match(validateSlot(slot({ slot: 'a', lifecycle: 'manual' })) ?? '', /manual/u);
  assert.match(validateSlot(slot({ slot: 'a', agent: 'working' })) ?? '', /working/u);
  assert.match(
    validateSlot(slot({ slot: 'a', lifecycle: 'busy', phase: 'preparing' })) ?? '',
    /busy \(preparing\)/u,
  );
});

test('evaluateSlotIdentityPolicy: same run allows, mismatched identity blocks', () => {
  assert.equal(evaluateSlotIdentityPolicy({ runId: 'r1' }, { runId: 'r1' }).action, 'allow');
  // Fresh slot (no identity) allows any request.
  assert.equal(evaluateSlotIdentityPolicy({}, { runId: 'r2', ticket: 'T-2' }).action, 'allow');
  // Different run + different ticket/family blocks…
  assert.equal(
    evaluateSlotIdentityPolicy(
      { runId: 'r1', ticket: 'T-1', flow: 'dev', familyId: 'f1', lane: 'production' },
      { runId: 'r2', ticket: 'T-2', flow: 'dev', familyId: 'f2', lane: 'production' },
    ).action,
    'block',
  );
  // …but scrubs instead of blocking in validation mode.
  assert.equal(
    evaluateSlotIdentityPolicy(
      { runId: 'r1', ticket: 'T-1', flow: 'dev', familyId: 'f1', lane: 'production' },
      { runId: 'r2', ticket: 'T-2', flow: 'dev', familyId: 'f2', lane: 'production' },
      'validation',
    ).action,
    'scrub',
  );
  // Family follow-up on the same family/lane is allowed.
  assert.equal(
    evaluateSlotIdentityPolicy(
      { runId: 'r1', ticket: 'T-1', flow: 'dev', familyId: 'f1', lane: 'production' },
      { runId: 'r2', ticket: 'T-9', flow: 'pr-complete', familyId: 'f1', lane: 'production' },
    ).action,
    'allow',
  );
});

test('evaluateSlotIdentityPolicy: comparison lane is strict', () => {
  // A comparison run may claim a fresh slot only with fork/family provenance.
  assert.equal(evaluateSlotIdentityPolicy({}, { runId: 'r2', lane: 'comparison' }).action, 'block');
  assert.equal(
    evaluateSlotIdentityPolicy({}, { runId: 'r2', lane: 'comparison', parentRunId: 'r1' }).action,
    'allow',
  );
  assert.equal(
    evaluateSlotIdentityPolicy({}, { runId: 'r2', lane: 'comparison', familyId: 'f1' }).action,
    'allow',
  );
});

test('branchContainsJiraKey matches whole ticket slugs only', () => {
  assert.equal(branchContainsJiraKey('fix/proj-123-crash', 'PROJ-123'), true);
  assert.equal(branchContainsJiraKey('fix/proj-1234-crash', 'PROJ-123'), false);
  assert.equal(branchContainsJiraKey('main', 'PROJ-123'), false);
});

test('slotClaimBlockedByRelease refuses only slots mid-release', () => {
  assert.equal(slotClaimBlockedByRelease({ phase: 'releasing' }), 'slot is mid-release');
  assert.equal(slotClaimBlockedByRelease({ phase: 'dispatching' }), null);
  assert.equal(slotClaimBlockedByRelease({ phase: 'working' }), null);
  assert.equal(slotClaimBlockedByRelease({}), null);
});

test('slotClaimBlockedByLiveOwner blocks only live non-terminal owners', () => {
  const lookup = (id: string) =>
    ({ live: { status: 'monitoring' }, dead: undefined, finished: { status: 'done' } })[
      id as 'live'
    ];
  assert.equal(slotClaimBlockedByLiveOwner({}, 'me', lookup), null);
  assert.equal(slotClaimBlockedByLiveOwner({ current_run_id: 'me' }, 'me', lookup), null);
  assert.equal(slotClaimBlockedByLiveOwner({ current_run_id: 'dead' }, 'me', lookup), null);
  assert.equal(slotClaimBlockedByLiveOwner({ current_run_id: 'finished' }, 'me', lookup), null);
  assert.match(
    slotClaimBlockedByLiveOwner({ current_run_id: 'live' }, 'me', lookup) ?? '',
    /claimed by live run live/,
  );
});

test('slotClaimBlockedByHandoff blocks foreign reservations only', () => {
  assert.equal(slotClaimBlockedByHandoff({}, 'me'), null);
  assert.equal(slotClaimBlockedByHandoff({ handoff_run_id: 'me' }, 'me'), null);
  assert.match(
    slotClaimBlockedByHandoff({ handoff_run_id: 'other' }, 'me') ?? '',
    /reserved for handoff to run other/,
  );
});
