import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { NodePressureHistorySample } from '@farmslot/protocol';

import {
  loadPressureHistory,
  PRESSURE_HISTORY_STORE_VERSION,
  savePressureHistory,
} from './pressure-history-store.js';

function withTempHome<T>(run: () => T): T {
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = mkdtempSync(path.join(tmpdir(), 'farmslot-pressure-store-'));
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
  }
}

// Anchored one hour in the PAST: the store rejects future-dated samples, so
// fixtures must sit behind the wall clock while staying mutually ordered.
const SAMPLE_BASE_MS = Date.now() - 60 * 60_000;

function sample(sampleId: number, cpu = 0.5): NodePressureHistorySample {
  return {
    generation: 'gen-a',
    sampleId,
    collectedAt: new Date(SAMPLE_BASE_MS + sampleId * 1_000).toISOString(),
    pressure: { cpu, memory: 0.4, disk: 0.5, load1: 0.6 },
    cpuPercent: cpu * 100,
    memoryPercent: 40,
    diskPercent: 50,
    loadAvg1: 4,
    loadAvg5: 4,
  };
}

function storeFilePath(): string {
  return path.join(process.env.FARMSLOT_HOME!, 'state', 'pressure-history.json');
}

test('restart roundtrip: saved ring rehydrates with identical normalized samples', () => {
  withTempHome(() => {
    const machines = new Map([
      ['macwork', [sample(1), sample(2), sample(3)]],
      ['mini', [sample(1, 0.9)]],
    ]);
    savePressureHistory(machines, 120);
    const loaded = loadPressureHistory(120);
    assert.equal(loaded.quarantinedReason, undefined);
    assert.deepEqual(loaded.machines.get('macwork'), machines.get('macwork'));
    assert.deepEqual(loaded.machines.get('mini'), machines.get('mini'));
  });
});

test('bounds: save and load both cap each machine at the sample limit', () => {
  withTempHome(() => {
    const many = Array.from({ length: 300 }, (_, index) => sample(index));
    savePressureHistory(new Map([['macwork', many]]), 120);
    const loaded = loadPressureHistory(120);
    assert.equal(loaded.machines.get('macwork')?.length, 120);
    // Newest samples survive the bound.
    assert.equal(loaded.machines.get('macwork')?.at(-1)?.sampleId, 299);
    // A tighter load-time limit re-bounds an oversized on-disk ring.
    const rebounded = loadPressureHistory(10);
    assert.equal(rebounded.machines.get('macwork')?.length, 10);
  });
});

test('corrupt file: unparseable JSON is quarantined, startup continues empty', () => {
  withTempHome(() => {
    savePressureHistory(new Map([['macwork', [sample(1)]]]), 120);
    writeFileSync(storeFilePath(), '{ this is not json');
    const loaded = loadPressureHistory(120);
    assert.equal(loaded.machines.size, 0);
    assert.match(loaded.quarantinedReason ?? '', /unparseable JSON/);
    const stateFiles = readdirSync(path.dirname(storeFilePath()));
    assert.ok(stateFiles.some((name) => name.startsWith('pressure-history.json.quarantined-')));
    // A subsequent save starts a clean store.
    savePressureHistory(new Map([['macwork', [sample(2)]]]), 120);
    assert.equal(loadPressureHistory(120).machines.get('macwork')?.length, 1);
  });
});

test('wrong version and malformed samples are rejected, valid samples survive', () => {
  withTempHome(() => {
    savePressureHistory(new Map(), 120); // ensures state dir exists
    writeFileSync(storeFilePath(), JSON.stringify({ version: 999, savedAt: 'x', machines: {} }));
    const wrongVersion = loadPressureHistory(120);
    assert.equal(wrongVersion.machines.size, 0);
    assert.match(wrongVersion.quarantinedReason ?? '', /unsupported shape\/version/);

    writeFileSync(
      storeFilePath(),
      JSON.stringify({
        version: PRESSURE_HISTORY_STORE_VERSION,
        savedAt: 'x',
        machines: {
          macwork: [
            sample(1),
            { collectedAt: 'not-a-date', pressure: { cpu: 1, memory: 1, disk: 1 } },
            { totally: 'wrong' },
            null,
          ],
          '': [sample(1)],
        },
      }),
    );
    const partial = loadPressureHistory(120);
    assert.equal(partial.quarantinedReason, undefined);
    assert.equal(partial.machines.get('macwork')?.length, 1);
    assert.equal(partial.machines.has(''), false);
  });
});

test('persisted payload carries only normalized gauges — no process detail fields', () => {
  withTempHome(() => {
    const poisoned = {
      ...sample(1),
      // Fields that must never round-trip through the store.
      pid: 1234,
      executable: '/usr/bin/secret',
      commandLine: 'secret --args',
    } as NodePressureHistorySample;
    savePressureHistory(new Map([['macwork', [poisoned]]]), 120);
    const raw = readFileSync(storeFilePath(), 'utf-8');
    // Both directions rebuild samples field-by-field: the on-disk payload
    // never contains process paths/PIDs/command lines, and neither does the
    // rehydrated ring.
    assert.ok(!raw.includes('secret'));
    assert.ok(!raw.includes('pid'));
    assert.ok(raw.includes('"cpuPercent"'));
    const loaded = loadPressureHistory(120);
    const restored = loaded.machines.get('macwork')?.[0] as unknown as Record<string, unknown>;
    assert.equal(restored.pid, undefined);
    assert.equal(restored.executable, undefined);
    assert.equal(restored.commandLine, undefined);
  });
});

test('restored samples are strictly validated: future, out-of-range, malformed ids dropped', () => {
  withTempHome(() => {
    savePressureHistory(new Map(), 120); // ensures state dir exists
    const future = {
      ...sample(1),
      collectedAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    const badRatio = { ...sample(2), pressure: { cpu: 1.4, memory: 0.4, disk: 0.5 } };
    const negativeLoad = { ...sample(3), loadAvg1: -1 };
    const fractionalId = { ...sample(4), sampleId: 4.5 };
    const hugeGeneration = { ...sample(5), generation: 'g'.repeat(300) };
    writeFileSync(
      storeFilePath(),
      JSON.stringify({
        version: PRESSURE_HISTORY_STORE_VERSION,
        savedAt: 'x',
        machines: {
          macwork: [sample(1), future, badRatio, negativeLoad, fractionalId, hugeGeneration],
          ['m'.repeat(200)]: [sample(1)],
        },
      }),
    );
    const loaded = loadPressureHistory(120);
    // Only the one valid sample survives; a future-dated restored sample can
    // never suppress live updates after restart.
    assert.equal(loaded.machines.get('macwork')?.length, 1);
    assert.equal(loaded.machines.get('macwork')?.[0].sampleId, sample(1).sampleId);
    assert.equal(loaded.machines.has('m'.repeat(200)), false);
  });
});
