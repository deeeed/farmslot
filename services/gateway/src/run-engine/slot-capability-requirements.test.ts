import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { RuntimeCapabilityCatalogEntry, SlotStatus } from '@farmslot/protocol';

import {
  resolveDispatchPreviewFromFleet,
  selectBranchAffinityEligibleSlots,
} from '../methods/dispatch/preview.js';
import { findBestSlot, validateSlotForDispatch } from '../methods/dispatch/slot-scoring.js';

import {
  replaySlotCapabilityRequirements,
  slotCapabilityBlocker,
} from './slot-capability-requirements.js';

function provider(id: string, available = true, device = true): RuntimeCapabilityCatalogEntry {
  return {
    id,
    project: 'device-farm',
    label: id,
    version: '1',
    sharePolicy: 'exclusive',
    cost: { class: 'low', resources: device ? [{ id, kind: 'device', access: 'exclusive' }] : [] },
    actions: {
      acquire: { kind: 'slot-action', actionId: 'boot' },
      health: { kind: 'slot-action', actionId: 'health' },
      release: { kind: 'slot-action', actionId: 'stop' },
    },
    releaseEffects: [],
    provenance: { project: 'device-farm', providerId: id, version: '1', digest: id },
    availability: available
      ? { state: 'available' }
      : { state: 'unavailable', reason: 'Slot has no Android device' },
  };
}

function slot(id: string, pressure = 'OK'): SlotStatus {
  return {
    slot: id,
    machine: id,
    platform: 'ios',
    project: 'device-farm',
    branch: 'main',
    health: { ssh: pressure, device: 'sim:OK', devserver: 'OK', cdp: 'Wallet', fixtures: 'OK' },
    lifecycle: 'ready',
    phase: null,
    agent: 'idle',
    enabled: true,
    dispatchable: true,
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
  } as SlotStatus;
}

const ios = slot('ios-slot');
const pixel = { ...slot('pixel-slot', 'YELLOW'), platform: 'android' };
const catalogs = new Map([
  [ios.slot, [provider('ios-simulator'), provider('android-device', false)]],
  [pixel.slot, [provider('android-device'), provider('ios-simulator', false)]],
]);
const requirements = { requiredCapabilities: ['android-device'], capabilityCatalogs: catalogs };

test('Pixel replay intent comes from available device providers and survives slot clearing', async () => {
  const captured = await replaySlotCapabilityRequirements({ slotId: pixel.slot }, async () => ({
    slotId: pixel.slot,
    project: 'device-farm',
    capabilities: [
      provider('android-device'),
      provider('ios-simulator', false),
      provider('browser', true, false),
    ],
  }));
  assert.deepEqual(captured, { sourceSlotId: pixel.slot, capabilityIds: ['android-device'] });
  const retained = await replaySlotCapabilityRequirements(
    { slotId: null, engineState: { slotCapabilityRequirements: captured } },
    async () => {
      throw new Error('must use retained intent');
    },
  );
  assert.deepEqual(retained, captured);
  assert.notEqual(retained, captured);
  assert.equal(await replaySlotCapabilityRequirements({ slotId: null }), undefined);
});

test('replay keeps a run.create capability request and adds the devices of the slot it leaves', async () => {
  const requested = { capabilityIds: ['audio-capture'] };
  const leaving = { slotId: pixel.slot, engineState: { slotCapabilityRequirements: requested } };
  assert.deepEqual(
    await replaySlotCapabilityRequirements(leaving, async () => ({
      slotId: pixel.slot,
      project: 'device-farm',
      capabilities: [provider('android-device'), provider('ios-simulator', false)],
    })),
    { sourceSlotId: pixel.slot, capabilityIds: ['audio-capture', 'android-device'] },
  );
  assert.deepEqual(await replaySlotCapabilityRequirements({ ...leaving, slotId: null }), requested);
});

test('Android capability is a hard filter even when the iOS slot has the best score', () => {
  assert.equal(
    findBestSlot([ios, pixel], 'device-farm')?.slot,
    ios.slot,
    'former selection picks the wrong device',
  );
  assert.equal(findBestSlot([ios, pixel], 'device-farm', requirements)?.slot, pixel.slot);
  assert.equal(findBestSlot([ios], 'device-farm', requirements), null);
  assert.match(
    validateSlotForDispatch(ios, [ios, pixel], requirements)!,
    /android-device.*unavailable/,
  );
  assert.equal(validateSlotForDispatch(pixel, [ios, pixel], requirements), null);
  assert.match(slotCapabilityBlocker(pixel.slot, ['android-device'])!, /unavailable/);
});

test('automatic, explicit and affinity preview selection share device eligibility', () => {
  const params = { project: 'device-farm', flowType: 'qa' as const, ticketOrPr: 'PROJ-123' };
  assert.equal(
    resolveDispatchPreviewFromFleet(params, [ios, pixel], undefined, requirements).preview.slotId,
    pixel.slot,
  );
  assert.throws(
    () =>
      resolveDispatchPreviewFromFleet(
        { ...params, slotId: ios.slot },
        [ios, pixel],
        undefined,
        requirements,
      ),
    /android-device.*unavailable/,
  );
  assert.throws(
    () => resolveDispatchPreviewFromFleet(params, [ios], undefined, requirements),
    /No dispatchable slots.*\n.*android-device/s,
  );
  const held = { ...ios, lifecycle: 'held' as const, branch: 'feat/proj-123' };
  assert.equal(
    resolveDispatchPreviewFromFleet(
      { ...params, flowType: 'review-pr', targetBranch: held.branch },
      [held, pixel],
      undefined,
      requirements,
    ).preview.slotId,
    pixel.slot,
  );
  const busy = {
    ...ios,
    lifecycle: 'busy' as const,
    agent: 'working' as const,
    branch: held.branch,
  };
  assert.equal(
    selectBranchAffinityEligibleSlots([busy], 'device-farm', params.ticketOrPr, requirements)
      .length,
    0,
  );
});

test('source-scoped plans and allowed slot filters cannot drop the device requirement', () => {
  const plans = new Map(
    [ios, pixel].map((candidate) => [
      candidate.slot,
      {
        params: {
          project: 'device-farm',
          flowType: 'qa' as const,
          ticketOrPr: 'PROJ-123',
          slotId: candidate.slot,
        },
      },
    ]),
  );
  assert.equal(
    findBestSlot([ios, pixel], 'device-farm', { ...requirements, plans })?.slot,
    pixel.slot,
  );
  assert.equal(
    findBestSlot([ios, pixel], 'device-farm', { ...requirements, allowedSlots: [ios.slot] }),
    null,
  );
});

test('find-slot replay persists the requested device intent before clearing its preferred slot', async (t) => {
  await import('../runtime/mock-pty.test-support.js');
  const capabilityModule = await import('../methods/runtime-capabilities.js');
  mock.module('../methods/runtime-capabilities.js', {
    namedExports: {
      ...capabilityModule,
      runtimeCapabilityList: async ({ slotId }: { slotId: string }) => ({
        slotId,
        project: 'device-farm',
        capabilities: catalogs.get(slotId) ?? [],
      }),
    },
  });
  const { createRun, getRun, updateRun, deleteRun } = await import('../runs/store.js');
  const { runReplayStep } = await import('../methods/run/replay-step.js');
  const previous = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  const previousContext = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const run = createRun({ flowType: 'dev', project: 'device-farm', ticketOrPr: 'PROJ-123' });
  t.after(async () => {
    mock.restoreAll();
    if (previous === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previous;
    if (previousContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousContext;
    updateRun(run.id, { status: 'failed' });
    await deleteRun(run.id);
  });
  updateRun(run.id, { status: 'failed', slotId: pixel.slot, engineState: { generation: 3 } });
  const replayed = await runReplayStep({ runId: run.id, stepName: 'find-slot' }, () => {});
  assert.equal(replayed.run.slotId, null);
  assert.equal(replayed.run.allowedSlots, null);
  assert.deepEqual(replayed.run.engineState?.slotCapabilityRequirements, {
    sourceSlotId: pixel.slot,
    capabilityIds: ['android-device'],
  });
  assert.equal(
    findBestSlot([ios, pixel], 'device-farm', {
      requiredCapabilities: getRun(run.id)!.engineState!.slotCapabilityRequirements!.capabilityIds,
      capabilityCatalogs: catalogs,
    })?.slot,
    pixel.slot,
  );
});
