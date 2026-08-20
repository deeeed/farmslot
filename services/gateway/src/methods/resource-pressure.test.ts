import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const collectedAt = '2026-08-20T00:00:00.000Z';

mock.module('../fleet/resource-manager.js', {
  namedExports: {
    executeResourceControl: async () => ({ ok: true }),
    getActiveResources: () =>
      new Map([['metro', { pid: 42, startedAt: collectedAt, runId: 'run-1' }]]),
    getCachedResourceStatus: () => 'running',
    getResourceWatchRuntimeState: () => ({ enabled: true, updatedAt: collectedAt }),
    pollSlotResources: async () => [],
    resolveSlotResources: async () => [
      {
        id: 'metro',
        status: 'running',
        definition: {
          type: 'dev-server',
          label: 'Metro',
          streamable: false,
          controllable: true,
          hooks: { shutdown: 'stop-metro' },
        },
      },
    ],
    setResourceWatchesEnabled: async () => ({ ok: true, enabled: true }),
  },
});

mock.module('../fleet/node-health.js', {
  namedExports: {
    getMachineProcessInventory: () => ({
      generation: 'node:1',
      sampleId: 1,
      collectedAt,
      totalProcesses: 1,
      maxEntries: 256,
      truncated: false,
      health: {
        attempts: 1,
        executions: 1,
        failures: 0,
        skippedBusy: 0,
        skippedCadence: 0,
        lastDurationMs: 3,
      },
      processes: [
        {
          pid: 42,
          ppid: 1,
          cpuPercent: 20,
          rssBytes: 1_048_576,
          elapsedSeconds: 10,
          executable: 'node',
        },
      ],
    }),
    getMachinePressureHistory: () => [
      {
        collectedAt,
        pressure: { cpu: 0.5, memory: 0.4, disk: 0.3, load1: 0.2, load5: 0.1 },
        cpuPercent: 50,
        memoryPercent: 40,
        diskPercent: 30,
        loadAvg1: 2,
        loadAvg5: 1,
      },
    ],
  },
});

mock.module('../fleet/state.js', {
  namedExports: {
    loadFleetStatus: async () => ({
      slots: [
        {
          slot: 'slot-1',
          machine: 'macpro',
          project: 'farmslot-farm',
          enabled: true,
          lifecycle: 'busy',
          agent: 'working',
          currentRunId: 'run-1',
        },
      ],
      machines: [
        {
          machine: 'macpro',
          online: true,
          headroom: 'green',
          capacity: { maxSlots: 6, activeSlots: 1, cpuCores: 10 },
          system: {
            cpuPercent: 50,
            memoryPercent: 40,
            memoryUsedGb: 12,
            memoryTotalGb: 32,
            diskPercent: 30,
            loadAvg1: 2,
            loadAvg5: 1,
            collectedAt,
          },
        },
      ],
    }),
  },
});

mock.module('../runs/store.js', {
  namedExports: {
    getAllRuns: () => [{ id: 'run-1', status: 'monitoring' }],
  },
});

mock.module('./tmux-workers.js', {
  namedExports: {
    tmuxWorkerList: async () => ({
      observedAt: Date.now(),
      nodes: [],
      workers: [
        {
          ref: { nodeId: 'macpro', session: 'slot-1', target: 'slot-1:dev' },
          pid: 42,
          linkedSlotId: 'slot-1',
          linkedRunId: 'run-1',
          status: { label: 'active', source: 'hook', confidence: 'high', state: 'active' },
        },
      ],
    }),
  },
});

const { resourceHostPressure, resourcePressureSnapshot, resourcePressureSnapshotForModel } =
  await import('./resource.js');

test('resource pressure snapshot exposes bounded trends and active attribution', async () => {
  const hostOnly = await resourceHostPressure('macpro', 'farmslot-farm');
  assert.equal(hostOnly.machine, 'macpro');
  assert.equal(hostOnly.online, true);

  const result = await resourcePressureSnapshot({ machine: 'macpro' });
  assert.equal(result.machines.length, 1);
  assert.equal(result.machines[0].history.length, 1);
  assert.equal(result.machines[0].processAttribution.groups[0].classification, 'active');
  assert.equal(result.machines[0].processAttribution.groups[0].runId, 'run-1');
  assert.equal(result.machines[0].processAttribution.sampler?.executions, 1);
  assert.equal(result.machines[0].processAttribution.sampledProcesses, 1);
  assert.equal(result.cleanupCandidates.length, 0);

  result.machines[0].processAttribution.groups[0].topExecutable =
    '/Users/developer/Applications/Private Tool.app/Contents/MacOS/Private Tool';
  result.machines[0].processAttribution.sampler!.lastError =
    'Command /Users/developer/bin/ps failed';
  const modelProjection = resourcePressureSnapshotForModel(result);
  const serialized = JSON.stringify(modelProjection);
  assert.doesNotMatch(serialized, /rootPid|topPid|lastError|\/Users\/developer/);
  assert.match(serialized, /"process":"Private Tool"/);
});
