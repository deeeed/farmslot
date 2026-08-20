import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const collectedAt = new Date().toISOString();
let tmuxFailure = false;
let omitPollStatus = false;
let failedResolutionSlot = '';
let resourceResolutionCalls = 0;
let tmuxCalls = 0;
const controlledTargets: string[] = [];

mock.module('../fleet/resource-manager.js', {
  namedExports: {
    executeResourceControl: async (slotId: string, resourceId: string) => {
      controlledTargets.push(`${slotId}:${resourceId}`);
      return { ok: true };
    },
    getActiveResources: (slotId: string) =>
      slotId === 'slot-1'
        ? new Map([['metro', { pid: 42, startedAt: collectedAt, runId: 'run-1' }]])
        : undefined,
    getCachedResourceStatus: () => 'running',
    getCachedSlotResources: () => new Map([['metro', 'running']]),
    getResourceWatchRuntimeState: () => ({ enabled: true, updatedAt: collectedAt }),
    pollSlotResources: async () => (omitPollStatus ? [] : [{ id: 'metro', status: 'stopped' }]),
    resolveSlotResources: async (slotId: string) => {
      resourceResolutionCalls += 1;
      if (slotId === failedResolutionSlot) throw new Error('project config unavailable');
      return [
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
      ];
    },
    setResourceWatchesEnabled: async () => ({ ok: true, enabled: true }),
  },
});

mock.module('../fleet/node-health.js', {
  namedExports: {
    getMachineProcessSamplerHealth: () => ({
      attempts: 1,
      executions: 1,
      failures: 0,
      skippedBusy: 0,
      skippedCadence: 0,
      lastDurationMs: 3,
    }),
    getMachineProcessInventory: () => ({
      generation: 'node:1',
      sampleId: 1,
      collectedAt,
      totalProcesses: 2,
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
        {
          pid: 43,
          ppid: 1,
          cpuPercent: 10,
          rssBytes: 524_288,
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
        {
          slot: 'slot-2',
          machine: 'macpro',
          project: 'farmslot-farm',
          enabled: true,
          lifecycle: 'ready',
          agent: 'idle',
          currentRunId: null,
        },
        {
          slot: 'foreign-slot',
          machine: 'macpro',
          project: 'other-farm',
          enabled: true,
          lifecycle: 'busy',
          agent: 'working',
          currentRunId: 'run-2',
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
        ...Array.from({ length: 33 }, (_, index) => ({
          machine: index === 32 ? 'zz-critical' : `extra-${String(index).padStart(2, '0')}`,
          online: true,
          headroom: index === 32 ? 'red' : 'green',
          capacity: { maxSlots: 0, activeSlots: 0, cpuCores: 10 },
          system: {
            cpuPercent: index === 32 ? 95 : 10,
            memoryPercent: 20,
            memoryUsedGb: 4,
            memoryTotalGb: 32,
            diskPercent: 30,
            loadAvg1: 1,
            loadAvg5: 1,
            collectedAt,
          },
        })),
      ],
    }),
  },
});

mock.module('../runs/store.js', {
  namedExports: {
    getAllRuns: () => [
      { id: 'run-1', slotId: 'slot-1', status: 'monitoring' },
      { id: 'run-2', slotId: 'foreign-slot', status: 'monitoring' },
    ],
  },
});

mock.module('./tmux-workers.js', {
  namedExports: {
    tmuxWorkerList: async () => {
      tmuxCalls += 1;
      if (tmuxFailure) throw new Error('tmux timeout');
      return {
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
          {
            ref: { nodeId: 'macpro', session: 'foreign-slot', target: 'foreign-slot:dev' },
            pid: 43,
            linkedSlotId: 'foreign-slot',
            linkedRunId: 'run-2',
            status: { label: 'active', source: 'hook', confidence: 'high', state: 'active' },
          },
        ],
      };
    },
  },
});

const {
  resourceCleanup,
  resourceHostPressure,
  resourcePressureSnapshot,
  resourcePressureSnapshotForModel,
} = await import('./resource.js');

test('resource pressure snapshot exposes bounded trends and active attribution', async () => {
  const exactCleanup = await resourceCleanup({
    dryRun: true,
    targets: [{ machine: 'macpro', slotId: 'slot-2', resourceId: 'metro' }],
  });
  assert.deepEqual(
    exactCleanup.targets.map((target) => `${target.machine}:${target.slotId}:${target.resourceId}`),
    ['macpro:slot-2:metro'],
  );
  assert.equal((await resourceCleanup({ dryRun: true, targets: [] })).targets.length, 0);
  const executedCleanup = await resourceCleanup({
    dryRun: false,
    targets: [
      { machine: 'macpro', slotId: 'slot-2', resourceId: 'metro' },
      { machine: 'macpro', slotId: 'slot-2', resourceId: 'metro' },
    ],
  });
  assert.equal(executedCleanup.stopped, 1);
  assert.deepEqual(controlledTargets, ['slot-2:metro']);
  omitPollStatus = true;
  const unverifiedCleanup = await resourceCleanup({
    dryRun: false,
    targets: [{ machine: 'macpro', slotId: 'slot-2', resourceId: 'metro' }],
  });
  omitPollStatus = false;
  assert.equal(unverifiedCleanup.ok, false);
  assert.equal(unverifiedCleanup.failed, 1);
  assert.match(
    unverifiedCleanup.targets[0].detail ?? '',
    /verification returned no resource status/,
  );
  const busyCleanup = await resourceCleanup({
    dryRun: false,
    targets: [{ machine: 'macpro', slotId: 'slot-1', resourceId: 'metro' }],
  });
  assert.equal(busyCleanup.targets.length, 1);
  assert.equal(busyCleanup.targets[0].ok, false);
  assert.equal(busyCleanup.ok, false);
  assert.deepEqual(controlledTargets, ['slot-2:metro', 'slot-2:metro']);
  failedResolutionSlot = 'slot-2';
  const unresolvedCleanup = await resourceCleanup({
    dryRun: false,
    targets: [{ machine: 'macpro', slotId: 'slot-2', resourceId: 'metro' }],
  });
  failedResolutionSlot = '';
  assert.equal(unresolvedCleanup.ok, false);
  assert.equal(unresolvedCleanup.targets[0].ok, false);
  assert.match(unresolvedCleanup.targets[0].detail ?? '', /project config unavailable/);
  const wrongMachineCleanup = await resourceCleanup({
    dryRun: false,
    targets: [{ machine: 'mini', slotId: 'slot-2', resourceId: 'metro' }],
  });
  assert.equal(wrongMachineCleanup.targets[0].project, 'unknown');
  assert.match(wrongMachineCleanup.targets[0].detail ?? '', /slot no longer exists/);

  const hostOnly = await resourceHostPressure('macpro', 'farmslot-farm');
  assert.equal(hostOnly.machine, 'macpro');
  assert.equal(hostOnly.online, true);

  const tmuxCallsBeforeEmptyFilter = tmuxCalls;
  const emptyFiltered = await resourcePressureSnapshot({ machines: [] });
  assert.equal(emptyFiltered.machines.length, 0);
  assert.equal(tmuxCalls, tmuxCallsBeforeEmptyFilter);
  const blankFiltered = await resourcePressureSnapshot({ machine: '   ' });
  assert.equal(blankFiltered.machines.length, 0);
  assert.equal(tmuxCalls, tmuxCallsBeforeEmptyFilter);

  const result = await resourcePressureSnapshot({
    machines: ['macpro'],
    projects: ['farmslot-farm'],
  });
  assert.equal(result.machines.length, 1);
  assert.equal(result.summary.omittedMachines, 0);
  assert.equal(result.summary.omittedCleanupCandidates, 0);
  assert.equal(result.machines[0].history.length, 1);
  assert.equal(result.machines[0].processAttribution.groups[0].classification, 'active');
  assert.equal(result.machines[0].processAttribution.groups[0].runId, 'run-1');
  assert.equal(result.machines[0].processAttribution.sampler?.executions, 1);
  assert.equal(result.machines[0].processAttribution.sampledProcesses, 2);
  assert.doesNotMatch(
    JSON.stringify(result.machines[0].processAttribution.groups),
    /run-2|foreign-slot/,
  );
  assert.equal(result.cleanupCandidates.length, 1);
  assert.deepEqual(
    {
      slotId: result.cleanupCandidates[0].slotId,
      slotLifecycle: result.cleanupCandidates[0].slotLifecycle,
      effect: result.cleanupCandidates[0].effect,
      activeWorkExcluded: result.cleanupCandidates[0].activeWorkExcluded,
    },
    {
      slotId: 'slot-2',
      slotLifecycle: 'ready',
      effect: 'configured-shutdown-hook',
      activeWorkExcluded: true,
    },
  );
  const unionFiltered = await resourcePressureSnapshot({
    machine: 'missing-machine',
    machines: ['macpro'],
    project: 'missing-project',
    projects: ['farmslot-farm'],
  });
  assert.deepEqual(
    unionFiltered.machines.map((machine) => machine.machine),
    ['macpro'],
  );
  const capped = await resourcePressureSnapshot();
  assert.equal(capped.machines.length, 32);
  assert.equal(capped.summary.omittedMachines, 2);
  assert.ok(capped.machines.some((machine) => machine.machine === 'zz-critical'));
  assert.equal(capped.summary.severity, 'critical');
  const resolutionCallsAfterFirstSnapshot = resourceResolutionCalls;

  tmuxFailure = true;
  const degraded = await resourcePressureSnapshot({
    machine: 'macpro',
    project: 'farmslot-farm',
  });
  tmuxFailure = false;
  assert.equal(degraded.machines[0].history.length, 1);
  assert.equal(resourceResolutionCalls, resolutionCallsAfterFirstSnapshot);
  assert.equal(degraded.machines[0].processAttribution.groups[0].classification, 'active');
  assert.match(degraded.machines[0].processAttribution.degradedReason ?? '', /tmux timeout/i);

  result.machines[0].processAttribution.groups[0].topExecutable =
    '/Users/developer/Applications/Private Tool.app/Contents/MacOS/Private Tool';
  const originalGroup = result.machines[0].processAttribution.groups[0];
  result.machines[0].processAttribution.groups = Array.from({ length: 10 }, (_, index) => ({
    ...originalGroup,
    rootPid: originalGroup.rootPid + index,
    topPid: originalGroup.topPid + index,
  }));
  result.machines[0].processAttribution.managedGroupCount = 10;
  result.machines[0].processAttribution.managedClassCounts = {
    active: 10,
    retained: 0,
    stale: 0,
    manual: 0,
    unknown: 0,
  };
  result.machines[0].processAttribution.sampler!.lastError =
    'Command /Users/developer/bin/ps failed';
  result.machines[0].processAttribution.degradedReason = 'Tmux attribution unavailable';
  const modelProjection = resourcePressureSnapshotForModel(result);
  const serialized = JSON.stringify(modelProjection);
  assert.doesNotMatch(serialized, /rootPid|topPid|lastError|\/Users\/developer/);
  assert.doesNotMatch(serialized, /"slotId"|"runId"|"resourceId"|"system"|"watchState"/);
  assert.doesNotMatch(serialized, /"cleanupCandidates":\[/);
  assert.match(serialized, /"process":"Private Tool"/);
  assert.match(serialized, /"degradedReason":"Tmux attribution unavailable"/);
  assert.equal(modelProjection.machines[0].processAttribution.omittedGroups, 2);
  assert.equal(modelProjection.machines[0].processAttribution.classCounts.active, 10);
});
