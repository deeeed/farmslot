import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runWithSessionOriginator } from '../../security/work-originator.js';

import { resolveExecutePressureOutcome } from './execute.js';
import { capturePressureAdmissionDecisions } from './pressure-admission.js';
import {
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

test('kill switch: default enabled, authenticated disable persists and survives restart', () => {
  withTempHome(() => {
    assert.deepEqual(getPressureAdmissionControl(), {
      enabled: true,
      updatedAt: null,
      updatedBy: null,
    });

    const disabled = runWithSessionOriginator(PRINCIPAL, () =>
      setPressureAdmissionEnabled({ enabled: false }),
    );
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.updatedBy, 'principal-arthur');
    assert.ok(disabled.updatedAt);

    const onDisk = JSON.parse(readFileSync(controlFile(), 'utf-8'));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.enabled, false);
    assert.equal(onDisk.updatedBy, 'principal-arthur');

    // Simulated gateway restart: drop the cache, re-read from disk.
    resetPressureAdmissionControlCacheForTest();
    assert.equal(isPressureAdmissionEnabled(), false);
    assert.equal(getPressureAdmissionControl().updatedBy, 'principal-arthur');

    const enabled = runWithSessionOriginator(PRINCIPAL, () =>
      setPressureAdmissionEnabled({ enabled: true }),
    );
    assert.equal(enabled.enabled, true);
    resetPressureAdmissionControlCacheForTest();
    assert.equal(isPressureAdmissionEnabled(), true);
  });
});

test('kill switch: corrupt or wrong-shape control file fails SAFE to enabled', () => {
  withTempHome(() => {
    mkdirSync(path.dirname(controlFile()), { recursive: true });
    writeFileSync(controlFile(), '{ nope');
    assert.equal(isPressureAdmissionEnabled(), true);
    resetPressureAdmissionControlCacheForTest();
    writeFileSync(controlFile(), JSON.stringify({ version: 99, enabled: false }));
    assert.equal(isPressureAdmissionEnabled(), true);
  });
});

test('kill switch: malformed setEnabled params are rejected loudly', () => {
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

test('disabled switch admits every machine with state=disabled and no pressure read', async () => {
  await withTempHome(async () => {
    runWithSessionOriginator(PRINCIPAL, () => setPressureAdmissionEnabled({ enabled: false }));
    // No fleet/pressure infrastructure exists in this test process — the
    // capture must short-circuit before any snapshot read or it would throw.
    const decisions = await capturePressureAdmissionDecisions(['macwork', 'mini']);
    for (const machine of ['macwork', 'mini']) {
      const decision = decisions.get(machine);
      assert.equal(decision?.outcome, 'admitted');
      assert.equal(decision?.outcome === 'admitted' && decision.state, 'disabled');
      assert.equal(decision?.evidence.generation, null);
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
