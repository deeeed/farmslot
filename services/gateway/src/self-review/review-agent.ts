// self-review/review-agent.ts — launch and collect the independent self-review runner.

import path from 'node:path';

import {
  type AgentContext,
  allocateReviewerContext,
  type ReviewDiffSnapshot,
  type ReviewFixDeltaSnapshot,
  type ReviewLoopTimelineSegment,
  type ReviewValidationDepth,
  type RunnerSessionUsage,
  type SelfReviewIssue,
} from '@farmslot/protocol';

import { markAgentContextStatus, upsertAgentContext } from '../agents/contexts.js';
import { loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import {
  ensureTmuxWindowMinimumSize,
  resolveExactTmuxWindowPane,
  resolveTmuxSession,
  respawnTmuxWindowWithCommand,
  shellQuote,
  TMUX_WINDOW_RESPAWN_SETTLE_MS,
  tmuxShellSnippet,
} from '../core/tmux.js';
import { writeTextFileOnSlot } from '../methods/dispatch/slot-file-write.js';
import {
  buildLaunchCommand,
  buildRunnerSessionReloadCommand,
  RUNNER_LAUNCH_READY_TIMEOUT_MS,
  runnerSupportsSessionReload,
} from '../runners/launch-command.js';
import {
  captureRunnerPromptAcceptanceBaseline,
  runnerHasDurablePromptHandoff,
  runnerLineLooksWaiting,
  runnerNeedsPostLaunchPrompt,
  runnerPaneShowsCurrentInteractiveProgress,
  sendRunnerPostLaunchPrompt,
  WORKER_ENV_PREFIX,
} from '../runners/registry.js';
import {
  isRunnerAliveUnderPane,
  resumableSessionProbeCommand,
} from '../runners/session-process.js';
import { resolveWorkerDispatchPrompt } from '../runners/worker-prompt.js';
import { getRun, updateRun, updateRunStep } from '../runs/store.js';
import {
  extractRunnerSessionUsage,
  unavailableRunnerSessionUsage,
} from '../runtime/session-usage.js';
import {
  restoreWorkerChecklistTargetFromSlot,
  slotTaskRelPath,
  syncChecklistTargetForRole,
  targetForChecklistBasename,
  taskDirRelPath,
} from '../tasks/checklist-target.js';
import { unwatchContext, watchContext } from '../tasks/watcher.js';
import { terminalWorkerSignalFromRaw } from '../tasks/worker-signals.js';

import { readReviewFeedback } from './feedback.js';
import { startProgressWatcher } from './progress.js';
import {
  claimWarmReviewerSession,
  DEFAULT_REVIEW_SESSION_POLICY,
  registerWarmReviewerSession,
  reviewerAllocationMode,
  type ReviewSessionPolicy,
  shouldAttemptWarmResume,
  type WarmReviewerScope,
} from './session-policy.js';
import {
  bestEffortCaptureRunnerSessionMetadata,
  bestEffortListRunnerSessionFiles,
  captureReviewSnapshot,
  debugSelfReviewLog,
  durationBetween,
  killSelfReviewWindow,
  readPersistedReviewSnapshot,
  removeSlotFiles,
  reviewArtifactDir,
  type ReviewSessionMeta,
  waitForSessionTranscriptToSettle,
} from './snapshots.js';
import { expandSelfReviewTemplate } from './templates.js';

/** Progress mark writes status "running"; only terminal worker signals count as done. */
export function parseTerminalSelfReviewSignal(raw: string) {
  return terminalWorkerSignalFromRaw(raw);
}

export function shouldKeepWaitingForOverdueReview(
  reviewerProcessAlive: boolean,
  _reviewerAtIdlePrompt: boolean,
): boolean {
  return reviewerProcessAlive;
}

export const LEGACY_REVIEW_FEEDBACK_REL_PATH = 'artifacts/review-feedback.md';
const LEGACY_REVIEW_FEEDBACK_ARTIFACT_PATTERN =
  /(^|[^\w-])artifacts\/review-feedback\.md(?![\w./-])/g;
const LEGACY_REVIEW_FEEDBACK_BASENAME_PATTERN = /(^|[^\w./-])review-feedback\.md(?![\w./-])/g;

export function selfReviewChecklistMarkPrompt(
  taskDir: string,
  taskMdPath: string,
  reviewTarget: { checklist: string; signal: string },
  feedbackRelPath: string,
): string {
  const mark = `${taskDir}/mark`;
  const markWithTarget = `${mark} --checklist ${reviewTarget.checklist} --signal ${reviewTarget.signal}`;
  return (
    `Follow ${taskMdPath} top-to-bottom. After EVERY checklist step run ${markWithTarget} N ` +
    `(bootstrap with ${markWithTarget} start — same path as the checklist header). ` +
    `Skipping ${markWithTarget} leaves the run at 0/N in the UI. ` +
    `Write ${taskDir}/${feedbackRelPath}, then ${markWithTarget} complete.`
  );
}

export function reviewerChecklistBasename(contextId: string): string {
  return `SELF-REVIEW.${contextId}.md`;
}

export function reviewerFeedbackRelPath(contextId: string): string {
  return `artifacts/review-feedback.${contextId}.md`;
}

export function selectRecoverableReviewContext(
  contexts: readonly AgentContext[],
  params: { taskDir: string; runner: string; artifactScope?: string | null },
): AgentContext | null {
  const expectedScope = params.artifactScope?.trim() || null;
  return (
    [...contexts].reverse().find((context) => {
      const contextScope = context.artifactScope?.trim() || null;
      return (
        context.role === 'self-review' &&
        (context.status === 'working' || context.status === 'launching') &&
        context.runner === params.runner &&
        contextScope === expectedScope &&
        !!context.taskFile &&
        path.posix.dirname(context.taskFile) === params.taskDir &&
        !!context.target?.target
      );
    }) ?? null
  );
}

/**
 * Re-assert the exact checklist prompt for a reviewer that survived a gateway
 * restart. The shared delivery adapter proves accepted/running/buffered state,
 * so this submits a buffered prompt or no-ops on accepted work without opening
 * another reviewer window.
 */
export async function resumeReviewAgentPromptDelivery(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runId: string,
  context: Pick<
    AgentContext,
    'id' | 'runner' | 'taskFile' | 'signalFile' | 'target' | 'attemptStartedAt' | 'startedAt'
  >,
): Promise<'delivered' | 'inactive' | 'unsupported'> {
  const target = context.target?.target;
  const taskMdPath = context.taskFile;
  const runner = context.runner;
  if (!target || !taskMdPath || !runner || !runnerNeedsPostLaunchPrompt(runner)) {
    return 'unsupported';
  }
  const pane = await resolveExactTmuxWindowPane(vars, target);
  if (!pane) return 'inactive';
  if (!(await isRunnerAliveUnderPane(vars, pane.panePid, runner, { timeout: 10_000 }))) {
    return 'inactive';
  }

  const taskDir = path.posix.dirname(taskMdPath);
  const reviewTarget = targetForChecklistBasename(path.posix.basename(taskMdPath));
  const feedbackRelPath = reviewerFeedbackRelPath(context.id);
  const parentRun = getRun(runId);
  const prompt = `${await resolveWorkerDispatchPrompt(parentRun?.project ?? vars.projectName, {
    taskFile: taskMdPath,
    taskDir,
  })}\n\n${selfReviewChecklistMarkPrompt(taskDir, taskMdPath, reviewTarget, feedbackRelPath)}`;
  const attemptStartedAtMs = Date.parse(context.attemptStartedAt ?? context.startedAt ?? '');
  const baselineMs = Number.isFinite(attemptStartedAtMs) ? attemptStartedAtMs : Date.now();
  const runtimeDir = await resolveProjectRuntimeDir(parentRun?.project);
  await sendRunnerPostLaunchPrompt(
    vars,
    pane.paneId,
    runner,
    prompt,
    reviewTarget.checklist,
    'self-review-recovery',
    {
      readyTimeoutMs: RUNNER_LAUNCH_READY_TIMEOUT_MS,
      maxAttempts: 5,
      blockerSnapshotPath: `${taskDir}/artifacts/runner-blockers/self-review-recovery.txt`,
      signalPath: context.signalFile ?? taskDirRelPath(taskDir, reviewTarget.signal),
      launchAckSignalPath: context.signalFile ?? taskDirRelPath(taskDir, reviewTarget.signal),
      promptAcceptanceBaselineMs: baselineMs,
      requirePromptDigest: true,
      acceptExistingLaunchAck: true,
      handoffAckSinceMs: baselineMs,
      softAcceptOnHandoffAck: true,
      runtimeDir,
    },
  );
  return 'delivered';
}

export function scopeReviewFeedbackPath(template: string, feedbackRelPath: string): string {
  const scoped = template
    .replace(
      LEGACY_REVIEW_FEEDBACK_ARTIFACT_PATTERN,
      (_match, prefix: string) => `${prefix}${feedbackRelPath}`,
    )
    .replace(
      LEGACY_REVIEW_FEEDBACK_BASENAME_PATTERN,
      (_match, prefix: string) => `${prefix}${feedbackRelPath}`,
    );
  if (scoped !== template) return scoped;
  return `${template.trimEnd()}\n\nWrite reviewer feedback to ${feedbackRelPath}.`;
}

// Exported for self-review.test.ts to seed runSelfReviewRetryLoop fixtures. Not part of the
// gateway's public surface — keep internal to this module's tests.
export interface ReviewAgentResult {
  verdict: 'pass' | 'issues';
  issues: SelfReviewIssue[];
  validationDepth?: ReviewValidationDepth;
  usage?: RunnerSessionUsage;
  reviewSnapshot?: ReviewDiffSnapshot;
  fixDelta?: ReviewFixDeltaSnapshot;
  artifactPaths?: string[];
  taskProgressArtifactPath?: string;
  timeline?: ReviewLoopTimelineSegment[];
  startedAt?: string;
  completedAt?: string;
  incomplete?: boolean; // true when feedback file was never written (agent didn't finish)
}

async function persistReviewOutputArtifacts(params: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  taskDir: string;
  taskMdPath: string;
  signalBasename: string;
  feedbackRelPath: string;
  artifactDir: string;
  feedbackIncomplete: boolean;
}): Promise<{ artifactPaths: string[]; taskProgressArtifactPath: string }> {
  const {
    vars,
    taskDir,
    taskMdPath,
    signalBasename,
    feedbackRelPath,
    artifactDir,
    feedbackIncomplete,
  } = params;
  const persistedArtifacts: string[] = [];
  const taskProgressRel = `${artifactDir}/self-review.md`;
  const taskProgressDest = `${vars.remoteRepo}/${taskDir}/${taskProgressRel}`;
  const taskProgressCopy = await execOnSlot(
    vars,
    `mkdir -p ${shellQuote(path.posix.dirname(taskProgressDest))} && cp ${shellQuote(`${vars.remoteRepo}/${taskMdPath}`)} ${shellQuote(taskProgressDest)}`,
    { timeout: 10_000 },
  );
  if (taskProgressCopy.exitCode !== 0) {
    throw new Error(
      `Failed to persist self-review progress artifact: ${taskProgressCopy.stderr || taskProgressCopy.stdout || `exit ${taskProgressCopy.exitCode}`}`,
    );
  }
  persistedArtifacts.push(taskProgressRel);

  const signalRel = `${artifactDir}/self-review-signal.json`;
  const liveSignalPath = slotTaskRelPath(vars, taskDir, signalBasename);
  const signalCopy = await execOnSlot(
    vars,
    `if [ -f ${shellQuote(liveSignalPath)} ]; then cp ${shellQuote(liveSignalPath)} ${shellQuote(`${vars.remoteRepo}/${taskDir}/${signalRel}`)} && echo copied; fi`,
    { timeout: 10_000 },
  );
  if (signalCopy.exitCode !== 0) {
    throw new Error(
      `Failed to persist self-review signal artifact: ${signalCopy.stderr || signalCopy.stdout || `exit ${signalCopy.exitCode}`}`,
    );
  }
  if (signalCopy.stdout.trim() === 'copied') persistedArtifacts.push(signalRel);

  if (!feedbackIncomplete) {
    const feedbackRel = `${artifactDir}/review-feedback.md`;
    const feedbackSrc = `${vars.remoteRepo}/${taskDir}/${feedbackRelPath}`;
    const feedbackDest = `${vars.remoteRepo}/${taskDir}/${feedbackRel}`;
    const feedbackCopy = await execOnSlot(
      vars,
      `mkdir -p ${shellQuote(path.posix.dirname(feedbackDest))} && cp ${shellQuote(feedbackSrc)} ${shellQuote(feedbackDest)}`,
      { timeout: 10_000 },
    );
    if (feedbackCopy.exitCode !== 0) {
      throw new Error(
        `Failed to persist self-review feedback artifact: ${feedbackCopy.stderr || feedbackCopy.stdout || `exit ${feedbackCopy.exitCode}`}`,
      );
    }
    persistedArtifacts.push(feedbackRel);
  }

  return {
    artifactPaths: persistedArtifacts,
    taskProgressArtifactPath: `${taskDir}/${taskProgressRel}`,
  };
}

async function recoverRunningReviewAgent(params: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  runner: string;
  model: string;
  taskDir: string;
  slotId: string;
  runId: string;
  session: string;
  reviewTimeoutMs: number;
  loopNumber: number;
  validationDepth: ReviewValidationDepth;
  artifactScope?: string | null;
}): Promise<ReviewAgentResult | null> {
  const run = getRun(params.runId);
  const context = selectRecoverableReviewContext(run?.agentContexts ?? [], params);
  if (
    !context?.target?.target ||
    !context.target.window ||
    !context.taskFile ||
    !context.signalFile
  )
    return null;

  const abandonRecoveredReviewer = async (reason: string): Promise<null> => {
    await markAgentContextStatus(params.runId, 'self-review', 'failed', { id: context.id });
    try {
      await killSelfReviewWindow(params.vars, params.session, reason, context.target?.window);
    } catch (error) {
      console.warn(
        `[self-review] run ${params.runId.slice(0, 8)} — recovered reviewer ${context.id} cleanup failed: ${(error as Error).message}`,
      );
    }
    return null;
  };

  const pane = await resolveExactTmuxWindowPane(params.vars, context.target.target);
  if (
    !pane ||
    !(await isRunnerAliveUnderPane(params.vars, pane.panePid, params.runner, { timeout: 10_000 }))
  ) {
    return abandonRecoveredReviewer('inactive recovered reviewer cleanup');
  }

  debugSelfReviewLog(
    `[self-review] run ${params.runId.slice(0, 8)} — reclaiming active reviewer ${context.id} after restart`,
  );
  try {
    const delivery = await resumeReviewAgentPromptDelivery(params.vars, params.runId, context);
    if (delivery !== 'delivered') {
      console.warn(
        `[self-review] run ${params.runId.slice(0, 8)} — recovered reviewer ${context.id} is ${delivery}; starting a fresh review`,
      );
      return abandonRecoveredReviewer('unsupported recovered reviewer cleanup');
    }
  } catch (error) {
    console.warn(
      `[self-review] run ${params.runId.slice(0, 8)} — recovered reviewer ${context.id} prompt recovery failed: ${(error as Error).message}`,
    );
    return abandonRecoveredReviewer('failed recovered reviewer prompt cleanup');
  }
  updateRun(params.runId, { activeTaskFile: context.taskFile });
  const reviewWindow = context.target.window;
  const signalBasename = path.posix.basename(context.signalFile);
  const feedbackRelPath = reviewerFeedbackRelPath(context.id);
  const reviewSnapshot = await readPersistedReviewSnapshot(
    params.vars,
    params.taskDir,
    context.reviewLoopNumber ?? params.loopNumber,
    params.artifactScope,
  );
  if (!reviewSnapshot) {
    console.warn(
      `[self-review] run ${params.runId.slice(0, 8)} — recovered reviewer ${context.id} has no valid launch snapshot; starting a fresh review`,
    );
    return abandonRecoveredReviewer('snapshot-less recovered reviewer cleanup');
  }
  const watcher = startProgressWatcher(params.vars, context.taskFile, params.runId, 'Review', {
    contextId: context.id,
    role: 'self-review',
  });
  let completedSuccessfully = false;
  try {
    const completed = await waitForReviewCompletion(
      params.vars,
      params.session,
      params.taskDir,
      params.reviewTimeoutMs,
      params.runId,
      params.runner,
      reviewWindow,
      context.id,
      signalBasename,
      feedbackRelPath,
    );
    if (!completed) return null;
    const feedback = await readReviewFeedback(params.vars, params.taskDir, feedbackRelPath);
    await waitForSessionTranscriptToSettle(params.vars, context.runnerSessionPath ?? null);
    const usage = context.runnerSessionPath
      ? await extractRunnerSessionUsage({
          slotId: params.slotId,
          vars: params.vars,
          runner: params.runner,
          runnerSessionId: context.runnerSessionId ?? null,
          runnerSessionPath: context.runnerSessionPath,
        })
      : unavailableRunnerSessionUsage({
          runner: params.runner,
          runnerSessionId: context.runnerSessionId ?? null,
          runnerSessionPath: context.runnerSessionPath ?? null,
          error: 'Recovered reviewer has no persisted runner session path.',
        });
    const persisted = await persistReviewOutputArtifacts({
      vars: params.vars,
      taskDir: params.taskDir,
      taskMdPath: context.taskFile,
      signalBasename,
      feedbackRelPath,
      artifactDir: reviewArtifactDir(params.loopNumber, params.artifactScope),
      feedbackIncomplete: feedback.incomplete ?? false,
    });
    const startedAt = context.attemptStartedAt ?? context.startedAt ?? new Date().toISOString();
    const completedAt = new Date().toISOString();
    completedSuccessfully = true;
    return {
      ...feedback,
      validationDepth: params.validationDepth,
      usage,
      reviewSnapshot: reviewSnapshot.snapshot,
      artifactPaths: [...reviewSnapshot.artifactPaths, ...persisted.artifactPaths],
      taskProgressArtifactPath: persisted.taskProgressArtifactPath,
      timeline: [
        {
          kind: params.loopNumber > 1 ? 're-review' : 'review',
          loopNumber: params.loopNumber,
          runner: params.runner,
          model: params.model,
          startedAt,
          completedAt,
          durationMs: durationBetween(startedAt, completedAt),
          verdict: feedback.verdict === 'pass' ? 'pass' : 'issues',
          unresolvedCount: feedback.verdict === 'pass' ? 0 : feedback.issues.length,
          artifactPaths: [...reviewSnapshot.artifactPaths, ...persisted.artifactPaths],
        },
      ],
      startedAt,
      completedAt,
    };
  } finally {
    watcher.stop();
    await unwatchContext(params.slotId, context.id);
    updateRun(params.runId, { activeTaskFile: undefined });
    const latest = getRun(params.runId);
    await restoreWorkerChecklistTargetFromSlot(
      params.vars,
      params.taskDir,
      latest ? { flowType: latest.flowType, mode: latest.mode ?? undefined } : undefined,
    );
    if (completedSuccessfully) {
      try {
        await killSelfReviewWindow(
          params.vars,
          params.session,
          'post-recovery cleanup',
          reviewWindow,
        );
      } catch (cleanupErr) {
        console.warn(
          `[self-review] recovered reviewer cleanup failed: ${(cleanupErr as Error).message}`,
        );
      }
    }
  }
}

export async function runReviewAgent(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  model: string,
  taskDir: string,
  _slotId: string,
  _runId: string,
  reviewTimeoutMs: number,
  loopNumber = 1,
  validationDepth: ReviewValidationDepth = 'full-live',
  artifactScope?: string | null,
  sessionPolicy: ReviewSessionPolicy = DEFAULT_REVIEW_SESSION_POLICY,
): Promise<ReviewAgentResult> {
  const session = await resolveTmuxSession(vars.slotId, vars);
  const recovered = await recoverRunningReviewAgent({
    vars,
    runner,
    model,
    taskDir,
    slotId: _slotId,
    runId: _runId,
    session,
    reviewTimeoutMs,
    loopNumber,
    validationDepth,
    artifactScope,
  });
  if (recovered) return recovered;
  const startedAt = new Date().toISOString();
  const reviewSnapshot = await captureReviewSnapshot(vars, taskDir, loopNumber, artifactScope);
  const artifactDir = reviewArtifactDir(loopNumber, artifactScope);
  let progressWatcher: { stop(): void } | null = null;
  let activeTaskSet = false;
  let completedSuccessfully = false;
  const sessionFilesBefore = await bestEffortListRunnerSessionFiles(vars, runner);
  let sessionMeta: ReviewSessionMeta = {
    runnerSessionPath: null,
    runnerSessionId: null,
    error: sessionFilesBefore.error,
  };
  const parentRunForAlloc = getRun(_runId);
  // Warm reuse is same-run only: scope must match on every field or the claim
  // returns null and this pass behaves exactly like fresh-per-pass.
  const warmScope: WarmReviewerScope = {
    runId: _runId,
    taskDir,
    artifactScope: artifactScope ?? null,
    runner,
    subjectRef: parentRunForAlloc?.branch ?? null,
  };
  let warmSession = shouldAttemptWarmResume(
    sessionPolicy,
    loopNumber,
    runnerSupportsSessionReload(runner),
  )
    ? claimWarmReviewerSession(warmScope)
    : null;
  // Set once the resumed session actually launched — the cold-fallback path and
  // fresh passes leave it false so registration binds the freshly captured id.
  let warmResumed = false;
  const allocated = allocateReviewerContext({
    runId: _runId,
    runner,
    model,
    existing: parentRunForAlloc?.agentContexts ?? [],
    // warm-per-reviewer keeps one reviewer identity (context id + tab name)
    // across the run's review loops; fresh-per-pass numbers a new tab per pass.
    mode: reviewerAllocationMode(sessionPolicy),
  });
  const reviewWindow = allocated.windowName;
  const reviewChecklistTarget = targetForChecklistBasename(reviewerChecklistBasename(allocated.id));
  const feedbackRelPath = reviewerFeedbackRelPath(allocated.id);
  let reviewContext = await upsertAgentContext(_runId, 'self-review', {
    id: allocated.id,
    label: allocated.label,
    status: 'launching',
    attemptStartedAt: startedAt,
    taskFile: taskDirRelPath(taskDir, reviewChecklistTarget.checklist),
    signalFile: taskDirRelPath(taskDir, reviewChecklistTarget.signal),
    artifactScope: artifactScope ?? null,
    reviewLoopNumber: loopNumber,
    runner,
    model,
    target: null,
  });

  try {
    // 1. Kill only this reviewer tab before relaunch (other same-run reviewers stay).
    await killSelfReviewWindow(vars, session, 'pre-launch cleanup', reviewWindow);

    // 1b. Clear prior-pass artifacts so waitForReviewCompletion / readReviewFeedback
    // can't short-circuit on stale files (caused retry verdict to mirror pass 1).
    await removeSlotFiles(vars, [
      `${vars.remoteRepo}/${taskDir}/${feedbackRelPath}`,
      slotTaskRelPath(vars, taskDir, reviewChecklistTarget.signal),
    ]);

    // 2. Create new window in same session with a short operator-addressable name.
    const newWinResult = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `new-window -t ${shellQuote(session)} -n ${shellQuote(reviewWindow)} -d 2>&1`,
      ),
    );
    debugSelfReviewLog(
      `[self-review] new-window: exit=${newWinResult.exitCode} out=${newWinResult.stdout.trim()} err=${newWinResult.stderr.trim()}`,
    );
    if (newWinResult.exitCode !== 0) {
      throw new Error(
        `Failed to create self-review tmux window ${session}:${reviewWindow}: ${newWinResult.stderr || newWinResult.stdout || `exit ${newWinResult.exitCode}`}`,
      );
    }
    reviewContext =
      (await upsertAgentContext(_runId, 'self-review', {
        id: allocated.id,
        label: allocated.label,
        runner,
        model,
        target: {
          session,
          window: reviewWindow,
          pane: null,
          target: `${session}:${reviewWindow}`,
        },
      })) ?? reviewContext;
    await new Promise((r) => setTimeout(r, 500));
    await ensureTmuxWindowMinimumSize(vars, `${session}:${reviewWindow}`);

    // Log active windows so we can see what's in the session
    const winList = (
      await execOnSlot(vars, tmuxShellSnippet(`list-windows -t ${shellQuote(session)} 2>/dev/null`))
    ).stdout.trim();
    debugSelfReviewLog(`[self-review] windows in ${session}: ${winList}`);

    // 3. Write expanded self-review TASK.md to the slot before launch so
    // non-interactive runners (e.g. Codex) can read it immediately.
    // The template is in projects/<project>/templates/worker/self-review.md with {{VAR}} placeholders.
    // Long multiline prompts get bracketed-pasted by tmux — so we write to a file.
    const taskMdPath = taskDirRelPath(taskDir, reviewChecklistTarget.checklist);
    const expandedTemplate = scopeReviewFeedbackPath(
      await expandSelfReviewTemplate(vars, taskDir, _runId, validationDepth),
      feedbackRelPath,
    );
    await writeTextFileOnSlot(vars, taskMdPath, expandedTemplate);
    await syncChecklistTargetForRole(vars, taskDir, 'self-review', {
      reportPath: feedbackRelPath,
      target: reviewChecklistTarget,
    });

    // Mark the reviewer-specific checklist as the active task file for progress tracking.
    updateRun(_runId, { activeTaskFile: taskMdPath });
    activeTaskSet = true;
    if (reviewContext) await watchContext(vars.slotId, reviewContext);

    // Interactive runners receive a short prompt after the TUI is ready; the
    // detailed instructions live in the reviewer checklist. Exec runners bake a
    // self-contained prompt into their launch command.
    const parentRun = getRun(_runId);
    const markPrompt = selfReviewChecklistMarkPrompt(
      taskDir,
      taskMdPath,
      reviewChecklistTarget,
      feedbackRelPath,
    );
    // Pre-flight: a claim whose persisted session file is gone (or was never
    // recorded) cannot resume — downgrade to a fresh cold launch up front
    // instead of burning the 120s ready-timeout on a dead `resume`.
    if (warmSession) {
      const probe = warmSession.runnerSessionPath
        ? await execOnSlot(vars, resumableSessionProbeCommand(warmSession.runnerSessionPath), {
            timeout: 10_000,
          })
        : null;
      if (!probe || probe.exitCode !== 0) {
        console.warn(
          `[self-review] warm ${runner} session ${warmSession.runnerSessionId} has no resumable session file — falling back to a fresh launch`,
        );
        warmSession = null;
      }
    }
    const basePrompt = runnerNeedsPostLaunchPrompt(runner)
      ? `${await resolveWorkerDispatchPrompt(parentRun?.project ?? vars.projectName, {
          taskFile: taskMdPath,
          taskDir,
        })}\n\n${markPrompt}`
      : `Read ${taskMdPath} and execute all steps exactly as written. Do NOT run /review. ${markPrompt}`;
    // A warm re-review resumes the reviewer that produced the previous loop's
    // findings, so its prompt narrows the scope to the worker's fixes since then.
    // The cold-fallback path must NOT use this preamble — a fresh reviewer is not
    // "the same reviewer session" and needs the full review contract.
    const warmPrompt = warmSession
      ? `You are the same reviewer session that produced the findings in ${taskDir}/${reviewArtifactDir(warmSession.lastLoopNumber, artifactScope)}/review-feedback.md. The worker has applied fixes since. Re-review ONLY the worker's fixes against your previous findings — do not re-review unchanged code — then complete the checklist's output contract (feedback + signal) as written.\n\n${basePrompt}`
      : basePrompt;
    let taskPrompt = warmPrompt;

    // 4. Launch review agent in the review window. Inherit the run's safety
    // tier (ADR-023) so the review agent runs with the same posture as the worker.
    // Warm passes resume the prior reviewer's persisted runner session instead of
    // cold-launching; every other step (window lifecycle, prompt delivery,
    // artifacts, teardown) is identical to fresh-per-pass.
    const parentSafetyTier = parentRun?.safetyTier;
    const runtimeDir = await resolveProjectRuntimeDir(parentRun?.project);
    const reviewTarget = `${session}:${reviewWindow}`;
    const coldLaunchCommand = () =>
      buildLaunchCommand(vars, runner, model, taskPrompt, {
        taskFile: taskMdPath,
        taskDir,
        effort: parentRun?.effort,
        safetyTier: parentSafetyTier,
        runtimeDir,
      });
    // Launch → settle → capture session metadata → bind context → deliver prompt.
    // `claimed` is the warm session being resumed: capture is diff-based (not
    // pane-scoped), so a resume that continues the SAME transcript file captures
    // nothing — seed the claimed id/path so usage extraction and the persisted
    // context binding still work.
    const launchReviewer = async (
      launchCmd: string,
      prompt: string,
      claimed: typeof warmSession,
    ): Promise<void> => {
      const handoffAckSinceMs = Date.now();
      debugSelfReviewLog(`[self-review] launching (${runner}) via respawn-window: ${launchCmd}`);
      await respawnTmuxWindowWithCommand(vars, reviewTarget, launchCmd);
      await new Promise((r) => setTimeout(r, TMUX_WINDOW_RESPAWN_SETTLE_MS));
      sessionMeta = await bestEffortCaptureRunnerSessionMetadata(
        vars,
        runner,
        sessionFilesBefore.paths,
        sessionFilesBefore.error,
        { sinceMs: handoffAckSinceMs },
      );
      if (claimed) {
        // Use the claimed binding UNCONDITIONALLY on a resume: capture is
        // diff-based and prefers fresh paths, so concurrent same-runner
        // activity can produce a non-null FOREIGN binding — which would then
        // drive the persisted context and cost attribution. The claimed
        // session IS the reviewer's session (codex/grok continue the same
        // file; for claude this trades exact per-loop usage attribution for
        // never attributing a foreign session).
        sessionMeta = {
          runnerSessionId: claimed.runnerSessionId,
          runnerSessionPath: claimed.runnerSessionPath,
          error: sessionMeta.error,
        };
      }
      reviewContext =
        (await upsertAgentContext(_runId, 'self-review', {
          id: allocated.id,
          label: allocated.label,
          status: 'working',
          runnerSessionId: sessionMeta.runnerSessionId,
          runnerSessionPath: sessionMeta.runnerSessionPath,
        })) ?? reviewContext;

      // For interactive runners, send the task with verify-and-retry.
      // Use the same runner-neutral post-launch protocol as dispatch: wait for a
      // stable runner prompt, send, then verify that the pane echoes our marker.
      if (runnerNeedsPostLaunchPrompt(runner)) {
        const signalPath = taskDirRelPath(taskDir, reviewChecklistTarget.signal);
        const promptAcceptanceBaselineMs = await captureRunnerPromptAcceptanceBaseline(
          vars,
          reviewTarget,
          runner,
          handoffAckSinceMs,
        );
        try {
          await sendRunnerPostLaunchPrompt(
            vars,
            reviewTarget,
            runner,
            prompt,
            reviewChecklistTarget.checklist,
            'self-review',
            {
              readyTimeoutMs: RUNNER_LAUNCH_READY_TIMEOUT_MS,
              maxAttempts: 5,
              blockerSnapshotPath: `${taskDir}/artifacts/runner-blockers/self-review-launch.txt`,
              signalPath,
              launchAckSignalPath: signalPath,
              promptAcceptanceBaselineMs,
              requirePromptDigest: true,
              handoffAckSinceMs,
              softAcceptOnHandoffAck: true,
              runtimeDir,
            },
          );
        } catch (err) {
          const handoff = await runnerHasDurablePromptHandoff(
            vars,
            reviewTarget,
            runner,
            prompt,
            handoffAckSinceMs,
            {
              promptAcceptanceBaselineMs,
              requirePromptDigest: true,
            },
          );
          if (!handoff.accepted) throw err;
          console.warn(
            `[self-review] prompt delivery verifier failed but durable handoff passed via ${handoff.source}: ${handoff.reason}`,
          );
        }
      }
    };

    // 4/5. Launch (warm resume when claimed) and deliver the prompt. A warm
    // resume that fails for any reason past the pre-flight (corrupt session,
    // runner refuses the id, ready-timeout) is retried ONCE as a cold fresh
    // launch with the full (non-narrowed) prompt.
    if (warmSession) {
      const reloadCmd = `${WORKER_ENV_PREFIX} && ${buildRunnerSessionReloadCommand(
        vars,
        runner,
        model,
        warmSession.runnerSessionId,
        { effort: parentRun?.effort, safetyTier: parentSafetyTier, runtimeDir, taskDir },
      )}`;
      try {
        await launchReviewer(reloadCmd, taskPrompt, warmSession);
        warmResumed = true;
      } catch (err) {
        console.warn(
          `[self-review] warm resume of ${runner} session ${warmSession.runnerSessionId} failed (${(err as Error).message}) — retrying with a cold fresh launch`,
        );
        warmSession = null;
        taskPrompt = basePrompt;
        await launchReviewer(`${WORKER_ENV_PREFIX} && ${coldLaunchCommand()}`, taskPrompt, null);
      }
    } else {
      await launchReviewer(`${WORKER_ENV_PREFIX} && ${coldLaunchCommand()}`, taskPrompt, null);
    }

    // 6. Watch the reviewer-specific checklist for progress + wait for completion
    const selfReviewPath = slotTaskRelPath(vars, taskDir, reviewChecklistTarget.checklist);
    progressWatcher = startProgressWatcher(vars, selfReviewPath, _runId, 'Review', {
      contextId: allocated.id,
      role: 'self-review',
    });
    const completed = await waitForReviewCompletion(
      vars,
      session,
      taskDir,
      reviewTimeoutMs,
      _runId,
      runner,
      reviewWindow,
      allocated.id,
      reviewChecklistTarget.signal,
      feedbackRelPath,
    );
    if (!completed) {
      throw new Error(
        `Self-review agent did not complete within ${reviewTimeoutMs}ms (${reviewTimeoutMs / 60_000}min). Bump self_review.review_timeout_min in projects/${vars.projectName}/project.json if reviews need longer.`,
      );
    }
    await waitForSessionTranscriptToSettle(vars, sessionMeta.runnerSessionPath);
    const usage = sessionMeta.error
      ? unavailableRunnerSessionUsage({
          runner,
          runnerSessionId: sessionMeta.runnerSessionId,
          runnerSessionPath: sessionMeta.runnerSessionPath,
          error: sessionMeta.error,
        })
      : await extractRunnerSessionUsage({
          slotId: vars.slotId,
          vars,
          runner,
          runnerSessionId: sessionMeta.runnerSessionId,
          runnerSessionPath: sessionMeta.runnerSessionPath,
        });

    // 7. Read reviewer-specific feedback.
    const feedback = await readReviewFeedback(vars, taskDir, feedbackRelPath);
    if (feedback.incomplete) {
      return {
        ...feedback,
        validationDepth,
        usage,
        reviewSnapshot: reviewSnapshot.snapshot,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
    completedSuccessfully = true;
    if (sessionPolicy === 'warm-per-reviewer') {
      // Record this pass's session so the next loop of THIS run can resume it.
      // On a warm-resumed pass keep the CLAIMED binding: session capture is
      // diff-based, so concurrent same-runner activity on the slot could
      // mis-attribute a foreign transcript — and a mis-bound id would be
      // RESUMED next loop. (For claude this means later loops resume the
      // original lineage rather than each resume's successor id — trading one
      // loop of reviewer context for never binding a foreign session.)
      const reusableSessionId =
        warmResumed && warmSession ? warmSession.runnerSessionId : sessionMeta.runnerSessionId;
      const reusableSessionPath =
        warmResumed && warmSession ? warmSession.runnerSessionPath : sessionMeta.runnerSessionPath;
      if (reusableSessionId && runnerSupportsSessionReload(runner)) {
        registerWarmReviewerSession({
          ...warmScope,
          contextId: allocated.id,
          windowName: reviewWindow,
          slotId: vars.slotId,
          runnerSessionId: reusableSessionId,
          runnerSessionPath: reusableSessionPath ?? null,
          lastLoopNumber: loopNumber,
        });
      }
    }
    const persisted = await persistReviewOutputArtifacts({
      vars,
      taskDir,
      taskMdPath,
      signalBasename: reviewChecklistTarget.signal,
      feedbackRelPath,
      artifactDir,
      feedbackIncomplete: feedback.incomplete ?? false,
    });
    const completedAt = new Date().toISOString();
    return {
      ...feedback,
      validationDepth,
      usage,
      reviewSnapshot: reviewSnapshot.snapshot,
      artifactPaths: [...reviewSnapshot.artifactPaths, ...persisted.artifactPaths],
      taskProgressArtifactPath: persisted.taskProgressArtifactPath,
      timeline: [
        {
          kind: loopNumber > 1 ? 're-review' : 'review',
          loopNumber,
          runner,
          model,
          startedAt,
          completedAt,
          durationMs: durationBetween(startedAt, completedAt),
          verdict: feedback.verdict === 'pass' ? 'pass' : 'issues',
          unresolvedCount: feedback.verdict === 'pass' ? 0 : feedback.issues.length,
          artifactPaths: [...reviewSnapshot.artifactPaths, ...persisted.artifactPaths],
        },
      ],
      startedAt,
      completedAt,
    };
  } catch (err) {
    await markAgentContextStatus(_runId, 'self-review', 'failed', {
      id: allocated.id,
      lastSignalAt: new Date().toISOString(),
    });
    throw err;
  } finally {
    progressWatcher?.stop();
    // Cleanup must not mask the original throw above — log and continue so the outer error
    // propagates intact to the run-engine catch. Keep failed review panes alive for
    // forensics/manual recovery; only successful review agents are torn down.
    try {
      await unwatchContext(vars.slotId, allocated.id);
    } catch (cleanupErr) {
      console.warn(`[self-review] cleanup unwatchContext failed: ${(cleanupErr as Error).message}`);
    }
    if (activeTaskSet) {
      updateRun(_runId, { activeTaskFile: undefined });
      const parentRun = getRun(_runId);
      await restoreWorkerChecklistTargetFromSlot(
        vars,
        taskDir,
        parentRun ? { flowType: parentRun.flowType, mode: parentRun.mode ?? undefined } : undefined,
      );
    }
    if (completedSuccessfully) {
      try {
        await killSelfReviewWindow(vars, session, 'post-run cleanup', reviewWindow);
      } catch (cleanupErr) {
        console.warn(`[self-review] cleanup killWindow failed: ${(cleanupErr as Error).message}`);
      }
    }
  }
}

async function waitForReviewCompletion(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
  taskDir: string,
  timeoutMs: number,
  runId: string,
  runner: string,
  reviewWindow: string,
  reviewContextId: string,
  signalBasename: string,
  feedbackRelPath: string,
): Promise<boolean> {
  const start = Date.now();
  const pollInterval = 10_000; // 10s
  let overdueWarned = false;
  // Re-enforce the minimum window size before polling: completion matching
  // reads the last pane lines, which a reflowed 5-row window truncates.
  await ensureTmuxWindowMinimumSize(vars, `${session}:${reviewWindow}`);

  while (true) {
    await new Promise((r) => setTimeout(r, pollInterval));
    let reviewerActive = false;

    // Check if the review window still exists
    const hasWindow =
      (
        await execOnSlot(
          vars,
          tmuxShellSnippet(
            `list-windows -t ${shellQuote(session)} -F '#{window_name}' 2>/dev/null | grep -Fxq ${shellQuote(reviewWindow)}`,
          ),
        )
      ).exitCode === 0;

    if (!hasWindow) {
      // Window disappearance is only success after the review artifact exists.
      const hasFeedback = (
        await execOnSlot(
          vars,
          `test -f ${shellQuote(`${vars.remoteRepo}/${taskDir}/${feedbackRelPath}`)} && echo yes`,
        )
      ).stdout.trim();
      if (hasFeedback === 'yes') {
        debugSelfReviewLog(`[self-review] review window gone + feedback written — agent completed`);
        await markAgentContextStatus(runId, 'self-review', 'complete', {
          id: reviewContextId,
          lastSignalAt: new Date().toISOString(),
        });
        return true;
      }
      console.warn(
        `[self-review] review window gone before feedback file existed — waiting for timeout`,
      );
      if (Date.now() - start >= timeoutMs) {
        console.warn(
          `[self-review] review window disappeared without feedback after ${timeoutMs}ms`,
        );
        return false;
      }
      continue;
    }

    // Check if the configured runner process is still running in the review pane.
    const panePid = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(
          `list-panes -t ${shellQuote(`${session}:${reviewWindow}`)} -F '#{pane_pid}' 2>/dev/null | head -1`,
        ),
      )
    ).stdout.trim();

    if (panePid) {
      const agentAlive = await isRunnerAliveUnderPane(vars, panePid, runner);
      reviewerActive = agentAlive;

      if (!agentAlive) {
        // Runner exited but window still exists — only declare done if feedback was written.
        // Without this gate, a false positive fires during runner startup before it has forked.
        const hasFeedback = (
          await execOnSlot(
            vars,
            `test -f ${shellQuote(`${vars.remoteRepo}/${taskDir}/${feedbackRelPath}`)} && echo yes`,
          )
        ).stdout.trim();
        if (hasFeedback === 'yes') {
          debugSelfReviewLog(
            `[self-review] ${runner} process exited + feedback written — agent completed`,
          );
          await markAgentContextStatus(runId, 'self-review', 'complete', {
            id: reviewContextId,
            lastSignalAt: new Date().toISOString(),
          });
          return true;
        }
        debugSelfReviewLog(
          `[self-review] no ${runner} child found but no feedback yet — may be starting up, continuing poll`,
        );
      }
    }

    // Terminal reviewer signal (complete/blocked/failed) plus feedback artifact.
    const signalRaw = (
      await execOnSlot(
        vars,
        `cat ${shellQuote(slotTaskRelPath(vars, taskDir, signalBasename))} 2>/dev/null`,
      )
    ).stdout.trim();
    let terminalSignal: ReturnType<typeof parseTerminalSelfReviewSignal> | undefined;
    try {
      terminalSignal = parseTerminalSelfReviewSignal(signalRaw);
    } catch (err) {
      debugSelfReviewLog(
        `[self-review] ignoring invalid ${signalBasename} during poll: ${(err as Error).message}`,
      );
    }
    if (terminalSignal) {
      const hasFeedback = (
        await execOnSlot(
          vars,
          `test -f ${shellQuote(`${vars.remoteRepo}/${taskDir}/${feedbackRelPath}`)} && echo yes`,
        )
      ).stdout.trim();
      if (hasFeedback === 'yes') {
        debugSelfReviewLog(
          `[self-review] terminal ${signalBasename} (status=${terminalSignal.status}) + feedback — agent completed`,
        );
        await markAgentContextStatus(runId, 'self-review', 'complete', {
          id: reviewContextId,
          lastSignalAt: new Date().toISOString(),
        });
        return true;
      }
      debugSelfReviewLog(
        `[self-review] terminal ${signalBasename} (status=${terminalSignal.status}) but ${feedbackRelPath} missing — continuing poll`,
      );
    }

    // Check pane output for signs of completion
    const pane = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(
          `capture-pane -p -t ${shellQuote(`${session}:${reviewWindow}`)} 2>/dev/null | tail -5`,
        ),
      )
    ).stdout;

    // Runner at idle prompt, not mid-tool-call.
    const tailLines = pane.split('\n');
    const reviewerAtIdlePrompt =
      tailLines.some((line) => runnerLineLooksWaiting(line, runner)) &&
      !runnerPaneShowsCurrentInteractiveProgress(pane, runner);
    if (reviewerAtIdlePrompt) {
      // Double-check: the reviewer-specific feedback file exists = work is done.
      const hasFeedback = (
        await execOnSlot(
          vars,
          `test -f ${shellQuote(`${vars.remoteRepo}/${taskDir}/${feedbackRelPath}`)} && echo yes`,
        )
      ).stdout.trim();
      if (hasFeedback === 'yes') {
        debugSelfReviewLog(`[self-review] idle prompt + feedback file — agent completed`);
        await markAgentContextStatus(runId, 'self-review', 'complete', {
          id: reviewContextId,
          lastSignalAt: new Date().toISOString(),
        });
        return true;
      }
    }

    // Shell prompt without feedback is not success — Codex can bounce back to shell after an internal shortcut.
    if (pane.match(/[\$%]\s*$/m) && !pane.includes('⏵⏵')) {
      const hasFeedback = (
        await execOnSlot(
          vars,
          `test -f ${shellQuote(`${vars.remoteRepo}/${taskDir}/${feedbackRelPath}`)} && echo yes`,
        )
      ).stdout.trim();
      if (hasFeedback === 'yes') {
        debugSelfReviewLog(`[self-review] shell prompt + feedback file — agent completed`);
        await markAgentContextStatus(runId, 'self-review', 'complete', {
          id: reviewContextId,
          lastSignalAt: new Date().toISOString(),
        });
        return true;
      }
      console.warn(
        `[self-review] shell prompt detected before feedback file existed — treating as incomplete and continuing wait`,
      );
    }

    if (Date.now() - start >= timeoutMs) {
      if (!shouldKeepWaitingForOverdueReview(reviewerActive, reviewerAtIdlePrompt)) {
        console.warn(
          `[self-review] reviewer became inactive without feedback after ${timeoutMs}ms`,
        );
        return false;
      }
      if (!overdueWarned) {
        overdueWarned = true;
        const detail =
          `Review exceeded ${timeoutMs / 60_000}min but the reviewer process is still active; ` +
          'continuing to wait. The operator may inspect or cancel the review without failing the run.';
        console.warn(`[self-review] ${detail}`);
        updateRunStep(runId, 'self-review', { detail });
      }
    }
  }
}
