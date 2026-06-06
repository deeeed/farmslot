import { strict as assert } from 'node:assert';
import test from 'node:test';

import type { SlotResource, SlotStatus } from '@farmslot/protocol';

import {
  isDeviceGridResourceApplicable,
  isDeviceGridResourceLive,
  resolveDeviceGridResourceStatus,
} from './device-grid-model.js';

function slot(overrides: Partial<SlotStatus>): SlotStatus {
  return {
    slot: 'slot-1',
    machine: 'mini',
    platform: 'ios',
    project: 'mobile',
    branch: 'main',
    enabled: true,
    lifecycle: 'ready',
    phase: null,
    currentRunId: null,
    agent: 'idle',
    health: { ssh: 'OK', device: '-', devserver: '-', cdp: '-', fixtures: '-' },
    ...overrides,
  } as SlotStatus;
}

function resource(overrides: Partial<SlotResource>): SlotResource {
  return {
    id: 'ios-sim',
    status: 'unknown',
    definition: {
      type: 'device',
      platform: 'ios',
      label: 'iOS Sim',
      streamable: true,
      controllable: true,
    },
    stream: { state: 'unknown' },
    ...overrides,
  } as SlotResource;
}

test('resolveDeviceGridResourceStatus falls back to slot device health when resource cache is unknown', () => {
  const status = resolveDeviceGridResourceStatus(
    slot({ health: { ssh: 'OK', device: 'sim:OK', devserver: '-', cdp: '-', fixtures: '-' } }),
    resource({ status: 'unknown' }),
  );

  assert.equal(status, 'running');
});

test('resolveDeviceGridResourceStatus does not treat CDP health as browser stream health', () => {
  const status = resolveDeviceGridResourceStatus(
    slot({
      platform: 'chrome-extension',
      health: { ssh: 'OK', device: 'ext:OK', devserver: '-', cdp: 'Login', fixtures: '-' },
    }),
    resource({
      id: 'browser',
      status: 'unknown',
      definition: {
        type: 'browser',
        platform: 'chrome-extension',
        label: 'Ext Browser',
        streamable: true,
        controllable: true,
      },
    }),
  );

  assert.equal(status, 'unknown');
});

test('isDeviceGridResourceApplicable filters cross-platform project resources', () => {
  const iosSlot = slot({ platform: 'ios' });
  const androidResource = resource({
    id: 'android-emu',
    definition: {
      type: 'device',
      platform: 'android',
      label: 'Android Emu',
      streamable: true,
      controllable: true,
    },
  });

  assert.equal(isDeviceGridResourceApplicable(iosSlot, androidResource), false);
  assert.equal(resolveDeviceGridResourceStatus(iosSlot, androidResource), 'stopped');
});

test('isDeviceGridResourceLive includes stale because it is still capturable', () => {
  assert.equal(isDeviceGridResourceLive('running'), true);
  assert.equal(isDeviceGridResourceLive('stale'), true);
  assert.equal(isDeviceGridResourceLive('stopped'), false);
});
