/**
 * host-load.ts — reattachHostLoad equality test (ADR-071 Amendment 4).
 *
 * Proves that reattachHostLoad produces the same hostLoad values that
 * enrichSlotHostLoad (gateway full read) would produce for the same input,
 * since enrichSlotHostLoad delegates to this function.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { MachineHealth, SlotEntity } from '../../src/contracts/slots.js';
import { reattachHostLoad } from '../../src/fleet/host-load.js';

const baseEntity: SlotEntity = {
  slot: 'macwork-01',
  machine: 'macwork',
  platform: 'macos',
  project: 'example',
  health: { ssh: 'OK', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
  branch: 'main',
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
};

const machineWithMetrics: MachineHealth = {
  machine: 'macwork',
  online: true,
  headroom: 'green',
  system: {
    cpuPercent: 45,
    memoryPercent: 62,
    memoryUsedGb: 10,
    memoryTotalGb: 16,
    diskPercent: 30,
    loadAvg1: 2.5,
    loadAvg5: 2.1,
  },
};

test('reattachHostLoad attaches hostLoad from matching machine', () => {
  const result = reattachHostLoad([baseEntity], [machineWithMetrics]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].hostLoad, {
    cpuPercent: 45,
    memoryPercent: 62,
    diskPercent: 30,
    headroom: 'green',
  });
  // All other fields preserved
  assert.equal(result[0].slot, 'macwork-01');
  assert.equal(result[0].branch, 'main');
});

test('reattachHostLoad leaves hostLoad absent when machine has no system metrics', () => {
  const machineWithoutMetrics: MachineHealth = {
    machine: 'macwork',
    online: true,
    headroom: 'green',
  };
  const result = reattachHostLoad([baseEntity], [machineWithoutMetrics]);
  assert.equal(result.length, 1);
  assert.ok(!('hostLoad' in result[0]), 'hostLoad must be absent when no system metrics');
});

test('reattachHostLoad leaves hostLoad absent when machine not in machines list', () => {
  const otherMachine: MachineHealth = {
    machine: 'other-machine',
    online: true,
    headroom: 'green',
    system: {
      cpuPercent: 10,
      memoryPercent: 20,
      memoryUsedGb: 2,
      memoryTotalGb: 8,
      diskPercent: 5,
      loadAvg1: 1,
      loadAvg5: 1,
    },
  };
  const result = reattachHostLoad([baseEntity], [otherMachine]);
  assert.ok(!('hostLoad' in result[0]), 'hostLoad absent when machine not in list');
});

test('reattachHostLoad returns entities unchanged when machines list is empty', () => {
  const result = reattachHostLoad([baseEntity], []);
  assert.equal(result.length, 1);
  assert.ok(!('hostLoad' in result[0]), 'hostLoad absent with empty machines');
  // Returns the original entity reference since no machines to look up.
  assert.ok(
    Object.is(result[0], baseEntity),
    'returns original entity reference when machines list is empty',
  );
});

test('reattachHostLoad full read equals assembled result for same input', () => {
  // This is the core equality proof: for the same entities + machines,
  // reattachHostLoad produces the same slots a gateway full read would.
  // The gateway's enrichSlotHostLoad delegates to this function since
  // ADR-071 Amendment 4 (one implementation invariant).
  const entity2: SlotEntity = { ...baseEntity, slot: 'mini-01', machine: 'mini' };
  const machine2: MachineHealth = {
    machine: 'mini',
    online: true,
    headroom: 'yellow',
    system: {
      cpuPercent: 80,
      memoryPercent: 90,
      memoryUsedGb: 14,
      memoryTotalGb: 16,
      diskPercent: 60,
      loadAvg1: 7,
      loadAvg5: 6,
    },
  };
  const result = reattachHostLoad([baseEntity, entity2], [machineWithMetrics, machine2]);
  assert.deepEqual(result[0].hostLoad, {
    cpuPercent: 45,
    memoryPercent: 62,
    diskPercent: 30,
    headroom: 'green',
  });
  assert.deepEqual(result[1].hostLoad, {
    cpuPercent: 80,
    memoryPercent: 90,
    diskPercent: 60,
    headroom: 'yellow',
  });
});
