import { createHash } from 'node:crypto';

import {
  agentRoleWindow,
  type DiffStat,
  type IndependentReviewAttempt,
  type ReviewDiffSnapshot,
  type ReviewFixDeltaSnapshot,
} from '@farmslot/protocol';

import { getProjectField, loadProjectVars, loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote, tmuxShellSnippet } from '../core/tmux.js';
import { writeTextFileOnSlot } from '../methods/dispatch/slot-file-write.js';
import {
  captureRunnerSessionMetadata,
  listRunnerSessionFiles,
} from '../runners/session-process.js';

import type { ReviewAgentResult } from './review-agent.js';

const REVIEW_WINDOW = agentRoleWindow('self-review') ?? 'self-review';
const REVIEW_DIFF_MAX_BUFFER = 5 * 1024 * 1024;

export type ReviewSessionMeta = {
  runnerSessionPath: string | null;
  runnerSessionId: string | null;
  error?: string;
};

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function parseReviewNumstat(text: string): DiffStat {
  const stat = { files: 0, additions: 0, deletions: 0 };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [addRaw, delRaw] = line.split('\t');
    stat.files += 1;
    const additions = Number(addRaw);
    const deletions = Number(delRaw);
    if (Number.isFinite(additions)) stat.additions += additions;
    if (Number.isFinite(deletions)) stat.deletions += deletions;
  }
  return stat;
}

export function reviewArtifactDir(loopNumber: number, artifactScope?: string | null): string {
  const scope = artifactScope?.trim().replace(/^\/+|\/+$/g, '');
  if (!scope) return `artifacts/review-loop-${loopNumber}`;
  if (scope.includes('..')) throw new Error(`Invalid review artifact scope: ${artifactScope}`);
  return `artifacts/${scope}/review-loop-${loopNumber}`;
}

export function unavailableReviewSnapshot(
  missingReason: string,
  error?: string,
): ReviewDiffSnapshot {
  return {
    source: 'unavailable',
    capturedAt: new Date().toISOString(),
    missingReason,
    ...(error ? { error: error.slice(0, 500) } : {}),
  };
}

async function resolveReviewBaseRef(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
): Promise<string> {
  try {
    const pv = await loadProjectVars(vars.projectName);
    return getProjectField(pv.projectJson, 'default_branch') || 'main';
  } catch (err) {
    debugSelfReviewLog(
      `[self-review] defaulting review base ref to main after project lookup failed: ${(err as Error).message}`,
    );
    return 'main';
  }
}

export async function captureReviewSnapshot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  loopNumber: number,
  artifactScope?: string | null,
): Promise<{ snapshot: ReviewDiffSnapshot; artifactPaths: string[] }> {
  const baseRef = await resolveReviewBaseRef(vars);
  const artifactDir = reviewArtifactDir(loopNumber, artifactScope);
  const diffRel = `${artifactDir}/review.diff`;
  const statRel = `${artifactDir}/review-diff-stat.json`;
  try {
    const headResult = await execOnSlot(vars, 'git rev-parse HEAD', { timeout: 10_000 });
    if (headResult.exitCode !== 0) {
      const snapshot = unavailableReviewSnapshot(
        'head-ref-unavailable',
        headResult.stderr || headResult.stdout,
      );
      await writeTextFileOnSlot(vars, `${taskDir}/${statRel}`, JSON.stringify(snapshot, null, 2));
      return { snapshot, artifactPaths: [statRel] };
    }
    const baseResult = await execOnSlot(
      vars,
      `git merge-base ${shellQuote(baseRef)} HEAD 2>/dev/null || git rev-parse --verify ${shellQuote(baseRef)} 2>/dev/null`,
      { timeout: 10_000 },
    );
    if (baseResult.exitCode !== 0) {
      const snapshot = unavailableReviewSnapshot(
        'base-ref-unavailable',
        baseResult.stderr || baseResult.stdout,
      );
      await writeTextFileOnSlot(vars, `${taskDir}/${statRel}`, JSON.stringify(snapshot, null, 2));
      return { snapshot, artifactPaths: [statRel] };
    }
    const branchResult = await execOnSlot(
      vars,
      'git rev-parse --abbrev-ref HEAD 2>/dev/null || true',
      { timeout: 10_000 },
    );
    const headSha = headResult.stdout.trim();
    const baseSha = baseResult.stdout.trim().split('\n').at(-1)?.trim() ?? '';
    const headRef = branchResult.stdout.trim() || null;
    // Compare the base commit to the current worktree instead of HEAD-only so
    // local-first/uncommitted runner fixes are still captured for audit.
    const range = shellQuote(baseSha);
    const numstat = await execOnSlot(vars, `git -c core.quotePath=false diff --numstat ${range}`, {
      timeout: 10_000,
    });
    if (numstat.exitCode !== 0) {
      const snapshot = unavailableReviewSnapshot(
        'git-numstat-failed',
        numstat.stderr || numstat.stdout,
      );
      await writeTextFileOnSlot(vars, `${taskDir}/${statRel}`, JSON.stringify(snapshot, null, 2));
      return { snapshot, artifactPaths: [statRel] };
    }
    const diff = await execOnSlot(
      vars,
      `git -c core.quotePath=false diff --binary --find-renames ${range}`,
      {
        timeout: 30_000,
        maxBuffer: REVIEW_DIFF_MAX_BUFFER,
      },
    );
    if (diff.exitCode !== 0) {
      const snapshot = unavailableReviewSnapshot(
        /maxBuffer exceeded/i.test(diff.stderr) ? 'diff-artifact-too-large' : 'git-diff-failed',
        diff.stderr || diff.stdout,
      );
      await writeTextFileOnSlot(vars, `${taskDir}/${statRel}`, JSON.stringify(snapshot, null, 2));
      return { snapshot, artifactPaths: [statRel] };
    }
    const snapshot: ReviewDiffSnapshot = {
      source: 'local-git',
      baseRef,
      baseSha,
      headRef,
      headSha,
      diffPath: diffRel,
      diffHash: sha256(diff.stdout),
      diffStat: parseReviewNumstat(numstat.stdout),
      capturedAt: new Date().toISOString(),
    };
    await writeTextFileOnSlot(vars, `${taskDir}/${diffRel}`, diff.stdout);
    await writeTextFileOnSlot(vars, `${taskDir}/${statRel}`, JSON.stringify(snapshot, null, 2));
    return { snapshot, artifactPaths: [diffRel, statRel] };
  } catch (err) {
    const snapshot = unavailableReviewSnapshot('slot-exec-error', (err as Error).message);
    try {
      await writeTextFileOnSlot(vars, `${taskDir}/${statRel}`, JSON.stringify(snapshot, null, 2));
      return { snapshot, artifactPaths: [statRel] };
    } catch (writeErr) {
      debugSelfReviewLog(
        `[self-review] failed to persist unavailable review snapshot: ${(writeErr as Error).message}`,
      );
      return { snapshot, artifactPaths: [] };
    }
  }
}

export async function captureFixDeltaSnapshot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  loopNumber: number,
  fixBaseSha: string | null,
  artifactScope?: string | null,
): Promise<{ snapshot: ReviewFixDeltaSnapshot; artifactPaths: string[] }> {
  const artifactDir = reviewArtifactDir(loopNumber, artifactScope);
  const diffRel = `${artifactDir}/fix-delta.diff`;
  const statRel = `${artifactDir}/fix-delta-stat.json`;
  try {
    if (!fixBaseSha) {
      const snapshot: ReviewFixDeltaSnapshot = {
        ...unavailableReviewSnapshot('fix-base-unavailable'),
        fixBaseSha: null,
        fixHeadSha: null,
      };
      await writeTextFileOnSlot(vars, `${taskDir}/${statRel}`, JSON.stringify(snapshot, null, 2));
      return { snapshot, artifactPaths: [statRel] };
    }
    const headResult = await execOnSlot(vars, 'git rev-parse HEAD', { timeout: 10_000 });
    if (headResult.exitCode !== 0) {
      const snapshot: ReviewFixDeltaSnapshot = {
        ...unavailableReviewSnapshot(
          'fix-head-unavailable',
          headResult.stderr || headResult.stdout,
        ),
        fixBaseSha,
        fixHeadSha: null,
      };
      await writeTextFileOnSlot(vars, `${taskDir}/${statRel}`, JSON.stringify(snapshot, null, 2));
      return { snapshot, artifactPaths: [statRel] };
    }
    const fixHeadSha = headResult.stdout.trim();
    // Use base-to-worktree, not base..HEAD, so a self-review fix pass that
    // leaves changes uncommitted still has a useful delta artifact.
    const range = shellQuote(fixBaseSha);
    const numstat = await execOnSlot(vars, `git -c core.quotePath=false diff --numstat ${range}`, {
      timeout: 10_000,
    });
    if (numstat.exitCode !== 0) {
      const snapshot: ReviewFixDeltaSnapshot = {
        ...unavailableReviewSnapshot('git-numstat-failed', numstat.stderr || numstat.stdout),
        fixBaseSha,
        fixHeadSha,
      };
      await writeTextFileOnSlot(vars, `${taskDir}/${statRel}`, JSON.stringify(snapshot, null, 2));
      return { snapshot, artifactPaths: [statRel] };
    }
    const diff = await execOnSlot(
      vars,
      `git -c core.quotePath=false diff --binary --find-renames ${range}`,
      {
        timeout: 30_000,
        maxBuffer: REVIEW_DIFF_MAX_BUFFER,
      },
    );
    if (diff.exitCode !== 0) {
      const snapshot: ReviewFixDeltaSnapshot = {
        ...unavailableReviewSnapshot(
          /maxBuffer exceeded/i.test(diff.stderr) ? 'diff-artifact-too-large' : 'git-diff-failed',
          diff.stderr || diff.stdout,
        ),
        fixBaseSha,
        fixHeadSha,
      };
      await writeTextFileOnSlot(vars, `${taskDir}/${statRel}`, JSON.stringify(snapshot, null, 2));
      return { snapshot, artifactPaths: [statRel] };
    }
    const snapshot: ReviewFixDeltaSnapshot = {
      source: 'local-git',
      baseSha: fixBaseSha,
      headSha: fixHeadSha,
      fixBaseSha,
      fixHeadSha,
      diffPath: diffRel,
      diffHash: sha256(diff.stdout),
      diffStat: parseReviewNumstat(numstat.stdout),
      capturedAt: new Date().toISOString(),
    };
    await writeTextFileOnSlot(vars, `${taskDir}/${diffRel}`, diff.stdout);
    await writeTextFileOnSlot(vars, `${taskDir}/${statRel}`, JSON.stringify(snapshot, null, 2));
    return { snapshot, artifactPaths: [diffRel, statRel] };
  } catch (err) {
    const snapshot: ReviewFixDeltaSnapshot = {
      ...unavailableReviewSnapshot('slot-exec-error', (err as Error).message),
      fixBaseSha,
      fixHeadSha: null,
    };
    try {
      await writeTextFileOnSlot(vars, `${taskDir}/${statRel}`, JSON.stringify(snapshot, null, 2));
      return { snapshot, artifactPaths: [statRel] };
    } catch (writeErr) {
      debugSelfReviewLog(
        `[self-review] failed to persist unavailable fix-delta snapshot: ${(writeErr as Error).message}`,
      );
      return { snapshot, artifactPaths: [] };
    }
  }
}

export async function captureCurrentHeadSha(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
): Promise<string | null> {
  const result = await execOnSlot(vars, 'git rev-parse HEAD', { timeout: 10_000 });
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

export function reviewAttemptFromResult(
  result: ReviewAgentResult,
  loopNumber: number,
  fixDelta?: ReviewFixDeltaSnapshot,
  extraArtifactPaths: string[] = [],
): IndependentReviewAttempt {
  const effectiveFixDelta = fixDelta ?? result.fixDelta;
  return {
    loopNumber,
    verdict: result.verdict === 'pass' ? 'pass' : 'issues',
    unresolvedCount: result.verdict === 'pass' ? 0 : result.issues.length,
    ...(result.issues.length ? { issues: result.issues } : {}),
    ...(result.validationDepth ? { validationDepth: result.validationDepth } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.reviewSnapshot ? { reviewSnapshot: result.reviewSnapshot } : {}),
    ...(effectiveFixDelta ? { fixDelta: effectiveFixDelta } : {}),
    artifactPaths: [...(result.artifactPaths ?? []), ...extraArtifactPaths],
    ...(result.taskProgressArtifactPath
      ? { taskProgressArtifactPath: result.taskProgressArtifactPath }
      : {}),
    ...(result.timeline?.length ? { timeline: result.timeline } : {}),
    ...(result.startedAt ? { startedAt: result.startedAt } : {}),
    completedAt: result.completedAt ?? new Date().toISOString(),
  };
}

export function durationBetween(startedAt: string, completedAt?: string): number | undefined {
  if (!completedAt) return undefined;
  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(completedAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined;
  return endMs - startMs;
}
function isDebugSelfReview(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.DEBUG_SELF_REVIEW ?? '');
}

export function debugSelfReviewLog(message?: unknown, ...optionalParams: unknown[]): void {
  if (isDebugSelfReview()) console.log(message, ...optionalParams);
}

export async function killSelfReviewWindow(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
  reason: string,
): Promise<void> {
  const target = `${session}:${REVIEW_WINDOW}`;
  const exists = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `list-panes -t ${shellQuote(target)} -F '#{pane_index}' 2>/dev/null | head -1`,
    ),
  );
  if (exists.exitCode !== 0 || !exists.stdout.trim()) {
    debugSelfReviewLog(`[self-review] ${reason}: no existing ${target} window`);
    return;
  }
  const killed = await execOnSlot(
    vars,
    tmuxShellSnippet(`kill-window -t ${shellQuote(target)} 2>&1`),
  );
  if (killed.exitCode !== 0) {
    const message = `${killed.stderr}\n${killed.stdout}`;
    if (/can't find|can't find window|no such|not found/i.test(message)) {
      debugSelfReviewLog(`[self-review] ${reason}: ${target} disappeared before cleanup completed`);
      return;
    }
    throw new Error(
      `Failed to kill self-review window ${target}: ${killed.stderr || killed.stdout || `exit ${killed.exitCode}`}`,
    );
  }
  debugSelfReviewLog(`[self-review] ${reason}: killed ${target}`);
}

export async function removeSlotFiles(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  absolutePaths: string[],
): Promise<void> {
  const result = await execOnSlot(
    vars,
    `rm -f ${absolutePaths.map(shellQuote).join(' ')} 2>/dev/null`,
    vars.remoteRepo,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to remove stale self-review files: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
}

export async function readOptionalSlotFile(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  absolutePath: string,
): Promise<string> {
  const result = await execOnSlot(vars, `cat ${shellQuote(absolutePath)} 2>/dev/null`);
  return result.exitCode === 0 ? result.stdout.trim() : '';
}

export async function bestEffortListRunnerSessionFiles(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
): Promise<{ paths: string[]; error?: string }> {
  try {
    return { paths: await listRunnerSessionFiles(vars, runner) };
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[self-review] optional ${runner} session pre-scan failed: ${message}`);
    return { paths: [], error: message };
  }
}

export async function bestEffortCaptureRunnerSessionMetadata(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  beforePaths: string[],
  preScanError?: string,
): Promise<ReviewSessionMeta> {
  if (preScanError) {
    return { runnerSessionPath: null, runnerSessionId: null, error: preScanError };
  }
  try {
    return await captureRunnerSessionMetadata(vars, runner, beforePaths);
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[self-review] optional ${runner} session metadata capture failed: ${message}`);
    return { runnerSessionPath: null, runnerSessionId: null, error: message };
  }
}

export async function waitForSessionTranscriptToSettle(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runnerSessionPath: string | null,
): Promise<void> {
  if (!runnerSessionPath) return;
  let previous = '';
  let stableReads = 0;
  const statCommand = `if [ -f ${shellQuote(runnerSessionPath)} ]; then (stat -f '%m:%z' ${shellQuote(runnerSessionPath)} 2>/dev/null || stat -c '%Y:%s' ${shellQuote(runnerSessionPath)} 2>/dev/null); fi`;
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    let current = '';
    try {
      const result = await execOnSlot(vars, statCommand, { timeout: 5_000 });
      current = result.exitCode === 0 ? result.stdout.trim() : '';
    } catch (err) {
      console.warn(
        `[self-review] optional session transcript settle check failed: ${(err as Error).message}`,
      );
      return;
    }
    if (current && current === previous) {
      stableReads += 1;
      if (stableReads >= 2) return;
    } else {
      stableReads = 0;
      previous = current;
    }
  }
}
