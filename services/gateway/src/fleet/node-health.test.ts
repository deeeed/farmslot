import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NodeSystemMetrics, RecipeRuntimeCapabilityDeclaration } from '@farmslot/protocol';

import {
  getMachineHealth,
  getMachinePressureHistory,
  getMachineProcessInventory,
  markMachineOnline,
  NODE_PRESSURE_HISTORY_LIMIT,
  updateMachineMetrics,
} from './node-health.js';

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

test('pressure history is bounded and rejects duplicate or out-of-order samples', () => {
  const machine = `history-node-${Date.now()}`;
  const base = Date.now();
  for (let index = 0; index <= NODE_PRESSURE_HISTORY_LIMIT; index += 1) {
    updateMachineMetrics(machine, {
      cpuPercent: index,
      memoryPercent: 20,
      memoryUsedGb: 3,
      memoryTotalGb: 16,
      diskPercent: 30,
      loadAvg1: 1,
      loadAvg5: 1,
      cpuCores: 10,
      collectedAt: new Date(base + index * 1_000).toISOString(),
    });
  }
  const history = getMachinePressureHistory(machine);
  assert.equal(history.length, NODE_PRESSURE_HISTORY_LIMIT);
  assert.equal(history[0].cpuPercent, 1);
  assert.equal(history.at(-1)?.cpuPercent, NODE_PRESSURE_HISTORY_LIMIT);

  updateMachineMetrics(machine, {
    cpuPercent: 99,
    memoryPercent: 99,
    memoryUsedGb: 15,
    memoryTotalGb: 16,
    diskPercent: 99,
    loadAvg1: 99,
    loadAvg5: 99,
    collectedAt: new Date(base).toISOString(),
  });
  assert.equal(getMachinePressureHistory(machine).at(-1)?.cpuPercent, NODE_PRESSURE_HISTORY_LIMIT);
});

test('node restart replaces process generation and stale same-generation samples cannot regress it', () => {
  const machine = `restart-node-${Date.now()}`;
  const metrics = (
    generation: string,
    sampleId: number,
    collectedAt: string,
  ): NodeSystemMetrics => ({
    cpuPercent: 10,
    memoryPercent: 20,
    memoryUsedGb: 3,
    memoryTotalGb: 16,
    diskPercent: 30,
    loadAvg1: 1,
    loadAvg5: 1,
    collectedAt,
    processInventory: {
      generation,
      sampleId,
      collectedAt,
      processes: [],
      totalProcesses: 0,
      maxEntries: 256,
      truncated: false,
      health: {
        attempts: sampleId,
        executions: sampleId,
        failures: 0,
        skippedBusy: 0,
        skippedCadence: 0,
        lastDurationMs: 1,
      },
    },
  });
  const now = Date.now();
  updateMachineMetrics(machine, metrics('generation-a', 2, new Date(now).toISOString()));
  updateMachineMetrics(machine, metrics('generation-a', 1, new Date(now + 1_000).toISOString()));
  assert.equal(getMachineProcessInventory(machine)?.sampleId, 2);
  assert.equal(getMachineHealth(machine)?.system?.processInventory, undefined);
  updateMachineMetrics(machine, metrics('generation-b', 1, new Date(now + 2_000).toISOString()));
  assert.equal(getMachineProcessInventory(machine)?.generation, 'generation-b');
});
