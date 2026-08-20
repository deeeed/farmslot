import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type ProcessAttributionGroup, selectResourcePressureGroups } from '../../src/index.js';

function group(
  rootPid: number,
  classification: ProcessAttributionGroup['classification'],
  cpuPercent: number,
): ProcessAttributionGroup {
  return {
    rootPid,
    processCount: 1,
    executable: `process-${rootPid}`,
    topPid: rootPid,
    topExecutable: `process-${rootPid}`,
    topCpuPercent: cpuPercent,
    topRssBytes: 1,
    cpuPercent,
    rssBytes: 1,
    classification,
    confidence: 'high',
    evidence: [],
  };
}

test('bounded pressure groups keep the hottest tree plus managed ownership evidence', () => {
  const groups = [group(1, 'unknown', 100), group(2, 'unknown', 90), group(3, 'active', 5)];
  assert.deepEqual(
    selectResourcePressureGroups(groups, 2).map((candidate) => candidate.rootPid),
    [1, 3],
  );
  assert.deepEqual(selectResourcePressureGroups(groups, 0), []);
});
