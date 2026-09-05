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
  formatMachinePauseResult,
  isPartialMachineResult,
  machineRunSelector,
  pauseNextCommand,
  registerMachineCommand,
  rejectedTargetsFromPreview,
  resolveReviewedPreviewId,
  restoreNextCommand,
  reviewedTargetsFromPreview,
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
