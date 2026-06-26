import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  type AgentContextTarget,
  agentRoleWindow,
  type FlowType,
  primaryRoleForFlow,
} from '@farmslot/protocol';

import { upsertAgentContext } from '../../agents/contexts.js';
import {
  execLocal,
  execOnSlot,
  farmslotRoot,
  isLocal,
  loadProjectVars,
  loadSlotVars,
  markSlotBusy,
  type RawProjectJson,
  readSlotField,
  resolveProjectTaskDirName,
  updateSlotStatus,
} from '../../core/index.js';
import {
  firstWindowTarget,
  resolveTmuxSession,
  shellQuote,
  tmuxShellSnippet,
} from '../../core/tmux.js';
import { loadFleetStatus } from '../../fleet/state.js';
import {
  normalizeRunner,
  runnerSupportsTmuxNudges,
  sendRunnerInstructionSafely,
} from '../../runners/registry.js';
import { resolveWorkerNudgePrompt } from '../../runners/worker-prompt.js';
import { copyPreparedTaskRootSidecars } from '../../tasks/sidecars.js';
import { unwatchContext, watchContext, watchSlot } from '../../tasks/watcher.js';

import { ensureWorkerRoleTarget, waitForRunnerProcessExit } from './execute.js';
import { verifyBranchAffinityNudgeStillEligible } from './preview.js';

type EventEmitter = (event: string, payload: unknown) => void;

// ─── Nudge Dispatch — reuse a busy worker on the matching PR branch ───
//
// Companion to dispatchExecute for the branch-affinity nudge path (ADR-024 §7 addendum).
// Skips PREPARE entirely and skips dispatchExecute's pane-teardown / runner-relaunch — the
// worker is already running on the PR's branch with loaded context. We copy the new
// TASK.md into the slot's task tree, then send the standard read+execute prompt to the
// existing tmux session via `sendRunnerInstructionSafely(..., { forceBusyPoll: true })`.
//
// Per ADR-027 the slot's `current_run_id` is reassigned to this run; we log the prior
// owner so the identity stomp is auditable. The prior Run is NOT modified — its monitor
// handles its own end-of-life. The new Run is the system of record.

export class NudgeTimeoutError extends Error {
  constructor(
    message: string,
    public readonly paneTail: string,
  ) {
    super(message);
    this.name = 'NudgeTimeoutError';
  }
}

/**
 * Tear down a slot's prior owning Run when ownership is being stomped (nudge or fresh-reuse).
 *
 * Performs three steps when the slot is held by a different run than the new owner:
 *   1. cancelRunEngine — aborts the prior run's MONITOR / PREPARE controller so its abort
 *      handler short-circuits.
 *   2. updateRun(status='cancelled', completedAt) — terminalizes the prior Run record. Without
 *      this, MONITOR's abort returns exitReason='cancelled' but executeStep still marks the
 *      step done and pipeline transitions continue; subsequent steps would let the prior run
 *      mutate the same slot after the new run was assigned.
 *   3. unwatchContext for each agent context — drops the file watch keyed to the prior
 *      run's task path; otherwise its push-handler keeps short-circuiting on the runId
 *      mismatch and the new run never receives push-based completion signals (kept by the
 *      next watchContext call).
 *
 * Idempotent: skips when there's no prior run, when prior is already terminal, or when the
 * prior run was bound to a different slot.
 */
export async function terminalizePriorRunOnSlot(
  slotId: string,
  currentRunId: string,
  label: string,
): Promise<{ priorRunId: string | null; terminated: boolean }> {
  const priorRunId = (await readSlotField(slotId, 'current_run_id')) as string | null;
  if (!priorRunId || priorRunId === currentRunId) return { priorRunId: null, terminated: false };
  console.log(
    `[${label}] slot=${slotId} reassigning current_run_id ${priorRunId} -> ${currentRunId} (operator-approved)`,
  );
  // Dynamic import to avoid a static cycle: run-engine imports from this file already.
  const { cancelRunEngine } = await import('../../run-engine/orchestrator.js');
  cancelRunEngine(priorRunId);
  const { getRun: getRunForCleanup, updateRun: updateRunForCleanup } =
    await import('../../runs/store.js');
  const priorRun = getRunForCleanup(priorRunId);
  let terminated = false;
  if (priorRun?.slotId === slotId) {
    const isAlreadyTerminal =
      priorRun.status === 'done' ||
      priorRun.status === 'failed' ||
      priorRun.status === 'cancelled' ||
      priorRun.status === 'blocked';
    if (!isAlreadyTerminal) {
      console.log(
        `[${label}] terminalizing prior run ${priorRunId} as cancelled (superseded by ${currentRunId})`,
      );
      updateRunForCleanup(priorRunId, {
        status: 'cancelled',
        completedAt: new Date().toISOString(),
      });
      terminated = true;
    }
    for (const ctx of priorRun.agentContexts ?? []) {
      await unwatchContext(slotId, ctx.id);
    }
  }
  return { priorRunId, terminated };
}

/**
 * Hard-kill any agent process running on a slot. Used by the fresh-reuse path before
 * PREPARE can run safely — without this, PREPARE's git reset / checkout / dependency
 * install would race against a prior worker still writing in the same worktree, corrupting
 * slot state. Sequential: kill role windows -> kill the runner in the session ->
 * wait for the runner pid to exit. Mirrors what `dispatchExecute`'s "Clean pane" step does
 * before launch but pulled out so it can run BEFORE the engine's PREPARE step.
 */
export async function killWorkerOnSlot(slotId: string, runner: string): Promise<void> {
  const vars = await loadSlotVars(slotId);
  const slotMod = await import('../slot.js');
  const session = await resolveTmuxSession(vars.slotId, vars, { strict: true });
  const hasSession =
    (await execOnSlot(vars, tmuxShellSnippet(`has-session -t ${shellQuote(session)} 2>/dev/null`)))
      .exitCode === 0;
  if (!hasSession) return;
  await slotMod.killAllAgentWindows(vars, session);
  await slotMod.killAgentInSession(vars, runner);
  // Re-check session after the kills. When the only window in the session was a role window,
  // killAllAgentWindows uses `kill-session` (slot.ts:1625-1627) and the session itself is
  // gone — the runner process exited as a side effect of the session dying, so there's no
  // exit pane left to wait on. firstWindowTarget on a missing session throws "has no
  // windows", which would crash this helper before PREPARE even runs. Returning early is
  // correct here: the caller (prepareSlotForFreshReuse) only needs the worker dead before
  // PREPARE; missing session means the worker is already dead.
  const stillHasSession =
    (await execOnSlot(vars, tmuxShellSnippet(`has-session -t ${shellQuote(session)} 2>/dev/null`)))
      .exitCode === 0;
  if (!stillHasSession) return;
  const exitTarget = await firstWindowTarget(vars, session);
  await waitForRunnerProcessExit(vars, exitTarget, runner);
}

/**
 * Combined teardown for fresh-reuse: terminalize prior Run + hard-kill worker on slot.
 * Engine call sites (decision-card 'fresh' branch, FIND_SLOT freshReuse wizard-shortcut)
 * must call this BEFORE markSlotBusy('preparing') / before PREPARE runs, so that PREPARE
 * doesn't race the prior worker mutating the same git worktree.
 */
export async function prepareSlotForFreshReuse(slotId: string, newRunId: string): Promise<void> {
  await terminalizePriorRunOnSlot(slotId, newRunId, 'fresh-reuse');
  const slotRunner = (await readSlotField(slotId, 'runner')) as string | null;
  if (slotRunner) {
    await killWorkerOnSlot(slotId, normalizeRunner(slotRunner));
  }
}

export interface NudgeDispatchParams {
  slotId: string;
  taskFile: string;
  runId: string;
  ticketOrPr: string;
  /** PR-bound flow type. Engine has this on the run record; passing it explicitly avoids a
   * redundant TASK.md parse and lets the type-checker enforce the supported set. */
  flowType: 'pr-complete' | 'review-pr';
  /** PR head branch the wizard / decision card authorized for this nudge. The runtime
   * eligibility re-check compares this against `liveSlot.branch` to detect drift between
   * authorization and execution. Without it the re-check uses the slot's own branch as
   * target, which is tautological and only catches lifecycle/agent/runner regressions. */
  targetBranch?: string | null;
}

export async function nudgeDispatch(
  params: NudgeDispatchParams,
  emit: EventEmitter,
): Promise<{ nudged: boolean; workerTarget: string; runner: string; model: string | null }> {
  const vars = await loadSlotVars(params.slotId);
  if (vars.slotMode === 'disabled') throw new Error(`Slot ${params.slotId} is disabled`);

  const step = (name: string, detail: string) => emit('dispatch.step', { name, detail });

  // Pre-flight re-eligibility check. Operators can take seconds to click in the wizard, and a
  // gateway restart can rehydrate `engineState.flags.nudgeReuse` against a slot that has since
  // been recycled to a different branch. Re-running the same gate `collectBranchAffinityNudgeCandidates`
  // uses ensures we throw with a human-readable reason before any state mutation, instead of
  // sending keys into a stale or wrong worker.
  //
  // The expected identity (project / familyId / lane / variant) comes from the *new run* —
  // not from the slot. Using liveSlot's own fields would be tautological and miss the case
  // where the slot was reassigned to a different owner that's coincidentally still on the
  // same branch (e.g. another fix-bug run on the same family that hasn't terminated yet).
  const fleet = await loadFleetStatus();
  const liveSlot = fleet.slots.find((s) => s.slot === params.slotId);
  const { getRun: getRunForVerify } = await import('../../runs/store.js');
  const requestingRun = getRunForVerify(params.runId);
  if (!requestingRun) throw new Error(`Run ${params.runId} not found in store`);
  const eligibilityFail = await verifyBranchAffinityNudgeStillEligible(
    liveSlot,
    requestingRun.project,
    params.ticketOrPr,
    {
      familyId: requestingRun.familyId ?? null,
      lane: requestingRun.lane ?? null,
      variant: requestingRun.variant ?? null,
      // PR head branch the wizard / decision card authorized for this nudge. Comparing
      // params.targetBranch (authorized) against liveSlot.branch (current) is the only way
      // to catch a slot that drifted off the PR's branch between authorization and DISPATCH.
      // Falls back to the run's stored branch, then liveSlot.branch as a final backstop —
      // the last fallback is tautological but preserves behavior for legacy call sites that
      // didn't thread params.targetBranch through.
      targetBranch: params.targetBranch ?? requestingRun.branch ?? liveSlot?.branch ?? null,
    },
  );
  if (eligibilityFail) throw new Error(`Branch-affinity nudge no longer valid: ${eligibilityFail}`);

  let projectJson: RawProjectJson = {};
  try {
    projectJson = (await loadProjectVars(vars.projectName)).projectJson;
  } catch (err) {
    // Same recovery posture as dispatchExecute: missing/unreadable project.json falls back
    // to defaults so the nudge can still target the right slot. Per-field reads null-check.
    console.warn(
      `[dispatch] nudge project vars load failed for ${vars.projectName}: ${(err as Error).message}`,
    );
  }

  let taskFilePath = params.taskFile;
  if (!path.isAbsolute(taskFilePath)) taskFilePath = path.join(farmslotRoot, taskFilePath);
  if (!existsSync(taskFilePath)) throw new Error(`Task file not found: ${taskFilePath}`);

  const taskDir = path.dirname(taskFilePath);
  const taskFolderId = path.basename(taskDir);
  const flowSubdir = path.basename(path.dirname(taskDir));
  const flowType = params.flowType;

  const slotRunnerRaw = (await readSlotField(params.slotId, 'runner')) as string | null;
  const slotModelRaw = (await readSlotField(params.slotId, 'model')) as string | null;
  const runner = normalizeRunner(slotRunnerRaw ?? 'claude');
  if (!runnerSupportsTmuxNudges(runner)) {
    throw new Error(`Runner '${runner}' on slot ${params.slotId} does not support tmux nudges`);
  }

  const taskDirName = resolveProjectTaskDirName(projectJson);
  const workerTaskDir = `${taskDirName}/${flowSubdir}/${taskFolderId}`;
  const workerTaskAbs = `${vars.remoteRepo}/${workerTaskDir}`;

  step('copy', `Copying TASK.md to ${workerTaskDir}/TASK.md`);
  if (isLocal(vars.host, vars.machine)) {
    await mkdir(workerTaskAbs, { recursive: true });
    await copyFile(taskFilePath, path.join(workerTaskAbs, 'TASK.md'));
  } else {
    await execOnSlot(vars, `mkdir -p ${shellQuote(workerTaskAbs)}`);
    await execLocal(
      `scp -q ${shellQuote(taskFilePath)} ${shellQuote(`${vars.sshTarget}:${workerTaskAbs}/TASK.md`)}`,
    );
  }
  for (const sidecar of await copyPreparedTaskRootSidecars({
    taskDir,
    workerTaskAbs,
    host: vars.host,
    machine: vars.machine,
    sshTarget: vars.sshTarget,
  })) {
    step('copy', `${sidecar} copied`);
  }
  for (const subdir of ['assets', 'inputs', 'artifacts']) {
    const localDir = path.join(taskDir, subdir);
    if (existsSync(localDir)) {
      if (isLocal(vars.host, vars.machine)) {
        await cp(localDir, path.join(workerTaskAbs, subdir), { recursive: true });
      } else {
        await execLocal(
          `rsync -az ${shellQuote(`${localDir}/`)} ${shellQuote(`${vars.sshTarget}:${workerTaskAbs}/${subdir}/`)}`,
        );
      }
      step('copy', `${subdir}/ copied`);
    }
  }

  // STEP A: resolve the existing worker's role + tmux target. This must NOT mutate any state
  // — if the nudge fails downstream, the prior run is still alive and we don't want to have
  // overwritten anything. Determine the target role from the slot's CURRENT flow type, not
  // the new run's flow: when the operator dispatches review-pr against a slot whose worker
  // is doing fix-bug, the worker is sitting in the fix-bug role's window. Targeting
  // primaryRoleForFlow(newFlowType) would land us in an empty / wrong pane.
  step('clean', 'Resolving role target (no pane teardown — nudge reuses existing worker)');
  const session = await resolveTmuxSession(vars.slotId, vars, { strict: true });
  const priorFlowTypeRaw = (await readSlotField(params.slotId, 'current_flow_type')) as
    | string
    | null;
  const priorRole = priorFlowTypeRaw ? primaryRoleForFlow(priorFlowTypeRaw as FlowType) : null;
  const newRole = primaryRoleForFlow(flowType);
  const workerRole = priorRole ?? newRole;
  const workerTarget = await ensureWorkerRoleTarget(vars, session, runner, workerRole);
  const primaryTarget: AgentContextTarget = {
    session,
    window: agentRoleWindow(workerRole),
    pane: null,
    target: workerTarget,
  };

  // STEP B: send the nudge FIRST, BEFORE any ownership state mutation. Critical correctness
  // property: if the prompt fails to land (runner stayed busy past the 30s timeout, ssh hiccup,
  // etc.), the prior run is still active with its monitor + watchers + slot ownership intact.
  // Stomping prior ownership before delivery would leave the old worker executing without an
  // active monitor while the new run fails — silent split-brain.
  step('nudge', `Sending TASK.md prompt to existing worker at ${workerTarget}`);
  // Absolute path so the prompt resolves correctly regardless of the worker's current cwd —
  // Claude tool-use loops can chdir mid-task and a relative path would target the wrong place.
  const absoluteTaskMd = `${workerTaskAbs}/TASK.md`;
  const prompt = await resolveWorkerNudgePrompt(vars.projectName, {
    taskFile: absoluteTaskMd,
    taskDir: workerTaskAbs,
  });
  const sent = await sendRunnerInstructionSafely(
    vars,
    workerTarget,
    runner,
    prompt,
    '[nudge]',
    30000,
    { forceBusyPoll: true },
  );
  if (!sent) {
    // Capture the pane tail so the failure is debuggable rather than a context-free timeout.
    const paneRes = await execOnSlot(
      vars,
      tmuxShellSnippet(`capture-pane -p -t ${shellQuote(workerTarget)} 2>/dev/null | tail -15`),
    );
    // No rollback needed — we deferred all state mutation past this point. Prior run is still
    // the slot's owner and its monitor/watchers are intact. The new run fails cleanly.
    const { getRun, updateRun } = await import('../../runs/store.js');
    const timeoutRun = getRun(params.runId);
    if (timeoutRun) {
      updateRun(params.runId, {
        metrics: {
          ...timeoutRun.metrics,
          nudgeTimeoutCount: (timeoutRun.metrics.nudgeTimeoutCount ?? 0) + 1,
        },
      });
    }
    throw new NudgeTimeoutError(
      `Nudge to ${workerTarget} timed out — runner stayed busy past 30s. Pane tail:\n${paneRes.stdout}`,
      paneRes.stdout,
    );
  }

  // STEP C: nudge accepted. NOW stomp ownership atomically. The prior run's `Run` record
  // retains its old `slotId` field by design — `runForSlot` resolves through the slot's
  // `currentRunId` pointer first (see run-store.ts `selectSingleActiveRunForSlot`), so the
  // new run is correctly returned even though both records still reference this slot.
  // Preserving the prior Run's slotId keeps run-detail / observability views stable for the
  // operator. terminalizePriorRunOnSlot handles the cancel + terminalize + unwatch — see its
  // docstring for why each step is required.
  //
  // Inherit the prior owning run's nudgeCount BEFORE terminalize so the new run's primary
  // context starts at `priorOwnerNudgeCount + 1`, not `0 + 1`. Without this read here the
  // wizard's `×N` chip resets to 1 after every nudge regardless of how many we've sent into
  // the same worker, which also defeats the `high-nudge-count` risk-flag threshold.
  const { getRun } = await import('../../runs/store.js');
  const priorRunId = (await readSlotField(params.slotId, 'current_run_id')) as string | null;
  const priorOwnerRun = priorRunId && priorRunId !== params.runId ? getRun(priorRunId) : null;
  const priorOwnerContext =
    priorOwnerRun?.agentContexts?.find((c) => c.role === workerRole) ??
    priorOwnerRun?.agentContexts?.[0];
  const priorNudgeCount = priorOwnerContext?.nudgeCount ?? 0;

  await terminalizePriorRunOnSlot(params.slotId, params.runId, 'nudge');
  // Atomic claim: write every current_* field the contamination check (line
  // 1420-1462) reads. Skipping family/lane/variant here was the source of
  // half-cleared slot state — a later same-family dispatch would see
  // current_run_id=<new-id> + family=null and trip evaluateSlotIdentityPolicy
  // as "different identity, block".
  await updateSlotStatus(params.slotId, {
    current_run_id: params.runId,
    current_ticket_or_pr: params.ticketOrPr,
    current_flow_type: flowType,
    current_family_id: requestingRun.familyId ?? null,
    current_lane: requestingRun.lane ?? null,
    current_variant: requestingRun.variant ?? null,
    task_id: taskFolderId,
    task_file: `${workerTaskDir}/TASK.md`,
    dispatched_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });

  // STEP D: register the new run's agent context under the actual targeted role + bump nudge
  // count. We register under `workerRole` (the existing worker's role) rather than the new
  // run's flow-derived role because the agent context tracks WHERE the worker physically is —
  // the AgentContextTarget points at the prior role's tmux window which is where send-keys
  // landed. Monitor consults agentContexts to find the pane to probe; using the wrong role
  // here would have it look at an empty window.
  const workingContext = await upsertAgentContext(params.runId, workerRole, {
    status: 'working',
    taskFile: `${workerTaskDir}/TASK.md`,
    signalFile: `${workerTaskDir}/SIGNAL.json`,
    runner,
    target: primaryTarget,
    nudgeCount: priorNudgeCount + 1,
  });
  await markSlotBusy(params.slotId, 'working', 'working');
  step(
    'nudge',
    `Worker nudged on ${workerTarget} (role=${workerRole}, nudgeCount=${priorNudgeCount + 1})`,
  );

  // STEP E: wire signal-file watching for the new task path. Without this, monitorRun falls
  // back to slow polling at best, and the prior watch (still keyed on the old task path under
  // the prior runId) keeps short-circuiting any push-handler signals as a runId mismatch —
  // the new run never receives push-based completion events. Match dispatchExecute's tail.
  if (workingContext) {
    await watchContext(params.slotId, workingContext);
  } else {
    await watchSlot(params.slotId);
  }

  emit('dispatch.done', { slotId: params.slotId, taskId: taskFolderId, runner });
  return { nudged: true, workerTarget, runner, model: slotModelRaw };
}
