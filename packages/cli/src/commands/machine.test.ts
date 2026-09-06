import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';
import { WebSocketServer } from 'ws';

import type {
  MachineParkRecord,
  MachinePausePreviewResult,
  ResourcePressureMachine,
} from '@farmslot/protocol';

import {
  formatGateParkLine,
  formatMachinePauseResult,
  gateParkedPreviewRuns,
  gateParkedRuns,
  gateParksHoldingFreedSlot,
  isPartialMachineResult,
  machineRunSelector,
  pauseNextCommand,
  registerMachineCommand,
  rejectedTargetsFromPreview,
  resolveReviewedPreviewId,
  restoreNextCommand,
  reviewedTargetsFromPreview,
  withGateParks,
} from './machine.js';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(packageDir, '../..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const entry = path.join(packageDir, 'src', 'entry.ts');

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function spawnCli(args: string[], home: string): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [entry, ...args], {
      cwd: packageDir,
      env: { ...process.env, FARMSLOT_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('CLI fixture timed out'));
    }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

const pressure: ResourcePressureMachine = {
  machine: 'macwork',
  online: true,
  headroom: 'yellow',
  severity: 'warn',
  concerns: [],
  history: [
    {
      collectedAt: '2026-08-21T00:00:00.000Z',
      pressure: { cpu: 0.73, memory: 0.81, disk: 0.4, load1: 1.25, load5: 1.1 },
      cpuPercent: 73,
      memoryPercent: 81,
      diskPercent: 40,
      loadAvg1: 10,
      loadAvg5: 8.8,
    },
  ],
  processAttribution: {
    truncated: false,
    ancestryTruncated: false,
    sampledProcesses: 0,
    totalProcesses: 0,
    maxEntries: 256,
    omittedGroups: 0,
    classCounts: { active: 0, retained: 0, stale: 0, manual: 0, unknown: 0 },
    managedGroupCount: 0,
    managedClassCounts: { active: 0, retained: 0, stale: 0, manual: 0, unknown: 0 },
    groups: [],
  },
  slots: { total: 2, ready: 0, busy: 2, working: 2, manual: 0, disabled: 0 },
  resources: {
    total: 1,
    byStatus: { unknown: 0, running: 1, stopped: 0, error: 0, stale: 0 },
    cleanupCandidates: 0,
  },
};

function previewResult(): MachinePausePreviewResult {
  return {
    previewId: 'preview-1',
    machine: 'macwork',
    mode: 'release',
    selector: { kind: 'all' },
    createdAt: '2026-08-21T00:00:00.000Z',
    eligibleCount: 1,
    rejectedCount: 1,
    pressure,
    runs: [
      {
        runId: 'run-1',
        slotId: 'macwork-ff-1',
        generation: 3,
        selected: true,
        status: 'monitoring',
        currentStep: { index: 2, name: 'monitor', status: 'running' },
        slotDisposition: 'retained',
        eligibility: {
          eligible: true,
          code: 'ELIGIBLE_MONITORING',
          reason: 'monitoring is safely resumable',
        },
        recoveryPolicy: { kind: 'runner-session-reload', supported: true, runnerId: 'codex' },
        resourceManifest: {
          capturedAt: '2026-08-21T00:00:00.000Z',
          resources: [
            {
              resourceId: 'metro:8081',
              label: 'Metro',
              type: 'dev-server',
              observedStatus: 'running',
              phase: 'observed-running',
              capabilityLeaseIds: [],
            },
          ],
          capabilityLeases: [
            {
              leaseId: 'lease-1',
              capabilityId: 'ios-simulator',
              state: 'held',
              parameters: {},
              proofRequirement: {
                capabilityId: 'ios-simulator',
                reason: 'visual proof',
                mode: 'visual',
              },
              resourceId: 'metro:8081',
            },
          ],
        },
      },
      {
        runId: 'run-2',
        slotId: 'macwork-ff-2',
        generation: 4,
        selected: true,
        status: 'dispatching',
        currentStep: { index: 3, name: 'publish', status: 'running' },
        slotDisposition: 'retained',
        eligibility: {
          eligible: false,
          code: 'UNSAFE_STATUS',
          reason: 'current step publication is not eligible',
        },
        recoveryPolicy: {
          kind: 'runner-session-reload',
          supported: false,
          runnerId: 'unknown',
          reason: 'unsupported',
        },
        resourceManifest: {
          capturedAt: '2026-08-21T00:00:00.000Z',
          resources: [],
          capabilityLeases: [],
        },
      },
    ],
  };
}

test('machine selector defaults to all and deduplicates include/exclude selections', () => {
  assert.deepEqual(machineRunSelector({}), { kind: 'all' });
  assert.deepEqual(machineRunSelector({ run: ['run-1', 'run-1', 'run-2'] }), {
    kind: 'include',
    runIds: ['run-1', 'run-2'],
  });
  assert.deepEqual(machineRunSelector({ excludeRun: ['run-2', 'run-2'] }), {
    kind: 'exclude',
    runIds: ['run-2'],
  });
  assert.throws(
    () => machineRunSelector({ run: ['run-1'], excludeRun: ['run-2'] }),
    /cannot be used together/u,
  );
});

test('commander rejects invalid pause modes and conflicting selectors before RPC', async () => {
  const program = new Command('farmslot').exitOverride().configureOutput({ writeErr: () => {} });
  registerMachineCommand(program);
  await assert.rejects(
    () =>
      program.parseAsync(['machine', 'pause', 'macwork', '--mode', 'invalid'], { from: 'user' }),
    (error: unknown) => (error as { code?: string }).code === 'commander.invalidArgument',
  );
  await assert.rejects(
    () =>
      program.parseAsync(
        ['machine', 'restore', 'macwork', '--run', 'run-1', '--exclude-run', 'run-2'],
        { from: 'user' },
      ),
    (error: unknown) => (error as { code?: string }).code === 'commander.conflictingOption',
  );
});

test('exact next commands preserve mode and reviewed selection', () => {
  assert.equal(
    pauseNextCommand('mac work', 'release', { kind: 'include', runIds: ['run-1', 'run 2'] }),
    "farmslot machine pause 'mac work' --mode release --run 'run-1' --run 'run 2' --execute",
  );
  assert.equal(
    restoreNextCommand('macpro', { kind: 'exclude', runIds: ['run-old'] }),
    "farmslot machine restore 'macpro' --exclude-run 'run-old' --execute",
  );
  assert.equal(
    pauseNextCommand("mac'$(touch nope)", 'orchestration', { kind: 'all' }),
    "farmslot machine pause 'mac'\\''$(touch nope)' --mode orchestration --execute",
  );
  assert.equal(
    pauseNextCommand('macpro', 'orchestration', { kind: 'all' }, 'preview-all'),
    "farmslot machine pause 'macpro' --mode orchestration --preview-id 'preview-all' --execute",
  );
  assert.equal(
    restoreNextCommand('macpro', { kind: 'exclude', runIds: ['run-old'] }, 'preview-exclude'),
    "farmslot machine restore 'macpro' --exclude-run 'run-old' --preview-id 'preview-exclude' --execute",
  );
});

test('reviewed preview ids accept an exact match and reject stale reviews with the fresh preview', () => {
  const preview = previewResult();
  const nextCommand = pauseNextCommand('macwork', 'release', preview.selector, preview.previewId);
  assert.equal(resolveReviewedPreviewId('preview-1', preview, nextCommand), 'preview-1');
  assert.equal(resolveReviewedPreviewId(undefined, preview, nextCommand), 'preview-1');
  assert.throws(
    () => resolveReviewedPreviewId('preview-old', preview, nextCommand),
    (error: unknown) => {
      const rich = error as {
        code?: string;
        userAction?: string;
        details?: { suppliedPreviewId?: string; freshPreviewId?: string; preview?: unknown };
      };
      assert.equal(rich.code, 'MACHINE_PREVIEW_STALE');
      assert.match(rich.userAction ?? '', /--preview-id 'preview-1'/u);
      assert.equal(rich.details?.suppliedPreviewId, 'preview-old');
      assert.equal(rich.details?.freshPreviewId, 'preview-1');
      assert.equal(rich.details?.preview, preview);
      return true;
    },
  );
});

test('preview formatter shows pressure, eligibility, recovery, resources, and exact next command', () => {
  const preview = previewResult();
  const output = formatMachinePauseResult(
    preview,
    "farmslot machine pause 'macwork' --mode release --preview-id 'preview-1' --execute",
  );
  assert.match(output, /macwork {2}mode=release/u);
  assert.match(
    output,
    /Pressure {2}warn {2}CPU 73% {2}memory 81% {2}disk 40% {2}load\/core 1\.25x/u,
  );
  assert.match(output, /run-1 {2}selected {2}eligible/u);
  assert.match(output, /recovery: kind=runner-session-reload supported=true runnerId=codex/u);
  assert.match(output, /resources: metro:8081/u);
  assert.match(output, /capability leases: lease-1/u);
  assert.match(output, /run-2 {2}selected {2}rejected/u);
  assert.match(output, /reason \(UNSAFE_STATUS\): current step publication is not eligible/u);
  assert.match(
    output,
    /Next {2}farmslot machine pause 'macwork' --mode release --preview-id 'preview-1' --execute/u,
  );
});

test('durable status formatter preserves phases, errors, and residuals', () => {
  const parkRecord: MachineParkRecord = {
    version: 1,
    operationId: 'operation-1',
    previewId: 'preview-1',
    runId: 'run-3',
    generation: 5,
    machine: 'macpro',
    slotId: 'macpro-ff-1',
    mode: 'release',
    phase: 'partial',
    prePauseStatus: 'monitoring',
    prePauseCurrentStep: { index: 2, name: 'monitor', status: 'running' },
    resourceManifest: {
      capturedAt: '2026-08-21T00:00:00.000Z',
      resources: [
        {
          resourceId: 'metro:8082',
          label: 'Metro',
          type: 'dev-server',
          observedStatus: 'running',
          phase: 'failed',
          capabilityLeaseIds: [],
          error: 'Metro stayed up',
        },
      ],
      capabilityLeases: [],
    },
    recoveryHandle: null,
    errors: [
      {
        phase: 'partial',
        action: 'resource-stop',
        code: 'HOOK_FAILED',
        message: 'Metro stayed up',
        occurredAt: '2026-08-21T00:00:01.000Z',
        retryable: true,
        resourceId: 'metro:8082',
      },
    ],
    residuals: { runner: 'stopped', resources: [{ resourceId: 'metro:8082', state: 'running' }] },
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:01.000Z',
  };
  const output = formatMachinePauseResult({
    machine: 'macpro',
    pressure: { ...pressure, machine: 'macpro', severity: 'critical' },
    records: [parkRecord],
  });
  assert.match(output, /phase=partial/u);
  assert.match(output, /error \(partial\/HOOK_FAILED\): Metro stayed up/u);
  assert.match(output, /residuals: runner=stopped resources=resourceId=metro:8082 state=running/u);
  assert.equal(isPartialMachineResult({ outcome: 'partial', ok: false }), true);
});

test('execution target handoff contains only eligible reviewed generations', () => {
  const preview = previewResult();
  preview.runs.push({
    ...preview.runs[0],
    runId: 'run-unselected',
    generation: 9,
    selected: false,
  });
  assert.deepEqual(reviewedTargetsFromPreview(preview), [{ runId: 'run-1', generation: 3 }]);
  assert.deepEqual(
    rejectedTargetsFromPreview(preview).map((run) => run.runId),
    ['run-2'],
  );
});

test('machine JSON execution accepts a matching pin and preserves a stale preview in one error envelope', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const preview = previewResult();
  preview.runs = [preview.runs[0]];
  preview.eligibleCount = 1;
  preview.rejectedCount = 0;

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const request = JSON.parse(String(data)) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      if (request.method === 'auth.connect') {
        socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: {} }));
        return;
      }
      calls.push({ method: request.method, params: request.params });
      if (request.method === 'machine.pause.preview') {
        socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: preview }));
        return;
      }
      if (request.method === 'machine.pause.execute') {
        socket.send(
          JSON.stringify({
            type: 'res',
            id: request.id,
            ok: true,
            payload: {
              ok: true,
              outcome: 'complete',
              operationId: 'operation-1',
              machine: 'macwork',
              mode: 'release',
              records: [],
            },
          }),
        );
        return;
      }
      if (request.method === 'machine.pause.restore') {
        const execute = request.params.execute === true;
        socket.send(
          JSON.stringify({
            type: 'res',
            id: request.id,
            ok: true,
            payload: {
              ok: true,
              outcome: execute ? 'complete' : 'preview',
              execute,
              previewId: 'restore-preview-1',
              ...(execute ? { operationId: 'restore-operation-1' } : {}),
              machine: 'macwork',
              selector: request.params.selector,
              runs: [],
              records: [],
            },
          }),
        );
        return;
      }
      socket.send(
        JSON.stringify({
          type: 'res',
          id: request.id,
          ok: false,
          error: { code: 'UNEXPECTED_METHOD', message: request.method },
        }),
      );
    });
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `ws://127.0.0.1:${address.port}`;
  const home = mkdtempSync(path.join(os.tmpdir(), 'farmslot-machine-preview-'));
  try {
    const common = [
      '--url',
      url,
      '--timeout',
      '3000',
      '--json',
      'machine',
      'pause',
      'macwork',
      '--mode',
      'release',
      '--run',
      'run-1',
      '--execute',
    ];
    const matching = await spawnCli([...common, '--preview-id', 'preview-1'], home);
    assert.equal(matching.status, 0, matching.stderr);
    const matchingEnvelope = JSON.parse(matching.stdout) as {
      status: string;
      data: { outcome: string };
    };
    assert.equal(matchingEnvelope.status, 'ok');
    assert.equal(matchingEnvelope.data.outcome, 'complete');
    assert.deepEqual(
      calls.map((call) => call.method),
      ['machine.pause.preview', 'machine.pause.execute'],
    );
    assert.equal(calls[1].params.previewId, 'preview-1');

    const stale = await spawnCli([...common, '--preview-id', 'preview-old'], home);
    assert.equal(stale.status, 1, stale.stderr);
    const staleEnvelope = JSON.parse(stale.stdout) as {
      status: string;
      error: {
        code: string;
        details: { suppliedPreviewId: string; freshPreviewId: string; preview: unknown };
      };
    };
    assert.equal(staleEnvelope.status, 'error');
    assert.equal(staleEnvelope.error.code, 'MACHINE_PREVIEW_STALE');
    assert.equal(staleEnvelope.error.details.suppliedPreviewId, 'preview-old');
    assert.equal(staleEnvelope.error.details.freshPreviewId, 'preview-1');
    assert.deepEqual(staleEnvelope.error.details.preview, preview);
    assert.deepEqual(
      calls.map((call) => call.method),
      ['machine.pause.preview', 'machine.pause.execute', 'machine.pause.preview'],
      'stale review must fail before a second execute RPC',
    );

    const restoreCommon = [
      '--url',
      url,
      '--timeout',
      '3000',
      '--json',
      'machine',
      'restore',
      'macwork',
      '--exclude-run',
      'run-old',
      '--execute',
    ];
    const restoreMatching = await spawnCli(
      [...restoreCommon, '--preview-id', 'restore-preview-1'],
      home,
    );
    assert.equal(restoreMatching.status, 0, restoreMatching.stderr);
    const restoreEnvelope = JSON.parse(restoreMatching.stdout) as {
      status: string;
      data: { outcome: string };
    };
    assert.equal(restoreEnvelope.status, 'ok');
    assert.equal(restoreEnvelope.data.outcome, 'complete');
    assert.equal(calls[4].params.previewId, 'restore-preview-1');

    const restoreStale = await spawnCli(
      [...restoreCommon, '--preview-id', 'restore-preview-old'],
      home,
    );
    assert.equal(restoreStale.status, 1, restoreStale.stderr);
    const restoreStaleEnvelope = JSON.parse(restoreStale.stdout) as {
      error: { code: string; details: { freshPreviewId: string } };
    };
    assert.equal(restoreStaleEnvelope.error.code, 'MACHINE_PREVIEW_STALE');
    assert.equal(restoreStaleEnvelope.error.details.freshPreviewId, 'restore-preview-1');
    assert.deepEqual(
      calls.map((call) => call.method),
      [
        'machine.pause.preview',
        'machine.pause.execute',
        'machine.pause.preview',
        'machine.pause.restore',
        'machine.pause.restore',
        'machine.pause.restore',
      ],
      'stale restore review must fail before a second restore execution RPC',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function gateParkRecord(overrides: Partial<MachineParkRecord> = {}): MachineParkRecord {
  return {
    version: 1,
    operationId: 'operation-2',
    previewId: 'preview-2',
    runId: 'run-4',
    generation: 7,
    machine: 'macwork',
    slotId: 'macwork-ff-1',
    mode: 'release',
    phase: 'parked',
    prePauseStatus: 'human-gating',
    prePauseCurrentStep: { index: 6, name: 'human-gate', status: 'running' },
    resourceManifest: {
      capturedAt: '2026-09-05T10:00:00.000Z',
      resources: [],
      capabilityLeases: [],
    },
    recoveryHandle: null,
    errors: [],
    residuals: { runner: 'stopped', resources: [] },
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:05:00.000Z',
    slotDisposition: 'freed',
    slotFreedAt: '2026-09-05T10:05:00.000Z',
    preservedWorkspace: {
      branch: 'feat/free-slot',
      headSha: 'abc1234',
      detachedAt: '2026-09-05T10:04:00.000Z',
    },
    ...overrides,
  };
}

test('durable status lists gate-parked runs with disposition, freed slot, and target', () => {
  const parks = gateParkedRuns([gateParkRecord()]);
  assert.equal(parks.length, 1);
  assert.equal(parks[0].slotDisposition, 'freed');
  assert.equal(parks[0].freedSlotId, 'macwork-ff-1');
  assert.equal(parks[0].restoreTarget.slotId, 'macwork-ff-1');
  // `machine status` reads durable records and probes nothing, so it must not
  // claim the slot is free.
  assert.equal(parks[0].restoreTarget.available, null);

  const line = formatGateParkLine(parks[0]);
  assert.match(line, /run-4/u);
  assert.match(line, /Parked, slot freed for dispatch/u);
  assert.match(line, /freed=macwork-ff-1/u);
  assert.match(line, /restore=macwork-ff-1 \(availability not read\)/u);
  assert.match(line, /branch feat\/free-slot at abc1234/u);
});

test('a refused restore is carried onto the status line', () => {
  const [view] = gateParkedRuns([
    gateParkRecord({
      restoreRefusal: {
        code: 'RESTORE_SLOT_TAKEN',
        reason: 'macwork-ff-1 is now running run-9',
        at: '2026-09-05T11:00:00.000Z',
      },
    }),
  ]);
  assert.match(
    formatGateParkLine(view),
    /refused RESTORE_SLOT_TAKEN: macwork-ff-1 is now running/u,
  );
});

test('retained and settled records are not gate parks', () => {
  assert.deepEqual(gateParkedRuns([gateParkRecord({ slotDisposition: 'retained' })]), []);
  assert.deepEqual(gateParkedRuns([gateParkRecord({ phase: 'restored' })]), []);
  assert.deepEqual(gateParkedRuns([]), []);
});

test('the status formatter adds a gate-park section only when a park holds a freed slot', () => {
  const withPark = formatMachinePauseResult({
    machine: 'macwork',
    pressure,
    records: [gateParkRecord()],
  });
  assert.match(withPark, /Gate parks {2}1 run\(s\), 1 holding a freed slot/u);
  assert.match(withPark, /freed=macwork-ff-1/u);

  const withoutPark = formatMachinePauseResult({
    machine: 'macwork',
    pressure,
    records: [gateParkRecord({ slotDisposition: 'retained' })],
  });
  assert.doesNotMatch(withoutPark, /Gate parks/u);
});

function restorePreviewResult(record: MachineParkRecord, available: boolean) {
  return {
    ok: true as const,
    outcome: 'preview' as const,
    execute: false as const,
    previewId: 'restore-1',
    machine: 'macwork',
    selector: { kind: 'all' as const },
    records: [],
    runs: [
      {
        runId: record.runId,
        generation: 0,
        selected: true,
        eligibility: available
          ? {
              eligible: true as const,
              code: 'ELIGIBLE_FREED_SLOT_RESTORE',
              reason: 'the freed slot is still free',
            }
          : {
              eligible: false as const,
              code: 'RESTORE_SLOT_TAKEN',
              reason: 'macwork-ff-1 is now running run-9',
            },
        restoreTarget: {
          slotId: record.slotId,
          disposition: 'freed' as const,
          available,
        },
        record,
      },
    ],
  };
}

test('a restore preview prints gate parks with the Gateway availability verdict', () => {
  // The surface that HAS a verdict used to print no gate-park line at all,
  // because the section read `records`, which is undefined beside preview runs.
  const preview = restorePreviewResult(gateParkRecord(), true);
  const output = formatMachinePauseResult(preview);
  assert.match(output, /Gate parks {2}1 run\(s\), 1 holding a freed slot/u);
  assert.match(output, /restore=macwork-ff-1 \(available\)/u);
  assert.doesNotMatch(output, /availability not read/u);

  const views = gateParkedPreviewRuns(preview.runs);
  assert.equal(views[0].restoreTarget.available, true);
  assert.equal(views[0].restoreTarget.code, 'ELIGIBLE_FREED_SLOT_RESTORE');
});

test('a taken slot is reported as not available with the Gateway reason', () => {
  const output = formatMachinePauseResult(restorePreviewResult(gateParkRecord(), false));
  assert.match(output, /not available: macwork-ff-1 is now running run-9/u);
});

test('the header counts what is actually holding a freed slot, not what is listed', () => {
  // A park still landing has released nothing; one mid-restore has taken its
  // slot back. Counting either as "holding a freed slot" overstates the gain.
  const landing = gateParkRecord({ phase: 'resources-stopping' });
  delete landing.slotFreedAt;
  const restoring = gateParkRecord({
    runId: 'run-5',
    phase: 'resources-restoring',
    slotReboundAt: '2026-09-05T11:00:00.000Z',
  });
  const views = gateParkedRuns([gateParkRecord(), landing, restoring]);
  assert.equal(views.length, 3, 'all three are live gate parks worth listing');
  assert.equal(gateParksHoldingFreedSlot(views), 1);
  const output = formatMachinePauseResult({
    machine: 'macwork',
    pressure,
    records: [gateParkRecord(), landing, restoring],
  });
  assert.match(output, /Gate parks {2}3 run\(s\), 1 holding a freed slot/u);
});

test('every machine envelope carries the derived gate parks beside the raw payload', () => {
  const status = withGateParks({ machine: 'macwork', records: [gateParkRecord()] });
  assert.equal(status.gateParks.length, 1);
  assert.equal(status.gateParks[0].restoreTarget.available, null, 'status probes nothing');
  assert.equal(status.records.length, 1, 'the raw records survive for existing readers');

  const preview = withGateParks(restorePreviewResult(gateParkRecord(), true));
  assert.equal(preview.gateParks.length, 1);
  assert.equal(preview.gateParks[0].restoreTarget.available, true, 'a preview has a verdict');
  assert.equal(preview.runs.length, 1, 'the raw runs survive for existing readers');
});
