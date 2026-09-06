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
    const detail = result.stderr?.trim() || stdout || 'gateway unavailable';
    const error = new Error(`Gateway RPC ${method} failed (exit ${result.status}): ${detail}`);
    // The gateway's own typed refusal, parsed out and attached, so a caller can
    // branch on WHICH refusal it got instead of on the text of a message. A
    // caller with only a string to match cannot tell a refusal it means to wait
    // through from a transport failure it must not swallow.
    Object.assign(error, gatewayRefusal(detail));
    throw error;
  }
  return JSON.parse(stdout);
}

/**
 * The typed `{code, message}` a gateway refusal carries, or nothing.
 *
 * `cdp.mjs` prints `cdp.mjs: <envelope>` for a refusal and something else
 * entirely for a transport failure, so a payload that does not parse into an
 * error envelope is exactly the case a caller must NOT treat as a refusal.
 */
function gatewayRefusal(detail) {
  const start = detail.indexOf('{');
  if (start === -1) return {};
  try {
    const envelope = JSON.parse(detail.slice(start));
    const error = envelope?.error;
    if (!error || typeof error.code !== 'string') return {};
    return { gatewayCode: error.code, gatewayMessage: error.message ?? '' };
  } catch {
    // Not an envelope. Deliberately no classification rather than a guess: the
    // caller then rethrows, which is the right outcome for a payload nobody
    // recognizes.
    return {};
  }
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
  const gateParkRunId = process.env.FARMSLOT_GATE_PARK_RESTORE_RUN_ID?.trim();
  if (gateParkRunId) {
    return runGateParkRestoreScenario({ runner, runId: gateParkRunId, timeoutMs, outDir });
  }
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
    gatewaySource: gatewaySourceRevision(),
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
    // A missing `stoppedAt` proves nothing, and neither does an absence of boot
    // ERRORS: a boot that succeeds leaves no error behind. The Gateway now
    // records what the restore actually did to each resource, emitted by the
    // code paths that did it, so this asserts those effects directly.
    //
    // Every retained resource must carry exactly one `verified` effect and no
    // `booted` effect. Every resource the park stopped must carry a `booted`
    // effect, because restore is what brings those back.
    //
    // What this still does NOT prove: that nothing stopped and restarted a
    // resource strictly between the Gateway's own observations. Framework-level
    // RPC exposes no per-resource process identity to close that window.
    const parkedRetained = [...report.resourceStopProof.retained].sort();
    const parkedStopped = [...report.resourceStopProof.stopped].sort();
    const restoredRetained = restoredResources
      .filter((resource) => resource.releaseEffect === 'retain')
      .map((resource) => resource.resourceId)
      .sort();
    const liveAfter = rpc('resource.health', { slotId: before.slotId });
    const effects = report.restoredRecord.restoreEffects ?? null;
    const effectsFor = (resourceId) =>
      (effects ?? []).filter((effect) => effect.resourceId === resourceId);
    report.retainedRestoreProof = {
      expected: parkedRetained,
      observed: restoredRetained,
      resources: restoredResources
        .filter((resource) => resource.releaseEffect === 'retain')
        .map((resource) => ({
          resourceId: resource.resourceId,
          phase: resource.phase,
          stoppedAt: resource.stoppedAt ?? null,
          restoredAt: resource.restoredAt ?? null,
        })),
      restoreEffects: effects,
      observedRunningAfterRestore: parkedRetained.map((resourceId) => ({
        resourceId,
        status: liveAfter.resources.find((entry) => entry.id === resourceId)?.status ?? null,
      })),
      provesNoRestartBetweenGatewayObservations: false,
    };
    if (parkedRetained.length === 0) {
      throw new Error(
        'no retained resource was in the manifest; this run proves nothing about retention — boot the slot dev-server first',
      );
    }
    if (JSON.stringify(parkedRetained) !== JSON.stringify(restoredRetained)) {
      throw new Error(
        `retained set changed across restore: parked ${parkedRetained.join(', ')} vs restored ${restoredRetained.join(', ')}`,
      );
    }
    if (!effects) {
      throw new Error(
        'the park record carries no restoreEffects; this Gateway does not record what its restore did, so the claim cannot be checked',
      );
    }
    for (const resourceId of parkedRetained) {
      const own = effectsFor(resourceId);
      const verified = own.filter((effect) => effect.action === 'verified');
      const booted = own.filter((effect) => effect.action === 'booted');
      if (booted.length > 0) {
        throw new Error(
          `restore booted retained resource '${resourceId}': ${booted.map((effect) => effect.reason ?? 'no reason given').join('; ')}`,
        );
      }
      if (verified.length !== 1 || !verified[0].ok) {
        throw new Error(
          `retained resource '${resourceId}' has ${verified.length} verified effect(s) (${own.map((effect) => `${effect.action}:${effect.ok}`).join(', ') || 'none'}); expected exactly one that passed`,
        );
      }
    }
    // An empty stopped set is a fact about this run, not a pass. Say so, so a
    // reader can tell "restore booted everything it stopped" from "there was
    // nothing to boot" instead of reading a loop that never ran as proof.
    report.retainedRestoreProof.stoppedResourcesExercised = parkedStopped.length > 0;
    if (parkedStopped.length === 0) {
      report.retainedRestoreProof.stoppedResourcesNote =
        'this run parked no resource with release_effect stop, so the boot-on-restore claim was not exercised live here';
    }
    // A `verified` effect is written by the retained check itself, not by the
    // reporting path that attributes a performed hook to the initiating
    // restore. If no hook ran, this run says nothing about that attribution.
    const performedEffects = (effects ?? []).filter((effect) => effect.action !== 'verified');
    report.retainedRestoreProof.attributionPathExercised = performedEffects.length > 0;
    if (performedEffects.length === 0) {
      report.retainedRestoreProof.attributionPathNote =
        'no boot, shutdown, or relaunch hook ran during this restore, so the effect-attribution path was not exercised live here; it is covered by the gateway unit suite';
    }
    for (const resourceId of parkedStopped) {
      const booted = effectsFor(resourceId).filter((effect) => effect.action === 'booted');
      const failedBoots = booted.filter((effect) => !effect.ok);
      if (booted.length === 0) {
        throw new Error(
          `resource '${resourceId}' was stopped by the park but restore recorded no boot`,
        );
      }
      if (failedBoots.length > 0) {
        throw new Error(
          `resource '${resourceId}' recorded ${failedBoots.length} failed boot(s) of ${booted.length}: ${failedBoots
            .map((effect) => effect.reason ?? 'no reason given')
            .join('; ')}`,
        );
      }
    }
    for (const resource of report.retainedRestoreProof.resources) {
      if (resource.phase !== 'restored' || resource.stoppedAt) {
        throw new Error(
          `retained resource '${resource.resourceId}' settled at phase '${resource.phase}' with stoppedAt ${resource.stoppedAt}`,
        );
      }
    }
    const notRunningAfter = report.retainedRestoreProof.observedRunningAfterRestore.filter(
      (entry) => entry.status !== 'running',
    );
    if (notRunningAfter.length > 0) {
      throw new Error(
        `retained resource(s) ${notRunningAfter.map((entry) => entry.resourceId).join(', ')} are not running after restore`,
      );
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

// ─── ADR-054 `free-slot`: restoring a freed slot (MANUAL-000112 slice 2) ─────
//
// A different shape from the park/restore cycle above, and it needs its own
// node: the run is ALREADY parked with its slot handed to dispatch, and what is
// being proved is the way back. That state cannot be produced by a scripted
// run — it needs a real publication package held at a gate — so the parked run
// is supplied through FARMSLOT_GATE_PARK_RESTORE_RUN_ID rather than created.
//
// What each node proves, and how to make it fail:
//
//   parked             The supplied run really is a landed gate park with its
//                      gate unanswered and its slot free. Answer the gate, or
//                      restore the run first, and this node fails.
//   fencedWhileParked  `runtime.posture.apply` still refuses a freed park with
//                      FREED_SLOT_RESTORE_REQUIRED. Drop the fence in
//                      methods/runtime-posture.ts and it fails.
//   previewEligible    The freed slot is restorable into ITSELF, and the
//                      Gateway says where. Restore the freed-slot rejection in
//                      buildRestorePreview and it fails.
//   slotTaken          With a successor holding the slot, answering the gate is
//                      refused with RESTORE_SLOT_TAKEN and nothing the operator
//                      has to undo moves: the decision stays pending, the park
//                      record stays parked and freed, the slot row keeps its
//                      successor, and the worktree stays detached. The record
//                      DOES gain a `restoreRefusal` — that is the refusal being
//                      made durable, and the assertions require it. Remove the
//                      availability check in buildRestorePreview and it fails
//                      (the restore proceeds and mutates the record).
//   restored           The slot is re-bound, the branch is back on its ref at
//                      the recorded tip, the retained resource is verified
//                      rather than rebooted, and the worker is back through the
//                      persisted session with a structured acknowledgement on a
//                      RE-HOSTED pane. Skip reclaimFreedSlot, or make the
//                      re-host reuse the dead pane, and it fails.
//   answerable         The gate is answerable again and STILL PENDING: the
//                      fence has lifted without the proof consuming the
//                      operator's decision, and the restored gate no longer
//                      inherits the `free-slot` choice that parked the run.
//                      Drop the suppression in the resume transition's hold
//                      branch and it fails.
//
// Each node's break-and-observe run is recorded, verbatim, in
// `gate-park-restore-negative-proofs.json` beside this scenario's evidence.
const GATE_PARK_SCENARIO_ID = 'gate-park-restore-smoke';

/**
 * The gateway source this evidence was produced against.
 *
 * Recorded because this PR twice needed a human to reason about whether an
 * artifact came from the code under review. A SHA plus a dirty flag makes that
 * check mechanical: `dirty` means the tree carried uncommitted changes, so the
 * SHA alone does not reproduce it.
 */
function gatewaySourceRevision() {
  const read = (args) => {
    const result = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const scope = ['services/gateway', 'packages/protocol'];
  const sha = read(['rev-parse', 'HEAD']);
  const status = read(['status', '--porcelain', '--', ...scope]);
  return {
    sha,
    // What `dirty` measured, stated rather than assumed. It covers the code
    // under test, not this harness: a change to the scenario alters what is
    // asserted, not what the Gateway does, and conflating the two would make
    // every harness tweak look like the artifact came from unreviewed gateway
    // code.
    scope,
    dirty: status === null ? null : status.length > 0,
    describedAt: new Date().toISOString(),
  };
}

function fleetSlot(slotId) {
  const status = rpc('fleet.status', {});
  const slot = (status.fleet?.slots ?? []).find((candidate) => candidate.slot === slotId);
  if (!slot) throw new Error(`slot ${slotId} is absent from fleet.status`);
  return slot;
}

/** The slot-row facts a restore must move, read as one snapshot. */
function slotBinding(slotId) {
  const slot = fleetSlot(slotId);
  return {
    slot: slot.slot,
    currentRunId: slot.currentRunId ?? null,
    lifecycle: slot.lifecycle ?? null,
    phase: slot.phase ?? null,
    agent: slot.agent ?? null,
  };
}

/**
 * The slot working tree's git identity, read directly because the fleet row's
 * branch/headSha are a refresh snapshot and a restore has to be judged against
 * the tree itself. Local slots only; a remote slot skips rather than guessing.
 */
function workspaceIdentity(slot) {
  if (slot.health?.ssh !== 'LOCAL' || !slot.repo) {
    return { skipped: true, reason: `slot ${slot.slot} is not a local checkout` };
  }
  const git = (args) => {
    const result = spawnSync('git', ['-C', slot.repo, ...args], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  return {
    repo: slot.repo,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    headSha: git(['rev-parse', 'HEAD']),
    dirty: (git(['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length,
  };
}

function pendingGateDecision(run) {
  return (
    run.decisions?.find(
      (decision) => decision.type === 'engine_human_gate' && !decision.resolvedAt,
    ) ?? null
  );
}

function resolveDecisionAttempt(runId, decisionId, actionId, timeoutMs = 300_000) {
  const script = path.resolve('apps/command-center/scripts/cdp.mjs');
  const result = spawnSync(
    'node',
    [script, 'gateway', 'run.resolveDecision', JSON.stringify({ runId, decisionId, actionId })],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: timeoutMs + 10_000,
      // Answering a freed park RESTORES first — a slot claim, a checkout, a
      // resource boot, and a runner relaunch. The client's default 5s budget
      // gives up long before that lands and reports a timeout for a call that
      // is still working.
      env: { ...process.env, FARMSLOT_RPC_TIMEOUT_MS: String(timeoutMs) },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

/**
 * `farmslot machine status <machine> --json`, run as a real process, must list
 * the gate-parked run.
 *
 * The envelope's `records` already carried the raw park; what this proves is
 * the DERIVED `gateParks` entry an operator (or a script) reads instead of
 * re-implementing the reading — the slot disposition, the freed slot, the
 * preserved branch, the restore target, and the restore the gate answer owes.
 *
 * Availability is deliberately expected to be `null`. `machine status` reads
 * durable records and probes no slot, so claiming the target were free would be
 * a claim nothing checked; `machine restore` is the command that asks.
 */
function proveCliMachineStatus({ machine, runId, record }) {
  const proof = { attempted: true, pass: false, machine, runId, error: null };
  const result = spawnSync('yarn', ['farmslot', 'machine', 'status', machine, '--json'], {
    cwd: path.resolve('apps/command-center'),
    encoding: 'utf8',
    timeout: 120_000,
  });
  proof.exit = result.status;
  try {
    if (result.status !== 0) {
      throw new Error(
        `machine status exited ${result.status}: ${`${result.stdout ?? ''}${result.stderr ?? ''}`.slice(0, 400)}`,
      );
    }
    const envelope = JSON.parse(result.stdout);
    proof.envelopeStatus = envelope.status;
    proof.envelopeCommand = envelope.command;
    const parks = envelope.data?.gateParks ?? null;
    if (!Array.isArray(parks)) {
      throw new Error('the status envelope carried no gateParks list');
    }
    proof.gateParkRunIds = parks.map((park) => park.runId);
    const entry = parks.find((park) => park.runId === runId);
    proof.entry = entry ?? null;
    if (!entry) throw new Error(`gateParks did not list the parked run ${runId}`);
    if (entry.slotDisposition !== 'freed') {
      throw new Error(`gateParks reported slotDisposition '${entry.slotDisposition}'`);
    }
    if (entry.slotState !== 'freed') {
      throw new Error(`gateParks reported slot state '${entry.slotState}'`);
    }
    if (entry.freedSlotId !== record.slotId) {
      throw new Error(
        `gateParks named freed slot '${entry.freedSlotId}' for a park on '${record.slotId}'`,
      );
    }
    if (entry.restoreTarget?.slotId !== record.slotId) {
      throw new Error(`gateParks named restore target '${entry.restoreTarget?.slotId}'`);
    }
    if (entry.restoreTarget?.available !== null) {
      throw new Error(
        `machine status claimed restore availability '${entry.restoreTarget?.available}' without probing the slot`,
      );
    }
    if (entry.restoreBeforeGateAnswer !== true) {
      throw new Error('gateParks did not report that answering the gate restores the run first');
    }
    const branch = record.preservedWorkspace?.branch ?? null;
    if (branch && entry.preservedWorkspace?.branch !== branch) {
      throw new Error(
        `gateParks reported preserved branch '${entry.preservedWorkspace?.branch}', expected '${branch}'`,
      );
    }
    proof.pass = true;
  } catch (error) {
    proof.error = error?.message || String(error);
  }
  return proof;
}

async function runGateParkRestoreScenario({ runner, runId, timeoutMs, outDir }) {
  const operationId = `gate-park-restore-${process.pid}-${Date.now()}`;
  const report = {
    runner,
    runId,
    operationId,
    gatewaySource: gatewaySourceRevision(),
    machine: null,
    slotId: null,
    parkedByChoice: null,
    parked: null,
    cliStatus: null,
    fencedWhileParked: null,
    previewEligible: null,
    slotTaken: null,
    restored: null,
    consumed: null,
    answerable: null,
    pass: false,
    error: null,
  };
  // The successor is created here rather than supplied: a scripted run CAN take
  // a freed slot, and proving RESTORE_SLOT_TAKEN against a slot this scenario
  // handed away itself is what makes the refusal reproducible.
  const takeSlot = process.env.FARMSLOT_GATE_PARK_TAKE_SLOT !== '0';
  let successorRunId = process.env.FARMSLOT_GATE_PARK_SUCCESSOR_RUN_ID?.trim() || null;
  try {
    // ─── parked ───────────────────────────────────────────────────────────
    // Re-runnable on purpose: a supplied run that is merely gate-held is parked
    // here through the operator's own `free-slot` choice, so this node proves
    // the park and the restore as one cycle rather than depending on a state
    // some earlier session left behind.
    let before = rpc('run.get', { runId }).run;
    if (!before.park || !before.park.slotFreedAt) {
      report.parkedByChoice = parkGateHeldRun(runId, timeoutMs);
      before = rpc('run.get', { runId }).run;
    }
    const record = before.park;
    if (!record) throw new Error(`run ${runId} carries no park record`);
    if (record.mode !== 'release' || record.slotDisposition !== 'freed') {
      throw new Error(
        `run ${runId} is not a freed gate park (mode=${record.mode}, slotDisposition=${record.slotDisposition})`,
      );
    }
    if (!record.slotFreedAt) throw new Error('the park never released the slot');
    if (record.phase !== 'parked') throw new Error(`park record is '${record.phase}', not parked`);
    const decision = pendingGateDecision(before);
    if (!decision) throw new Error('the parked run has no pending publication gate decision');
    report.machine = record.machine;
    report.slotId = record.slotId;
    const parkedSlot = slotBinding(record.slotId);
    const parkedWorkspace = workspaceIdentity(fleetSlot(record.slotId));
    report.parked = {
      status: before.status,
      phase: record.phase,
      slotFreedAt: record.slotFreedAt,
      generation: before.engineState?.generation ?? 0,
      decisionId: decision.id,
      preservedWorkspace: record.preservedWorkspace,
      recordedPaneId: record.recoveryHandle?.target?.paneId ?? null,
      sessionId: record.recoveryHandle?.sessionId ?? null,
      slot: parkedSlot,
      workspace: parkedWorkspace,
    };
    if (parkedSlot.currentRunId) {
      throw new Error(`freed slot ${record.slotId} is held by ${parkedSlot.currentRunId}`);
    }

    // ─── cliStatus ────────────────────────────────────────────────────────
    // The operator surface for "what is parked on this machine right now".
    // Asserted against the real CLI process against the real gateway, not
    // against the RPC it wraps: the claim is that `machine status --json`
    // LISTS the gate-parked run with what an operator needs to act on it, and
    // only running the command proves the envelope carries that.
    report.cliStatus = proveCliMachineStatus({ machine: record.machine, runId, record });
    if (!report.cliStatus.pass) {
      throw new Error(`machine status did not list the gate park: ${report.cliStatus.error}`);
    }

    // ─── fencedWhileParked ────────────────────────────────────────────────
    // Read through the public RPC, because that is where an operator meets it.
    const postureAttempt = spawnSync(
      'node',
      [
        path.resolve('apps/command-center/scripts/cdp.mjs'),
        'gateway',
        'runtime.posture.apply',
        JSON.stringify({ runId, posture: 'active' }),
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 },
    );
    const fencedOutput = `${postureAttempt.stdout ?? ''}${postureAttempt.stderr ?? ''}`;
    report.fencedWhileParked = {
      exit: postureAttempt.status,
      matched: fencedOutput.includes('FREED_SLOT_RESTORE_REQUIRED'),
    };
    if (!report.fencedWhileParked.matched) {
      throw new Error(
        `runtime.posture.apply on a freed park did not report FREED_SLOT_RESTORE_REQUIRED: ${fencedOutput.slice(0, 400)}`,
      );
    }

    // ─── previewEligible ──────────────────────────────────────────────────
    const selector = { kind: 'include', runIds: [runId] };
    const preview = rpc('machine.pause.restore', { machine: record.machine, selector });
    const entry = selectedRun(preview, runId);
    report.previewEligible = {
      previewId: preview.previewId,
      eligibility: entry?.eligibility ?? null,
      restoreTarget: entry?.restoreTarget ?? null,
    };
    if (!entry?.eligibility.eligible) {
      throw new Error(
        `freed-slot restore preview refused: ${entry?.eligibility.code} — ${entry?.eligibility.reason}`,
      );
    }
    if (entry.eligibility.code !== 'ELIGIBLE_FREED_SLOT_RESTORE') {
      throw new Error(`restore preview took code '${entry.eligibility.code}'`);
    }
    if (entry.restoreTarget?.slotId !== record.slotId || entry.restoreTarget.available !== true) {
      throw new Error(`restore target is ${JSON.stringify(entry.restoreTarget)}`);
    }

    // ─── slotTaken ────────────────────────────────────────────────────────
    // Only when a successor really holds the slot. Asserted through the
    // OPERATOR's path — answering the gate — because that is what has to refuse
    // without consuming the decision.
    // The successor needs a ticket `run.create` accepts for this project. The
    // parked run's own ref is usually NOT one: a manual backlog item may only be
    // dispatched from Backlog. Supplied rather than invented, because a ticket
    // pattern is project policy and this harness is project-agnostic.
    const successorTicket = process.env.FARMSLOT_GATE_PARK_SUCCESSOR_TICKET?.trim() || null;
    if (takeSlot && !successorRunId && !successorTicket) {
      report.slotTaken = {
        skipped: true,
        reason:
          'RESTORE_SLOT_TAKEN needs a run holding the freed slot; set FARMSLOT_GATE_PARK_SUCCESSOR_TICKET to a ticket ref run.create accepts for this project, or FARMSLOT_GATE_PARK_SUCCESSOR_RUN_ID to a run already on it',
      };
    }
    if (takeSlot && !successorRunId && successorTicket) {
      successorRunId = await dispatchSlotSuccessor({
        project: before.project,
        ticketOrPr: successorTicket,
        slotId: record.slotId,
        timeoutMs,
      });
    }
    if (successorRunId) {
      const successorSlot = slotBinding(record.slotId);
      if (successorSlot.currentRunId !== successorRunId) {
        throw new Error(
          `successor ${successorRunId} does not hold ${record.slotId} (owner=${successorSlot.currentRunId})`,
        );
      }
      // Snapshotted immediately either side of the READ, so "no mutation" is a
      // measurement of the preview itself rather than of the window around it.
      // The successor's OWN row phase is excluded: it is a live run walking its
      // pipeline, and comparing that would fail on its progress rather than on
      // anything the preview did.
      const previewSnapshot = () => ({
        record: rpc('run.get', { runId }).run.park,
        slotOwner: slotBinding(record.slotId).currentRunId,
        workspace: workspaceIdentity(fleetSlot(record.slotId)),
      });
      const beforePreview = previewSnapshot();
      const takenPreview = rpc('machine.pause.restore', { machine: record.machine, selector });
      const afterPreview = previewSnapshot();
      if (JSON.stringify(beforePreview) !== JSON.stringify(afterPreview)) {
        throw new Error(
          `the slot-taken restore preview changed the record, the slot owner, or the tree: ${JSON.stringify(beforePreview)} -> ${JSON.stringify(afterPreview)}`,
        );
      }
      const takenEntry = selectedRun(takenPreview, runId);
      // The read-only verdict is checked BEFORE the resolve is attempted. If the
      // Gateway thinks a taken slot is restorable, answering the gate would try
      // the restore for real — and this node exists to prove it does not.
      if (takenEntry?.eligibility.code !== 'RESTORE_SLOT_TAKEN') {
        report.slotTaken = {
          successorRunId,
          previewCode: takenEntry?.eligibility.code ?? null,
          previewAvailable: takenEntry?.restoreTarget?.available ?? null,
        };
        throw new Error(`a taken slot previewed as '${takenEntry?.eligibility.code}'`);
      }
      if (takenEntry.restoreTarget?.available !== false) {
        throw new Error('a taken slot still reported its restore target available');
      }
      const attempt = resolveDecisionAttempt(runId, decision.id, decision.actions[0].id, timeoutMs);
      const attemptOutput = `${attempt.stdout}${attempt.stderr}`;
      const after = rpc('run.get', { runId }).run;
      report.slotTaken = {
        successorRunId,
        previewCode: takenEntry?.eligibility.code ?? null,
        previewAvailable: takenEntry?.restoreTarget?.available ?? null,
        previewMutatedNothing: true,
        resolveExit: attempt.status,
        resolveMatched: attemptOutput.includes('RESTORE_SLOT_TAKEN'),
        decisionStillPending: pendingGateDecision(after)?.id === decision.id,
        recordAfter: {
          phase: after.park?.phase ?? null,
          slotFreedAt: after.park?.slotFreedAt ?? null,
          slotReboundAt: after.park?.slotReboundAt ?? null,
          restoreRefusal: after.park?.restoreRefusal ?? null,
        },
        slotAfter: slotBinding(record.slotId),
        workspaceAfter: workspaceIdentity(fleetSlot(record.slotId)),
      };
      if (attempt.status === 0 || !report.slotTaken.resolveMatched) {
        throw new Error(
          `answering the gate over a taken slot did not refuse with RESTORE_SLOT_TAKEN: exit=${attempt.status} ${attemptOutput.slice(0, 400)}`,
        );
      }
      if (!report.slotTaken.decisionStillPending) {
        throw new Error('a refused restore consumed the operator decision');
      }
      if (
        report.slotTaken.recordAfter.phase !== 'parked' ||
        !report.slotTaken.recordAfter.slotFreedAt ||
        report.slotTaken.recordAfter.slotReboundAt
      ) {
        throw new Error(
          `a refused restore moved the park record: ${JSON.stringify(report.slotTaken.recordAfter)}`,
        );
      }
      if (report.slotTaken.recordAfter.restoreRefusal?.code !== 'RESTORE_SLOT_TAKEN') {
        throw new Error('the refusal reason was not persisted on the record');
      }
      // The successor's OWN phase moves while these assertions run — it is a
      // live run walking its pipeline — so comparing the whole row would fail
      // on the successor's progress rather than on anything the refusal did.
      // What the refusal must not have done is take the slot back or touch the
      // tree, and that is what is compared.
      if (report.slotTaken.slotAfter.currentRunId !== successorSlot.currentRunId) {
        throw new Error(
          `a refused restore moved slot ownership from '${successorSlot.currentRunId}' to '${report.slotTaken.slotAfter.currentRunId}'`,
        );
      }
      if (JSON.stringify(report.slotTaken.workspaceAfter) !== JSON.stringify(parkedWorkspace)) {
        throw new Error('a refused restore changed the working tree');
      }
      // Hand the slot back before the restore half.
      rpc('run.cancel', { runId: successorRunId, reason: 'gate-park restore live proof' });
      // Both facts, not just the owner: a row whose owner cleared but whose
      // lifecycle has not settled back to `ready` is still mid-teardown, and a
      // restore into it is refused. Waiting on ownership alone raced the
      // successor's own release.
      await poll(
        `${record.slotId} to be released by ${successorRunId}`,
        () => slotBinding(record.slotId),
        (slot) => slot.currentRunId === null && slot.lifecycle === 'ready',
        timeoutMs,
      );
    }

    // ─── restored ─────────────────────────────────────────────────────────
    // Waits on the Gateway's own verdict rather than on a proxy for it. The
    // successor's slot row clears before its worker process does, and the
    // re-host correctly refuses a pane another runner is still alive in — so
    // "the row is free" is not the condition a restore needs.
    const waitedThrough = [];
    const freshPreview = await poll(
      `${record.slotId} to accept a restore of ${runId}`,
      () => {
        // ONE refusal is a state to wait through: the gateway rejects the whole
        // call while the successor's teardown leaves the slot `busy`, and the
        // poll's own deadline is what turns a lasting refusal into a failure.
        // Everything else — a transport failure, malformed output, an
        // unexpected gateway error — is rethrown. A bare catch here would wait
        // out the full deadline and then report a timeout for a gateway that
        // was never reachable.
        try {
          return rpc('machine.pause.restore', { machine: record.machine, selector });
        } catch (error) {
          if (!isSlotNotReadyRefusal(error)) throw error;
          waitedThrough.push({ at: new Date().toISOString(), reason: error.gatewayMessage });
          return null;
        }
      },
      (preview) => preview !== null && selectedRun(preview, runId)?.eligibility.eligible === true,
      timeoutMs,
    );
    report.restoreWaitedThrough = waitedThrough;
    const freshEntry = selectedRun(freshPreview, runId);
    if (!freshEntry?.eligibility.eligible) {
      throw new Error(
        `restore preview refused before execute: ${freshEntry?.eligibility.code} — ${freshEntry?.eligibility.reason}`,
      );
    }
    const executed = rpc(
      'machine.pause.restore',
      {
        machine: record.machine,
        selector,
        execute: true,
        previewId: freshPreview.previewId,
        reviewedTargets: [{ runId, generation: freshEntry.generation }],
        operationId,
      },
      timeoutMs,
    );
    const restoredRun = rpc('run.get', { runId }).run;
    const restoredRecord = restoredRun.park;
    const restoredContext = restoredRun.agentContexts?.find(
      (context) => context.id === record.recoveryHandle.contextId,
    );
    report.restored = {
      outcome: executed.outcome,
      ok: executed.ok,
      phase: restoredRecord?.phase ?? null,
      slotFreedAt: restoredRecord?.slotFreedAt ?? null,
      slotReboundAt: restoredRecord?.slotReboundAt ?? null,
      restoreRefusal: restoredRecord?.restoreRefusal ?? null,
      errors: restoredRecord?.errors ?? [],
      slot: slotBinding(record.slotId),
      workspace: workspaceIdentity(fleetSlot(record.slotId)),
      recoveryProof: restoredRecord?.recoveryProof ?? null,
      restoreEffects: restoredRecord?.restoreEffects ?? [],
      paneBefore: record.recoveryHandle.target.paneId,
      paneAfter: restoredRecord?.recoveryHandle?.target?.paneId ?? null,
      contextPaneAfter: restoredContext?.target?.paneId ?? null,
      generation: restoredRun.engineState?.generation ?? 0,
      status: restoredRun.status,
    };
    if (!executed.ok || restoredRecord?.phase !== 'restored') {
      throw new Error(
        `restore did not complete: outcome=${executed.outcome} phase=${restoredRecord?.phase} errors=${JSON.stringify(restoredRecord?.errors ?? [])}`,
      );
    }
    if (report.restored.slotFreedAt || !report.restored.slotReboundAt) {
      throw new Error('the record still advertises a freed slot after a completed restore');
    }
    if (report.restored.slot.currentRunId !== runId) {
      throw new Error(
        `slot ${record.slotId} is owned by ${report.restored.slot.currentRunId}, not the restored run`,
      );
    }
    if (!report.restored.workspace.skipped) {
      if (report.restored.workspace.branch !== record.preservedWorkspace.branch) {
        throw new Error(
          `working tree is on '${report.restored.workspace.branch}', not the preserved '${record.preservedWorkspace.branch}'`,
        );
      }
      if (report.restored.workspace.headSha !== record.preservedWorkspace.headSha) {
        throw new Error(
          `preserved branch came back at ${report.restored.workspace.headSha}, not ${record.preservedWorkspace.headSha}`,
        );
      }
    }
    // The retained resource was VERIFIED, never rebooted: the park left it
    // running, and a boot here would start a second copy of it.
    const retainedIds = record.resourceManifest.resources
      .filter((resource) => resource.releaseEffect === 'retain')
      .map((resource) => resource.resourceId);
    for (const resourceId of retainedIds) {
      const effects = report.restored.restoreEffects.filter(
        (effect) => effect.resourceId === resourceId,
      );
      if (!effects.some((effect) => effect.action === 'verified' && effect.ok)) {
        throw new Error(
          `retained resource '${resourceId}' has no successful verification: ${JSON.stringify(effects)}`,
        );
      }
      if (effects.some((effect) => effect.action === 'booted')) {
        throw new Error(`restore booted retained resource '${resourceId}'`);
      }
    }
    if (
      report.restored.recoveryProof?.sessionId !== record.recoveryHandle.sessionId ||
      report.restored.recoveryProof?.live !== true ||
      report.restored.recoveryProof?.acknowledgement?.kind !== 'structured'
    ) {
      throw new Error(
        `the worker did not come back on the persisted session with structured proof: ${JSON.stringify(report.restored.recoveryProof)}`,
      );
    }
    if (report.restored.paneAfter !== report.restored.contextPaneAfter) {
      throw new Error(
        `the park record and the agent context disagree about the worker pane: ${report.restored.paneAfter} vs ${report.restored.contextPaneAfter}`,
      );
    }
    if (report.restored.generation !== report.parked.generation) {
      throw new Error(
        `a held gate advanced the generation ${report.parked.generation} -> ${report.restored.generation}`,
      );
    }

    // ─── answerable ───────────────────────────────────────────────────────
    // Read-only on purpose: the operator's decision is theirs to make. What is
    // proved here is that the fence lifted, not that the gate was answered.
    const stillPending = pendingGateDecision(restoredRun);
    const postureAfter = rpc('runtime.posture.status', { runId });
    report.answerable = {
      decisionId: stillPending?.id ?? null,
      stillPending: stillPending?.id === decision.id,
      posture: postureAfter.state?.posture ?? null,
      gateChoiceSuppressedForGeneration:
        postureAfter.state?.gateChoiceSuppressedForGeneration ?? null,
    };
    if (!report.answerable.stillPending) {
      throw new Error('the restore consumed or replaced the pending gate decision');
    }
    // The restored gate must not inherit the choice that parked the run.
    if (report.answerable.gateChoiceSuppressedForGeneration !== report.parked.generation) {
      throw new Error(
        `the restored gate can still inherit free-slot (suppressed=${report.answerable.gateChoiceSuppressedForGeneration}, generation=${report.parked.generation})`,
      );
    }
    // ─── consumed ─────────────────────────────────────────────────────────
    // LAST, because it spends the gate the node above just proved answerable —
    // and consuming it also consumes the one-shot suppression that node checks.
    // The REAL operator trigger, end to end: `run.resolveDecision` restores a
    // freed park, consumes the decision, and the engine acts on the answer. It
    // needs a gate-held run the proof may spend, so it runs against a
    // disposable run supplied for it, never against one an operator is holding.
    report.consumed = await proveGateConsumption({ machine: record.machine, timeoutMs });
    if (report.consumed.attempted && !report.consumed.pass) {
      throw new Error(`gate consumption proof failed: ${report.consumed.error}`);
    }
    report.pass = true;
  } catch (error) {
    report.error = error?.message || String(error);
  }

  const outPath = writeEvidence(report, GATE_PARK_SCENARIO_ID, runner, outDir);
  return { scenario: GATE_PARK_SCENARIO_ID, runner, outPath, pass: report.pass, report };
}

/**
 * The one refusal the restore poll waits through: the slot is still `busy`
 * because the successor's teardown has not finished.
 *
 * `METHOD_ERROR` is the gateway's catch-all for a refused call, so the code
 * alone would also match every unrelated method error. The message is consulted
 * to narrow it to this cause — and the exact refusal is recorded in the
 * evidence, so a change in that wording shows up as a node that stopped
 * waiting rather than as a silent behaviour change.
 */
function isSlotNotReadyRefusal(error) {
  return (
    error?.gatewayCode === 'METHOD_ERROR' && /is 'busy', not ready/.test(error.gatewayMessage ?? '')
  );
}

/**
 * Whether a park rejection is one of the two RACES this harness retries.
 *
 * The two causes each have their own code now, so this branches on the code
 * alone. It used to match the reason text, because both causes shared a
 * catch-all code with real verdicts — `PARK_EXECUTE_REFUSED` for any execute
 * exception, `RUNNER_RECOVERY_UNSUPPORTED` for any recovery-handle exception —
 * and retrying on those would have let a later success bury an unrelated
 * failure. The gateway now emits the distinction at the source, so the harness
 * reads it instead of re-deriving it from prose that can change per release.
 *
 * The two races an operator answers by choosing `free-slot` again:
 *
 *   - the machine-pause preview digest went stale because something touched the
 *     run between the preview and the execute;
 *   - the runner liveness probe exceeded its budget on a loaded machine
 *     (MANUAL-000121); the budget itself arrives in `details.probeBudgetMs`.
 */
function isRetryableParkRace(rejection) {
  return (
    rejection?.code === 'MACHINE_PAUSE_PREVIEW_STALE' ||
    rejection?.code === 'RUNNER_LIVENESS_PROBE_TIMEOUT'
  );
}

/**
 * Park a gate-held run through the operator's own `free-slot` choice.
 *
 * The gateway path, not a shortcut: `runtime.posture.apply` is exactly what
 * Command Center, the CLI, and Companion send, so a park that only works when
 * this scenario drives machine-pause directly would not be the one operators
 * get.
 */
function parkGateHeldRun(runId, timeoutMs) {
  const before = rpc('run.get', { runId }).run;
  if (!pendingGateDecision(before)) {
    throw new Error(`run ${runId} has no pending publication gate to park at`);
  }
  // Retried, because two of this park's refusals are races rather than
  // verdicts. An operator meets both by choosing `free-slot` again, so the
  // harness does the same rather than reporting a machine-load artifact as a
  // product defect — but ONLY for those two causes, and every attempt is kept.
  // A retry that reported just its last attempt would let a success hide the
  // refusals it took to get there, which is the thing a reader of this evidence
  // most needs to see.
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const operationId = `gate-park-restore-park-${process.pid}-${Date.now()}-${attempt}`;
    const applied = rpc(
      'runtime.posture.apply',
      { runId, gateChoice: 'free-slot', operationId },
      timeoutMs,
    );
    const parked = rpc('run.get', { runId }).run;
    const record = {
      attempt,
      operationId,
      transitionOutcome: applied.transition?.outcome ?? null,
      rejection: applied.transition?.rejection ?? null,
      phase: parked.park?.phase ?? null,
      slotFreedAt: parked.park?.slotFreedAt ?? null,
    };
    attempts.push(record);
    if (parked.park?.slotFreedAt && parked.park.phase === 'parked') {
      return { ...record, attempts };
    }
    if (!isRetryableParkRace(record.rejection)) break;
  }
  throw new Error(`free-slot did not park the run: ${JSON.stringify({ attempts })}`);
}

/**
 * Put a scripted run on the freed slot so the restore has something to refuse.
 *
 * It resolves the engine's own blocking decisions rather than pre-empting them:
 * a freed slot legitimately looks stale (its HEAD is wherever the park detached
 * it, or wherever the last occupant left it), so the slot picker is expected and
 * answering it is the operator action that hands the slot over.
 */
async function dispatchSlotSuccessor({ project, ticketOrPr, slotId, timeoutMs }) {
  const created = rpc('run.create', {
    project,
    flowType: 'dev',
    mode: 'validation',
    ticketOrPr,
    initialContext: `Live proof successor: hold ${slotId} so a freed-slot restore must refuse.`,
    runner: 'scripted',
    scripted: { mode: 'scenario', scenario: 'success', stepDelayMs: 4000 },
    allowedSlots: [slotId],
    skipPrepare: true,
  });
  const successorRunId = created.run.id;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = rpc('run.get', { runId: successorRunId }).run;
    // The SLOT ROW is what a restore reads, and the run's own `slotId` is set
    // before the row claim is visible. Waiting on the run would hand the next
    // node a slot nothing owns yet.
    if (run.slotId === slotId && slotBinding(slotId).currentRunId === successorRunId) {
      return successorRunId;
    }
    if (['done', 'failed', 'cancelled'].includes(run.status)) {
      throw new Error(`successor ${successorRunId} ended '${run.status}' without taking ${slotId}`);
    }
    const pending = (run.decisions ?? []).find((decision) => !decision.resolvedAt);
    if (pending?.type === 'engine_collision') {
      rpc('run.resolveDecision', {
        runId: successorRunId,
        decisionId: pending.id,
        actionId: 'create-new',
      });
    } else if (pending?.type === 'engine_no_suitable_slot') {
      // The freed slot scores stale by design; picking it is the operator
      // action that hands it over.
      rpc('run.resolveDecision', {
        runId: successorRunId,
        decisionId: pending.id,
        actionId: 'pick',
        selectionData: { slotId },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`successor ${successorRunId} never took ${slotId}`);
}

/**
 * Prove `run.resolveDecision` on a freed gate park end to end: it restores, it
 * consumes the decision, and the run moves past the gate.
 *
 * Deliberately a separate, disposable run. Consuming a decision is the thing
 * being proved, so it cannot be done to a gate an operator is still holding —
 * and the run that IS held is the only one on this machine, because a
 * publication gate needs a real prepared package that a scripted worker cannot
 * produce. So the run is supplied rather than created, and without one the node
 * says exactly what it did not prove and how to supply it.
 */
async function proveGateConsumption({ machine, timeoutMs }) {
  const consumeRunId = process.env.FARMSLOT_GATE_PARK_CONSUME_RUN_ID?.trim();
  if (!consumeRunId) {
    return {
      attempted: false,
      pass: false,
      reason:
        'proving consumption spends a publication gate, so it needs a run supplied for that purpose',
      howToSupply: [
        'dispatch a second backlog item to a session-reload runner and let it reach its publication HUMAN_GATE',
        'park it with runtime.posture.apply { gateChoice: "free-slot" }',
        'pass its run id as FARMSLOT_GATE_PARK_CONSUME_RUN_ID; this node then answers that gate',
      ],
    };
  }
  const proof = { attempted: true, pass: false, runId: consumeRunId, error: null };
  try {
    // Parked here when it is not already, so this node is self-contained and can
    // follow the restore cycle above on the same run: that cycle deliberately
    // leaves the run RESTORED, and consumption needs it parked.
    let before = rpc('run.get', { runId: consumeRunId }).run;
    if (!before.park?.slotFreedAt) {
      proof.parkedByChoice = parkGateHeldRun(consumeRunId, timeoutMs);
      before = rpc('run.get', { runId: consumeRunId }).run;
    }
    const park = before.park;
    if (!park?.slotFreedAt || park.mode !== 'release' || park.slotDisposition !== 'freed') {
      throw new Error(`run ${consumeRunId} is not a freed gate park`);
    }
    if (park.machine !== machine)
      throw new Error(`run ${consumeRunId} is parked on ${park.machine}`);
    const decision = pendingGateDecision(before);
    if (!decision) throw new Error(`run ${consumeRunId} has no pending publication gate`);
    // Prefer an answer that keeps the run non-terminal and PUBLISHES NOTHING.
    // The claim under test is that answering the gate restores the run before
    // it consumes the decision — publishing is not part of it, and a proof that
    // opens a PR as a side effect is a proof nobody can safely re-run.
    const actionIds = decision.actions.map((candidate) => candidate.id);
    const action =
      actionIds.find((candidate) => candidate === 'hold') ??
      actionIds.find((candidate) => !candidate.startsWith('approve-')) ??
      actionIds[0];
    proof.actionIsNonPublishing = action !== actionIds.find((c) => c.startsWith('approve-'));
    proof.decisionId = decision.id;
    proof.actionId = action;
    proof.beforeStatus = before.status;

    const attempt = resolveDecisionAttempt(consumeRunId, decision.id, action, timeoutMs);
    proof.resolveExit = attempt.status;
    if (attempt.status !== 0) {
      throw new Error(
        `run.resolveDecision failed: ${`${attempt.stdout}${attempt.stderr}`.slice(0, 400)}`,
      );
    }
    const response = JSON.parse(attempt.stdout);
    proof.gateParkRestore = response.gateParkRestore ?? null;
    if (!proof.gateParkRestore?.reloadedSessionId) {
      throw new Error('the resolution reported no gate-park restore, so it never restored the run');
    }
    const restoredRun = rpc('run.get', { runId: consumeRunId }).run;
    const after = restoredRun;
    proof.resolvedAt =
      after.decisions.find((candidate) => candidate.id === decision.id)?.resolvedAt ?? null;
    if (!proof.resolvedAt) throw new Error('the decision was not consumed');
    proof.parkPhase = after.park?.phase ?? null;
    proof.slotFreedAt = after.park?.slotFreedAt ?? null;
    proof.restoreProgress = after.park?.restoreProgress ?? null;
    if (proof.parkPhase !== 'restored' || proof.slotFreedAt) {
      throw new Error(
        `the park settled '${proof.parkPhase}' with slotFreedAt ${proof.slotFreedAt}`,
      );
    }
    // Consuming is not progress. The engine has to ACT on the answer, or the
    // operator's decision went nowhere. What acting looks like depends on the
    // action: an approval walks past the gate, a hold re-presents it as a new
    // decision. Either is the engine moving.
    //
    // The run's STATUS is deliberately not one of those signals. The restore
    // inside this very call moves the run off the status the park preserved, so
    // a status comparison against the parked value is satisfied by the restore
    // rather than by the engine acting — an assertion that cannot fail on the
    // path it is asserting about.
    const progressed = await poll(
      `run ${consumeRunId} to act on its answered gate`,
      () => rpc('run.get', { runId: consumeRunId }).run,
      (run) =>
        run.steps.find((step) => step.name === 'human-gate')?.status !== 'running' ||
        pendingGateDecision(run)?.id !== undefined,
      timeoutMs,
    );
    proof.statusAfterRestore = restoredRun.status;
    proof.afterStatus = progressed.status;
    proof.gateStep = progressed.steps.find((step) => step.name === 'human-gate')?.status ?? null;
    proof.rePresentedDecisionId = pendingGateDecision(progressed)?.id ?? null;
    if (proof.rePresentedDecisionId === decision.id) {
      throw new Error('the answered decision is still the pending one; it was not consumed');
    }
    if (proof.gateStep === 'running' && !proof.rePresentedDecisionId) {
      throw new Error('the answered gate produced no engine action');
    }
    proof.pass = true;
  } catch (error) {
    proof.error = error?.message || String(error);
  }
  return proof;
}
