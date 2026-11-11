import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { NodeSystemMetrics } from '@farmslot/protocol';

const warnings: Array<{ type: string; summary: string; severity?: string }> = [];
const realObserver = await import('../chat/copilot-observer.js');
mock.module('../chat/copilot-observer.js', {
  namedExports: {
    ...realObserver,
    reportGatewayWarning: (type: string, summary: string, severity?: string) =>
      warnings.push({ type, summary, severity }),
  },
});
const { updateMachineMetrics, getMachineHealth } = await import('./node-health.js');

const base: NodeSystemMetrics = {
  cpuPercent: 1,
  memoryPercent: 1,
  memoryUsedGb: 1,
  memoryTotalGb: 16,
  diskPercent: 1,
  loadAvg1: 0,
  loadAvg5: 0,
  collectedAt: '2024-01-01T00:00:00Z',
};

test('TCP severity transitions reach the existing operator health feed once per band', () => {
  for (const [total, severity] of [
    [5, 'warning'],
    [6, 'warning'],
    [8, 'critical'],
  ] as const) {
    updateMachineMetrics('tcp-node', {
      ...base,
      tcp: {
        established: total - 1,
        timeWait: 1,
        total,
        ephemeralFirst: 40000,
        ephemeralLast: 40009,
        ephemeralCapacity: 10,
        warningThreshold: 5,
        criticalThreshold: 8,
        severity,
        topProcesses: [{ pid: 101, command: 'fixture-server', connections: total - 1 }],
        collectedAt: base.collectedAt,
      },
    });
  }
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0].severity, 'warn');
  assert.equal(warnings[1].severity, 'error');
  assert.match(warnings[1].summary, /tcp-node.*critical/);
  assert.match(warnings[1].summary, /fixture-server.*101/);
  assert.equal(getMachineHealth('tcp-node')?.headroom, 'red');
});
