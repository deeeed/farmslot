// self-review/review-agent.ts — launch and collect the independent self-review runner.

import path from 'node:path';

import {
  agentRoleWindow,
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
  resolveTmuxSession,
  respawnTmuxWindowWithCommand,
  shellQuote,
  TMUX_WINDOW_RESPAWN_SETTLE_MS,
  tmuxShellSnippet,
} from '../core/tmux.js';
import { writeTextFileOnSlot } from '../methods/dispatch/slot-file-write.js';
import { buildLaunchCommand, RUNNER_LAUNCH_READY_TIMEOUT_MS } from '../runners/launch-command.js';
import { probeRunnerHandoffAck } from '../runners/prompt-delivery-evidence.js';
import {
  runnerLineLooksWaiting,
  runnerNeedsPostLaunchPrompt,
  sendRunnerPostLaunchPrompt,
  WORKER_ENV_PREFIX,
} from '../runners/registry.js';
import { isRunnerAliveUnderPane } from '../runners/session-process.js';
import { resolveWorkerDispatchPrompt } from '../runners/worker-prompt.js';
import { getRun, updateRun } from '../runs/store.js';
import {
  extractRunnerSessionUsage,
  unavailableRunnerSessionUsage,
} from '../runtime/session-usage.js';
import { unwatchContext, watchContext } from '../tasks/watcher.js';

import { readReviewFeedback } from './feedback.js';
import { startProgressWatcher } from './progress.js';
import {
  bestEffortCaptureRunnerSessionMetadata,
  bestEffortListRunnerSessionFiles,
  captureReviewSnapshot,
  debugSelfReviewLog,
  durationBetween,
  killSelfReviewWindow,
  removeSlotFiles,
  reviewArtifactDir,
  type ReviewSessionMeta,
  waitForSessionTranscriptToSettle,
} from './snapshots.js';
import { expandSelfReviewTemplate } from './templates.js';

const REVIEW_WINDOW = agentRoleWindow('self-review') ?? 'self-review';

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
): Promise<ReviewAgentResult> {
  const session = await resolveTmuxSession(vars.slotId, vars);
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
  let reviewContext = await upsertAgentContext(_runId, 'self-review', {
    status: 'launching',
    taskFile: `${taskDir}/SELF-REVIEW.md`,
    signalFile: `${taskDir}/SELF-REVIEW-SIGNAL.json`,
    runner,
    model,
    target: null,
  });

  try {
    // 1. Kill any existing review window
    await killSelfReviewWindow(vars, session, 'pre-launch cleanup');

    // 1b. Clear prior-pass artifacts so waitForReviewCompletion / readReviewFeedback
    // can't short-circuit on stale files (caused retry verdict to mirror pass 1).
    await removeSlotFiles(vars, [
      `${vars.remoteRepo}/${taskDir}/artifacts/review-feedback.md`,
      `${vars.remoteRepo}/${taskDir}/SELF-REVIEW-SIGNAL.json`,
    ]);

    // 2. Create new window in same session
    const newWinResult = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `new-window -t ${shellQuote(session)} -n ${shellQuote(REVIEW_WINDOW)} -d 2>&1`,
      ),
    );
    debugSelfReviewLog(
      `[self-review] new-window: exit=${newWinResult.exitCode} out=${newWinResult.stdout.trim()} err=${newWinResult.stderr.trim()}`,
    );
    if (newWinResult.exitCode !== 0) {
      throw new Error(
        `Failed to create self-review tmux window ${session}:${REVIEW_WINDOW}: ${newWinResult.stderr || newWinResult.stdout || `exit ${newWinResult.exitCode}`}`,
      );
    }
    reviewContext =
      (await upsertAgentContext(_runId, 'self-review', {
        target: {
          session,
          window: REVIEW_WINDOW,
          pane: null,
          target: `${session}:${REVIEW_WINDOW}`,
        },
      })) ?? reviewContext;
    await new Promise((r) => setTimeout(r, 500));
    await ensureTmuxWindowMinimumSize(vars, `${session}:${REVIEW_WINDOW}`);

    // Log active windows so we can see what's in the session
    const winList = (
      await execOnSlot(vars, tmuxShellSnippet(`list-windows -t ${shellQuote(session)} 2>/dev/null`))
    ).stdout.trim();
    debugSelfReviewLog(`[self-review] windows in ${session}: ${winList}`);

    // 3. Write expanded self-review TASK.md to the slot before launch so
    // non-interactive runners (e.g. Codex) can read it immediately.
    // The template is in projects/<project>/templates/worker/self-review.md with {{VAR}} placeholders.
    // Long multiline prompts get bracketed-pasted by tmux — so we write to a file.
    const taskMdPath = `${taskDir}/SELF-REVIEW.md`;
    const expandedTemplate = await expandSelfReviewTemplate(vars, taskDir, _runId, validationDepth);
    await writeTextFileOnSlot(vars, taskMdPath, expandedTemplate);

    // Mark SELF-REVIEW.md as the active task file for progress tracking
    updateRun(_runId, { activeTaskFile: taskMdPath });
    activeTaskSet = true;
    if (reviewContext) await watchContext(vars.slotId, reviewContext);

    // Interactive runners receive a short prompt after the TUI is ready; the
    // detailed instructions live in SELF-REVIEW.md. Exec runners bake a
    // self-contained prompt into their launch command.
    const parentRun = getRun(_runId);
    const taskPrompt = runnerNeedsPostLaunchPrompt(runner)
      ? await resolveWorkerDispatchPrompt(parentRun?.project ?? vars.projectName, {
          taskFile: taskMdPath,
          taskDir,
        })
      : `Read ${taskMdPath} and execute all steps exactly as written. Do NOT run /review. You must write ${taskDir}/artifacts/review-feedback.md and ${taskDir}/SELF-REVIEW-SIGNAL.json before exiting.`;

    // 4. Launch review agent in the review window. Inherit the run's safety
    // tier (ADR-023) so the review agent runs with the same posture as the worker.
    const parentSafetyTier = parentRun?.safetyTier;
    const runtimeDir = await resolveProjectRuntimeDir(parentRun?.project);
    let launchCmd = buildLaunchCommand(vars, runner, model, taskPrompt, {
      taskFile: taskMdPath,
      effort: parentRun?.effort,
      safetyTier: parentSafetyTier,
      runtimeDir,
    });
    launchCmd = `${WORKER_ENV_PREFIX} && ${launchCmd}`;
    const reviewTarget = `${session}:${REVIEW_WINDOW}`;
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
    reviewContext =
      (await upsertAgentContext(_runId, 'self-review', {
        status: 'working',
        runnerSessionId: sessionMeta.runnerSessionId,
        runnerSessionPath: sessionMeta.runnerSessionPath,
      })) ?? reviewContext;

    // 5. For interactive runners, send the task with verify-and-retry.
    // Use the same runner-neutral post-launch protocol as dispatch: wait for a
    // stable runner prompt, send, then verify that the pane echoes our marker.
    if (runnerNeedsPostLaunchPrompt(runner)) {
      try {
        await sendRunnerPostLaunchPrompt(
          vars,
          reviewTarget,
          runner,
          taskPrompt,
          'SELF-REVIEW.md',
          'self-review',
          {
            readyTimeoutMs: RUNNER_LAUNCH_READY_TIMEOUT_MS,
            maxAttempts: 5,
            blockerSnapshotPath: `${taskDir}/artifacts/runner-blockers/self-review-launch.txt`,
            signalPath: `${taskDir}/SELF-REVIEW-SIGNAL.json`,
            launchAckSignalPath: `${taskDir}/SELF-REVIEW-SIGNAL.json`,
            handoffAckSinceMs,
            softAcceptOnHandoffAck: true,
          },
        );
      } catch (err) {
        const handoff = await probeRunnerHandoffAck(
          vars,
          reviewTarget,
          taskPrompt,
          handoffAckSinceMs,
          {
            launchAckSignalPath: `${taskDir}/SELF-REVIEW-SIGNAL.json`,
            preferHooks: true,
          },
        );
        if (!handoff.accepted) throw err;
        console.warn(
          `[self-review] prompt delivery verifier failed but continuing: ${handoff.reason}`,
        );
      }
    }

    // 6. Watch SELF-REVIEW.md for progress + wait for completion
    const selfReviewPath = `${vars.remoteRepo}/${taskDir}/SELF-REVIEW.md`;
    progressWatcher = startProgressWatcher(vars, selfReviewPath, _runId);
    const completed = await waitForReviewCompletion(
      vars,
      session,
      taskDir,
      reviewTimeoutMs,
      _runId,
      runner,
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

    // 7. Read review-feedback.md
    const feedback = await readReviewFeedback(vars, taskDir);
    completedSuccessfully = true;
    const persistedArtifacts: string[] = [];
    const taskProgressRel = `${artifactDir}/self-review.md`;
    const taskProgressCopy = await execOnSlot(
      vars,
      `mkdir -p ${shellQuote(path.posix.dirname(`${vars.remoteRepo}/${taskDir}/${taskProgressRel}`))} && cp ${shellQuote(`${vars.remoteRepo}/${taskMdPath}`)} ${shellQuote(`${vars.remoteRepo}/${taskDir}/${taskProgressRel}`)}`,
      { timeout: 10_000 },
    );
    if (taskProgressCopy.exitCode !== 0) {
      throw new Error(
        `Failed to persist self-review progress artifact: ${taskProgressCopy.stderr || taskProgressCopy.stdout || `exit ${taskProgressCopy.exitCode}`}`,
      );
    }
    persistedArtifacts.push(taskProgressRel);

    const signalRel = `${artifactDir}/self-review-signal.json`;
    const signalCopy = await execOnSlot(
      vars,
      `if [ -f ${shellQuote(`${vars.remoteRepo}/${taskDir}/SELF-REVIEW-SIGNAL.json`)} ]; then cp ${shellQuote(`${vars.remoteRepo}/${taskDir}/SELF-REVIEW-SIGNAL.json`)} ${shellQuote(`${vars.remoteRepo}/${taskDir}/${signalRel}`)} && echo copied; fi`,
      { timeout: 10_000 },
    );
    if (signalCopy.exitCode !== 0) {
      throw new Error(
        `Failed to persist self-review signal artifact: ${signalCopy.stderr || signalCopy.stdout || `exit ${signalCopy.exitCode}`}`,
      );
    }
    if (signalCopy.stdout.trim() === 'copied') persistedArtifacts.push(signalRel);

    if (!feedback.incomplete) {
      const feedbackRel = `${artifactDir}/review-feedback.md`;
      const feedbackSrc = `${vars.remoteRepo}/${taskDir}/artifacts/review-feedback.md`;
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
    const completedAt = new Date().toISOString();
    return {
      ...feedback,
      validationDepth,
      usage,
      reviewSnapshot: reviewSnapshot.snapshot,
      artifactPaths: [...reviewSnapshot.artifactPaths, ...persistedArtifacts],
      taskProgressArtifactPath: `${taskDir}/${taskProgressRel}`,
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
          artifactPaths: [...reviewSnapshot.artifactPaths, ...persistedArtifacts],
        },
      ],
      startedAt,
      completedAt,
    };
  } catch (err) {
    await markAgentContextStatus(_runId, 'self-review', 'failed', {
      lastSignalAt: new Date().toISOString(),
    });
    throw err;
  } finally {
    progressWatcher?.stop();
    // Cleanup must not mask the original throw above — log and continue so the outer error
    // propagates intact to the run-engine catch. Keep failed review panes alive for
    // forensics/manual recovery; only successful review agents are torn down.
    try {
      await unwatchContext(vars.slotId, 'self-review');
    } catch (cleanupErr) {
      console.warn(`[self-review] cleanup unwatchContext failed: ${(cleanupErr as Error).message}`);
    }
    if (activeTaskSet) updateRun(_runId, { activeTaskFile: undefined });
    if (completedSuccessfully) {
      try {
        await killSelfReviewWindow(vars, session, 'post-run cleanup');
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
): Promise<boolean> {
  const start = Date.now();
  const pollInterval = 10_000; // 10s

  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollInterval));

    // Check if the review window still exists
    const hasWindow =
      (
        await execOnSlot(
          vars,
          tmuxShellSnippet(
            `list-windows -t ${shellQuote(session)} -F '#{window_name}' 2>/dev/null | grep -q '${REVIEW_WINDOW}'`,
          ),
        )
      ).exitCode === 0;

    if (!hasWindow) {
      // Window disappearance is only success after the review artifact exists.
      const hasFeedback = (
        await execOnSlot(
          vars,
          `test -f '${vars.remoteRepo}/${taskDir}/artifacts/review-feedback.md' && echo yes`,
        )
      ).stdout.trim();
      if (hasFeedback === 'yes') {
        debugSelfReviewLog(`[self-review] review window gone + feedback written — agent completed`);
        await markAgentContextStatus(runId, 'self-review', 'complete', {
          lastSignalAt: new Date().toISOString(),
        });
        return true;
      }
      console.warn(
        `[self-review] review window gone before feedback file existed — waiting for timeout`,
      );
      continue;
    }

    // Check if the configured runner process is still running in the review pane.
    const panePid = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(
          `list-panes -t ${shellQuote(`${session}:${REVIEW_WINDOW}`)} -F '#{pane_pid}' 2>/dev/null | head -1`,
        ),
      )
    ).stdout.trim();

    if (panePid) {
      const agentAlive = await isRunnerAliveUnderPane(vars, panePid, runner);

      if (!agentAlive) {
        // Runner exited but window still exists — only declare done if feedback was written.
        // Without this gate, a false positive fires during runner startup before it has forked.
        const hasFeedback = (
          await execOnSlot(
            vars,
            `test -f '${vars.remoteRepo}/${taskDir}/artifacts/review-feedback.md' && echo yes`,
          )
        ).stdout.trim();
        if (hasFeedback === 'yes') {
          debugSelfReviewLog(
            `[self-review] ${runner} process exited + feedback written — agent completed`,
          );
          await markAgentContextStatus(runId, 'self-review', 'complete', {
            lastSignalAt: new Date().toISOString(),
          });
          return true;
        }
        debugSelfReviewLog(
          `[self-review] no ${runner} child found but no feedback yet — may be starting up, continuing poll`,
        );
      }
    }

    // Check if SELF-REVIEW-SIGNAL.json was written (review-specific signal, avoids stale worker SIGNAL.json)
    const signalCheck = (
      await execOnSlot(
        vars,
        `cat '${vars.remoteRepo}/${taskDir}/SELF-REVIEW-SIGNAL.json' 2>/dev/null`,
      )
    ).stdout.trim();
    if (signalCheck && signalCheck.includes('"status"')) {
      debugSelfReviewLog(`[self-review] SELF-REVIEW-SIGNAL.json detected — agent completed`);
      await markAgentContextStatus(runId, 'self-review', 'complete', {
        lastSignalAt: new Date().toISOString(),
      });
      return true;
    }

    // Check pane output for signs of completion
    const pane = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(
          `capture-pane -p -t ${shellQuote(`${session}:${REVIEW_WINDOW}`)} 2>/dev/null | tail -5`,
        ),
      )
    ).stdout;

    // Runner at idle prompt, not mid-tool-call.
    const tailLines = pane.split('\n');
    if (
      tailLines.some((line) => runnerLineLooksWaiting(line, runner)) &&
      !pane.includes('Running') &&
      !pane.includes('Searching') &&
      !pane.includes('Reading')
    ) {
      // Double-check: review-feedback.md exists = work is done
      const hasFeedback = (
        await execOnSlot(
          vars,
          `test -f '${vars.remoteRepo}/${taskDir}/artifacts/review-feedback.md' && echo yes`,
        )
      ).stdout.trim();
      if (hasFeedback === 'yes') {
        debugSelfReviewLog(`[self-review] idle prompt + feedback file — agent completed`);
        await markAgentContextStatus(runId, 'self-review', 'complete', {
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
          `test -f '${vars.remoteRepo}/${taskDir}/artifacts/review-feedback.md' && echo yes`,
        )
      ).stdout.trim();
      if (hasFeedback === 'yes') {
        debugSelfReviewLog(`[self-review] shell prompt + feedback file — agent completed`);
        await markAgentContextStatus(runId, 'self-review', 'complete', {
          lastSignalAt: new Date().toISOString(),
        });
        return true;
      }
      console.warn(
        `[self-review] shell prompt detected before feedback file existed — treating as incomplete and continuing wait`,
      );
    }
  }

  console.warn(`[self-review] review agent timed out after ${timeoutMs}ms`);
  return false;
}
