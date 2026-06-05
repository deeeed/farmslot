import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NodeSystemMetrics, RecipeRuntimeCapabilityDeclaration } from '@farmslot/protocol';

import { getMachineHealth, markMachineOnline, updateMachineMetrics } from './node-health.js';

test('machine health preserves node capture capabilities across metrics updates', () => {
  const machine = `capability-node-${Date.now()}`;
  const capabilities: RecipeRuntimeCapabilityDeclaration[] = [
    {
      capability: 'capture.stream',
      status: 'supported',
      provider: 'capture-helper',
      platforms: ['macos'],
      modes: ['framed-h264'],
    },
    {
      capability: 'record.video',
      status: 'unsupported',
      provider: 'capture-helper',
      reason: 'capture-helper doctor failed',
    },
  ];
  const metrics: NodeSystemMetrics = {
    cpuPercent: 10,
    memoryPercent: 20,
    memoryUsedGb: 3,
    memoryTotalGb: 16,
    diskPercent: 30,
    loadAvg1: 1,
    loadAvg5: 1.2,
    collectedAt: new Date().toISOString(),
  };

  markMachineOnline(machine, capabilities);
  assert.deepEqual(getMachineHealth(machine)?.capabilities, capabilities);

  updateMachineMetrics(machine, metrics);
  assert.deepEqual(getMachineHealth(machine)?.capabilities, capabilities);
  assert.equal(getMachineHealth(machine)?.system?.cpuPercent, 10);
});
