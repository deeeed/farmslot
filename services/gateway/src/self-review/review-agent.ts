// self-review/review-agent.ts — launch and collect the independent self-review runner.

import path from 'node:path';

import {
  type AgentContext,
  allocateReviewerContext,
  type ReviewDiffSnapshot,
  type ReviewFixDeltaSnapshot,
  type ReviewLoopTimelineSegment,
  type ReviewSessionIntent,
  type ReviewValidationDepth,
  type RunnerSessionUsage,
  type SelfReviewIssue,
  type WorkerSignalChecklistTiming,
} from '@farmslot/protocol';

import { markAgentContextStatus, upsertAgentContext } from '../agents/contexts.js';
import { loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import {
  ensureTmuxWindow,
  killTmuxWindowById,
  resolveExactTmuxWindowPane,
  resolveTmuxSession,
  respawnTmuxWindowWithCommand,
  shellQuote,
  TMUX_WINDOW_RESPAWN_SETTLE_MS,
  tmuxShellSnippet,
  type TmuxWindowRef,
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
  retainedReviewerDeliveryPlan,
  runnerHasDurablePromptHandoff,
  runnerLineLooksWaiting,
  runnerNeedsPostLaunchPrompt,
  runnerPaneShowsCurrentInteractiveProgress,
  sendRunnerPostLaunchPrompt,
  WORKER_ENV_PREFIX,
} from '../runners/registry.js';
import {
  captureRunnerSessionMetadata,
  isRunnerAliveUnderPane,
  resumableSessionProbeCommand,
} from '../runners/session-process.js';
import {
  deliverPromptToLiveRunner,
  resetLiveRunnerContext,
} from '../runners/session-reactivation.js';
import { resolveWorkerDispatchPrompt } from '../runners/worker-prompt.js';
import { clearRunActiveTaskFile, getRun, updateRun } from '../runs/store.js';
import {
  extractRunnerSessionUsage,
  unavailableRunnerSessionUsage,
} from '../runtime/session-usage.js';
import {
  checklistMarkerCommand,
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
  invalidateWarmReviewerSessions,
  registerWarmReviewerSession,
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
import {
  isSuccessfulTerminalReviewSignal,
  isTerminalReviewArtifactError,
  TerminalReviewArtifactError,
  terminalReviewArtifactErrorForCompletion,
} from './terminal-result.js';

interface ReconciledReviewerWindow extends TmuxWindowRef {
  disposition: 'existing' | 'created';
  runnerAlive: boolean;
}

async function reconcileReviewerWindow(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
  windowName: string,
  runner: string,
): Promise<ReconciledReviewerWindow> {
  // Do not resize shared tmux windows here. Prompt acceptance and completion
  // are hook/signal based; changing the server size corrupts attached operator
  // clients without strengthening the runner contract.
  const ensured = await ensureTmuxWindow(vars, session, windowName);
  const candidates = await Promise.all(
    ensured.windows.map(async (window) => ({
      ...window,
      runnerAlive: await isRunnerAliveUnderPane(vars, window.panePid, runner, { timeout: 10_000 }),
    })),
  );
  const live = candidates.filter((window) => window.runnerAlive);
  const newestFirst = (a: TmuxWindowRef, b: TmuxWindowRef) =>
    (Number.isFinite(b.activityAt) ? b.activityAt : 0) -
      (Number.isFinite(a.activityAt) ? a.activityAt : 0) || b.windowIndex - a.windowIndex;
  const canonical = [...live].sort(newestFirst)[0] ?? [...candidates].sort(newestFirst)[0];
  if (!canonical) throw new Error(`No tmux reviewer window available for ${session}:${windowName}`);

  for (const duplicate of candidates) {
    if (duplicate.windowId === canonical.windowId) continue;
    await killTmuxWindowById(vars, duplicate.windowId);
  }
  if (candidates.length > 1) {
    debugSelfReviewLog(
      `[self-review] reconciled ${candidates.length} ${session}:${windowName} windows to ${canonical.windowId}`,
    );
  }
  return { ...canonical, disposition: ensured.disposition };
}

/** Progress mark writes status "running"; only terminal worker signals count as done. */
export function parseTerminalSelfReviewSignal(raw: string) {
  return terminalWorkerSignalFromRaw(raw);
}

export function applyTerminalReviewSignal(
  feedback: ReviewAgentResult,
  signal: ReturnType<typeof parseTerminalSelfReviewSignal>,
): ReviewAgentResult {
  if (!signal) return feedback;
  const withTiming = signal.checklistTiming
    ? { ...feedback, checklistTiming: signal.checklistTiming }
    : feedback;
  if (isSuccessfulTerminalReviewSignal(signal)) return withTiming;
  return { ...withTiming, verdict: 'pass', issues: [], incomplete: true };
}

async function readTerminalReviewSignal(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  signalBasename: string,
) {
  const raw = (
    await execOnSlot(
      vars,
      `cat ${shellQuote(slotTaskRelPath(vars, taskDir, signalBasename))} 2>/dev/null`,
    )
  ).stdout.trim();
  return parseTerminalSelfReviewSignal(raw);
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
  resultRelPath?: string | null,
): string {
  const markWithTarget = checklistMarkerCommand(taskDir, reviewTarget);
  return (
    `Follow ${taskMdPath} top-to-bottom. After EVERY checklist step run ${markWithTarget} N ` +
    `(bootstrap with ${markWithTarget} start — same path as the checklist header). ` +
    `Skipping ${markWithTarget} leaves the run at 0/N in the UI. ` +
    `Write ${taskDir}/${feedbackRelPath}` +
    (resultRelPath ? ` and ${taskDir}/${resultRelPath}` : '') +
    `, then ${markWithTarget} complete.`
  );
}

export function reviewerChecklistBasename(contextId: string): string {
  return `SELF-REVIEW.${contextId}.md`;
}

export function reviewerFeedbackRelPath(contextId: string): string {
  return `artifacts/review-feedback.${contextId}.md`;
}

export function reviewerResultRelPath(contextId: string): string {
  return `artifacts/review-result.${contextId}.json`;
}

function continuationReviewScope(params: {
  priorHeadSha: string | null;
  currentHeadSha: string | null;
  priorArtifactDir: string;
}): string {
  const reviewRange =
    params.priorHeadSha && params.currentHeadSha
      ? `${params.priorHeadSha}..${params.currentHeadSha}`
      : 'unavailable';
  return `## Authoritative continuation scope

This is an incremental continuation of the same review, not a new full-branch review.

- Previous reviewed HEAD: \`${params.priorHeadSha ?? 'unavailable'}\`
- Current HEAD: \`${params.currentHeadSha ?? 'unavailable'}\`
- Exact review range: \`${reviewRange}\`
- Prior review artifacts: \`${params.priorArtifactDir}\`

This scope overrides generic full-branch diff instructions below. When the exact range is
available, inspect \`git diff --stat ${reviewRange}\` and \`git diff ${reviewRange}\` instead of
\`main...HEAD\`. Recheck the prior findings and validate affected surfaces only. Expand beyond
that range only when the delta invalidates a prior assumption, and explain why in the report.
`;
}

function structuredReviewResultInstructions(resultRelPath: string): string {
  return `

## Machine-readable review result

Write \`${resultRelPath}\` as JSON before completing:

\`\`\`json
{
  "schemaVersion": 1,
  "verdict": "pass",
  "issues": []
}
\`\`\`

For an issues verdict, set \`verdict\` to \`"issues"\` and include at least one
\`{ "file": "path", "line": 1, "description": "specific finding" }\` entry.
The JSON verdict and issues are authoritative; the Markdown file is the human-readable report.`;
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

interface ReviewPromptRecoveryDependencies {
  resolveExactTmuxWindowPane: typeof resolveExactTmuxWindowPane;
  isRunnerAliveUnderPane: typeof isRunnerAliveUnderPane;
  resolveWorkerDispatchPrompt: typeof resolveWorkerDispatchPrompt;
  resolveProjectRuntimeDir: typeof resolveProjectRuntimeDir;
  sendRunnerPostLaunchPrompt: typeof sendRunnerPostLaunchPrompt;
}

const defaultReviewPromptRecoveryDependencies: ReviewPromptRecoveryDependencies = {
  resolveExactTmuxWindowPane,
  isRunnerAliveUnderPane,
  resolveWorkerDispatchPrompt,
  resolveProjectRuntimeDir,
  sendRunnerPostLaunchPrompt,
};

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
    | 'id'
    | 'runner'
    | 'taskFile'
    | 'signalFile'
    | 'reviewResultFile'
    | 'target'
    | 'attemptStartedAt'
    | 'startedAt'
  >,
  dependencyOverrides: Partial<ReviewPromptRecoveryDependencies> = {},
): Promise<'delivered' | 'inactive' | 'unsupported'> {
  const dependencies = {
    ...defaultReviewPromptRecoveryDependencies,
    ...dependencyOverrides,
  };
  const target = context.target?.target;
  const taskMdPath = context.taskFile;
  const runner = context.runner;
  if (!target || !taskMdPath || !runner || !runnerNeedsPostLaunchPrompt(runner)) {
    return 'unsupported';
  }
  const pane = await dependencies.resolveExactTmuxWindowPane(vars, target);
  if (!pane) return 'inactive';
  if (
    !(await dependencies.isRunnerAliveUnderPane(vars, pane.panePid, runner, { timeout: 10_000 }))
  ) {
    return 'inactive';
  }

  const taskDir = path.posix.dirname(taskMdPath);
  const reviewTarget = targetForChecklistBasename(path.posix.basename(taskMdPath));
  const feedbackRelPath = reviewerFeedbackRelPath(context.id);
  const resultRelPath = context.reviewResultFile ?? null;
  const parentRun = getRun(runId);
  const prompt = `${await dependencies.resolveWorkerDispatchPrompt(
    parentRun?.project ?? vars.projectName,
    {
      taskFile: taskMdPath,
      taskDir,
    },
  )}\n\n${selfReviewChecklistMarkPrompt(
    taskDir,
    taskMdPath,
    reviewTarget,
    feedbackRelPath,
    resultRelPath,
  )}`;
  const attemptStartedAtMs = Date.parse(context.attemptStartedAt ?? context.startedAt ?? '');
  const baselineMs = Number.isFinite(attemptStartedAtMs) ? attemptStartedAtMs : Date.now();
  const runtimeDir = await dependencies.resolveProjectRuntimeDir(parentRun?.project);
  await dependencies.sendRunnerPostLaunchPrompt(
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

export async function waitForRecoveredReviewerOrCleanup(
  waitForCompletion: () => Promise<boolean>,
  abandonRecoveredReviewer: (reason: string, status?: 'failed' | 'blocked') => Promise<unknown>,
): Promise<boolean> {
  try {
    if (await waitForCompletion()) return true;
  } catch (error) {
    if (!isTerminalReviewArtifactError(error)) throw error;
    await abandonRecoveredReviewer('invalid recovered reviewer artifact cleanup', 'blocked');
    throw error;
  }
  await abandonRecoveredReviewer('recovered reviewer timeout');
  return false;
}

export function scopeReviewFeedbackPath(
  template: string,
  feedbackRelPath: string,
  resultRelPath?: string | null,
): string {
  const scoped = template
    .replace(
      LEGACY_REVIEW_FEEDBACK_ARTIFACT_PATTERN,
      (_match, prefix: string) => `${prefix}${feedbackRelPath}`,
    )
    .replace(
      LEGACY_REVIEW_FEEDBACK_BASENAME_PATTERN,
      (_match, prefix: string) => `${prefix}${feedbackRelPath}`,
    );
  const feedbackScoped =
    scoped !== template
      ? scoped
      : `${template.trimEnd()}\n\nWrite reviewer feedback to ${feedbackRelPath}.`;
  return resultRelPath
    ? `${feedbackScoped.trimEnd()}${structuredReviewResultInstructions(resultRelPath)}`
    : feedbackScoped;
}

// Exported for self-review.test.ts to seed runSelfReviewRetryLoop fixtures. Not part of the
// gateway's public surface — keep internal to this module's tests.
export interface ReviewAgentResult {
  verdict: 'pass' | 'issues';
  issues: SelfReviewIssue[];
  validationDepth?: ReviewValidationDepth;
  usage?: RunnerSessionUsage;
  checklistTiming?: WorkerSignalChecklistTiming;
  reviewSnapshot?: ReviewDiffSnapshot;
  fixDelta?: ReviewFixDeltaSnapshot;
  artifactPaths?: string[];
  taskProgressArtifactPath?: string;
  timeline?: ReviewLoopTimelineSegment[];
  startedAt?: string;
  completedAt?: string;
  incomplete?: boolean; // true when feedback file was never written (agent didn't finish)
  /** Stable invalid artifact: recovery must stop and ask the operator, not poll again. */
  terminalInvalidReason?: string;
}

async function persistReviewOutputArtifacts(params: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  taskDir: string;
  taskMdPath: string;
  signalBasename: string;
  feedbackRelPath: string;
  resultRelPath?: string | null;
  artifactDir: string;
  feedbackIncomplete: boolean;
}): Promise<{ artifactPaths: string[]; taskProgressArtifactPath: string }> {
  const {
    vars,
    taskDir,
    taskMdPath,
    signalBasename,
    feedbackRelPath,
    resultRelPath,
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

    if (resultRelPath) {
      const resultRel = `${artifactDir}/review-result.json`;
      const resultCopy = await execOnSlot(
        vars,
        `cp ${shellQuote(`${vars.remoteRepo}/${taskDir}/${resultRelPath}`)} ${shellQuote(`${vars.remoteRepo}/${taskDir}/${resultRel}`)}`,
        { timeout: 10_000 },
      );
      if (resultCopy.exitCode !== 0) {
        throw new Error(
          `Failed to persist structured review result: ${resultCopy.stderr || resultCopy.stdout || `exit ${resultCopy.exitCode}`}`,
        );
      }
      persistedArtifacts.push(resultRel);
    }
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

  const abandonRecoveredReviewer = async (
    reason: string,
    status: 'failed' | 'blocked' = 'failed',
  ): Promise<null> => {
    await markAgentContextStatus(params.runId, 'self-review', status, { id: context.id });
    try {
      if (context.target?.target?.startsWith('@')) {
        await killTmuxWindowById(params.vars, context.target.target);
      } else {
        await killSelfReviewWindow(params.vars, params.session, reason, context.target?.window);
      }
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
  const recoveredLoopNumber = context.reviewLoopNumber ?? params.loopNumber;
  const recoveredArtifactScope = context.artifactScope ?? params.artifactScope;
  const reviewSnapshot = await readPersistedReviewSnapshot(
    params.vars,
    params.taskDir,
    recoveredLoopNumber,
    recoveredArtifactScope,
  );
  if (!reviewSnapshot) {
    console.warn(
      `[self-review] run ${params.runId.slice(0, 8)} — recovered reviewer ${context.id} has no valid launch snapshot; starting a fresh review`,
    );
    return abandonRecoveredReviewer('snapshot-less recovered reviewer cleanup');
  }
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
  const reviewTarget = context.target.target ?? pane.paneId;
  const signalBasename = path.posix.basename(context.signalFile);
  const feedbackRelPath = reviewerFeedbackRelPath(context.id);
  const resultRelPath = context.reviewResultFile ?? null;
  const watcher = startProgressWatcher(params.vars, context.taskFile, params.runId, 'Review', {
    contextId: context.id,
    role: 'self-review',
  });
  try {
    const completed = await waitForRecoveredReviewerOrCleanup(
      () =>
        waitForReviewCompletion(
          params.vars,
          reviewTarget,
          params.taskDir,
          params.reviewTimeoutMs,
          params.runId,
          params.runner,
          context.id,
          signalBasename,
          feedbackRelPath,
          resultRelPath,
        ),
      abandonRecoveredReviewer,
    );
    if (!completed) return null;
    const terminalSignal = await readTerminalReviewSignal(
      params.vars,
      params.taskDir,
      signalBasename,
    );
    const feedback = applyTerminalReviewSignal(
      await readReviewFeedback(params.vars, params.taskDir, feedbackRelPath, resultRelPath),
      terminalSignal,
    );
    const terminalArtifactError = terminalReviewArtifactErrorForCompletion(
      context.id,
      feedback.terminalInvalidReason,
    );
    if (terminalArtifactError) {
      await abandonRecoveredReviewer('invalid recovered reviewer artifact cleanup', 'blocked');
      throw terminalArtifactError;
    }
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
      resultRelPath,
      artifactDir: reviewArtifactDir(recoveredLoopNumber, recoveredArtifactScope),
      feedbackIncomplete: feedback.incomplete ?? false,
    });
    const startedAt = context.attemptStartedAt ?? context.startedAt ?? new Date().toISOString();
    const completedAt = new Date().toISOString();
    return {
      ...feedback,
      validationDepth: params.validationDepth,
      usage,
      reviewSnapshot: reviewSnapshot.snapshot,
      artifactPaths: [...reviewSnapshot.artifactPaths, ...persisted.artifactPaths],
      taskProgressArtifactPath: persisted.taskProgressArtifactPath,
      timeline: [
        {
          kind: recoveredLoopNumber > 1 ? 're-review' : 'review',
          loopNumber: recoveredLoopNumber,
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
    clearRunActiveTaskFile(params.runId, context.taskFile);
    const latest = getRun(params.runId);
    await restoreWorkerChecklistTargetFromSlot(
      params.vars,
      params.taskDir,
      latest ? { flowType: latest.flowType, mode: latest.mode ?? undefined } : undefined,
    );
    // Keep the canonical reviewer window after successful recovery. The next
    // review retargets it; run/slot teardown owns final cleanup.
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
  sessionIntent: ReviewSessionIntent = 'reset',
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
  const sessionFilesBefore = await bestEffortListRunnerSessionFiles(vars, runner);
  let sessionMeta: ReviewSessionMeta = {
    runnerSessionPath: null,
    runnerSessionId: null,
    error: sessionFilesBefore.error,
  };
  const parentRunForAlloc = getRun(_runId);
  // Warm reuse is same-run only. Fix/re-review passes require the same artifact
  // scope; an explicit next-generation continuation may advance that scope
  // while run, task, runner, and subject lineage remain identical.
  const warmScope: WarmReviewerScope = {
    runId: _runId,
    taskDir,
    artifactScope: artifactScope ?? null,
    runner,
    subjectRef: parentRunForAlloc?.branch ?? null,
  };
  const continuingPriorGeneration = sessionIntent === 'resume' && loopNumber === 1;
  const retainReviewerSession = sessionPolicy === 'warm-per-reviewer' || continuingPriorGeneration;
  if (sessionIntent === 'reset' && loopNumber === 1) {
    invalidateWarmReviewerSessions(_runId, runner);
  }
  const runnerCanResume = runnerSupportsSessionReload(runner);
  let warmSession =
    runnerCanResume &&
    (continuingPriorGeneration || shouldAttemptWarmResume(sessionPolicy, loopNumber, true))
      ? claimWarmReviewerSession(warmScope, {
          allowArtifactScopeChange: continuingPriorGeneration,
          consume: true,
        })
      : null;
  const allocated = allocateReviewerContext({
    runId: _runId,
    runner,
    model,
  });
  const reviewWindow = allocated.windowName;
  const reviewChecklistTarget = targetForChecklistBasename(reviewerChecklistBasename(allocated.id));
  const feedbackRelPath = reviewerFeedbackRelPath(allocated.id);
  const resultRelPath = reviewerResultRelPath(allocated.id);
  const taskMdPath = taskDirRelPath(taskDir, reviewChecklistTarget.checklist);
  let reviewContext = await upsertAgentContext(_runId, 'self-review', {
    id: allocated.id,
    label: allocated.label,
    status: 'launching',
    attemptStartedAt: startedAt,
    // The worker establishes the new opaque attempt identity with `mark start`.
    // Do not let a warm context expose the previous attempt during launch.
    signalAttemptId: undefined,
    taskFile: taskDirRelPath(taskDir, reviewChecklistTarget.checklist),
    signalFile: taskDirRelPath(taskDir, reviewChecklistTarget.signal),
    reviewResultFile: resultRelPath,
    artifactScope: artifactScope ?? null,
    reviewLoopNumber: loopNumber,
    runner,
    model,
    target: null,
  });

  try {
    // 1. Keep one stable window per runner. Reset versus resume changes runner
    // context, not topology; the runner capability decides whether delivery
    // reuses the live process or replaces it through native resume/cold launch.
    const reviewerWindow = await reconcileReviewerWindow(vars, session, reviewWindow, runner);
    const reviewTarget = reviewerWindow.windowId;

    // 1b. Clear prior-pass artifacts so waitForReviewCompletion / readReviewFeedback
    // can't short-circuit on stale files (caused retry verdict to mirror pass 1).
    await removeSlotFiles(vars, [
      `${vars.remoteRepo}/${taskDir}/${feedbackRelPath}`,
      `${vars.remoteRepo}/${taskDir}/${resultRelPath}`,
      slotTaskRelPath(vars, taskDir, reviewChecklistTarget.signal),
    ]);

    // 2. Bind the stable operator-addressable window to this review context.
    debugSelfReviewLog(
      `[self-review] reviewer window ${reviewWindow}: ${reviewerWindow.disposition} (${reviewTarget})`,
    );
    reviewContext =
      (await upsertAgentContext(_runId, 'self-review', {
        id: allocated.id,
        label: allocated.label,
        runner,
        model,
        target: {
          session,
          window: reviewWindow,
          pane: reviewerWindow.paneId,
          target: reviewTarget,
        },
      })) ?? reviewContext;

    // Log active windows so we can see what's in the session
    const winList = (
      await execOnSlot(vars, tmuxShellSnippet(`list-windows -t ${shellQuote(session)} 2>/dev/null`))
    ).stdout.trim();
    debugSelfReviewLog(`[self-review] windows in ${session}: ${winList}`);

    // 3. Write expanded self-review TASK.md to the slot before launch so
    // non-interactive runners (e.g. Codex) can read it immediately.
    // The template is in projects/<project>/templates/worker/self-review.md with {{VAR}} placeholders.
    // Long multiline prompts get bracketed-pasted by tmux — so we write to a file.
    let expandedTemplate = scopeReviewFeedbackPath(
      await expandSelfReviewTemplate(vars, taskDir, _runId, validationDepth),
      feedbackRelPath,
      resultRelPath,
    );
    if (warmSession) {
      expandedTemplate = `${continuationReviewScope({
        priorHeadSha: warmSession.lastReviewedHeadSha,
        currentHeadSha: reviewSnapshot.snapshot.headSha ?? null,
        priorArtifactDir: `${taskDir}/${reviewArtifactDir(
          warmSession.lastLoopNumber,
          warmSession.artifactScope,
        )}`,
      })}\n${expandedTemplate}`;
    }
    await writeTextFileOnSlot(vars, taskMdPath, expandedTemplate);
    await syncChecklistTargetForRole(vars, taskDir, 'self-review', {
      reportPath: feedbackRelPath,
      additionalArtifactPaths: [resultRelPath],
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
      resultRelPath,
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
      ? continuingPriorGeneration
        ? `Continue your prior review of this same run. Review only changes since your previous reviewed head and confirm prior findings remain resolved. Prior review artifacts are in ${taskDir}/${reviewArtifactDir(warmSession.lastLoopNumber, warmSession.artifactScope)}. Complete the checklist's current output contract (feedback + signal) as written.\n\n${basePrompt}`
        : `You are the same reviewer session that produced the findings in ${taskDir}/${reviewArtifactDir(warmSession.lastLoopNumber, warmSession.artifactScope)}/review-feedback.md. The worker has applied fixes since. Re-review ONLY the worker's fixes against your previous findings — do not re-review unchanged code — then complete the checklist's output contract (feedback + signal) as written.\n\n${basePrompt}`
      : basePrompt;
    let taskPrompt = warmPrompt;

    // 4. Reuse the live reviewer when possible. The runner capability decides
    // whether the next turn is a safe in-place send or a native resume that
    // replaces the idle process while preserving its retained session.
    const parentSafetyTier = parentRun?.safetyTier;
    const runtimeDir = await resolveProjectRuntimeDir(parentRun?.project);
    const coldLaunchCommand = () =>
      buildLaunchCommand(vars, runner, model, taskPrompt, {
        taskFile: taskMdPath,
        taskDir,
        effort: parentRun?.effort,
        safetyTier: parentSafetyTier,
        runtimeDir,
      });
    const signalPath = taskDirRelPath(taskDir, reviewChecklistTarget.signal);

    const persistLiveReviewerSession = async (binding: {
      runnerSessionId: string | null;
      runnerSessionPath: string | null;
    }): Promise<boolean> => {
      if (!binding.runnerSessionId || !binding.runnerSessionPath) return false;
      sessionMeta = {
        runnerSessionId: binding.runnerSessionId,
        runnerSessionPath: binding.runnerSessionPath,
      };
      reviewContext =
        (await upsertAgentContext(_runId, 'self-review', {
          id: allocated.id,
          label: allocated.label,
          status: 'working',
          runnerSessionId: binding.runnerSessionId,
          runnerSessionPath: binding.runnerSessionPath,
        })) ?? reviewContext;
      return true;
    };

    const bindLiveReviewerSession = async (
      options: {
        sinceMs?: number;
        observedNotBeforeMs?: number;
        excludedSessionId?: string | null;
        excludedSessionPath?: string | null;
      } = {},
    ): Promise<boolean> => {
      const binding = await captureRunnerSessionMetadata(vars, runner, [], {
        ...options,
        paneId: reviewerWindow.paneId,
        slotId: vars.slotId,
      });
      return binding ? persistLiveReviewerSession(binding) : false;
    };

    const deliverToLiveReviewer = async (prompt: string, resetContext: boolean): Promise<void> => {
      // Native resume or cold replacement can create a new runner process even
      // though the canonical tmux window stays the same. Rebind from that live
      // pane before the next retained handoff; the previous claim is lineage
      // metadata, not proof that its process still owns the window.
      const rebound = await bindLiveReviewerSession();
      if (runnerCanResume && !rebound) {
        invalidateWarmReviewerSessions(_runId, runner);
        throw new Error(
          `Cannot identify the live ${runner} session that owns ${reviewTarget}; refusing a stale retained handoff`,
        );
      }
      let resetObservedNotBeforeMs: number | undefined;
      let resetPriorSessionId: string | null = null;
      let resetPriorSessionPath: string | null = null;
      if (resetContext) {
        resetPriorSessionId = sessionMeta.runnerSessionId;
        resetPriorSessionPath = sessionMeta.runnerSessionPath;
        const baseline = await captureRunnerPromptAcceptanceBaseline(vars, reviewTarget, runner);
        if (baseline === null) {
          throw new Error(
            `Cannot establish the ${runner} observability timebase before resetting ${reviewTarget}`,
          );
        }
        resetObservedNotBeforeMs = baseline;
        const reset = await resetLiveRunnerContext({
          vars,
          target: reviewTarget,
          runnerId: runner,
          sessionId: sessionMeta.runnerSessionId,
          sessionPath: sessionMeta.runnerSessionPath,
          model,
          effort: parentRun?.effort,
          safetyTier: parentSafetyTier,
          runtimeDir,
          taskDir,
          recovery: { runId: _runId },
          forceBusyPoll: true,
          sendLogPrefix: 'self-review-reset',
        });
        if (!reset.delivered) {
          throw new Error(`Cannot reset retained ${runner} reviewer: ${reset.reason}`);
        }
      }
      const delivery = await deliverPromptToLiveRunner({
        vars,
        target: reviewTarget,
        runnerId: runner,
        // Native reset may acknowledge before it exposes the successor session.
        // The fresh prompt hook is authoritative until we bind that successor
        // immediately after acceptance.
        sessionId: resetContext ? null : sessionMeta.runnerSessionId,
        sessionPath: resetContext ? null : sessionMeta.runnerSessionPath,
        model,
        effort: parentRun?.effort,
        prompt,
        promptMarker: reviewChecklistTarget.checklist,
        safetyTier: parentSafetyTier,
        runtimeDir,
        taskDir,
        launchAckSignalPath: signalPath,
        recovery: { runId: _runId },
        forceBusyPoll: true,
        sendLogPrefix: 'self-review-retained',
      });
      if (!delivery.delivered) {
        throw new Error(
          `Retained ${runner} reviewer did not accept the review task: ${delivery.reason}`,
        );
      }
      if (
        resetContext &&
        runnerCanResume &&
        !(await bindLiveReviewerSession({
          observedNotBeforeMs: resetObservedNotBeforeMs,
          excludedSessionId: resetPriorSessionId,
          excludedSessionPath: resetPriorSessionPath,
        }))
      ) {
        console.warn(
          `[self-review] accepted ${runner} review task did not expose a pane-owned session binding in ${reviewTarget}; completing this pass without retaining it`,
        );
        invalidateWarmReviewerSessions(_runId, runner);
        sessionMeta = {
          runnerSessionId: null,
          runnerSessionPath: null,
          error: `No authoritative session binding for ${reviewTarget}`,
        };
        reviewContext =
          (await upsertAgentContext(_runId, 'self-review', {
            id: allocated.id,
            label: allocated.label,
            runnerSessionId: null,
            runnerSessionPath: null,
          })) ?? reviewContext;
      }
    };

    // Cold launch → settle → capture the pane-owned session → bind context
    // → deliver prompt. A claimed warm session supplies the native resume id,
    // but only the live pane hook may establish the binding after launch.
    const launchReviewer = async (
      launchCmd: string,
      prompt: string,
      claimed: typeof warmSession,
    ): Promise<void> => {
      const handoffAckSinceMs = Date.now();
      let bindingObservedNotBeforeMs = handoffAckSinceMs;
      debugSelfReviewLog(`[self-review] launching (${runner}) via respawn-window: ${launchCmd}`);
      await respawnTmuxWindowWithCommand(vars, reviewTarget, launchCmd, {
        preserveWindowAfterExit: true,
      });
      await new Promise((r) => setTimeout(r, TMUX_WINDOW_RESPAWN_SETTLE_MS));
      sessionMeta = await bestEffortCaptureRunnerSessionMetadata(
        vars,
        runner,
        sessionFilesBefore.paths,
        sessionFilesBefore.error,
        {
          sinceMs: handoffAckSinceMs,
          paneId: reviewerWindow.paneId,
        },
      );
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
        const promptAcceptanceBaselineMs = await captureRunnerPromptAcceptanceBaseline(
          vars,
          reviewTarget,
          runner,
          handoffAckSinceMs,
        );
        bindingObservedNotBeforeMs = promptAcceptanceBaselineMs ?? handoffAckSinceMs;
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

      // Some interactive runners emit SessionStart before creating their
      // transcript file. The pre-prompt capture correctly refuses that
      // incomplete identity; retry only after exact prompt acceptance, when
      // the pane hook and resumable transcript can both be verified.
      if (
        !sessionMeta.runnerSessionId &&
        runnerCanResume &&
        !(await bindLiveReviewerSession({ observedNotBeforeMs: bindingObservedNotBeforeMs })) &&
        retainReviewerSession
      ) {
        console.warn(
          `[self-review] ${claimed ? 'reloaded' : 'launched'} ${runner} reviewer did not establish an authoritative session binding in ${reviewTarget}; completing this pass without retaining it`,
        );
        invalidateWarmReviewerSessions(_runId, runner);
      }
    };

    // 4/5. Keep one canonical reviewer window and retained session. The shared
    // runner capability may resume that session by replacing the idle process;
    // this preserves reviewer context without composing into unknown TUI state.
    if (reviewerWindow.runnerAlive) {
      const deliveryPlan = retainedReviewerDeliveryPlan(runner, sessionIntent, loopNumber);
      if (deliveryPlan.kind === 'cold-relaunch') {
        warmSession = null;
        taskPrompt = basePrompt;
        await launchReviewer(`${WORKER_ENV_PREFIX} && ${coldLaunchCommand()}`, taskPrompt, null);
      } else {
        try {
          await deliverToLiveReviewer(taskPrompt, deliveryPlan.resetContext);
        } catch (err) {
          if (!deliveryPlan.resetContext) throw err;
          console.warn(
            `[self-review] retained ${runner} reviewer could not reset (${(err as Error).message}) — replacing its process with a cold fresh launch`,
          );
          warmSession = null;
          taskPrompt = basePrompt;
          await launchReviewer(`${WORKER_ENV_PREFIX} && ${coldLaunchCommand()}`, taskPrompt, null);
        }
      }
    } else if (warmSession) {
      const reloadCmd = `${WORKER_ENV_PREFIX} && ${buildRunnerSessionReloadCommand(
        vars,
        runner,
        model,
        warmSession.runnerSessionId,
        { effort: parentRun?.effort, safetyTier: parentSafetyTier, runtimeDir, taskDir },
      )}`;
      try {
        await launchReviewer(reloadCmd, taskPrompt, warmSession);
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
    await waitForReviewCompletionOrThrow(
      vars,
      reviewTarget,
      taskDir,
      reviewTimeoutMs,
      _runId,
      runner,
      allocated.id,
      reviewChecklistTarget.signal,
      feedbackRelPath,
      resultRelPath,
    );
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
    const terminalSignal = await readTerminalReviewSignal(
      vars,
      taskDir,
      reviewChecklistTarget.signal,
    );
    const feedback = applyTerminalReviewSignal(
      await readReviewFeedback(vars, taskDir, feedbackRelPath, resultRelPath),
      terminalSignal,
    );
    const terminalArtifactError = terminalReviewArtifactErrorForCompletion(
      allocated.id,
      feedback.terminalInvalidReason,
    );
    if (terminalArtifactError) throw terminalArtifactError;
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
    if (retainReviewerSession) {
      // Record this pass's session so the next loop of THIS run can resume it.
      const reusableSessionId = sessionMeta.runnerSessionId;
      const reusableSessionPath = sessionMeta.runnerSessionPath;
      if (reusableSessionId && runnerSupportsSessionReload(runner)) {
        registerWarmReviewerSession({
          ...warmScope,
          contextId: allocated.id,
          windowName: reviewWindow,
          slotId: vars.slotId,
          runnerSessionId: reusableSessionId,
          runnerSessionPath: reusableSessionPath ?? null,
          lastLoopNumber: loopNumber,
          lastReviewedHeadSha: reviewSnapshot.snapshot.headSha ?? null,
        });
      }
    }
    const persisted = await persistReviewOutputArtifacts({
      vars,
      taskDir,
      taskMdPath,
      signalBasename: reviewChecklistTarget.signal,
      feedbackRelPath,
      resultRelPath,
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
    invalidateWarmReviewerSessions(_runId, runner);
    await markAgentContextStatus(
      _runId,
      'self-review',
      isTerminalReviewArtifactError(err) ? 'blocked' : 'failed',
      {
        id: allocated.id,
        lastSignalAt: new Date().toISOString(),
      },
    );
    throw err;
  } finally {
    progressWatcher?.stop();
    // Cleanup must not mask the original throw above — log and continue so the outer error
    // propagates intact to the run-engine catch. The canonical reviewer window
    // remains available for same-run continuation and operator inspection;
    // run/slot teardown owns its final cleanup.
    try {
      await unwatchContext(vars.slotId, allocated.id);
    } catch (cleanupErr) {
      console.warn(`[self-review] cleanup unwatchContext failed: ${(cleanupErr as Error).message}`);
    }
    if (activeTaskSet) {
      clearRunActiveTaskFile(_runId, taskMdPath);
      const parentRun = getRun(_runId);
      await restoreWorkerChecklistTargetFromSlot(
        vars,
        taskDir,
        parentRun ? { flowType: parentRun.flowType, mode: parentRun.mode ?? undefined } : undefined,
      );
    }
  }
}

export async function waitForReviewCompletion(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  reviewTarget: string,
  taskDir: string,
  timeoutMs: number,
  runId: string,
  runner: string,
  reviewContextId: string,
  signalBasename: string,
  feedbackRelPath: string,
  resultRelPath?: string | null,
  pollInterval = 10_000,
): Promise<boolean> {
  const start = Date.now();
  const requiredOutputPaths = [feedbackRelPath, ...(resultRelPath ? [resultRelPath] : [])].map(
    (relPath) => `${vars.remoteRepo}/${taskDir}/${relPath}`,
  );
  const outputExists = async (outputPath: string): Promise<boolean> =>
    (await execOnSlot(vars, `test -f ${shellQuote(outputPath)} && echo yes`)).stdout.trim() ===
    'yes';
  const terminalInvalid = async (reason: string): Promise<never> => {
    await markAgentContextStatus(runId, 'self-review', 'blocked', {
      id: reviewContextId,
      lastSignalAt: new Date().toISOString(),
    });
    throw new TerminalReviewArtifactError(
      `Reviewer ${reviewContextId} completed with an invalid result artifact: ${reason}`,
    );
  };
  const completedOutputIsValid = async (completionEstablished: boolean): Promise<boolean> => {
    if (!(await outputExists(requiredOutputPaths[0]!))) {
      if (!completionEstablished) return false;
      return terminalInvalid(`${feedbackRelPath} is missing`);
    }
    if (resultRelPath && !(await outputExists(requiredOutputPaths[1]!))) {
      if (!completionEstablished) return false;
      return terminalInvalid(`${resultRelPath} is missing`);
    }
    if (resultRelPath) {
      const feedback = await readReviewFeedback(vars, taskDir, feedbackRelPath, resultRelPath);
      if (feedback.terminalInvalidReason) {
        if (!completionEstablished) return false;
        return terminalInvalid(feedback.terminalInvalidReason);
      }
    }
    return true;
  };
  let reviewerWasObservedActive = false;

  while (true) {
    const remainingMs = Math.max(0, timeoutMs - (Date.now() - start));
    await new Promise((r) => setTimeout(r, Math.min(pollInterval, remainingMs)));
    let reviewerActive = false;

    // Check the immutable reviewer target. Window names are not unique in tmux
    // and must never be used for lifecycle or completion decisions.
    const hasWindow =
      (
        await execOnSlot(
          vars,
          tmuxShellSnippet(`list-panes -t ${shellQuote(reviewTarget)} 2>/dev/null`),
        )
      ).exitCode === 0;

    if (!hasWindow) {
      // Window disappearance establishes completion. Required artifacts must
      // now be valid; unlike pane heuristics, this branch may fail closed.
      await completedOutputIsValid(true);
      debugSelfReviewLog(`[self-review] review window gone + feedback written — agent completed`);
      await markAgentContextStatus(runId, 'self-review', 'complete', {
        id: reviewContextId,
        lastSignalAt: new Date().toISOString(),
      });
      return true;
    }

    // Check if the configured runner process is still running in the review pane.
    const panePid = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(
          `list-panes -t ${shellQuote(reviewTarget)} -F '#{pane_pid}' 2>/dev/null | head -1`,
        ),
      )
    ).stdout.trim();

    if (panePid) {
      const agentAlive = await isRunnerAliveUnderPane(vars, panePid, runner);
      reviewerActive = agentAlive;
      reviewerWasObservedActive ||= agentAlive;

      if (!agentAlive) {
        // Only absence after observing the process is completion. A runner can
        // be temporarily absent while its launcher is still starting.
        if (await completedOutputIsValid(reviewerWasObservedActive)) {
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

    // Successful terminal signals require every configured feedback artifact.
    // Failed/blocked signals take the existing failed-review path immediately.
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
      if (!isSuccessfulTerminalReviewSignal(terminalSignal)) {
        await markAgentContextStatus(
          runId,
          'self-review',
          terminalSignal.status === 'blocked' ? 'blocked' : 'failed',
          {
            id: reviewContextId,
            lastSignalAt: new Date().toISOString(),
          },
        );
        return true;
      }
      await completedOutputIsValid(true);
      debugSelfReviewLog(
        `[self-review] terminal ${signalBasename} (status=${terminalSignal.status}) + feedback — agent completed`,
      );
      await markAgentContextStatus(runId, 'self-review', 'complete', {
        id: reviewContextId,
        lastSignalAt: new Date().toISOString(),
      });
      return true;
    }

    // Check pane output for signs of completion
    const pane = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(`capture-pane -p -t ${shellQuote(reviewTarget)} 2>/dev/null | tail -5`),
      )
    ).stdout;

    // Runner at idle prompt, not mid-tool-call.
    const tailLines = pane.split('\n');
    const reviewerAtIdlePrompt =
      tailLines.some((line) => runnerLineLooksWaiting(line, runner)) &&
      !runnerPaneShowsCurrentInteractiveProgress(pane, runner);
    if (reviewerAtIdlePrompt) {
      // Double-check: the reviewer-specific feedback file exists = work is done.
      if (await completedOutputIsValid(false)) {
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
      if (await completedOutputIsValid(false)) {
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
      const state = reviewerAtIdlePrompt
        ? 'idle at its prompt'
        : reviewerActive
          ? 'still active'
          : 'inactive';
      console.warn(
        `[self-review] reviewer was ${state} without complete review artifacts after ${timeoutMs}ms`,
      );
      return false;
    }
  }
}

export async function waitForReviewCompletionOrThrow(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  reviewTarget: string,
  taskDir: string,
  timeoutMs: number,
  runId: string,
  runner: string,
  reviewContextId: string,
  signalBasename: string,
  feedbackRelPath: string,
  resultRelPath?: string | null,
  pollInterval?: number,
): Promise<void> {
  const completed = await waitForReviewCompletion(
    vars,
    reviewTarget,
    taskDir,
    timeoutMs,
    runId,
    runner,
    reviewContextId,
    signalBasename,
    feedbackRelPath,
    resultRelPath,
    pollInterval,
  );
  if (completed) return;

  try {
    await killTmuxWindowById(vars, reviewTarget);
  } catch (cleanupErr) {
    console.warn(
      `[self-review] review timeout cleanup failed for ${reviewTarget}: ${(cleanupErr as Error).message}`,
    );
  }
  throw new Error(
    `Self-review agent did not complete within ${timeoutMs}ms (${timeoutMs / 60_000}min). Bump self_review.review_timeout_min in projects/${vars.projectName}/project.json if reviews need longer.`,
  );
}
