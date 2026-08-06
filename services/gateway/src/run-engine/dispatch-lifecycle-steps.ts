import { Events, type Run } from '@farmslot/protocol';

import { loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { dispatchExecute, nudgeDispatch, warmSessionHandoffDispatch } from '../methods/dispatch.js';
import { slotPrepare } from '../methods/slot.js';
import { assertRunnerLaunchPrerequisites } from '../runners/launch-command.js';
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
import { getRun, updateRun, updateRunStep } from '../runs/store.js';

import { executeEvalHarnessLifecycle } from './eval-harness-lifecycle.js';
import { probeRemotePath } from './remote-probes.js';
import { createSubStepCollector } from './sub-step-collector.js';

interface StepIO {
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

async function readPrepareProvenance(slotId: string, project: string): Promise<PrepareProvenance> {
  const vars = await loadSlotVars(slotId);
  const runtimeDir = await resolveProjectRuntimeDir(project);
  const readJson = async (basename: string): Promise<Record<string, unknown> | undefined> => {
    const result = await execOnSlot(
      vars,
      `cat ${shellQuote(`${vars.remoteRepo}/${runtimeDir}/${basename}`)} 2>/dev/null`,
      { timeout: 5_000, maxBuffer: 256 * 1024 },
    );
    if (result.exitCode !== 0 || !result.stdout.trim()) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      // Each provenance file is optional enrichment. A malformed file must not
      // prevent the other independent provenance source from being preserved.
      console.warn(
        `[run-engine] ignoring malformed optional prepare provenance ${basename}: ${(error as Error).message}`,
      );
      return undefined;
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  };
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

type BroadcastFn = (event: string, payload: unknown) => void;

interface RunEngineFlags {
  skipPrepare?: true;
  warmRecovery?: true;
  nudgeReuse?: true;
  mergeMain?: true;
  warmSessionReuse?: true;
}

export interface PrepareStepContext {
  activeMonitors: Map<string, AbortController>;
  broadcastFn: BroadcastFn;
  getRunFlags: (runId: string) => RunEngineFlags | undefined;
  normalizeEvalReplayForTaskWrite: (runId: string, current: Run) => Promise<Run>;
  stepPartialIO: Map<string, StepIO>;
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
  const current = await normalizeEvalReplayForTaskWrite(runId, ensureRunSlotBinding(runId));
  if (!current.slotId) throw new Error('No slot assigned');
  // pr-complete and update-branch flows leave the merge to the worker so it
  // can resolve conflicts in-session. review-pr checks out the PR branch as
  // pushed; integration with main is informational (TASK.md) unless the
  // operator explicitly passes mergeMain on prepare.
  const flags = getRunFlags(runId);
  // Optional integrate-main for review (merge commit, soft-fail) — off by default.
  const mergeMain = flags?.mergeMain === true;
  const inputs: Record<string, unknown> = {
    slotId: current.slotId,
    branch: current.branch,
    mergeMain,
    flowType: current.flowType,
    app: current.app,
    ...(current.prepareProfile ? { prepareProfile: current.prepareProfile } : {}),
    ...(current.startRef ? { startRef: current.startRef.requestedRef } : {}),
  };

  // skipPrepare is the pure binary "run no preparation at all" — the operator
  // owns slot state, no health gating attached (ADR-037 §5). Verified reuse is
  // a prepare profile (e.g. attach) with requires/fallback, not a gated skip.
  // Eval replays must always run prepare because that step installs and
  // verifies the pinned recipe harness; reject before any slot/project lookup
  // so this invariant is hermetic.
  const skipPrepare = flags?.skipPrepare === true;
  if (skipPrepare && current.engineState?.evalExperiment) {
    throw new Error(
      'Eval replay cannot skip prepare; prepare installs and verifies the pinned recipe harness.',
    );
  }
  if (skipPrepare) {
    console.log(`[run-engine] skipping prepare for ${runId.slice(0, 8)} (operator skip)`);
    return { inputs, outputs: { skipped: true, reason: 'operator-skip' } };
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
  let lastStreamBroadcast = 0;
  const STREAM_THROTTLE_MS = 1500;
  const emitWithBroadcast = (event: string, payload: unknown) => {
    collector.emit(event, payload);
    const p = payload as { name?: string; detail?: string; stream?: string } | undefined;
    if (p?.name) {
      // Named step events are infrequent — safe to snapshot + broadcast
      const lo = collector.getLastOutput();
      const outputs: Record<string, unknown> = {
        cliCommand,
        hostLoad,
        subSteps: collector.snapshot(),
      };
      if (lo) outputs.lastOutput = lo;
      updateRunStep(runId, 'prepare', { detail: p.detail || p.name, outputs });
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
  // F2.10 preflight: remote slots must expose tmux/lsof/node on PATH
  // before prepare runs. Failing early with a readable error avoids minutes
  // of confusing "metro up but capture-helper silently dies" diagnostics.
  const pathProbe = await probeRemotePath(current.slotId);
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
  const forceNewBranch =
    !isPrepareReplay && (current.flowType === 'fix-bug' || current.flowType === 'dev');
  const prepareController = new AbortController();
  // activeMonitors[runId] is exclusively owned for the duration of one
  // step; an existing entry orphans the prior controller from cancellation.
  if (activeMonitors.has(runId)) {
    console.warn(
      `[run-engine] activeMonitors overwrite at PREPARE for run ${runId.slice(0, 8)} — prior controller will not receive abort`,
    );
  }
  activeMonitors.set(runId, prepareController);
  const warmRecovery = getRunFlags(runId)?.warmRecovery;
  let selectedPrepareProfile: import('../methods/slot/shared.js').SlotPrepareResult['profile'];
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
        ...(warmRecovery ? { stripClean: true } : {}),
        ...(isPrepareReplay ? { preserveBranch: true } : {}),
        ...(current.startRef ? { startRef: { requestedRef: current.startRef.requestedRef } } : {}),
      },
    );
    selectedPrepareProfile = prepareResult.profile;
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
    const afterPrepare = getRun(runId)!;
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
      ...(preparedRun?.startRef ? { startRef: preparedRun.startRef } : {}),
      ...(lastOutput ? { lastOutput } : {}),
    },
  };
}

export interface DispatchStepContext {
  stepPartialIO: Map<string, StepIO>;
  blockedRunError: (message: string, reason: string) => Error;
}

export async function executeDispatchStep(
  runId: string,
  context: DispatchStepContext,
): Promise<StepIO> {
  const { blockedRunError, stepPartialIO } = context;
  const current = ensureRunSlotBinding(runId);
  if (!current.slotId) throw new Error('No slot assigned');
  if (!current.taskFile) throw new Error('No task file specified');
  const inputs: Record<string, unknown> = {
    slotId: current.slotId,
    runner: current.metrics.runner,
    model: current.metrics.model,
    taskFile: current.taskFile,
    app: current.app,
  };

  // CI-watch warm-session handoff — parent finalize kept the worker alive through
  // ci-watch. Prefer handing the follow-up TASK.md into that session; fall through
  // to fresh dispatchExecute when the process is dead, runner/model swapped, or
  // the runner cannot accept tmux instructions (MANUAL-000065 / MANUAL-000043).
  if (current.engineState?.flags?.warmSessionReuse) {
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
      });
      return {
        inputs,
        outputs: {
          success: true,
          warmHandoff: true,
          workerTarget: result.workerTarget,
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
        'retained-session-handoff',
      );
    }
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — warm session handoff skipped (${result.reason}); falling back to fresh dispatch`,
    );
    // Leave warmSessionReuse set for observability; fresh path ignores it.
  }

  // Branch-affinity nudge — set by the wizard via run.create or by the decision card in
  // FIND_SLOT. Skip dispatchExecute entirely: no pane teardown, no relaunch. nudgeDispatch
  // copies TASK.md and sends the read+execute prompt into the existing tmux session via
  // sendRunnerInstructionSafely(forceBusyPoll: true), preserving the worker's loaded PR
  // context. The runner / model recorded on the run is informational here — the actual
  // runner is whatever's already running in the slot's role window.
  if (current.engineState?.flags?.nudgeReuse) {
    // Defensive narrow: nudgeDispatch's signature accepts only PR-bound flow types,
    // and runCreate already rejects nudgeReuse for any other flow — re-assert here so
    // a future code path that sets the flag without going through runCreate still
    // fails loudly instead of silently converting an unsupported flow to pr-complete.
    if (current.flowType !== 'pr-complete' && current.flowType !== 'review-pr') {
      throw new Error(`nudgeReuse set on unsupported flow '${current.flowType}'`);
    }
    const collector = createSubStepCollector();
    const dispatchStart = Date.now();
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
  if (current.app) cliCommandParts.push('--app', shellQuote(current.app));
  const cliCommand = cliCommandParts.join(' ');

  // Stash partial I/O before the potentially-failing call
  stepPartialIO.set(runId, { inputs, outputs: { cliCommand } });

  // Collect sub-step events instead of discarding them
  const collector = createSubStepCollector();
  const dispatchStart = Date.now();

  // Provider subscription rotation: only when RunnerStatusProvider.supportsAccountBinding.
  // Eligibility + ledger live on the execution host (node-local multi-node safe).
  const runnerId = normalizeRunner(current.metrics.runner);
  const statusProvider = getRunnerStatusProvider(runnerId);
  const supportsBind = Boolean(statusProvider?.supportsAccountBinding);
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

  for (;;) {
    if (forcedLabel) triedLabels.push(forcedLabel);
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
      );
      if (forcedLabel && slotVars) {
        await hostRecordAccountSuccess({ vars: slotVars, label: forcedLabel });
      }
      break;
    } catch (err) {
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
