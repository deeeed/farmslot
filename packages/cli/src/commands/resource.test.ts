import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ResourcePressureSnapshotResult } from '@farmslot/protocol';

import { formatResourcePressure } from './resource.js';

test('pressure formatter includes trends, classes, sampler degradation, and no mutation action', () => {
  const result = {
    checkedAt: '2026-08-20T00:00:00.000Z',
    watchState: { enabled: true, updatedAt: null },
    watchAutoStartEnabled: true,
    cleanupScope: 'non-active-slots-only',
    filters: {},
    summary: {
      machines: 1,
      omittedMachines: 0,
      severity: 'warn',
      cleanupCandidates: 0,
      omittedCleanupCandidates: 0,
      runningResources: 1,
      staleResources: 0,
      busySlots: 1,
      workingSlots: 1,
    },
    machines: [
      {
        machine: 'macpro',
        online: true,
        headroom: 'yellow',
        severity: 'warn',
        concerns: [],
        history: [
          {
            collectedAt: '2026-08-20T00:00:00.000Z',
            pressure: { cpu: 0.2, memory: 0.3, disk: 0.4, load1: 0.1, load5: 0.1 },
            cpuPercent: 20,
            memoryPercent: 30,
            diskPercent: 40,
            loadAvg1: 1,
            loadAvg5: 1,
          },
        ],
        processAttribution: {
          truncated: true,
          ancestryTruncated: false,
          sampledProcesses: 1,
          totalProcesses: 400,
          maxEntries: 256,
          omittedGroups: 1,
          classCounts: { active: 1, retained: 0, stale: 0, manual: 0, unknown: 1 },
          groups: [
            {
              rootPid: 42,
              processCount: 2,
              executable: 'node',
              topPid: 43,
              topExecutable: 'gradle',
              topCpuPercent: 50,
              topRssBytes: 1_048_576,
              cpuPercent: 50,
              rssBytes: 1_048_576,
              classification: 'active',
              confidence: 'high',
              evidence: ['active-run:run-1'],
            },
          ],
          sampler: {
            attempts: 2,
            executions: 1,
            failures: 0,
            skippedBusy: 1,
            skippedCadence: 4,
            lastDurationMs: 4,
            lastError: 'ps timed out',
          },
        },
        slots: { total: 1, ready: 0, busy: 1, working: 1, manual: 0, disabled: 0 },
        resources: {
          total: 1,
          byStatus: { unknown: 0, running: 1, stopped: 0, error: 0, stale: 0 },
          cleanupCandidates: 0,
        },
      },
    ],
    cleanupCandidates: [],
  } satisfies ResourcePressureSnapshotResult;
  const output = formatResourcePressure(result);
  assert.match(output, /CPU 20%→20%/);
  assert.match(output, /active=1/);
  assert.match(output, /skippedBusy=1/);
  assert.match(output, /avoided=4/);
  assert.match(output, /error=ps timed out/);
  assert.match(output, /sampled=1\/400 \(truncated\)/);
  assert.doesNotMatch(output, /kill|stop|cleanup command/i);
});
