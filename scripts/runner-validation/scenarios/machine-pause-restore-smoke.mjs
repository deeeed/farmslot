import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { primaryRoleForFlow } from '@farmslot/protocol';

import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'machine-pause-restore-smoke';

const SUPPORTED_RUNNERS = new Set(['claude', 'codex', 'grok']);

function rpc(method, params = {}, timeoutMs = 120_000) {
  const script = path.resolve('apps/command-center/scripts/cdp.mjs');
  const result = spawnSync('node', [script, 'gateway', method, JSON.stringify(params)], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: timeoutMs + 10_000,
    env: {
      ...process.env,
      FARMSLOT_RPC_TIMEOUT_MS: String(timeoutMs),
    },
  });
  const stdout = result.stdout?.trim() ?? '';
  if (result.status !== 0) {
    throw new Error(
      `Gateway RPC ${method} failed (exit ${result.status}): ${result.stderr?.trim() || stdout || 'gateway unavailable'}`,
    );
  }
  return JSON.parse(stdout);
}

async function poll(description, read, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = read();
    if (accept(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${description}; latest=${JSON.stringify(latest)}`);
}

export function runBinding(run) {
  const primaryRole = primaryRoleForFlow(run.flowType);
  const primary = run.agentContexts?.find((context) => context.role === primaryRole);
  const contextOwnsBinding = Boolean(
    primary && (primary.runnerSessionId != null || primary.runnerSessionPath != null),
  );
  return {
    runnerId: primary?.runner ?? run.metrics?.runner ?? null,
    sessionId: contextOwnsBinding
      ? (primary.runnerSessionId ?? null)
      : (run.metrics?.runnerSessionId ?? null),
    sessionPath: contextOwnsBinding
      ? (primary.runnerSessionPath ?? null)
      : (run.metrics?.runnerSessionPath ?? null),
    contextId: primary?.id ?? null,
    target: primary?.target ?? null,
  };
}

function selectedRun(result, runId) {
  return result.runs.find((candidate) => candidate.runId === runId && candidate.selected);
}

export async function runScenario({ runnerAdapter, timeoutMs, outDir }) {
  const runner = runnerAdapter.RUNNER_ID;
  const runId = process.env.FARMSLOT_MACHINE_PAUSE_RUN_ID?.trim();
  if (!SUPPORTED_RUNNERS.has(runner)) {
    const report = {
      runner,
      skipped: true,
      skipReason: `runner '${runner}' has no validated release-park session reload`,
      pass: true,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }
  if (!runId) {
    const report = {
      runner,
      skipped: true,
      skipReason:
        'live gateway proof requires FARMSLOT_MACHINE_PAUSE_RUN_ID for a dedicated mode=validation run currently in monitoring or ci-watching',
      pass: true,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: true, skipped: true, report };
  }

  const operationId = `runner-validation-machine-pause-${process.pid}-${Date.now()}`;
  const report = {
    runner,
    runId,
    operationId,
    machine: null,
    initialBinding: null,
    pausePreview: null,
    pauseExecute: null,
    parkedRecord: null,
    resourceStopProof: null,
    restorePreview: null,
    restoreExecute: null,
    restoredRecord: null,
    restoredBinding: null,
    structuredAcceptance: null,
    continuity: null,
    cleanupRestore: null,
    pass: false,
    error: null,
  };

  try {
    const before = rpc('run.get', { runId }).run;
    if (before.mode !== 'validation') {
      throw new Error(`Refusing non-validation run ${runId} (mode=${before.mode ?? 'unset'})`);
    }
    if (before.status !== 'monitoring' && before.status !== 'ci-watching') {
      throw new Error(`Run ${runId} is ${before.status}; expected monitoring or ci-watching`);
    }
    report.initialBinding = runBinding(before);
    if (report.initialBinding.runnerId !== runner) {
      throw new Error(
        `Run ${runId} uses runner '${report.initialBinding.runnerId}', not requested '${runner}'`,
      );
    }
    if (
      !report.initialBinding.sessionId ||
      !report.initialBinding.sessionPath ||
      !report.initialBinding.contextId ||
      !report.initialBinding.target
    ) {
      throw new Error(`Run ${runId} has no exact persisted runner binding`);
    }

    const fleetStatus = rpc('fleet.status');
    const slot = fleetStatus.fleet.slots.find((candidate) => candidate.slot === before.slotId);
    if (!slot?.machine)
      throw new Error(`Run ${runId} slot '${before.slotId}' is absent from fleet`);
    report.machine = slot.machine;
    const selector = { kind: 'include', runIds: [runId] };

    report.pausePreview = rpc('machine.pause.preview', {
      machine: report.machine,
      mode: 'release',
      selector,
    });
    const pauseTarget = selectedRun(report.pausePreview, runId);
    if (!pauseTarget?.eligibility.eligible) {
      throw new Error(
        `Release preview rejected ${runId}: ${pauseTarget?.eligibility.reason ?? 'missing selected target'}`,
      );
    }
    report.pauseExecute = rpc('machine.pause.execute', {
      machine: report.machine,
      mode: 'release',
      previewId: report.pausePreview.previewId,
      reviewedTargets: [{ runId, generation: pauseTarget.generation }],
      operationId,
    });
    if (!report.pauseExecute.ok) {
      throw new Error(`Release park failed: ${report.pauseExecute.outcome}`);
    }
    const parkedStatus = await poll(
      'durable release park',
      () => rpc('machine.pause.status', { machine: report.machine }),
      (status) =>
        status.records.some((record) => record.runId === runId && record.phase === 'parked'),
      timeoutMs,
    );
    report.parkedRecord = parkedStatus.records.find((record) => record.runId === runId);
    if (report.parkedRecord.recoveryHandle?.sessionId !== report.initialBinding.sessionId) {
      throw new Error('Park record did not preserve the initial exact runner session id');
    }
    if (report.parkedRecord.residuals.runner !== 'stopped') {
      throw new Error(`Parked runner residual is ${report.parkedRecord.residuals.runner}`);
    }
    const resources = report.parkedRecord.resourceManifest.resources;
    report.resourceStopProof = {
      configured: resources.length,
      allStopped:
        resources.every((resource) => resource.phase === 'stopped') &&
        report.parkedRecord.residuals.resources.every((resource) => resource.state === 'stopped'),
    };
    if (!report.resourceStopProof.allStopped) {
      throw new Error('One or more manifest resources remained after release park');
    }

    report.restorePreview = rpc('machine.pause.restore', {
      machine: report.machine,
      selector,
    });
    const restoreTarget = selectedRun(report.restorePreview, runId);
    if (!restoreTarget?.eligibility.eligible) {
      throw new Error(
        `Restore preview rejected ${runId}: ${restoreTarget?.eligibility.reason ?? 'missing selected target'}`,
      );
    }
    report.restoreExecute = rpc('machine.pause.restore', {
      machine: report.machine,
      selector,
      execute: true,
      previewId: report.restorePreview.previewId,
      reviewedTargets: [{ runId, generation: restoreTarget.generation }],
      operationId: `${operationId}-restore`,
    });
    if (!report.restoreExecute.ok) {
      throw new Error(`Restore failed: ${report.restoreExecute.outcome}`);
    }
    const restoredStatus = await poll(
      'structured runner restore',
      () => rpc('machine.pause.status', { machine: report.machine }),
      (status) =>
        status.records.some(
          (record) =>
            record.runId === runId && record.phase === 'restored' && record.recoveryProof?.live,
        ),
      timeoutMs,
    );
    report.restoredRecord = restoredStatus.records.find((record) => record.runId === runId);
    report.structuredAcceptance = report.restoredRecord.recoveryProof;
    const after = rpc('run.get', { runId }).run;
    report.restoredBinding = runBinding(after);
    report.continuity = {
      sessionId:
        report.initialBinding.sessionId === report.restoredRecord.recoveryHandle?.sessionId &&
        report.initialBinding.sessionId === report.structuredAcceptance?.sessionId &&
        report.initialBinding.sessionId === report.restoredBinding.sessionId,
      contextId: report.initialBinding.contextId === report.restoredBinding.contextId,
      generation:
        typeof report.restoredRecord.restoredGeneration === 'number' &&
        report.restoredRecord.restoredGeneration > report.restoredRecord.generation,
    };
    const restoredResources = report.restoredRecord.resourceManifest.resources;
    const resourcesRestored = restoredResources.every((resource) => resource.phase === 'restored');
    report.pass =
      report.structuredAcceptance?.live === true &&
      report.structuredAcceptance?.acknowledgement?.kind === 'structured' &&
      report.continuity.sessionId &&
      report.continuity.contextId &&
      report.continuity.generation &&
      resourcesRestored;
  } catch (error) {
    report.error = error?.message || String(error);
    if (report.machine && report.parkedRecord && report.restoredRecord?.phase !== 'restored') {
      try {
        const selector = { kind: 'include', runIds: [runId] };
        const preview = rpc('machine.pause.restore', { machine: report.machine, selector });
        const target = selectedRun(preview, runId);
        if (target?.eligibility.eligible) {
          report.cleanupRestore = rpc('machine.pause.restore', {
            machine: report.machine,
            selector,
            execute: true,
            previewId: preview.previewId,
            reviewedTargets: [{ runId, generation: target.generation }],
            operationId: `${operationId}-cleanup-restore`,
          });
        } else {
          report.cleanupRestore = { skipped: true, reason: target?.eligibility.reason };
        }
      } catch (cleanupError) {
        report.cleanupRestore = { error: cleanupError?.message || String(cleanupError) };
      }
    }
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
