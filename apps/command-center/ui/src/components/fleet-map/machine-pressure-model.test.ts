import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ProcessAttributionGroup } from '@farmslot/protocol';

import {
  cleanupExecutionTargets,
  cleanupTargetSetMatches,
  cleanupTargetsRemainEligible,
  pressureProcessCpu,
  pressureProcessName,
  pressureSampleAge,
  pressureSparklinePoints,
  visiblePressureGroups,
} from './machine-pressure-model.js';

test('cleanup target comparison is order-independent and detects drift', () => {
  const first = { machine: 'macwork', slotId: 'slot-1', resourceId: 'metro' };
  const second = { machine: 'macpro', slotId: 'slot-2', resourceId: 'browser' };
  assert.equal(cleanupTargetSetMatches([first, second], [second, first]), true);
  assert.equal(cleanupTargetSetMatches([first], [second]), false);
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
