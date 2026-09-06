import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  Events,
  isTerminalRunStatus,
  type MachineParkCapabilityLease,
  type MachineParkCurrentStep,
  MachineParkEligibilityCodes,
  type MachineParkError,
  type MachineParkPhase,
  type MachineParkRecord,
  type MachineParkResource,
  type MachineParkResourceManifest,
  type MachineParkResourceReleaseEffect,
  machineParkRestoreComplete,
  type MachineParkRestoreEffect,
  type MachineParkRestoreProgress,
  type MachineParkRestoreRefusal,
  type MachineParkRestoreStage,
  type MachineParkSlotDisposition,
  type MachineParkWorkspace,
  type MachinePauseExecuteParams,
  type MachinePauseExecuteResult,
  type MachinePauseMode,
  type MachinePausePreviewParams,
  type MachinePausePreviewResult,
  type MachinePausePreviewRun,
  type MachinePauseRecoveryHandle,
  type MachinePauseRestoreParams,
  type MachinePauseRestorePreviewRun,
  type MachinePauseRestoreResult,
  type MachinePauseRestoreTarget,
  type MachinePauseReviewedTarget,
  type MachinePauseSelector,
  type MachinePauseStatusResult,
  needsGateParkRestore,
  PipelineSteps,
  type ResourcePressureMachine,
  type Run,
  type RuntimeCapabilityAcquireParams,
  type RuntimeCapabilityAcquireResult,
  type RuntimeCapabilityAffectedOwnership,
  type RuntimeCapabilityAffectedReleaseEffect,
  type RuntimeCapabilityCatalogEntry,
  type RuntimeCapabilityReleaseResult,
  type RuntimeCapabilityStatusResult,
  type SlotResource,
} from '@farmslot/protocol';

import { selectAgentContext, upsertAgentContext } from '../agents/contexts.js';
import { loadProjectVars, loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import {
  claimSlotStatusIf,
  readSlotRow,
  resetSlotIf,
  SLOT_PHASE_RELEASING,
} from '../core/index.js';
import {
  captureSlotResourceLifecycle,
  runWithResourceLifecycleContext,
} from '../core/resource-lifecycle-log.js';
import { resolveTmuxSession, shellQuote } from '../core/tmux.js';
import { readMachinePressure } from '../fleet/pressure-read.js';
import {
  executeResourceControl,
  pollSlotResources,
  resolveSlotResources,
} from '../fleet/resource-manager.js';
import { loadFleetStatus } from '../fleet/state.js';
import { resolveDispatchSafetyTier } from '../methods/dispatch/safety-tier.js';
import { slotOwnershipFieldsForRun } from '../methods/fleet.js';
import {
  runPauseTransitionLocked,
  type RunResumeAcknowledgement,
  runResumeTransitionLocked,
} from '../methods/run/lifecycle-control.js';
import {
  runtimeCapabilityAcquire,
  runtimeCapabilityRelease,
  runtimeCapabilityStatus,
} from '../methods/runtime-capabilities.js';
import { isGateHeldPublicationRun } from '../run-engine/gate-held-lifecycle.js';
import {
  withMachineRunTransition,
  withRunTransitionWhileMachineHeld,
} from '../run-lifecycle/transition-coordinator.js';
import { normalizeRunner } from '../runners/registry.js';
import {
  inspectRunnerParkHost,
  inspectRunnerRecovery,
  rehostRunnerParkTarget,
  reloadRunnerForPark,
  type RunnerParkHostOwnership,
  type RunnerParkHostPlan,
  runnerRunningForPark,
  stopRunnerForPark,
} from '../runners/session-lifecycle.js';
import { resolveRunRetainedSessionBinding } from '../runners/session-process.js';
import { getAllRuns, getRun, persistRunNow, runsDirectory, updateRun } from '../runs/store.js';

import {
  type MachineParkingIntentJournal,
  MachineParkingIntentJournalStore,
  type MachineParkingIntentKind,
} from './journal.js';

type Fleet = Awaited<ReturnType<typeof loadFleetStatus>>;
type MachineParkingRecoveryProof = NonNullable<MachineParkRecord['recoveryProof']>;

export interface MachineParkingDependencies {
  now(): string;
  operationId(): string;
  allRuns(): Run[];
  getRun(runId: string): Run | undefined;
  loadFleet(): Promise<Fleet>;
  updatePark(runId: string, park: MachineParkRecord | null): Run;
  persistRun(run: Run, reason: string): Promise<void>;
  writeIntentJournal(
    kind: MachineParkingIntentKind,
    records: MachineParkRecord[],
    scopeId?: string,
  ): Promise<void>;
  deleteIntentJournal(
    machine: string,
    kind: MachineParkingIntentKind,
    operationId: string,
    scopeId?: string,
  ): Promise<void>;
  loadIntentJournals(): Promise<MachineParkingIntentJournal[]>;
  emit(event: string, payload: unknown): Promise<void>;
  pressure(machine: string): Promise<ResourcePressureMachine | undefined>;
  observeResources(slotId: string): Promise<SlotResource[]>;
  capabilityStatus(slotId: string, runId?: string): Promise<RuntimeCapabilityStatusResult>;
  releaseCapability(params: {
    slotId: string;
    runId: string;
    leaseId: string;
    capabilityId: string;
  }): Promise<RuntimeCapabilityReleaseResult>;
  acquireCapability(
    params: RuntimeCapabilityAcquireParams,
  ): Promise<RuntimeCapabilityAcquireResult>;
  /** Declaration-only runner capability check; no session probe, no side effect. */
  inspectRunnerReload(run: Run): Promise<RunnerReloadInspection>;
  /** Read-only: which branch the slot's working tree holds and whether it is clean. */
  inspectParkWorkspace(run: Run): Promise<ParkWorkspaceInspection>;
  /** Take the parked branch out of the working tree so the next prepare cannot move it. */
  detachParkedWorkspace(run: Run, expected: MachineParkWorkspace): Promise<void>;
  /** Release slot ownership while the parked run keeps its slotId. */
  freeSlotOwnership(slotId: string, runId: string): Promise<boolean>;
  /**
   * Bind a freed slot back to the run it was freed from. CAS on the slot still
   * being unowned, so a restore can never take a slot dispatch already gave
   * away.
   */
  claimSlotOwnership(run: Run, slotId: string): Promise<boolean>;
  /** Read-only: where the preserved branch ref points now, or null when it is gone. */
  preservedBranchTip(run: Run, workspace: MachineParkWorkspace): Promise<string | null>;
  /** Read-only: can the persisted runner session be reloaded on this slot, and where. */
  inspectParkHost(
    run: Run,
    handle: MachinePauseRecoveryHandle,
    ownership?: RunnerParkHostOwnership,
  ): Promise<RunnerParkHostPlan>;
  /** Bind the persisted runner session to a pane a reload can run in. */
  rehostParkTarget(
    run: Run,
    handle: MachinePauseRecoveryHandle,
    ownership?: RunnerParkHostOwnership,
  ): Promise<RunnerParkHostPlan>;
  /** Point the run's agent context at the re-hosted pane so operator attach works. */
  rebindAgentContextTarget(run: Run, handle: MachinePauseRecoveryHandle): Promise<void>;
  /**
   * Tell the posture reconciler the park its `parked` posture described is
   * over. Without it every client reads a restored run as parked with a dead
   * worker, because the posture records the policy that was applied rather than
   * where the run is now.
   */
  recordParkRestoredPosture(runId: string): Promise<void>;
  /** The slot row as one snapshot, so owner and lifecycle cannot be read torn. */
  slotRow(slotId: string): Promise<Readonly<Record<string, unknown>> | null>;
  /** Put a detached branch back in the working tree when a park will not finish. */
  reattachParkedWorkspace(run: Run, workspace: MachineParkWorkspace): Promise<void>;
  resolveRecoveryHandle(run: Run): Promise<MachinePauseRecoveryHandle>;
  inspectRecoveryHandle(
    run: Run,
    handle: MachinePauseRecoveryHandle,
    expectedRunnerState: 'live' | 'stopped' | 'stopped-or-live',
  ): Promise<void>;
  pauseRun(runId: string, emit: (event: string, payload: unknown) => void): Promise<void>;
  resumeRun(
    runId: string,
    emit: (event: string, payload: unknown) => void,
    options: { suppressMonitorNudge: boolean },
  ): Promise<RunResumeAcknowledgement>;
  stopRunner(run: Run, handle: MachinePauseRecoveryHandle): Promise<void>;
  reloadRunner(
    run: Run,
    handle: MachinePauseRecoveryHandle,
    continuationPrompt: string,
  ): Promise<MachineParkingRecoveryProof>;
  runnerRunning(
    run: Run,
    handle: MachinePauseRecoveryHandle,
  ): Promise<'running' | 'stopped' | 'unknown'>;
  stopResource(slotId: string, resourceId: string): Promise<{ ok: boolean; detail?: string }>;
  startResource(slotId: string, resourceId: string): Promise<{ ok: boolean; detail?: string }>;
}

/**
 * What the slot's working tree currently holds. `branch` is null when HEAD is
 * already detached, which means there is no branch ref for the next occupant's
 * prepare to move and nothing to preserve.
 */
export interface ParkWorkspaceInspection {
  branch: string | null;
  headSha: string | null;
  dirtyPaths: string[];
}

/** What the runner registry declares about stopping and reloading a session. */
export interface RunnerReloadInspection {
  runnerId: string;
  supported: boolean;
  reason?: string;
}

/** What a gate-resolution-triggered restore did, or why it refused. */
export type MachineParkGateRestoreResult =
  | {
      ok: true;
      runId: string;
      slotId: string;
      restoredGeneration: number;
      reloadedSessionId: string;
      /** The gate loop had exited, so the gate was re-presented as a new decision. */
      gateReplayed: boolean;
      record: MachineParkRecord;
    }
  | {
      ok: false;
      runId: string;
      slotId: string;
      /** A `MachineParkEligibilityCode`, or `RESTORE_PARTIAL` for an attempt that started. */
      code: string;
      reason: string;
      record: MachineParkRecord;
    };

export interface MachineParkingCancelEffect {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  detail?: string;
}

interface CachedPreview {
  kind: 'pause' | 'restore';
  createdAtMs: number;
  pause?: MachinePausePreviewResult;
  restore?: {
    machine: string;
    selector: MachinePauseSelector;
    previewId: string;
    runs: MachinePauseRestorePreviewRun[];
  };
}

const PREVIEW_TTL_MS = 5 * 60_000;
const PREVIEW_CACHE_LIMIT = 100;
const previewCache = new Map<string, CachedPreview>();
const intentJournalStore = new MachineParkingIntentJournalStore(runsDirectory());

async function defaultLoadIntentJournals(): Promise<MachineParkingIntentJournal[]> {
  const result = await intentJournalStore.load();
  for (const issue of result.quarantined) {
    console.error(
      `[machine-pause] quarantined malformed intent journal ${issue.file}: ${issue.reason}`,
    );
  }
  return result.journals;
}

async function broadcast(event: string, payload: unknown): Promise<void> {
  const { broadcastEvent } = await import('../server.js');
  broadcastEvent(event, payload);
}

async function defaultPressure(machine: string): Promise<ResourcePressureMachine | undefined> {
  try {
    // Shared 1s-deduped read so machine relief and dispatch admission never
    // multiply the expensive snapshot work for the same machine.
    return await readMachinePressure(machine);
  } catch (error) {
    // Pressure is optional response context. A sampling failure must not turn an already-durable
    // park/restore mutation into a reported RPC failure.
    console.warn(
      `[machine-pause] pressure refresh failed for ${machine}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

async function defaultObserveResources(slotId: string): Promise<SlotResource[]> {
  await pollSlotResources(slotId, { probeInactiveSimulators: true });
  return resolveSlotResources(slotId);
}

async function defaultResolveRecoveryHandle(run: Run): Promise<MachinePauseRecoveryHandle> {
  if (!run.slotId) throw new Error('run has no slot');
  const context = selectAgentContext(run, { role: 'primary' });
  if (!context?.target) throw new Error('primary agent context has no exact tmux target');
  if (!context.target.paneId) throw new Error('primary agent context has no exact tmux pane id');
  const rawRunnerId = context.runner ?? run.metrics.runner;
  if (!rawRunnerId?.trim()) throw new Error('run has no persisted runner identity');
  const runnerId = normalizeRunner(rawRunnerId);
  const binding = resolveRunRetainedSessionBinding(run, context);
  if (!binding.binding) throw new Error(binding.reason ?? 'no persisted runner session binding');
  const vars = await loadSlotVars(run.slotId);
  const expectedSession = await resolveTmuxSession(run.slotId, vars, { strict: true });
  if (context.target.session !== expectedSession) {
    throw new Error(
      `agent target session '${context.target.session}' does not own slot session '${expectedSession}'`,
    );
  }
  const projectVars = await loadProjectVars(run.project);
  const safetyTier = resolveDispatchSafetyTier({
    runTier: run.safetyTier,
    projectDefaultRaw: projectVars.projectJson.default_safety_tier,
  });
  const handle: MachinePauseRecoveryHandle = {
    version: 1,
    runnerId,
    contextId: context.id,
    sessionId: binding.binding.runnerSessionId,
    sessionPath: binding.binding.runnerSessionPath,
    target: { ...structuredClone(context.target), paneId: context.target.paneId },
    model: context.model ?? run.metrics.model ?? null,
    ...(run.effort ? { effort: run.effort } : {}),
    ...(safetyTier ? { safetyTier } : {}),
    runtimeDir: await resolveProjectRuntimeDir(run.project),
    ...(run.taskFile ? { taskDir: path.posix.dirname(run.taskFile) } : {}),
    capturedAt: new Date().toISOString(),
  };
  await defaultInspectRecoveryHandle(run, handle, 'live');
  return handle;
}

async function defaultInspectRecoveryHandle(
  run: Run,
  handle: MachinePauseRecoveryHandle,
  expectedRunnerState: 'live' | 'stopped' | 'stopped-or-live',
): Promise<void> {
  if (!run.slotId) throw new Error('run has no slot');
  const vars = await loadSlotVars(run.slotId);
  const session = await resolveTmuxSession(run.slotId, vars, { strict: true });
  if (session !== handle.target.session) {
    throw new Error(
      `slot session changed from '${handle.target.session}' to '${session}'; recovery handle is stale`,
    );
  }
  const inspection = await inspectRunnerRecovery({
    vars,
    runnerId: handle.runnerId,
    recoveryHandle: handle,
    expectedRunnerState,
  });
  if (!inspection.supported) throw new Error(inspection.reason ?? 'runner recovery unsupported');
}

async function defaultReloadRunner(
  run: Run,
  handle: MachinePauseRecoveryHandle,
  continuationPrompt: string,
): Promise<MachineParkingRecoveryProof> {
  if (!run.slotId) throw new Error('run has no slot');
  const vars = await loadSlotVars(run.slotId);
  const session = await resolveTmuxSession(run.slotId, vars, { strict: true });
  if (session !== handle.target.session) {
    throw new Error(
      `slot session changed from '${handle.target.session}' to '${session}'; refusing session reload`,
    );
  }
  const result = await reloadRunnerForPark({
    vars,
    recoveryHandle: handle,
    initialPrompt: continuationPrompt,
  });
  if (!result.ok) throw new Error(result.error);
  if (!result.live || result.acknowledgement.kind !== 'structured') {
    throw new Error('runner reload returned without structured acceptance and live-target proof');
  }
  return {
    sessionId: result.sessionId,
    live: true,
    acknowledgement: structuredClone(result.acknowledgement),
    acceptedAt: new Date().toISOString(),
  };
}

/**
 * Runner-capability-first gate for parking a gate-held worker: the registry's
 * declared graceful exit + persisted session reload, read through the shared
 * runner inspection with no handle probe and no runner-name branch. A runner
 * that declares neither fails closed.
 */
async function defaultInspectRunnerReload(run: Run): Promise<RunnerReloadInspection> {
  // Declaration-only: no slot vars, no exec, no session probe. The registry
  // answers this from RunnerDefinition alone.
  const inspection = await inspectRunnerRecovery({
    runnerId: run.metrics.runner,
    recoveryHandle: null,
  });
  const runnerId = inspection.runnerId || (run.metrics.runner?.trim() ?? 'unknown');
  const supported = inspection.gracefulStop.supported && inspection.sessionReload.supported;
  if (supported) return { runnerId, supported: true };
  return {
    runnerId,
    supported: false,
    reason: !inspection.gracefulStop.supported
      ? `runner '${runnerId}' declares no graceful exit capability`
      : `runner '${runnerId}' declares no persisted session reload capability`,
  };
}

/**
 * Read the slot working tree's branch identity. Read-only: no checkout, no
 * reset, no index write. A detached HEAD reports `branch: null` — there is no
 * branch ref at risk, so nothing needs preserving.
 */
async function defaultInspectParkWorkspace(run: Run): Promise<ParkWorkspaceInspection> {
  if (!run.slotId) throw new Error('run has no slot');
  const vars = await loadSlotVars(run.slotId);
  const repo = shellQuote(vars.remoteRepo);
  const [headRef, headSha, porcelain] = await Promise.all([
    execOnSlot(vars, `cd ${repo} && git rev-parse --abbrev-ref HEAD`, { timeout: 15_000 }),
    execOnSlot(vars, `cd ${repo} && git rev-parse HEAD`, { timeout: 15_000 }),
    execOnSlot(vars, `cd ${repo} && git status --porcelain`, { timeout: 30_000 }),
  ]);
  if (headRef.exitCode !== 0 || headSha.exitCode !== 0 || porcelain.exitCode !== 0) {
    throw new Error(
      `git identity unreadable in ${vars.remoteRepo}: ${
        (headRef.stderr || headSha.stderr || porcelain.stderr).slice(-200) || 'no detail'
      }`,
    );
  }
  const ref = headRef.stdout.trim();
  return {
    branch: ref && ref !== 'HEAD' ? ref : null,
    headSha: headSha.stdout.trim() || null,
    dirtyPaths: porcelain.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

/**
 * Detach the working tree from the parked branch after re-proving nothing moved
 * since the preview. The branch ref survives at `expected.headSha`, so the next
 * occupant's `git reset --hard <base>` moves only the detached HEAD.
 */
async function defaultDetachParkedWorkspace(
  run: Run,
  expected: MachineParkWorkspace,
): Promise<void> {
  const current = await defaultInspectParkWorkspace(run);
  if (current.branch === null) {
    if (current.headSha !== expected.headSha) {
      throw new Error(
        `working tree is already detached at ${current.headSha ?? 'unknown'}, not the reviewed ${expected.headSha}`,
      );
    }
    return;
  }
  if (current.branch !== expected.branch || current.headSha !== expected.headSha) {
    throw new Error(
      `working tree moved to ${current.branch}@${current.headSha ?? 'unknown'} since the preview reviewed ${expected.branch}@${expected.headSha}`,
    );
  }
  if (current.dirtyPaths.length > 0) {
    throw new Error(
      `working tree became dirty before detach: ${current.dirtyPaths.slice(0, 10).join(', ')}`,
    );
  }
  const vars = await loadSlotVars(run.slotId!);
  const detached = await execOnSlot(
    vars,
    `cd ${shellQuote(vars.remoteRepo)} && git checkout --detach ${shellQuote(expected.headSha)}`,
    { timeout: 60_000 },
  );
  if (detached.exitCode !== 0) {
    throw new Error(
      `git checkout --detach failed in ${vars.remoteRepo}: ${detached.stderr.slice(-200) || detached.stdout.slice(-200)}`,
    );
  }
}

/**
 * Put the parked branch back in the working tree at the exact tip the park
 * detached from. Refuses rather than moving the branch: the ref must still be
 * where the record says it is, or something else has touched this workspace and
 * a checkout would be guessing.
 */
async function defaultReattachParkedWorkspace(
  run: Run,
  workspace: MachineParkWorkspace,
): Promise<void> {
  if (!run.slotId) throw new Error('run has no slot');
  const vars = await loadSlotVars(run.slotId);
  const repo = shellQuote(vars.remoteRepo);
  // One reader for "where does the preserved branch point", shared with the
  // read-only inspection restore does first. Two copies of a comparison this
  // load-bearing is one copy too many: the refusal and the checkout must agree
  // about what counts as the recorded tip.
  const tip = await defaultPreservedBranchTip(run, workspace);
  if (tip !== workspace.headSha) {
    throw new Error(
      `branch '${workspace.branch}' is at ${tip ?? 'unknown'}, not the detached tip ${workspace.headSha}`,
    );
  }
  const checkout = await execOnSlot(
    vars,
    `cd ${repo} && git checkout ${shellQuote(workspace.branch)}`,
    { timeout: 60_000 },
  );
  if (checkout.exitCode !== 0) {
    throw new Error(
      `git checkout ${workspace.branch} failed in ${vars.remoteRepo}: ${checkout.stderr.slice(-200) || checkout.stdout.slice(-200)}`,
    );
  }
}

/**
 * Where the preserved branch ref points right now. Read-only: no checkout, no
 * ref write. `null` means the ref is gone, which restore treats exactly like a
 * moved tip — the recorded commit is no longer reachable by that name.
 */
async function defaultPreservedBranchTip(
  run: Run,
  workspace: MachineParkWorkspace,
): Promise<string | null> {
  if (!run.slotId) throw new Error('run has no slot');
  const vars = await loadSlotVars(run.slotId);
  const tip = await execOnSlot(
    vars,
    `cd ${shellQuote(vars.remoteRepo)} && git rev-parse ${shellQuote(workspace.branch)}`,
    { timeout: 15_000 },
  );
  return tip.exitCode === 0 ? tip.stdout.trim() || null : null;
}

async function parkHostOptions(run: Run, handle: MachinePauseRecoveryHandle) {
  if (!run.slotId) throw new Error('run has no slot');
  return { vars: await loadSlotVars(run.slotId), recoveryHandle: handle };
}

const defaultDependencies: MachineParkingDependencies = {
  now: () => new Date().toISOString(),
  operationId: () => `machine-park-${randomUUID()}`,
  allRuns: getAllRuns,
  getRun,
  loadFleet: loadFleetStatus,
  updatePark: (runId, park) => updateRun(runId, { park }),
  persistRun: persistRunNow,
  writeIntentJournal: (kind, records, scopeId) => intentJournalStore.write(kind, records, scopeId),
  deleteIntentJournal: (machine, kind, operationId, scopeId) =>
    intentJournalStore.delete(machine, kind, operationId, scopeId),
  loadIntentJournals: defaultLoadIntentJournals,
  emit: broadcast,
  pressure: defaultPressure,
  observeResources: defaultObserveResources,
  capabilityStatus: (slotId, runId) =>
    runtimeCapabilityStatus({ slotId, ...(runId ? { ownerRunId: runId } : {}) }),
  releaseCapability: ({ slotId, runId, leaseId, capabilityId }) =>
    runtimeCapabilityRelease({ slotId, ownerRunId: runId, leaseId, capabilityId }),
  acquireCapability: runtimeCapabilityAcquire,
  inspectRunnerReload: defaultInspectRunnerReload,
  inspectParkWorkspace: defaultInspectParkWorkspace,
  detachParkedWorkspace: defaultDetachParkedWorkspace,
  slotRow: readSlotRow,
  reattachParkedWorkspace: defaultReattachParkedWorkspace,
  // CAS on the exact owner: a slot re-claimed between the park's last resource
  // stop and this write belongs to its new owner, and freeing must not touch a
  // pending handoff reservation or a teardown already fencing the slot.
  freeSlotOwnership: (slotId, runId) =>
    resetSlotIf(
      slotId,
      (slot) =>
        slot.current_run_id === runId &&
        slot.phase !== SLOT_PHASE_RELEASING &&
        !(typeof slot.handoff_run_id === 'string' && slot.handoff_run_id),
    ),
  // The mirror of the free, and CAS'd for the same reason: exclusivity is
  // decided INSIDE the serialized write, so a dispatch claim landing between
  // the eligibility read and this write wins rather than being clobbered. The
  // fields are the ones fleet refresh would republish from the run store, so
  // the slot stops looking free the instant the claim lands instead of at the
  // next refresh.
  claimSlotOwnership: async (run, slotId) => {
    const { claimed } = await claimSlotStatusIf(
      slotId,
      (slot) =>
        !(typeof slot.current_run_id === 'string' && slot.current_run_id) &&
        slot.phase !== SLOT_PHASE_RELEASING &&
        !(typeof slot.handoff_run_id === 'string' && slot.handoff_run_id),
      slotOwnershipFieldsForRun(run),
    );
    return claimed;
  },
  preservedBranchTip: defaultPreservedBranchTip,
  inspectParkHost: async (run, handle, ownership) =>
    inspectRunnerParkHost({
      ...(await parkHostOptions(run, handle)),
      ...(ownership ? { ownership } : {}),
    }),
  rehostParkTarget: async (run, handle, ownership) =>
    rehostRunnerParkTarget({
      ...(await parkHostOptions(run, handle)),
      ...(ownership ? { ownership } : {}),
    }),
  // Lazily imported: the posture reconciler reaches machine parking for the
  // `parked` posture, and a static edge back would close that loop at load.
  recordParkRestoredPosture: async (runId) => {
    const { getRunResourcePostureReconciler } = await import('../methods/runtime-posture.js');
    await getRunResourcePostureReconciler().recordParkRestored(runId);
  },
  rebindAgentContextTarget: async (run, handle) => {
    const context = run.agentContexts?.find((candidate) => candidate.id === handle.contextId);
    if (!context) {
      throw new Error(`run ${run.id} has no agent context '${handle.contextId}' to re-bind`);
    }
    await upsertAgentContext(run.id, context.role, {
      id: context.id,
      target: structuredClone(handle.target),
    });
  },
  resolveRecoveryHandle: defaultResolveRecoveryHandle,
  inspectRecoveryHandle: defaultInspectRecoveryHandle,
  pauseRun: (runId, emit) =>
    withRunTransitionWhileMachineHeld(runId, async () => {
      await runPauseTransitionLocked({ runId }, emit, { machineParkingPause: true });
    }),
  resumeRun: (runId, emit, options) =>
    withRunTransitionWhileMachineHeld(runId, () =>
      runResumeTransitionLocked({ runId }, emit, {
        machineParkingRestore: true,
        suppressMonitorNudge: options.suppressMonitorNudge,
      }),
    ),
  stopRunner: async (run, handle) => {
    if (!run.slotId) throw new Error('run has no slot');
    const vars = await loadSlotVars(run.slotId);
    const result = await stopRunnerForPark({ vars, recoveryHandle: handle });
    if (!result.ok) throw new Error(result.error);
  },
  reloadRunner: defaultReloadRunner,
  runnerRunning: async (run, handle) => {
    if (!run.slotId) return 'unknown';
    return runnerRunningForPark({ vars: await loadSlotVars(run.slotId), recoveryHandle: handle });
  },
  stopResource: (slotId, resourceId) => executeResourceControl(slotId, resourceId, 'shutdown'),
  startResource: (slotId, resourceId) => executeResourceControl(slotId, resourceId, 'boot'),
};

export class MachineParkingService {
  private readonly recoveryHandles = new Map<string, MachinePauseRecoveryHandle>();
  /**
   * The branch identity each freeing preview reviewed, keyed like the recovery
   * handles. Execute re-proves it against the live tree before detaching, so a
   * stale entry can only cause a refusal, never a wrong checkout.
   */
  private readonly parkWorkspaces = new Map<string, MachineParkWorkspace>();
  private readonly pressureCache = new Map<
    string,
    {
      expiresAt: number;
      value?: ResourcePressureMachine;
      inFlight?: Promise<ResourcePressureMachine | undefined>;
    }
  >();

  constructor(private readonly deps: MachineParkingDependencies = defaultDependencies) {}

  async preview(params: MachinePausePreviewParams): Promise<MachinePausePreviewResult> {
    const machine = assertMachine(params.machine);
    assertPauseMode(params.mode);
    assertSelector(params.selector);
    const result = await this.buildPausePreview({ ...params, machine });
    this.cachePreview(result.previewId, { kind: 'pause', pause: result });
    return result;
  }

  async execute(params: MachinePauseExecuteParams): Promise<MachinePauseExecuteResult> {
    const machine = assertMachine(params.machine);
    assertPauseMode(params.mode);
    const operationId = params.operationId?.trim() || this.deps.operationId();
    return withMachineRunTransition(machine, async () => {
      const idempotent = this.idempotentRecords(operationId, machine);
      if (idempotent.length > 0) {
        if (idempotent.some((record) => record.mode !== params.mode)) {
          throw new Error('operationId was already used for a different pause mode');
        }
        assertReviewedRecords(idempotent, params.reviewedTargets, params.previewId);
        const outcome = operationOutcome(idempotent, 'parked');
        return {
          ok: outcome === 'complete',
          outcome,
          operationId,
          machine,
          mode: params.mode,
          records: idempotent,
          ...(await this.optionalPressure(machine)),
        };
      }
      const cached = this.requirePreview(params.previewId, 'pause').pause!;
      if (cached.machine !== machine || cached.mode !== params.mode) {
        throw new Error('preview does not match requested machine and pause mode');
      }
      const fresh = await this.buildPausePreview({
        machine,
        mode: params.mode,
        selector: cached.selector,
      });
      if (fresh.previewId !== params.previewId) {
        throw new Error('machine pause preview is stale; preview the batch again');
      }
      assertExecutablePreview(fresh.runs, params.reviewedTargets);
      const intent = await this.persistPauseIntents(fresh, operationId);
      if (intent.durable) {
        for (const record of intent.records) {
          try {
            await this.parkOne(record.runId);
          } catch (error) {
            await this.settleUnexpectedFailure(
              record.runId,
              'partial',
              'machine-pause.unexpected',
              error,
            );
          }
        }
      }
      this.pressureCache.delete(machine);
      const completed = intent.durable
        ? this.recordsForOperation(operationId, machine)
        : intent.records;
      const outcome = operationOutcome(completed, 'parked');
      return {
        ok: outcome === 'complete',
        outcome,
        operationId,
        machine,
        mode: params.mode,
        records: completed,
        ...(await this.optionalPressure(machine)),
      };
    });
  }

  async status(machineInput: string): Promise<MachinePauseStatusResult> {
    const machine = assertMachine(machineInput);
    const records = this.deps
      .allRuns()
      .flatMap((run) => (run.park?.machine === machine ? [structuredClone(run.park)] : []))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (records.length === 0) assertKnownMachine(machine, await this.deps.loadFleet());
    return {
      machine,
      records,
      ...(await this.optionalPressure(machine)),
    };
  }

  async restore(params: MachinePauseRestoreParams): Promise<MachinePauseRestoreResult> {
    const machine = assertMachine(params.machine);
    assertSelector(params.selector);
    if (params.execute !== true) {
      const preview = await this.buildRestorePreview(machine, params.selector);
      this.cachePreview(preview.previewId, { kind: 'restore', restore: preview });
      return {
        ok: true,
        outcome: 'preview',
        execute: false,
        previewId: preview.previewId,
        machine,
        selector: params.selector,
        runs: preview.runs,
        records: [],
        ...(await this.optionalPressure(machine)),
      };
    }
    const operationId = params.operationId?.trim() || this.deps.operationId();
    return withMachineRunTransition(machine, async () => {
      const idempotent = this.idempotentRecords(operationId, machine);
      if (idempotent.length > 0) {
        assertReviewedRecords(idempotent, params.reviewedTargets, params.previewId);
        const outcome = operationOutcome(idempotent, 'restored');
        return {
          ok: outcome === 'complete',
          outcome,
          execute: true,
          previewId: params.previewId,
          operationId,
          machine,
          selector: params.selector,
          runs: await this.restoreOutcomeRuns(idempotent),
          records: idempotent,
          ...(await this.optionalPressure(machine)),
        };
      }
      const cached = this.requirePreview(params.previewId, 'restore').restore!;
      if (
        cached.machine !== machine ||
        stableJson(cached.selector) !== stableJson(params.selector)
      ) {
        throw new Error('restore preview does not match requested machine and selector');
      }
      const fresh = await this.buildRestorePreview(machine, params.selector);
      if (fresh.previewId !== params.previewId) {
        throw new Error('machine restore preview is stale; preview the batch again');
      }
      assertExecutableRestore(fresh.runs, params.reviewedTargets);
      const selected = fresh.runs.filter((item) => item.selected);
      const intent = await this.persistRestoreIntents(selected, operationId, params.previewId);
      if (intent.durable) {
        for (const item of selected) {
          try {
            if (item.eligibility.code === 'ELIGIBLE_ZERO_EFFECT_REPAIR') {
              await this.settleZeroEffectRestore(item, operationId, params.previewId);
            } else {
              await this.restoreOne(item.runId, expectedRestoreRunnerState(item.record));
            }
          } catch (error) {
            await this.settleUnexpectedFailure(
              item.runId,
              'partial',
              'machine-restore.unexpected',
              error,
              // Only restore can legitimately advance the run generation, via a
              // gate replay, so only restore may adopt it.
              { syncGeneration: true },
            );
          }
        }
      }
      this.pressureCache.delete(machine);
      const records = intent.durable
        ? this.recordsForOperation(operationId, machine)
        : intent.records;
      const outcome = operationOutcome(records, 'restored');
      return {
        ok: outcome === 'complete',
        outcome,
        execute: true,
        previewId: params.previewId,
        operationId,
        machine,
        selector: params.selector,
        runs: await this.restoreOutcomeRuns(records),
        records,
        ...(await this.optionalPressure(machine)),
      };
    });
  }

  /**
   * Restore a freed gate park because its operator is answering the gate.
   *
   * ADR-054: resolving a gate on a parked run cannot just consume the decision
   * — the worker is stopped and the slot may belong to someone else. So the
   * resolution restores FIRST and only consumes the decision if that succeeded.
   * A refusal changes nothing the operator has to undo: the record stays
   * parked, the decision stays pending, and the reason is durable on the record
   * so a client that reconnects can still explain it.
   *
   * Deliberately not the public `machine.pause.restore` shape. There is no
   * preview to review and no batch to reconcile: the operator already made
   * their decision, and asking them to review a restore they did not ask for
   * would be a second gate in front of the first.
   */
  async restoreForGateResolution(runId: string): Promise<MachineParkGateRestoreResult> {
    const initial = this.requireRun(runId);
    const record = initial.park;
    if (!record || record.mode !== 'release' || record.slotDisposition !== 'freed') {
      throw new Error(`Run ${runId} has no gate park to restore`);
    }
    const machine = record.machine;
    return withMachineRunTransition(machine, async () => {
      // Re-read INSIDE the machine transition. A concurrent restore serializes
      // ahead of this one and may have finished the very restoration this call
      // was queued to perform; throwing "no park record" there would report a
      // failure for work that succeeded, and the operator's gate answer would
      // be lost to a race they cannot see.
      const settledFirst = this.deps.getRun(runId)?.park;
      if (settledFirst && settledFirst.phase === 'restored') {
        return this.completedGateRestore(runId, settledFirst);
      }
      const preview = await this.buildRestorePreview(machine, {
        kind: 'include',
        runIds: [runId],
      });
      const item = preview.runs.find((entry) => entry.runId === runId);
      if (!item) {
        return this.refusedGateRestore(runId, record.slotId, 'NOT_PARKED', 'no park record');
      }
      if (!item.eligibility.eligible) {
        return this.refusedGateRestore(
          runId,
          record.slotId,
          item.eligibility.code,
          item.eligibility.reason,
        );
      }
      const operationId = `gate-restore-${randomUUID()}`;
      const intent = await this.persistRestoreIntents([item], operationId, preview.previewId);
      if (!intent.durable) {
        return this.refusedGateRestore(
          runId,
          record.slotId,
          'RESTORE_PARTIAL',
          lastError(intent.records[0] ?? record),
        );
      }
      try {
        if (item.eligibility.code === 'ELIGIBLE_ZERO_EFFECT_REPAIR') {
          await this.settleZeroEffectRestore(item, operationId, preview.previewId);
        } else {
          await this.restoreOne(runId, expectedRestoreRunnerState(item.record));
        }
      } catch (error) {
        await this.settleUnexpectedFailure(runId, 'partial', 'machine-restore.unexpected', error, {
          syncGeneration: true,
        });
      }
      this.pressureCache.delete(machine);
      const settled = this.requireRun(runId).park!;
      if (settled.phase !== 'restored') {
        return this.refusedGateRestore(runId, record.slotId, 'RESTORE_PARTIAL', lastError(settled));
      }
      return this.completedGateRestore(runId, settled);
    });
  }

  /**
   * The result for a restoration that finished, whether this call performed it
   * or a concurrent one did.
   *
   * The proof is REQUIRED, not defaulted from the handle. A restore whose
   * reload started the worker and then failed to get an acknowledgement leaves
   * a running process and no proof, and falling back to the handle's session id
   * there would report a reload that was never acknowledged — which is exactly
   * the evidence gate consumption is supposed to depend on.
   *
   * BOTH acknowledgement kinds satisfy consumption, and the rule is worth
   * stating. The question consumption asks is "is this run's worker back on its
   * persisted session", not "did we personally relaunch it". `adopted` answers
   * that through the structured live-binding check on a pane the current slot
   * binding says is this run's — which is the same evidence the reload path
   * verifies AFTER relaunching. What neither may be is inferred from occupancy.
   */
  private completedGateRestore(
    runId: string,
    settled: MachineParkRecord,
  ): MachineParkGateRestoreResult {
    const proof = settled.recoveryProof;
    const acknowledged =
      proof?.acknowledgement.kind === 'structured' || proof?.acknowledgement.kind === 'adopted';
    if (!proof || proof.live !== true || !acknowledged) {
      return {
        ok: false,
        runId,
        slotId: settled.slotId,
        code: MachineParkEligibilityCodes.restoreRunnerReloadFailed,
        reason: 'the restore recorded no acknowledged runner session reload',
        record: settled,
      };
    }
    const restoredGeneration = settled.restoredGeneration ?? settled.generation;
    return {
      ok: true,
      runId,
      slotId: settled.slotId,
      restoredGeneration,
      reloadedSessionId: proof.sessionId,
      // Only a replay advances the generation; a hold restore leaves it where
      // the park found it. That is the difference between "the gate you are
      // answering is still the live one" and "the gate was re-presented".
      gateReplayed: restoredGeneration > settled.generation,
      record: settled,
    };
  }

  /**
   * The preview-shaped entries describing what a restore attempt actually did.
   *
   * `available` comes from the SAME question the preview asks — can that slot
   * take this run back right now — rather than from the record's obligation
   * marker. Reading the marker reported a partial that is sitting in its own
   * slot as unavailable, so the same record answered two different ways
   * depending on which call the client happened to make.
   */
  private async restoreOutcomeRuns(
    records: MachineParkRecord[],
  ): Promise<MachinePauseRestorePreviewRun[]> {
    return Promise.all(
      records.map(async (record) => ({
        runId: record.runId,
        generation: record.generation,
        selected: true,
        eligibility:
          record.phase === 'restored'
            ? {
                eligible: true as const,
                code: 'RESTORE_COMPLETE',
                reason: 'The reviewed parked run was restored.',
              }
            : {
                eligible: false as const,
                code: 'RESTORE_PARTIAL',
                reason: lastError(record),
              },
        restoreTarget: {
          slotId: record.slotId,
          disposition: record.slotDisposition ?? 'retained',
          available: (await this.slotAcceptsRestore(record.slotId, record.runId)).ok,
        },
        record,
      })),
    );
  }

  private async refusedGateRestore(
    runId: string,
    slotId: string,
    code: string,
    reason: string,
  ): Promise<MachineParkGateRestoreResult> {
    const record = await this.recordRestoreRefusal(runId, code, reason);
    return { ok: false, runId, slotId, code, reason, record };
  }

  async reconcile(): Promise<{ reconciled: number; partial: number }> {
    const journalBlockedRuns = await this.repairIntentJournals();
    const machines = [
      ...new Set(
        this.deps
          .allRuns()
          .flatMap((run) => (run.park && !settledPhase(run.park.phase) ? [run.park.machine] : [])),
      ),
    ];
    let reconciled = 0;
    let partial = 0;
    for (const machine of machines) {
      await withMachineRunTransition(machine, async () => {
        for (const run of this.deps
          .allRuns()
          .filter((candidate) =>
            Boolean(
              candidate.park?.machine === machine &&
              !settledPhase(candidate.park.phase) &&
              !journalBlockedRuns.has(candidate.id),
            ),
          )) {
          const record = run.park!;
          const residuals = await this.observeResiduals(run, record);
          if (record.restoreDisposition === 'zero-effect') {
            await this.patchRecord(run.id, (current) => ({
              ...current,
              phase: 'restored',
              residuals,
              restoredAt: current.restoredAt ?? this.deps.now(),
              restoredGeneration: current.restoredGeneration ?? current.generation,
            }));
            reconciled += 1;
            continue;
          }
          if (zeroEffectIntent(run, record, residuals)) {
            const cleared = this.deps.updatePark(run.id, null);
            await this.deps.persistRun(cleared, 'machine-pause-zero-effect-recovery');
            try {
              await this.deps.emit(Events.RUN_UPDATED, { run: cleared });
            } catch (error) {
              console.warn(`[machine-pause] zero-effect recovery emit failed: ${messageOf(error)}`);
            }
            reconciled += 1;
            continue;
          }
          let phase: MachineParkPhase = 'partial';
          const stopped =
            residuals.runner === 'stopped' && manifestResidualsSettled(record, residuals);
          if (isTerminalRunStatus(run.status)) phase = 'cancelled';
          else if (record.mode === 'orchestration' && run.status === 'paused') phase = 'parked';
          else if (record.mode === 'release' && run.status === 'paused' && stopped) {
            phase = 'parked';
          } else if (
            // A gate park never moves the run to `paused` — its gate must stay
            // answerable — so its parked proof is the record's own slot release
            // plus stopped residuals, not the run status.
            record.mode === 'release' &&
            record.slotDisposition === 'freed' &&
            Boolean(record.slotFreedAt) &&
            // Not once a restore has re-bound the slot. `slotFreedAt` survives
            // the restore, and `observeResiduals` reported `stopped` from the
            // same record, so this re-phased a mid-restore `partial` back to a
            // clean `parked` — self-confirmed by the very field that made it
            // look freed, and erasing the `partial` an operator needs to see.
            !record.slotReboundAt &&
            stopped
          ) {
            phase = 'parked';
          } else if (
            run.status === record.prePauseStatus &&
            record.phase === 'orchestration-resuming'
          ) {
            phase = 'restored';
          }
          await this.patchRecord(run.id, (current) => ({
            ...current,
            phase,
            residuals,
            ...(phase === 'parked' ? { parkedAt: current.parkedAt ?? this.deps.now() } : {}),
            ...(phase === 'restored' ? { restoredAt: current.restoredAt ?? this.deps.now() } : {}),
            ...(phase === 'cancelled'
              ? { cancelledAt: current.cancelledAt ?? this.deps.now() }
              : {}),
          }));
          reconciled += 1;
          if (phase === 'partial') partial += 1;
        }
      });
    }
    return { reconciled, partial };
  }

  async prepareRunCancel(runId: string): Promise<boolean> {
    const run = this.deps.getRun(runId);
    if (!run?.park) return false;
    const residuals = await this.observeResiduals(run, run.park);
    await this.patchRecord(runId, (record) => ({
      ...record,
      phase: 'cancelling',
      residuals,
    }));
    return true;
  }

  async finalizeRunCancel(
    runId: string,
    effects: readonly MachineParkingCancelEffect[],
  ): Promise<void> {
    const run = this.deps.getRun(runId);
    if (!run?.park) return;
    const failures = effects.filter((effect) => effect.status === 'failed');
    if (failures.length === 0) {
      const cleared = this.deps.updatePark(runId, null);
      await this.deps.persistRun(cleared, 'machine-pause-cancel-cleared');
      await this.deps.emit(Events.RUN_UPDATED, { run: cleared });
      return;
    }
    const residuals = await this.observeResiduals(run, run.park);
    const occurredAt = this.deps.now();
    await this.patchRecord(runId, (record) => ({
      ...record,
      phase: 'cancelled',
      cancelledAt: record.cancelledAt ?? occurredAt,
      residuals,
      errors: [
        ...record.errors,
        ...failures.map(
          (effect): MachineParkError => ({
            phase: 'cancelled',
            action: `cancel.${effect.name}`,
            code: 'TERMINAL_CLEANUP_FAILED',
            message: effect.detail ?? `${effect.name} failed`,
            occurredAt,
            retryable: true,
          }),
        ),
      ],
    }));
  }

  private async buildPausePreview(
    params: MachinePausePreviewParams,
  ): Promise<MachinePausePreviewResult> {
    const fleet = await this.deps.loadFleet();
    assertKnownMachine(params.machine, fleet);
    const selected = selectPauseRuns(this.deps.allRuns(), fleet, params.machine, params.selector);
    const runs = await Promise.all(
      selected.map((run) =>
        this.previewPauseRun(
          run,
          params.machine,
          params.mode,
          fleet,
          selectedBySelector(run.id, params.selector),
        ),
      ),
    );
    const createdAt = this.deps.now();
    const previewId = digestPreview('pause', {
      machine: params.machine,
      mode: params.mode,
      selector: params.selector,
      runs: runs.filter((run) => run.selected),
    });
    return {
      previewId,
      machine: params.machine,
      mode: params.mode,
      selector: structuredClone(params.selector),
      createdAt,
      runs,
      eligibleCount: runs.filter((run) => run.selected && run.eligibility.eligible).length,
      rejectedCount: runs.filter((run) => run.selected && !run.eligibility.eligible).length,
      ...(await this.optionalPressure(params.machine)),
    };
  }

  private async previewPauseRun(
    run: Run,
    machine: string,
    mode: MachinePauseMode,
    fleet: Fleet,
    selected: boolean,
  ): Promise<MachinePausePreviewRun> {
    const generation = run.engineState?.generation ?? 0;
    const currentStep = currentRunStep(run);
    const emptyManifest = (): MachineParkResourceManifest => ({
      capturedAt: this.deps.now(),
      resources: [],
      capabilityLeases: [],
    });
    // ADR-038 amendment (ADR-054 `free-slot`): a publication gate is a durable
    // operator wait, so it is a third parkable shape beside monitor and
    // ci-watch. It is the only shape that frees the slot: monitor/ci-watch
    // parks keep the slot bound because their restore reclaims it in place.
    const gateHeld =
      isGateHeldPublicationRun(run) && currentStep?.name === PipelineSteps.HUMAN_GATE;
    const slotDisposition: MachineParkSlotDisposition =
      mode === 'release' && gateHeld ? 'freed' : 'retained';
    const base = {
      runId: run.id,
      generation,
      selected,
      slotId: run.slotId,
      status: run.status,
      currentStep,
      slotDisposition,
    };
    const reject = (
      code: string,
      reason: string,
      resourceManifest = emptyManifest(),
      runnerId = run.metrics.runner?.trim() || 'unknown',
    ): MachinePausePreviewRun => ({
      ...base,
      eligibility: { eligible: false, code, reason },
      recoveryPolicy:
        mode === 'orchestration'
          ? { kind: 'orchestration-only', supported: true }
          : { kind: 'runner-session-reload', supported: false, runnerId, reason },
      resourceManifest,
    });
    if (run.park && !settledPhase(run.park.phase)) {
      return reject('ALREADY_PARKED', `run already has park phase '${run.park.phase}'`);
    }
    if (!run.slotId) return reject('SLOT_REQUIRED', 'run has no assigned slot');
    const slot = fleet.slots.find((candidate) => candidate.slot === run.slotId);
    if (!slot || slot.machine !== machine) {
      return reject('MACHINE_MISMATCH', `run slot is not owned by machine '${machine}'`);
    }
    if (!gateHeld) {
      if (run.status !== 'monitoring' && run.status !== 'ci-watching') {
        return reject(
          'STATUS_NOT_ELIGIBLE',
          `status '${run.status}' is not monitoring or ci-watching`,
        );
      }
      if (!currentStep || (currentStep.name !== 'monitor' && currentStep.name !== 'ci-watch')) {
        return reject('STEP_NOT_IDEMPOTENT', 'run has no active monitor or ci-watch step');
      }
    }
    if (mode === 'orchestration') {
      if (gateHeld) {
        // An orchestration pause would move the run off its gate without
        // freeing anything, stranding the operator decision it is waiting on.
        return reject(
          MachineParkEligibilityCodes.gateParkRequiresRelease,
          "a gate-held run can only be parked in 'release' mode",
        );
      }
      return {
        ...base,
        eligibility: {
          eligible: true,
          code: 'ELIGIBLE_ORCHESTRATION_PAUSE',
          reason: 'The run is in an idempotent monitoring phase; worker and resources stay live.',
        },
        recoveryPolicy: { kind: 'orchestration-only', supported: true },
        resourceManifest: emptyManifest(),
      };
    }
    if (gateHeld) {
      // Fail closed before anything else touches the slot: stopping a gate-held
      // worker is only safe when the runner itself declares a graceful stop and
      // a persisted session reload to bring it back.
      let reload: RunnerReloadInspection;
      try {
        reload = await this.deps.inspectRunnerReload(run);
      } catch (error) {
        return reject(
          MachineParkEligibilityCodes.runnerReloadUnsupported,
          `runner reload capability could not be inspected: ${messageOf(error)}`,
        );
      }
      if (!reload.supported) {
        return reject(
          MachineParkEligibilityCodes.runnerReloadUnsupported,
          reload.reason ?? `runner '${reload.runnerId}' cannot reload a persisted session`,
          emptyManifest(),
          reload.runnerId,
        );
      }
      // Freeing the slot hands this working tree to the next occupant, whose
      // prepare resets the checked-out branch to its base ref. Refuse unless
      // the branch can be taken out of the tree first with nothing lost.
      let workspace: ParkWorkspaceInspection;
      try {
        workspace = await this.deps.inspectParkWorkspace(run);
      } catch (error) {
        return reject(
          MachineParkEligibilityCodes.workspaceNotPreservable,
          `slot workspace could not be inspected: ${messageOf(error)}`,
        );
      }
      if (workspace.dirtyPaths.length > 0) {
        return reject(
          MachineParkEligibilityCodes.workspaceNotPreservable,
          `slot workspace has uncommitted changes that freeing the slot would discard: ${workspace.dirtyPaths
            .slice(0, 10)
            .join(', ')}`,
        );
      }
      if (!workspace.headSha) {
        return reject(
          MachineParkEligibilityCodes.workspaceNotPreservable,
          'slot workspace reports no HEAD commit to preserve',
        );
      }
      if (workspace.branch) {
        this.parkWorkspaces.set(recoveryHandleKey(run.id, generation), {
          branch: workspace.branch,
          headSha: workspace.headSha,
        });
        while (this.parkWorkspaces.size > 512) {
          this.parkWorkspaces.delete(this.parkWorkspaces.keys().next().value!);
        }
      } else {
        this.parkWorkspaces.delete(recoveryHandleKey(run.id, generation));
      }
    }
    if (slot.currentRunId !== run.id) {
      return reject(
        'SLOT_OWNERSHIP_CHANGED',
        `slot '${run.slotId}' is owned by '${slot.currentRunId ?? 'no run'}'`,
      );
    }

    let handle: MachinePauseRecoveryHandle;
    try {
      handle = await this.deps.resolveRecoveryHandle(run);
      this.recoveryHandles.set(recoveryHandleKey(run.id, generation), structuredClone(handle));
      while (this.recoveryHandles.size > 512) {
        this.recoveryHandles.delete(this.recoveryHandles.keys().next().value!);
      }
    } catch (error) {
      return reject(
        'RUNNER_RECOVERY_UNSUPPORTED',
        error instanceof Error ? error.message : String(error),
      );
    }
    let resources: SlotResource[];
    let capabilityStatus: RuntimeCapabilityStatusResult;
    try {
      [resources, capabilityStatus] = await Promise.all([
        this.deps.observeResources(run.slotId),
        this.deps.capabilityStatus(run.slotId),
      ]);
    } catch (error) {
      return reject(
        'MANIFEST_CAPTURE_FAILED',
        error instanceof Error ? error.message : String(error),
        emptyManifest(),
        handle.runnerId,
      );
    }
    const runningResources = resources.filter((resource) => resource.status === 'running');
    // Ordered before the hooks guard. Which hooks a resource needs depends on
    // what its claimants say happens to it, so a catalog that contradicts
    // itself would otherwise surface as a hooks complaint and send the operator
    // after the wrong bug. Name the contradiction they can actually fix.
    const conflicted = runningResources
      .map((resource) => ({
        resource,
        claims: capabilityClaimsForResource(capabilityStatus, resource.id),
      }))
      .find(
        ({ claims }) => new Set([...claims.values()].map((claim) => claim.releaseEffect)).size > 1,
      );
    if (conflicted) {
      return reject(
        'CAPABILITY_CLAIM_CONFLICT',
        `resource '${conflicted.resource.id}' has conflicting release effects from ${[
          ...conflicted.claims.entries(),
        ]
          .map(([providerId, claim]) => `${providerId}=${claim.releaseEffect}`)
          .sort()
          .join(', ')}`,
        emptyManifest(),
        handle.runnerId,
      );
    }
    // A resource every claimant declares `retain` is never stopped by the park
    // and never booted by the restore, so demanding boot and shutdown hooks for
    // it refuses slots for capabilities it does not use — a physically attached
    // device has no boot hook and never will. What restore does need is a way
    // to prove it stayed up. Resource polling reports a resource with no health
    // hook as `unknown` whatever its watch config says, so a health hook is the
    // only signal that can carry that proof. Derived claims are always `stop`,
    // so this only ever admits an explicit declaration.
    const parkRetains = (resource: SlotResource): boolean => {
      const claims = capabilityClaimsForResource(capabilityStatus, resource.id);
      return (
        claims.size > 0 && [...claims.values()].every((claim) => claim.releaseEffect === 'retain')
      );
    };
    const controllableForPark = (resource: SlotResource): boolean =>
      parkRetains(resource)
        ? Boolean(resource.definition.hooks?.health)
        : Boolean(resource.definition.hooks?.shutdown && resource.definition.hooks?.boot);
    const unsafe = runningResources.find(
      (resource) => resource.definition.controllable && !controllableForPark(resource),
    );
    if (unsafe) {
      return reject(
        'RESOURCE_HOOKS_UNAVAILABLE',
        parkRetains(unsafe)
          ? `retained resource '${unsafe.id}' has no project-owned health hook to prove it stayed running`
          : `running resource '${unsafe.id}' lacks project-owned shutdown and boot hooks`,
        emptyManifest(),
        handle.runnerId,
      );
    }
    const affected = runningResources.filter(
      (resource) => resource.definition.controllable && controllableForPark(resource),
    );
    const proofPlan = capabilityStatus.proofPlans[run.id];
    const activeLeases = capabilityStatus.leases.filter(
      (lease) => lease.owner.runId === run.id && lease.state === 'acquired',
    );
    for (const lease of capabilityStatus.leases.filter(capabilityLeaseBlocksStop)) {
      const provider = capabilityStatus.catalog.find((entry) => entry.id === lease.capabilityId);
      const hasSlotAction = provider
        ? Object.values(provider.actions).some((action) => action.kind === 'slot-action')
        : false;
      const selectedLifecycleSlotAction =
        lease.owner.runId === run.id &&
        (provider?.actions.acquire.kind === 'slot-action' ||
          provider?.actions.release.kind === 'slot-action');
      // A provider that declares its affected resources has told us exactly
      // what a slot action touches, so there is nothing left to refuse for.
      // Absent metadata is still unproven and still refuses, so every catalog
      // that has not been annotated behaves exactly as it did before.
      const declaresAffectedResources = provider?.affectedResources !== undefined;
      const mapped = affected.some((resource) =>
        capabilityProvidersForResource(capabilityStatus, resource.id).has(lease.capabilityId),
      );
      if (selectedLifecycleSlotAction && !declaresAffectedResources) {
        return reject(
          'CAPABILITY_SLOT_ACTION_UNMAPPED',
          `selected capability '${lease.capabilityId}' uses slot-action acquire/release without explicit affected-resource metadata`,
          emptyManifest(),
          handle.runnerId,
        );
      }
      if (hasSlotAction && !declaresAffectedResources && !mapped) {
        return reject(
          'CAPABILITY_SLOT_ACTION_UNMAPPED',
          `active capability '${lease.capabilityId}' uses slot actions without a proven managed resource`,
          emptyManifest(),
          handle.runnerId,
        );
      }
    }
    for (const resource of affected) {
      const claims = capabilityClaimsForResource(capabilityStatus, resource.id);
      const providerIds = new Set(claims.keys());
      // Ownership is per claimant, never pooled. Each provider that claims to
      // own this resource must itself be leased by this run; a lease on some
      // OTHER claimant — a slot-lifecycle one especially — proves nothing about
      // the owner and must not stand in for it.
      const unowned = [...claims.entries()].filter(
        ([providerId, claim]) =>
          claim.ownership === 'capability' &&
          !activeLeases.some((lease) => lease.capabilityId === providerId),
      );
      if (unowned.length > 0) {
        return reject(
          'CAPABILITY_RESOURCE_UNOWNED',
          `resource '${resource.id}' is capability-backed but not leased by run '${run.id}': ${unowned
            .map(([providerId]) => providerId)
            .sort()
            .join(', ')}`,
          emptyManifest(),
          handle.runnerId,
        );
      }
      const foreignHolders = capabilityStatus.leases.filter(
        (lease) =>
          providerIds.has(lease.capabilityId) &&
          lease.owner.runId !== run.id &&
          capabilityLeaseBlocksStop(lease),
      );
      if (foreignHolders.length > 0) {
        return reject(
          'CAPABILITY_FOREIGN_HOLDER',
          `resource '${resource.id}' is held by ${foreignHolders
            .map((lease) => `${lease.owner.runId}/${lease.capabilityId}`)
            .join(', ')}`,
          emptyManifest(),
          handle.runnerId,
        );
      }
    }
    const capabilityLeases: MachineParkCapabilityLease[] = [];
    for (const lease of activeLeases) {
      const proofRequirement = proofPlan?.requirements.find(
        (requirement) => requirement.capabilityId === lease.capabilityId,
      );
      if (!proofRequirement) {
        return reject(
          'CAPABILITY_PROOF_MISSING',
          `capability '${lease.capabilityId}' has no durable proof requirement`,
          emptyManifest(),
          handle.runnerId,
        );
      }
      const resourceId = affected
        .map((resource) => resource.id)
        .find((id) => capabilityProvidersForResource(capabilityStatus, id).has(lease.capabilityId));
      capabilityLeases.push({
        leaseId: lease.id,
        capabilityId: lease.capabilityId,
        state: 'held',
        parameters: structuredClone(lease.parameters),
        proofRequirement: structuredClone(proofRequirement),
        ...(lease.owner.familyId ? { ownerFamilyId: lease.owner.familyId } : {}),
        ...(resourceId ? { resourceId } : {}),
      });
    }
    const manifest: MachineParkResourceManifest = {
      capturedAt: this.deps.now(),
      resources: affected.map((resource) => ({
        resourceId: resource.id,
        label: resource.definition.label,
        type: resource.definition.type,
        observedStatus: 'running',
        phase: 'observed-running',
        releaseEffect: resourceReleaseEffect(
          capabilityClaimsForResource(capabilityStatus, resource.id),
        ),
        capabilityLeaseIds: capabilityLeases
          .filter((lease) => lease.resourceId === resource.id)
          .map((lease) => lease.leaseId),
      })),
      capabilityLeases,
    };
    return {
      ...base,
      eligibility: {
        eligible: true,
        code: gateHeld ? MachineParkEligibilityCodes.eligibleGateRelease : 'ELIGIBLE_RELEASE_PAUSE',
        reason: gateHeld
          ? 'The gate-held run has an exact reload handle; parking frees its slot and keeps the gate answerable.'
          : 'The run has an exact reload handle and a restorable observed-running manifest.',
      },
      recoveryPolicy: {
        kind: 'runner-session-reload',
        supported: true,
        runnerId: handle.runnerId,
      },
      resourceManifest: manifest,
    };
  }

  private async persistPauseIntents(
    preview: MachinePausePreviewResult,
    operationId: string,
  ): Promise<{ records: MachineParkRecord[]; durable: boolean }> {
    const now = this.deps.now();
    const records = preview.runs
      .filter((item) => item.selected)
      .map((item) => {
        const run = this.requireRun(item.runId);
        const handle =
          preview.mode === 'release'
            ? Promise.resolve(
                this.recoveryHandles.get(recoveryHandleKey(run.id, item.generation)) ?? null,
              )
            : Promise.resolve(null);
        return { item, run, handle };
      });
    // Resolve every recovery input before the first in-memory or durable park write. A handle
    // drifting after preview rejects the entire batch without leaving a half-created record.
    const preflight = await Promise.all(
      records.map(async ({ item, run, handle }) => {
        const recoveryHandle = await handle;
        if (preview.mode === 'release') {
          if (!recoveryHandle) throw new Error(`run ${run.id} has no fresh recovery handle`);
          await this.deps.inspectRecoveryHandle(run, recoveryHandle, 'live');
        }
        return { item, run, recoveryHandle };
      }),
    );
    const fleet = await this.deps.loadFleet();
    for (const { item, run } of preflight) {
      const current = this.requireRun(run.id);
      const slot = fleet.slots.find((candidate) => candidate.slot === item.slotId);
      if (
        current.status !== item.status ||
        (current.engineState?.generation ?? 0) !== item.generation ||
        current.slotId !== item.slotId ||
        Boolean(current.park && !settledPhase(current.park.phase)) ||
        !slot ||
        slot.machine !== preview.machine ||
        (preview.mode === 'release' && slot.currentRunId !== run.id)
      ) {
        throw new Error(`run ${run.id} changed during final preflight; preview the batch again`);
      }
    }
    const nextRecords = preflight.map(({ item, run, recoveryHandle }) => {
      const record: MachineParkRecord = {
        version: 1,
        operationId,
        previewId: preview.previewId,
        runId: run.id,
        generation: item.generation,
        machine: preview.machine,
        slotId: run.slotId!,
        mode: preview.mode,
        phase: 'intent-persisted',
        slotDisposition: item.slotDisposition,
        ...(item.slotDisposition === 'freed'
          ? (() => {
              const workspace = this.parkWorkspaces.get(recoveryHandleKey(run.id, item.generation));
              return workspace ? { preservedWorkspace: structuredClone(workspace) } : {};
            })()
          : {}),
        prePauseStatus: run.status,
        prePauseCurrentStep: item.currentStep,
        resourceManifest: structuredClone(item.resourceManifest),
        recoveryHandle,
        errors: [],
        residuals: {
          runner: 'running',
          resources: item.resourceManifest.resources.map((resource) => ({
            resourceId: resource.resourceId,
            state: 'running',
          })),
        },
        createdAt: now,
        updatedAt: now,
      };
      return { run, record };
    });
    try {
      await this.deps.writeIntentJournal(
        'pause',
        nextRecords.map(({ record }) => record),
      );
    } catch (error) {
      return {
        records: intentFailureRecords(
          nextRecords.map(({ record }) => record),
          error,
          this.deps.now(),
        ),
        durable: false,
      };
    }
    const resolved = nextRecords.map(({ run, record }) => this.deps.updatePark(run.id, record));
    const durable = await this.settleIntentDurability(resolved, 'pause', 'machine-pause-intent');
    for (const run of resolved) await this.emitRecord(run.park!);
    for (const { item } of preflight) {
      this.recoveryHandles.delete(recoveryHandleKey(item.runId, item.generation));
      this.parkWorkspaces.delete(recoveryHandleKey(item.runId, item.generation));
    }
    return { records: resolved.map((run) => structuredClone(run.park!)), durable };
  }

  private async parkOne(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    const record = run.park!;
    try {
      await this.patchRecord(runId, (current) => ({ ...current, phase: 'orchestration-pausing' }));
      await this.withQueuedEmit((emit) => this.deps.pauseRun(runId, emit));
      await this.patchRecord(runId, (current) => ({
        ...current,
        phase: 'orchestration-paused',
      }));
    } catch (error) {
      await this.failRecord(runId, 'orchestration-pausing', 'run.pause', error);
      return;
    }
    if (record.mode === 'orchestration') {
      const latest = this.requireRun(runId);
      const residuals = await this.observeResiduals(latest, latest.park!);
      await this.patchRecord(runId, (current) => ({
        ...current,
        phase: 'parked',
        residuals,
        parkedAt: this.deps.now(),
      }));
      return;
    }
    const handle = record.recoveryHandle!;
    try {
      await this.patchRecord(runId, (current) => ({ ...current, phase: 'runner-stopping' }));
      await this.deps.stopRunner(this.requireRun(runId), handle);
      await this.patchRecord(runId, (current) => ({ ...current, phase: 'runner-stopped' }));
    } catch (error) {
      await this.failRecord(runId, 'runner-stopping', 'runner.stop', error);
      return;
    }
    await this.patchRecord(runId, (current) => ({ ...current, phase: 'resources-stopping' }));
    let failed = false;
    const beforeCapabilityStatus =
      record.resourceManifest.capabilityLeases.length > 0
        ? await this.deps.capabilityStatus(record.slotId)
        : null;
    for (const lease of record.resourceManifest.capabilityLeases) {
      const currentLease = beforeCapabilityStatus?.leases.find(
        (candidate) => candidate.id === lease.leaseId,
      );
      if (currentLease?.state === 'released') {
        await this.patchCapability(runId, lease.leaseId, {
          state: 'released',
          error: undefined,
        });
        continue;
      }
      await this.patchCapability(runId, lease.leaseId, { state: 'releasing', error: undefined });
      try {
        const result = await this.deps.releaseCapability({
          slotId: record.slotId,
          runId,
          leaseId: lease.leaseId,
          capabilityId: lease.capabilityId,
        });
        const failure = result.failures.find((item) => item.leaseId === lease.leaseId);
        if (!result.ok || failure) throw new Error(failure?.reason ?? 'capability release failed');
        if (result.retained.some((item) => item.id === lease.leaseId)) {
          await this.patchCapability(runId, lease.leaseId, {
            state: 'held',
            error: 'capability registry retained this lease',
          });
          continue;
        }
        const released = result.released.some((item) => item.id === lease.leaseId);
        if (!released) {
          throw new Error('capability registry did not release or retain the exact lease');
        }
        await this.patchCapability(runId, lease.leaseId, {
          state: 'released',
          error: undefined,
        });
      } catch (error) {
        failed = true;
        await this.patchCapability(runId, lease.leaseId, {
          state: 'failed',
          error: messageOf(error),
        });
        await this.appendError(runId, 'resources-stopping', 'capability.release', error);
      }
    }
    for (const resource of record.resourceManifest.resources) {
      if (resource.capabilityLeaseIds.length > 0) continue;
      // A retained resource is one the catalog says nothing in this release
      // stops. Parking must not stop it either, or it would take down a
      // lifecycle it does not own (the sandbox gateway UI, for one).
      if (resource.releaseEffect === 'retain') continue;
      await this.patchResource(runId, resource.resourceId, { phase: 'stopping', error: undefined });
      try {
        const result = await this.deps.stopResource(record.slotId, resource.resourceId);
        if (!result.ok) throw new Error(result.detail ?? 'resource shutdown failed');
        await this.patchResource(runId, resource.resourceId, {
          phase: 'stopped',
          stoppedAt: this.deps.now(),
          error: undefined,
        });
      } catch (error) {
        failed = true;
        await this.patchResource(runId, resource.resourceId, {
          phase: 'failed',
          error: messageOf(error),
        });
        await this.appendError(
          runId,
          'resources-stopping',
          'resource.shutdown',
          error,
          resource.resourceId,
        );
      }
    }
    if (record.resourceManifest.capabilityLeases.length > 0) {
      const finalCapabilityStatus = await this.deps.capabilityStatus(record.slotId);
      for (const lease of record.resourceManifest.capabilityLeases) {
        const state = finalCapabilityStatus.leases.find(
          (candidate) => candidate.id === lease.leaseId,
        )?.state;
        if (state === 'released') {
          await this.patchCapability(runId, lease.leaseId, {
            state: 'released',
            error: undefined,
          });
          continue;
        }
        failed = true;
        await this.patchCapability(runId, lease.leaseId, {
          state: 'failed',
          error: `capability lease remained '${state ?? 'missing'}' after release`,
        });
        await this.appendError(
          runId,
          'resources-stopping',
          'capability.release-retained',
          new Error(`capability lease '${lease.leaseId}' remained '${state ?? 'missing'}'`),
        );
      }
    }
    const latest = this.requireRun(runId);
    const residuals = await this.observeResiduals(latest, latest.park!);
    if (residuals.runner !== 'stopped') {
      failed = true;
      await this.appendError(
        runId,
        'runner-stopping',
        'runner.residual',
        new Error(`runner remained '${residuals.runner}' after release pause`),
      );
    }
    for (const resource of record.resourceManifest.resources) {
      const residual = residuals.resources.find(
        (candidate) => candidate.resourceId === resource.resourceId,
      );
      const expected = expectedResidualState(resource);
      if (residual?.state === expected) {
        await this.patchResource(runId, resource.resourceId, {
          // A retained resource was never stopped, so it carries no stoppedAt;
          // its settled phase records that park verified it still running.
          ...(expected === 'stopped'
            ? { phase: 'stopped' as const, stoppedAt: this.deps.now() }
            : { phase: 'retained' as const }),
          error: undefined,
        });
        continue;
      }
      failed = true;
      await this.appendError(
        runId,
        'resources-stopping',
        'resource.residual',
        new Error(
          `resource '${resource.resourceId}' is '${residual?.state ?? 'missing'}'; expected '${expected}'`,
        ),
        resource.resourceId,
      );
    }
    await this.patchRecord(runId, (current) => ({
      ...current,
      phase: failed ? 'partial' : 'parked',
      residuals,
      parkedAt: this.deps.now(),
    }));
    // Ordered last and gated on a clean park: freeing the slot publishes it for
    // dispatch, so a run whose runner or resources are still up must keep it.
    if (!failed && record.slotDisposition === 'freed') await this.freeParkedSlot(runId, record);
  }

  /**
   * Hand the slot to dispatch: take the parked branch out of the working tree,
   * then release slot ownership. The park record survives and keeps `slotId`.
   *
   * Both steps are journalled as one `free-slot` intent. The detach, the
   * ownership release, and the `slotFreedAt` write are separate durable writes,
   * and a crash between them leaves a `parked` record that recovery would
   * otherwise read as a park that never freed anything — while the fleet had
   * already handed the slot out. The journal is the write-ahead marker that
   * lets `reconcile` finish exactly this window.
   */
  private async freeParkedSlot(runId: string, record: MachineParkRecord): Promise<void> {
    try {
      // Scoped to THIS run. A batch shares one `operationId`, so an unscoped
      // free-slot journal would be overwritten by the next member's write and
      // then deleted by the first member that succeeded — taking a failed
      // sibling's still-pending repair with it.
      await this.deps.writeIntentJournal('free-slot', [structuredClone(record)], runId);
    } catch (error) {
      await this.appendError(runId, 'parked', 'slot.free-journal', error);
      await this.patchRecord(runId, (current) => ({ ...current, phase: 'partial' }));
      return;
    }
    const completed = await this.completeSlotFree(runId, record);
    if (!completed) return;
    await this.deps
      .deleteIntentJournal(record.machine, 'free-slot', record.operationId, runId)
      .catch((error: unknown) => {
        // The free landed and is durable on the record; a stale journal only
        // makes the next reconcile re-prove an already-finished transition.
        console.warn(
          `[machine-pause] could not delete free-slot journal for ${runId}: ${messageOf(error)}`,
        );
      });
  }

  /**
   * Detach the branch, release ownership, and record `slotFreedAt`. Idempotent,
   * so recovery can re-drive it from the journal after a crash at any point.
   * Returns false when the transition did not complete and the record was
   * marked partial.
   */
  private async completeSlotFree(
    runId: string,
    record: MachineParkRecord,
    options: { recovering?: boolean } = {},
  ): Promise<boolean> {
    const run = this.requireRun(runId);
    // Same guard the repair path carries. A cancel racing this park terminalizes
    // the run and runs its own slot cleanup; detaching and releasing underneath
    // that would have two owners mutating one slot. The park stops, and cancel's
    // cleanup is the single writer.
    if (isTerminalRunStatus(run.status)) {
      await this.appendError(
        runId,
        'parked',
        'slot.free',
        new Error(`run '${runId}' became '${run.status}' before its slot could be freed`),
      );
      await this.patchRecord(runId, (current) => ({ ...current, phase: 'partial' }));
      return false;
    }
    if (record.preservedWorkspace && !record.preservedWorkspace.detachedAt) {
      try {
        await this.deps.detachParkedWorkspace(run, record.preservedWorkspace);
      } catch (error) {
        // Fail closed BEFORE the release: leaving the branch checked out in a
        // slot dispatch can claim is how the next prepare discards its commits.
        await this.appendError(runId, 'parked', 'workspace.detach', error);
        await this.patchRecord(runId, (current) => ({ ...current, phase: 'partial' }));
        return false;
      }
      // Records the FACT. Recovery re-driving this transition skips a detach
      // that already landed, and the zero-effect guard reads it as a real
      // effect that must not be discarded.
      await this.patchRecord(runId, (current) => ({
        ...current,
        preservedWorkspace: current.preservedWorkspace
          ? { ...current.preservedWorkspace, detachedAt: this.deps.now() }
          : current.preservedWorkspace,
      }));
    }
    if (await this.deps.freeSlotOwnership(record.slotId, runId)) {
      await this.patchRecord(runId, (current) => ({
        ...current,
        slotFreedAt: current.slotFreedAt ?? this.deps.now(),
      }));
      return true;
    }
    // On the live path a refused CAS means a rival claimed or fenced the slot
    // while this park was running — an anomaly, recorded as partial below.
    //
    // Re-driving from the journal is the opposite: the record exists precisely
    // because a crash interrupted this transition, so a slot that is no longer
    // ours can be the trace of a release that DID land before the crash.
    // Leaving it unfreed there is the bug this journal exists to prevent: fleet
    // refresh would re-bind the slot to this run under whoever dispatch already
    // gave it to.
    //
    // But "not owned by us" is NOT by itself proof the release landed. A row
    // fenced mid-teardown, or one carrying a foreign handoff reservation, also
    // refuses the CAS while still holding this run's slot. Concluding "freed"
    // there would publish a fact that never happened. So the row itself has to
    // show a completed release: nobody owns it and it is back to ready, or a
    // rival already owns it.
    if (options.recovering && (await this.slotReleaseLanded(record.slotId, runId))) {
      await this.patchRecord(runId, (current) => ({
        ...current,
        slotFreedAt: current.slotFreedAt ?? this.deps.now(),
      }));
      return true;
    }
    await this.appendError(
      runId,
      'parked',
      'slot.free',
      new Error(`slot '${record.slotId}' ownership could not be released for run '${runId}'`),
    );
    // The detach is this park's only landed effect now, and the park is not
    // going to finish. Putting the branch back leaves the run exactly as the
    // park found it, so restore has an unambiguous starting point.
    await this.rollBackDetachedWorkspace(runId);
    // Abandon the write-ahead intent BEFORE the record settles. The journal
    // exists to finish a transition a crash interrupted; this transition was
    // not interrupted, it was refused and undone. Leaving the marker behind
    // means the next reconcile re-drives it and frees the slot of a run that
    // has since been restored and resumed.
    await this.abandonFreeSlotIntent(runId, record);
    await this.patchRecord(runId, (current) => ({ ...current, phase: 'partial' }));
    return false;
  }

  /**
   * Drop the `free-slot` write-ahead marker for a transition that will not be
   * finished. Failing to delete it is itself recorded: a stale marker is the
   * one thing that can still free this slot behind the operator's back, so it
   * must not pass silently.
   */
  private async abandonFreeSlotIntent(runId: string, record: MachineParkRecord): Promise<void> {
    try {
      await this.deps.deleteIntentJournal(record.machine, 'free-slot', record.operationId, runId);
    } catch (error) {
      await this.appendError(runId, 'parked', 'slot.free-journal-abandon', error);
    }
  }

  /**
   * Whether the slot row proves this run's ownership release actually landed.
   * A refused CAS alone does not: a releasing fence or a foreign handoff
   * reservation refuses it too while the run still holds the slot.
   */
  private async slotReleaseLanded(slotId: string, runId: string): Promise<boolean> {
    const row = await this.deps.slotRow(slotId);
    // No row at all means the slot left the pool; there is nothing left bound
    // to this run, and claiming otherwise would strand the record forever.
    if (!row) return true;
    const owner = typeof row.current_run_id === 'string' ? row.current_run_id : null;
    if (owner === runId) return false;
    if (owner) return true;
    return row.lifecycle === 'ready';
  }

  /**
   * Whether the ORIGINAL slot can take its parked run back right now.
   *
   * ADR-054 restores into the original slot only, so this is the whole
   * question. It is deliberately read-only and deliberately strict: an owner
   * that is not us, a row mid-release, and a foreign warm-handoff reservation
   * each mean the slot belongs to someone else's transition, and taking it
   * would put two runs on one slot. An owner that IS us is accepted so a
   * re-driven restore, after a crash between the claim and the record write,
   * finishes instead of refusing its own landed claim.
   */
  private async slotAcceptsRestore(
    slotId: string,
    runId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const row = await this.deps.slotRow(slotId);
    if (!row) return { ok: false, reason: `slot '${slotId}' has no status row to restore into` };
    const owner =
      typeof row.current_run_id === 'string' && row.current_run_id ? row.current_run_id : null;
    if (owner && owner !== runId) {
      return { ok: false, reason: `slot '${slotId}' is now owned by run '${owner}'` };
    }
    if (row.phase === SLOT_PHASE_RELEASING) {
      return { ok: false, reason: `slot '${slotId}' is mid-release` };
    }
    const handoff = typeof row.handoff_run_id === 'string' ? row.handoff_run_id : '';
    if (handoff && handoff !== runId) {
      return {
        ok: false,
        reason: `slot '${slotId}' is reserved for a warm handoff to run '${handoff}'`,
      };
    }
    if (!owner && row.lifecycle !== 'ready') {
      return {
        ok: false,
        reason: `slot '${slotId}' is '${String(row.lifecycle ?? 'unknown')}', not ready`,
      };
    }
    return { ok: true };
  }

  /**
   * Whether the preserved branch can be checked back out.
   *
   * Two ways a successor can make that impossible, and both must refuse rather
   * than guess: uncommitted work in the tree (a checkout would carry someone
   * else's changes onto the parked branch), and a branch ref that no longer
   * sits at the tip the park detached from (the commits the operator is about
   * to publish are not the ones that would come back).
   */
  private async inspectRestoreWorkspace(
    run: Run,
    workspace: MachineParkWorkspace,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    let current: ParkWorkspaceInspection;
    try {
      current = await this.deps.inspectParkWorkspace(run);
    } catch (error) {
      return { ok: false, reason: messageOf(error) };
    }
    if (current.dirtyPaths.length > 0) {
      return {
        ok: false,
        reason: `the slot working tree has uncommitted changes (${current.dirtyPaths
          .slice(0, 10)
          .join(', ')}); checking '${workspace.branch}' out would carry them onto it`,
      };
    }
    let tip: string | null;
    try {
      tip = await this.deps.preservedBranchTip(run, workspace);
    } catch (error) {
      return { ok: false, reason: messageOf(error) };
    }
    if (tip !== workspace.headSha) {
      return {
        ok: false,
        reason: `branch '${workspace.branch}' is at ${tip ?? 'no ref'}, not the tip ${workspace.headSha} the park detached from`,
      };
    }
    return { ok: true };
  }

  /**
   * Take the freed slot back for its parked run: re-bind ownership, then put
   * the preserved branch back in the working tree.
   *
   * The mirror of `freeParkedSlot`, journalled for the mirror-image reason. The
   * slot claim and the write that clears `slotFreedAt` are two writes, and a
   * crash between them leaves a row bound to a run every other reader still
   * treats as freed — so fleet refresh would not republish it and dispatch
   * would keep offering a slot this run is sitting in. The `restore-slot`
   * journal is the write-ahead marker that finishes exactly that window.
   *
   * Throws on refusal; the caller settles the record. Nothing here is reached
   * until the preview and the in-transition preflight both proved the slot
   * free, so a throw means the state changed underneath a checked precondition.
   */
  private async reclaimFreedSlot(
    runId: string,
    record: MachineParkRecord,
    operationId: string,
  ): Promise<void> {
    const availability = await this.slotAcceptsRestore(record.slotId, runId);
    if (!availability.ok) throw new Error(availability.reason);
    // Scoped to THIS run, like the free it undoes: a batch shares one
    // operationId, and an unscoped marker would be overwritten by the next
    // member and then deleted by the first that succeeded.
    //
    // Written here and deleted only when the LAST stage lands. Deleting it once
    // the slot was re-bound is what let a crash before the checkout drop the
    // marker while the branch was still detached — recovery then had nothing to
    // finish from.
    // A retry writes its marker under a new operation id, so the previous
    // attempt's marker would be orphaned on disk — pointing at a transition
    // this one has taken over. `restoreProgress` names exactly the attempt that
    // owns the outgoing marker, so it is dropped rather than left for a later
    // reconcile to puzzle over.
    const superseded = record.restoreProgress?.operationId;
    if (superseded && superseded !== record.operationId) {
      await this.deps
        .deleteIntentJournal(record.machine, 'restore-slot', superseded, runId)
        .catch((error: unknown) => {
          console.warn(
            `[machine-pause] could not drop superseded restore-slot journal for ${runId}: ${messageOf(error)}`,
          );
        });
    }
    await this.deps.writeIntentJournal('restore-slot', [structuredClone(record)], runId);
    await this.rebindSlotStage(runId, record, operationId);
    await this.reattachWorkspaceStage(runId, operationId);
  }

  /**
   * Bind the slot row back to the run. Idempotent: a row that already names
   * this run needs no claim, so recovery can re-drive it after a crash.
   *
   * `slotReboundAt` is the occupancy fact and lands here; `slotFreedAt` does
   * NOT, because it is what tells a retry this record still owes freed-slot
   * stages. Clearing it here made a restore that died before re-creating the
   * pane look like an ordinary park to the retry, which then failed on a
   * recovery handle nothing had re-hosted.
   */
  private async rebindSlotStage(
    runId: string,
    record: MachineParkRecord,
    operationId: string,
  ): Promise<void> {
    await this.beginRestoreStage(runId, operationId, 'rebind');
    const row = await this.deps.slotRow(record.slotId);
    const owner =
      row && typeof row.current_run_id === 'string' && row.current_run_id
        ? row.current_run_id
        : null;
    if (owner !== runId) {
      if (!(await this.deps.claimSlotOwnership(this.requireRun(runId), record.slotId))) {
        throw new Error(`slot '${record.slotId}' could not be re-bound to run '${runId}'`);
      }
    }
    await this.patchRecord(runId, (current) => ({
      ...current,
      slotReboundAt: current.slotReboundAt ?? this.deps.now(),
      restoreRefusal: undefined,
    }));
    await this.completeRestoreStage(runId, operationId, 'rebind');
  }

  /** Put the preserved branch back in the working tree at its recorded tip. */
  private async reattachWorkspaceStage(runId: string, operationId: string): Promise<void> {
    await this.beginRestoreStage(runId, operationId, 'reattach');
    const workspace = this.requireRun(runId).park?.preservedWorkspace;
    if (workspace?.detachedAt) {
      // Re-proved after the claim, not just at preview: the tree could have gone
      // dirty in between, and a checkout on top of that would carry a successor's
      // leftovers onto the parked branch.
      const inspection = await this.inspectRestoreWorkspace(this.requireRun(runId), workspace);
      if (!inspection.ok) throw new Error(inspection.reason);
      await this.deps.reattachParkedWorkspace(this.requireRun(runId), workspace);
      await this.patchRecord(runId, (current) => ({
        ...current,
        preservedWorkspace: current.preservedWorkspace
          ? {
              branch: current.preservedWorkspace.branch,
              headSha: current.preservedWorkspace.headSha,
            }
          : current.preservedWorkspace,
      }));
    }
    await this.completeRestoreStage(runId, operationId, 'reattach');
  }

  /**
   * Drop the write-ahead marker and the freed-slot flag, together, once every
   * stage has landed. Both describe an obligation that no longer exists.
   */
  private async settleCompletedRestore(runId: string, record: MachineParkRecord): Promise<void> {
    await this.patchRecord(runId, (current) => ({ ...current, slotFreedAt: undefined }));
    await this.deps
      .deleteIntentJournal(record.machine, 'restore-slot', record.operationId, runId)
      .catch((error: unknown) => {
        // The restore is durable on the record; a stale marker only makes the
        // next reconcile re-prove an already-finished transition.
        console.warn(
          `[machine-pause] could not delete restore-slot journal for ${runId}: ${messageOf(error)}`,
        );
      });
  }

  /**
   * Declare a restore stage before it runs.
   *
   * Write-ahead, and that is the whole point: a crash inside a stage has to be
   * visible as an unfinished stage rather than as an absence. The per-stage
   * FACTS — the slot row, the reattached branch, the lease states, the runner
   * proof — are each written after their stage, so reading them alone cannot
   * tell "never started" from "died half way".
   */
  private async beginRestoreStage(
    runId: string,
    operationId: string,
    stage: MachineParkRestoreStage,
  ): Promise<void> {
    const at = this.deps.now();
    await this.patchRecord(runId, (record) => ({
      ...record,
      restoreProgress: {
        operationId,
        // A NEW attempt starts its own history. Every stage re-runs and
        // re-verifies its own fact, so carrying an earlier attempt's stages
        // forward would only let the record claim a stage landed in this one —
        // and a `rebind` an earlier attempt completed says nothing about a slot
        // a rival has since taken. The repair path continues the SAME attempt,
        // so it keeps what that attempt recorded.
        completed:
          record.restoreProgress?.operationId === operationId
            ? record.restoreProgress.completed
            : [],
        attempting: stage,
        updatedAt: at,
      },
    }));
  }

  /** Mark a stage landed. Only ever called after the stage proved its own fact. */
  private async completeRestoreStage(
    runId: string,
    operationId: string,
    stage: MachineParkRestoreStage,
  ): Promise<void> {
    const at = this.deps.now();
    await this.patchRecord(runId, (record) => {
      const previous = record.restoreProgress?.completed ?? [];
      const completed = previous.includes(stage) ? previous : [...previous, stage];
      const progress: MachineParkRestoreProgress = { operationId, completed, updatedAt: at };
      return { ...record, restoreProgress: progress };
    });
  }

  /**
   * Which panes this run may adopt a live worker from.
   *
   * A matching native session id proves the process is resuming this
   * CONVERSATION; a successor dispatched with the same `--resume` proves that
   * too. What it cannot prove is that the worker belongs to this Farmslot run.
   *
   * So the evidence has to be CURRENT, and the only current binding this
   * gateway records is the slot row: it names the run that owns the slot right
   * now. A historical pane id is not evidence — the pane it names was handed to
   * whoever took the slot next, and a same-conversation successor sitting in it
   * after its own row cleared would be adopted and then respawned over.
   *
   * Returns undefined unless the row names this run, and the caller then
   * refuses every live occupant rather than adopting one. That is deliberately
   * strict about the free-slot case: a live worker on a slot nobody owns is an
   * orphan, and orphans are not this restore's to take. Adoption only has to
   * work after the rebind, which is where a retry needs it.
   */
  private async parkHostOwnership(
    run: Run,
    record: MachineParkRecord,
  ): Promise<RunnerParkHostOwnership | undefined> {
    const row = await this.deps.slotRow(record.slotId);
    const owner =
      row && typeof row.current_run_id === 'string' && row.current_run_id
        ? row.current_run_id
        : null;
    if (owner !== run.id) return undefined;
    const ownedPaneIds = [
      ...new Set(
        [
          record.recoveryHandle?.target.paneId,
          ...(run.agentContexts ?? []).map((context) => context.target?.paneId),
        ].filter((paneId): paneId is string => Boolean(paneId)),
      ),
    ];
    return { runId: run.id, ownedPaneIds };
  }

  /**
   * Record why a restore refused, without touching anything else.
   *
   * A refusal is not a park failure: the record stays `parked`, its slot stays
   * freed, and its gate decision stays pending. Persisting the reason is what
   * lets a client that reconnects — or one that never saw the RPC error —
   * still explain why the operator's answer did not go through.
   */
  private recordRestoreRefusal(
    runId: string,
    code: string,
    reason: string,
  ): Promise<MachineParkRecord> {
    const refusal: MachineParkRestoreRefusal = { code, reason, at: this.deps.now() };
    return this.patchRecord(runId, (record) => ({ ...record, restoreRefusal: refusal }));
  }

  /**
   * Undo a detach this park performed when the park will not finish. The branch
   * goes back into the working tree at the tip it was detached from, so the run
   * is left exactly as the park found it and `detachedAt` is cleared.
   */
  private async rollBackDetachedWorkspace(runId: string): Promise<void> {
    const run = this.deps.getRun(runId);
    const workspace = run?.park?.preservedWorkspace;
    if (!run || !workspace?.detachedAt) return;
    // The release was refused, which can mean a rival already owns this row. A
    // checkout there would run `git checkout <our branch>` inside SOMEONE
    // ELSE'S working tree, on top of whatever their prepare just laid down.
    // Ownership first: only the run that still holds the slot may touch it.
    const row = await this.deps.slotRow(run.park!.slotId);
    const owner = row && typeof row.current_run_id === 'string' ? row.current_run_id : null;
    if (owner !== runId) {
      await this.appendError(
        runId,
        'parked',
        'workspace.reattach',
        new Error(
          `slot '${run.slotId}' is owned by '${owner ?? 'nobody'}', not '${runId}'; leaving the detached workspace alone`,
        ),
      );
      return;
    }
    // Identity second: the tree must still be sitting on the exact commit this
    // park detached to. Anything else means another writer moved it, and a
    // checkout would be guessing at whose work is on top.
    let current: ParkWorkspaceInspection;
    try {
      current = await this.deps.inspectParkWorkspace(run);
    } catch (error) {
      await this.appendError(runId, 'parked', 'workspace.reattach', error);
      return;
    }
    if (current.branch !== null || current.headSha !== workspace.headSha) {
      await this.appendError(
        runId,
        'parked',
        'workspace.reattach',
        new Error(
          `slot workspace moved to ${current.branch ?? 'detached'}@${current.headSha ?? 'unknown'} since the park detached ${workspace.headSha}`,
        ),
      );
      return;
    }
    try {
      await this.deps.reattachParkedWorkspace(run, workspace);
    } catch (error) {
      // The branch ref still exists at `headSha`; only the checkout failed. The
      // record keeps `detachedAt`, so the fence stays up and the operator sees
      // an outstanding effect rather than a run that silently looks untouched.
      await this.appendError(runId, 'parked', 'workspace.reattach', error);
      return;
    }
    await this.patchRecord(runId, (current) => ({
      ...current,
      preservedWorkspace: current.preservedWorkspace
        ? { branch: current.preservedWorkspace.branch, headSha: current.preservedWorkspace.headSha }
        : current.preservedWorkspace,
    }));
  }

  private async buildRestorePreview(machine: string, selector: MachinePauseSelector) {
    const fleet = await this.deps.loadFleet();
    assertKnownMachine(machine, fleet);
    const records = selectRestoreRuns(this.deps.allRuns(), machine, selector);
    const runs: MachinePauseRestorePreviewRun[] = await Promise.all(
      records.map(async (run) => {
        const record = structuredClone(run.park!);
        const selected = selectedBySelector(run.id, selector);
        const slot = fleet.slots.find((candidate) => candidate.slot === record.slotId);
        const freed = owesFreedSlotStages(record);
        // Read once and shared by the verdict and the target, so a client never
        // sees a rejection that disagrees with the availability beside it.
        const availability = freed
          ? await this.slotAcceptsRestore(record.slotId, run.id)
          : { ok: true as const };
        const restoreTarget: MachinePauseRestoreTarget = {
          slotId: record.slotId,
          disposition: record.slotDisposition ?? 'retained',
          available: freed
            ? availability.ok
            : Boolean(slot) && (record.mode !== 'release' || slot!.currentRunId === run.id),
        };
        const reject = (code: string, reason: string): MachinePauseRestorePreviewRun => ({
          runId: run.id,
          generation: run.engineState?.generation ?? 0,
          selected,
          eligibility: { eligible: false, code, reason },
          restoreTarget,
          record,
        });
        if (record.phase === 'restored' || record.phase === 'cancelled') {
          return reject('NOT_PARKED', `park record is '${record.phase}'`);
        }
        if (!isPauseMode(record.mode)) {
          return reject('INVALID_MODE', `park record has invalid mode '${String(record.mode)}'`);
        }
        if (zeroEffectRecord(run, record)) {
          return {
            runId: run.id,
            generation: record.generation,
            selected,
            eligibility: {
              eligible: true,
              code: 'ELIGIBLE_ZERO_EFFECT_REPAIR',
              reason: 'No pause side effect landed; restore will settle the durable record only.',
            },
            restoreTarget,
            record,
          };
        }
        // A gate park deliberately PRESERVES the run's status — the run stays at
        // its gate rather than moving to `paused`. Requiring `paused` here would
        // therefore refuse every gate park that needs restoring, which is the
        // only exit a partial one has: its runner is already stopped, so the run
        // is fenced out of answering its gate until restore reloads the worker.
        if (run.status !== 'paused' && !isGateParkRecord(record))
          return reject('RUN_NOT_PAUSED', `run status is '${run.status}'`);
        if ((run.engineState?.generation ?? 0) !== record.generation) {
          return reject('GENERATION_CHANGED', 'run generation changed while parked');
        }
        if (!slot || slot.machine !== machine) {
          return reject(
            'MACHINE_MISMATCH',
            'recorded slot no longer belongs to the selected machine',
          );
        }
        if (record.mode === 'release' && !record.recoveryHandle) {
          return reject('RECOVERY_HANDLE_MISSING', 'release park has no runner recovery handle');
        }
        if (freed) {
          // ADR-054 restores a freed slot into the ORIGINAL slot only. Every
          // check below is READ-ONLY on purpose: a refusal here has changed
          // nothing, so the record stays parked and its gate stays answerable
          // once the slot comes back. Cross-slot re-dispatch is a separate
          // decision and deliberately absent.
          if (!availability.ok) {
            return reject(MachineParkEligibilityCodes.restoreSlotTaken, availability.reason);
          }
          if (record.preservedWorkspace?.detachedAt) {
            const workspace = await this.inspectRestoreWorkspace(run, record.preservedWorkspace);
            if (!workspace.ok) {
              return reject(
                MachineParkEligibilityCodes.restoreWorkspaceUnavailable,
                workspace.reason,
              );
            }
          }
          // The pane the park recorded is routinely gone: freeing the slot hands
          // its tmux session to the next occupant. What must still hold is the
          // persisted session and the runner's declared reload — the pane is a
          // host the restore re-creates.
          const host = await this.deps.inspectParkHost(
            run,
            record.recoveryHandle!,
            await this.parkHostOwnership(run, record),
          );
          if (!host.ok) {
            return reject(MachineParkEligibilityCodes.restoreRunnerReloadFailed, host.reason);
          }
          return {
            runId: run.id,
            generation: record.generation,
            selected,
            eligibility: {
              eligible: true,
              code: 'ELIGIBLE_FREED_SLOT_RESTORE',
              reason:
                host.disposition === 'exact'
                  ? 'The freed slot is still free and the persisted runner session is reloadable in place.'
                  : 'The freed slot is still free and the persisted runner session will be re-hosted on a new pane.',
            },
            restoreTarget,
            record,
          };
        }
        if (record.mode === 'release' && slot.currentRunId !== run.id) {
          return reject('SLOT_OWNERSHIP_CHANGED', 'slot no longer has the reviewed run ownership');
        }
        if (record.mode === 'release') {
          try {
            await this.deps.inspectRecoveryHandle(
              run,
              record.recoveryHandle!,
              expectedRestoreRunnerState(record),
            );
          } catch (error) {
            return reject('RECOVERY_HANDLE_STALE', messageOf(error));
          }
        }
        return {
          runId: run.id,
          generation: record.generation,
          selected,
          eligibility: {
            eligible: true,
            code: 'ELIGIBLE_RESTORE',
            reason:
              record.mode === 'release'
                ? 'The parked generation and exact slot ownership still match the durable record.'
                : 'The parked orchestration generation still belongs to the recorded machine slot.',
          },
          restoreTarget,
          record,
        };
      }),
    );
    return {
      machine,
      selector: structuredClone(selector),
      previewId: digestPreview('restore', {
        machine,
        selector,
        runs: runs.filter((run) => run.selected),
      }),
      runs,
    };
  }

  private async persistRestoreIntents(
    items: MachinePauseRestorePreviewRun[],
    operationId: string,
    previewId: string,
  ): Promise<{ records: MachineParkRecord[]; durable: boolean }> {
    const fleet = await this.deps.loadFleet();
    await Promise.all(
      items.map(async (item) => {
        if (item.eligibility.code === 'ELIGIBLE_ZERO_EFFECT_REPAIR') return;
        if (item.record.mode !== 'release') return;
        const run = this.requireRun(item.runId);
        if (!item.record.recoveryHandle)
          throw new Error(`run ${item.runId} has no recovery handle`);
        if (owesFreedSlotStages(item.record)) {
          // A freed park's recorded pane belongs to whoever dispatch gave the
          // slot to, so probing it would refuse every restore this slice
          // exists to allow. The persisted session and the runner's declared
          // reload are what must still hold.
          const host = await this.deps.inspectParkHost(
            run,
            item.record.recoveryHandle,
            await this.parkHostOwnership(run, item.record),
          );
          if (!host.ok) throw new Error(host.reason);
          return;
        }
        await this.deps.inspectRecoveryHandle(
          run,
          item.record.recoveryHandle,
          expectedRestoreRunnerState(item.record),
        );
      }),
    );
    for (const item of items) {
      const current = this.requireRun(item.runId);
      const slot = fleet.slots.find((candidate) => candidate.slot === item.record.slotId);
      const zeroEffect = item.eligibility.code === 'ELIGIBLE_ZERO_EFFECT_REPAIR';
      // Re-proved INSIDE the machine transition, because the preview's read
      // happened outside it: a dispatch that claimed the slot in between must
      // stop this restore before it writes an intent, not after.
      if (owesFreedSlotStages(item.record)) {
        const availability = await this.slotAcceptsRestore(item.record.slotId, item.runId);
        if (!availability.ok) throw new Error(availability.reason);
      }
      if (
        // Same relaxation the preview applies: a gate park preserves the run's
        // status by design, so `paused` is the wrong precondition for it. Left
        // in place here, the preflight would refuse the very restore the
        // preview just declared eligible.
        (zeroEffect
          ? !current.park || !zeroEffectRecord(current, current.park)
          : current.status !== 'paused' && !isGateParkRecord(item.record)) ||
        (current.engineState?.generation ?? 0) !== item.generation ||
        current.slotId !== item.record.slotId ||
        !current.park ||
        stableJson(current.park) !== stableJson(item.record) ||
        !slot ||
        slot.machine !== item.record.machine ||
        // A freed park has no slot ownership by construction; its availability
        // was just re-proved above.
        (item.record.mode === 'release' &&
          !owesFreedSlotStages(item.record) &&
          slot.currentRunId !== item.runId)
      ) {
        throw new Error(`run ${item.runId} changed during restore preflight; preview again`);
      }
    }
    const nextRecords = items.map((item) => {
      const run = this.requireRun(item.runId);
      return {
        run,
        record: {
          ...structuredClone(run.park!),
          operationId,
          previewId,
          restoreDisposition:
            item.eligibility.code === 'ELIGIBLE_ZERO_EFFECT_REPAIR' ? 'zero-effect' : 'effectful',
          phase:
            item.eligibility.code === 'ELIGIBLE_ZERO_EFFECT_REPAIR'
              ? run.park!.phase
              : run.park!.mode === 'release'
                ? 'resources-restoring'
                : 'orchestration-resuming',
          updatedAt: this.deps.now(),
        } satisfies MachineParkRecord,
      };
    });
    try {
      await this.deps.writeIntentJournal(
        'restore',
        nextRecords.map(({ record }) => record),
      );
    } catch (error) {
      return {
        records: intentFailureRecords(
          nextRecords.map(({ record }) => record),
          error,
          this.deps.now(),
        ),
        durable: false,
      };
    }
    const updated = nextRecords.map(({ run, record }) => this.deps.updatePark(run.id, record));
    const durable = await this.settleIntentDurability(updated, 'restore', 'machine-restore-intent');
    for (const run of updated) await this.emitRecord(run.park!);
    return { records: updated.map((run) => structuredClone(run.park!)), durable };
  }

  private async settleZeroEffectRestore(
    item: MachinePauseRestorePreviewRun,
    operationId: string,
    previewId: string,
  ): Promise<void> {
    const run = this.requireRun(item.runId);
    if (!run.park || !zeroEffectRecord(run, run.park)) {
      throw new Error(`run ${item.runId} no longer has a zero-effect restore record`);
    }
    await this.patchRecord(run.id, (record) => ({
      ...record,
      operationId,
      previewId,
      phase: 'restored',
      restoredAt: this.deps.now(),
      restoredGeneration: run.engineState?.generation ?? record.generation,
    }));
  }

  private async restoreOne(
    runId: string,
    expectedRunnerState: 'stopped' | 'stopped-or-live',
  ): Promise<void> {
    const initial = this.requireRun(runId);
    const record = initial.park!;
    let failed = false;
    let resumeAcknowledgement: RunResumeAcknowledgement | null = null;
    // The handle the reload will use. A freed park's recorded pane is routinely
    // gone, so this is re-bound below; every later runner call reads THIS rather
    // than the record's snapshot, or it would address a pane that no longer
    // exists.
    let handle = record.recoveryHandle!;
    const freedSlot = owesFreedSlotStages(record);
    // The attempt these stages belong to. The record's own operation id, so a
    // retry that re-drives the same record keeps one continuous stage history
    // rather than starting a parallel one.
    const restoreOperationId = record.operationId;
    if (record.mode === 'release') {
      if (freedSlot) {
        // FIRST, before any resource or runner work. Everything that follows
        // acts on the slot, and acting on a slot this run does not own would
        // reach into whatever dispatch handed it to. A refusal here throws with
        // the slot untouched.
        await this.reclaimFreedSlot(runId, record, restoreOperationId);
      } else {
        await this.deps.inspectRecoveryHandle(initial, record.recoveryHandle!, expectedRunnerState);
      }
      // Ordered FIRST, before anything acquires. A provider's acquire action is
      // frequently its resource's own boot action — the shipped gateway/UI
      // provider is exactly that — so acquiring first would revive a retained
      // resource that died while the run was parked and let the restore report
      // success over it. Park never stopped these, so restore must find them
      // already up or refuse; it may not boot its way to a green result.
      // One observation taken before anything acquires, feeding the retained
      // check below. What each acquisition and boot actually did is reported by
      // the code that performs it, not inferred from observations around it.
      if (freedSlot) await this.beginRestoreStage(runId, restoreOperationId, 'reacquire');
      await this.patchRecord(runId, (current) => ({ ...current, restoreEffects: [] }));
      let preAcquire: Map<string, SlotResource['status']> | null = null;
      try {
        preAcquire = new Map(
          (await this.deps.observeResources(record.slotId)).map((resource) => [
            resource.id,
            resource.status,
          ]),
        );
      } catch (error) {
        await this.appendError(runId, 'resources-restoring', 'resource.retained-verify', error);
      }
      // Every boot, shutdown, and relaunch on this slot from here on is
      // reported by the code that runs it, including the ones a capability
      // acquire reaches. A retained resource must never be booted at all, so a
      // boot against one is recorded as an effect that should not have
      // happened, whatever state it was in beforehand.
      const retainedIds = new Set(
        record.resourceManifest.resources
          .filter((resource) => resource.releaseEffect === 'retain')
          .map((resource) => resource.resourceId),
      );
      const performed: MachineParkRestoreEffect[] = [];
      /** Resources the restore acted on, so a verification is not added on top. */
      const actedOn = new Set<string>();
      // Only hooks this restore itself initiates carry this id, so an operator
      // control or a cleanup shutdown landing on the same slot mid-restore is
      // not recorded as something the restore did.
      const lifecycleContextId = `machine-park-restore:${runId}:${randomUUID()}`;
      const stopCapture = captureSlotResourceLifecycle(
        { contextId: lifecycleContextId, slotId: record.slotId },
        (event) => {
          actedOn.add(event.resourceId);
          const action = event.action === 'shutdown' ? ('stopped' as const) : ('booted' as const);
          const forbidden = action === 'booted' && retainedIds.has(event.resourceId);
          performed.push({
            resourceId: event.resourceId,
            action,
            at: this.deps.now(),
            ok: forbidden ? false : event.ok,
            ...(forbidden
              ? {
                  reason: `a retained resource must never be booted by a restore; '${event.action}' ran anyway`,
                }
              : event.detail
                ? { reason: event.detail }
                : {}),
          });
        },
      );
      const drainPerformed = async (): Promise<void> => {
        while (performed.length > 0) {
          const effect = performed.shift()!;
          if (!effect.ok) failed = true;
          await this.recordRestoreEffect(runId, effect);
        }
      };
      try {
        await runWithResourceLifecycleContext(lifecycleContextId, async () => {
          const retainedFailure = !(await this.verifyRetainedResources(runId, record, preAcquire));
          if (retainedFailure) {
            failed = true;
            // Say plainly which resources this restore never touched, so the record
            // reads as a complete account rather than a silence to interpret.
            for (const resource of record.resourceManifest.resources) {
              if (resource.releaseEffect === 'retain') continue;
              await this.recordRestoreEffect(runId, {
                resourceId: resource.resourceId,
                action: 'skipped',
                ok: false,
                reason:
                  'a retained resource failed verification, so nothing was acquired or booted',
              });
            }
          }
          for (const lease of retainedFailure ? [] : record.resourceManifest.capabilityLeases) {
            let shouldAcquire = lease.state === 'released';
            if (lease.state === 'held' || lease.state === 'reacquired') continue;
            if (!shouldAcquire) {
              try {
                const status = await this.deps.capabilityStatus(record.slotId, runId);
                const persisted = status.leases.find((candidate) => candidate.id === lease.leaseId);
                if (persisted?.state === 'released') {
                  shouldAcquire = true;
                } else if (persisted?.state === 'acquired') {
                  await this.patchCapability(runId, lease.leaseId, {
                    state: 'held',
                    error: undefined,
                  });
                  continue;
                } else {
                  throw new Error(
                    `capability '${lease.capabilityId}' cannot be safely reacquired from state '${persisted?.state ?? 'missing'}'`,
                  );
                }
              } catch (error) {
                failed = true;
                await this.patchCapability(runId, lease.leaseId, {
                  state: 'failed',
                  error: messageOf(error),
                });
                await this.appendError(runId, 'resources-restoring', 'capability.reconcile', error);
                continue;
              }
            }
            if (!shouldAcquire) continue;
            await this.patchCapability(runId, lease.leaseId, {
              state: 'reacquiring',
              error: undefined,
            });
            try {
              const result = await this.deps.acquireCapability({
                slotId: record.slotId,
                capabilityId: lease.capabilityId,
                ownerRunId: runId,
                ...(lease.ownerFamilyId ? { ownerFamilyId: lease.ownerFamilyId } : {}),
                proofRequirement: structuredClone(lease.proofRequirement),
                parameters: structuredClone(lease.parameters),
              });
              if (!result.ok) throw new Error(result.conflict.reason);
              await this.patchCapability(runId, lease.leaseId, {
                state: 'reacquired',
                restoredLeaseId: result.lease.id,
                error: undefined,
              });
            } catch (error) {
              failed = true;
              await this.patchCapability(runId, lease.leaseId, {
                state: 'failed',
                error: messageOf(error),
              });
              await this.appendError(runId, 'resources-restoring', 'capability.acquire', error);
            }
          }
          await drainPerformed();
          let observed = retainedFailure ? [] : await this.deps.observeResources(record.slotId);
          const observedById = new Map(observed.map((resource) => [resource.id, resource.status]));
          for (const resource of retainedFailure ? [] : record.resourceManifest.resources) {
            await this.patchResource(runId, resource.resourceId, {
              phase: 'restoring',
              error: undefined,
            });
            try {
              const status = observedById.get(resource.resourceId);
              if (resource.releaseEffect === 'retain') {
                // Park never stopped this one, so booting it here would start a
                // second copy of something already running. Restore's job is to
                // prove the claim held: it is still up.
                if (status !== 'running') {
                  throw new Error(
                    `retained resource '${resource.resourceId}' is '${status ?? 'missing'}'; park never stopped it, so restore will not boot it`,
                  );
                }
              } else if (status === 'stopped') {
                // No effect recorded here: the code that runs the boot hook reports
                // it, so a boot reached through a capability acquire and a boot
                // reached from this line land in the record the same way.
                const result = await this.deps.startResource(record.slotId, resource.resourceId);
                if (!result.ok) throw new Error(result.detail ?? 'resource boot failed');
                observedById.set(resource.resourceId, 'running');
              } else if (status === 'running') {
                // Only when the restore did nothing to it. A resource an
                // acquisition already booted is running for a reason the record
                // states; adding a verification on top would report the same
                // resource twice and hide which of the two actually happened.
                if (!actedOn.has(resource.resourceId)) {
                  await this.recordRestoreEffect(runId, {
                    resourceId: resource.resourceId,
                    action: 'verified',
                    ok: true,
                  });
                }
              } else {
                throw new Error(
                  `resource '${resource.resourceId}' is '${status ?? 'missing'}'; refusing an unobserved boot`,
                );
              }
              await this.patchResource(runId, resource.resourceId, {
                phase: 'restored',
                restoredAt: this.deps.now(),
                error: undefined,
              });
            } catch (error) {
              failed = true;
              await this.patchResource(runId, resource.resourceId, {
                phase: 'failed',
                error: messageOf(error),
              });
              await this.appendError(
                runId,
                'resources-restoring',
                'resource.boot',
                error,
                resource.resourceId,
              );
            }
          }
          await drainPerformed();
          try {
            observed = retainedFailure ? [] : await this.deps.observeResources(record.slotId);
            const finalById = new Map(observed.map((resource) => [resource.id, resource.status]));
            for (const resource of retainedFailure ? [] : record.resourceManifest.resources) {
              if (finalById.get(resource.resourceId) === 'running') continue;
              failed = true;
              await this.appendError(
                runId,
                'resources-restoring',
                'resource.restore-verify',
                new Error(
                  `resource '${resource.resourceId}' is '${finalById.get(resource.resourceId) ?? 'missing'}' after restore`,
                ),
                resource.resourceId,
              );
            }
          } catch (error) {
            failed = true;
            await this.appendError(runId, 'resources-restoring', 'resource.restore-verify', error);
          }
          if (freedSlot && !failed) {
            await this.completeRestoreStage(runId, restoreOperationId, 'reacquire');
          }
          if (!failed) {
            try {
              if (freedSlot) await this.beginRestoreStage(runId, restoreOperationId, 'reload');
              if (freedSlot) {
                // The park handed this slot's tmux session to the next
                // occupant, whose dispatch replaced its windows. The session id
                // is the identity that survives; the pane is a host the restore
                // re-creates. Refuses rather than respawning over a live runner
                // it cannot prove this run owns.
                const ownership = await this.parkHostOwnership(this.requireRun(runId), record);
                const host = await this.deps.rehostParkTarget(
                  this.requireRun(runId),
                  handle,
                  ownership,
                );
                if (!host.ok) throw new Error(host.reason);
                handle = host.recoveryHandle;
                // BOTH targets, every time, whatever the disposition. The record
                // is what a later restore reads and the agent context is what an
                // operator's attach reads, and a failure between the two writes
                // left attach pointing at a pane the successor had destroyed —
                // which a retry then had no reason to repair, because the record
                // already looked right. Writing both unconditionally makes the
                // stage idempotent, so the retry repairs it by re-running.
                await this.patchRecord(runId, (current) => ({
                  ...current,
                  recoveryHandle: structuredClone(handle),
                }));
                await this.deps.rebindAgentContextTarget(this.requireRun(runId), handle);
              }
              const runner = await this.deps.runnerRunning(this.requireRun(runId), handle);
              if (runner === 'stopped') {
                await this.patchRecord(runId, (current) => ({
                  ...current,
                  phase: 'runner-reloading',
                }));
                const current = this.requireRun(runId);
                const proof = await this.deps.reloadRunner(
                  current,
                  handle,
                  buildMachineParkingContinuationPrompt(current, current.park!),
                );
                if (
                  proof.sessionId !== handle.sessionId ||
                  !proof.live ||
                  proof.acknowledgement.kind !== 'structured'
                ) {
                  throw new Error(
                    'runner reload proof does not match the persisted recovery handle',
                  );
                }
                await this.patchRecord(runId, (park) => ({
                  ...park,
                  recoveryProof: structuredClone(proof),
                }));
              } else if (runner === 'running') {
                // The worker was already back — a retry after a restore whose
                // reload landed and whose next step did not. It still owes a
                // proof: consumption requires one, and "the process is running"
                // is not it. The host plan above proved this pane runs THIS
                // run's persisted session, so that is what is recorded.
                await this.patchRecord(runId, (park) => ({
                  ...park,
                  recoveryProof: {
                    sessionId: handle.sessionId,
                    live: true,
                    acknowledgement: {
                      // `adopted`, not `structured`: nothing was relaunched and
                      // no turn was delivered here. The evidence is the host
                      // plan's structured live-binding check, which is a real
                      // signal — but a consumer must be able to tell it from a
                      // prompt the runner acknowledged.
                      kind: 'adopted',
                      source: 'runner-session-binding',
                      reason: `the live worker on pane ${handle.target.paneId} owns this run's persisted session`,
                    },
                    acceptedAt: this.deps.now(),
                  },
                }));
              } else {
                throw new Error('runner residual state is unknown; refusing an ambiguous reload');
              }
              if (freedSlot) {
                await this.completeRestoreStage(runId, restoreOperationId, 'reload');
              }
            } catch (error) {
              failed = true;
              await this.appendError(runId, 'runner-reloading', 'runner.reload', error);
            }
          }
        });
      } finally {
        // Always: the context id never recurs, so a listener left behind cannot
        // catch a later operation, but it would hold this restore's closure and
        // its effect buffer for the life of the process.
        stopCapture();
        await drainPerformed();
      }
    }
    // BEFORE the resume, because the resume may replay the gate and a replay
    // ADVANCES the run generation. A reattach failure after that advance would
    // settle `partial` carrying the pre-replay generation, and every later
    // restore preview would then reject GENERATION_CHANGED — the record could
    // never be retried even once the checkout problem cleared. Failing here
    // instead leaves the generation untouched, so a retry is still possible.
    //
    // A park that detached and then failed to roll back leaves the branch out of
    // the working tree. Restoring on top of that would report success over a
    // workspace the run cannot use, and lift the fence while the detach is still
    // outstanding. Retry the reattach and PROVE it landed before going on.
    if (!failed && this.requireRun(runId).park?.preservedWorkspace?.detachedAt) {
      await this.rollBackDetachedWorkspace(runId);
      if (this.requireRun(runId).park?.preservedWorkspace?.detachedAt) {
        failed = true;
        await this.appendError(
          runId,
          'orchestration-resuming',
          'workspace.reattach',
          new Error(
            'the parked branch is still detached; restore cannot complete until it is back in the working tree',
          ),
        );
      }
    }
    if (!failed) {
      try {
        await this.patchRecord(runId, (current) => ({
          ...current,
          phase: 'orchestration-resuming',
        }));
        resumeAcknowledgement = await this.withQueuedEmit((emit) =>
          this.deps.resumeRun(runId, emit, {
            suppressMonitorNudge: record.mode === 'release',
          }),
        );
        // A gate-park restore re-drives nothing — the run never left its gate —
        // so it is acknowledged with an UNCHANGED generation by design. Demanding
        // an advance there would reject the very restore this branch exists to
        // allow, after the reload had already landed.
        // `gateParkHold` re-drives nothing and must NOT advance; every other
        // shape, including a gate whose loop had exited and was replayed, takes
        // ownership and must.
        const generationAdvanced = resumeAcknowledgement.gateParkHold
          ? resumeAcknowledgement.generation === resumeAcknowledgement.previousGeneration
          : resumeAcknowledgement.generation > resumeAcknowledgement.previousGeneration;
        if (
          resumeAcknowledgement.run.id !== runId ||
          !generationAdvanced ||
          resumeAcknowledgement.stepName !== record.prePauseCurrentStep?.name
        ) {
          throw new Error('run resume acknowledgement did not match the parked generation/step');
        }
      } catch (error) {
        failed = true;
        await this.appendError(runId, 'orchestration-resuming', 'run.resume', error);
        // Bring the record's generation up to the run's. A replay inside the
        // resume advances it before it can fail the acknowledgement check, and a
        // record left describing a generation that no longer exists is refused by
        // the preview's GENERATION_CHANGED check forever — the retry this partial
        // exists to allow could never happen. This is the ONLY failure path that
        // can follow an advance: the reattach is verified before the resume.
        const generation = this.requireRun(runId).engineState?.generation ?? record.generation;
        await this.patchRecord(runId, (current) => ({ ...current, generation }));
      }
    }
    const latest = this.requireRun(runId);
    const residuals = await this.observeResiduals(latest, latest.park!);
    await this.patchRecord(runId, (current) => ({
      ...current,
      phase: failed ? 'partial' : 'restored',
      residuals,
      ...(failed
        ? {}
        : {
            restoredAt: this.deps.now(),
            restoredGeneration: resumeAcknowledgement?.generation ?? current.generation,
          }),
    }));
    // The obligation ends here and nowhere earlier: `slotFreedAt` and the
    // write-ahead marker both say "this record owes freed-slot stages", and a
    // restore that settles `partial` still owes them.
    if (!failed && freedSlot) {
      if (!machineParkRestoreComplete(this.requireRun(runId).park?.restoreProgress)) {
        throw new Error(
          `restore for run ${runId} reported success with unfinished stages; refusing to clear its freed-slot marker`,
        );
      }
      await this.settleCompletedRestore(runId, record);
    }
    // AFTER the record settles `restored`, because that is what makes the run
    // no longer parked; recording the posture first would describe a state the
    // record still contradicts. A restore that failed settles `partial` and
    // skips this, leaving the run's posture reading `parked` — which is honest:
    // its worker did not come back.
    if (!failed) {
      try {
        await this.deps.recordParkRestoredPosture(runId);
      } catch (error) {
        // The restore itself is durable and complete. A posture note that could
        // not be written is a reporting gap, not a reason to report a restore
        // that happened as failed — but it is never silent.
        await this.appendError(runId, 'restored', 'posture.record-restored', error);
      }
    }
  }

  private async observeResiduals(run: Run, record: MachineParkRecord) {
    // Once the slot is freed it belongs to whoever dispatch handed it to.
    // Probing it here would report the SUCCESSOR's runner and providers as this
    // run's residuals, so `machine.pause.status` would show a parked run
    // holding processes it does not own. The record is the authority instead:
    // the free only lands after the runner and every manifest resource were
    // observed stopped, so those observations are what it carries.
    //
    // Only while the slot is still ANOTHER's, though. `slotFreedAt` survives the
    // whole restore as the obligation marker, so reading it alone kept reporting
    // a restored run's live worker as stopped from a record written before the
    // rebind. Once `slotReboundAt` says the slot is ours again, probing it is
    // both safe and the only way to report what is actually there.
    if (record.slotFreedAt && !record.slotReboundAt) {
      return {
        runner: 'stopped' as const,
        resources: record.resourceManifest.resources.map((resource) => ({
          resourceId: resource.resourceId,
          state:
            resource.phase === 'stopped'
              ? ('stopped' as const)
              : // A retained resource was verified still running before the free;
                // the successor now shares it, so the record stays the authority.
                resource.phase === 'retained'
                ? ('running' as const)
                : ('unknown' as const),
          detail: 'observed before the slot was freed',
        })),
      };
    }
    let runner: 'running' | 'stopped' | 'unknown' =
      record.mode === 'orchestration' ? 'running' : 'unknown';
    if (record.recoveryHandle) {
      try {
        runner = await this.deps.runnerRunning(run, record.recoveryHandle);
      } catch {
        // Same fail-closed contract as the resource probe below: this function
        // reports what it could observe and never throws. It runs on the
        // settlement path of an operation that has already had its effects, so
        // a probe failure here must not erase the durable result of that
        // operation — `unknown` is the honest answer and the operator sees it.
        runner = 'unknown';
      }
    }
    let observed: SlotResource[] = [];
    try {
      observed = await this.deps.observeResources(record.slotId);
    } catch {
      // Residual collection is intentionally fail-closed: unknown is reported instead of
      // erasing the durable operation result when the node is temporarily unreachable.
    }
    return {
      runner,
      resources: record.resourceManifest.resources.map((resource) => {
        const status = observed.find((item) => item.id === resource.resourceId)?.status;
        return {
          resourceId: resource.resourceId,
          state:
            status === 'running'
              ? ('running' as const)
              : status === 'stopped'
                ? ('stopped' as const)
                : ('unknown' as const),
          ...(status ? { detail: `observed ${status}` } : {}),
        };
      }),
    };
  }

  private async patchRecord(
    runId: string,
    mutate: (record: MachineParkRecord) => MachineParkRecord,
  ): Promise<MachineParkRecord> {
    const current = this.requireRun(runId).park;
    if (!current) throw new Error(`run ${runId} has no park record`);
    const next = { ...mutate(structuredClone(current)), updatedAt: this.deps.now() };
    const run = this.deps.updatePark(runId, next);
    await this.deps.persistRun(run, `machine-pause-${next.phase}`);
    await this.emitRecord(next);
    return structuredClone(next);
  }

  /**
   * Prove every `retain` resource in the manifest is still running, before the
   * restore is allowed to acquire or boot anything. Returns false and records a
   * typed failure per dead resource; the caller then settles `partial` and the
   * fence stays up, because a retained resource that stopped means something
   * outside this run took down a lifecycle the park promised to leave alone.
   */
  /** Append one lifecycle effect, so the record states what restore did. */
  private recordRestoreEffect(
    runId: string,
    effect: Omit<MachineParkRestoreEffect, 'at'>,
  ): Promise<MachineParkRecord> {
    return this.patchRecord(runId, (record) => ({
      ...record,
      restoreEffects: [...(record.restoreEffects ?? []), { ...effect, at: this.deps.now() }],
    }));
  }

  private async verifyRetainedResources(
    runId: string,
    record: MachineParkRecord,
    statusById: Map<string, SlotResource['status']> | null,
  ): Promise<boolean> {
    const retained = record.resourceManifest.resources.filter(
      (resource) => resource.releaseEffect === 'retain',
    );
    if (retained.length === 0) return true;
    if (!statusById) return false;
    let intact = true;
    for (const resource of retained) {
      const status = statusById.get(resource.resourceId);
      if (status === 'running') {
        await this.recordRestoreEffect(runId, {
          resourceId: resource.resourceId,
          action: 'verified',
          ok: true,
        });
        continue;
      }
      intact = false;
      await this.recordRestoreEffect(runId, {
        resourceId: resource.resourceId,
        action: 'verified',
        ok: false,
        reason: `observed '${status ?? 'missing'}'`,
      });
      const failure = new Error(
        `retained resource '${resource.resourceId}' is '${status ?? 'missing'}'; park never stopped it, so restore will not boot it`,
      );
      await this.patchResource(runId, resource.resourceId, {
        phase: 'failed',
        error: failure.message,
      });
      await this.appendError(
        runId,
        'resources-restoring',
        'resource.retained-verify',
        failure,
        resource.resourceId,
      );
    }
    return intact;
  }

  private patchResource(
    runId: string,
    resourceId: string,
    patch: Partial<MachineParkRecord['resourceManifest']['resources'][number]>,
  ): Promise<MachineParkRecord> {
    return this.patchRecord(runId, (record) => ({
      ...record,
      resourceManifest: {
        ...record.resourceManifest,
        resources: record.resourceManifest.resources.map((resource) =>
          resource.resourceId === resourceId ? { ...resource, ...patch } : resource,
        ),
      },
    }));
  }

  private patchCapability(
    runId: string,
    leaseId: string,
    patch: Partial<MachineParkCapabilityLease>,
  ): Promise<MachineParkRecord> {
    return this.patchRecord(runId, (record) => ({
      ...record,
      resourceManifest: {
        ...record.resourceManifest,
        capabilityLeases: record.resourceManifest.capabilityLeases.map((lease) =>
          lease.leaseId === leaseId ? { ...lease, ...patch } : lease,
        ),
      },
    }));
  }

  private async appendError(
    runId: string,
    phase: MachineParkPhase,
    action: string,
    error: unknown,
    resourceId?: string,
  ): Promise<void> {
    const item: MachineParkError = {
      phase,
      action,
      code: 'EFFECT_FAILED',
      message: messageOf(error),
      occurredAt: this.deps.now(),
      retryable: true,
      ...(resourceId ? { resourceId } : {}),
    };
    await this.patchRecord(runId, (record) => ({ ...record, errors: [...record.errors, item] }));
  }

  private async failRecord(
    runId: string,
    phase: MachineParkPhase,
    action: string,
    error: unknown,
  ): Promise<void> {
    await this.appendError(runId, phase, action, error);
    const run = this.requireRun(runId);
    const residuals = await this.observeResiduals(run, run.park!);
    await this.patchRecord(runId, (record) => ({ ...record, phase: 'partial', residuals }));
  }

  private async emitRecord(record: MachineParkRecord): Promise<void> {
    try {
      await this.deps.emit(Events.MACHINE_PAUSE_UPDATED, {
        machine: record.machine,
        operationId: record.operationId,
        record: structuredClone(record),
      });
    } catch (error) {
      // Progress publication is advisory after the record is durable. A disconnected client
      // must not turn a successful lifecycle effect into a partial park/restore result.
      console.warn(`[machine-pause] progress emit failed: ${messageOf(error)}`);
    }
  }

  private async withQueuedEmit<T>(
    operation: (emit: (event: string, payload: unknown) => void) => Promise<T>,
  ): Promise<T> {
    let tail = Promise.resolve();
    const result = await operation((event, payload) => {
      tail = tail.then(async () => {
        try {
          await this.deps.emit(event, payload);
        } catch (error) {
          // run.pause/run.resume already mutated durable state; publication is advisory.
          console.warn(`[machine-pause] lifecycle emit failed for ${event}: ${messageOf(error)}`);
        }
      });
    });
    await tail;
    return result;
  }

  private async persistIntentRecords(runs: Run[], reason: string): Promise<boolean> {
    const results = await Promise.allSettled(runs.map((run) => this.deps.persistRun(run, reason)));
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected' ? [{ run: runs[index]!, error: result.reason }] : [],
    );
    if (failures.length === 0) return true;
    const occurredAt = this.deps.now();
    const failedIds = failures.map(({ run }) => run.id).join(', ');
    for (const run of runs) {
      const current = run.park!;
      this.deps.updatePark(run.id, {
        ...structuredClone(current),
        phase: 'failed',
        updatedAt: occurredAt,
        errors: [
          ...current.errors,
          {
            phase: 'failed',
            action: 'intent.persist',
            code: 'INTENT_BATCH_NOT_DURABLE',
            message: `zero effects applied because intent persistence failed for: ${failedIds}`,
            occurredAt,
            retryable: true,
          },
        ],
      });
    }
    await Promise.allSettled(
      runs.map((run) => this.deps.persistRun(this.requireRun(run.id), `${reason}-failed`)),
    );
    return false;
  }

  private async settleIntentDurability(
    runs: Run[],
    kind: MachineParkingIntentKind,
    reason: string,
  ): Promise<boolean> {
    let durable = await this.persistIntentRecords(runs, reason);
    const operationId = runs[0]?.park?.operationId;
    if (!operationId) return false;
    if (durable) {
      try {
        await this.deps.deleteIntentJournal(runs[0]!.park!.machine, kind, operationId);
        return true;
      } catch (error) {
        const failed = intentFailureRecords(
          runs.map((run) => run.park!),
          error,
          this.deps.now(),
        );
        for (const record of failed) this.deps.updatePark(record.runId, record);
        await Promise.allSettled(
          failed.map((record) =>
            this.deps.persistRun(this.requireRun(record.runId), `${reason}-journal-cleanup-failed`),
          ),
        );
        durable = false;
      }
    }
    try {
      await this.deps.writeIntentJournal(
        kind,
        runs.map((run) => structuredClone(run.park!)),
      );
    } catch (error) {
      console.error(`[machine-pause] intent journal repair failed: ${messageOf(error)}`);
    }
    return durable;
  }

  private async repairIntentJournals(): Promise<Set<string>> {
    const blockedRunIds = new Set<string>();
    const journals = await this.deps.loadIntentJournals();
    for (const journal of journals) {
      const { records } = journal;
      if (records.length === 0) continue;
      if (journal.kind === 'free-slot' || journal.kind === 'restore-slot') {
        for (const record of records) {
          const repaired =
            journal.kind === 'free-slot'
              ? await this.repairFreeSlotIntent(record)
              : await this.repairRestoreSlotIntent(record);
          if (!repaired) blockedRunIds.add(record.runId);
        }
        if (!records.some((record) => blockedRunIds.has(record.runId))) {
          await this.deps.deleteIntentJournal(
            journal.machine,
            journal.kind,
            journal.operationId,
            journal.scopeId,
          );
        }
        continue;
      }
      const repaired: Run[] = [];
      for (const record of records) {
        const run = this.deps.getRun(record.runId);
        if (!run) continue;
        if (run.park?.operationId === record.operationId && run.park.phase !== 'intent-persisted') {
          repaired.push(run);
          continue;
        }
        repaired.push(this.deps.updatePark(run.id, structuredClone(record)));
      }
      const results = await Promise.allSettled(
        repaired.map((run) => this.deps.persistRun(run, 'machine-pause-journal-repair')),
      );
      if (results.every((result) => result.status === 'fulfilled')) {
        await this.deps.deleteIntentJournal(journal.machine, journal.kind, journal.operationId);
      } else {
        for (const record of records) blockedRunIds.add(record.runId);
      }
    }
    return blockedRunIds;
  }

  /**
   * Finish a `free-slot` transition interrupted by a crash.
   *
   * Without this, a record already at `parked` is skipped by the phase
   * reconciler, so a run whose slot release landed but whose `slotFreedAt`
   * write did not would keep reading as an occupant — and fleet refresh would
   * re-bind the slot to it under whoever dispatch had already given it to.
   * Re-driving the idempotent completion settles both outcomes: the release is
   * finished, or it is proven already done.
   */
  private async repairFreeSlotIntent(record: MachineParkRecord): Promise<boolean> {
    // Phase is deliberately not consulted: a crash after the release landed
    // leaves a `partial` record that still needs finishing.
    //
    // The marker being on disk does NOT prove the transition was interrupted.
    // Only the CAS-refused path abandons it; the detach-failure and terminality
    // paths return with the marker intact, on purpose, so a later reconcile can
    // retry a transition that never touched the slot. Those retries are safe
    // because every step below is idempotent and re-checks its preconditions.
    const run = this.deps.getRun(record.runId);
    // Nothing to finish: the run is gone, terminal cleanup cleared the record,
    // or a restore already reclaimed the slot.
    if (!run?.park) return true;
    if (run.park.operationId !== record.operationId) return true;
    if (run.park.phase === 'restored' || run.park.phase === 'cancelled') return true;
    if (run.park.slotFreedAt) return true;
    if (isTerminalRunStatus(run.status)) return true;
    return this.completeSlotFree(record.runId, run.park, { recovering: true });
  }

  /**
   * Finish a `restore-slot` transition interrupted by a crash.
   *
   * The mirror of {@link repairFreeSlotIntent}. Without it a restore that
   * claimed the slot and crashed before clearing `slotFreedAt` leaves a row
   * bound to a run that every reader still treats as parked-and-freed: fleet
   * refresh skips it, dispatch keeps offering the slot, and the operator's gate
   * stays fenced. Re-driving the idempotent rebind settles both outcomes.
   *
   * Returns false only when the repair should be retried on the next reconcile.
   * A slot a rival took in the meantime is NOT a retry: the record goes back to
   * being an ordinary freed park with the refusal recorded, which is exactly
   * the state a fresh restore attempt starts from, so the marker is dropped.
   */
  private async repairRestoreSlotIntent(record: MachineParkRecord): Promise<boolean> {
    const run = this.deps.getRun(record.runId);
    // Nothing to finish: the run is gone, terminal cleanup cleared the record,
    // or a later operation already settled it.
    if (!run?.park) return true;
    if (run.park.operationId !== record.operationId) return true;
    if (run.park.phase === 'restored' || run.park.phase === 'cancelled') return true;
    if (isTerminalRunStatus(run.status)) return true;
    // Nothing is owed any more, so the marker outlived its transition. Keyed on
    // the obligation rather than the stage list: every stage can be complete and
    // the record still `partial`, because the resume after them failed.
    if (!needsGateParkRestore(run)) return true;
    const availability = await this.slotAcceptsRestore(record.slotId, record.runId);
    if (!availability.ok) {
      await this.recordRestoreRefusal(
        record.runId,
        MachineParkEligibilityCodes.restoreSlotTaken,
        availability.reason,
      );
      return true;
    }
    const operationId = run.park.restoreProgress?.operationId ?? record.operationId;
    const done =
      run.park.restoreProgress?.operationId === operationId
        ? run.park.restoreProgress.completed
        : [];
    // Re-driving stages this attempt already landed costs four record patches
    // and a slot read every reconcile tick, for as long as the park sits
    // unrestored. Keeping the marker is right; repeating finished work is not.
    if (done.includes('rebind') && done.includes('reattach')) {
      return !needsGateParkRestore(this.requireRun(record.runId));
    }
    try {
      // Resumes from the recorded stage. Only the two FLEET-VISIBLE stages are
      // finished here: a crash between them leaves a row bound to a run every
      // reader still treats as freed, or a branch out of its working tree, and
      // both strand the fleet without an operator present. Reacquiring
      // capabilities and relaunching a worker are the operator's restore to
      // ask for, so those stages are left for it — and the marker stays until
      // they land, so nothing reads the restore as finished.
      await this.rebindSlotStage(record.runId, run.park, operationId);
      await this.reattachWorkspaceStage(record.runId, operationId);
    } catch (error) {
      await this.appendError(record.runId, 'resources-restoring', 'slot.rebind', error);
      return false;
    }
    // The marker is dropped only when the record owes nothing at all. Reading
    // the stage list instead dropped it for a record whose stages all landed
    // and whose orchestration resume then failed — a `partial` that still needs
    // a restore, with nothing left on disk to finish it from.
    return !needsGateParkRestore(this.requireRun(record.runId));
  }

  private async settleUnexpectedFailure(
    runId: string,
    phase: MachineParkPhase,
    action: string,
    error: unknown,
    options: { syncGeneration?: boolean } = {},
  ): Promise<void> {
    const run = this.deps.getRun(runId);
    if (!run?.park) {
      console.error(
        `[machine-pause] ${action} for ${runId} failed without a park record: ${messageOf(error)}`,
      );
      return;
    }
    const residuals = await this.observeResiduals(run, run.park);
    const occurredAt = this.deps.now();
    // Bring the record's generation up to the run's — but ONLY for the caller
    // that can legitimately advance it.
    //
    // A restore advances it on purpose: the gate replay takes ownership, and
    // only afterwards can a write throw — the final `patchRecord` persists
    // outside the resume's own catch, so a persistence failure lands here.
    // Cloning the record verbatim would settle `partial` describing a
    // generation that no longer exists, and every retry would then be refused
    // by the preview's GENERATION_CHANGED check and the execute preflight.
    //
    // A PAUSE never advances it, so any bump seen on that path is foreign — a
    // replay or another actor moving the run while it parked. Absorbing it
    // there would defeat the GENERATION_CHANGED check for this record's later
    // restore, which is precisely the drift that check exists to catch.
    const liveGeneration =
      options.syncGeneration === true
        ? (run.engineState?.generation ?? run.park.generation)
        : run.park.generation;
    const next: MachineParkRecord = {
      ...structuredClone(run.park),
      generation: liveGeneration,
      phase,
      residuals,
      updatedAt: occurredAt,
      errors: [
        ...run.park.errors,
        {
          phase,
          action,
          code: 'UNEXPECTED_EFFECT_FAILURE',
          message: messageOf(error),
          occurredAt,
          retryable: true,
        },
      ],
    };
    const updated = this.deps.updatePark(runId, next);
    try {
      await this.deps.persistRun(updated, action);
    } catch (persistError) {
      console.error(
        `[machine-pause] could not persist ${action} failure for ${runId}: ${messageOf(persistError)}`,
      );
    }
    await this.emitRecord(next);
  }

  private requireRun(runId: string): Run {
    const run = this.deps.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }

  private cachePreview(previewId: string, preview: Omit<CachedPreview, 'createdAtMs'>): void {
    this.prunePreviews();
    previewCache.set(previewId, { ...preview, createdAtMs: Date.now() });
    while (previewCache.size > PREVIEW_CACHE_LIMIT)
      previewCache.delete(previewCache.keys().next().value!);
  }

  private requirePreview(previewId: string, kind: CachedPreview['kind']): CachedPreview {
    this.prunePreviews();
    const cached = previewCache.get(previewId);
    if (!cached || cached.kind !== kind)
      throw new Error('preview is missing or expired; preview again');
    return cached;
  }

  private prunePreviews(): void {
    const cutoff = Date.now() - PREVIEW_TTL_MS;
    for (const [id, preview] of previewCache)
      if (preview.createdAtMs < cutoff) previewCache.delete(id);
  }

  private idempotentRecords(operationId: string, machine: string): MachineParkRecord[] {
    return this.deps
      .allRuns()
      .flatMap((run) =>
        run.park?.operationId === operationId && run.park.machine === machine
          ? [structuredClone(run.park)]
          : [],
      )
      .sort((a, b) => a.runId.localeCompare(b.runId));
  }

  private recordsForOperation(operationId: string, machine: string): MachineParkRecord[] {
    return this.idempotentRecords(operationId, machine);
  }

  private async optionalPressure(machine: string): Promise<{ pressure?: ResourcePressureMachine }> {
    const now = Date.now();
    const cached = this.pressureCache.get(machine);
    if (cached?.inFlight) {
      const pressure = await cached.inFlight;
      return pressure ? { pressure } : {};
    }
    if (cached && cached.expiresAt > now) return cached.value ? { pressure: cached.value } : {};
    const inFlight = this.deps.pressure(machine);
    this.pressureCache.set(machine, { expiresAt: now + 1_000, inFlight });
    while (this.pressureCache.size > 16) {
      this.pressureCache.delete(this.pressureCache.keys().next().value!);
    }
    let pressure: ResourcePressureMachine | undefined;
    try {
      pressure = await inFlight;
    } catch (error) {
      this.pressureCache.delete(machine);
      throw error;
    }
    this.pressureCache.set(machine, { expiresAt: Date.now() + 1_000, value: pressure });
    return pressure ? { pressure } : {};
  }
}

export const machineParkingService = new MachineParkingService();

export const machinePausePreview = (params: MachinePausePreviewParams) =>
  machineParkingService.preview(params);
export const machinePauseExecute = (params: MachinePauseExecuteParams) =>
  machineParkingService.execute(params);
export const machinePauseStatus = (machine: string) => machineParkingService.status(machine);
export const machineParkRestoreForGateResolution = (runId: string) =>
  machineParkingService.restoreForGateResolution(runId);
export const machinePauseRestore = (params: MachinePauseRestoreParams) =>
  machineParkingService.restore(params);
function selectPauseRuns(
  runs: Run[],
  fleet: Fleet,
  machine: string,
  selector: MachinePauseSelector,
): Run[] {
  const machineSlots = new Set(
    fleet.slots.filter((slot) => slot.machine === machine).map((slot) => slot.slot),
  );
  const machineRuns = runs.filter(
    (run) =>
      !isTerminalRunStatus(run.status) && Boolean(run.slotId && machineSlots.has(run.slotId)),
  );
  if (selector.kind === 'include') {
    for (const id of selector.runIds) {
      const run = runs.find((candidate) => candidate.id === id);
      if (!run) throw new Error(`Run not found: ${id}`);
      if (!machineRuns.some((candidate) => candidate.id === id)) machineRuns.push(run);
    }
  }
  return machineRuns.sort((a, b) => a.id.localeCompare(b.id));
}

function selectRestoreRuns(runs: Run[], machine: string, selector: MachinePauseSelector): Run[] {
  const parked = runs.filter(
    (run) =>
      run.park?.machine === machine &&
      run.park.phase !== 'restored' &&
      run.park.phase !== 'cancelled',
  );
  if (selector.kind === 'include') {
    for (const id of selector.runIds) {
      if (!parked.some((candidate) => candidate.id === id)) {
        throw new Error(`No machine park record found for run: ${id}`);
      }
    }
  }
  return parked.sort((a, b) => a.id.localeCompare(b.id));
}

function assertExecutablePreview(
  runs: MachinePausePreviewRun[],
  reviewed: MachinePauseReviewedTarget[],
): void {
  const selected = runs.filter((run) => run.selected);
  if (selected.length === 0) throw new Error('machine pause selection resolved to no runs');
  const rejected = selected.filter((run) => !run.eligibility.eligible);
  if (rejected.length > 0) {
    throw new Error(
      `batch rejected before mutation: ${rejected.map((run) => `${run.runId}: ${run.eligibility.reason}`).join('; ')}`,
    );
  }
  assertExactTargets(
    selected.map((run) => ({ runId: run.runId, generation: run.generation })),
    reviewed,
  );
}

function assertExecutableRestore(
  runs: MachinePauseRestorePreviewRun[],
  reviewed: MachinePauseReviewedTarget[],
): void {
  const selected = runs.filter((run) => run.selected);
  if (selected.length === 0) throw new Error('machine restore selection resolved to no runs');
  const rejected = selected.filter((run) => !run.eligibility.eligible);
  if (rejected.length > 0) {
    throw new Error(
      `restore batch rejected before mutation: ${rejected.map((run) => `${run.runId}: ${run.eligibility.reason}`).join('; ')}`,
    );
  }
  assertExactTargets(
    selected.map((run) => ({ runId: run.runId, generation: run.generation })),
    reviewed,
  );
}

function assertReviewedRecords(
  records: MachineParkRecord[],
  reviewed: MachinePauseReviewedTarget[],
  previewId: string,
): void {
  if (records.some((record) => record.previewId !== previewId)) {
    throw new Error('operationId was already used for a different preview');
  }
  assertExactTargets(
    records.map((record) => ({ runId: record.runId, generation: record.generation })),
    reviewed,
  );
}

function assertExactTargets(
  expected: MachinePauseReviewedTarget[],
  actual: MachinePauseReviewedTarget[],
): void {
  const normalize = (items: MachinePauseReviewedTarget[]) =>
    [...items]
      .map((item) => `${item.runId}:${item.generation}`)
      .sort()
      .join('|');
  if (normalize(expected) !== normalize(actual)) {
    throw new Error('reviewedTargets do not exactly match the current preview; refusing widening');
  }
}

function currentRunStep(run: Run): MachineParkCurrentStep | null {
  const index = run.steps.findIndex((step) => step.status === 'running');
  if (index < 0) return null;
  return { index, name: run.steps[index]!.name, status: run.steps[index]!.status };
}

function recoveryHandleKey(runId: string, generation: number): string {
  return `${runId}:${generation}`;
}

function capabilityLeaseBlocksStop(
  lease: RuntimeCapabilityStatusResult['leases'][number],
): boolean {
  return (
    lease.state === 'queued' ||
    lease.state === 'acquiring' ||
    lease.state === 'acquired' ||
    lease.state === 'releasing' ||
    (lease.state === 'error' && Boolean(lease.cleanupFailure))
  );
}

/** One provider's resolved claim on a slot resource, declared or derived. */
interface EffectiveAffectedResource {
  resourceId: string;
  ownership: RuntimeCapabilityAffectedOwnership;
  releaseEffect: RuntimeCapabilityAffectedReleaseEffect;
  /** True when the project catalog stated the claim instead of us deriving it. */
  declared: boolean;
}

/**
 * The claims one provider makes on slot resources. A catalog that declares
 * `affectedResources` is taken at its word, including an empty array. A catalog
 * that omits the field derives exactly what `capabilityProvidersForResource`
 * derived before this metadata existed: every resource named by a resource-kind
 * action ref, owned by the capability and stopped on release.
 */
function effectiveAffectedResources(
  entry: RuntimeCapabilityCatalogEntry,
): EffectiveAffectedResource[] {
  if (entry.affectedResources) {
    return entry.affectedResources.map((claim) => ({
      resourceId: claim.resourceId,
      ownership: claim.ownership,
      releaseEffect: claim.releaseEffect,
      declared: true,
    }));
  }
  const derived = new Map<string, EffectiveAffectedResource>();
  for (const action of Object.values(entry.actions)) {
    if (action.kind !== 'resource') continue;
    derived.set(action.resourceId, {
      resourceId: action.resourceId,
      ownership: 'capability',
      releaseEffect: 'stop',
      declared: false,
    });
  }
  return [...derived.values()];
}

/** Providers claiming `resourceId`, keyed by capability id. */
function capabilityClaimsForResource(
  status: RuntimeCapabilityStatusResult,
  resourceId: string,
): Map<string, EffectiveAffectedResource> {
  const claims = new Map<string, EffectiveAffectedResource>();
  for (const entry of status.catalog) {
    const claim = effectiveAffectedResources(entry).find(
      (candidate) => candidate.resourceId === resourceId,
    );
    if (claim) claims.set(entry.id, claim);
  }
  return claims;
}

/**
 * What parking does to a resource. Every claimant must already agree — a
 * catalog whose providers disagree is refused with `CAPABILITY_CLAIM_CONFLICT`
 * before this runs — so this reports the one agreed effect rather than picking
 * a winner. An unclaimed resource is stopped, which is what parking always did.
 */
function resourceReleaseEffect(
  claims: Map<string, EffectiveAffectedResource>,
): MachineParkResourceReleaseEffect {
  const [first] = claims.values();
  return first?.releaseEffect ?? 'stop';
}

function capabilityProvidersForResource(
  status: RuntimeCapabilityStatusResult,
  resourceId: string,
): Set<string> {
  return new Set(capabilityClaimsForResource(status, resourceId).keys());
}

export function buildMachineParkingContinuationPrompt(
  run: Pick<Run, 'id' | 'project' | 'ticketOrPr' | 'taskFile'>,
  record: MachineParkRecord,
): string {
  const step = record.prePauseCurrentStep;
  return [
    `Continue Farmslot run ${run.id} after machine restore.`,
    `Project: ${run.project}`,
    `Work item: ${run.ticketOrPr}`,
    `Machine: ${record.machine}`,
    `Slot: ${record.slotId}`,
    `Prior orchestration state: ${record.prePauseStatus}`,
    `Prior step: ${step ? `${step.name} (index ${step.index})` : 'monitoring state'}`,
    ...(run.taskFile ? [`Task file: ${run.taskFile}`] : []),
    `Restore operation: ${record.operationId}`,
    'Resume the persisted session from that monitoring step. Do not start a fresh run or repeat completed work.',
  ].join('\n');
}

function selectedBySelector(runId: string, selector: MachinePauseSelector): boolean {
  if (selector.kind === 'all') return true;
  if (selector.kind === 'include') return selector.runIds.includes(runId);
  return !selector.runIds.includes(runId);
}

function operationOutcome(
  records: MachineParkRecord[],
  successPhase: 'parked' | 'restored',
): 'complete' | 'partial' | 'failed' {
  if (records.length === 0) return 'failed';
  const completed = records.filter((record) => record.phase === successPhase).length;
  if (completed === records.length) return 'complete';
  return completed > 0 ? 'partial' : 'failed';
}

function intentFailureRecords(
  records: readonly MachineParkRecord[],
  error: unknown,
  occurredAt: string,
): MachineParkRecord[] {
  return records.map((record) => ({
    ...structuredClone(record),
    phase: 'failed',
    updatedAt: occurredAt,
    errors: [
      ...record.errors,
      {
        phase: 'failed',
        action: 'intent.journal',
        code: 'INTENT_BATCH_NOT_DURABLE',
        message: `zero effects applied: ${messageOf(error)}`,
        occurredAt,
        retryable: true,
      },
    ],
  }));
}

/**
 * A record written by an ADR-054 `free-slot` gate park. Such a park preserves
 * the run's status by design, so the `paused` precondition every other restore
 * relies on never holds for one.
 */
/**
 * Whether this record's restore has to run the freed-slot stages.
 *
 * `slotFreedAt` is the marker a live record carries for exactly this, and it
 * survives until the last stage lands. The second clause is for records written
 * before that was true: they cleared the marker at their first stage, so the
 * only thing left saying the slot was ever freed is the disposition plus the
 * rebind that answered it. Without it those records take the retained path,
 * probe the pane a successor destroyed, and refuse RECOVERY_HANDLE_STALE with
 * no way forward.
 */
function owesFreedSlotStages(record: MachineParkRecord): boolean {
  if (record.slotFreedAt) return true;
  return record.slotDisposition === 'freed' && Boolean(record.slotReboundAt);
}

/**
 * A release park that declared it would free the run's slot. Keyed on the
 * INTENT, because the callers that use it — the preview's `paused` relaxation
 * and the restore preflight — must admit a gate park whose release never
 * landed just as readily as one whose did.
 */
function isGateParkRecord(record: MachineParkRecord): boolean {
  return record.mode === 'release' && record.slotDisposition === 'freed';
}

function zeroEffectIntent(
  run: Run,
  record: MachineParkRecord,
  residuals: MachineParkRecord['residuals'],
): boolean {
  // A gate park preserves the run's status by design, so the status comparison
  // below says nothing about whether it had effects. Its two effects are the
  // workspace detach and the slot release; either one landing means the intent
  // was not zero-effect, and discarding the record would lose the only note of
  // which branch was taken out of the slot's working tree.
  //
  // Keyed on the OBLIGATION rather than on `slotFreedAt` alone, because a
  // record that cleared its freed marker at the rebind — everything written
  // before restores tracked their stages — otherwise reads as a park that never
  // touched anything. Zero-effect repair settles `restored` with no stages and
  // no proof, so choosing it for a record that still owes a restore drops the
  // consumption fence and the next answer skips the restoration entirely. A run
  // that owes a restore has had effects by definition: something freed or
  // re-bound its slot.
  if (needsGateParkRestore({ park: record })) return false;
  if (record.preservedWorkspace?.detachedAt) return false;
  // A released lease is an effect the residuals cannot show. A manifest that is
  // all `retain` resources reports every resource `running` by design, and a
  // lease-only manifest has no resources at all, so without this a park that
  // already gave up its leases would look untouched and its record — the only
  // note of which leases were released — would be deleted.
  if (
    record.resourceManifest.capabilityLeases.some(
      (lease) => lease.state !== 'held' && lease.state !== 'failed',
    )
  ) {
    return false;
  }
  if (run.status !== record.prePauseStatus) return false;
  if (
    record.phase !== 'intent-persisted' &&
    record.phase !== 'orchestration-pausing' &&
    record.phase !== 'failed' &&
    record.phase !== 'partial'
  ) {
    return false;
  }
  return (
    residuals.runner === 'running' &&
    residuals.resources.every((resource) => resource.state === 'running')
  );
}

function zeroEffectRecord(run: Run, record: MachineParkRecord): boolean {
  return zeroEffectIntent(run, record, record.residuals);
}

/**
 * What a settled release park must observe for one manifest resource. A
 * retained resource that stopped is as much a failure as a stopped one that
 * kept running: both mean the park did not do what the catalog claims.
 * Records journalled before the metadata existed carry no `releaseEffect`,
 * and every one of those parks stopped every resource.
 */
function expectedResidualState(resource: MachineParkResource): 'running' | 'stopped' {
  return resource.releaseEffect === 'retain' ? 'running' : 'stopped';
}

function manifestResidualsSettled(
  record: MachineParkRecord,
  residuals: MachineParkRecord['residuals'],
): boolean {
  return record.resourceManifest.resources.every(
    (resource) =>
      residuals.resources.find((candidate) => candidate.resourceId === resource.resourceId)
        ?.state === expectedResidualState(resource),
  );
}

function expectedRestoreRunnerState(record: MachineParkRecord): 'stopped' | 'stopped-or-live' {
  return record.phase === 'parked' ? 'stopped' : 'stopped-or-live';
}

function settledPhase(phase: MachineParkPhase): boolean {
  return phase === 'parked' || phase === 'restored' || phase === 'cancelled';
}

function assertMachine(machine: string): string {
  if (typeof machine !== 'string' || !machine.trim()) throw new Error('machine is required');
  if (machine !== machine.trim()) throw new Error('machine must not have surrounding whitespace');
  return machine;
}

function assertPauseMode(mode: unknown): asserts mode is MachinePauseMode {
  if (!isPauseMode(mode)) {
    throw new Error("mode must be exactly 'orchestration' or 'release'");
  }
}

function isPauseMode(mode: unknown): mode is MachinePauseMode {
  return mode === 'orchestration' || mode === 'release';
}

function assertKnownMachine(machine: string, fleet: Fleet): void {
  if (
    !fleet.slots.some((slot) => slot.machine === machine) &&
    !fleet.machines?.some((candidate) => candidate.machine === machine)
  ) {
    throw new Error(`Machine not found: ${machine}`);
  }
}

function assertSelector(selector: MachinePauseSelector): void {
  if (!selector || !['all', 'include', 'exclude'].includes(selector.kind)) {
    throw new Error('selector must be all, include, or exclude');
  }
  if (selector.kind === 'include' || selector.kind === 'exclude') {
    if (!Array.isArray(selector.runIds)) throw new Error('selector.runIds must be an array');
    if (selector.runIds.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new Error('selector.runIds must contain non-empty run ids');
    }
    if (new Set(selector.runIds).size !== selector.runIds.length) {
      throw new Error('selector.runIds must not contain duplicates');
    }
  }
}

function digestPreview(kind: string, value: unknown): string {
  return `${kind}-${createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 24)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined && key !== 'createdAt' && key !== 'capturedAt')
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lastError(record: MachineParkRecord): string {
  return record.errors.at(-1)?.message ?? `operation stopped in phase '${record.phase}'`;
}
