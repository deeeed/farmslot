import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, it, mock } from 'node:test';

import {
  type DeviceDiscoveryError,
  findAvailableIosSimulatorById,
  listConnectedDevices,
} from '../src/devices.js';

// devices.ts binds `execFileSync` through an ESM named import; syncing the
// builtin exports makes that binding see the mock (and the restore).
function mockExecFileSync(implementation: (...args: unknown[]) => string) {
  const mocked = mock.method(childProcess, 'execFileSync', implementation);
  syncBuiltinESMExports();
  return mocked;
}

afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

describe('iOS simulator discovery', () => {
  it('allows cold CoreSimulator startup for booted and available inventories', () => {
    const execFileSync = mockExecFileSync(() =>
      JSON.stringify({
        devices: { 'iOS-26': [{ udid: 'SIM-1', name: 'iPhone', state: 'Booted' }] },
      }),
    );

    assert.deepEqual(
      listConnectedDevices('ios').map((device) => device.id),
      ['SIM-1'],
    );
    assert.equal(findAvailableIosSimulatorById('SIM-1')?.id, 'SIM-1');
    assert.equal(execFileSync.mock.callCount(), 2);
    for (const call of execFileSync.mock.calls) {
      assert.equal((call.arguments[2] as { timeout?: number }).timeout, 30_000);
    }
  });

  it('reports the actual bound when iOS discovery times out', () => {
    mockExecFileSync(() => {
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    });
    const errors: DeviceDiscoveryError[] = [];

    assert.deepEqual(listConnectedDevices('ios', errors), []);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.platform, 'ios');
    assert.equal(
      errors[0]?.message,
      'ios device discovery timed out after 30 seconds; device availability is unknown.',
    );
  });
});
