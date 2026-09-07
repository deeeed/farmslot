import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_HOST_PRESSURE_THRESHOLDS,
  hostPressureAdmissionEnvOverride,
  resolveHostPressureAdmission,
} from './host-pressure-config.js';

test('an absent project block resolves to off, the default', () => {
  const resolved = resolveHostPressureAdmission(undefined, {});
  assert.equal(resolved.mode, 'off');
  assert.equal(resolved.source, 'default');
  assert.deepEqual(resolved.thresholds, { ...DEFAULT_HOST_PRESSURE_THRESHOLDS });
});

test('a project opts in and may move the critical band it enforces on', () => {
  const resolved = resolveHostPressureAdmission(
    { mode: 'refuse', load1CriticalMultiplier: 2.5, cpuCriticalPercent: 95 },
    {},
  );
  assert.equal(resolved.mode, 'refuse');
  assert.equal(resolved.source, 'project');
  assert.equal(resolved.thresholds.load1CriticalMultiplier, 2.5);
  assert.equal(resolved.thresholds.cpuCriticalPercent, 95);
  // Untouched dimensions keep the gateway defaults.
  assert.equal(
    resolved.thresholds.memoryCriticalPercent,
    DEFAULT_HOST_PRESSURE_THRESHOLDS.memoryCriticalPercent,
  );
  assert.equal(
    resolved.thresholds.diskCriticalPercent,
    DEFAULT_HOST_PRESSURE_THRESHOLDS.diskCriticalPercent,
  );
});

test('the gateway env override wins over the project mode, in both directions', () => {
  const off = resolveHostPressureAdmission(
    { mode: 'refuse' },
    { FARMSLOT_HOST_PRESSURE_ADMISSION: 'off' },
  );
  assert.equal(off.mode, 'off');
  assert.equal(off.source, 'env');

  const refuse = resolveHostPressureAdmission(undefined, {
    FARMSLOT_HOST_PRESSURE_ADMISSION: 'refuse',
  });
  assert.equal(refuse.mode, 'refuse');
  assert.equal(refuse.source, 'env');
});

test('the env override does not take the project thresholds with it', () => {
  const resolved = resolveHostPressureAdmission(
    { mode: 'off', cpuCriticalPercent: 99 },
    { FARMSLOT_HOST_PRESSURE_ADMISSION: 'refuse' },
  );
  assert.equal(resolved.mode, 'refuse');
  assert.equal(resolved.thresholds.cpuCriticalPercent, 99);
});

test('an unrecognized env value throws rather than resolving to some other mode', () => {
  assert.throws(
    () => hostPressureAdmissionEnvOverride({ FARMSLOT_HOST_PRESSURE_ADMISSION: 'enabled' }),
    /must be off, refuse, queue/,
  );
  assert.equal(hostPressureAdmissionEnvOverride({ FARMSLOT_HOST_PRESSURE_ADMISSION: '  ' }), null);
  assert.equal(hostPressureAdmissionEnvOverride({}), null);
});
