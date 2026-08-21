import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type {
  ProcessAttributionGroup,
  ResourcePressureHistoryResult,
  ResourcePressureSnapshotResult,
} from '@farmslot/protocol';

import {
  cleanupExecutionTargets,
  cleanupTargetsRemainEligible,
  mergePressureHistoryForRender,
  pressureHistoryFreshnessLabel,
  pressureLoadRatio,
  pressureOwnershipLabel,
  pressureProcessCpu,
  pressureProcessName,
  pressureSampleAge,
  pressureSparklinePoints,
  visiblePressureGroups,
} from './machine-pressure-model.js';

test('node reconnect retries one debounced explicit pressure snapshot', () => {
  const source = readFileSync(new URL('./fleet-canvas.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /Events\.NODE_CONNECTED[\s\S]*scheduleResourcePressureReconnectRefresh\(\)/u,
  );
  assert.match(
    source,
    /scheduleResourcePressureReconnectRefresh[\s\S]*void this\.fetchResourcePressure\(\)/u,
  );
  assert.match(source, /clearResourcePressureReconnectRefresh\(\)[\s\S]*disconnectedCallback/u);
});

test('live history refresh updates snapshot charts without replacing attribution', () => {
  const oldSample = {
    collectedAt: '2026-08-21T09:00:00.000Z',
    pressure: { cpu: 0.2, memory: 0.3, disk: 0.4 },
    cpuPercent: 20,
    memoryPercent: 30,
    diskPercent: 40,
    loadAvg1: 1,
    loadAvg5: 1,
  };
  const newSample = { ...oldSample, collectedAt: '2026-08-21T09:00:30.000Z' };
  const attribution = { groups: [{ rootPid: 42 }] };
  const snapshotMachine = {
    machine: 'macwork',
    history: [oldSample],
    historyFreshness: {
      source: 'restored',
      latestSampleAt: oldSample.collectedAt,
      ageMs: 30_000,
      stale: false,
    },
    processAttribution: attribution,
  } as ResourcePressureSnapshotResult['machines'][number];
  const previewMachine = {
    machine: 'macwork',
    online: true,
    history: [oldSample, newSample],
    historyFreshness: {
      source: 'live',
      latestSampleAt: newSample.collectedAt,
      ageMs: 1_000,
      stale: false,
    },
  } as ResourcePressureHistoryResult['machines'][number];

  const [merged] = mergePressureHistoryForRender([snapshotMachine], [previewMachine]);
  assert.equal(merged.history.length, 2);
  assert.equal(merged.historyFreshness?.source, 'live');
  assert.equal(merged.processAttribution, attribution);

  const newestSample = { ...newSample, collectedAt: '2026-08-21T09:01:00.000Z' };
  const newerSnapshot = {
    ...snapshotMachine,
    history: [oldSample, newSample, newestSample],
    historyFreshness: {
      source: 'live' as const,
      latestSampleAt: newestSample.collectedAt,
      ageMs: 500,
      stale: false,
    },
  };
  const [preserved] = mergePressureHistoryForRender([newerSnapshot], [previewMachine]);
  assert.equal(preserved.history.at(-1)?.collectedAt, newestSample.collectedAt);
  assert.equal(preserved.history.length, 3);
});

test('cleanup eligibility detects drift and execution strips display fields', () => {
  const first = { machine: 'macwork', slotId: 'slot-1', resourceId: 'metro' };
  const second = { machine: 'macpro', slotId: 'slot-2', resourceId: 'browser' };
  assert.equal(cleanupTargetsRemainEligible([first], [first, second]), true);
  assert.equal(cleanupTargetsRemainEligible([first], [second]), false);
  const extended = { ...first, ignored: 'value' };
  assert.deepEqual(cleanupExecutionTargets([extended]), [first]);
});

function group(classification: ProcessAttributionGroup['classification'], pid: number) {
  return { classification, rootPid: pid } as ProcessAttributionGroup;
}

test('pressure chart stays bounded to thirty fixed-scale samples', () => {
  const points = pressureSparklinePoints(
    Array.from({ length: 40 }, (_, index) => index / 10),
    2,
  );
  assert.equal(points.split(' ').length, 30);
  assert.match(points, /^0\.0,/);
  assert.match(points, /100\.0,2\.0$/);
});

test('process presentation shortens app paths and expresses multi-core CPU', () => {
  assert.equal(
    pressureProcessName(
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ),
    'Google Chrome Canary',
  );
  assert.equal(pressureProcessName('(simctl)'), 'simctl');
  assert.equal(pressureProcessCpu(279.2), '2.8 cores');
  assert.equal(pressureProcessCpu(55.1), '55.1%');
  assert.equal(pressureLoadRatio(1.324), '1.32×');
  assert.equal(pressureLoadRatio(undefined), '–');
  assert.equal(pressureOwnershipLabel('unknown'), 'system / unmapped');
  assert.equal(pressureOwnershipLabel('active'), 'active');
});

test('bounded process rows retain managed and stale work', () => {
  const groups = [group('unknown', 1), group('manual', 2), group('unknown', 3), group('active', 4)];
  assert.deepEqual(
    visiblePressureGroups(groups, 2).map((entry) => entry.rootPid),
    [1, 4],
  );
  const managed = [
    group('unknown', 1),
    group('active', 2),
    group('stale', 3),
    group('retained', 4),
  ];
  assert.deepEqual(
    visiblePressureGroups(managed, 3).map((entry) => entry.rootPid),
    [1, 2, 3],
  );
  assert.equal(
    pressureSampleAge('2026-08-20T00:00:00.000Z', Date.parse('2026-08-20T00:01:30.000Z')),
    '1m ago',
  );
  assert.equal(pressureSampleAge('not-a-date'), 'unknown sample age');
});

test('history freshness: restored rings render immediately with explicit provenance', () => {
  // Restored-from-store history labels itself instead of waiting for three
  // live 30s samples before rendering anything.
  assert.equal(
    pressureHistoryFreshnessLabel({
      source: 'restored',
      latestSampleAt: '2026-08-21T09:58:00.000Z',
      ageMs: 120_000,
      stale: false,
    }),
    'restored from last session · 2m old',
  );
  assert.equal(
    pressureHistoryFreshnessLabel({
      source: 'restored',
      latestSampleAt: '2026-08-21T09:00:00.000Z',
      ageMs: 3_600_000,
      stale: true,
    }),
    'restored from last session · 60m old · stale',
  );
  // Fresh live history needs no provenance label at all.
  assert.equal(
    pressureHistoryFreshnessLabel({
      source: 'live',
      latestSampleAt: '2026-08-21T09:59:30.000Z',
      ageMs: 30_000,
      stale: false,
    }),
    '',
  );
  // A live source that went stale still states it.
  assert.equal(
    pressureHistoryFreshnessLabel({
      source: 'live',
      latestSampleAt: '2026-08-21T09:50:00.000Z',
      ageMs: 600_000,
      stale: true,
    }),
    'live · 10m old · stale',
  );
  assert.equal(pressureHistoryFreshnessLabel(undefined), '');
});

test('history freshness: machines with no samples state it explicitly', () => {
  assert.equal(
    pressureHistoryFreshnessLabel({
      source: 'none',
      latestSampleAt: null,
      ageMs: null,
      stale: true,
    }),
    'no samples yet',
  );
});
