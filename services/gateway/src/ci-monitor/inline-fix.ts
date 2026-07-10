import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type BotComment,
  type CIWatchFixProgress,
  primaryRoleForFlow,
  type WorkerSignal,
} from '@farmslot/protocol';

import {
  markAgentContextStatus,
  resolveAgentTarget,
  upsertAgentContext,
} from '../agents/contexts.js';
import {
  farmslotRoot,
  loadProjectVars,
  loadSlotVars,
  resolveProjectRuntimeDir,
  resolveProjectTaskDirName,
} from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { expandTemplate } from '../core/hooks.js';
import {
  respawnTmuxWindowWithCommand,
  shellQuote,
  TMUX_WINDOW_RESPAWN_SETTLE_MS,
  tmuxShellSnippet,
} from '../core/tmux.js';
import { ghRequest } from '../integrations/github-client.js';
import { writeTextFileOnSlot } from '../methods/dispatch/slot-file-write.js';
import { buildLaunchCommand, RUNNER_LAUNCH_READY_TIMEOUT_MS } from '../runners/launch-command.js';
import {
  normalizeRunner,
  resolvePrimaryWorkerTarget,
  runnerLineLooksWaiting,
  runnerNeedsPostLaunchPrompt,
  runnerProcessPatternSource,
  sendRunnerInstructionSafely,
  WORKER_ENV_PREFIX,
} from '../runners/registry.js';
import { isRunnerAliveUnderPane } from '../runners/session-process.js';
import { resolveWorkerDispatchPrompt } from '../runners/worker-prompt.js';
import { getRun, updateRun, updateRunStep } from '../runs/store.js';
import { ensureTmuxTargetReadyForRelaunch } from '../self-review/worker-lifecycle.js';
import {
  CI_FIX_CHECKLIST,
  CI_FIX_CHECKLIST_TARGET,
  restoreWorkerChecklistTargetFromSlot,
  slotTaskRelPath,
  syncChecklistTargetForRole,
  taskDirRelPath,
} from '../tasks/checklist-target.js';
import { unwatchContext, watchContext } from '../tasks/watcher.js';

import {
  clearInlineFixState,
  type InlineCIFix,
  isInlineFixRedundant,
  mergeCIWatchOutputPatch,
  mutateDedup,
  parseCIFixProgress,
  readDedup,
  triggerForInlineFix,
} from './state.js';

const MAX_INLINE_CI_FIX_ATTEMPTS = 2;
const MAX_INLINE_CI_FIX_TOTAL = 6;
const INLINE_FIX_TIMEOUT_MS = 10 * 60_000;
const INLINE_FIX_FALLBACK_POLL_MS = 30_000;

export async function isInlineFixDedupedNow(
  runId: string,
  slotId: string | null,
  comments: BotComment[],
  failedChecks: string[],
): Promise<boolean> {
  if (!slotId) return false;
  const headSha = await getSlotHeadSha(slotId);
  if (!isInlineFixRedundant(runId, comments, failedChecks, headSha)) return false;
  const { skips } = mutateDedup(runId, (s) => {
    s.skips += 1;
  });
  mergeCIWatchOutputPatch(runId, {
    phase: 'deduped',
    fixInProgress: false,
    fixTrigger: triggerForInlineFix(comments, failedChecks),
    activeTaskFile: null,
    dedupReason: 'signature+HEAD match',
  });
  console.log(
    `[ci-monitor] run ${runId.slice(0, 8)} — inline fix deduped (signature+HEAD match) skip #${skips}`,
  );
  return true;
}

// ─── Inline CI fix (template-based) ───

/** Check if the worker session is still alive in tmux */
async function isWorkerSessionAlive(
  slotId: string,
  runnerId?: string | null,
  runId?: string,
): Promise<boolean> {
  try {
    const vars = await loadSlotVars(slotId);
    if (!vars.session) return false;
    const workerTarget = runId
      ? (await resolveAgentTarget(slotId, { runId, role: 'primary' })).target
      : await resolvePrimaryWorkerTarget(vars);
    const paneCmd = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(
          `display-message -p -t ${shellQuote(workerTarget)} '#{pane_current_command}' 2>/dev/null`,
        ),
      )
    ).stdout
      .trim()
      .toLowerCase();
    const matcherParts = runnerProcessPatternSource(runnerId)
      .split('|')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    if (paneCmd && matcherParts.some((part) => paneCmd.includes(part))) return true;
    const r = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `list-panes -t ${shellQuote(workerTarget)} -F '#{pane_pid}' 2>/dev/null | head -1`,
      ),
    );
    const panePid = r.stdout.trim();
    if (!panePid) return false;
    return await isRunnerAliveUnderPane(vars, panePid, runnerId);
  } catch {
    return false;
  }
}

async function relaunchWorkerSession(slotId: string, runId: string): Promise<boolean> {
  const run = getRun(runId);
  if (!run) return false;
  const vars = await loadSlotVars(slotId);
  const runner = normalizeRunner(run.metrics.runner);
  const model = run.metrics.model ?? 'unknown';
  const primaryTarget = await resolveAgentTarget(slotId, { runId, role: 'primary' });
  const roleWindowName =
    run.agentContexts?.find((ctx) => ctx.role === primaryRoleForFlow(run.flowType))?.target
      ?.window ?? null;
  const workerTarget = await ensureTmuxTargetReadyForRelaunch(
    vars,
    primaryTarget.session,
    primaryTarget.target,
    roleWindowName,
    run.flowType,
  );

  const prompt = 'Continue working on the current TASK.md and CI follow-up fixes.';
  // Inherit parent run's safety tier (ADR-023) so CI-watch relaunch keeps the posture.
  const runtimeDir = await resolveProjectRuntimeDir(run.project);
  let launchCmd = buildLaunchCommand(vars, runner, model, prompt, {
    effort: run.effort,
    safetyTier: run.safetyTier,
    runtimeDir,
  });
  launchCmd = `${WORKER_ENV_PREFIX} && ${launchCmd}`;

  await respawnTmuxWindowWithCommand(vars, workerTarget, launchCmd);
  await new Promise((resolve) => setTimeout(resolve, TMUX_WINDOW_RESPAWN_SETTLE_MS));

  const workerRole = primaryTarget.role ?? primaryRoleForFlow(run.flowType);
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
      session: primaryTarget.session,
      window,
      pane: null,
      target: workerTarget,
    },
  });

  if (!runnerNeedsPostLaunchPrompt(runner)) {
    return true;
  }

  const readyTimeout = RUNNER_LAUNCH_READY_TIMEOUT_MS;
  const readyStart = Date.now();
  while (Date.now() - readyStart < readyTimeout) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await isWorkerSessionAlive(slotId, runner, runId)) {
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
      return true;
    }
  }
  return false;
}

/** Get the current HEAD sha on the slot's repo */
export async function getSlotHeadSha(slotId: string): Promise<string | null> {
  try {
    const vars = await loadSlotVars(slotId);
    const r = await execOnSlot(vars, `git -C '${vars.remoteRepo}' rev-parse HEAD 2>/dev/null`);
    return r.exitCode === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** Check if all actionable comments are from bots (not human reviewers) */
function allCommentsAreFromBots(comments: BotComment[]): boolean {
  return (
    comments.length > 0 &&
    comments.every((c) => c.source === 'review_comment' || c.source === 'issue_comment')
  );
}

/** Build the CI_ISSUES placeholder content from comments + failed checks */
function buildCIIssuesString(comments: BotComment[], failedChecks: string[]): string {
  const lines: string[] = [];
  for (const c of comments) {
    lines.push(
      `- **Review comment** (${c.author}): ${c.bodyPreview} *(fetch full context via gh api)*`,
    );
  }
  for (const check of failedChecks) {
    lines.push(`- **CI failure**: \`${check}\` failed *(run \`gh pr checks\` for details)*`);
  }
  return lines.join('\n');
}

const CI_FIX_TEMPLATE_NAME = 'ci-fix.md';

/** Project-owned ci-fix template, then Farmslot default at `templates/worker/ci-fix.md`. */
export async function resolveCiFixTemplatePath(project: string): Promise<string | null> {
  const projectPath = path.join(
    farmslotRoot,
    'projects',
    project,
    'templates',
    'worker',
    CI_FIX_TEMPLATE_NAME,
  );
  try {
    await readFile(projectPath, 'utf-8');
    return projectPath;
  } catch {
    // fall through
  }

  const defaultPath = path.join(farmslotRoot, 'templates', 'worker', CI_FIX_TEMPLATE_NAME);
  try {
    await readFile(defaultPath, 'utf-8');
    console.warn(
      `[ci-monitor] project '${project}' has no templates/worker/${CI_FIX_TEMPLATE_NAME}; using Farmslot default`,
    );
    return defaultPath;
  } catch {
    console.warn(
      `[ci-monitor] no ci-fix template for project '${project}' and no Farmslot default at templates/worker/${CI_FIX_TEMPLATE_NAME}`,
    );
    return null;
  }
}

/** Resolve the slot's task directory path (relative within the repo) */
async function resolveSlotTaskDir(runId: string, project: string): Promise<string | null> {
  try {
    const run = getRun(runId);
    if (!run) return null;
    const pv = await loadProjectVars(project);
    const taskDir = resolveProjectTaskDirName(pv.projectJson);
    const taskFile = run.taskFile?.split('/tasks/')[1]?.replace('/TASK.md', '') ?? '';
    if (!taskFile) return null;
    return `${taskDir}/${taskFile}`;
  } catch {
    return null;
  }
}

/** Write CI-FIX.md to the slot's task dir using the ci-fix template */
async function writeCIFixTask(
  slotId: string,
  runId: string,
  comments: BotComment[],
  failedChecks: string[],
  prNumber: number,
  ciRepo: string,
): Promise<{ taskDir: string; taskPath: string; progress?: CIWatchFixProgress } | null> {
  const run = getRun(runId);
  if (!run) return null;

  const taskDir = await resolveSlotTaskDir(runId, run.project);
  if (!taskDir) return null;

  const ciIssues = buildCIIssuesString(comments, failedChecks);
  const ciIssueType =
    comments.length > 0 && failedChecks.length > 0
      ? 'both'
      : comments.length > 0
        ? 'comments'
        : 'failures';

  const templatePath = await resolveCiFixTemplatePath(run.project);
  if (!templatePath) return null;

  let template: string;
  try {
    template = await readFile(templatePath, 'utf-8');
  } catch {
    return null;
  }

  // Expand CI-watch placeholders, then standard slot/project template vars.
  const vars = await loadSlotVars(slotId);
  const pv = await loadProjectVars(run.project);
  const branch = run.branch ?? 'unknown';
  const defaultBranch =
    typeof pv.projectJson.default_branch === 'string' && pv.projectJson.default_branch.trim()
      ? pv.projectJson.default_branch.trim()
      : 'main';
  const ciReplacements: Record<string, string> = {
    TASK_DIR: taskDir,
    PR_NUMBER: String(prNumber),
    GH_REPO: ciRepo,
    BRANCH: branch,
    DEFAULT_BRANCH: defaultBranch,
    CI_ISSUES: ciIssues,
    CI_ISSUE_TYPE: ciIssueType,
  };

  let expanded = template;
  for (const [key, val] of Object.entries(ciReplacements)) {
    expanded = expanded.replaceAll(`{{${key}}}`, val);
  }
  expanded = expandTemplate(expanded, vars, pv);

  // Write CI-FIX.md to slot using the shared safe text writer
  const taskPath = taskDirRelPath(taskDir, CI_FIX_CHECKLIST_TARGET.checklist);
  await writeTextFileOnSlot(vars, taskPath, expanded);
  await syncChecklistTargetForRole(vars, taskDir, 'ci-fix');

  // Mark CI-FIX.md as the active task file for progress tracking
  updateRun(runId, { activeTaskFile: taskPath });

  console.log(
    `[ci-monitor] run ${runId.slice(0, 8)} — wrote ${taskDirRelPath(taskDir, CI_FIX_CHECKLIST)} to slot`,
  );
  return { taskDir, taskPath, progress: parseCIFixProgress(expanded) };
}

async function readRemoteCIFixProgress(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskPath: string,
): Promise<CIWatchFixProgress | undefined> {
  const fullPath = `${vars.remoteRepo}/${taskPath}`;
  try {
    const result = await execOnSlot(vars, `cat '${fullPath}' 2>/dev/null`);
    if (result.exitCode !== 0) return undefined;
    return parseCIFixProgress(result.stdout);
  } catch {
    // Progress is opportunistic; the signal file and HEAD checks remain authoritative.
    return undefined;
  }
}

/** Write CI-FIX.md template to slot, nudge worker, wait for CI-FIX-SIGNAL.json / HEAD change (fallback) */
async function attemptInlineCIFix(
  runId: string,
  slotId: string,
  comments: BotComment[],
  failedChecks: string[],
  prNumber: number,
  ciRepo: string,
  signal: AbortSignal,
): Promise<InlineCIFix> {
  const run = getRun(runId);
  const runner = normalizeRunner(run?.metrics.runner);
  const startedAt = Date.now();
  const { consecutiveAttempts: attempts, totalAttempts } = mutateDedup(runId, (s) => {
    s.consecutiveAttempts += 1;
    s.totalAttempts += 1;
  });
  const fixTrigger = triggerForInlineFix(comments, failedChecks);
  updateRunStep(runId, 'ci-watch', {
    detail: `Inline fix loop ${attempts}/${MAX_INLINE_CI_FIX_ATTEMPTS} (total ${totalAttempts}/${MAX_INLINE_CI_FIX_TOTAL})`,
  });
  mergeCIWatchOutputPatch(runId, {
    phase: 'fixing',
    fixInProgress: true,
    fixTrigger,
    nextPollAt: null,
    dedupReason: null,
  });

  console.log(
    `[ci-monitor] run ${runId.slice(0, 8)} — inline CI fix attempt ${attempts}/${MAX_INLINE_CI_FIX_ATTEMPTS} (total ${totalAttempts}/${MAX_INLINE_CI_FIX_TOTAL})`,
  );

  // Get current HEAD before nudge
  const beforeSha = await getSlotHeadSha(slotId);
  if (!beforeSha) {
    console.warn(
      `[ci-monitor] run ${runId.slice(0, 8)} — could not get HEAD sha, skipping inline fix`,
    );
    clearInlineFixState(runId, { phase: 'polling' });
    return { attempted: true, success: false, attempts };
  }

  // Write CI-FIX.md to slot
  const writeResult = await writeCIFixTask(slotId, runId, comments, failedChecks, prNumber, ciRepo);
  if (!writeResult) {
    console.warn(
      `[ci-monitor] run ${runId.slice(0, 8)} — failed to write CI-FIX.md, skipping inline fix`,
    );
    clearInlineFixState(runId, { phase: 'polling' });
    return { attempted: true, success: false, attempts };
  }
  mergeCIWatchOutputPatch(runId, {
    phase: 'fixing',
    fixInProgress: true,
    fixTrigger,
    activeTaskFile: writeResult.taskPath,
    fixProgress: writeResult.progress,
  });

  // Delete old CI-FIX-SIGNAL.json so we can detect fresh completion
  let ciFixContextStarted = false;
  let vars: Awaited<ReturnType<typeof loadSlotVars>> | undefined;
  try {
    vars = await loadSlotVars(slotId);
    const signalPath = slotTaskRelPath(vars, writeResult.taskDir, CI_FIX_CHECKLIST_TARGET.signal);
    await execOnSlot(vars, `rm -f '${signalPath}'`);
    let signalBaseline = '';
    try {
      signalBaseline = (
        await execOnSlot(vars, `cat '${signalPath}' 2>/dev/null || true`)
      ).stdout.trim();
    } catch (err) {
      console.warn(
        `[ci-monitor] run ${runId.slice(0, 8)} — failed to read CI fix signal baseline: ${(err as Error).message}`,
      );
      signalBaseline = '';
    }
    const primaryTarget = await resolveAgentTarget(slotId, { runId, role: 'primary' });
    const roleWindowName =
      run?.agentContexts?.find((ctx) => ctx.role === primaryRoleForFlow(run.flowType))?.target
        ?.window ?? null;
    const workerTarget = await ensureTmuxTargetReadyForRelaunch(
      vars,
      primaryTarget.session,
      primaryTarget.target,
      roleWindowName,
      run?.flowType,
    );
    const session = primaryTarget.session;

    // Send one-liner nudge to worker
    const ciFixTaskFile = taskDirRelPath(writeResult.taskDir, CI_FIX_CHECKLIST_TARGET.checklist);
    const nudgeCmd = await resolveWorkerDispatchPrompt(run?.project ?? vars.projectName, {
      taskFile: ciFixTaskFile,
      taskDir: writeResult.taskDir,
    });
    try {
      const sent = await sendRunnerInstructionSafely(
        vars,
        workerTarget,
        runner,
        nudgeCmd,
        'ci-monitor',
      );
      console.log(
        `[ci-monitor] run ${runId.slice(0, 8)} — CI fix nudge ${sent ? 'sent' : 'deferred'} to ${workerTarget}`,
      );
      if (!sent) {
        clearInlineFixState(runId, { phase: 'polling' });
        return { attempted: true, success: false, attempts, durationMs: Date.now() - startedAt };
      }
    } catch (err) {
      console.warn(
        `[ci-monitor] run ${runId.slice(0, 8)} — failed to send nudge: ${(err as Error).message}`,
      );
      clearInlineFixState(runId, { phase: 'polling' });
      return { attempted: true, success: false, attempts, durationMs: Date.now() - startedAt };
    }
    const ciFixContext = await upsertAgentContext(runId, 'ci-fix', {
      status: 'working',
      taskFile: writeResult.taskPath,
      signalFile: taskDirRelPath(writeResult.taskDir, CI_FIX_CHECKLIST_TARGET.signal),
      runner,
      model: run?.metrics.model ?? null,
      target: { session, window: null, pane: null, target: workerTarget },
    });
    if (ciFixContext) await watchContext(slotId, ciFixContext);
    ciFixContextStarted = true;
    mergeCIWatchOutputPatch(runId, {
      phase: 'waiting_for_worker',
      fixInProgress: true,
      fixTrigger,
      activeTaskFile: writeResult.taskPath,
      fixProgress: writeResult.progress,
    });

    const deadline = Date.now() + INLINE_FIX_TIMEOUT_MS;
    while (Date.now() < deadline && !signal.aborted) {
      const timeout = Math.min(INLINE_FIX_FALLBACK_POLL_MS, deadline - Date.now());
      try {
        await sleep(timeout, signal);
      } catch (err) {
        if (!signal.aborted) throw err;
      }
      if (signal.aborted) break;

      const fixProgress = await readRemoteCIFixProgress(vars, writeResult.taskPath);
      if (fixProgress) {
        mergeCIWatchOutputPatch(runId, {
          phase: 'waiting_for_worker',
          fixInProgress: true,
          fixTrigger,
          activeTaskFile: writeResult.taskPath,
          fixProgress,
        });
      }

      try {
        const raw = (
          await execOnSlot(vars, `cat '${signalPath}' 2>/dev/null || true`)
        ).stdout.trim();
        if (raw && raw !== signalBaseline) {
          const ws = JSON.parse(raw) as WorkerSignal;
          if (
            ws.status === 'complete' ||
            ws.status === 'done' ||
            ws.status === 'failed' ||
            ws.status === 'blocked'
          ) {
            const lastSignalAt = new Date().toISOString();
            const currentSha = await getSlotHeadSha(slotId);
            if (ws.status === 'blocked') {
              console.log(
                `[ci-monitor] run ${runId.slice(0, 8)} — ${CI_FIX_CHECKLIST_TARGET.signal} blocked: ${ws.reason ?? 'no reason provided'}`,
              );
              await markAgentContextStatus(runId, 'ci-fix', 'blocked', { lastSignalAt });
              await unwatchContext(slotId, 'ci-fix');
              clearInlineFixState(runId, {
                phase: 'blocked',
                lastSignalAt,
                lastFixCommitSha: currentSha ?? null,
                fixProgress,
              });
              return {
                attempted: true,
                success: false,
                blocked: true,
                blockedReason: ws.reason,
                attempts,
                commitSha: currentSha ?? undefined,
                durationMs: Date.now() - startedAt,
              };
            }
            mutateDedup(runId, (s) => {
              s.consecutiveAttempts = 0;
            });
            const commitChanged = !!(currentSha && currentSha !== beforeSha);
            console.log(
              `[ci-monitor] run ${runId.slice(0, 8)} — ${CI_FIX_CHECKLIST_TARGET.signal} detected, sha=${currentSha?.slice(0, 8)}${commitChanged ? '' : ' (no push)'}`,
            );
            await markAgentContextStatus(
              runId,
              'ci-fix',
              ws.status === 'failed' ? 'failed' : 'complete',
              { lastSignalAt },
            );
            await unwatchContext(slotId, 'ci-fix');
            clearInlineFixState(runId, {
              phase: 'polling',
              lastSignalAt,
              lastFixCommitSha: currentSha ?? null,
              fixProgress,
            });
            return {
              attempted: true,
              success: true,
              attempts,
              commitSha: currentSha ?? undefined,
              commitChanged,
              durationMs: Date.now() - startedAt,
            };
          }
        }
      } catch {
        // keep polling
      }

      const currentSha = await getSlotHeadSha(slotId);
      if (currentSha && currentSha !== beforeSha) {
        mutateDedup(runId, (s) => {
          s.consecutiveAttempts = 0;
        });
        console.log(
          `[ci-monitor] run ${runId.slice(0, 8)} — new commit detected: ${currentSha.slice(0, 8)} (was ${beforeSha.slice(0, 8)})`,
        );
        await markAgentContextStatus(runId, 'ci-fix', 'complete', {
          lastSignalAt: new Date().toISOString(),
        });
        await unwatchContext(slotId, 'ci-fix');
        clearInlineFixState(runId, {
          phase: 'polling',
          lastFixCommitSha: currentSha,
          fixProgress,
        });
        return {
          attempted: true,
          success: true,
          attempts,
          commitSha: currentSha,
          commitChanged: true,
          durationMs: Date.now() - startedAt,
        };
      }

      const alive = await isWorkerSessionAlive(slotId, runner, runId);
      if (!alive) {
        console.log(
          `[ci-monitor] run ${runId.slice(0, 8)} — worker session died during inline fix without success signal`,
        );
        await markAgentContextStatus(runId, 'ci-fix', 'failed');
        await unwatchContext(slotId, 'ci-fix');
        clearInlineFixState(runId, {
          phase: 'polling',
          fixProgress,
        });
        return { attempted: true, success: false, attempts, durationMs: Date.now() - startedAt };
      }
    }

    console.log(
      `[ci-monitor] run ${runId.slice(0, 8)} — inline fix timed out after ${Math.round((Date.now() - startedAt) / 1000)}s`,
    );
    await markAgentContextStatus(runId, 'ci-fix', 'failed');
    await unwatchContext(slotId, 'ci-fix');
    clearInlineFixState(runId, { phase: 'polling' });
    return { attempted: true, success: false, attempts, durationMs: Date.now() - startedAt };
  } catch (err) {
    console.warn(
      `[ci-monitor] run ${runId.slice(0, 8)} — inline CI fix setup failed: ${(err as Error).message}`,
    );
    if (ciFixContextStarted) {
      await markAgentContextStatus(runId, 'ci-fix', 'failed');
      await unwatchContext(slotId, 'ci-fix');
    }
    vars = vars ?? (await loadSlotVars(slotId));
    clearInlineFixState(runId, { phase: 'polling' });
    return { attempted: true, success: false, attempts, durationMs: Date.now() - startedAt };
  } finally {
    if (vars) {
      await restoreWorkerChecklistTargetFromSlot(vars, writeResult.taskDir);
    }
  }
}

/** Try inline CI fix — returns result if attempted, null if not applicable */
export async function tryInlineCIFix(
  runId: string,
  slotId: string | null,
  comments: BotComment[],
  failedChecks: string[],
  prNumber: number,
  ciRepo: string,
  signal: AbortSignal,
): Promise<InlineCIFix | null> {
  if (!slotId) return null;
  const run = getRun(runId);
  if (!run) return null;
  const runner = normalizeRunner(run.metrics.runner);

  const dedup = readDedup(runId);
  if (dedup.totalAttempts >= MAX_INLINE_CI_FIX_TOTAL) {
    console.log(
      `[ci-monitor] run ${runId.slice(0, 8)} — total inline CI fix cap (${MAX_INLINE_CI_FIX_TOTAL}) reached`,
    );
    return null;
  }

  const attempts = dedup.consecutiveAttempts;
  if (attempts >= MAX_INLINE_CI_FIX_ATTEMPTS) {
    console.log(
      `[ci-monitor] run ${runId.slice(0, 8)} — ${MAX_INLINE_CI_FIX_ATTEMPTS} consecutive inline fix failures, falling through to decision`,
    );
    return null;
  }

  // For comment-only triggers, ensure all are from bots (not human reviewers)
  if (comments.length > 0 && failedChecks.length === 0 && !allCommentsAreFromBots(comments))
    return null;

  let alive = await isWorkerSessionAlive(slotId, runner, runId);
  if (!alive) {
    if (run.mode === 'autonomous' || run.mode === 'validation') {
      console.log(
        `[ci-monitor] run ${runId.slice(0, 8)} — worker session not alive, relaunching warm worker`,
      );
      alive = await relaunchWorkerSession(slotId, runId);
    }
    if (!alive) {
      console.log(
        `[ci-monitor] run ${runId.slice(0, 8)} — worker session not alive, skipping inline fix`,
      );
      return null;
    }
  }

  return attemptInlineCIFix(runId, slotId, comments, failedChecks, prNumber, ciRepo, signal);
}

export async function rerunFailedChecks(prNumber: number, ciRepo: string): Promise<void> {
  try {
    const result = await ghRequest([
      'pr',
      'view',
      String(prNumber),
      '--repo',
      ciRepo,
      '--json',
      'headRefOid',
      '--jq',
      '.headRefOid',
    ]);
    const sha = result.stdout.trim();
    if (sha) {
      await ghRequest(
        ['api', `repos/${ciRepo}/check-suites`, '-X', 'POST', '-f', `head_sha=${sha}`],
        { force: true },
      );
      console.log(`[ci-monitor] requested check re-run for PR #${prNumber}`);
    }
  } catch {
    console.warn(`[ci-monitor] failed to re-run checks for PR #${prNumber}`);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}
