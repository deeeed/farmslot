import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Events,
  type FleetRefreshSlotsCancelResult,
  type FleetRefreshSlotsResult,
  type FleetStatusResult,
  Methods,
  slotRecoveryEligibility,
  type SlotRefreshResult,
  type SlotStatus,
  type SlotWorkspace,
  slotWorkspaceIdentity,
} from '@farmslot/protocol';

import {
  type FleetRefreshClient,
  FleetRefreshViewModel,
  fleetWorkspaceRow,
} from '../src/fleet-refresh.js';

const workspace: SlotWorkspace = {
  epoch: 2,
  currentRunId: null,
  cleanupRunId: null,
  handoffRunId: null,
  branch: 'feature',
  headSha: 'a'.repeat(40),
  dirtyFingerprint: 'b'.repeat(64),
  recoveryId: null,
  observedAt: new Date().toISOString(),
  localDefaultSha: 'c'.repeat(40),
  defaultFetchedAt: null,
  remoteDefaultSha: 'c'.repeat(40),
  remoteObservedAt: new Date().toISOString(),
  behind: 3,
  remoteAdvanced: false,
  publication: 'pushed',
  dirtyCount: 0,
  unpublishedCount: 0,
};
function slot(
  id: string,
  work: Partial<SlotWorkspace> = {},
  fields: Partial<SlotStatus> = {},
): SlotStatus {
  return {
    slot: id,
    machine: 'node-a',
    platform: 'web',
    project: 'example',
    health: { ssh: 'OK', device: '-', devserver: '-', cdp: '-', fixtures: 'OK' },
    branch: 'feature',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: false,
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
    workspace: { ...workspace, ...work },
    ...fields,
  };
}
function setup(slots: SlotStatus[]) {
  const calls: Array<{ method: string; params: unknown }> = [];
  let context = 'farm-a';
  let failRead = false;
  const events = new Map<string, (payload: unknown) => void>();
  const client: FleetRefreshClient = {
    contextKey: () => context,
    request: async <T>(method: string, params: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method === Methods.FLEET_STATUS && failRead) {
        failRead = false;
        throw new Error('Read failed');
      }
      if (method === Methods.SLOT_REFRESH) {
        for (let index = 0; index < slots.length; index++) {
          const current = slots[index];
          slots[index] = {
            ...current,
            branch: 'main',
            workspace: { ...workspace, branch: 'main', publication: 'baseline', behind: 0 },
          };
        }
      }

      const requestId =
        typeof params === 'object' &&
        params !== null &&
        'requestId' in params &&
        typeof params.requestId === 'string'
          ? params.requestId
          : 'proof';
      let result:
        | FleetStatusResult
        | SlotRefreshResult
        | FleetRefreshSlotsResult
        | FleetRefreshSlotsCancelResult;
      if (method === Methods.FLEET_STATUS) {
        result = {
          fleet: {
            checkedAt: new Date().toISOString(),
            slots,
            summary: {
              total: slots.length,
              ready: slots.filter((slot) => slot.lifecycle === 'ready').length,
              busy: slots.filter((slot) => slot.lifecycle === 'busy').length,
              held: slots.filter((slot) => slot.lifecycle === 'held').length,
              manual: 0,
              disabled: 0,
              blocked: 0,
              warmCount: 0,
            },
          },
        };
      } else if (method === Methods.SLOT_REFRESH) {
        result = { requestId, refreshed: true, branch: 'main', advanced: true };
      } else if (method === Methods.FLEET_REFRESH_SLOTS) {
        result = { requestId, scheduled: 1, perSlotRequestIds: { shown: 'server-owned-row-id' } };
      } else if (method === Methods.FLEET_REFRESH_SLOTS_CANCEL) {
        result = { cancelled: true };
      } else throw new Error(`Unexpected method ${method}`);
      return result as T;
    },
    subscribe: (event, callback) => {
      events.set(event, callback);
      return () => events.delete(event);
    },
  };
  return {
    model: new FleetRefreshViewModel(client, () => `proof-${calls.length}`),
    calls,
    setContext: (value: string) => {
      context = value;
    },
    failNextRead: () => {
      failRead = true;
    },
    setSlots: (values: SlotStatus[]) => slots.splice(0, slots.length, ...values),
    emit: (event: string, payload: unknown) => events.get(event)?.(payload),
  };
}

test('bulk freezes visible membership and never includes held, dirty, unpublished or unknown work', async () => {
  const { model, calls } = setup([
    slot('shown'),
    slot('hidden'),
    slot('dirty', { dirtyCount: 1 }),
    slot('local', { publication: 'unpushed' }),
    slot('unknown', { publication: 'unknown' }),
    slot('held', {}, { lifecycle: 'held' }),
  ]);
  await model.load(['shown', 'dirty', 'local', 'unknown', 'held']);
  assert.equal(model.bulkCount, 1);
  await model.releaseIdle();
  const request = calls.find((call) => call.method === Methods.FLEET_REFRESH_SLOTS);
  assert.deepEqual(request?.params, {
    requestId: 'proof-1',
    slots: [
      {
        slotId: 'shown',
        mode: 'safe',
        release: true,
        expectedWorkspace: {
          epoch: 2,
          currentRunId: null,
          cleanupRunId: null,
          handoffRunId: null,
          branch: 'feature',
          headSha: 'a'.repeat(40),
          dirtyFingerprint: 'b'.repeat(64),
          recoveryId: null,
        },
      },
    ],
  });
  model.dispose();
});

test('bulk completion refreshes metadata and later identities without expanding scope or losing outcomes', async () => {
  const { model, calls, emit, setSlots } = setup([slot('shown'), slot('hidden')]);
  await model.load(['shown']);
  await model.releaseIdle();
  emit(Events.SCRIPT_OUTPUT, { requestId: 'server-owned-row-id', data: 'verified\n' });
  emit(Events.FLEET_REFRESH_SLOT_UPDATE, {
    requestId: 'proof-1',
    slotId: 'shown',
    status: 'refreshed',
  });
  setSlots([
    slot(
      'shown',
      { branch: 'main', headSha: 'd'.repeat(40), publication: 'baseline', behind: 0 },
      { branch: 'main' },
    ),
    slot('hidden'),
  ]);
  emit(Events.FLEET_REFRESH_SUMMARY, {
    requestId: 'proof-1',
    refreshed: 1,
    skipped: 0,
    failed: 0,
    cancelled: 0,
    durationMs: 1,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(model.phase, 'done');
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].branch, 'main');
  assert.equal(model.rows[0].publication, 'baseline');
  assert.equal(model.rows[0].behind, '0 behind main');
  assert.equal(model.rows[0].status, 'refreshed');
  assert.deepEqual(model.rows[0].log, ['verified']);
  await model.releaseIdle();
  const request = calls.filter((call) => call.method === Methods.FLEET_REFRESH_SLOTS).at(-1);
  assert.deepEqual(request?.params, {
    requestId: 'proof-3',
    slots: [
      {
        slotId: 'shown',
        mode: 'safe',
        release: true,
        expectedWorkspace: slotWorkspaceIdentity({
          ...workspace,
          branch: 'main',
          headSha: 'd'.repeat(40),
        }),
      },
    ],
  });
  model.dispose();
});

test('a failed bulk completion read preserves outcomes but removes stale release authority', async () => {
  const { model, emit, failNextRead } = setup([slot('shown')]);
  await model.load(['shown']);
  await model.releaseIdle();
  emit(Events.FLEET_REFRESH_SLOT_UPDATE, {
    requestId: 'proof-1',
    slotId: 'shown',
    status: 'refreshed',
  });
  failNextRead();
  emit(Events.FLEET_REFRESH_SUMMARY, {
    requestId: 'proof-1',
    refreshed: 1,
    skipped: 0,
    failed: 0,
    cancelled: 0,
    durationMs: 1,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(model.phase, 'error');
  assert.equal(model.rows[0].status, 'refreshed');
  assert.equal(model.rows[0].eligibility.reason, 'unknown');
  assert.equal(model.bulkCount, 0);
  assert.match(model.error, /Read failed/);
  model.dispose();
});

test('behind counts name the actual project default branch', () => {
  assert.equal(
    fleetWorkspaceRow(slot('release', { defaultBranch: 'develop' })).behind,
    '3 behind develop',
  );
});

test('discard requires an explicit confirmation and sends the exact observed content identity', async () => {
  const { model, calls } = setup([
    slot('dirty', { dirtyCount: 2, publication: 'unpushed', unpublishedCount: 1 }),
  ]);
  await model.load(['dirty']);
  await model.release('dirty');
  assert.ok(model.confirmation);
  assert.equal(calls.length, 1);
  model.cancelConfirmation();
  assert.equal(calls.length, 1);
  await model.release('dirty');
  await model.confirmDiscard();
  const request = calls.find((call) => call.method === Methods.SLOT_REFRESH);
  assert.ok(request);
  assert.equal(typeof request.params, 'object');
  assert.deepEqual(request.params, {
    slotId: 'dirty',
    mode: 'force',
    release: true,
    expectedWorkspace: {
      epoch: 2,
      currentRunId: null,
      cleanupRunId: null,
      handoffRunId: null,
      branch: 'feature',
      headSha: 'a'.repeat(40),
      dirtyFingerprint: 'b'.repeat(64),
      recoveryId: null,
    },
    requestId: 'proof-1',
  });
  model.dispose();
});

test('protected owner and unknown publication cannot authorize discard', () => {
  assert.equal(
    slotRecoveryEligibility(slot('gate', { protectedReason: 'publication gate' })).allowed,
    false,
  );
  assert.equal(
    slotRecoveryEligibility(slot('handoff', { handoffRunId: 'incoming' })).allowed,
    false,
  );
  assert.equal(
    slotRecoveryEligibility(slot('local', { publication: 'unknown', dirtyCount: 1 }))
      .confirmationRequired,
    false,
  );
  const row = fleetWorkspaceRow(slot('stale', { behind: 0, remoteAdvanced: true }));
  assert.match(row.behind, /remote advanced/);
  assert.equal(fleetWorkspaceRow(slot('unknown', { behind: null })).behind, 'Behind main unknown');
});

test('a release refreshes the shared labels from the gateway after verification', async () => {
  const { model } = setup([slot('published')]);
  await model.load(['published']);
  await model.release('published');
  assert.equal(model.rows[0]?.branch, 'main');
  assert.equal(model.rows[0]?.publication, 'baseline');
  assert.equal(model.rows[0]?.behind, '0 behind main');
  assert.equal(model.rows[0]?.status, 'refreshed');
  model.dispose();
});

test('expired evidence only permits release after a fresh inspection succeeds', async () => {
  const slots = [slot('expired', { observedAt: '2000-01-01T00:00:00Z' })];
  const { model, calls } = setup(slots);
  await model.load(['expired']);
  assert.equal(model.bulkCount, 0);
  assert.equal(model.rows[0]?.action, 'Release and update to main');
  slots[0] = slot('expired');
  await model.release('expired');
  assert.equal(calls.filter((call) => call.method === Methods.SLOT_REFRESH).length, 1);
  model.dispose();
});

test('ordinary terminal owners allow a guarded single release while protected holds stay excluded', () => {
  const ordinary = slot(
    'terminal',
    { currentRunId: 'finished', terminalOwner: true },
    { currentRunId: 'finished', lifecycle: 'held' },
  );
  assert.equal(slotRecoveryEligibility(ordinary).allowed, true);
  assert.equal(slotRecoveryEligibility(ordinary).bulkAllowed, false);
  assert.equal(
    slotRecoveryEligibility({ ...ordinary, heldReason: 'retained hold' }).allowed,
    false,
  );
  assert.equal(
    slotRecoveryEligibility({
      ...ordinary,
      workspace: { ...ordinary.workspace!, protectedReason: 'result decision' },
    }).allowed,
    false,
  );
});

test('expired metadata permits inspecting a bulk scope without authorizing a release', async () => {
  const { fleetRecoverySummary } = await import('../src/fleet-refresh.js');
  const slots = [slot('expired', { observedAt: '2000-01-01T00:00:00Z' })];
  assert.deepEqual(fleetRecoverySummary(slots), { count: 0, canInspect: true });
  const { model, calls } = setup(slots);
  await model.load(['expired']);
  await model.releaseIdle();
  assert.equal(calls.filter((call) => call.method === Methods.FLEET_REFRESH_SLOTS).length, 0);
  model.dispose();
});

test('an authoritative unowned workspace does not fall back to an older slot owner', () => {
  const released = slot('released', { currentRunId: null }, { currentRunId: 'older-owner' });
  assert.equal(fleetWorkspaceRow(released).owner, 'Unowned');
  assert.equal(slotRecoveryEligibility(released).bulkInspectable, true);
});

test('changing farms after inspection cannot send the old workspace identity to the new farm', async () => {
  const { model, calls, setContext } = setup([slot('same-slot')]);
  await model.load(['same-slot']);
  setContext('farm-b');
  await model.release('same-slot');
  assert.equal(calls.filter((call) => call.method === Methods.SLOT_REFRESH).length, 0);
  model.dispose();
});

test('farm changes invalidate both bulk requests and an open discard confirmation', async () => {
  for (const confirm of [false, true]) {
    const { model, calls, setContext } = setup([
      slot('same-slot', confirm ? { dirtyCount: 1 } : {}),
    ]);
    await model.load(['same-slot']);
    if (confirm) await model.release('same-slot');
    setContext('farm-b');
    if (confirm) await model.confirmDiscard();
    else await model.releaseIdle();
    assert.equal(
      calls.filter(
        (call) =>
          call.method === Methods.SLOT_REFRESH || call.method === Methods.FLEET_REFRESH_SLOTS,
      ).length,
      0,
    );
    model.dispose();
  }
});

test('a failed re-inspection clears old release authority', async () => {
  const { model, calls, failNextRead } = setup([slot('same-slot')]);
  await model.load(['same-slot']);
  failNextRead();
  await model.load(['same-slot']);
  await model.release('same-slot');
  assert.equal(calls.filter((call) => call.method === Methods.SLOT_REFRESH).length, 0);
  assert.equal(model.rows.length, 0);
  model.dispose();
});

test('bulk logs follow server-owned request identities instead of assuming their format', async () => {
  const { model, emit } = setup([slot('shown')]);
  await model.load(['shown']);
  await model.releaseIdle();
  emit(Events.SCRIPT_OUTPUT, {
    requestId: 'server-owned-row-id',
    stream: 'stdout',
    data: 'Verified fixture\n',
    timestamp: Date.now(),
  });
  assert.deepEqual(model.rows[0]?.log, ['Verified fixture']);
  emit(Events.SCRIPT_OUTPUT, {
    requestId: 'unrelated',
    stream: 'stdout',
    data: 'Foreign log\n',
    timestamp: Date.now(),
  });
  assert.deepEqual(model.rows[0]?.log, ['Verified fixture']);
  model.dispose();
});
