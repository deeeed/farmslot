// self-review.ts — Automated self-review step (D7)
// Spawns a second runner session in a new tmux window on the same slot.
// The review agent has full codebase access — can read files, run tsc, execute recipe.
// Writes review-feedback.md; if issues found, feeds back to worker for a fix pass.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type AgentContext,
  type IndependentReviewAttempt,
  primaryRoleForFlow,
  type ReviewDiffSnapshot,
  type ReviewFixDeltaSnapshot,
  type ReviewLoopTimelineSegment,
  type ReviewValidationDepth,
  type RunnerSessionUsage,
  type SelfReviewIssue,
  type WorkerSignal,
} from '@farmslot/protocol';

import {
  markAgentContextStatus,
  resolveAgentTarget,
  upsertAgentContext,
} from '../agents/contexts.js';
import { loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import {
  respawnTmuxWindowWithCommand,
  shellQuote,
  TMUX_WINDOW_RESPAWN_SETTLE_MS,
  tmuxShellSnippet,
} from '../core/tmux.js';
import { writeTextFileOnSlot } from '../methods/dispatch/slot-file-write.js';
import { buildLaunchCommand, RUNNER_LAUNCH_READY_TIMEOUT_MS } from '../runners/launch-command.js';
import {
  normalizeRunner,
  runnerDefaultModel,
  runnerLineLooksWaiting,
  runnerNeedsPostLaunchPrompt,
  sendRunnerInstructionSafely,
  WORKER_ENV_PREFIX,
} from '../runners/registry.js';
import { resolveWorkerDispatchPrompt } from '../runners/worker-prompt.js';
import { getRun, updateRun } from '../runs/store.js';
import {
  restoreWorkerChecklistTargetFromSlot,
  SELF_REVIEW_FIX_CHECKLIST_TARGET,
  slotTaskRelPath,
  syncChecklistTargetForRole,
  taskDirRelPath,
} from '../tasks/checklist-target.js';
import { unwatchContext, watchContext } from '../tasks/watcher.js';
import { signalFreshSince, terminalWorkerSignalFromRaw } from '../tasks/worker-signals.js';

import { parseSelfReviewIssueBullets } from './issues.js';
import { initSelfReviewProgress, startProgressWatcher } from './progress.js';
import { type ReviewAgentResult, runReviewAgent } from './review-agent.js';
import {
  captureCurrentHeadSha,
  captureFixDeltaSnapshot,
  debugSelfReviewLog,
  durationBetween,
  readOptionalSlotFile,
  removeSlotFiles,
  reviewAttemptFromResult,
} from './snapshots.js';
import { getSelfReviewConfig, resolveWorkerTaskDir } from './templates.js';
import { ensureTmuxTargetReadyForRelaunch, isWorkerAlive } from './worker-lifecycle.js';
export { handleSelfReviewFsChanged } from './progress.js';

export interface SelfReviewResult {
  skipped?: boolean;
  reason?: string;
  verdict?: 'pass' | 'issues' | 'blocked';
  issues?: SelfReviewIssue[];
  reviewSnapshot?: ReviewDiffSnapshot;
  fixDelta?: ReviewFixDeltaSnapshot;
  attempts?: IndependentReviewAttempt[];
  validationDepth?: ReviewValidationDepth;
  usage?: RunnerSessionUsage;
  taskProgressArtifactPath?: string;
  timeline?: ReviewLoopTimelineSegment[];
  runner?: string;
  model?: string;
  crossRunner?: boolean;
  retryCount: number;
  maxRetries?: number;
  feedbackSent?: boolean;
  durationMs?: number;
}

export interface SelfReviewOptions {
  reviewRunner?: string | null;
  model?: string | null;
  maxRetries?: number | null;
  validationDepth?: ReviewValidationDepth | null;
  artifactScope?: string | null;
  publicationReview?: boolean | null;
}

const DEFAULT_REVIEW_TIMEOUT_MIN = 30;
const FEEDBACK_TIMEOUT_MS = 30 * 60_000; // 30 min for worker to fix

type BroadcastFn = (event: string, payload: unknown) => void;

export function shouldSkipForDisabledSelfReviewConfig(
  config: { enabled: boolean },
  options: Pick<SelfReviewOptions, 'publicationReview'> = {},
): boolean {
  return !config.enabled && options.publicationReview !== true;
}

export function resolveSelfReviewRunnerModel(
  workerRunner: string,
  workerModel: string | undefined,
  config: { runner?: string; model?: string },
  options: Pick<SelfReviewOptions, 'reviewRunner' | 'model'> = {},
): { reviewRunner: string; model: string; crossRunner: boolean } {
  const normalizedWorkerRunner = normalizeRunner(workerRunner);
  const optionRunner = options.reviewRunner?.trim();
  const configRunner = config.runner?.trim();
  const explicitRunner =
    optionRunner && optionRunner !== 'same'
      ? normalizeRunner(optionRunner)
      : configRunner && configRunner !== 'same'
        ? normalizeRunner(configRunner)
        : null;
  const reviewRunner = explicitRunner ?? normalizedWorkerRunner;
  const crossRunner = reviewRunner !== normalizedWorkerRunner;
  // Publish-gate / human-gate plans pass reviewRunner explicitly (e.g. codex static).
  // Project self_review.model configures dispatch same-runner reviews — never bleed it
  // onto plan-requested cross-runners or Codex would inherit Claude's opus default.
  const planRequestedRunner = !!(optionRunner && optionRunner !== 'same');
  let model: string;
  if (options.model?.trim()) {
    model = options.model.trim();
  } else if (planRequestedRunner) {
    model = runnerDefaultModel(reviewRunner) ?? 'unknown';
  } else if (explicitRunner) {
    model = config.model?.trim() || runnerDefaultModel(reviewRunner) || 'unknown';
  } else {
    model =
      workerModel?.trim() || config.model?.trim() || runnerDefaultModel(reviewRunner) || 'unknown';
  }

  return {
    reviewRunner,
    model,
    crossRunner,
  };
}

export function initSelfReview(broadcast: BroadcastFn): void {
  initSelfReviewProgress(broadcast);
}

export async function executeSelfReview(
  runId: string,
  slotId: string,
  options: SelfReviewOptions = {},
): Promise<SelfReviewResult> {
  const run = getRun(runId);
  if (!run) throw new Error('Run not found');

  const config = await getSelfReviewConfig(run.project);
  if (shouldSkipForDisabledSelfReviewConfig(config, options)) {
    debugSelfReviewLog(
      `[self-review] run ${runId.slice(0, 8)} — disabled for project ${run.project}`,
    );
    return { skipped: true, reason: 'disabled-for-project', retryCount: 0 };
  }

  const vars = await loadSlotVars(slotId);
  const workerRunner = normalizeRunner(run.metrics.runner);
  const {
    reviewRunner,
    model,
    crossRunner: isCrossRunnerReview,
  } = resolveSelfReviewRunnerModel(workerRunner, run.metrics.model ?? undefined, config, options);
  const maxRetries = Math.max(0, Math.min(5, options.maxRetries ?? config.max_retries ?? 1));
  const validationDepth = options.validationDepth ?? 'full-live';
  const artifactScope = options.artifactScope ?? null;
  const reviewTimeoutMs = (config.review_timeout_min ?? DEFAULT_REVIEW_TIMEOUT_MIN) * 60_000;
  const start = Date.now();

  // Resolve task dir on the worker repo
  const taskDir = await resolveWorkerTaskDir(vars, run.project, run.taskFile);
  if (!taskDir) {
    debugSelfReviewLog(`[self-review] run ${runId.slice(0, 8)} — no task dir found`);
    return { skipped: true, reason: 'no-task-dir', retryCount: 0 };
  }

  const recoveredFixResult = await recoverSelfReviewFixPass({
    vars,
    taskDir,
    slotId,
    runId,
    start,
    reviewRunner,
    model,
    workerRunner,
    maxRetries,
    reviewTimeoutMs,
    validationDepth,
    artifactScope,
  });
  if (recoveredFixResult)
    return {
      ...recoveredFixResult,
      usage: recoveredFixResult.attempts?.at(-1)?.usage,
      runner: reviewRunner,
      model,
      crossRunner: isCrossRunnerReview,
    };

  // First review pass
  debugSelfReviewLog(
    `[self-review] run ${runId.slice(0, 8)} — spawning review agent (${reviewRunner}/${model}, timeout ${reviewTimeoutMs / 60_000}min)`,
  );
  const result = await runReviewAgent(
    vars,
    reviewRunner,
    model,
    taskDir,
    slotId,
    runId,
    reviewTimeoutMs,
    1,
    validationDepth,
    artifactScope,
  );

  if (result.incomplete) {
    console.warn(
      `[self-review] run ${runId.slice(0, 8)} — INCOMPLETE: agent exited without writing feedback`,
    );
    const attempts = [reviewAttemptFromResult(result, 1)];
    return {
      skipped: true,
      reason: 'no-feedback-file',
      retryCount: 0,
      validationDepth,
      usage: result.usage,
      reviewSnapshot: result.reviewSnapshot,
      attempts,
      timeline: attempts.flatMap((attempt) => attempt.timeline ?? []),
      durationMs: Date.now() - start,
    };
  }

  if (result.verdict === 'pass') {
    debugSelfReviewLog(`[self-review] run ${runId.slice(0, 8)} — PASS (${Date.now() - start}ms)`);
    return {
      verdict: 'pass',
      issues: [],
      validationDepth,
      usage: result.usage,
      reviewSnapshot: result.reviewSnapshot,
      attempts: [reviewAttemptFromResult(result, 1)],
      timeline: result.timeline,
      runner: reviewRunner,
      model,
      crossRunner: isCrossRunnerReview,
      retryCount: 0,
      durationMs: Date.now() - start,
    };
  }

  const retryResult = await runSelfReviewRetryLoop({
    vars,
    taskDir,
    slotId,
    runId,
    start,
    workerRunner,
    reviewRunner,
    model,
    maxRetries,
    reviewTimeoutMs,
    reviewResult: result,
    retryCount: 0,
    validationDepth,
    artifactScope,
  });
  return {
    ...retryResult,
    usage: retryResult.attempts?.at(-1)?.usage,
    runner: reviewRunner,
    model,
    crossRunner: isCrossRunnerReview,
  };
}

// Dep surface for runSelfReviewRetryLoop. Real production wiring lives in
// defaultSelfReviewRetryDeps below; tests pass a struct of mocks to exercise the
// retry boundary without standing up tmux/worker infrastructure.
export interface SelfReviewRetryDeps {
  isWorkerAlive: (
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    runner: string,
    runId?: string,
  ) => Promise<boolean>;
  relaunchWorkerForFix: (
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    runner: string,
    model: string,
    runId: string,
  ) => Promise<boolean>;
  sendFeedbackToWorker: (
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    issues: SelfReviewIssue[],
    taskDir: string,
    runId: string,
  ) => Promise<string>;
  startProgressWatcher: (
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    filePath: string,
    runId: string,
    label?: string,
  ) => { stop(): void };
  waitForWorkerSignal: (
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    taskDir: string,
    timeoutMs: number,
    baseline: string,
  ) => Promise<WorkerSignal | undefined>;
  // Loop never reads the return values — narrow to Promise<void> so test mocks don't have to
  // synthesize the production AgentContext shape just to satisfy the type checker.
  markAgentContextStatus: (...args: Parameters<typeof markAgentContextStatus>) => Promise<void>;
  unwatchContext: (slotId: string, role: 'self-review-fix') => Promise<void>;
  runReviewAgent: (
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    runner: string,
    model: string,
    taskDir: string,
    slotId: string,
    runId: string,
    reviewTimeoutMs: number,
    loopNumber?: number,
    validationDepth?: ReviewValidationDepth,
    artifactScope?: string | null,
  ) => Promise<ReviewAgentResult>;
  captureFixDelta: (
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    taskDir: string,
    loopNumber: number,
    fixBaseSha: string | null,
    artifactScope?: string | null,
  ) => Promise<{ snapshot: ReviewFixDeltaSnapshot; artifactPaths: string[] }>;
  captureHeadSha: (vars: Awaited<ReturnType<typeof loadSlotVars>>) => Promise<string | null>;
  restoreWorkerChecklistTargetFromSlot: (
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    taskDir: string,
  ) => Promise<void>;
  getRun: typeof getRun;
}

// Module-level constant — wiring is fixed at module load. Tests pass their own deps struct
// instead of reassigning here. Function declarations referenced inside the literal are
// hoisted, so the const initializer captures live function refs even though they appear
// later in the file.
const PRODUCTION_DEPS: SelfReviewRetryDeps = {
  isWorkerAlive,
  relaunchWorkerForFix,
  sendFeedbackToWorker,
  startProgressWatcher,
  waitForWorkerSignal,
  markAgentContextStatus,
  unwatchContext,
  runReviewAgent,
  captureFixDelta: captureFixDeltaSnapshot,
  captureHeadSha: captureCurrentHeadSha,
  restoreWorkerChecklistTargetFromSlot,
  getRun,
};

export async function runSelfReviewRetryLoop({
  vars,
  taskDir,
  slotId,
  runId,
  start,
  workerRunner,
  reviewRunner,
  model,
  maxRetries,
  reviewTimeoutMs,
  reviewResult,
  retryCount,
  validationDepth = 'full-live',
  artifactScope = null,
  feedbackAlreadySent = false,
  deps = PRODUCTION_DEPS,
}: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  taskDir: string;
  slotId: string;
  runId: string;
  start: number;
  workerRunner: string;
  reviewRunner: string;
  model: string;
  maxRetries: number;
  reviewTimeoutMs: number;
  reviewResult: ReviewAgentResult;
  retryCount: number;
  validationDepth?: ReviewValidationDepth;
  artifactScope?: string | null;
  feedbackAlreadySent?: boolean;
  deps?: SelfReviewRetryDeps;
}): Promise<SelfReviewResult> {
  let result = reviewResult;
  let feedbackSent = feedbackAlreadySent;
  const attempts: IndependentReviewAttempt[] = [reviewAttemptFromResult(result, retryCount + 1)];

  while (result.verdict === 'issues' && result.issues.length > 0 && retryCount < maxRetries) {
    console.log(
      `[self-review] run ${runId.slice(0, 8)} — ${result.issues.length} issue(s) found (retry ${retryCount + 1}/${maxRetries})`,
    );
    let workerAlive = await deps.isWorkerAlive(vars, workerRunner, runId);
    if (!workerAlive) {
      console.log(
        `[self-review] run ${runId.slice(0, 8)} — worker exited, re-launching primary worker`,
      );
      const run = deps.getRun(runId);
      workerAlive = await deps.relaunchWorkerForFix(
        vars,
        workerRunner,
        run?.metrics.model ?? model,
        runId,
      );
      if (!workerAlive) {
        console.warn(
          `[self-review] run ${runId.slice(0, 8)} — failed to re-launch worker, skipping feedback`,
        );
        return {
          verdict: 'issues',
          issues: result.issues,
          validationDepth,
          usage: result.usage,
          reviewSnapshot: result.reviewSnapshot,
          attempts,
          retryCount,
          maxRetries,
          feedbackSent,
          durationMs: Date.now() - start,
        };
      }
    }

    // Send feedback to the primary worker. Each pass clears the previous fix
    // signal and waits on a fresh baseline, so every retry gets its own timeout.
    let fixBaseSha: string | null = null;
    try {
      fixBaseSha = await deps.captureHeadSha(vars);
    } catch (err) {
      debugSelfReviewLog(
        `[self-review] run ${runId.slice(0, 8)} — failed to capture fix base SHA: ${(err as Error).message}`,
      );
    }
    const fixSignalBaseline = await deps.sendFeedbackToWorker(vars, result.issues, taskDir, runId);
    const fixStartedAt = new Date().toISOString();
    retryCount += 1;
    feedbackSent = true;
    const nextLoopNumber = retryCount + 1;
    console.log(
      `[self-review] run ${runId.slice(0, 8)} — feedback sent to worker, waiting for fix`,
    );

    // Watch the fix task for progress
    const fixTaskPath = slotTaskRelPath(vars, taskDir, SELF_REVIEW_FIX_CHECKLIST_TARGET.checklist);
    const fixWatcher = deps.startProgressWatcher(vars, fixTaskPath, runId, 'Fix');
    let fixSignal;
    let fixCompletedAt = fixStartedAt;
    try {
      fixSignal = await deps.waitForWorkerSignal(
        vars,
        taskDir,
        FEEDBACK_TIMEOUT_MS,
        fixSignalBaseline,
      );
      fixCompletedAt = new Date().toISOString();
      if (!fixSignal) {
        console.warn(`[self-review] run ${runId.slice(0, 8)} — timeout waiting for worker fix`);
        await deps.markAgentContextStatus(runId, 'self-review-fix', 'failed');
        await deps.unwatchContext(slotId, 'self-review-fix');
        if (retryCount >= maxRetries) {
          return {
            verdict: 'issues',
            issues: result.issues,
            validationDepth,
            usage: result.usage,
            reviewSnapshot: result.reviewSnapshot,
            attempts,
            retryCount,
            maxRetries,
            feedbackSent,
            durationMs: Date.now() - start,
          };
        }
        continue;
      }
      if (fixSignal.status === 'blocked') {
        const fixDelta = await deps.captureFixDelta(
          vars,
          taskDir,
          nextLoopNumber,
          fixBaseSha,
          artifactScope,
        );
        const fixArtifacts = fixDelta.artifactPaths;
        attempts.push({
          loopNumber: nextLoopNumber,
          verdict: 'failed',
          unresolvedCount: result.issues.length,
          fixDelta: fixDelta.snapshot,
          artifactPaths: fixArtifacts,
          timeline: [
            {
              kind: 'worker-fix',
              loopNumber: nextLoopNumber,
              runner: workerRunner,
              model,
              startedAt: fixStartedAt,
              completedAt: fixCompletedAt,
              durationMs: durationBetween(fixStartedAt, fixCompletedAt),
              verdict: 'failed',
              unresolvedCount: result.issues.length,
              artifactPaths: fixArtifacts,
            },
          ],
          completedAt: new Date().toISOString(),
        });
        debugSelfReviewLog(
          `[self-review] run ${runId.slice(0, 8)} — worker blocked during self-review fix: ${fixSignal.reason ?? 'no reason provided'}`,
        );
        await deps.markAgentContextStatus(runId, 'self-review-fix', 'blocked', {
          lastSignalAt: new Date().toISOString(),
        });
        await deps.unwatchContext(slotId, 'self-review-fix');
        return {
          verdict: 'blocked',
          reason: fixSignal.reason ?? 'worker blocked during self-review fix',
          issues: result.issues,
          validationDepth,
          usage: result.usage,
          reviewSnapshot: result.reviewSnapshot,
          fixDelta: fixDelta.snapshot,
          attempts,
          retryCount,
          maxRetries,
          feedbackSent,
          durationMs: Date.now() - start,
        };
      }

      await deps.markAgentContextStatus(
        runId,
        'self-review-fix',
        fixSignal.status === 'failed' ? 'failed' : 'complete',
        { lastSignalAt: new Date().toISOString() },
      );
      await deps.unwatchContext(slotId, 'self-review-fix');
      const fixDelta = await deps.captureFixDelta(
        vars,
        taskDir,
        nextLoopNumber,
        fixBaseSha,
        artifactScope,
      );
      const fixSegment: ReviewLoopTimelineSegment = {
        kind: 'worker-fix',
        loopNumber: nextLoopNumber,
        runner: workerRunner,
        model,
        startedAt: fixStartedAt,
        completedAt: fixCompletedAt,
        durationMs: durationBetween(fixStartedAt, fixCompletedAt),
        verdict: fixSignal.status === 'failed' ? 'failed' : 'pass',
        unresolvedCount: 0,
        artifactPaths: fixDelta.artifactPaths,
      };
      debugSelfReviewLog(`[self-review] run ${runId.slice(0, 8)} — re-reviewing after worker fix`);
      result = await deps.runReviewAgent(
        vars,
        reviewRunner,
        model,
        taskDir,
        slotId,
        runId,
        reviewTimeoutMs,
        nextLoopNumber,
        validationDepth,
        artifactScope,
      );
      attempts.push({
        ...reviewAttemptFromResult(
          result,
          nextLoopNumber,
          fixDelta.snapshot,
          fixDelta.artifactPaths,
        ),
        timeline: [fixSegment, ...(result.timeline ?? [])],
      });
      debugSelfReviewLog(
        `[self-review] run ${runId.slice(0, 8)} — retry verdict: ${result.verdict}`,
      );
    } finally {
      fixWatcher.stop();
      await deps.restoreWorkerChecklistTargetFromSlot(vars, taskDir);
    }
  }

  if (result.incomplete) {
    // A re-review after a fix pass exited without writing feedback. Its verdict
    // is a placeholder 'pass' from readReviewFeedback — returning it would
    // silently clear the previous reviewer's unresolved issues. Surface as
    // skipped (like the initial-review incomplete path) so the gate re-presents.
    console.warn(
      `[self-review] run ${runId.slice(0, 8)} — INCOMPLETE: re-review exited without writing feedback`,
    );
    return {
      skipped: true,
      reason: 'no-feedback-file',
      retryCount,
      maxRetries,
      feedbackSent,
      validationDepth,
      usage: result.usage,
      reviewSnapshot: result.reviewSnapshot,
      attempts,
      timeline: attempts.flatMap((attempt) => attempt.timeline ?? []),
      durationMs: Date.now() - start,
    };
  }

  return {
    verdict: result.verdict,
    issues: result.issues,
    validationDepth,
    usage: result.usage,
    reviewSnapshot: result.reviewSnapshot,
    fixDelta: attempts.at(-1)?.fixDelta,
    attempts,
    timeline: attempts.flatMap((attempt) => attempt.timeline ?? []),
    retryCount,
    maxRetries,
    feedbackSent,
    durationMs: Date.now() - start,
  };
}

// ─── Review Agent ───

async function readSelfReviewFixIssues(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
): Promise<SelfReviewIssue[]> {
  const content = await readOptionalSlotFile(
    vars,
    slotTaskRelPath(vars, taskDir, SELF_REVIEW_FIX_CHECKLIST_TARGET.checklist),
  );
  return parseSelfReviewIssueBullets(content);
}

export function canRecoverSelfReviewFixPass(
  fixContext: Pick<AgentContext, 'role' | 'status' | 'taskFile' | 'signalFile'> | null | undefined,
  taskDir: string,
): boolean {
  return (
    fixContext?.role === 'self-review-fix' &&
    fixContext.status === 'working' &&
    fixContext.taskFile === taskDirRelPath(taskDir, SELF_REVIEW_FIX_CHECKLIST_TARGET.checklist) &&
    fixContext.signalFile === taskDirRelPath(taskDir, SELF_REVIEW_FIX_CHECKLIST_TARGET.signal)
  );
}

async function recoverSelfReviewFixPass({
  vars,
  taskDir,
  slotId,
  runId,
  start,
  reviewRunner,
  model,
  workerRunner,
  maxRetries,
  reviewTimeoutMs,
  validationDepth,
  artifactScope,
}: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  taskDir: string;
  slotId: string;
  runId: string;
  start: number;
  reviewRunner: string;
  model: string;
  workerRunner: string;
  maxRetries: number;
  reviewTimeoutMs: number;
  validationDepth: ReviewValidationDepth;
  artifactScope?: string | null;
}): Promise<SelfReviewResult | null> {
  const run = getRun(runId);
  const fixContext = run?.agentContexts?.find((ctx) => canRecoverSelfReviewFixPass(ctx, taskDir));
  // Never recover from SELF-REVIEW-FIX-SIGNAL.json alone. That file is reused by every
  // review loop in the task dir, so a completed prior loop can otherwise masquerade as the
  // fix pass for a new external review and prevent feedback from reaching the worker.
  if (!fixContext) return null;

  try {
    const fixSignalPath = slotTaskRelPath(vars, taskDir, SELF_REVIEW_FIX_CHECKLIST_TARGET.signal);
    const rawSignal = await readOptionalSlotFile(vars, fixSignalPath);
    let fixSignal: WorkerSignal | undefined;
    try {
      fixSignal = terminalWorkerSignalFromRaw(rawSignal);
    } catch (err) {
      console.warn(
        `[self-review] ignoring invalid recovered self-review fix signal for ${runId.slice(0, 8)}: ${(err as Error).message}`,
      );
    }

    if (fixSignal && !signalFreshSince(fixSignal, fixContext?.startedAt)) {
      fixSignal = undefined;
    }

    const issues = await readSelfReviewFixIssues(vars, taskDir);
    debugSelfReviewLog(
      `[self-review] run ${runId.slice(0, 8)} — recovering self-review fix pass (${fixSignal ? 'signal-present' : 'waiting'})`,
    );

    if (!fixSignal) {
      const fixTaskPath = slotTaskRelPath(
        vars,
        taskDir,
        SELF_REVIEW_FIX_CHECKLIST_TARGET.checklist,
      );
      const fixWatcher = startProgressWatcher(vars, fixTaskPath, runId, 'Fix');
      try {
        fixSignal = await waitForWorkerSignal(vars, taskDir, FEEDBACK_TIMEOUT_MS, rawSignal);
      } finally {
        fixWatcher.stop();
      }
    }

    if (!fixSignal) {
      debugSelfReviewLog(
        `[self-review] run ${runId.slice(0, 8)} — timeout waiting for recovered worker fix`,
      );
      await markAgentContextStatus(runId, 'self-review-fix', 'failed');
      await unwatchContext(slotId, 'self-review-fix');
      if (maxRetries <= 1)
        return {
          verdict: 'issues',
          issues,
          validationDepth,
          retryCount: 1,
          maxRetries,
          feedbackSent: true,
          attempts: [
            { loopNumber: 1, verdict: 'issues', unresolvedCount: issues.length, validationDepth },
          ],
          durationMs: Date.now() - start,
        };
      return await runSelfReviewRetryLoop({
        vars,
        taskDir,
        slotId,
        runId,
        start,
        workerRunner,
        reviewRunner,
        model,
        maxRetries,
        reviewTimeoutMs,
        reviewResult: { verdict: 'issues', issues, validationDepth },
        retryCount: 1,
        validationDepth,
        artifactScope,
        feedbackAlreadySent: true,
      });
    }

    if (fixSignal.status === 'blocked') {
      const fixDelta = await captureFixDeltaSnapshot(vars, taskDir, 2, null, artifactScope);
      await markAgentContextStatus(runId, 'self-review-fix', 'blocked', {
        lastSignalAt: new Date().toISOString(),
      });
      await unwatchContext(slotId, 'self-review-fix');
      return {
        verdict: 'blocked',
        reason: fixSignal.reason ?? 'worker blocked during self-review fix',
        issues,
        validationDepth,
        retryCount: 1,
        fixDelta: fixDelta.snapshot,
        attempts: [
          { loopNumber: 1, verdict: 'issues', unresolvedCount: issues.length, validationDepth },
          {
            loopNumber: 2,
            verdict: 'failed',
            unresolvedCount: issues.length,
            validationDepth,
            fixDelta: fixDelta.snapshot,
            artifactPaths: fixDelta.artifactPaths,
          },
        ],
        feedbackSent: true,
        durationMs: Date.now() - start,
      };
    }

    await markAgentContextStatus(
      runId,
      'self-review-fix',
      fixSignal.status === 'failed' ? 'failed' : 'complete',
      { lastSignalAt: new Date().toISOString() },
    );
    await unwatchContext(slotId, 'self-review-fix');
    const fixDelta = await captureFixDeltaSnapshot(vars, taskDir, 2, null, artifactScope);
    const retryResult = await runReviewAgent(
      vars,
      reviewRunner,
      model,
      taskDir,
      slotId,
      runId,
      reviewTimeoutMs,
      2,
      validationDepth,
      artifactScope,
    );
    const seededReviewResult = {
      ...retryResult,
      fixDelta: fixDelta.snapshot,
      artifactPaths: [...(retryResult.artifactPaths ?? []), ...fixDelta.artifactPaths],
    };
    return await runSelfReviewRetryLoop({
      vars,
      taskDir,
      slotId,
      runId,
      start,
      workerRunner,
      reviewRunner,
      model,
      maxRetries,
      reviewTimeoutMs,
      reviewResult: seededReviewResult,
      retryCount: 1,
      validationDepth,
      artifactScope,
      feedbackAlreadySent: true,
    });
  } finally {
    await restoreWorkerChecklistTargetFromSlot(vars, taskDir);
  }
}

// ─── Feedback to worker ───

async function sendFeedbackToWorker(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  issues: SelfReviewIssue[],
  taskDir: string,
  runId: string,
): Promise<string> {
  const run = getRun(runId);
  const project = run?.project;
  if (!project)
    throw new Error(`Cannot send self-review feedback without a project for run ${runId}`);

  // Format issues as bullet list for template insertion
  const issueLines = issues
    .map((i) => {
      const loc = i.line ? `${i.file}:${i.line}` : i.file;
      return `- **${loc}** — ${i.description}`;
    })
    .join('\n');

  // Read and expand the self-review-fix template
  let template: string;
  try {
    const { farmslotRoot } = await import('../fleet/state.js');
    const templatePath = path.join(
      farmslotRoot,
      'projects',
      project,
      'templates',
      'worker',
      'self-review-fix.md',
    );
    template = await readFile(templatePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Self-review fix template not found for project ${project}: ${(err as Error).message}`,
    );
  }

  const runtimeDir = await resolveProjectRuntimeDir(project);

  const replacements: Record<string, string> = {
    TASK_DIR: taskDir,
    REPO: vars.remoteRepo,
    TICKET: run?.ticketOrPr ?? '',
    ISSUES: issueLines,
    RUNTIME_DIR: runtimeDir,
  };

  let expanded = template;
  for (const [key, val] of Object.entries(replacements)) {
    expanded = expanded.replaceAll(`{{${key}}}`, val);
  }

  // Clear any stale fix-pass signal before sending new feedback.
  const fixSignalPath = slotTaskRelPath(vars, taskDir, SELF_REVIEW_FIX_CHECKLIST_TARGET.signal);
  await removeSlotFiles(vars, [fixSignalPath]);
  const fixSignalBaseline = await readOptionalSlotFile(vars, fixSignalPath);

  // Write the fix task to a file on the slot
  await writeTextFileOnSlot(
    vars,
    taskDirRelPath(taskDir, SELF_REVIEW_FIX_CHECKLIST_TARGET.checklist),
    expanded,
  );
  await syncChecklistTargetForRole(vars, taskDir, 'self-review-fix');

  try {
    const fixTaskRel = taskDirRelPath(taskDir, SELF_REVIEW_FIX_CHECKLIST_TARGET.checklist);
    // Mark SELF-REVIEW-FIX.md as the active task file for progress tracking
    updateRun(runId, { activeTaskFile: fixTaskRel });
    const primaryTarget = await resolveAgentTarget(vars.slotId, { runId, role: 'primary' });
    const session = primaryTarget.session;
    const roleWindowName =
      getRun(runId)?.agentContexts?.find((ctx) => ctx.role === primaryRoleForFlow(run?.flowType))
        ?.target?.window ?? null;
    const workerTarget = await ensureTmuxTargetReadyForRelaunch(
      vars,
      session,
      primaryTarget.target,
      roleWindowName,
      run?.flowType,
    );
    // Derive the window name from the primary worker's target so resolveAgentTarget
    // can route back to the correct pane if the stored context is used.
    const workerWindowSep = workerTarget.indexOf(':');
    const workerWindow =
      workerWindowSep === -1
        ? null
        : workerTarget.slice(workerWindowSep + 1).split('.', 1)[0] || null;
    const fixContext = await upsertAgentContext(runId, 'self-review-fix', {
      status: 'working',
      taskFile: taskDirRelPath(taskDir, SELF_REVIEW_FIX_CHECKLIST_TARGET.checklist),
      signalFile: taskDirRelPath(taskDir, SELF_REVIEW_FIX_CHECKLIST_TARGET.signal),
      runner: run?.metrics.runner ?? null,
      model: run?.metrics.model ?? null,
      target: { session, window: workerWindow, pane: null, target: workerTarget },
    });
    if (fixContext) await watchContext(vars.slotId, fixContext);

    // Send single-line command to the worker's original pane
    const fixTaskFile = taskDirRelPath(taskDir, SELF_REVIEW_FIX_CHECKLIST_TARGET.checklist);
    const cmd = await resolveWorkerDispatchPrompt(project, {
      taskFile: fixTaskFile,
      taskDir,
    });
    let sent = await sendRunnerInstructionSafely(
      vars,
      workerTarget,
      normalizeRunner(run?.metrics.runner),
      cmd,
      'self-review',
    );
    if (!sent) {
      // A deferred send never retries on its own — the fix wait would burn its
      // whole timeout against a worker that never received the task. Retry
      // once forcing the busy-composer poll before giving up.
      console.warn(
        `[self-review] run ${runId.slice(0, 8)} — fix task send deferred; retrying with busy-poll`,
      );
      sent = await sendRunnerInstructionSafely(
        vars,
        workerTarget,
        normalizeRunner(run?.metrics.runner),
        cmd,
        'self-review',
        undefined,
        { forceBusyPoll: true },
      );
    }
    // Always-on: delivery state is the first question when a fix loop stalls.
    console.log(
      `[self-review] run ${runId.slice(0, 8)} — fix task ${sent ? 'sent' : 'NOT delivered (deferred twice)'}: ${fixTaskFile}`,
    );
    return fixSignalBaseline;
  } catch (err) {
    await restoreWorkerChecklistTargetFromSlot(vars, taskDir);
    updateRun(runId, { activeTaskFile: undefined });
    throw err;
  }
}

// ─── Helpers ───

async function relaunchWorkerForFix(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  model: string,
  runId: string,
): Promise<boolean> {
  const resolved = await resolveAgentTarget(vars.slotId, { runId, role: 'primary' });
  const parentRun = getRun(runId);
  const roleWindowName =
    parentRun?.agentContexts?.find((ctx) => ctx.role === primaryRoleForFlow(parentRun?.flowType))
      ?.target?.window ?? null;
  const workerTarget = await ensureTmuxTargetReadyForRelaunch(
    vars,
    resolved.session,
    resolved.target,
    roleWindowName,
    parentRun?.flowType,
  );
  const prompt = 'Continue working on the current TASK.md and self-review fix feedback.';
  // Inherit parent run's safety tier (ADR-023) so the relaunch stays on the same posture.
  const parentSafetyTier = parentRun?.safetyTier;
  const runtimeDir = await resolveProjectRuntimeDir(parentRun?.project);
  let launchCmd = buildLaunchCommand(vars, runner, model, prompt, {
    effort: parentRun?.effort,
    safetyTier: parentSafetyTier,
    runtimeDir,
  });
  launchCmd = `${WORKER_ENV_PREFIX} && ${launchCmd}`;
  await respawnTmuxWindowWithCommand(vars, workerTarget, launchCmd);
  await new Promise((r) => setTimeout(r, TMUX_WINDOW_RESPAWN_SETTLE_MS));
  const run = getRun(runId);
  const workerRole = resolved.role ?? primaryRoleForFlow(run?.flowType);
  const windowSeparator = workerTarget.indexOf(':');
  const window =
    windowSeparator === -1
      ? null
      : workerTarget.slice(windowSeparator + 1).split('.', 1)[0] || null;
  await upsertAgentContext(runId, workerRole, {
    status: 'working',
    runner,
    model,
    target: {
      session: resolved.session,
      window,
      pane: null,
      target: workerTarget,
    },
  });

  if (!runnerNeedsPostLaunchPrompt(runner)) {
    debugSelfReviewLog(`[self-review] worker re-launched (${runner})`);
    return true;
  }

  const readyTimeout = RUNNER_LAUNCH_READY_TIMEOUT_MS;
  const readyStart = Date.now();
  while (Date.now() - readyStart < readyTimeout) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await isWorkerAlive(vars, runner, runId)) {
      debugSelfReviewLog(
        `[self-review] worker re-launched (${runner}) in ${Math.round((Date.now() - readyStart) / 1000)}s`,
      );
      return true;
    }
    const pane = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(`capture-pane -p -t ${shellQuote(workerTarget)} 2>/dev/null | tail -8`),
      )
    ).stdout;
    const tailLines = pane
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-5);
    if (tailLines.some((line) => runnerLineLooksWaiting(line, runner))) {
      debugSelfReviewLog(
        `[self-review] worker re-launched in ${Math.round((Date.now() - readyStart) / 1000)}s`,
      );
      return true;
    }
  }
  console.warn(`[self-review] worker re-launch timed out after ${readyTimeout}ms`);
  return false;
}

async function waitForWorkerSignal(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  timeoutMs: number,
  baseline: string,
): Promise<WorkerSignal | undefined> {
  const signalPath = slotTaskRelPath(vars, taskDir, SELF_REVIEW_FIX_CHECKLIST_TARGET.signal);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const raw = await readOptionalSlotFile(vars, signalPath);
      if (!raw || raw === baseline) continue;
      const signal = terminalWorkerSignalFromRaw(raw);
      if (signal) return signal;
    } catch (err) {
      console.warn(`[self-review] failed to parse ${signalPath}: ${(err as Error).message}`);
    }
  }
  return undefined;
}
