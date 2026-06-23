import { Events, type Run } from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { isLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { dispatchExecute, nudgeDispatch } from '../methods/dispatch.js';
import { slotPrepare } from '../methods/slot.js';
import { assertRunnerLaunchPrerequisites } from '../runners/launch-command.js';
import { runnerNeedsPostLaunchPrompt } from '../runners/registry.js';
import { captureHostLoadSnapshot } from '../runs/analytics.js';
import { getRun, updateRun, updateRunStep } from '../runs/store.js';

import { executeEvalHarnessLifecycle } from './eval-harness-lifecycle.js';
import { probeRemotePath } from './remote-probes.js';
import { createSubStepCollector } from './sub-step-collector.js';

interface StepIO {
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

type BroadcastFn = (event: string, payload: unknown) => void;

interface RunEngineFlags {
  skipPrepare?: true;
  warmRecovery?: true;
  nudgeReuse?: true;
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
  const current = await normalizeEvalReplayForTaskWrite(runId, getRun(runId)!);
  if (!current.slotId) throw new Error('No slot assigned');
  // pr-complete and merge-main flows leave the merge to the worker so it
  // can resolve conflicts in-session. Only review-pr auto-merges in prepare
  // (and aborts on conflict) — reviewer flow doesn't fix code.
  const mergeMain = current.flowType === 'review-pr' && !!current.branch;
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
  const flags = getRunFlags(runId);
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

  // fix-bug/dev create new branches — force-recreate if stale remote exists from a previous run
  const forceNewBranch = current.flowType === 'fix-bug' || current.flowType === 'dev';
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
        prepareProfile: current.prepareProfile,
        vars: prepareVars,
        runId,
      },
      emitWithBroadcast,
      prepareController.signal,
      {
        ...(warmRecovery ? { stripClean: true } : {}),
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
  try {
    const vars = await loadSlotVars(current.slotId);
    machine = vars.machine;
    platform = vars.platform;
    local = isLocal(vars.host, vars.machine);
  } catch (err) {
    // Slot metadata is enrichment only; preserve the successful PREPARE
    // result while surfacing why machine/platform are missing.
    console.warn(
      `[run-engine] prepare metadata lookup failed for ${runId.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
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
      cliCommand,
      ...(selectedPrepareProfile ? { profile: selectedPrepareProfile } : {}),
      ...(preparedRun?.startRef ? { startRef: preparedRun.startRef } : {}),
      ...(lastOutput ? { lastOutput } : {}),
    },
  };
}

export interface DispatchStepContext {
  stepPartialIO: Map<string, StepIO>;
}

export async function executeDispatchStep(
  runId: string,
  context: DispatchStepContext,
): Promise<StepIO> {
  const { stepPartialIO } = context;
  const current = getRun(runId)!;
  if (!current.slotId) throw new Error('No slot assigned');
  if (!current.taskFile) throw new Error('No task file specified');
  const inputs: Record<string, unknown> = {
    slotId: current.slotId,
    runner: current.metrics.runner,
    model: current.metrics.model,
    taskFile: current.taskFile,
    app: current.app,
  };

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
  const dispatchResult = await dispatchExecute(
    {
      slotId: current.slotId,
      taskFile: current.taskFile,
      runId,
      skipPrepare: true,
      mode: current.mode,
      model: current.metrics.model || undefined,
      runner: current.metrics.runner || undefined,
      effort: current.effort,
      app: current.app,
    },
    collector.emit,
  );

  stepPartialIO.delete(runId);
  const subSteps = collector.finish();
  const launchCommand = dispatchResult.launchCommand;

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
    },
  };
}
