// review/review-agent.ts — launch and collect the independent review runner.

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  type AgentContext,
  allocateReviewerContext,
  type ReviewDiffSnapshot,
  type ReviewFixDeltaSnapshot,
  type ReviewIssue,
  type ReviewLoopTimelineSegment,
  type ReviewMode,
  type ReviewSessionTrace,
  type ReviewValidationDepth,
  type RunnerSessionUsage,
  type WorkerSignalChecklistTiming,
} from '@farmslot/protocol';
import { executionModelFromSelection } from '@farmslot/review-dispatch';

import { markAgentContextStatus, upsertAgentContext } from '../agents/contexts.js';
import { loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import {
  ensureTmuxWindow,
  killTmuxWindowById,
  listExactTmuxWindows,
  resolveExactTmuxWindowPane,
  resolveTmuxSession,
  resolveTmuxWindowId,
  resolveTmuxWindowIdentity,
  resolveTmuxWindowPaneCount,
  respawnTmuxWindowWithCommand,
  shellQuote,
  TMUX_WINDOW_RESPAWN_SETTLE_MS,
  tmuxShellSnippet,
  type TmuxWindowRef,
} from '../core/tmux.js';
import { writeTextFileOnSlot } from '../methods/dispatch/slot-file-write.js';
import { ensureNodeSupportBundle } from '../node-support/ensure.js';
import { stackPrBase } from '../run-engine/stack-base.js';
import {
  buildLaunchCommand,
  RUNNER_LAUNCH_READY_TIMEOUT_MS,
  runnerSupportsSessionReload,
} from '../runners/launch-command.js';
import { readNativeWorkerSnapshot } from '../runners/native/worker-control.js';
import {
  launchAckSignalAdvanced,
  readLaunchAckSignalSnapshot,
} from '../runners/prompt-delivery-evidence.js';
import {
  captureRunnerPromptAcceptanceBaseline,
  runnerHasDurablePromptHandoff,
  runnerNeedsPostLaunchPrompt,
  runnerRetainedSessionHandoff,
  runnerSupportsInteractivePrompt,
  sendRunnerPostLaunchPrompt,
  WORKER_ENV_PREFIX,
} from '../runners/registry.js';
import {
  captureRunnerSessionMetadata,
  isRunnerAliveUnderPane,
  probeRunnerDescendantPid,
  resumableSessionProbeCommand,
} from '../runners/session-process.js';
import { deliverPromptToRetainedRunnerSession } from '../runners/session-reactivation.js';
import {
  clearedRunnerSessionContextPatch,
  recordRunnerSessionForRole,
} from '../runners/session-record.js';
import { resolveWorkerDispatchPrompt } from '../runners/worker-prompt.js';
import { clearRunActiveTaskFile, getAllRuns, getRun, updateRun } from '../runs/store.js';
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

import { finishReviewCleanup } from './cleanup.js';
import { readReviewFeedback } from './feedback.js';
import { broadcastReviewRun, startProgressWatcher } from './progress.js';
import { noteReviewInputsAtLaunch } from './reviewed-inputs.js';
import {
  claimWarmReviewerSession,
  invalidateWarmReviewerSessions,
  registerWarmReviewerSession,
  resolveWarmReviewerSession,
  reviewPRIdentity,
  type WarmReviewerScope,
  WarmReviewRefusal,
} from './session-mode.js';
import {
  bestEffortCaptureRunnerSessionMetadata,
  bestEffortListRunnerSessionFiles,
  captureReviewSnapshot,
  debugReviewLog,
  durationBetween,
  readPersistedReviewSnapshot,
  removeSlotFiles,
  reviewArtifactDir,
  type ReviewSessionMeta,
  waitForSessionTranscriptToSettle,
} from './snapshots.js';
import { expandReviewTemplate } from './templates.js';
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
    ensured.windows.map(async (window) => {
      const runnerProbe = await probeRunnerDescendantPid(vars, window.panePid, runner, {
        timeout: 10_000,
      });
      return { ...window, runnerProbe };
    }),
  );
  const indeterminate = candidates.find((window) => window.runnerProbe.state === 'unknown');
  if (indeterminate?.runnerProbe.state === 'unknown') {
    throw new Error(
      `Cannot reconcile ${session}:${windowName}: runner liveness is unknown for ${indeterminate.windowId}${indeterminate.runnerProbe.reason ? ` (${indeterminate.runnerProbe.reason})` : ''}`,
    );
  }
  const live = candidates.filter((window) => window.runnerProbe.state === 'present');
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
    debugReviewLog(
      `[review] reconciled ${candidates.length} ${session}:${windowName} windows to ${canonical.windowId}`,
    );
  }
  return {
    ...canonical,
    disposition: ensured.disposition,
    runnerAlive: canonical.runnerProbe.state === 'present',
  };
}

/** Progress mark writes status "running"; only terminal worker signals count as done. */
export function parseTerminalReviewSignal(raw: string) {
  return terminalWorkerSignalFromRaw(raw);
}

export function applyTerminalReviewSignal(
  feedback: ReviewAgentResult,
  signal: ReturnType<typeof parseTerminalReviewSignal>,
): ReviewAgentResult {
  if (!signal) return feedback;
  const withTiming = signal.checklistTiming
    ? { ...feedback, checklistTiming: signal.checklistTiming }
    : feedback;
  if (isSuccessfulTerminalReviewSignal(signal)) return withTiming;
  return { ...withTiming, verdict: 'pass', issues: [], incomplete: true };
}

export async function readTerminalReviewSignal(
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
  return parseTerminalReviewSignal(raw);
}

export const LEGACY_REVIEW_FEEDBACK_REL_PATH = 'artifacts/review-feedback.md';
const LEGACY_REVIEW_FEEDBACK_ARTIFACT_PATTERN =
  /(^|[^\w-])artifacts\/review-feedback\.md(?![\w./-])/g;
const LEGACY_REVIEW_FEEDBACK_BASENAME_PATTERN = /(^|[^\w./-])review-feedback\.md(?![\w./-])/g;

export function reviewChecklistMarkPrompt(
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

export function prependReviewerExecutionContract(
  checklist: string,
  executionContract: string,
): string {
  return `## Reviewer-specific execution contract\n\n${executionContract}\n\n${checklist}`;
}

export function reviewerChecklistBasename(contextId: string): string {
  return `REVIEW.${contextId}.md`;
}

export function reviewerFeedbackRelPath(contextId: string): string {
  return `artifacts/review-feedback.${contextId}.md`;
}

export function reviewerResultRelPath(contextId: string): string {
  return `artifacts/review-result.${contextId}.json`;
}

export function continuationReviewScope(params: {
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

export function workerFixHandoffScope(params: {
  taskDir: string;
  priorLoopNumber: number;
  artifactScope?: string | null;
}): string {
  const priorDir = `${params.taskDir}/${reviewArtifactDir(params.priorLoopNumber, params.artifactScope)}`;
  return `## Worker fix handoff (required reading)

This is a continuation, not a first-look review. The worker already answered the prior findings.

Before filing any finding, read:
- \`${params.taskDir}/artifacts/report.md\` — latest \`## Review Fixes\` (fixed, disputed, or left open)
- \`${params.taskDir}/REVIEW-FIX.md\` — the issue list sent to the worker
- \`${priorDir}/review-feedback.md\` — the prior findings

Treat the worker report as first-class:
- **Fixed:** verify on current HEAD. Re-file only if the defect is still present.
- **Does not reproduce / wrong:** confirm or refute with evidence. Do not re-file on taste.
- **Still open / product decision:** do not re-state it as a new finding. Quote the worker rationale and reject it, or drop the issue.

A worker SIGNAL of complete/success can mean "subset fixed + documented refusals." That is not "all findings gone." Repeating the same AC4/AC5/cache finding without engaging the worker write-up is a failed re-review.
`;
}

/** Prefix for extra-review loop 2+ and WARM continuation. COLD always reviews the full PR. */
export function reReviewChecklistPrefix(params: {
  taskDir: string;
  loopNumber: number;
  artifactScope?: string | null;
  priorArtifactScope?: string | null;
  priorLoopNumber?: number;
  priorHeadSha?: string | null;
  currentHeadSha?: string | null;
  resume?: boolean;
}): string | null {
  if (params.loopNumber <= 1 && !params.resume) return null;
  const priorLoopNumber = params.priorLoopNumber ?? Math.max(1, params.loopNumber - 1);
  const priorScope =
    params.priorArtifactScope === undefined ? params.artifactScope : params.priorArtifactScope;
  const priorArtifactDir = `${params.taskDir}/${reviewArtifactDir(priorLoopNumber, priorScope)}`;
  return [
    continuationReviewScope({
      priorHeadSha: params.priorHeadSha ?? null,
      currentHeadSha: params.currentHeadSha ?? null,
      priorArtifactDir,
    }),
    workerFixHandoffScope({
      taskDir: params.taskDir,
      priorLoopNumber,
      artifactScope: priorScope,
    }),
  ].join('\n');
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
        context.role === 'review' &&
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
  listExactTmuxWindows: typeof listExactTmuxWindows;
  resolveExactTmuxWindowPane: typeof resolveExactTmuxWindowPane;
  probeRunnerDescendantPid: typeof probeRunnerDescendantPid;
  resolveWorkerDispatchPrompt: typeof resolveWorkerDispatchPrompt;
  resolveProjectRuntimeDir: typeof resolveProjectRuntimeDir;
  sendRunnerPostLaunchPrompt: typeof sendRunnerPostLaunchPrompt;
  killTmuxWindowById: typeof killTmuxWindowById;
  resolveTmuxWindowIdentity: typeof resolveTmuxWindowIdentity;
  resolveTmuxWindowPaneCount: typeof resolveTmuxWindowPaneCount;
}

const defaultReviewPromptRecoveryDependencies: ReviewPromptRecoveryDependencies = {
  listExactTmuxWindows,
  resolveExactTmuxWindowPane,
  probeRunnerDescendantPid,
  resolveWorkerDispatchPrompt,
  resolveProjectRuntimeDir,
  sendRunnerPostLaunchPrompt,
  killTmuxWindowById,
  resolveTmuxWindowIdentity,
  resolveTmuxWindowPaneCount,
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
    | 'nativeSession'
  >,
  dependencyOverrides: Partial<ReviewPromptRecoveryDependencies> = {},
): Promise<'delivered' | 'inactive' | 'indeterminate' | 'retired' | 'unsupported'> {
  if (context.nativeSession) {
    const binding = context.nativeSession;
    if (binding.releasedAt || (binding.closedAt && !binding.recovery)) return 'inactive';
    const snapshot = await readNativeWorkerSnapshot(runId, 'review', context.id);
    if (['closed', 'failed'].includes(snapshot.session.state))
      return snapshot.session.processStopped ? 'inactive' : 'indeterminate';
    const receipt = snapshot.commands.find((command) => command.commandId === binding.commandId);
    // Acceptance only restores the pending review. Its terminal signal and result
    // artifacts remain completion authority; recovery never sends another prompt.
    return binding.acceptedAt || receipt?.accepted ? 'delivered' : 'indeterminate';
  }
  const dependencies = {
    ...defaultReviewPromptRecoveryDependencies,
    ...dependencyOverrides,
  };
  const target = context.target?.target;
  const taskMdPath = context.taskFile;
  const runner = context.runner;
  if (!target || !taskMdPath || !runner || !runnerSupportsInteractivePrompt(runner)) {
    return 'unsupported';
  }
  let expectedSession = context.target?.session?.trim() || null;
  let expectedWindow = context.target?.window?.trim() || null;
  if (!/^[@%]\d+$/.test(target)) {
    const separator = target.indexOf(':');
    if (separator <= 0 || separator === target.length - 1) return 'indeterminate';
    expectedSession ??= target.slice(0, separator);
    expectedWindow ??= target.slice(separator + 1).split('.', 1)[0] || null;
  }
  let exactTarget = target;
  if (!/^[@%]\d+$/.test(target) && expectedSession && expectedWindow) {
    const matches = await dependencies.listExactTmuxWindows(vars, expectedSession, expectedWindow);
    if (matches.length !== 1) return 'indeterminate';
    exactTarget = matches[0]!.windowId;
  }
  const pane = await dependencies.resolveExactTmuxWindowPane(vars, exactTarget);
  if (!pane) return 'inactive';
  const runnerProbe = await dependencies.probeRunnerDescendantPid(vars, pane.panePid, runner, {
    timeout: 10_000,
  });
  if (runnerProbe.state === 'unknown') return 'indeterminate';
  if (runnerProbe.state === 'absent') return 'inactive';
  // Pane-only argv runners cannot prove a recovered in-place prompt. Retire
  // the exact reviewer window here so every recovery caller gets the same
  // cleanup and can launch a fresh scoped review without a stale writer.
  if (runnerRetainedSessionHandoff(runner) === 'argv-relaunch') {
    const identity = await dependencies.resolveTmuxWindowIdentity(vars, pane.paneId);
    if (!identity) return 'indeterminate';
    if (
      expectedSession &&
      expectedWindow &&
      (identity.session !== expectedSession || identity.window !== expectedWindow)
    ) {
      return 'indeterminate';
    }
    const windowId = identity.windowId;
    if ((await dependencies.resolveTmuxWindowPaneCount(vars, windowId)) !== 1) {
      return 'indeterminate';
    }
    await dependencies.killTmuxWindowById(vars, windowId);
    return 'retired';
  }

  const taskDir = path.posix.dirname(taskMdPath);
  const reviewTarget = targetForChecklistBasename(path.posix.basename(taskMdPath));
  const parentRun = getRun(runId);
  const prompt = await dependencies.resolveWorkerDispatchPrompt(
    parentRun?.project ?? vars.projectName,
    {
      taskFile: taskMdPath,
      taskDir,
    },
  );
  const attemptStartedAtMs = Date.parse(context.attemptStartedAt ?? context.startedAt ?? '');
  const baselineMs = Number.isFinite(attemptStartedAtMs) ? attemptStartedAtMs : Date.now();
  const runtimeDir = await dependencies.resolveProjectRuntimeDir(parentRun?.project);
  await dependencies.sendRunnerPostLaunchPrompt(
    vars,
    pane.paneId,
    runner,
    prompt,
    reviewTarget.checklist,
    'review-recovery',
    {
      readyTimeoutMs: RUNNER_LAUNCH_READY_TIMEOUT_MS,
      maxAttempts: 5,
      blockerSnapshotPath: `${taskDir}/artifacts/runner-blockers/review-recovery.txt`,
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

// Exported for review.test.ts to seed runReviewRetryLoop fixtures. Not part of the
// gateway's public surface — keep internal to this module's tests.
export interface ReviewAgentResult {
  reviewId?: string;
  mode?: ReviewMode;
  reviewerSessionId?: string | null;
  session?: ReviewSessionTrace;
  verdict: 'pass' | 'issues';
  issues: ReviewIssue[];
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

export async function persistReviewOutputArtifacts(params: {
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
  const taskProgressRel = `${artifactDir}/review.md`;
  const taskProgressDest = `${vars.remoteRepo}/${taskDir}/${taskProgressRel}`;
  const taskProgressCopy = await execOnSlot(
    vars,
    `mkdir -p ${shellQuote(path.posix.dirname(taskProgressDest))} && cp ${shellQuote(`${vars.remoteRepo}/${taskMdPath}`)} ${shellQuote(taskProgressDest)}`,
    { timeout: 10_000 },
  );
  if (taskProgressCopy.exitCode !== 0) {
    throw new Error(
      `Failed to persist review progress artifact: ${taskProgressCopy.stderr || taskProgressCopy.stdout || `exit ${taskProgressCopy.exitCode}`}`,
    );
  }
  persistedArtifacts.push(taskProgressRel);

  const signalRel = `${artifactDir}/review-signal.json`;
  const liveSignalPath = slotTaskRelPath(vars, taskDir, signalBasename);
  const signalCopy = await execOnSlot(
    vars,
    `if [ -f ${shellQuote(liveSignalPath)} ]; then cp ${shellQuote(liveSignalPath)} ${shellQuote(`${vars.remoteRepo}/${taskDir}/${signalRel}`)} && echo copied; fi`,
    { timeout: 10_000 },
  );
  if (signalCopy.exitCode !== 0) {
    throw new Error(
      `Failed to persist review signal artifact: ${signalCopy.stderr || signalCopy.stdout || `exit ${signalCopy.exitCode}`}`,
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
        `Failed to persist review feedback artifact: ${feedbackCopy.stderr || feedbackCopy.stdout || `exit ${feedbackCopy.exitCode}`}`,
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
  mode: ReviewMode;
  reviewId?: string | null;
}): Promise<ReviewAgentResult | null> {
  const run = getRun(params.runId);
  const context = selectRecoverableReviewContext(run?.agentContexts ?? [], params);
  if (!context?.reviewId || context.reviewId !== params.reviewId) return null;
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
    await markAgentContextStatus(params.runId, 'review', status, { id: context.id });
    try {
      const storedTarget = context.target?.target;
      let windowId = storedTarget?.startsWith('@') ? storedTarget : null;
      if (!windowId && storedTarget?.startsWith('%')) {
        windowId = await resolveTmuxWindowId(params.vars, storedTarget);
      }
      if (!windowId && context.target?.window) {
        const matches = await listExactTmuxWindows(
          params.vars,
          context.target.session || params.session,
          context.target.window,
        );
        if (matches.length > 1) {
          console.warn(
            `[review] ${reason}: preserving ${matches.length} ambiguous ${context.target.window} windows`,
          );
          return null;
        }
        windowId = matches[0]?.windowId ?? null;
      }
      if (windowId) await killTmuxWindowById(params.vars, windowId);
    } catch (error) {
      console.warn(
        `[review] run ${params.runId.slice(0, 8)} — recovered reviewer ${context.id} cleanup failed: ${(error as Error).message}`,
      );
    }
    return null;
  };

  const pane = await resolveExactTmuxWindowPane(params.vars, context.target.target);
  if (!pane) {
    return abandonRecoveredReviewer('inactive recovered reviewer cleanup');
  }
  const runnerProbe = await probeRunnerDescendantPid(params.vars, pane.panePid, params.runner, {
    timeout: 10_000,
  });
  if (runnerProbe.state === 'unknown') {
    throw new Error(
      `Cannot recover reviewer ${context.id}: runner liveness is unknown${runnerProbe.reason ? ` (${runnerProbe.reason})` : ''}`,
    );
  }
  if (runnerProbe.state === 'absent') {
    return abandonRecoveredReviewer('inactive recovered reviewer cleanup');
  }

  debugReviewLog(
    `[review] run ${params.runId.slice(0, 8)} — reclaiming active reviewer ${context.id} after restart`,
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
      `[review] run ${params.runId.slice(0, 8)} — recovered reviewer ${context.id} has no valid launch snapshot; starting a fresh review`,
    );
    return abandonRecoveredReviewer('snapshot-less recovered reviewer cleanup');
  }
  try {
    const delivery = await resumeReviewAgentPromptDelivery(params.vars, params.runId, context);
    if (delivery === 'retired') {
      await markAgentContextStatus(params.runId, 'review', 'failed', { id: context.id });
      return null;
    }
    if (delivery === 'indeterminate') {
      console.warn(
        `[review] run ${params.runId.slice(0, 8)} — reviewer ${context.id} liveness is unknown; preserving its window`,
      );
      return null;
    }
    if (delivery !== 'delivered') {
      console.warn(
        `[review] run ${params.runId.slice(0, 8)} — recovered reviewer ${context.id} is ${delivery}; starting a fresh review`,
      );
      return abandonRecoveredReviewer(`${delivery} recovered reviewer cleanup`);
    }
  } catch (error) {
    console.warn(
      `[review] run ${params.runId.slice(0, 8)} — recovered reviewer ${context.id} prompt recovery failed: ${(error as Error).message}`,
    );
    return abandonRecoveredReviewer('failed recovered reviewer prompt cleanup');
  }
  updateRun(params.runId, { activeTaskFile: context.taskFile });
  const reviewTarget = context.target.target ?? pane.paneId;
  const signalBasename = path.posix.basename(context.signalFile);
  const feedbackRelPath = reviewerFeedbackRelPath(context.id);
  const resultRelPath = context.reviewResultFile ?? null;
  const recoveredTaskFile = context.taskFile;
  const watcher = startProgressWatcher(params.vars, context.taskFile, params.runId, 'Review', {
    contextId: context.id,
    role: 'review',
  });
  let recoveryFailure: unknown;
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
    if (!feedback.incomplete)
      await upsertAgentContext(params.runId, 'review', {
        id: context.id,
        status: 'complete',
        reviewResultValidatedAt: completedAt,
      });
    const identity = reviewPRIdentity(run);
    return {
      ...feedback,
      reviewId: context.reviewId,
      mode: params.mode,
      reviewerSessionId: context.runnerSessionId,
      session: {
        mode: params.mode,
        reviewId: context.reviewId,
        continuity: params.mode === 'warm' ? 'resumed' : 'fresh',
        sessionId: context.runnerSessionId ?? undefined,
        ...(params.mode === 'warm'
          ? { priorSessionId: context.runnerSessionId ?? undefined, priorRunId: params.runId }
          : {}),
        repository: identity?.repository,
        prNumber: identity?.prNumber,
        lastReviewedHeadSha:
          (params.mode === 'warm'
            ? reviewSnapshot.snapshot.baseSha
            : reviewSnapshot.snapshot.headSha) ?? undefined,
      },
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
  } catch (error) {
    recoveryFailure = error;
    throw error;
  } finally {
    await finishReviewCleanup(recoveryFailure, [
      () => watcher.stop(),
      () => unwatchContext(params.slotId, context.id),
      async () => {
        clearRunActiveTaskFile(params.runId, recoveredTaskFile);
        const latest = getRun(params.runId);
        await restoreWorkerChecklistTargetFromSlot(
          params.vars,
          params.taskDir,
          latest ? { flowType: latest.flowType, mode: latest.mode ?? undefined } : undefined,
        );
      },
    ]);
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
  loopNumber: number,
  validationDepth: ReviewValidationDepth,
  artifactScope?: string | null,
  mode: ReviewMode = 'cold',
  effort?: string | null,
  reviewId?: string | null,
): Promise<ReviewAgentResult> {
  if (mode === 'warm' && !reviewId?.trim())
    throw new WarmReviewRefusal(
      'missing-session',
      'WARM requires the reviewId of the lineage being continued',
    );
  const resolvedEffort = executionModelFromSelection({
    runner,
    model,
    effort: effort ?? null,
    mode,
  }).effort;
  if (getRun(_runId)?.transport === 'native') {
    const { runNativeReviewAgent } = await import('./native-review-agent.js');
    return runNativeReviewAgent({
      vars,
      runner,
      model,
      taskDir,
      runId: _runId,
      reviewTimeoutMs,
      loopNumber,
      validationDepth,
      artifactScope,
      mode,
      effort: resolvedEffort,
      reviewId,
    });
  }
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
    mode,
    reviewId,
  });
  if (recovered) return recovered;
  const parentRun = getRun(_runId);
  const launchEffort = resolvedEffort ?? undefined;
  const startedAt = new Date().toISOString();
  const artifactDir = reviewArtifactDir(loopNumber, artifactScope);
  let progressWatcher: { stop(): void | Promise<void> } | null = null;
  let primaryFailure: unknown;
  let activeTaskSet = false;
  const sessionFilesBefore = await bestEffortListRunnerSessionFiles(vars, runner);
  let sessionMeta: ReviewSessionMeta = {
    runnerSessionPath: null,
    runnerSessionId: null,
    error: sessionFilesBefore.error,
  };
  const parentRunForAlloc = getRun(_runId);
  const identity = reviewPRIdentity(parentRunForAlloc);
  const lineage =
    reviewId?.trim() || (mode === 'cold' ? artifactScope?.trim() || randomUUID() : null);
  if (!lineage)
    throw new WarmReviewRefusal(
      'missing-session',
      'WARM requires the reviewId of the lineage being continued',
    );
  const warmScope: WarmReviewerScope = {
    reviewId: lineage,
    project: parentRunForAlloc?.project ?? vars.projectName,
    ownerPrincipalId:
      parentRunForAlloc?.nativeOwnerPrincipalId ?? parentRunForAlloc?.createdByPrincipalId ?? null,
    transport: 'tmux',
    runId: _runId,
    taskDir,
    artifactScope: artifactScope ?? null,
    runner,
    model,
    effort: launchEffort ?? null,
    repository: identity?.repository ?? '',
    prNumber: identity?.prNumber ?? 0,
  };
  const runnerCanResume = runnerSupportsSessionReload(runner);
  let warmSession = null as ReturnType<typeof claimWarmReviewerSession>;
  if (mode === 'warm') {
    if (!identity)
      throw new WarmReviewRefusal('pr-mismatch', 'the current run has no verified repository/PR');
    if (!runnerCanResume)
      throw new WarmReviewRefusal(
        'unsupported-runner',
        'the runner cannot reload a retained reviewer',
      );
    warmSession = resolveWarmReviewerSession(warmScope, getAllRuns());
    if (!warmSession)
      throw new WarmReviewRefusal(
        'missing-session',
        'no completed PR reviewer session and reviewed head were retained',
      );
    if (warmSession.slotId !== vars.slotId)
      throw new WarmReviewRefusal(
        'slot-mismatch',
        'the retained reviewer belongs to a different slot',
      );
    if (
      getAllRuns().some(
        (run) =>
          run.id !== _runId &&
          run.agentContexts?.some(
            (context) =>
              context.runnerSessionId === warmSession!.runnerSessionId &&
              ['launching', 'working', 'waiting'].includes(context.status),
          ),
      )
    )
      throw new WarmReviewRefusal('session-busy', 'the reviewer session is owned by an active run');
  }
  const reviewSnapshot = await captureReviewSnapshot(vars, taskDir, loopNumber, artifactScope, {
    mode,
    baseRef: parentRunForAlloc
      ? (stackPrBase(parentRunForAlloc) ?? parentRunForAlloc.repeatReviewContext?.baseRef)
      : undefined,
    lastReviewedHeadSha: warmSession?.lastReviewedHeadSha,
  });
  if (
    !reviewSnapshot.snapshot.baseSha ||
    !reviewSnapshot.snapshot.headSha ||
    reviewSnapshot.snapshot.source === 'unavailable'
  )
    throw new Error('Review requires captured immutable base and head SHAs');
  const retainReviewerSession = Boolean(identity);
  let claimedWarmSession = false;
  const allocated = allocateReviewerContext({
    runId: _runId,
    runner,
    model,
  });
  const reviewWindow =
    warmSession?.windowName ?? `${allocated.windowName}-${randomUUID().slice(0, 8)}`;
  const priorReviewerContext = [...(parentRunForAlloc?.agentContexts ?? [])]
    .reverse()
    .find(
      (context) =>
        context.role === 'review' &&
        context.runner === runner &&
        context.target?.window === reviewWindow &&
        context.signalFile,
    );
  const reviewChecklistTarget = targetForChecklistBasename(reviewerChecklistBasename(allocated.id));
  const feedbackRelPath = reviewerFeedbackRelPath(allocated.id);
  const resultRelPath = reviewerResultRelPath(allocated.id);
  const taskMdPath = taskDirRelPath(taskDir, reviewChecklistTarget.checklist);
  let reviewContext = await upsertAgentContext(_runId, 'review', {
    id: allocated.id,
    reviewId: lineage,
    ...clearedRunnerSessionContextPatch(),
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
    ...(launchEffort ? { effort: launchEffort } : {}),
    target: null,
  });
  broadcastReviewRun(_runId);

  try {
    if (warmSession) {
      warmSession = claimWarmReviewerSession(warmScope, { consume: true });
      if (!warmSession)
        throw new WarmReviewRefusal(
          'missing-session',
          'the retained reviewer changed before launch',
        );
      claimedWarmSession = true;
    }
    // 1. Keep one stable window per runner. Reset versus resume changes runner
    // context, not topology; the runner capability decides whether delivery
    // reuses the live process or replaces it through native resume/cold launch.
    const reviewerWindow = await reconcileReviewerWindow(vars, session, reviewWindow, runner);
    const reviewTarget = reviewerWindow.windowId;
    const priorReviewerSignal = priorReviewerContext?.signalFile
      ? await readLaunchAckSignalSnapshot(vars, priorReviewerContext.signalFile)
      : null;

    // 1b. Clear prior-pass artifacts so waitForReviewCompletion / readReviewFeedback
    // can't short-circuit on stale files (caused retry verdict to mirror pass 1).
    await removeSlotFiles(vars, [
      `${vars.remoteRepo}/${taskDir}/${feedbackRelPath}`,
      `${vars.remoteRepo}/${taskDir}/${resultRelPath}`,
      slotTaskRelPath(vars, taskDir, reviewChecklistTarget.signal),
    ]);

    // 2. Bind the stable operator-addressable window to this review context.
    debugReviewLog(
      `[review] reviewer window ${reviewWindow}: ${reviewerWindow.disposition} (${reviewTarget})`,
    );
    reviewContext =
      (await upsertAgentContext(_runId, 'review', {
        id: allocated.id,
        label: allocated.label,
        runner,
        model,
        ...(launchEffort ? { effort: launchEffort } : {}),
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
    debugReviewLog(`[review] windows in ${session}: ${winList}`);

    // 3. Write expanded review TASK.md to the slot before launch so
    // non-interactive runners (e.g. Codex) can read it immediately.
    // The template is in projects/<project>/templates/worker/review.md with {{VAR}} placeholders.
    // Long multiline prompts get bracketed-pasted by tmux — so we write to a file.
    const markPrompt = reviewChecklistMarkPrompt(
      taskDir,
      taskMdPath,
      reviewChecklistTarget,
      feedbackRelPath,
      resultRelPath,
    );
    let expandedTemplate = scopeReviewFeedbackPath(
      await expandReviewTemplate(vars, taskDir, _runId, validationDepth),
      feedbackRelPath,
      resultRelPath,
    );
    // What this document gives the reviewer; a pass records it (F42).
    await noteReviewInputsAtLaunch(_runId);
    const range = warmSession
      ? continuationReviewScope({
          priorHeadSha: warmSession.lastReviewedHeadSha,
          currentHeadSha: reviewSnapshot.snapshot.headSha,
          priorArtifactDir: `${warmSession.taskDir}/${reviewArtifactDir(warmSession.lastLoopNumber, warmSession.artifactScope)}`,
        })
      : `## COLD review range\n\nReview the complete PR diff at captured commits ${reviewSnapshot.snapshot.baseSha}..${reviewSnapshot.snapshot.headSha}. Read ${taskDir}/${reviewSnapshot.snapshot.diffPath}. Do not narrow this review to previous findings.\n\n`;
    expandedTemplate = `${range}${expandedTemplate}`;
    expandedTemplate = prependReviewerExecutionContract(expandedTemplate, markPrompt);
    await writeTextFileOnSlot(vars, taskMdPath, expandedTemplate);
    await syncChecklistTargetForRole(vars, taskDir, 'review', {
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
    // A missing transcript cannot establish retained review ownership.
    if (warmSession) {
      const probe = warmSession.runnerSessionPath
        ? await execOnSlot(vars, resumableSessionProbeCommand(warmSession.runnerSessionPath), {
            timeout: 10_000,
          })
        : null;
      if (!probe || probe.exitCode !== 0) {
        throw new WarmReviewRefusal(
          'session-unavailable',
          'the retained reviewer transcript is unavailable',
        );
      }
    }
    const basePrompt = runnerNeedsPostLaunchPrompt(runner)
      ? await resolveWorkerDispatchPrompt(parentRun?.project ?? vars.projectName, {
          taskFile: taskMdPath,
          taskDir,
        })
      : `Read ${taskMdPath} and execute all steps exactly as written. Do NOT run /review.`;
    const taskPrompt = warmSession
      ? `Continue your review of ${warmScope.repository}#${warmScope.prNumber}. Review only ${warmSession.lastReviewedHeadSha}..${reviewSnapshot.snapshot.headSha}. Complete the current checklist output contract.\n\n${basePrompt}`
      : basePrompt;
    let promptAccepted = false;

    // 4. Reuse the live reviewer when possible. The runner capability decides
    // whether the next turn is a safe in-place send or a native resume that
    // replaces the idle process while preserving its retained session.
    const parentSafetyTier = parentRun?.safetyTier;
    const runtimeDir = await resolveProjectRuntimeDir(parentRun?.project);
    await ensureNodeSupportBundle(vars, runtimeDir);
    const coldLaunchCommand = () =>
      buildLaunchCommand(vars, runner, model, taskPrompt, {
        taskFile: taskMdPath,
        taskDir,
        effort: launchEffort,
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
      // Reviewer loops allocate a non-canonical context id (`rev2-codex`), so
      // the hook is given that exact target instead of collapsing every
      // reviewer generation onto the canonical `review` context.
      await upsertAgentContext(_runId, 'review', {
        id: allocated.id,
        label: allocated.label,
        status: 'launching',
      });
      reviewContext =
        (await recordRunnerSessionForRole({
          runId: _runId,
          role: 'review',
          contextId: allocated.id,
          label: allocated.label,
          session: binding,
          captureLabel: 'reviewer live session bind',
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

    // Cold launch → settle → capture the pane-owned session → bind context
    // → deliver prompt. A claimed warm session supplies the native resume id,
    // but only the live pane hook may establish the binding after launch.
    const launchReviewer = async (
      launchCmd: string,
      prompt: string,
      claimed: typeof warmSession,
    ): Promise<void> => {
      const launchAckBaseline = runnerNeedsPostLaunchPrompt(runner)
        ? null
        : await readLaunchAckSignalSnapshot(vars, signalPath);
      const handoffAckSinceMs = Date.now();
      let bindingObservedNotBeforeMs = handoffAckSinceMs;
      debugReviewLog(`[review] launching (${runner}) via respawn-window: ${launchCmd}`);
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
      const launchedContext = await upsertAgentContext(_runId, 'review', {
        id: allocated.id,
        label: allocated.label,
        status: 'launching',
      });
      // One hook owns session identity, including on the cold-launch path. It
      // records nothing when the capture produced no complete pair, so fall
      // back to the launch upsert rather than dropping the fresh context.
      reviewContext =
        (await recordRunnerSessionForRole({
          runId: _runId,
          role: 'review',
          contextId: allocated.id,
          label: allocated.label,
          session: sessionMeta,
          captureLabel: 'reviewer cold launch',
        })) ??
        launchedContext ??
        reviewContext;

      // Cold launch: argv-first runners already carry the task on the respawn
      // line (`withArgvTaskPromptPlaceholder`). A second tmux send races that
      // turn and can fail closed because pane-only Cursor has no prompt digest.
      // Recovery retires the exact stale argv-reviewer window before relaunch.
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
            'review',
            {
              readyTimeoutMs: RUNNER_LAUNCH_READY_TIMEOUT_MS,
              maxAttempts: 5,
              blockerSnapshotPath: `${taskDir}/artifacts/runner-blockers/review-launch.txt`,
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
            `[review] prompt delivery verifier failed but durable handoff passed via ${handoff.source}: ${handoff.reason}`,
          );
        }
      }

      if (runnerNeedsPostLaunchPrompt(runner)) {
        promptAccepted = true;
      } else {
        const acknowledgement = await readLaunchAckSignalSnapshot(vars, signalPath);
        promptAccepted = Boolean(
          acknowledgement && launchAckSignalAdvanced(launchAckBaseline, acknowledgement),
        );
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
          `[review] ${claimed ? 'reloaded' : 'launched'} ${runner} reviewer did not establish an authoritative session binding in ${reviewTarget}; completing this pass without retaining it`,
        );
        invalidateWarmReviewerSessions(_runId, runner);
      }
    };

    if (warmSession) {
      const delivery = await deliverPromptToRetainedRunnerSession({
        vars,
        target: reviewTarget,
        runnerId: runner,
        sessionId: warmSession.runnerSessionId,
        sessionPath: warmSession.runnerSessionPath,
        model,
        effort: launchEffort,
        prompt: taskPrompt,
        safetyTier: parentSafetyTier,
        runtimeDir,
        taskDir,
        taskFile: taskMdPath,
        launchAckSignalPath: signalPath,
        replacementReadySignalPath: priorReviewerContext?.signalFile,
        replacementReadySignalAttemptId: priorReviewerContext?.signalAttemptId,
        replacementReadySignal: priorReviewerSignal,
        recovery: { runId: _runId },
        forceBusyPoll: true,
        sendLogPrefix: 'review-warm',
      });
      if (!delivery.delivered)
        throw new WarmReviewRefusal(
          delivery.disposition === 'hold' ? 'session-busy' : 'session-unavailable',
          delivery.reason,
        );
      promptAccepted = true;
      if (
        !(await bindLiveReviewerSession()) ||
        sessionMeta.runnerSessionId !== warmSession.runnerSessionId
      )
        throw new WarmReviewRefusal(
          'session-unavailable',
          'the runner did not confirm the retained reviewer identity',
        );
    } else {
      await launchReviewer(`${WORKER_ENV_PREFIX} && ${coldLaunchCommand()}`, taskPrompt, null);
    }

    // Session binding and process launch do not prove prompt acceptance.
    if (promptAccepted) {
      reviewContext =
        (await upsertAgentContext(_runId, 'review', {
          id: allocated.id,
          label: allocated.label,
          status: 'working',
        })) ?? reviewContext;
    }

    broadcastReviewRun(_runId);

    // 6. Watch the reviewer-specific checklist for progress + wait for completion
    const reviewPath = slotTaskRelPath(vars, taskDir, reviewChecklistTarget.checklist);
    progressWatcher = startProgressWatcher(vars, reviewPath, _runId, 'Review', {
      contextId: allocated.id,
      role: 'review',
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
        mode,
        reviewId: lineage,
        reviewerSessionId: sessionMeta.runnerSessionId,
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
          lastReviewedHeadSha: reviewSnapshot.snapshot.headSha!,
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
    await upsertAgentContext(_runId, 'review', {
      id: allocated.id,
      status: 'complete',
      reviewResultValidatedAt: completedAt,
    });
    return {
      ...feedback,
      validationDepth,
      mode,
      reviewId: lineage,
      reviewerSessionId: sessionMeta.runnerSessionId,
      session: {
        mode,
        reviewId: lineage,
        continuity: warmSession ? 'resumed' : 'fresh',
        ...(warmSession
          ? { priorRunId: warmSession.runId, priorSessionId: warmSession.runnerSessionId }
          : {}),
        sessionId: sessionMeta.runnerSessionId ?? undefined,
        repository: identity?.repository,
        prNumber: identity?.prNumber,
        lastReviewedHeadSha: warmSession
          ? warmSession.lastReviewedHeadSha
          : reviewSnapshot.snapshot.headSha,
        runner,
        model,
        effort: launchEffort ?? null,
      },
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
    primaryFailure = err;
    if (claimedWarmSession) invalidateWarmReviewerSessions(_runId, runner);
    try {
      await markAgentContextStatus(
        _runId,
        'review',
        isTerminalReviewArtifactError(err) ? 'blocked' : 'failed',
        {
          id: allocated.id,
          lastSignalAt: new Date().toISOString(),
        },
      );
    } catch (recordError) {
      primaryFailure = new AggregateError(
        [err, recordError],
        `${String(err)}; status recording also failed: ${String(recordError)}`,
        { cause: err },
      );
    }
    throw primaryFailure;
  } finally {
    await finishReviewCleanup(primaryFailure, [
      () => progressWatcher?.stop(),
      () => unwatchContext(vars.slotId, allocated.id),
      async () => {
        if (!activeTaskSet) return;
        clearRunActiveTaskFile(_runId, taskMdPath);
        const parentRun = getRun(_runId);
        await restoreWorkerChecklistTargetFromSlot(
          vars,
          taskDir,
          parentRun
            ? { flowType: parentRun.flowType, mode: parentRun.mode ?? undefined }
            : undefined,
        );
      },
    ]);
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
    await markAgentContextStatus(runId, 'review', 'blocked', {
      id: reviewContextId,
      lastSignalAt: new Date().toISOString(),
    });
    throw new TerminalReviewArtifactError(
      `Reviewer ${reviewContextId} completed with an invalid result artifact: ${reason}`,
    );
  };
  const validateCompletedOutput = async (): Promise<void> => {
    if (!(await outputExists(requiredOutputPaths[0]!))) {
      return terminalInvalid(`${feedbackRelPath} is missing`);
    }
    if (resultRelPath && !(await outputExists(requiredOutputPaths[1]!))) {
      return terminalInvalid(`${resultRelPath} is missing`);
    }
    if (resultRelPath) {
      const feedback = await readReviewFeedback(vars, taskDir, feedbackRelPath, resultRelPath);
      if (feedback.terminalInvalidReason) {
        return terminalInvalid(feedback.terminalInvalidReason);
      }
    }
  };
  let reviewerWasObservedActive = false;

  while (true) {
    const remainingMs = Math.max(0, timeoutMs - (Date.now() - start));
    await new Promise((r) => setTimeout(r, Math.min(pollInterval, remainingMs)));
    let reviewerActive = false;

    // Successful terminal signals require every configured feedback artifact.
    // Failed/blocked signals take the existing failed-review path immediately.
    const signalRaw = (
      await execOnSlot(
        vars,
        `cat ${shellQuote(slotTaskRelPath(vars, taskDir, signalBasename))} 2>/dev/null`,
      )
    ).stdout.trim();
    let terminalSignal: ReturnType<typeof parseTerminalReviewSignal> | undefined;
    try {
      terminalSignal = parseTerminalReviewSignal(signalRaw);
    } catch (err) {
      debugReviewLog(
        `[review] ignoring invalid ${signalBasename} during poll: ${(err as Error).message}`,
      );
    }
    if (terminalSignal) {
      if (!isSuccessfulTerminalReviewSignal(terminalSignal)) {
        await markAgentContextStatus(
          runId,
          'review',
          terminalSignal.status === 'blocked' ? 'blocked' : 'failed',
          {
            id: reviewContextId,
            lastSignalAt: new Date().toISOString(),
          },
        );
        return true;
      }
      await validateCompletedOutput();
      debugReviewLog(
        `[review] terminal ${signalBasename} (status=${terminalSignal.status}) + feedback — agent completed`,
      );
      await markAgentContextStatus(runId, 'review', 'complete', {
        id: reviewContextId,
        lastSignalAt: new Date().toISOString(),
      });
      return true;
    }

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
      return terminalInvalid(`${signalBasename} is missing after the reviewer window closed`);
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

      if (!agentAlive && reviewerWasObservedActive) {
        debugReviewLog(`[review] runner stopped without its terminal mark; continuing signal wait`);
      }
    }

    if (Date.now() - start >= timeoutMs) {
      const state = reviewerActive ? 'still active' : 'inactive';
      console.warn(
        `[review] reviewer was ${state} without complete review artifacts after ${timeoutMs}ms`,
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
      `[review] review timeout cleanup failed for ${reviewTarget}: ${(cleanupErr as Error).message}`,
    );
  }
  throw new Error(
    `Review agent did not complete within ${timeoutMs}ms (${timeoutMs / 60_000}min). Bump review.review_timeout_min in projects/${vars.projectName}/project.json if reviews need longer.`,
  );
}
