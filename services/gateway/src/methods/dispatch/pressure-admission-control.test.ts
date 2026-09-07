import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runWithSessionOriginator } from '../../security/work-originator.js';

import { resolveExecutePressureOutcome } from './execute.js';
import { capturePressureAdmissionDecisions } from './pressure-admission.js';
import {
  assertDispatchPressureAdmissionEnvValid,
  getPressureAdmissionControl,
  isPressureAdmissionEnabled,
  resetPressureAdmissionControlCacheForTest,
  setPressureAdmissionEnabled,
} from './pressure-admission-control.js';

const PRINCIPAL = {
  id: 'principal-arthur',
  subject: { type: 'person' as const, displayName: 'Arthur' },
  roles: [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
};

function withTempHome<T>(run: () => T): T {
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = mkdtempSync(path.join(tmpdir(), 'farmslot-pressure-control-'));
  resetPressureAdmissionControlCacheForTest();
  try {
    return run();
  } finally {
    resetPressureAdmissionControlCacheForTest();
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
  }
}

function controlFile(): string {
  return path.join(process.env.FARMSLOT_HOME!, 'state', 'pressure-admission-control.json');
}

test('opt-in switch: default DISABLED, authenticated enable persists and survives restart', () => {
  withTempHome(() => {
    assert.deepEqual(getPressureAdmissionControl(), {
      enabled: false,
      updatedAt: null,
      updatedBy: null,
    });
    assert.equal(isPressureAdmissionEnabled(), false);

    const enabledState = runWithSessionOriginator(PRINCIPAL, () =>
      setPressureAdmissionEnabled({ enabled: true }),
    );
    assert.equal(enabledState.enabled, true);
    assert.equal(enabledState.updatedBy, 'principal-arthur');
    assert.ok(enabledState.updatedAt);

    const onDisk = JSON.parse(readFileSync(controlFile(), 'utf-8'));
    assert.equal(onDisk.version, 2);
    assert.equal(onDisk.enabled, true);
    assert.equal(onDisk.updatedBy, 'principal-arthur');

    // Simulated gateway restart: drop the cache, re-read from disk.
    resetPressureAdmissionControlCacheForTest();
    assert.equal(isPressureAdmissionEnabled(), true);
    assert.equal(getPressureAdmissionControl().updatedBy, 'principal-arthur');

    const disabled = runWithSessionOriginator(PRINCIPAL, () =>
      setPressureAdmissionEnabled({ enabled: false }),
    );
    assert.equal(disabled.enabled, false);
    resetPressureAdmissionControlCacheForTest();
    assert.equal(isPressureAdmissionEnabled(), false);
  });
});

test('opt-in switch: corrupt or wrong-shape control file falls back to the disabled default', () => {
  withTempHome(() => {
    mkdirSync(path.dirname(controlFile()), { recursive: true });
    writeFileSync(controlFile(), '{ nope');
    assert.equal(isPressureAdmissionEnabled(), false);
    resetPressureAdmissionControlCacheForTest();
    writeFileSync(controlFile(), JSON.stringify({ version: 99, enabled: true }));
    assert.equal(isPressureAdmissionEnabled(), false);
    resetPressureAdmissionControlCacheForTest();
    writeFileSync(controlFile(), JSON.stringify({ version: 2, enabled: 'yes' }));
    assert.equal(isPressureAdmissionEnabled(), false);
  });
});

test('a v1 control file that says enabled is reset to the new opt-in default', () => {
  withTempHome(() => {
    mkdirSync(path.dirname(controlFile()), { recursive: true });
    // Exactly what an install that ran `disable` then `enable` left behind,
    // when enabling meant "back to the shipped default" and that default was ON.
    writeFileSync(
      controlFile(),
      JSON.stringify({
        version: 1,
        enabled: true,
        updatedAt: '2026-08-01T00:00:00.000Z',
        updatedBy: 'principal-arthur',
      }),
    );
    assert.equal(
      isPressureAdmissionEnabled(),
      false,
      'a v1 file must not carry its inverted meaning across the upgrade',
    );
    assert.deepEqual(getPressureAdmissionControl(), {
      enabled: false,
      updatedAt: null,
      updatedBy: null,
    });
  });
});

test("a typo'd env value is ignored on reads and refused at startup", () => {
  const previous = process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION;
  try {
    withTempHome(() => {
      runWithSessionOriginator(PRINCIPAL, () => setPressureAdmissionEnabled({ enabled: true }));
      process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION = 'enabled';
      // Reads must stay answerable: an operator has to be able to read the
      // control state to find their typo.
      assert.equal(isPressureAdmissionEnabled(), true, 'falls back to the durable state');
      assert.equal(getPressureAdmissionControl().envOverride, undefined);
      // The gateway refuses to boot instead.
      assert.throws(
        () => assertDispatchPressureAdmissionEnvValid(),
        /must be off or refuse, got 'enabled'/,
      );
      assert.doesNotThrow(() =>
        assertDispatchPressureAdmissionEnvValid({ FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'refuse' }),
      );
    });
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION;
    else process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION = previous;
  }
});

test('env override wins over the durable state in both directions', () => {
  const previous = process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION;
  try {
    withTempHome(() => {
      runWithSessionOriginator(PRINCIPAL, () => setPressureAdmissionEnabled({ enabled: false }));
      process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION = 'refuse';
      assert.equal(isPressureAdmissionEnabled(), true);
      // The durable state is still reported verbatim next to the override.
      assert.equal(getPressureAdmissionControl().enabled, false);
      assert.equal(getPressureAdmissionControl().envOverride, 'refuse');

      runWithSessionOriginator(PRINCIPAL, () => setPressureAdmissionEnabled({ enabled: true }));
      process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION = 'off';
      assert.equal(isPressureAdmissionEnabled(), false);
      assert.equal(getPressureAdmissionControl().enabled, true);

      // An unusable value never poisons a read; startup is the fail-loud gate.
      process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION = 'maybe';
      assert.equal(isPressureAdmissionEnabled(), true, 'falls back to the durable enabled state');
    });
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION;
    else process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION = previous;
  }
});

test('opt-in switch: malformed setEnabled params are rejected loudly', () => {
  withTempHome(() => {
    assert.throws(
      () =>
        runWithSessionOriginator(PRINCIPAL, () =>
          setPressureAdmissionEnabled({ enabled: 'yes' as unknown as boolean }),
        ),
      /enabled: boolean/,
    );
  });
});

test('the off switch admits every machine with state=disabled and enforced=false', async () => {
  await withTempHome(async () => {
    runWithSessionOriginator(PRINCIPAL, () => setPressureAdmissionEnabled({ enabled: false }));
    // No fleet/pressure infrastructure exists in this test process — the
    // unenforced path reads only in-memory rings, never a snapshot.
    const decisions = await capturePressureAdmissionDecisions(['macwork', 'mini']);
    for (const machine of ['macwork', 'mini']) {
      const decision = decisions.get(machine);
      assert.equal(decision?.outcome, 'admitted');
      assert.equal(decision?.outcome === 'admitted' && decision.state, 'disabled');
      assert.equal(decision?.outcome === 'admitted' && decision.enforced, false);
      // No ring in this process: the machine has no evidence, and the
      // advisory says what an enabled gate would have refused with.
      assert.equal(decision?.evidence.generation, null);
      assert.equal(
        decision?.outcome === 'admitted' && decision.advisory?.code,
        'PRESSURE_EVIDENCE_UNAVAILABLE',
      );
    }
    // A preview identity recorded while admission was enabled must not turn
    // into a stale rejection while the switch is off.
    const outcome = resolveExecutePressureOutcome({
      machine: 'macwork',
      decision: decisions.get('macwork'),
      admissionRef: { machine: 'macwork', pressureGeneration: 'older-generation' },
    });
    assert.equal(outcome.rejection, null);
    assert.equal(outcome.acceptedOverride, null);
  });
});
