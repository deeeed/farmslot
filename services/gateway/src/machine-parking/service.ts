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
  type MachineParkResourceManifest,
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
  type MachinePauseReviewedTarget,
  type MachinePauseSelector,
  type MachinePauseStatusResult,
  PipelineSteps,
  type ResourcePressureMachine,
  type Run,
  type RuntimeCapabilityAcquireParams,
  type RuntimeCapabilityAcquireResult,
  type RuntimeCapabilityReleaseResult,
  type RuntimeCapabilityStatusResult,
  type SlotResource,
} from '@farmslot/protocol';

import { selectAgentContext } from '../agents/contexts.js';
import { loadProjectVars, loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { readSlotRow, resetSlotIf, SLOT_PHASE_RELEASING } from '../core/index.js';
import { resolveTmuxSession, shellQuote } from '../core/tmux.js';
import { readMachinePressure } from '../fleet/pressure-read.js';
import {
  executeResourceControl,
  pollSlotResources,
  resolveSlotResources,
} from '../fleet/resource-manager.js';
import { loadFleetStatus } from '../fleet/state.js';
import { resolveDispatchSafetyTier } from '../methods/dispatch/safety-tier.js';
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
  inspectRunnerRecovery,
  reloadRunnerForPark,
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
  const tip = await execOnSlot(
    vars,
    `cd ${repo} && git rev-parse ${shellQuote(workspace.branch)}`,
    {
      timeout: 15_000,
    },
  );
  if (tip.exitCode !== 0 || tip.stdout.trim() !== workspace.headSha) {
    throw new Error(
      `branch '${workspace.branch}' is at ${tip.stdout.trim() || 'unknown'}, not the detached tip ${workspace.headSha}`,
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
          runs: idempotent.map((record) => ({
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
            record,
          })),
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
        runs: records.map((record) => ({
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
          record,
        })),
        records,
        ...(await this.optionalPressure(machine)),
      };
    });
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
            residuals.runner === 'stopped' &&
            residuals.resources.every((resource) => resource.state === 'stopped');
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
    const unsafe = runningResources.find(
      (resource) =>
        resource.definition.controllable &&
        (!resource.definition.hooks?.shutdown || !resource.definition.hooks?.boot),
    );
    if (unsafe) {
      return reject(
        'RESOURCE_HOOKS_UNAVAILABLE',
        `running resource '${unsafe.id}' lacks project-owned shutdown and boot hooks`,
        emptyManifest(),
        handle.runnerId,
      );
    }
    const affected = runningResources.filter(
      (resource) =>
        resource.definition.controllable &&
        Boolean(resource.definition.hooks?.shutdown && resource.definition.hooks?.boot),
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
      const mapped = affected.some((resource) =>
        capabilityProvidersForResource(capabilityStatus, resource.id).has(lease.capabilityId),
      );
      if (selectedLifecycleSlotAction) {
        return reject(
          'CAPABILITY_SLOT_ACTION_UNMAPPED',
          `selected capability '${lease.capabilityId}' uses slot-action acquire/release without explicit affected-resource metadata`,
          emptyManifest(),
          handle.runnerId,
        );
      }
      if (hasSlotAction && !mapped) {
        return reject(
          'CAPABILITY_SLOT_ACTION_UNMAPPED',
          `active capability '${lease.capabilityId}' uses slot actions without a proven managed resource`,
          emptyManifest(),
          handle.runnerId,
        );
      }
    }
    for (const resource of affected) {
      const providerIds = capabilityProvidersForResource(capabilityStatus, resource.id);
      const selectedHolders = activeLeases.filter((lease) => providerIds.has(lease.capabilityId));
      if (providerIds.size > 0 && selectedHolders.length === 0) {
        return reject(
          'CAPABILITY_RESOURCE_UNOWNED',
          `resource '${resource.id}' is capability-backed but not leased by run '${run.id}'`,
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
    for (const residual of residuals.resources) {
      if (residual.state === 'stopped') {
        await this.patchResource(runId, residual.resourceId, {
          phase: 'stopped',
          stoppedAt: this.deps.now(),
          error: undefined,
        });
        continue;
      }
      failed = true;
      await this.appendError(
        runId,
        'resources-stopping',
        'resource.residual',
        new Error(`resource '${residual.resourceId}' remained '${residual.state}'`),
        residual.resourceId,
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
        const reject = (code: string, reason: string): MachinePauseRestorePreviewRun => ({
          runId: run.id,
          generation: run.engineState?.generation ?? 0,
          selected,
          eligibility: { eligible: false, code, reason },
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
            record,
          };
        }
        if (record.slotFreedAt) {
          // Keyed on the FACT, not the intent. Slice 1 frees the slot; restoring
          // into it (in place when still free, otherwise re-dispatch through the
          // affinity path) is the follow-up. Refusing with its own code keeps the
          // verdict honest instead of reporting a slot-ownership drift the record
          // deliberately created.
          //
          // A freeing park that never released anything must NOT land here: it
          // still owns its slot, so the ordinary restore path is exactly right,
          // and refusing it would leave the run with no exit but cancellation.
          return reject(
            MachineParkEligibilityCodes.freedSlotRestoreUnsupported,
            'this park freed the slot; restoring a freed slot is not supported yet',
          );
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
        const slot = fleet.slots.find((candidate) => candidate.slot === record.slotId);
        if (!slot || slot.machine !== machine) {
          return reject(
            'MACHINE_MISMATCH',
            'recorded slot no longer belongs to the selected machine',
          );
        }
        if (record.mode === 'release' && slot.currentRunId !== run.id) {
          return reject('SLOT_OWNERSHIP_CHANGED', 'slot no longer has the reviewed run ownership');
        }
        if (record.mode === 'release' && !record.recoveryHandle) {
          return reject('RECOVERY_HANDLE_MISSING', 'release park has no runner recovery handle');
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
      if (
        (zeroEffect
          ? !current.park || !zeroEffectRecord(current, current.park)
          : current.status !== 'paused') ||
        (current.engineState?.generation ?? 0) !== item.generation ||
        current.slotId !== item.record.slotId ||
        !current.park ||
        stableJson(current.park) !== stableJson(item.record) ||
        !slot ||
        slot.machine !== item.record.machine ||
        (item.record.mode === 'release' && slot.currentRunId !== item.runId)
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
    if (record.mode === 'release') {
      await this.deps.inspectRecoveryHandle(initial, record.recoveryHandle!, expectedRunnerState);
      for (const lease of record.resourceManifest.capabilityLeases) {
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
      let observed = await this.deps.observeResources(record.slotId);
      const observedById = new Map(observed.map((resource) => [resource.id, resource.status]));
      for (const resource of record.resourceManifest.resources) {
        await this.patchResource(runId, resource.resourceId, {
          phase: 'restoring',
          error: undefined,
        });
        try {
          const status = observedById.get(resource.resourceId);
          if (status === 'stopped') {
            const result = await this.deps.startResource(record.slotId, resource.resourceId);
            if (!result.ok) throw new Error(result.detail ?? 'resource boot failed');
            observedById.set(resource.resourceId, 'running');
          } else if (status !== 'running') {
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
      try {
        observed = await this.deps.observeResources(record.slotId);
        const finalById = new Map(observed.map((resource) => [resource.id, resource.status]));
        for (const resource of record.resourceManifest.resources) {
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
      if (!failed) {
        try {
          const runner = await this.deps.runnerRunning(
            this.requireRun(runId),
            record.recoveryHandle!,
          );
          if (runner === 'stopped') {
            await this.patchRecord(runId, (current) => ({
              ...current,
              phase: 'runner-reloading',
            }));
            const current = this.requireRun(runId);
            const proof = await this.deps.reloadRunner(
              current,
              record.recoveryHandle!,
              buildMachineParkingContinuationPrompt(current, current.park!),
            );
            if (
              proof.sessionId !== record.recoveryHandle!.sessionId ||
              !proof.live ||
              proof.acknowledgement.kind !== 'structured'
            ) {
              throw new Error('runner reload proof does not match the persisted recovery handle');
            }
            await this.patchRecord(runId, (park) => ({
              ...park,
              recoveryProof: structuredClone(proof),
            }));
          } else if (runner !== 'running') {
            throw new Error('runner residual state is unknown; refusing an ambiguous reload');
          }
        } catch (error) {
          failed = true;
          await this.appendError(runId, 'runner-reloading', 'runner.reload', error);
        }
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
        if (
          resumeAcknowledgement.run.id !== runId ||
          resumeAcknowledgement.generation <= resumeAcknowledgement.previousGeneration ||
          resumeAcknowledgement.stepName !== record.prePauseCurrentStep?.name
        ) {
          throw new Error('run resume acknowledgement did not match the parked generation/step');
        }
      } catch (error) {
        failed = true;
        await this.appendError(runId, 'orchestration-resuming', 'run.resume', error);
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
  }

  private async observeResiduals(run: Run, record: MachineParkRecord) {
    // Once the slot is freed it belongs to whoever dispatch handed it to.
    // Probing it here would report the SUCCESSOR's runner and providers as this
    // run's residuals, so `machine.pause.status` would show a parked run
    // holding processes it does not own. The record is the authority instead:
    // the free only lands after the runner and every manifest resource were
    // observed stopped, so those observations are what it carries.
    if (record.slotFreedAt) {
      return {
        runner: 'stopped' as const,
        resources: record.resourceManifest.resources.map((resource) => ({
          resourceId: resource.resourceId,
          state: resource.phase === 'stopped' ? ('stopped' as const) : ('unknown' as const),
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
      if (journal.kind === 'free-slot') {
        for (const record of records) {
          if (!(await this.repairFreeSlotIntent(record))) blockedRunIds.add(record.runId);
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
    // Reaching here at all means the marker is still on disk, which is the
    // signal that this transition was INTERRUPTED rather than settled: the live
    // path deletes the marker whenever it refuses and rolls back. So phase is
    // deliberately not consulted — a crash after the release landed leaves a
    // `partial` record that still needs finishing.
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

  private async settleUnexpectedFailure(
    runId: string,
    phase: MachineParkPhase,
    action: string,
    error: unknown,
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
    const next: MachineParkRecord = {
      ...structuredClone(run.park),
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

function capabilityProvidersForResource(
  status: RuntimeCapabilityStatusResult,
  resourceId: string,
): Set<string> {
  return new Set(
    status.catalog
      .filter((entry) =>
        Object.values(entry.actions).some(
          (action) => action.kind === 'resource' && action.resourceId === resourceId,
        ),
      )
      .map((entry) => entry.id),
  );
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
  if (record.slotFreedAt) return false;
  if (record.preservedWorkspace?.detachedAt) return false;
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
