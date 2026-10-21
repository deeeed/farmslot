// review/review-agent.ts — launch and collect the independent review runner.
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { GIT_DIFF_COMMAND } from '@farmslot/agent-runtime/scripts/git-diff.cjs';
import {
  type AgentContext,
  allocateReviewerContext,
  isTerminalRunStatus,
  type ReviewDiffSnapshot,
  type ReviewFixDeltaSnapshot,
  type ReviewIssue,
  type ReviewLoopTimelineSegment,
  type ReviewMode,
  type ReviewSessionTrace,
  type ReviewValidationDepth,
  type Run,
  type RunnerSessionUsage,
  type WorkerSignalChecklistTiming,
} from '@farmslot/protocol';
import { executionModelFromSelection } from '@farmslot/review-dispatch';

import { markAgentContextStatus, upsertAgentContext } from '../agents/contexts.js';
import { loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import {
  killTmuxWindowById,
  listExactTmuxWindows,
  resolveExactTmuxWindowPane,
  resolveTmuxSession,
  resolveTmuxWindowId,
  resolveTmuxWindowIdentity,
  resolveTmuxWindowPaneCount,
  shellQuote,
  throwIfTmuxQueryTimedOut,
  tmuxShellSnippet,
} from '../core/tmux.js';
import { runSupersededSince } from '../run-engine/run-generation.js';
import { RUNNER_LAUNCH_READY_TIMEOUT_MS } from '../runners/launch-command.js';
import { readNativeWorkerSnapshot } from '../runners/native/worker-control.js';
import {
  getRunnerObservability,
  runnerRetainedSessionHandoff,
  runnerSupportsInteractivePrompt,
  sendRunnerPostLaunchPrompt,
} from '../runners/registry.js';
import { probeRunnerDescendantPid } from '../runners/session-process.js';
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
  targetForChecklistBasename,
  taskDirRelPath,
} from '../tasks/checklist-target.js';
import { unwatchContext } from '../tasks/watcher.js';
import { terminalWorkerSignalFromRaw } from '../tasks/worker-signals.js';

import { finishReviewCleanup } from './cleanup.js';
import { readReviewFeedback } from './feedback.js';
import { startProgressWatcher } from './progress.js';
import { reviewContextRoundId } from './review-round-budget.js';
import { reviewPRIdentity, WarmReviewRefusal } from './session-mode.js';
import {
  debugReviewLog,
  durationBetween,
  readPersistedReviewSnapshot,
  reviewArtifactDir,
  waitForSessionTranscriptToSettle,
} from './snapshots.js';
import { reviewerFeedbackRelPath } from './template-paths.js';
export { reviewerChecklistBasename, reviewerFeedbackRelPath } from './template-paths.js';
import {
  isSuccessfulTerminalReviewSignal,
  isTerminalReviewArtifactError,
  ReviewerExitedError,
  TerminalReviewArtifactError,
  terminalReviewArtifactErrorForCompletion,
  withReviewerRelaunch,
} from './terminal-result.js';

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

/**
 * Where a slot reviewer puts probe tests and other scratch: the node's temporary directory,
 * which a sandboxed reviewer can write, never the checkout (ADR-032 Amendment 1).
 */
export function reviewerScratchRule(contextId: string): string {
  return (
    `Apart from the review files named above and the evidence your checklist asks for, write ` +
    `nothing in the checkout. Put probe tests and ` +
    `other scratch files under \`\${TMPDIR:-/tmp}/farmslot-review/${contextId}\` (create it with ` +
    `\`mkdir -p\`). If a probe must sit in the checkout to run, delete it before you write your result.`
  );
}

export function prependReviewerExecutionContract(
  checklist: string,
  executionContract: string,
): string {
  return `## Reviewer-specific execution contract\n\n${executionContract}\n\n${checklist}`;
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
available, inspect \`${GIT_DIFF_COMMAND} --stat ${reviewRange}\` and \`${GIT_DIFF_COMMAND} ${reviewRange}\` instead of
\`main...HEAD\`. Recheck the prior findings and validate affected surfaces only. Expand beyond
that range only when the delta invalidates a prior assumption, and explain why in the report.
`;
}

/** What an automatic re-review continues (ADR-063 Amendment 5). */
export interface ReReviewContinuation {
  /** The lineage's last reviewed head. */
  lastReviewedHeadSha: string;
  /** The earlier findings, given to a fresh session when the retained one can't continue. */
  priorIssues: ReviewIssue[];
  /** The stopped, refunded attempt explicitly selected by its owning continuation. */
  retryContextId?: string;
}

/** A validated result with a recorded reviewed head makes the next review a re-review. */
export function reReviewContinuation(
  result: Pick<ReviewAgentResult, 'reviewId' | 'reviewSnapshot'> & { issues?: ReviewIssue[] },
): ReReviewContinuation | undefined {
  const head =
    result.reviewSnapshot?.source === 'unavailable'
      ? undefined
      : result.reviewSnapshot?.headSha?.trim();
  return result.reviewId && head
    ? { lastReviewedHeadSha: head, priorIssues: result.issues ?? [] }
    : undefined;
}

/** The delta-scoped COLD fallback's prompt: the lineage's delta and its earlier findings. */
export function deltaFallbackReviewScope(params: {
  reason: string;
  comparedRanges: string[];
  rangeDiffPath?: string;
  deltaUnavailable?: string;
  priorIssues: ReviewIssue[];
}): string {
  const [first, second] = params.comparedRanges;
  const scope = params.rangeDiffPath
    ? `The branch was rebased since the last review. Review only the branch's own change at the two heads, as \`git range-diff ${first} ${second}\` compares them (saved at \`${params.rangeDiffPath}\`). In its output \`>\` marks a commit new since the review (inspect it with \`git show\`), \`!\` a rewritten commit with its patch difference, and \`=\` an unchanged one. Changes that came only from the base branch are out of scope.`
    : params.deltaUnavailable
      ? `The change since the last reviewed head is unavailable (${params.deltaUnavailable}). Review the branch's whole change \`${first}\`.`
      : `Review only the change since the last reviewed head: inspect \`${GIT_DIFF_COMMAND} --stat ${first}\` and \`${GIT_DIFF_COMMAND} ${first}\`.`;
  const findings = params.priorIssues.length
    ? params.priorIssues
        .map(
          (issue) => `- ${issue.file}${issue.line ? `:${issue.line}` : ''}: ${issue.description}`,
        )
        .join('\n')
    : '- none recorded';
  return `## Delta-scoped review in a fresh session

The reviewer session that reviewed this work can't continue (${params.reason}). This fresh session continues the same review; it is not a new full-branch review.

${scope}

This scope overrides generic full-branch diff instructions below. Keep correctness checks on this delta, and expand beyond it only when the delta invalidates an earlier assumption; explain why in the report.

Earlier findings of this review, to recheck against the delta:
${findings}
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

/** A native reviewer's context id starts with this; a launch with the same inputs reattaches to it. */
export function nativeReviewerContextPrefix(input: {
  runId: string;
  runner: string;
  model: string;
  generation: number;
  taskDir: string;
  artifactScope?: string | null;
  loopNumber: number;
}): string {
  const { id } = allocateReviewerContext({
    runId: input.runId,
    runner: input.runner,
    model: input.model,
  });
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        input.generation,
        input.taskDir,
        input.artifactScope ?? null,
        input.loopNumber,
        input.model,
      ]),
    )
    .digest('hex')
    .slice(0, 12);
  return `${id}-native-${key}`;
}

/** A launch reattaches to a native reviewer with its prefix while that reviewer still runs. */
export function isLiveNativeReviewer(context: AgentContext, prefix: string): boolean {
  return (
    context.id.startsWith(prefix) && ['launching', 'working', 'waiting'].includes(context.status)
  );
}

interface RefundedNativeReviewerParams {
  runner: string;
  model: string;
  taskDir: string;
  artifactScope?: string | null;
  reviewId?: string | null;
  effort?: string | null;
}

/** A stopped, refunded native attempt can retry its saved conversation without another fix or round. */
export function refundedNativeReviewer(
  run: Run,
  params: RefundedNativeReviewerParams,
): (AgentContext & { reviewLoopNumber: number; reviewId: string }) | undefined {
  return [...(run.agentContexts ?? [])]
    .reverse()
    .find((context): context is AgentContext & { reviewLoopNumber: number; reviewId: string } => {
      const roundId = reviewContextRoundId(context);
      return (
        context.role === 'review' &&
        context.status === 'failed' &&
        typeof context.reviewLoopNumber === 'number' &&
        typeof context.reviewId === 'string' &&
        (!params.reviewId || context.reviewId === params.reviewId) &&
        (context.effort ?? null) === (params.effort?.trim() || null) &&
        !!context.nativeSession?.acceptedAt &&
        !!context.nativeSession.closedAt &&
        !context.nativeSession.releasedAt &&
        !context.reviewResultValidatedAt &&
        !!roundId &&
        !!run.reviewRoundSettlements?.[roundId] &&
        context.id.startsWith(
          nativeReviewerContextPrefix({
            ...params,
            runId: run.id,
            generation: run.engineState?.generation ?? 0,
            loopNumber: context.reviewLoopNumber,
          }),
        )
      );
    });
}

/**
 * The newest native reviewer of this review that is still running. A launch at its loop and
 * lineage reattaches to it and reuses its admission receipt.
 */
export function liveNativeReviewer(
  run: Run,
  params: { runner: string; model: string; taskDir: string; artifactScope?: string | null },
): (AgentContext & { reviewLoopNumber: number; reviewId: string }) | undefined {
  const generation = run.engineState?.generation ?? 0;
  return [...(run.agentContexts ?? [])].reverse().find(
    (context): context is AgentContext & { reviewLoopNumber: number; reviewId: string } =>
      typeof context.reviewLoopNumber === 'number' &&
      typeof context.reviewId === 'string' &&
      isLiveNativeReviewer(
        context,
        nativeReviewerContextPrefix({
          ...params,
          runId: run.id,
          generation,
          loopNumber: context.reviewLoopNumber,
        }),
      ),
  );
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

  if (context.model !== params.model) {
    const windowId = await resolveTmuxWindowId(params.vars, pane.paneId);
    if (!windowId || (await resolveTmuxWindowPaneCount(params.vars, windowId)) !== 1)
      throw new Error(
        `Cannot relaunch reviewer ${context.id}: its window is not exclusively owned`,
      );
    return abandonRecoveredReviewer('reviewer model changed; relaunching the exact reviewer');
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
  ...args: Parameters<typeof runReviewAgentAttempt>
): Promise<ReviewAgentResult> {
  const runId = args[5];
  const generation = getRun(runId)?.engineState?.generation ?? 0;
  const deadline = Date.now() + args[6];
  return withReviewerRelaunch(
    () => runReviewAgentAttempt(...args),
    async (error) => {
      const current = getRun(runId);
      if (
        !current ||
        runSupersededSince(current, generation) ||
        isTerminalRunStatus(current.status)
      )
        throw error;
      const context = [...(current.agentContexts ?? [])]
        .reverse()
        .find(
          (item) => item.role === 'review' && item.runner === args[1] && item.status === 'failed',
        );
      if (!context?.taskFile || !context.signalFile) throw error;
      const [vars, , , taskDir, , , , loopNumber, , artifactScope] = args;
      const artifactDir = reviewArtifactDir(loopNumber, artifactScope);
      const destination = slotTaskRelPath(vars, taskDir, `${artifactDir}/stopped-${randomUUID()}`);
      const files = [
        [context.taskFile, 'review.md'],
        [context.signalFile, 'review-signal.json'],
        [taskDirRelPath(taskDir, reviewerFeedbackRelPath(context.id)), 'review-feedback.md'],
        [taskDirRelPath(taskDir, reviewerResultRelPath(context.id)), 'review-result.json'],
        [taskDirRelPath(taskDir, `${artifactDir}/review.diff`), 'review.diff'],
        [taskDirRelPath(taskDir, `${artifactDir}/review-diff-stat.json`), 'review-diff-stat.json'],
      ];
      const archived = await execOnSlot(
        vars,
        [
          `mkdir -p ${shellQuote(destination)}`,
          ...files.map(([source, name]) => {
            const from = shellQuote(path.posix.resolve(vars.remoteRepo, source!));
            return `if [ -f ${from} ]; then cp ${from} ${shellQuote(`${destination}/${name}`)}; fi`;
          }),
        ].join(' && '),
        { timeout: 10_000 },
      );
      if (archived.exitCode !== 0)
        throw new AggregateError(
          [error, new Error(archived.stderr || archived.stdout)],
          'Stopped reviewer evidence could not be preserved',
        );
      const fresh = getRun(runId);
      if (!fresh || runSupersededSince(fresh, generation) || isTerminalRunStatus(fresh.status))
        throw error;
      args[6] = deadline - Date.now();
      if (args[6] <= 0)
        throw new Error(`${error.message}; review deadline expired before relaunch`, {
          cause: error,
        });
      console.warn(
        `[review] run ${runId.slice(0, 8)}: ${error.message}; relaunching reviewer once`,
      );
    },
  );
}

async function runReviewAgentAttempt(
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
  rereview?: ReReviewContinuation | null,
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
  // Only already-admitted tmux attempts may finish on their original transport.
  // Every new pipeline admission uses the native reviewer contract.
  const retainedTmux = selectRecoverableReviewContext(getRun(_runId)?.agentContexts ?? [], {
    taskDir,
    runner,
    artifactScope,
  });
  if (retainedTmux && !retainedTmux.nativeSession) {
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
    throw new Error(
      'The retained tmux review could not be collected. Request a cold native review.',
    );
  }
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
    rereview,
  });
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
  const failCompletion = async (
    reason: string,
    kind: 'artifact' | 'exited' = 'artifact',
  ): Promise<never> => {
    await markAgentContextStatus(runId, 'review', kind === 'exited' ? 'failed' : 'blocked', {
      id: reviewContextId,
      lastSignalAt: new Date().toISOString(),
    });
    if (kind === 'exited')
      throw new ReviewerExitedError(`Reviewer ${reviewContextId} stopped: ${reason}`);
    throw new TerminalReviewArtifactError(
      `Reviewer ${reviewContextId} completed with an invalid result artifact: ${reason}`,
    );
  };
  const validateCompletedOutput = async (): Promise<void> => {
    if (!(await outputExists(requiredOutputPaths[0]!))) {
      return failCompletion(`${feedbackRelPath} is missing`);
    }
    if (resultRelPath && !(await outputExists(requiredOutputPaths[1]!))) {
      return failCompletion(`${resultRelPath} is missing`);
    }
    if (resultRelPath) {
      const feedback = await readReviewFeedback(vars, taskDir, feedbackRelPath, resultRelPath);
      if (feedback.terminalInvalidReason) {
        return failCompletion(feedback.terminalInvalidReason);
      }
    }
  };
  // Only the reviewer-owned terminal mark can establish successful completion.
  const completeFromTerminalSignal = async (): Promise<boolean> => {
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
    if (!terminalSignal) return false;
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
  };
  // A recorded acceptance already proves the runner launched, even if it exits
  // before the first completion poll.
  let reviewerWasObservedActive =
    getRun(runId)?.agentContexts?.find((item) => item.id === reviewContextId)?.status === 'working';

  while (true) {
    const remainingMs = Math.max(0, timeoutMs - (Date.now() - start));
    await new Promise((r) => setTimeout(r, Math.min(pollInterval, remainingMs)));
    let reviewerActive = false;

    if (await completeFromTerminalSignal()) return true;

    const context = getRun(runId)?.agentContexts?.find((item) => item.id === reviewContextId);
    if (context?.runnerSessionId && context.runnerSessionPath) {
      const reading = await getRunnerObservability(runner)?.getSessionDeliveryState(
        vars,
        reviewTarget,
        context.runnerSessionId,
        context.runnerSessionPath,
      );
      const acceptance = context.promptAcceptance;
      if (
        reading?.failure &&
        reading.confidence === 'high' &&
        reading.sessionId === context.runnerSessionId &&
        acceptance?.sessionId === context.runnerSessionId &&
        acceptance.sessionPath === context.runnerSessionPath &&
        acceptance.deliveryStartedAt === context.attemptStartedAt &&
        acceptance.turnToken !== undefined &&
        reading.turnToken === acceptance.turnToken
      ) {
        await markAgentContextStatus(runId, 'review', 'failed', { id: reviewContextId });
        throw new Error(`Reviewer ${reviewContextId} failed: ${reading.failure}`);
      }
    }

    // Check the immutable reviewer target. Window names are not unique in tmux
    // and must never be used for lifecycle or completion decisions.
    const windowQuery = await execOnSlot(
      vars,
      tmuxShellSnippet(`list-panes -t ${shellQuote(reviewTarget)} 2>/dev/null`),
    );
    throwIfTmuxQueryTimedOut(windowQuery, 'reviewer window');
    const hasWindow = windowQuery.exitCode === 0;

    if (!hasWindow) {
      if (await completeFromTerminalSignal()) return true;
      return failCompletion(
        `${signalBasename} is missing after the reviewer window closed`,
        'exited',
      );
    }

    // Check if the configured runner process is still running in the review pane.
    const paneQuery = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `list-panes -t ${shellQuote(reviewTarget)} -F '#{pane_pid}' 2>/dev/null | head -1`,
      ),
    );
    throwIfTmuxQueryTimedOut(paneQuery, 'reviewer pane');
    const panePid = paneQuery.stdout.trim();

    if (panePid) {
      const runnerProbe = await probeRunnerDescendantPid(vars, panePid, runner);
      reviewerActive = runnerProbe.state === 'present';
      reviewerWasObservedActive ||= reviewerActive;

      if (runnerProbe.state === 'absent' && reviewerWasObservedActive) {
        if (await completeFromTerminalSignal()) return true;
        return failCompletion(
          `${signalBasename} is missing after the reviewer runner exited`,
          'exited',
        );
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
