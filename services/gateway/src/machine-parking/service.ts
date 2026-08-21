import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  Events,
  isTerminalRunStatus,
  type MachineParkCapabilityLease,
  type MachineParkCurrentStep,
  type MachineParkError,
  type MachineParkPhase,
  type MachineParkRecord,
  type MachineParkResourceManifest,
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
import { resolveTmuxSession } from '../core/tmux.js';
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
  writeIntentJournal(kind: MachineParkingIntentKind, records: MachineParkRecord[]): Promise<void>;
  deleteIntentJournal(
    machine: string,
    kind: MachineParkingIntentKind,
    operationId: string,
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

const defaultDependencies: MachineParkingDependencies = {
  now: () => new Date().toISOString(),
  operationId: () => `machine-park-${randomUUID()}`,
  allRuns: getAllRuns,
  getRun,
  loadFleet: loadFleetStatus,
  updatePark: (runId, park) => updateRun(runId, { park }),
  persistRun: persistRunNow,
  writeIntentJournal: (kind, records) => intentJournalStore.write(kind, records),
  deleteIntentJournal: (machine, kind, operationId) =>
    intentJournalStore.delete(machine, kind, operationId),
  loadIntentJournals: defaultLoadIntentJournals,
  emit: broadcast,
  pressure: defaultPressure,
  observeResources: defaultObserveResources,
  capabilityStatus: (slotId, runId) =>
    runtimeCapabilityStatus({ slotId, ...(runId ? { ownerRunId: runId } : {}) }),
  releaseCapability: ({ slotId, runId, leaseId, capabilityId }) =>
    runtimeCapabilityRelease({ slotId, ownerRunId: runId, leaseId, capabilityId }),
  acquireCapability: runtimeCapabilityAcquire,
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
          if (isTerminalRunStatus(run.status)) phase = 'cancelled';
          else if (record.mode === 'orchestration' && run.status === 'paused') phase = 'parked';
          else if (
            record.mode === 'release' &&
            run.status === 'paused' &&
            residuals.runner === 'stopped' &&
            residuals.resources.every((resource) => resource.state === 'stopped')
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
    const base = {
      runId: run.id,
      generation,
      selected,
      slotId: run.slotId,
      status: run.status,
      currentStep,
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
    if (run.status !== 'monitoring' && run.status !== 'ci-watching') {
      return reject(
        'STATUS_NOT_ELIGIBLE',
        `status '${run.status}' is not monitoring or ci-watching`,
      );
    }
    if (!currentStep || (currentStep.name !== 'monitor' && currentStep.name !== 'ci-watch')) {
      return reject('STEP_NOT_IDEMPOTENT', 'run has no active monitor or ci-watch step');
    }
    if (mode === 'orchestration') {
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
        code: 'ELIGIBLE_RELEASE_PAUSE',
        reason: 'The run has an exact reload handle and a restorable observed-running manifest.',
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
        if (run.status !== 'paused')
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

function zeroEffectIntent(
  run: Run,
  record: MachineParkRecord,
  residuals: MachineParkRecord['residuals'],
): boolean {
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
