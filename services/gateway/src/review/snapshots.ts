import { GIT_DIFF_COMMAND } from '@farmslot/agent-runtime/scripts/git-diff.cjs';
import {
  agentRoleWindow,
  DEFAULT_BRANCH,
  isReviewerWindowName,
  type ReviewAttempt,
  reviewDiffHash,
  type ReviewDiffSnapshot,
  type ReviewFixDeltaSnapshot,
  type ReviewMode,
  reviewSnapshotIdentityText,
} from '@farmslot/protocol';
import { resolveReviewMode, reviewArtifactDir } from '@farmslot/review-dispatch';

import { getProjectField, loadProjectVars, loadSlotVars } from '../core/config.js';
import { execOnSlot, type ExecResult } from '../core/exec.js';
import { shellQuote, tmuxShellSnippet } from '../core/tmux.js';
import {
  writeLargeTextFileOnSlot,
  writeTextFileOnSlot,
} from '../methods/dispatch/slot-file-write.js';
import { refreshRemoteBaseRef } from '../methods/git.js';
import {
  cappedRunSourceDiffCommand,
  parseGitNumstat,
  projectSourceDiffPathspecs,
  runSourceDiffNumstatCommand,
  runSourceDiffUntrackedManifestCommand,
} from '../run-engine/diff-artifacts.js';
import {
  captureRunnerSessionMetadata,
  listRunnerSessionFiles,
} from '../runners/session-process.js';

import type { ReviewAgentResult } from './review-agent.js';

const REVIEW_WINDOW = agentRoleWindow('review') ?? 'review';
const REVIEW_DIFF_MAX_BUFFER = 5 * 1024 * 1024;

export type ReviewSessionMeta = {
  runnerSessionPath: string | null;
  runnerSessionId: string | null;
  error?: string;
};

type UntrackedReviewFile = NonNullable<ReviewDiffSnapshot['untrackedFiles']>[number];

export function parseUntrackedFileManifest(text: string): UntrackedReviewFile[] {
  if (!text) return [];
  const fields = text.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 3 !== 0) {
    throw new Error(`Invalid untracked review manifest field count: ${fields.length}`);
  }
  const files: UntrackedReviewFile[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const mode = fields[index] ?? '';
    const blobSha = fields[index + 1] ?? '';
    const filePath = fields[index + 2] ?? '';
    if (
      (mode !== '100644' && mode !== '100755' && mode !== '120000') ||
      !/^[0-9a-f]{40,64}$/i.test(blobSha) ||
      !filePath
    ) {
      throw new Error(`Invalid untracked review manifest entry at field ${index}`);
    }
    files.push({ path: filePath, blobSha, mode });
  }
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
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

export function parseReviewSnapshotArtifact(raw: string): ReviewDiffSnapshot | null {
  if (!raw.trim()) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const snapshot = value as Partial<ReviewDiffSnapshot>;
    if (
      (snapshot.source !== 'local-git' &&
        snapshot.source !== 'github-pr' &&
        snapshot.source !== 'unavailable') ||
      typeof snapshot.capturedAt !== 'string'
    ) {
      return null;
    }
    if (
      snapshot.source === 'local-git' &&
      (typeof snapshot.headSha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(snapshot.headSha))
    ) {
      return null;
    }
    return snapshot as ReviewDiffSnapshot;
  } catch {
    return null;
  }
}

export async function readPersistedReviewSnapshot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  loopNumber: number,
  artifactScope?: string | null,
): Promise<{ snapshot: ReviewDiffSnapshot; artifactPaths: string[] } | null> {
  const artifactDir = reviewArtifactDir(loopNumber, artifactScope);
  const statRel = `${artifactDir}/review-diff-stat.json`;
  const result = await execOnSlot(vars, `cat ${shellQuote(`${taskDir}/${statRel}`)} 2>/dev/null`, {
    timeout: 10_000,
  });
  if (result.exitCode !== 0) return null;
  const snapshot = parseReviewSnapshotArtifact(result.stdout);
  if (!snapshot) return null;
  return {
    snapshot,
    artifactPaths: [...(snapshot.diffPath ? [snapshot.diffPath] : []), statRel],
  };
}

export function preferredRemoteReviewBaseRef(baseRef: string): string | null {
  const normalized = baseRef.trim() || DEFAULT_BRANCH;
  if (normalized.startsWith('refs/')) return null;
  if (normalized.startsWith('origin/')) return normalized;
  return `origin/${normalized}`;
}

async function resolveReviewPathspecs(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
): Promise<{ configuredBaseRef: string; pathspecs: string[] }> {
  let configuredBaseRef: string = DEFAULT_BRANCH;
  let pathspecs = projectSourceDiffPathspecs(null);
  try {
    const pv = await loadProjectVars(vars.projectName);
    configuredBaseRef = getProjectField(pv.projectJson, 'default_branch') || DEFAULT_BRANCH;
    pathspecs = projectSourceDiffPathspecs(pv.projectJson);
  } catch (err) {
    debugReviewLog(
      `[review] defaulting review base ref to ${DEFAULT_BRANCH} after project lookup failed: ${(err as Error).message}`,
    );
  }
  return { configuredBaseRef, pathspecs };
}

async function resolveReviewContext(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  requestedBaseRef?: string,
): Promise<{ baseRef: string; pathspecs: string[] }> {
  const configured = await resolveReviewPathspecs(vars);
  const configuredBaseRef = requestedBaseRef ?? configured.configuredBaseRef;
  const pathspecs = configured.pathspecs;
  const remoteBaseRef = preferredRemoteReviewBaseRef(configuredBaseRef);
  if (!remoteBaseRef) return { baseRef: configuredBaseRef, pathspecs };
  const branch = remoteBaseRef.slice('origin/'.length);
  try {
    await refreshRemoteBaseRef(vars.slotId, remoteBaseRef);
  } catch (err) {
    // Offline slots may still have a valid remote-tracking or local base ref.
    debugReviewLog(
      `[review] base refresh failed for ${vars.slotId}/${remoteBaseRef}: ${(err as Error).message}`,
    );
  }
  const remoteAvailable = await execOnSlot(
    vars,
    `git rev-parse --verify ${shellQuote(remoteBaseRef)} 2>/dev/null`,
    { timeout: 10_000 },
  );
  if (remoteAvailable.exitCode === 0) return { baseRef: remoteBaseRef, pathspecs };
  const localAvailable = await execOnSlot(
    vars,
    `git rev-parse --verify ${shellQuote(branch)} 2>/dev/null`,
    { timeout: 10_000 },
  );
  if (localAvailable.exitCode === 0) return { baseRef: branch, pathspecs };
  throw new Error(`review base ${remoteBaseRef} is unavailable after refresh`);
}

export interface FrozenReviewContribution {
  snapshot: ReviewDiffSnapshot;
  diffText: string;
}

export interface ReviewSnapshotRange {
  /** Omit mode to override only the base, retaining source filters and untracked identity. */
  mode?: ReviewMode;
  lastReviewedHeadSha?: string;
  baseRef?: string;
  committedBaseSha?: string;
  committedHeadSha?: string;
  frozenContribution?: FrozenReviewContribution;
}

interface ReviewSnapshotDependencies {
  resolveContext: typeof resolveReviewContext;
  exec: typeof execOnSlot;
}

export async function captureCurrentReviewSnapshot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  range?: ReviewSnapshotRange,
  deps: ReviewSnapshotDependencies = { resolveContext: resolveReviewContext, exec: execOnSlot },
): Promise<{ snapshot: ReviewDiffSnapshot; diffText?: string }> {
  if (range?.frozenContribution) return range.frozenContribution;
  try {
    const pinned = range?.committedBaseSha && range?.committedHeadSha;
    const immutableRange = range?.mode !== undefined || !!pinned;
    if (!!range?.committedBaseSha !== !!range?.committedHeadSha)
      throw new Error('Both committed range endpoints are required');
    const { baseRef, pathspecs } = pinned
      ? { baseRef: range!.baseRef ?? range!.committedBaseSha!, pathspecs: ['.'] }
      : await deps.resolveContext(vars, range?.baseRef);
    const headResult = pinned
      ? { exitCode: 0, stdout: range!.committedHeadSha!, stderr: '' }
      : await deps.exec(vars, 'git rev-parse HEAD', { timeout: 10_000 });
    if (headResult.exitCode !== 0) {
      return {
        snapshot: unavailableReviewSnapshot(
          'head-ref-unavailable',
          headResult.stderr || headResult.stdout,
        ),
      };
    }
    const baseResult = pinned
      ? { exitCode: 0, stdout: range!.committedBaseSha!, stderr: '' }
      : await deps.exec(
          vars,
          `git merge-base ${shellQuote(baseRef)} HEAD 2>/dev/null || git rev-parse --verify ${shellQuote(baseRef)} 2>/dev/null`,
          { timeout: 10_000 },
        );
    if (baseResult.exitCode !== 0) {
      return {
        snapshot: unavailableReviewSnapshot(
          'base-ref-unavailable',
          baseResult.stderr || baseResult.stdout,
        ),
      };
    }
    const branchResult = await deps.exec(
      vars,
      'git rev-parse --abbrev-ref HEAD 2>/dev/null || true',
      { timeout: 10_000 },
    );
    const headSha = headResult.stdout.trim();
    const baseSha =
      range?.mode === 'warm'
        ? range.lastReviewedHeadSha
        : (baseResult.stdout.trim().split('\n').at(-1)?.trim() ?? '');
    if (!baseSha || !/^[0-9a-f]{7,40}$/i.test(baseSha) || !/^[0-9a-f]{7,40}$/i.test(headSha))
      throw new Error('Review range requires valid immutable commit SHAs');
    if (range?.mode === 'warm') {
      const ancestor = await deps.exec(
        vars,
        `git merge-base --is-ancestor ${shellQuote(baseSha)} ${shellQuote(headSha)}`,
        { timeout: 10_000 },
      );
      if (ancestor.exitCode !== 0)
        throw new Error('Last reviewed head is not an ancestor of the current PR head');
    }
    // Every snapshot covers the complete committed PR diff, so a package and the
    // COLD/WARM reviews of its HEAD fingerprint the same change.
    const capturedRange = `${shellQuote(baseSha)} ${shellQuote(headSha)} -- ${shellQuote('.')}`;
    const committedNumstat = await deps.exec(
      vars,
      `${GIT_DIFF_COMMAND} --numstat ${capturedRange}`,
      { timeout: 10_000 },
    );
    const uncommittedNumstat = immutableRange
      ? { exitCode: 0, stdout: '', stderr: '' }
      : await deps.exec(vars, runSourceDiffNumstatCommand(headSha, pathspecs), {
          timeout: 10_000,
        });
    for (const numstat of [committedNumstat, uncommittedNumstat])
      if (numstat.exitCode !== 0)
        return {
          snapshot: unavailableReviewSnapshot(
            'git-numstat-failed',
            numstat.stderr || numstat.stdout,
          ),
        };
    const numstat = { stdout: committedNumstat.stdout + uncommittedNumstat.stdout };
    const diffFailure = (result: ExecResult) =>
      unavailableReviewSnapshot(
        /maxBuffer exceeded/i.test(result.stderr) ? 'diff-artifact-too-large' : 'git-diff-failed',
        result.stderr || result.stdout,
      );
    const committed = await deps.exec(vars, `${GIT_DIFF_COMMAND} ${capturedRange}`, {
      timeout: 30_000,
      maxBuffer: REVIEW_DIFF_MAX_BUFFER,
    });
    if (committed.exitCode !== 0) return { snapshot: diffFailure(committed) };
    // A package also carries its uncommitted and untracked source edits, which no
    // review certified, so a dirty worktree never matches a review of HEAD.
    const uncommitted = immutableRange
      ? { exitCode: 0, stdout: '', stderr: '' }
      : await deps.exec(vars, cappedRunSourceDiffCommand(headSha, pathspecs), {
          timeout: 30_000,
          maxBuffer: REVIEW_DIFF_MAX_BUFFER,
        });
    if (uncommitted.exitCode !== 0) return { snapshot: diffFailure(uncommitted) };
    const diff = { stdout: committed.stdout + uncommitted.stdout };
    const untrackedManifest = immutableRange
      ? { exitCode: 0, stdout: '', stderr: '' }
      : await deps.exec(vars, runSourceDiffUntrackedManifestCommand(pathspecs), {
          timeout: 10_000,
        });
    if (untrackedManifest.exitCode !== 0) {
      return {
        snapshot: unavailableReviewSnapshot(
          'git-untracked-manifest-failed',
          untrackedManifest.stderr || untrackedManifest.stdout,
        ),
      };
    }
    const untrackedFiles = parseUntrackedFileManifest(untrackedManifest.stdout);
    const reviewDiffIdentity = reviewSnapshotIdentityText(diff.stdout, untrackedFiles);
    return {
      snapshot: {
        source: 'local-git',
        baseRef,
        baseSha,
        headRef: branchResult.stdout.trim() || null,
        headSha: headResult.stdout.trim(),
        diffHash: reviewDiffHash(reviewDiffIdentity),
        diffStat: parseGitNumstat(numstat.stdout),
        ...(untrackedFiles.length > 0 ? { untrackedFiles } : {}),
        capturedAt: new Date().toISOString(),
      },
      // Keep review.diff valid for diff2html/git tooling. The untracked
      // identity manifest participates in diffHash and lives structurally in
      // the snapshot, not as non-diff trailer text.
      diffText: diff.stdout,
    };
  } catch (err) {
    return {
      snapshot: unavailableReviewSnapshot('slot-exec-error', (err as Error).message),
    };
  }
}

export async function captureReviewSnapshot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  loopNumber: number,
  artifactScope?: string | null,
  range?: ReviewSnapshotRange,
): Promise<{ snapshot: ReviewDiffSnapshot; artifactPaths: string[] }> {
  const artifactDir = reviewArtifactDir(loopNumber, artifactScope);
  const diffRel = `${artifactDir}/review.diff`;
  const statRel = `${artifactDir}/review-diff-stat.json`;
  try {
    const captured = await captureCurrentReviewSnapshot(vars, range);
    const snapshot: ReviewDiffSnapshot = {
      ...captured.snapshot,
      ...(captured.diffText !== undefined ? { diffPath: diffRel } : {}),
    };
    if (captured.diffText !== undefined) {
      await writeLargeTextFileOnSlot(vars, `${taskDir}/${diffRel}`, captured.diffText);
    }
    await writeTextFileOnSlot(vars, `${taskDir}/${statRel}`, JSON.stringify(snapshot, null, 2));
    return {
      snapshot,
      artifactPaths: [...(captured.diffText !== undefined ? [diffRel] : []), statRel],
    };
  } catch (err) {
    const snapshot = unavailableReviewSnapshot('slot-exec-error', (err as Error).message);
    try {
      await writeTextFileOnSlot(vars, `${taskDir}/${statRel}`, JSON.stringify(snapshot, null, 2));
      return { snapshot, artifactPaths: [statRel] };
    } catch (writeErr) {
      debugReviewLog(
        `[review] failed to persist unavailable review snapshot: ${(writeErr as Error).message}`,
      );
      return { snapshot, artifactPaths: [] };
    }
  }
}

/** A lineage's change since its last reviewed head (ADR-063 Amendment 5). */
export interface ReviewDelta {
  /** `last..head`; after a rebase, the two `mergeBase..head` ranges `git range-diff` compared. */
  comparedRanges: string[];
  /** The `git range-diff` output, present only after a rebase. */
  rangeDiff?: string;
}

/**
 * The delta a re-review checks. While the current head descends from the reviewed head it is
 * `last..head`. After a rebase it compares the branch's own change at both heads, each against
 * its merge-base with the base branch, so changes that came only from the base are left out.
 */
export async function reviewDeltaSinceReviewedHead(
  exec: (command: string) => Promise<ExecResult>,
  params: { lastReviewedHeadSha: string; headSha: string; baseRef: string },
): Promise<ReviewDelta> {
  const { lastReviewedHeadSha: last, headSha: head, baseRef } = params;
  if (
    (await exec(`git merge-base --is-ancestor ${shellQuote(last)} ${shellQuote(head)}`))
      .exitCode === 0
  )
    return { comparedRanges: [`${last}..${head}`] };
  const mergeBase = async (sha: string) => {
    const result = await exec(`git merge-base ${shellQuote(baseRef)} ${shellQuote(sha)}`);
    const base = result.stdout.trim();
    if (result.exitCode !== 0 || !/^[0-9a-f]{7,40}$/i.test(base))
      throw new Error(
        `${sha} has no merge-base with ${baseRef}: ${result.stderr || result.stdout}`,
      );
    return base;
  };
  const comparedRanges = [`${await mergeBase(last)}..${last}`, `${await mergeBase(head)}..${head}`];
  const rangeDiff = await exec(
    `git range-diff --no-color ${comparedRanges.map(shellQuote).join(' ')}`,
  );
  if (rangeDiff.exitCode !== 0)
    throw new Error(`git range-diff failed: ${rangeDiff.stderr || rangeDiff.stdout}`);
  return { comparedRanges, rangeDiff: rangeDiff.stdout };
}

/**
 * The delta-scoped COLD fallback's range: the immutable snapshot of the delta, plus the
 * range-diff after a rebase. A delta that can't be computed reviews the branch's whole
 * change, and says so.
 */
export async function captureReviewDeltaSnapshot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  loopNumber: number,
  artifactScope: string | null | undefined,
  range: { lastReviewedHeadSha: string; baseRef?: string },
): Promise<{
  snapshot: ReviewDiffSnapshot;
  artifactPaths: string[];
  comparedRanges: string[];
  rangeDiffPath?: string;
  deltaUnavailable?: string;
}> {
  const exec = (command: string) =>
    execOnSlot(vars, command, { timeout: 30_000, maxBuffer: REVIEW_DIFF_MAX_BUFFER });
  const head = await exec('git rev-parse HEAD');
  const headSha = head.stdout.trim();
  if (head.exitCode !== 0 || !/^[0-9a-f]{7,40}$/i.test(headSha))
    throw new Error(`Review head is unavailable: ${head.stderr || head.stdout}`);
  const { baseRef } = await resolveReviewContext(vars, range.baseRef);
  let delta: ReviewDelta;
  let deltaUnavailable: string | undefined;
  try {
    delta = await reviewDeltaSinceReviewedHead(exec, {
      lastReviewedHeadSha: range.lastReviewedHeadSha,
      headSha,
      baseRef,
    });
  } catch (error) {
    // The reviewed head left the repository: the fallback still runs, on the whole change.
    deltaUnavailable = (error as Error).message;
    const base = await exec(`git merge-base ${shellQuote(baseRef)} ${shellQuote(headSha)}`);
    if (base.exitCode !== 0) throw error;
    delta = { comparedRanges: [`${base.stdout.trim()}..${headSha}`] };
  }
  const current = delta.comparedRanges.at(-1)!;
  const captured = await captureReviewSnapshot(vars, taskDir, loopNumber, artifactScope, {
    baseRef: range.baseRef,
    committedBaseSha: current.slice(0, current.indexOf('..')),
    committedHeadSha: headSha,
  });
  if (delta.rangeDiff === undefined)
    return {
      ...captured,
      comparedRanges: delta.comparedRanges,
      ...(deltaUnavailable ? { deltaUnavailable } : {}),
    };
  const rangeDiffPath = `${reviewArtifactDir(loopNumber, artifactScope)}/review-range-diff.txt`;
  await writeLargeTextFileOnSlot(vars, `${taskDir}/${rangeDiffPath}`, delta.rangeDiff);
  return {
    ...captured,
    artifactPaths: [...captured.artifactPaths, rangeDiffPath],
    comparedRanges: delta.comparedRanges,
    rangeDiffPath,
  };
}

export async function captureFixDeltaSnapshot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  loopNumber: number,
  fixBaseSha: string | null,
  artifactScope?: string | null,
): Promise<{
  snapshot: ReviewFixDeltaSnapshot;
  artifactPaths: string[];
  sourceLinesChanged?: number;
}> {
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
    const { pathspecs } = await resolveReviewPathspecs(vars);
    // Use base-to-worktree, not base..HEAD, so a review fix pass that
    // leaves changes uncommitted still has a useful delta artifact.
    const numstat = await execOnSlot(vars, runSourceDiffNumstatCommand(fixBaseSha, pathspecs), {
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
    const diff = await execOnSlot(vars, cappedRunSourceDiffCommand(fixBaseSha, pathspecs), {
      timeout: 30_000,
      maxBuffer: REVIEW_DIFF_MAX_BUFFER,
    });
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
    const untrackedManifest = await execOnSlot(
      vars,
      runSourceDiffUntrackedManifestCommand(pathspecs),
      { timeout: 10_000 },
    );
    if (untrackedManifest.exitCode !== 0) {
      const snapshot: ReviewFixDeltaSnapshot = {
        ...unavailableReviewSnapshot(
          'git-untracked-manifest-failed',
          untrackedManifest.stderr || untrackedManifest.stdout,
        ),
        fixBaseSha,
        fixHeadSha,
      };
      await writeTextFileOnSlot(vars, `${taskDir}/${statRel}`, JSON.stringify(snapshot, null, 2));
      return { snapshot, artifactPaths: [statRel] };
    }
    const untrackedFiles = parseUntrackedFileManifest(untrackedManifest.stdout);
    const fixDiffIdentity = reviewSnapshotIdentityText(diff.stdout, untrackedFiles);
    const diffStat = parseGitNumstat(numstat.stdout);
    const snapshot: ReviewFixDeltaSnapshot = {
      source: 'local-git',
      baseSha: fixBaseSha,
      headSha: fixHeadSha,
      fixBaseSha,
      fixHeadSha,
      diffPath: diffRel,
      diffHash: reviewDiffHash(fixDiffIdentity),
      diffStat,
      ...(untrackedFiles.length > 0 ? { untrackedFiles } : {}),
      capturedAt: new Date().toISOString(),
    };
    await writeLargeTextFileOnSlot(vars, `${taskDir}/${diffRel}`, diff.stdout);
    await writeTextFileOnSlot(vars, `${taskDir}/${statRel}`, JSON.stringify(snapshot, null, 2));
    return {
      snapshot,
      artifactPaths: [diffRel, statRel],
      ...(untrackedFiles.length === 0 &&
      !numstat.stdout.split('\n').some((line) => line.startsWith('-\t-\t'))
        ? { sourceLinesChanged: diffStat.additions + diffStat.deletions }
        : {}),
    };
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
      debugReviewLog(
        `[review] failed to persist unavailable fix-delta snapshot: ${(writeErr as Error).message}`,
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
): ReviewAttempt {
  const effectiveFixDelta = fixDelta ?? result.fixDelta;
  const verdict = result.incomplete ? 'skipped' : result.verdict === 'pass' ? 'pass' : 'issues';
  return {
    mode: resolveReviewMode({ explicitMode: result.mode }),
    ...(result.session ? { session: result.session } : {}),
    loopNumber,
    verdict,
    unresolvedCount: verdict === 'issues' ? result.issues.length : 0,
    ...(result.issues.length ? { issues: result.issues } : {}),
    ...(result.validationDepth ? { validationDepth: result.validationDepth } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.checklistTiming ? { checklistTiming: result.checklistTiming } : {}),
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
function isDebugReview(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.DEBUG_REVIEW ?? '');
}

export function debugReviewLog(message?: unknown, ...optionalParams: unknown[]): void {
  if (isDebugReview()) console.log(message, ...optionalParams);
}

/** List tmux window ids for a specific reviewer tab, or all reviewer tabs when omitted. */
export function tmuxListReviewWindowIdsSnippet(
  session: string,
  windowName?: string | null,
): string {
  if (windowName?.trim()) {
    const name = windowName.trim();
    return `list-windows -t ${shellQuote(session)} -F '#{?#{==:#{window_name},${name}},#{window_id},}' 2>/dev/null | grep -E '^@' || true`;
  }
  // Match legacy review plus short rev-* / revN-* reviewer tabs.
  return `list-windows -t ${shellQuote(session)} -F '#{window_id}\t#{window_name}' 2>/dev/null | awk -F'\\t' '$2=="${REVIEW_WINDOW}" || $2 ~ /^rev[0-9]*-/ { print $1 }' || true`;
}

export async function killReviewWindow(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
  reason: string,
  windowName?: string | null,
): Promise<void> {
  const ids = await execOnSlot(
    vars,
    tmuxShellSnippet(tmuxListReviewWindowIdsSnippet(session, windowName)),
  );
  const windowIds = ids.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const label = windowName?.trim() || 'reviewer';
  if (ids.exitCode !== 0 || windowIds.length === 0) {
    debugReviewLog(`[review] ${reason}: no existing ${session}:${label} window`);
    return;
  }
  for (const windowId of windowIds) {
    const killed = await execOnSlot(
      vars,
      tmuxShellSnippet(`kill-window -t ${shellQuote(windowId)} 2>&1`),
    );
    if (killed.exitCode !== 0) {
      const message = `${killed.stderr}\n${killed.stdout}`;
      if (/can't find|can't find window|no such|not found/i.test(message)) {
        debugReviewLog(`[review] ${reason}: ${windowId} disappeared before cleanup completed`);
        continue;
      }
      throw new Error(
        `Failed to kill review window ${windowId}: ${killed.stderr || killed.stdout || `exit ${killed.exitCode}`}`,
      );
    }
  }
  debugReviewLog(`[review] ${reason}: killed ${windowIds.length} ${session}:${label} window(s)`);
}

/** True when a tmux window name is a reviewer tab (short rev-* or legacy review). */
export function isReviewerTmuxWindow(windowName: string | null | undefined): boolean {
  return isReviewerWindowName(windowName);
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
      `Failed to remove stale review files: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
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
    console.warn(`[review] optional ${runner} session pre-scan failed: ${message}`);
    return { paths: [], error: message };
  }
}

export async function bestEffortCaptureRunnerSessionMetadata(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  beforePaths: string[],
  preScanError?: string,
  options: {
    sinceMs?: number;
    paneId?: string | null;
  } = {},
): Promise<ReviewSessionMeta> {
  try {
    const captured = await captureRunnerSessionMetadata(vars, runner, beforePaths, options);
    if (!captured.runnerSessionId && !captured.runnerSessionPath && preScanError) {
      return { ...captured, error: preScanError };
    }
    return captured;
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[review] optional ${runner} session metadata capture failed: ${message}`);
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
        `[review] optional session transcript settle check failed: ${(err as Error).message}`,
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
