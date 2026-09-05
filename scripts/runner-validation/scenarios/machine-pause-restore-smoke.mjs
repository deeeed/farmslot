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
      pass: false,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: false, skipped: true, report };
  }
  if (!runId) {
    const report = {
      runner,
      skipped: true,
      skipReason:
        'live gateway proof requires FARMSLOT_MACHINE_PAUSE_RUN_ID for a dedicated mode=validation run currently in monitoring or ci-watching',
      pass: false,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
    return { scenario: SCENARIO_ID, runner, outPath, pass: false, skipped: true, report };
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
    retainedLiveProof: null,
    retainedRestoreProof: null,
    restorePreview: null,
    restoreExecute: null,
    restoredRecord: null,
    restoredBinding: null,
    structuredAcceptance: null,
    continuity: null,
    cleanupRestore: null,
    cleanupStatus: null,
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
    // A park does not stop everything it observed running. The project catalog
    // declares, per resource, whether releasing actually stops it; the manifest
    // carries that as `releaseEffect`. A `retain` resource must still be running
    // afterwards and must never have been stopped — the sandbox gateway UI is
    // one, and stopping it would take down the control plane the slot needs.
    // Judging every resource against a single "all stopped" expectation both
    // hides that and fails a correct park.
    const resources = report.parkedRecord.resourceManifest.resources;
    const residualState = (resourceId) =>
      report.parkedRecord.residuals.resources.find((residual) => residual.resourceId === resourceId)
        ?.state ?? null;
    report.resourceStopProof = {
      configured: resources.length,
      resources: resources.map((resource) => ({
        resourceId: resource.resourceId,
        releaseEffect: resource.releaseEffect ?? null,
        phase: resource.phase,
        residual: residualState(resource.resourceId),
        stoppedAt: resource.stoppedAt ?? null,
      })),
      retained: resources
        .filter((resource) => resource.releaseEffect === 'retain')
        .map((resource) => resource.resourceId),
      stopped: resources
        .filter((resource) => resource.releaseEffect !== 'retain')
        .map((resource) => resource.resourceId),
      allAsDeclared: false,
    };
    const undeclared = resources.filter((resource) => !resource.releaseEffect);
    if (undeclared.length > 0) {
      throw new Error(
        `park manifest carries no releaseEffect for ${undeclared
          .map((resource) => resource.resourceId)
          .join(', ')}; the catalog metadata did not reach the manifest`,
      );
    }
    for (const resource of resources) {
      const expectedPhase = resource.releaseEffect === 'retain' ? 'retained' : 'stopped';
      const expectedResidual = resource.releaseEffect === 'retain' ? 'running' : 'stopped';
      if (resource.phase !== expectedPhase) {
        throw new Error(
          `resource '${resource.resourceId}' declared '${resource.releaseEffect}' settled at phase '${resource.phase}', expected '${expectedPhase}'`,
        );
      }
      if (residualState(resource.resourceId) !== expectedResidual) {
        throw new Error(
          `resource '${resource.resourceId}' declared '${resource.releaseEffect}' was observed '${residualState(resource.resourceId)}', expected '${expectedResidual}'`,
        );
      }
      if (resource.releaseEffect === 'retain' && resource.stoppedAt) {
        throw new Error(`retained resource '${resource.resourceId}' carries a stoppedAt timestamp`);
      }
    }
    report.resourceStopProof.allAsDeclared = true;

    // The record says the retained resource was left alone. Ask the node
    // directly, while the run is still parked, whether the process is really
    // up — a record entry is a claim, a live health probe is the evidence.
    if (report.resourceStopProof.retained.length > 0) {
      const live = rpc('resource.health', { slotId: before.slotId });
      report.retainedLiveProof = {
        slotId: before.slotId,
        observed: report.resourceStopProof.retained.map((resourceId) => ({
          resourceId,
          status: live.resources.find((entry) => entry.id === resourceId)?.status ?? null,
        })),
      };
      const dead = report.retainedLiveProof.observed.filter((entry) => entry.status !== 'running');
      if (dead.length > 0) {
        throw new Error(
          `retained resource(s) ${dead.map((entry) => entry.resourceId).join(', ')} are not running on the node while the run is parked`,
        );
      }
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
    // Restore verifies a retained resource rather than booting it. A boot would
    // have had to stop it first, so a retained resource that still carries no
    // stoppedAt after a full park-and-restore cycle is the observable proof
    // that nothing in either direction touched it.
    report.retainedRestoreProof = {
      retained: restoredResources
        .filter((resource) => resource.releaseEffect === 'retain')
        .map((resource) => ({
          resourceId: resource.resourceId,
          phase: resource.phase,
          stoppedAt: resource.stoppedAt ?? null,
          restoredAt: resource.restoredAt ?? null,
        })),
      neverStopped: restoredResources
        .filter((resource) => resource.releaseEffect === 'retain')
        .every((resource) => !resource.stoppedAt && resource.phase === 'restored'),
    };
    if (!report.retainedRestoreProof.neverStopped) {
      throw new Error('a retained resource was stopped or not verified across park and restore');
    }
    report.pass =
      report.structuredAcceptance?.live === true &&
      report.structuredAcceptance?.acknowledgement?.kind === 'structured' &&
      report.continuity.sessionId &&
      report.continuity.contextId &&
      report.continuity.generation &&
      resourcesRestored;
  } catch (error) {
    report.error = error?.message || String(error);
    if (report.machine) {
      try {
        const cleanupStatus = rpc('machine.pause.status', { machine: report.machine });
        const durableRecord = cleanupStatus.records.find((record) => record.runId === runId);
        report.cleanupStatus = durableRecord ?? null;
        if (durableRecord && !['restored', 'cancelled'].includes(durableRecord.phase)) {
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
        }
      } catch (cleanupError) {
        report.cleanupRestore = { error: cleanupError?.message || String(cleanupError) };
      }
    }
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
