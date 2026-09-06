import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, SlotStatus } from '@farmslot/protocol';

import {
  activeRunIds,
  activeRunSlotIds,
  branchContainsJiraKey,
  evaluateSlotIdentityPolicy,
  failedRunSlotCleanup,
  findBestSlot,
  isCdpLive,
  isDispatchStaleBranch,
  isFreeSlot,
  isReplaceableWarmSlot,
  parkPreservedSlotIds,
  pickedSlotIneligibility,
  SLOT_STALE_BRANCH_SCORE_PENALTY,
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

test('replaceable warm slots exclude active-run transitions and manual work', () => {
  const warm = slot({ slot: 'warm', agent: 'working', currentRunId: null });
  assert.equal(isReplaceableWarmSlot(warm, new Set(), new Set()), true);
  assert.equal(isReplaceableWarmSlot(warm, new Set(['warm']), new Set()), false);
  assert.equal(
    isReplaceableWarmSlot(
      slot({ slot: 'stale-owner', agent: 'working', currentRunId: 'finished' }),
      new Set(),
      new Set(),
    ),
    true,
  );
  assert.equal(
    isReplaceableWarmSlot(
      slot({ slot: 'manual', lifecycle: 'manual', agent: 'working' }),
      new Set(),
      new Set(),
    ),
    false,
  );
  assert.deepEqual(
    activeRunSlotIds([
      { id: 'active', slotId: 'warm', status: 'monitoring' },
      { id: 'done', slotId: 'old', status: 'done' },
    ]),
    new Set(['warm']),
  );
  assert.deepEqual(
    activeRunSlotIds([{ id: 'active', slotId: 'warm', status: 'monitoring' }], 'active'),
    new Set(),
  );
  assert.deepEqual(
    activeRunIds([
      { id: 'active', status: 'monitoring' },
      { id: 'done', status: 'done' },
    ]),
    new Set(['active']),
  );
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

test("a slot still in a terminal run's teardown is not free for dispatch", () => {
  // Why the work-graph tick may run BEFORE slot teardown (ADR-053): a tick
  // enqueues backlog work and never binds a slot — `QueueItem` carries no slot
  // field — so selection happens later, here, and this is what refuses a slot
  // whose teardown has not finished. Without it, ticking first would hand the
  // dying run's slot to the next one.
  assert.equal(
    isFreeSlot(slot({ slot: 'macwork-ff-3', lifecycle: 'busy', phase: 'releasing' })),
    false,
  );
  assert.equal(
    isFreeSlot(slot({ slot: 'macwork-ff-3', lifecycle: 'busy', phase: 'working' })),
    false,
  );
  // And the slot the teardown finished on is available again.
  assert.equal(isFreeSlot(slot({ slot: 'macwork-ff-3', lifecycle: 'ready', agent: 'idle' })), true);
});

test('pickedSlotIneligibility rejects ghosts, foreign projects, and undispatchable slots', () => {
  const base = {
    enabled: true,
    lifecycle: 'ready',
    missingFromPool: false,
    project: 'proj-a',
  } as never;
  assert.equal(pickedSlotIneligibility(base, 'proj-a'), null);
  assert.match(pickedSlotIneligibility(undefined, 'proj-a') ?? '', /not in the fleet/);
  assert.match(
    pickedSlotIneligibility({ ...(base as object), missingFromPool: true } as never, 'proj-a') ??
      '',
    /missing from the pool/,
  );
  assert.match(pickedSlotIneligibility(base, 'proj-b') ?? '', /belongs to project/);
  assert.match(
    pickedSlotIneligibility({ ...(base as object), enabled: false } as never, 'proj-a') ?? '',
    /disabled in the pool/,
  );
  assert.match(
    pickedSlotIneligibility({ ...(base as object), lifecycle: 'manual' } as never, 'proj-a') ?? '',
    /lifecycle is 'manual'/,
  );
});

test('failedRunSlotCleanup resets only owned slots and clears only own reservations', () => {
  const liveOwner = (id: string) => (id === 'prior' ? { status: 'monitoring' } : undefined);
  const deadOwner = (id: string) => (id === 'prior' ? { status: 'cancelled' } : undefined);
  assert.equal(failedRunSlotCleanup({ current_run_id: 'me' }, 'me', liveOwner), 'reset');
  assert.equal(
    failedRunSlotCleanup({ current_run_id: 'me', handoff_run_id: 'me' }, 'me', liveOwner),
    'reset',
  );
  assert.equal(
    failedRunSlotCleanup({ current_run_id: 'me', handoff_run_id: 'incoming' }, 'me', liveOwner),
    'release-keep-handoff',
  );
  assert.equal(
    failedRunSlotCleanup({ current_run_id: 'prior', handoff_run_id: 'me' }, 'me', liveOwner),
    'clear-reservation',
  );
  // The reservation holder is the sanctioned successor: a dead, unknown, or
  // absent owner means nobody else will tear the slot down.
  assert.equal(
    failedRunSlotCleanup({ current_run_id: 'prior', handoff_run_id: 'me' }, 'me', deadOwner),
    'reset',
  );
  assert.equal(
    failedRunSlotCleanup({ current_run_id: 'vanished', handoff_run_id: 'me' }, 'me', liveOwner),
    'reset',
  );
  assert.equal(failedRunSlotCleanup({ handoff_run_id: 'me' }, 'me', liveOwner), 'reset');
  assert.equal(failedRunSlotCleanup({ current_run_id: 'prior' }, 'me', liveOwner), 'none');
  assert.equal(failedRunSlotCleanup({}, 'me', liveOwner), 'none');
});

// ─── ADR-054 free-slot at an operator wait ───

function freedParkRecord(runId: string, slotId: string): Run['park'] {
  return {
    version: 1,
    operationId: `park-${runId}`,
    previewId: `preview-${runId}`,
    runId,
    generation: 1,
    machine: 'macwork',
    slotId,
    mode: 'release',
    phase: 'parked',
    slotDisposition: 'freed',
    slotFreedAt: '2026-09-04T00:00:10.000Z',
    prePauseStatus: 'human-gating',
    prePauseCurrentStep: { index: 1, name: 'human-gate', status: 'running' },
    resourceManifest: {
      capturedAt: '2026-09-04T00:00:00.000Z',
      resources: [],
      capabilityLeases: [],
    },
    recoveryHandle: null,
    errors: [],
    residuals: { runner: 'stopped', resources: [] },
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:10.000Z',
  };
}

test('activeRunSlotIds ignores a run whose park freed its slot', () => {
  const parked = {
    id: 'parked',
    slotId: 'gate-slot',
    status: 'human-gating' as const,
    park: freedParkRecord('parked', 'gate-slot'),
  };
  assert.deepEqual(activeRunSlotIds([parked]), new Set());
  // Intent alone is not enough: until the ownership release landed the run
  // still occupies the slot.
  assert.deepEqual(
    activeRunSlotIds([{ ...parked, park: { ...parked.park!, slotFreedAt: undefined } }]),
    new Set(['gate-slot']),
  );
});

test('findBestSlot selects the slot a gate park freed', () => {
  const freed = slot({ slot: 'gate-slot', branch: 'fix/gate', currentRunId: null });
  assert.equal(findBestSlot([freed], 'demo-farm')?.slot, 'gate-slot');
  // While the gate-held run held it, fleet refresh published it busy/working.
  const held = slot({
    slot: 'gate-slot',
    lifecycle: 'busy',
    phase: 'review-gate',
    agent: 'working',
    currentRunId: 'parked',
  });
  assert.equal(findBestSlot([held], 'demo-farm'), null);
});

// ─── ADR-054 free-slot: a gate-parked run's slot is not this cleanup's to take ───

function gateParkedOwner(overrides: Record<string, unknown> = {}) {
  return {
    status: 'blocked',
    park: {
      version: 1,
      operationId: 'op',
      previewId: 'preview',
      runId: 'parked',
      generation: 1,
      machine: 'macwork',
      slotId: 'slot-a',
      mode: 'release',
      phase: 'resources-stopping',
      slotDisposition: 'freed',
      prePauseStatus: 'blocked',
      prePauseCurrentStep: { index: 1, name: 'human-gate', status: 'running' },
      resourceManifest: { capturedAt: 'x', resources: [], capabilityLeases: [] },
      recoveryHandle: null,
      errors: [],
      residuals: { runner: 'stopped', resources: [] },
      createdAt: 'x',
      updatedAt: 'x',
      ...overrides,
    },
  } as never;
}

test('failedRunSlotCleanup leaves the slot alone while a gate park is in flight', () => {
  const slot = { slot: 'slot-a', current_run_id: 'parked', handoff_run_id: null };
  // The run still owns the row mid-park, so the plan would otherwise reset it —
  // publishing the slot ready while resources stop and the branch is still out.
  assert.equal(
    failedRunSlotCleanup(slot, 'parked', () => gateParkedOwner()),
    'none',
  );
});

test('failedRunSlotCleanup leaves a freed slot to its successor', () => {
  // The park already handed this row on; resetting it would tear down the
  // successor's work.
  const slot = { slot: 'slot-a', current_run_id: 'parked', handoff_run_id: null };
  assert.equal(
    failedRunSlotCleanup(slot, 'parked', () =>
      gateParkedOwner({ phase: 'parked', slotFreedAt: '2026-09-05T00:00:10.000Z' }),
    ),
    'none',
  );
});

test('failedRunSlotCleanup still resets for a park that settled without changing anything', () => {
  // Nothing landed — not even the runner stop — so the run owns its slot and
  // its worker exactly as before, and an ordinary failure must still clean it
  // up. The fence must not become a leak.
  const slot = { slot: 'slot-a', current_run_id: 'parked', handoff_run_id: null };
  assert.equal(
    failedRunSlotCleanup(slot, 'parked', () =>
      gateParkedOwner({
        phase: 'partial',
        residuals: { runner: 'running', resources: [] },
      }),
    ),
    'reset',
  );
});

test('failedRunSlotCleanup leaves the slot alone for a partial park that stopped the worker', () => {
  // The park died after stopping the runner. The run still owns the row, but it
  // is fenced out of its own gate until a restore, so this cleanup is not the
  // one that gets to decide the slot's fate.
  const slot = { slot: 'slot-a', current_run_id: 'parked', handoff_run_id: null };
  assert.equal(
    failedRunSlotCleanup(slot, 'parked', () => gateParkedOwner({ phase: 'partial' })),
    'none',
  );
});

test('failedRunSlotCleanup is unchanged for a run with no park record', () => {
  const slot = { slot: 'slot-a', current_run_id: 'plain', handoff_run_id: null };
  assert.equal(
    failedRunSlotCleanup(slot, 'plain', () => ({ status: 'failed' })),
    'reset',
  );
});

// ─── ADR-054 free-slot: the detached-HEAD exception is dispatch-only and scoped ───

const PARKED_HEAD = 'sha-parked-tip';

test('a detached slot scores stale unless a park record claims it', () => {
  const detached = slot({ slot: 'slot-detached', branch: 'HEAD', headSha: PARKED_HEAD });

  // No park claim: the commits on that detached HEAD are unaccounted for, so
  // dispatch must still charge the stale penalty and prepare must reset it.
  assert.equal(isDispatchStaleBranch(detached), true);
  assert.equal(slotScore(detached), SLOT_STALE_BRANCH_SCORE_PENALTY);

  // A park record whose recorded tip is what the slot is sitting on: the branch
  // ref survives there, so the slot is genuinely dispatchable.
  const claimed = new Map([['slot-detached', [{ runId: 'run-parked', headSha: PARKED_HEAD }]]]);
  assert.equal(isDispatchStaleBranch(detached, undefined, claimed), false);
  assert.equal(slotScore(detached, undefined, { parkPreservedSlotIds: claimed }), 0);

  // The exception is keyed on the slot, not on "detached" in general.
  assert.equal(
    isDispatchStaleBranch(
      detached,
      undefined,
      new Map([['other-slot', [{ runId: 'run-parked', headSha: PARKED_HEAD }]]]),
    ),
    true,
  );
});

test('a stale park record does not excuse an unrelated detached checkout', () => {
  // The park detached this slot, a successor then took it, finished, and left
  // its own detached commits behind. The park record still names the slot, but
  // the commits sitting there now are nobody's accounted-for work.
  const moved = slot({ slot: 'slot-detached', branch: 'HEAD', headSha: 'sha-successor-left-this' });
  const claimed = new Map([['slot-detached', [{ runId: 'run-parked', headSha: PARKED_HEAD }]]]);

  assert.equal(
    isDispatchStaleBranch(moved, undefined, claimed),
    true,
    'a slot id match alone must not suppress the stale penalty',
  );
  assert.equal(
    slotScore(moved, undefined, { parkPreservedSlotIds: claimed }),
    SLOT_STALE_BRANCH_SCORE_PENALTY,
  );

  // A slot whose head the refresh could not read is not evidence either.
  const unknownHead = slot({ slot: 'slot-detached', branch: 'HEAD' });
  assert.equal(isDispatchStaleBranch(unknownHead, undefined, claimed), true);

  // Ownership is the other admissible evidence: the park's own run still holds
  // the row, so the checkout is still the one the record describes.
  const stillOwned = slot({
    slot: 'slot-detached',
    branch: 'HEAD',
    headSha: 'sha-successor-left-this',
    currentRunId: 'run-parked',
  });
  assert.equal(isDispatchStaleBranch(stillOwned, undefined, claimed), false);
});

test('parkPreservedSlotIds lists only slots whose detach actually landed', () => {
  const detachedAt = '2026-09-05T00:00:00.000Z';
  const base = {
    version: 1,
    operationId: 'op',
    previewId: 'preview',
    generation: 1,
    machine: 'macwork',
    mode: 'release',
    phase: 'parked',
    slotDisposition: 'freed',
    prePauseStatus: 'blocked',
    prePauseCurrentStep: { index: 1, name: 'human-gate', status: 'running' },
    resourceManifest: { capturedAt: detachedAt, resources: [], capabilityLeases: [] },
    recoveryHandle: null,
    errors: [],
    residuals: { runner: 'stopped', resources: [] },
    createdAt: detachedAt,
    updatedAt: detachedAt,
  };
  const ids = parkPreservedSlotIds([
    {
      id: 'a',
      slotId: 'landed',
      park: {
        ...base,
        runId: 'a',
        slotId: 'landed',
        preservedWorkspace: { branch: 'w/a', headSha: 'sha-a', detachedAt },
      },
    },
    // Intent recorded, detach not yet performed: the branch is still checked
    // out, so this slot is not detached and has nothing to except.
    {
      id: 'b',
      slotId: 'planned',
      park: {
        ...base,
        runId: 'b',
        slotId: 'planned',
        preservedWorkspace: { branch: 'w/b', headSha: 'sha-b' },
      },
    },
    { id: 'c', slotId: 'plain', park: null },
  ] as never);

  assert.deepEqual([...ids.keys()], ['landed']);
  assert.deepEqual(ids.get('landed'), [{ runId: 'a', headSha: 'sha-a' }]);
});

test('findBestSlot ranks a park-preserved slot the same way slotScore does', () => {
  const detached = slot({ slot: 'slot-detached', branch: 'HEAD', headSha: PARKED_HEAD });
  const stale = slot({ slot: 'slot-stale', branch: 'feat/leftover' });
  const claimed = new Map([['slot-detached', [{ runId: 'run-parked', headSha: PARKED_HEAD }]]]);

  // Without the claim both are stale, so the tie is broken by input order and
  // the detached slot has no advantage.
  assert.equal(
    findBestSlot([stale, detached], 'demo-farm')?.slot,
    'slot-stale',
    'a plain detached slot ranks no better than any other stale slot',
  );

  // With the claim the detached slot is idle, so it must win — the AC that
  // names findBestSlot. Ranking here disagreeing with find-slot-step is the
  // drift the shared set exists to prevent.
  assert.equal(
    findBestSlot([stale, detached], 'demo-farm', { parkPreservedSlotIds: claimed })?.slot,
    'slot-detached',
  );
});

test('every park claim on a slot is kept, so creation order cannot hide the matching one', () => {
  const detachedAt = '2026-09-05T00:00:00.000Z';
  const base = {
    version: 1,
    operationId: 'op',
    previewId: 'preview',
    generation: 1,
    machine: 'macwork',
    mode: 'release',
    phase: 'parked',
    slotDisposition: 'freed',
    prePauseStatus: 'blocked',
    prePauseCurrentStep: { index: 1, name: 'human-gate', status: 'running' },
    resourceManifest: { capturedAt: detachedAt, resources: [], capabilityLeases: [] },
    recoveryHandle: null,
    errors: [],
    residuals: { runner: 'stopped', resources: [] },
    createdAt: detachedAt,
    updatedAt: detachedAt,
  };
  // Two runs claim the same slot. Run order is creation order, which need not
  // be parking order — so the CURRENT checkout may match the first claim.
  const claims = parkPreservedSlotIds([
    {
      id: 'run-old',
      slotId: 'slot-shared',
      park: {
        ...base,
        runId: 'run-old',
        slotId: 'slot-shared',
        preservedWorkspace: { branch: 'w/old', headSha: 'sha-old', detachedAt },
      },
    },
    {
      id: 'run-new',
      slotId: 'slot-shared',
      park: {
        ...base,
        runId: 'run-new',
        slotId: 'slot-shared',
        preservedWorkspace: { branch: 'w/new', headSha: 'sha-new', detachedAt },
      },
    },
  ] as never);

  assert.equal(claims.get('slot-shared')?.length, 2);

  // Either claim matching is enough. Keeping only the last one written made the
  // earlier claim unmatchable even when it described the actual checkout.
  for (const headSha of ['sha-old', 'sha-new']) {
    assert.equal(
      isDispatchStaleBranch(
        slot({ slot: 'slot-shared', branch: 'HEAD', headSha }),
        undefined,
        claims,
      ),
      false,
      `claim ${headSha} should match`,
    );
  }
  // A third, unrelated commit still scores stale.
  assert.equal(
    isDispatchStaleBranch(
      slot({ slot: 'slot-shared', branch: 'HEAD', headSha: 'sha-unrelated' }),
      undefined,
      claims,
    ),
    true,
  );
});
