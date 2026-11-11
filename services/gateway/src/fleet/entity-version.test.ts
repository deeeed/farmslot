import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotStatus } from '@farmslot/protocol';

import { slotEntityBody, slotEntityVersion } from './entity-version.js';

const baseSlot: SlotStatus = {
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

test('slotEntityBody strips hostLoad when present', () => {
  const withLoad: SlotStatus = {
    ...baseSlot,
    hostLoad: { cpuPercent: 50, memoryPercent: 30, diskPercent: 10, headroom: 'ok' },
  };
  const body = slotEntityBody(withLoad);
  assert.ok(!('hostLoad' in body), 'hostLoad must not appear in entity body');
  assert.equal(body.slot, baseSlot.slot);
});

test('slotEntityBody returns slot unchanged when hostLoad is absent', () => {
  const body = slotEntityBody(baseSlot);
  assert.equal(body, baseSlot);
});

test('slotEntityVersion is 16 hex chars', () => {
  const v = slotEntityVersion(baseSlot);
  assert.match(v, /^[0-9a-f]{16}$/, 'version must be 16 lowercase hex chars');
});

test('slotEntityVersion is stable across calls for the same input', () => {
  const v1 = slotEntityVersion(baseSlot);
  const v2 = slotEntityVersion({ ...baseSlot });
  assert.equal(v1, v2, 'same content must produce same version');
});

test('slotEntityVersion differs for different content', () => {
  const a = slotEntityVersion(baseSlot);
  const b = slotEntityVersion({ ...baseSlot, status: 'busy' } as SlotStatus);
  assert.notEqual(a, b, 'different content must produce different version');
});

test('slotEntityVersion is unaffected by hostLoad (excluded before hashing)', () => {
  const withLoad: SlotStatus = {
    ...baseSlot,
    hostLoad: { cpuPercent: 90, memoryPercent: 50, diskPercent: 20, headroom: 'ok' },
  };
  const bodyVersion = slotEntityVersion(slotEntityBody(withLoad));
  const baseVersion = slotEntityVersion(baseSlot);
  assert.equal(bodyVersion, baseVersion, 'hostLoad must not affect entity version');
});
