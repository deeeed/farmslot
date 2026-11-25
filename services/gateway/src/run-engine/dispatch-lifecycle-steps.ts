import path from 'node:path';

import {
  Events,
  isTerminalRunStatus,
  type Run,
  type RunPrepareArtifact,
  type TempScrubReceipt,
} from '@farmslot/protocol';

import { loadSlotVars, resolveProjectRuntimeDir, type SlotVars } from '../core/config.js';
import { execArgvOnSlot, execOnSlot, isLocal } from '../core/exec.js';
import { claimSlotStatusIf, nextSlotEpoch, readSlotRow } from '../core/state.js';
import { shellQuote } from '../core/tmux.js';
import { prepareBlindTrialGit } from '../evals/blind-trial.js';
import { usesEvalTrialCapsule } from '../evals/trial-policy.js';
import { dispatchExecute, nudgeDispatch, warmSessionHandoffDispatch } from '../methods/dispatch.js';
import {
  PARENT_HOLD_CLAIM_FIELDS,
  parentHoldForWarmChild,
  slotClaimBlockedByRelease,
} from '../methods/dispatch/slot-scoring.js';
import { slotPrepare } from '../methods/slot.js';
import { parseJsonObject } from '../methods/slot/pinned-prepare.js';
import { PINNED_SKIP_PREPARE_REFUSAL } from '../projects/pinned-prepare-policy.js';
import { ensureFrozenQaSource } from '../qa/frozen-source.js';
import {
  BEFORE_WORKER_LAUNCH,
  WORKER_LAUNCH,
  workerMayHaveStarted,
} from '../run-lifecycle/pre-worker-failure.js';
import { withRunTransition } from '../run-lifecycle/transition-coordinator.js';
import { assertRunnerLaunchPrerequisites } from '../runners/launch-command.js';
import { nudgeNativeWorker } from '../runners/native/worker-nudge.js';
import {
  hostListEligibleLabels,
  hostMarkAccountExhausted,
  hostRecordAccountSuccess,
} from '../runners/provider-account-host.js';
import { normalizeRunner, runnerNeedsPostLaunchPrompt } from '../runners/registry.js';
import {
  getRunnerStatusProvider,
  listRunnerFailoverCandidates,
  resolveRunnerAccountForDispatch,
} from '../runners/status-provider.js';
import {
  createNoEligibleProviderAccountError,
  createProviderUsageLimitError,
  isProviderUsageLimitError,
} from '../runners/usage-limit-error.js';
import { captureHostLoadSnapshot } from '../runs/analytics.js';
import { ensureRunSlotBinding } from '../runs/slot-binding.js';
import { getRun, persistRunNow, updateRun, updateRunStep } from '../runs/store.js';
import { taskExecutionAtDispatch } from '../runs/task-execution.js';

import { prepareConfiguredRunCapabilities } from './declared-capabilities.js';
import { RETAINED_SESSION_HANDOFF_HOLD } from './errors.js';
import { executeEvalHarnessLifecycle } from './eval-harness-lifecycle.js';
import {
  isObservedBuildRun,
  observedBuildFiles,
  observedRunwayArtifact,
  prepareObservesBuild,
  runPrepareIsPinned,
} from './pinned-prepare.js';
import { loadProjectVarsOrNull } from './project-vars.js';
import { probeRemotePath } from './remote-probes.js';
import { runSupersededSince } from './run-generation.js';
import { prepareWarmBudgetBaselineForHandoff } from './run-monitor.js';
import { ensureRunStack } from './stack-base.js';
import { createSubStepCollector, type SubStepCollector } from './sub-step-collector.js';
import { completeRunTaskInitialization } from './task-sync.js';
import { WorkerLaunchInputsChangedError } from './worker-launch-preflight.js';

export interface StepIO {
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

interface PrepareProvenance {
  recipeToolingProvenance?: Record<string, unknown>;
  referenceRepoProvenance?: Record<string, unknown>;
}

function copyDefinedKeys(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) safe[key] = source[key];
  }
  return safe;
}

export function safeRecipeToolingProvenance(
  provenance: Record<string, unknown>,
): Record<string, unknown> {
  const safe = copyDefinedKeys(provenance, [
    'schemaVersion',
    'protocolVersion',
    'runner_protocol_version',
    'status',
    'adapter',
    'compatibilityMode',
  ]);
  const runner =
    provenance.runner && typeof provenance.runner === 'object' && !Array.isArray(provenance.runner)
      ? (provenance.runner as Record<string, unknown>)
      : null;
  if (runner) {
    safe.runner = copyDefinedKeys(runner, [
      'name',
      'packageName',
      'version',
      'packageSource',
      'installKind',
      'linked',
      'global',
      'harnessPackage',
    ]);
  }
  const requiredChecks =
    provenance.requiredChecks &&
    typeof provenance.requiredChecks === 'object' &&
    !Array.isArray(provenance.requiredChecks)
      ? (provenance.requiredChecks as Record<string, unknown>)
      : null;
  if (requiredChecks) {
    safe.requiredChecks = copyDefinedKeys(requiredChecks, ['status', 'total', 'passed', 'failed']);
  }
  return safe;
}

export function safeReferenceRepoProvenance(
  provenance: Record<string, unknown>,
): Record<string, unknown> {
  const repositories = Array.isArray(provenance.repositories)
    ? provenance.repositories
        .filter(
          (repository): repository is Record<string, unknown> =>
            Boolean(repository) && typeof repository === 'object' && !Array.isArray(repository),
        )
        .map((repository) => {
          const safe: Record<string, unknown> = {};
          for (const key of [
            'name',
            'localName',
            'path',
            'requestedBranch',
            'actualBranch',
            'head',
            'dirty',
            'syncStatus',
          ]) {
            if (repository[key] !== undefined) safe[key] = repository[key];
          }
          return safe;
        })
    : [];
  return {
    ...(provenance.version !== undefined ? { version: provenance.version } : {}),
    ...(provenance.recordedAt !== undefined ? { recordedAt: provenance.recordedAt } : {}),
    repositories,
  };
}

/**
 * A JSON object file on a slot, read within 5 s, or undefined when absent, empty or
 * not an object. Optional enrichment only: a malformed file is logged and skipped.
 */
async function readSlotJsonObject(
  vars: SlotVars,
  file: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await execOnSlot(vars, `cat ${shellQuote(file)} 2>/dev/null`, {
    timeout: 5_000,
    maxBuffer: 256 * 1024,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) return undefined;
  const record = parseJsonObject(result.stdout);
  if (!record)
    console.warn(
      `[run-engine] ignoring optional prepare record ${path.basename(file)}: not a JSON object`,
    );
  return record;
}

async function readPrepareProvenance(slotId: string, project: string): Promise<PrepareProvenance> {
  const vars = await loadSlotVars(slotId);
  const runtimeDir = await resolveProjectRuntimeDir(project);
  const readJson = (basename: string) =>
    readSlotJsonObject(vars, `${vars.remoteRepo}/${runtimeDir}/${basename}`);
  const recipeToolingProvenance = await readJson('recipe-tooling-provenance.json');
  const referenceRepoProvenance = await readJson('reference-repos.json');
  return {
    recipeToolingProvenance: recipeToolingProvenance
      ? safeRecipeToolingProvenance(recipeToolingProvenance)
      : undefined,
    referenceRepoProvenance: referenceRepoProvenance
      ? safeReferenceRepoProvenance(referenceRepoProvenance)
      : undefined,
  };
}

/**
 * For an eval trial pinning excludes, the Runway build the slot reports. Isolation
 * moves ignored files into the capsule, so the capsule copy is read when the
 * checkout has none; an explicit runway prepare after isolation rewrites the
 * checkout copy, which therefore wins. Best effort: never fails a prepare.
 */
async function readObservedBuild(
  run: Run,
  slotId: string,
): Promise<RunPrepareArtifact | undefined> {
  const baseSha = run.startRef?.resolvedSha;
  // Lane and flow first, so a run that is neither pinned nor excluded does no new work.
  if (!baseSha || !isObservedBuildRun(run)) return undefined;
  const projectVars = await loadProjectVarsOrNull(run.project, 'observed build', run.id);
  if (!prepareObservesBuild(run, projectVars?.projectJson)) return undefined;
  const vars = await loadSlotVars(slotId);
  const runtimeDir = await resolveProjectRuntimeDir(run.project);
  const capsule = run.engineState?.evalExperiment?.blind?.isolation?.capsulePath;
  for (const file of observedBuildFiles(vars.remoteRepo, runtimeDir, capsule)) {
    const record = await readSlotJsonObject(vars, file);
    if (!record) continue;
    return observedRunwayArtifact(record, {
      slotId,
      baseSha,
      platform: vars.platform,
      ...(vars.resourceVars.simulator ? { simulator: vars.resourceVars.simulator } : {}),
    });
  }
  return undefined;
}

type BroadcastFn = (event: string, payload: unknown) => void;

interface RunEngineFlags {
  skipPrepare?: true;
  warmRecovery?: true;
  nudgeReuse?: true;
  mergeMain?: true;
  warmSessionReuse?: true;
}

/** Stage lines carry this token when a stage shows no change; they say so without being progress. */
const STALL_NOTICE = 'no progress for';
/** A stage line's trailing elapsed time (`, 1m42s`): a heartbeat changes only that. */
const ELAPSED_SUFFIX = /, \d+(?:h\d{2}m|m\d{2}s|s)$/u;

/**
 * Live prepare progress. A named sub-step event (a stage, a parsed `[i/n]`
 * preflight line) updates the step's detail and sub-steps and is the step's
 * last progress when it says something new (not a stall notice or a repeat). Raw output only refreshes
 * `lastOutput`, throttled: output alone does not prove a stage is moving.
 */
export function createPrepareProgressEmitter(params: {
  runId: string;
  inputs: Record<string, unknown>;
  baseOutputs: Record<string, unknown>;
  collector: SubStepCollector;
  stepPartialIO: Map<string, StepIO>;
  broadcastFn: BroadcastFn;
}): (event: string, payload: unknown) => void {
  const { runId, inputs, baseOutputs, collector, stepPartialIO, broadcastFn } = params;
  let lastStreamBroadcast = 0;
  const STREAM_THROTTLE_MS = 1500;
  let lastProgressText: string | undefined;
  return (event: string, payload: unknown) => {
    collector.emit(event, payload);
    const p = payload as
      | { name?: string; detail?: string; stream?: string; measurement?: string }
      | undefined;
    if (p?.name) {
      const gitMeasurement = event === 'slot.prepare.step' && p.measurement === 'git-command';
      // Named step events are infrequent — safe to snapshot + broadcast
      const lo = collector.getLastOutput();
      const outputs: Record<string, unknown> = {
        ...baseOutputs,
        subSteps: collector.snapshot(),
      };
      if (lo) outputs.lastOutput = lo;
      // Progress is a line that says something new: not a stall notice, and not
      // a heartbeat repeating the last line with a later elapsed time.
      const text = (p.detail || p.name).replace(ELAPSED_SUFFIX, '');
      const moved = !gitMeasurement && !text.includes(STALL_NOTICE) && text !== lastProgressText;
      if (moved) lastProgressText = text;
      updateRunStep(runId, 'prepare', {
        ...(!gitMeasurement ? { detail: p.detail || p.name } : {}),
        outputs,
        ...(moved ? { lastProgressAt: new Date().toISOString() } : {}),
      });
      stepPartialIO.set(runId, { inputs, outputs });
      broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
      lastStreamBroadcast = Date.now();
    } else if (p?.stream) {
      // Output events — keep lastOutput fresh + throttled broadcast to UI
      const lo = collector.getLastOutput();
      if (lo) {
        const outputs = { ...stepPartialIO.get(runId)?.outputs, lastOutput: lo };
        stepPartialIO.set(runId, { inputs, outputs });
        const now = Date.now();
        if (now - lastStreamBroadcast >= STREAM_THROTTLE_MS) {
          lastStreamBroadcast = now;
          updateRunStep(runId, 'prepare', { outputs });
          broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
        }
      }
    }
  };
}

/**
 * Records each branch prepare keeps in the step's outputs as it happens, so a prepare that fails
 * later still names it. `baseOutputs` is the progress emitter's: every later event keeps it.
 */
export function keptBranchRecorder(
  runId: string,
  inputs: Record<string, unknown>,
  baseOutputs: Record<string, unknown>,
  stepPartialIO: Map<string, StepIO>,
): (kept: string) => void {
  return (kept) => {
    const recorded = Array.isArray(baseOutputs.keptBranches) ? baseOutputs.keptBranches : [];
    baseOutputs.keptBranches = [...recorded, kept];
    stepPartialIO.set(runId, {
      inputs,
      outputs: { ...stepPartialIO.get(runId)?.outputs, keptBranches: baseOutputs.keptBranches },
    });
  };
}

/**
 * Records the new run's temp/ clear-out in the step's outputs as soon as it ends, so a prepare
 * that refuses or fails later still shows what was removed and kept.
 */
export function tempScrubRecorder(
  runId: string,
  inputs: Record<string, unknown>,
  baseOutputs: Record<string, unknown>,
  stepPartialIO: Map<string, StepIO>,
): (receipt: TempScrubReceipt) => void {
  return (receipt) => {
    baseOutputs.tempScrub = receipt;
    stepPartialIO.set(runId, {
      inputs,
      outputs: { ...stepPartialIO.get(runId)?.outputs, tempScrub: receipt },
    });
  };
}

export interface PrepareStepContext {
  activeMonitors: Map<string, AbortController>;
  broadcastFn: BroadcastFn;
  getRunFlags: (runId: string) => RunEngineFlags | undefined;
  normalizeEvalReplayForTaskWrite: (runId: string, current: Run) => Promise<Run>;
  stepPartialIO: Map<string, StepIO>;
}

/** Fresh worker runs may replace a branch; retries of the same run must reuse it. */
export function shouldForceNewPrepareBranch(run: Run, warmRecovery = false): boolean {
  return (
    (run.flowType === 'fix-bug' || run.flowType === 'dev') &&
    !run.recoveryAttempts?.length &&
    !run.engineState?.prepareBranch?.started &&
    !warmRecovery
  );
}

export async function executePrepareStep(
  runId: string,
  context: PrepareStepContext,
): Promise<StepIO> {
  const {
    activeMonitors,
    broadcastFn,
    getRunFlags,
    normalizeEvalReplayForTaskWrite,
    stepPartialIO,
  } = context;
  // A QA scope that names its commits exactly freezes them the way fetchPRData
  // freezes a PR at write-task: prepare lands on the head and the check below
  // verifies it. Recorded here so a replay lands there too.
  const frozen = ensureFrozenQaSource(runId);
  if (frozen?.qaSource && !frozen.startRef) {
    const head = frozen.qaSource.headSha;
    updateRun(runId, { startRef: { requestedRef: head, source: { kind: 'git-ref', ref: head } } });
  }
  const current = await normalizeEvalReplayForTaskWrite(runId, ensureRunSlotBinding(runId));
  if (!current.slotId) throw new Error('No slot assigned');
  // Normally resolved at write-task; repeated here for runs that brought their own task.
  const stack = (await ensureRunStack(runId)).stack;
  // A replay rebuilds from the recorded commit so the base cannot move under it.
  // A branch name resolves only as a head on origin, never as a same-named tag.
  const stackBaseRef =
    stack && !stack.retargetedTo
      ? (stack.resolvedSha ?? `refs/heads/${stack.baseBranch}`)
      : undefined;
  // pr-complete and update-branch flows leave the merge to the worker so it
  // can resolve conflicts in-session. review-pr checks out the PR branch as
  // pushed; integration with main is informational (TASK.md) unless the
  // operator explicitly passes mergeMain on prepare.
  const flags = getRunFlags(runId);
  // Optional integrate-main for review (merge commit, soft-fail) — off by default.
  const mergeMain = flags?.mergeMain === true;
  if (current.engineState?.evalExperiment && mergeMain)
    throw new Error('Blind trials cannot merge a later branch into their base.');
  const inputs: Record<string, unknown> = {
    slotId: current.slotId,
    branch: current.branch,
    mergeMain,
    flowType: current.flowType,
    app: current.app,
    ...(current.prepareProfile ? { prepareProfile: current.prepareProfile } : {}),
    ...(current.startRef ? { startRef: current.startRef.requestedRef } : {}),
    ...(stackBaseRef ? { stackBase: stackBaseRef } : {}),
  };

  // skipPrepare is the pure binary "run no preparation at all" — the operator
  // owns slot state, no health gating attached (ADR-037 §5). Verified reuse is
  // a prepare profile (e.g. attach) with requires/fallback, not a gated skip.
  // Eval replays must always run prepare because that step installs and
  // verifies the pinned recipe harness; reject before any slot/project lookup
  // so this invariant is hermetic.
  const skipReason = prepareSkipReason(flags?.skipPrepare === true);
  const skipPrepare = skipReason !== null;
  if (skipPrepare && current.engineState?.evalExperiment) {
    throw new Error(
      'Eval replay cannot skip prepare; prepare installs and verifies the pinned recipe harness.',
    );
  }
  const pinned = await runPrepareIsPinned(current);
  if (skipPrepare && pinned) throw new Error(PINNED_SKIP_PREPARE_REFUSAL);
  if (skipPrepare) {
    console.log(`[run-engine] skipping prepare for ${runId.slice(0, 8)} (${skipReason})`);
    await completeRunTaskInitialization(runId);
    return { inputs, outputs: { skipped: true, reason: skipReason } };
  }

  // A record from an earlier prepare must not outlive this one: a prepare that
  // fails, or runs on another slot, would otherwise leave the old build standing.
  if (current.prepareArtifact) {
    await persistRunNow(updateRun(runId, { prepareArtifact: null }), 'prepare artifact cleared');
  }

  // Machine-pressure snapshot at prepare start — the analytics emitter reads this from
  // prepare.outputs.hostLoad. Captured only once prepare actually runs (skip-prepare does no
  // work, so there's no cost to correlate load against). Threaded through every outputs rebuild
  // below so it survives a prepare failure.
  const hostLoad = captureHostLoadSnapshot(current.slotId);

  // Build cliCommand early so it's available on failure too. startRef is
  // passed through the internal prepare options below, but include it in
  // the recorded command string so replay validation can prove the slot did
  // not silently start from current main/default.
  const prepareVars =
    current.engineState?.evalExperiment && current.project.includes('extension')
      ? { watch: 'off' }
      : undefined;
  const cliCommand = `farmslot slot prepare ${current.slotId}${current.branch ? ` --branch ${current.branch}` : ''}${mergeMain ? ' --merge-main' : ''}${current.flowType ? ` --flow-type ${current.flowType}` : ''}${current.app ? ` --app ${current.app}` : ''}${current.startRef ? ` --start-ref ${current.startRef.requestedRef}` : ''}${current.prepareProfile ? ` --prepare-profile ${current.prepareProfile}` : ''}${prepareVars ? ' --var watch=off' : ''}`;

  // Stash partial I/O before the potentially-failing call
  stepPartialIO.set(runId, { inputs, outputs: { cliCommand, hostLoad } });

  // Collect sub-step events and broadcast live progress
  const collector = createSubStepCollector();
  // Shared with the progress emitter, which rebuilds the step's outputs from it on every event.
  const prepareOutputs: Record<string, unknown> = { cliCommand, hostLoad };
  const emitWithBroadcast = createPrepareProgressEmitter({
    runId,
    inputs,
    baseOutputs: prepareOutputs,
    collector,
    stepPartialIO,
    broadcastFn,
  });
  // F2.10 preflight: remote slots must expose tmux/lsof/node on PATH
  // before prepare runs. Failing early with a readable error avoids minutes
  // of confusing "metro up but capture-helper silently dies" diagnostics.
  const pathProbe = await probeRemotePath(current.slotId, current.transport);
  if (!pathProbe.ok) {
    const msg = pathProbe.detail
      ? `Remote PATH probe failed on ${pathProbe.machine}: ${pathProbe.detail}. Run: scripts/audit-remote-path.sh`
      : `Remote PATH missing on ${pathProbe.machine}: ${pathProbe.missing.join(', ')}. Run: scripts/audit-remote-path.sh`;
    console.warn(`[run-engine] ${msg} runId=${runId.slice(0, 8)}`);
    throw new Error(msg);
  }

  // Validate runner launch prerequisites before spending minutes preparing
  // a slot that cannot launch the selected worker binary.
  assertRunnerLaunchPrerequisites(await loadSlotVars(current.slotId), current.metrics.runner);

  // A new fix-bug/dev run owns a fresh branch. A replay from PREPARE owns the
  // existing branch instead: recreating it from main discards the very commits
  // and local evidence the operator is trying to recover.
  const activeRecoveryAttempt = current.recoveryAttempts?.at(-1);
  const isPrepareReplay =
    activeRecoveryAttempt?.stepName === 'prepare' && activeRecoveryAttempt.status === 'started';
  const branchIdentity = current.branch
    ? { slotId: current.slotId, branch: current.branch }
    : undefined;
  const normalSlotTrial =
    current.engineState?.evalExperiment?.blind?.executionPolicy === 'normal-slot';
  if (
    (!isPrepareReplay || normalSlotTrial) &&
    branchIdentity &&
    !current.engineState?.prepareBranch
  ) {
    await persistRunNow(
      updateRun(runId, {
        engineState: {
          ...current.engineState,
          prepareBranch: {
            ...branchIdentity,
            started: false,
          },
        },
      }),
      'prepare branch intent',
    );
  }
  const branchState = getRun(runId)?.engineState?.prepareBranch;
  const allowMissingReplayBranch =
    (isPrepareReplay || normalSlotTrial) &&
    branchState?.slotId === current.slotId &&
    branchState.branch === current.branch &&
    branchState.started === false;
  const warmRecovery = getRunFlags(runId)?.warmRecovery;
  const forceNewBranch = shouldForceNewPrepareBranch(current, warmRecovery);
  const prepareController = new AbortController();
  // activeMonitors[runId] is exclusively owned for the duration of one
  // step; an existing entry orphans the prior controller from cancellation.
  if (activeMonitors.has(runId)) {
    console.warn(
      `[run-engine] activeMonitors overwrite at PREPARE for run ${runId.slice(0, 8)} — prior controller will not receive abort`,
    );
  }
  activeMonitors.set(runId, prepareController);
  let selectedPrepareProfile: import('../methods/slot/shared.js').SlotPrepareResult['profile'];
  let lockfilesRewritten: string[] | undefined;
  let keptBranches: string[] | undefined;
  try {
    const prepareResult = await slotPrepare(
      {
        slotId: current.slotId,
        branch: current.branch || undefined,
        mergeMain,
        forceNewBranch,
        flowType: current.flowType,
        app: current.app,
        domain: current.domain,
        prepareProfile: current.prepareProfile,
        vars: prepareVars,
        runId,
      },
      emitWithBroadcast,
      prepareController.signal,
      {
        requireRunOwnership: true,
        ...(pinned ? { pinned: true } : {}),
        ...(warmRecovery ? { stripClean: true } : {}),
        ...(isPrepareReplay ||
        usesEvalTrialCapsule(current.engineState?.evalExperiment?.blind) ||
        (current.engineState?.evalExperiment && !forceNewBranch)
          ? { preserveBranch: true }
          : {}),
        ...(usesEvalTrialCapsule(current.engineState?.evalExperiment?.blind)
          ? { blindBaseSha: current.engineState?.evalExperiment?.blind?.baseSha }
          : {}),
        // Isolation happens in beforeBranchSetup; read its durable result at capture time.
        get blindRepoKey() {
          return getRun(runId)?.engineState?.evalExperiment?.blind?.isolation?.repoKey;
        },
        allowMissingReplayBranch,
        beforeBranchSetup: branchIdentity
          ? async () => {
              const latest = getRun(runId);
              if (!latest) throw new Error(`Run ${runId} was removed during prepare`);
              await persistRunNow(
                updateRun(runId, {
                  engineState: {
                    ...latest.engineState,
                    prepareBranch: {
                      ...branchIdentity,
                      started: true,
                    },
                  },
                }),
                'prepare branch setup starting',
              );
              await prepareBlindTrialGit(runId, prepareController.signal);
            }
          : undefined,
        // Recorded as it happens, so a prepare that fails later still names the kept branch.
        onBranchKept: keptBranchRecorder(runId, inputs, prepareOutputs, stepPartialIO),
        onTempScrubbed: tempScrubRecorder(runId, inputs, prepareOutputs, stepPartialIO),
        // A replay re-resolves against the commit the run already recorded: a
        // branch or tag name would otherwise move the recorded base under the
        // preserved branch's commits.
        ...(current.startRef
          ? {
              startRef: {
                requestedRef: current.startRef.resolvedSha ?? current.startRef.requestedRef,
              },
            }
          : {}),
        ...(stackBaseRef
          ? {
              stackBase: { requestedRef: stackBaseRef },
              // Recorded before later prepare phases run, so a failed prepare
              // still leaves the base a replay and the diff can use.
              onStackBaseResolved: async (resolution) => {
                const latest = getRun(runId);
                if (!latest?.stack || latest.stack.resolvedSha) return;
                await persistRunNow(
                  updateRun(runId, {
                    stack: { ...latest.stack, resolvedSha: resolution.resolvedSha },
                  }),
                  'stack base resolved',
                );
              },
            }
          : {}),
      },
    );
    // Prepare skips a disabled slot: stop here rather than initialize a task on it.
    if (!prepareResult.prepared)
      throw new Error(`Slot ${current.slotId} is disabled; prepare did not prepare it`);
    selectedPrepareProfile = prepareResult.profile;
    lockfilesRewritten = prepareResult.lockfilesRewritten;
    keptBranches = prepareResult.keptBranches;
    if (current.startRef) {
      if (!prepareResult.startRef) {
        throw new Error('startRef prepare completed without structured resolved provenance');
      }
      updateRun(runId, {
        startRef: {
          ...current.startRef,
          resolvedSha: prepareResult.startRef.resolvedSha,
          resolvedAt: prepareResult.startRef.resolvedAt,
        },
      });
    }
    if (prepareResult.prepareArtifact) {
      await persistRunNow(
        updateRun(runId, {
          prepareArtifact: {
            ...prepareResult.prepareArtifact,
            slotId: current.slotId,
            enforced: true,
          },
        }),
        'pinned build recorded',
      );
    } else {
      try {
        const observed = await readObservedBuild(getRun(runId)!, current.slotId);
        if (observed)
          await persistRunNow(
            updateRun(runId, { prepareArtifact: observed }),
            'observed build recorded',
          );
      } catch (error) {
        console.warn(
          `[run-engine] observed build not recorded for ${runId.slice(0, 8)}: ${(error as Error).message.slice(0, 200)}`,
        );
      }
    }
    const afterPrepare = getRun(runId)!;
    if (afterPrepare.flowType === 'qa' && afterPrepare.qaSource) {
      const frozenHead = afterPrepare.qaSource.headSha;
      const vars = await loadSlotVars(current.slotId);
      const head = await execArgvOnSlot(vars, ['git', 'rev-parse', 'HEAD']);
      const prepared = head.exitCode === 0 ? head.stdout.trim() : 'an unreadable HEAD';
      if (prepared !== frozenHead)
        throw new Error(
          `Prepared QA checkout ${prepared} differs from the frozen head ${frozenHead}`,
        );
    }
    if (afterPrepare.engineState?.evalExperiment) {
      emitWithBroadcast('substep', {
        name: 'recipe-harness-verify',
        detail: 'Verifying eval recipe harness',
      });
      await executeEvalHarnessLifecycle(afterPrepare, 'verify');
    }
  } finally {
    activeMonitors.delete(runId);
  }
  // The node producer imports project tooling from this prepared checkout.
  await completeRunTaskInitialization(runId, { emit: emitWithBroadcast });

  stepPartialIO.delete(runId);
  // Enrich with slot metadata
  let machine: string | undefined;
  let platform: string | undefined;
  let local: boolean | undefined;
  let provenance: PrepareProvenance = {};
  try {
    const vars = await loadSlotVars(current.slotId);
    machine = vars.machine;
    platform = vars.platform;
    local = isLocal(vars.host, vars.machine);
    provenance = await readPrepareProvenance(current.slotId, current.project);
  } catch (err) {
    // Slot metadata and prepare provenance are enrichment only; preserve the
    // successful PREPARE result while surfacing why either is missing.
    console.warn(
      `[run-engine] prepare metadata/provenance lookup failed for ${runId.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
    );
  }

  const lastOutput = collector.getLastOutput();
  const preparedRun = getRun(runId);
  return {
    inputs,
    outputs: {
      success: true,
      subSteps: collector.finish(),
      hostLoad,
      machine,
      platform,
      isLocal: local,
      ...(provenance.recipeToolingProvenance
        ? { recipeToolingProvenance: provenance.recipeToolingProvenance }
        : {}),
      ...(provenance.referenceRepoProvenance
        ? { referenceRepoProvenance: provenance.referenceRepoProvenance }
        : {}),
      cliCommand,
      ...(selectedPrepareProfile ? { profile: selectedPrepareProfile } : {}),
      // Lockfiles prepare rewrote for a drifted PR branch: the worker must commit them.
      ...(lockfilesRewritten?.length ? { lockfilesRewritten } : {}),
      ...(keptBranches?.length ? { keptBranches } : {}),
      // Recorded once, as the clear-out ended (tempScrubRecorder).
      ...(prepareOutputs.tempScrub ? { tempScrub: prepareOutputs.tempScrub } : {}),
      ...(preparedRun?.startRef ? { startRef: preparedRun.startRef } : {}),
      ...(lastOutput ? { lastOutput } : {}),
    },
  };
}

export function prepareSkipReason(operatorSkip: boolean): 'operator-skip' | null {
  return operatorSkip ? 'operator-skip' : null;
}

export interface DispatchStepContext {
  stepPartialIO: Map<string, StepIO>;
  blockedRunError: (message: string, reason: string) => Error;
}

/** Warm delivery consumes its reservation on success. A fresh launch needs its own claim first. */
export async function claimWarmFallbackSlot(run: Run, slotId: string): Promise<boolean> {
  const generation = run.engineState?.generation ?? 0;
  return withRunTransition(run.id, async () => {
    const current = getRun(run.id);
    if (!current || current.slotId !== slotId || runSupersededSince(current, generation))
      return false;
    const blockedSlot = (slot: Readonly<Record<string, unknown>>) =>
      Boolean(
        (slot.handoff_run_id && slot.handoff_run_id !== run.id) ||
        slot.cleanup_run_id ||
        slot.workspace_recovery ||
        slot.lifecycle === 'disabled' ||
        slot.lifecycle === 'manual' ||
        slotClaimBlockedByRelease(slot),
      );
    const row = await readSlotRow(slotId);
    // The parent's cleanup held the slot for this run: the fresh launch claims it from here.
    if (parentHoldForWarmChild(row, current)) {
      const heldFields: Record<string, unknown> = {
        lifecycle: 'busy',
        phase: 'dispatching',
        current_run_id: run.id,
        handoff_run_id: null,
        ...PARENT_HOLD_CLAIM_FIELDS,
      };
      const held = await claimSlotStatusIf(
        slotId,
        (slot) => {
          const latest = getRun(run.id);
          if (
            !latest ||
            latest.slotId !== slotId ||
            runSupersededSince(latest, generation) ||
            !parentHoldForWarmChild(slot, latest)
          )
            return false;
          if (slot.idle_devserver_epoch === slot.slot_epoch && Array.isArray(slot.idle_devservers))
            heldFields.idle_devserver_epoch = nextSlotEpoch(slot);
          return true;
        },
        heldFields,
      );
      return held.claimed;
    }
    if (row && blockedSlot(row)) return false;
    // A replay or a completed release may already have left the slot owned by
    // this run or free. The normal fresh launch path handles either state.
    if (!row?.current_run_id || row.current_run_id === run.id) return true;
    const parentId = current.parentRunId;
    const fields: Record<string, unknown> = { current_run_id: run.id, handoff_run_id: null };
    const claim = await claimSlotStatusIf(
      slotId,
      (slot) => {
        const latest = getRun(run.id);
        const parent = parentId ? getRun(parentId) : undefined;
        if (
          !parent ||
          !isTerminalRunStatus(parent.status) ||
          parent.slotId !== slotId ||
          runSupersededSince(latest, generation) ||
          latest?.slotId !== slotId ||
          latest?.parentRunId !== parentId ||
          slot.current_run_id !== parentId ||
          slot.handoff_run_id !== run.id ||
          blockedSlot(slot)
        )
          return false;
        if (slot.idle_devserver_epoch === slot.slot_epoch && Array.isArray(slot.idle_devservers))
          fields.idle_devserver_epoch = nextSlotEpoch(slot);
        return true;
      },
      fields,
    );
    return claim.claimed;
  });
}

export async function executeDispatchStep(
  runId: string,
  context: DispatchStepContext,
): Promise<StepIO> {
  const { blockedRunError, stepPartialIO } = context;
  const entry = ensureRunSlotBinding(runId);
  stepPartialIO.set(runId, {
    outputs: { failedPhase: workerMayHaveStarted(entry) ? WORKER_LAUNCH : BEFORE_WORKER_LAUNCH },
  });
  const onLaunchAttempt = () => {
    const io = stepPartialIO.get(runId);
    stepPartialIO.set(runId, { ...io, outputs: { ...io?.outputs, failedPhase: WORKER_LAUNCH } });
  };
  // Restore the slot binding first: update-branch has no PREPARE step, and restart
  // recovery can mark one done before its task initialized.
  await completeRunTaskInitialization(runId, { onlyPending: true });
  const bound = ensureRunSlotBinding(runId);
  const taskExecution = taskExecutionAtDispatch(bound);
  // Every delivery branch below spreads `current.engineState`, so record first.
  const current = taskExecution
    ? updateRun(runId, { engineState: { ...bound.engineState, taskExecution } })
    : bound;
  if (!current.slotId) throw new Error('No slot assigned');
  if (!current.taskFile) throw new Error('No task file specified');
  const activationBaseline = current.steps.find((step) => step.name === 'dispatch')?.inputs
    ?.activationDispatchBaseline;
  const preserveDispatchBaseline =
    typeof activationBaseline === 'string' && activationBaseline === current.worktreeHeadAtDispatch;
  const inputs: Record<string, unknown> = {
    ...(preserveDispatchBaseline ? { activationDispatchBaseline: activationBaseline } : {}),
    slotId: current.slotId,
    runner: current.metrics.runner,
    model: current.metrics.model,
    taskFile: current.taskFile,
    app: current.app,
  };

  if (current.parentRunId) {
    // All delivery modes pass here, including skip-prepare and warm handoffs.
    // Qualify/stage only after task initialization and before worker execution.
    const { stageInheritedAcceptance } = await import('../run-completion/inherited-acceptance.js');
    await stageInheritedAcceptance(current, await loadSlotVars(current.slotId));
  }

  if (current.engineState?.flags?.warmSessionReuse || current.engineState?.flags?.nudgeReuse)
    await prepareConfiguredRunCapabilities(runId);

  // CI-watch warm-session handoff — parent finalize kept the worker alive through
  // ci-watch. Prefer handing the follow-up TASK.md into that session; fall through
  // to fresh dispatchExecute when the process is dead, runner/model swapped, or
  // the runner cannot accept tmux instructions (MANUAL-000065 / MANUAL-000043).
  if (current.engineState?.flags?.warmSessionReuse) {
    onLaunchAttempt(); // Reusing an existing worker retains its checkout on uncertainty.
    const baselineStatus = await prepareWarmBudgetBaselineForHandoff(runId, current.slotId);
    if (baselineStatus === 'unavailable') {
      console.warn(
        `[run-engine] run ${runId.slice(0, 8)} — warm session budget baseline unavailable; falling back to fresh dispatch`,
      );
      updateRun(runId, {
        monitorState: undefined,
        engineState: {
          ...current.engineState,
          flags: {
            ...current.engineState?.flags,
            warmSessionReuse: true,
            warmHandoffSucceeded: false,
          },
        },
      });
    } else {
      const collector = createSubStepCollector();
      const dispatchStart = Date.now();
      const result = await warmSessionHandoffDispatch(
        {
          slotId: current.slotId,
          taskFile: current.taskFile,
          runId,
          ticketOrPr: current.ticketOrPr,
          flowType: current.flowType,
          parentRunId: current.parentRunId,
          runner: current.metrics.runner,
          model: current.metrics.model,
        },
        collector.emit,
      );
      if (result.handedOff) {
        const subSteps = collector.finish();
        updateRun(runId, {
          activeTaskFile: current.taskFile ?? undefined,
          metrics: {
            ...current.metrics,
            runner: result.runner,
            ...(result.model ? { model: result.model } : {}),
          },
          engineState: {
            ...current.engineState,
            flags: {
              ...current.engineState?.flags,
              warmSessionReuse: true,
              warmHandoffSucceeded: true,
            },
          },
        });
        return {
          inputs,
          outputs: {
            success: true,
            warmHandoff: true,
            workerTarget: result.workerTarget,
            ...(result.nativeSession ? { nativeSession: result.nativeSession } : {}),
            subSteps,
            readinessWaitMs: Date.now() - dispatchStart,
            runner: result.runner,
            model: result.model,
          },
        };
      }
      if (result.disposition === 'hold') {
        throw blockedRunError(
          `Retained session handoff requires operator attention: ${result.reason}`,
          RETAINED_SESSION_HANDOFF_HOLD,
        );
      }
      console.log(
        `[run-engine] run ${runId.slice(0, 8)} — warm session handoff skipped (${result.reason}); falling back to fresh dispatch`,
      );
      // Keep warmSessionReuse for observability (request recorded) but mark that
      // the handoff did not succeed so soft-budget baseline does not treat the
      // fresh session as a warm parent transcript.
      updateRun(runId, {
        monitorState: undefined,
        engineState: {
          ...current.engineState,
          flags: {
            ...current.engineState?.flags,
            warmSessionReuse: true,
            warmHandoffSucceeded: false,
          },
        },
      });
    }
    if (!(await claimWarmFallbackSlot(current, current.slotId)))
      throw blockedRunError(
        `Slot ${current.slotId}: the CI follow-up could not acquire its reserved slot for fresh dispatch`,
        RETAINED_SESSION_HANDOFF_HOLD,
      );
  }

  // Branch-affinity nudge — set by the wizard via run.create or by the decision card in
  // FIND_SLOT. Skip dispatchExecute entirely: no pane teardown, no relaunch. nudgeDispatch
  // copies TASK.md and sends the read+execute prompt into the existing tmux session via
  // sendRunnerInstructionSafely(forceBusyPoll: true), preserving the worker's loaded PR
  // context. The runner / model recorded on the run is informational here — the actual
  // runner is whatever's already running in the slot's role window.
  if (current.engineState?.flags?.nudgeReuse) {
    onLaunchAttempt();
    // Defensive narrow: nudgeDispatch's signature accepts only PR-bound flow types,
    // and runCreate already rejects nudgeReuse for any other flow — re-assert here so
    // a future code path that sets the flag without going through runCreate still
    // fails loudly instead of silently converting an unsupported flow to pr-complete.
    if (current.flowType !== 'pr-complete' && current.flowType !== 'review-pr') {
      throw new Error(`nudgeReuse set on unsupported flow '${current.flowType}'`);
    }
    const collector = createSubStepCollector();
    const dispatchStart = Date.now();
    if (current.transport === 'native') {
      const result = await nudgeNativeWorker(runId, collector.emit);
      updateRun(runId, { activeTaskFile: result.taskFile ?? undefined });
      return {
        inputs,
        outputs: {
          success: true,
          ...result,
          subSteps: collector.finish(),
          readinessWaitMs: Date.now() - dispatchStart,
        },
      };
    }
    const result = await nudgeDispatch(
      {
        slotId: current.slotId,
        taskFile: current.taskFile,
        runId,
        ticketOrPr: current.ticketOrPr,
        flowType: current.flowType,
        // PR head branch the wizard / decision card authorized — feeds nudgeDispatch's
        // runtime drift-check so a slot that flipped branches between FIND_SLOT and
        // DISPATCH fails loudly instead of nudging the wrong worker.
        targetBranch: current.branch ?? null,
      },
      collector.emit,
    );
    const subSteps = collector.finish();
    // Pin run metrics to the actual slot runner BEFORE entering MONITOR. The wizard
    // sends its global runner/model selector with run.create; if those don't match the
    // slot's running worker (e.g. wizard had codex selected but the reusable slot is
    // claude), monitorRun would call `runnerProcessPattern` / `runnerSupportsTmuxNudges`
    // against the wrong runner and either fail liveness checks or send mid-task nudges
    // through the wrong pane semantics. nudgeDispatch already validated runner against
    // the slot — adopt its truth as the run's truth from this step forward.
    updateRun(runId, {
      activeTaskFile: current.taskFile ?? undefined,
      metrics: {
        ...current.metrics,
        runner: result.runner,
        ...(result.model ? { model: result.model } : {}),
      },
    });
    return {
      inputs,
      outputs: {
        success: true,
        nudged: true,
        workerTarget: result.workerTarget,
        subSteps,
        readinessWaitMs: Date.now() - dispatchStart,
        runner: result.runner,
        model: result.model,
      },
    };
  }

  // Build cliCommand early so it's available on failure too. Public run dispatch goes
  // through run.create; task files are a first-class source for that entry point.
  const cliCommandParts = [
    'farmslot',
    'run',
    'create',
    '--slot',
    shellQuote(current.slotId),
    '--task',
    shellQuote(current.taskFile),
    '--skip-prepare',
  ];
  if (current.metrics.runner) cliCommandParts.push('--runner', shellQuote(current.metrics.runner));
  if (current.metrics.model) cliCommandParts.push('--model', shellQuote(current.metrics.model));
  if (current.transport === 'native') cliCommandParts.push('--transport', 'native');
  if (current.app) cliCommandParts.push('--app', shellQuote(current.app));
  const cliCommand = cliCommandParts.join(' ');

  // Stash partial I/O before the potentially-failing call
  stepPartialIO.set(runId, {
    inputs,
    outputs: { ...stepPartialIO.get(runId)?.outputs, cliCommand },
  });

  // Collect sub-step events instead of discarding them
  const collector = createSubStepCollector();
  const dispatchStart = Date.now();

  // Provider subscription rotation: only when RunnerStatusProvider.supportsAccountBinding.
  // Eligibility + ledger live on the execution host (node-local multi-node safe).
  const runnerId = normalizeRunner(current.metrics.runner);
  const statusProvider = getRunnerStatusProvider(runnerId);
  // Native dispatch pins its account with the durable session reservation. Retrying an
  // already-accepted native task must not run a new quota/failover selection first.
  const supportsBind =
    current.transport !== 'native' && Boolean(statusProvider?.supportsAccountBinding);
  const triedLabels: string[] = [];
  let rebindDone = false;
  let forcedLabel: string | undefined;
  let dispatchResult: Awaited<ReturnType<typeof dispatchExecute>>;
  const slotVars = supportsBind ? await loadSlotVars(current.slotId) : null;

  if (supportsBind && slotVars) {
    const eligible = await listRunnerFailoverCandidates({
      vars: slotVars,
      runnerId,
    });
    if (!eligible.length) {
      const listed = await hostListEligibleLabels({ vars: slotVars, provider: runnerId });
      throw createNoEligibleProviderAccountError({
        triedLabels: listed.all.length ? listed.all : ['ambient'],
        earliestExpiry: listed.earliestExpiry,
        provider: runnerId,
      });
    }
    const preferred = await resolveRunnerAccountForDispatch({
      vars: slotVars,
      runnerId,
      slotId: current.slotId,
    });
    const preferredLabel = preferred?.bind.accountLabel;
    forcedLabel =
      preferredLabel && eligible.includes(preferredLabel) ? preferredLabel : eligible[0];
  }

  // A configuration reload during preflight (a pool or project rewrite) refuses before the task
  // reaches a worker (a runner already started is stopped first, an unsent native reservation
  // forgets its launch); the dispatch re-reads its inputs and checks once more instead of failing.
  let launchInputsRetried = false;
  for (;;) {
    if (forcedLabel && !triedLabels.includes(forcedLabel)) triedLabels.push(forcedLabel);
    try {
      dispatchResult = await dispatchExecute(
        {
          slotId: current.slotId,
          taskFile: current.taskFile,
          runId,
          skipPrepare: true,
          mode: current.mode,
          model: current.metrics.model || undefined,
          runner: current.metrics.runner || undefined,
          scripted: current.scripted,
          effort: current.effort,
          app: current.app,
          providerAccountLabel: forcedLabel,
        },
        collector.emit,
        {
          preparationRan: current.engineState?.flags?.skipPrepare !== true,
          preserveDispatchBaseline,
          onLaunchAttempt,
        },
      );
      if (forcedLabel && slotVars) {
        await hostRecordAccountSuccess({ vars: slotVars, label: forcedLabel });
      }
      break;
    } catch (err) {
      if (err instanceof WorkerLaunchInputsChangedError && !launchInputsRetried) {
        launchInputsRetried = true;
        console.warn(
          `[dispatch] run ${runId.slice(0, 8)}: launch inputs changed during preflight; dispatching once more with the current configuration`,
        );
        collector.emit('dispatch.step', {
          name: 'preflight-retry',
          detail: 'Launch inputs changed during preflight; re-reading them and checking again',
        });
        continue;
      }
      if (!supportsBind || !isProviderUsageLimitError(err) || !slotVars) {
        throw err;
      }
      const failedLabel = err.accountLabel || forcedLabel || 'ambient';
      await hostMarkAccountExhausted({
        vars: slotVars,
        label: failedLabel,
        provider: runnerId,
      });
      console.log(
        `[dispatch] usage-limit on account '${failedLabel}' machine=${slotVars.machine} runner=${runnerId} run=${runId} (rebindDone=${rebindDone})`,
      );

      if (rebindDone) {
        const listed = await hostListEligibleLabels({
          vars: slotVars,
          provider: runnerId,
          exclude: [],
        });
        throw createProviderUsageLimitError({
          accountLabel: failedLabel,
          provider: runnerId,
          summary: `Provider usage limit after one rebind. Second account also exhausted.`,
          triedLabels: [...new Set(triedLabels)],
          earliestExpiry: listed.earliestExpiry,
        });
      }

      const eligible = await listRunnerFailoverCandidates({
        vars: slotVars,
        runnerId,
        exclude: triedLabels,
      });
      const nextLabel = eligible.find((l) => l !== failedLabel) ?? eligible[0];
      if (!nextLabel) {
        const tried = [...new Set(triedLabels)];
        const listed = await hostListEligibleLabels({
          vars: slotVars,
          provider: runnerId,
          exclude: [],
        });
        throw createNoEligibleProviderAccountError({
          triedLabels: tried,
          earliestExpiry: listed.earliestExpiry,
          provider: runnerId,
        });
      }

      rebindDone = true;
      forcedLabel = nextLabel;
      console.log(
        `[dispatch] rebinding slot ${current.slotId} run ${runId} runner=${runnerId} to provider account '${forcedLabel}' on ${slotVars.machine}`,
      );
    }
  }

  stepPartialIO.delete(runId);
  const subSteps = collector.finish();
  const launchCommand = dispatchResult!.launchCommand;

  // Mark TASK.md as the active task file for progress tracking
  updateRun(runId, { activeTaskFile: current.taskFile ?? undefined });

  return {
    inputs,
    outputs: {
      success: true,
      subSteps,
      readinessWaitMs: Date.now() - dispatchStart,
      promptSent: runnerNeedsPostLaunchPrompt(current.metrics.runner),
      launchCommand,
      cliCommand,
      providerAccountLabel: forcedLabel,
      providerAccountTried: triedLabels,
    },
  };
}
