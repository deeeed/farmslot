// branch-freshness.ts — Early behind-main + merge-tree conflict probe for
// human-gate rework and ready-gate soft chips. Non-destructive: never rebases
// or force-pushes; only reports counts/conflict state and operator-facing hints.

import type { SlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import {
  type MergeMainStrategy,
  resolveMergeMainStrategy,
} from '../methods/slot/slot-tracking.js';

/** Soft-gate fields exposed on ready-gate / package-refresh summaries. */
export interface BranchFreshnessSummary {
  /** Commits HEAD is behind origin/<defaultBranch> (`git rev-list --count HEAD..origin/<branch>`). */
  behindMain: number;
  /** Commits HEAD is ahead of origin/<defaultBranch> (`git rev-list --count origin/<branch>..HEAD`). */
  aheadMain: number;
  /** True when a non-destructive merge-tree probe reports conflicts with origin/<defaultBranch>. */
  mergeConflicts: boolean;
  /** Sample of conflicted paths (capped) for operator copy. */
  mergeConflictPaths: string[];
  defaultBranch: string;
  /** Slot HEAD SHA when the probe ran (optional; filled by the combined ready-gate probe). */
  headSha?: string;
  /**
   * Operator-facing next command: prefer merge during open review loops;
   * rebase only when the project already standardizes on it.
   */
  hint: string;
}

/** @deprecated Prefer {@link MergeMainStrategy} from slot-tracking — kept as an alias for call sites. */
export type BranchUpdateStrategy = MergeMainStrategy;

const CONFLICT_PATH_CAP = 8;

/** Parse `git rev-list --count` stdout into a non-negative integer. */
export function parseRevListCount(stdout: string): number {
  const n = Number.parseInt(String(stdout ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Extract conflicted path samples from `git merge-tree --write-tree --name-only`
 * stdout (CONFLICT lines + bare name-only paths). Does **not** decide conflict
 * status — that comes from the merge-tree exit code (1 = conflict).
 */
export function parseMergeTreeConflictPaths(mergeTreeOutput: string): string[] {
  const text = String(mergeTreeOutput ?? '');
  const paths = new Set<string>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const conflict = trimmed.match(/^CONFLICT \([^)]+\):\s*(.+)$/i);
    if (conflict) {
      const rest = conflict[1];
      const inPath = rest.match(/\bin\s+(\S+)\s*$/i);
      if (inPath) paths.add(inPath[1].replace(/[.,;:]+$/, ''));
      continue;
    }

    // Skip tree OIDs, auto-merge chatter, and classic marker noise.
    if (/^[0-9a-f]{40}$/i.test(trimmed)) continue;
    if (/^Auto-merging\b/i.test(trimmed)) continue;
    if (/^(<<<<<<<|=======|>>>>>>>)/.test(trimmed)) continue;
    if (/^\+?(<<<<<<<|=======|>>>>>>>)/.test(trimmed)) continue;

    // name-only path lines: "f.txt" or "apps/foo/bar.ts" (must look like a path).
    // Skip bare words like "merged" from classic merge-tree chatter.
    if (
      /^[A-Za-z0-9_./@+-]+$/.test(trimmed) &&
      !trimmed.startsWith('-') &&
      (trimmed.includes('/') || trimmed.includes('.'))
    ) {
      paths.add(trimmed);
    }
  }

  return [...paths].slice(0, CONFLICT_PATH_CAP);
}

/**
 * @deprecated Prefer exit-status-driven detection via {@link parseBranchFreshnessProbeOutput}.
 * Kept for tests that only exercise path extraction from CONFLICT lines.
 */
export function parseMergeTreeConflicts(mergeTreeOutput: string): {
  mergeConflicts: boolean;
  paths: string[];
} {
  const paths = parseMergeTreeConflictPaths(mergeTreeOutput);
  // Structured CONFLICT (content|add/add|…): lines only — never free-text "conflict".
  const hasStructuredConflict = /^CONFLICT \([^)]+\):/m.test(String(mergeTreeOutput ?? ''));
  return { mergeConflicts: hasStructuredConflict || paths.length > 0, paths };
}

/** Build operator-facing copy: behind count, optional paths, next git command. */
export function formatBranchFreshnessHint(params: {
  behindMain: number;
  mergeConflicts: boolean;
  mergeConflictPaths?: readonly string[];
  defaultBranch: string;
  strategy?: MergeMainStrategy;
}): string {
  const branch = params.defaultBranch || 'main';
  const strategy: MergeMainStrategy = params.strategy === 'rebase' ? 'rebase' : 'merge';
  const paths =
    params.mergeConflictPaths && params.mergeConflictPaths.length
      ? ` Conflict paths (sample): ${params.mergeConflictPaths.join(', ')}.`
      : '';

  if (!params.mergeConflicts && params.behindMain <= 0) {
    return `Branch is up to date with origin/${branch} (behindMain: 0, mergeConflicts: false).`;
  }

  const status = `behindMain: ${params.behindMain}, mergeConflicts: ${params.mergeConflicts}.${paths}`;
  if (strategy === 'rebase') {
    return (
      `${status} Next: \`git fetch origin ${branch} && git rebase origin/${branch}\` ` +
      `(force-with-lease only when the project already standardizes on rebase — never auto mid-loop).`
    );
  }
  return (
    `${status} Next: \`git fetch origin ${branch} && git merge origin/${branch}\` ` +
    `(prefer merge into the feature branch during open review loops).`
  );
}

/**
 * Build a non-destructive probe script (fetch + rev-list counts + merge-tree
 * --write-tree --name-only). Conflict detection keys off merge-tree exit status
 * (1 = conflict). Never rebases or pushes.
 */
export function buildBranchFreshnessProbeScript(
  repoPath: string,
  defaultBranch: string,
): string {
  const branch = sanitizeDefaultBranch(defaultBranch);
  const repo = shellQuote(repoPath);
  return [
    'set +e',
    `git -C ${repo} fetch origin ${branch} --quiet 2>/dev/null`,
    `head=$(git -C ${repo} rev-parse HEAD 2>/dev/null)`,
    `behind=$(git -C ${repo} rev-list --count "HEAD..origin/${branch}" 2>/dev/null || echo 0)`,
    `ahead=$(git -C ${repo} rev-list --count "origin/${branch}..HEAD" 2>/dev/null || echo 0)`,
    // --write-tree: exit 0 clean, exit 1 conflicts. --name-only lists conflict paths.
    `mt_out=$(git -C ${repo} merge-tree --write-tree --name-only HEAD "origin/${branch}" 2>&1)`,
    'mt_rc=$?',
    'printf "HEAD:%s\\n" "${head:-}"',
    'printf "BEHIND:%s\\n" "${behind:-0}"',
    'printf "AHEAD:%s\\n" "${ahead:-0}"',
    'printf "CONFLICT_EXIT:%s\\n" "${mt_rc:-1}"',
    'printf "TREE_BEGIN\\n"',
    'printf "%s\\n" "$mt_out"',
    'printf "TREE_END\\n"',
  ].join('\n');
}

export function sanitizeDefaultBranch(raw: string | null | undefined): string {
  const candidate = String(raw ?? 'main').trim() || 'main';
  // Only allow typical branch name characters so the token is safe in shell refs.
  if (!/^[A-Za-z0-9._/-]+$/.test(candidate)) return 'main';
  return candidate;
}

/** Parse combined probe stdout produced by {@link buildBranchFreshnessProbeScript}. */
export function parseBranchFreshnessProbeOutput(
  stdout: string,
  defaultBranch: string,
  strategy: MergeMainStrategy = 'merge',
): BranchFreshnessSummary {
  const branch = sanitizeDefaultBranch(defaultBranch);
  const text = String(stdout ?? '');
  const headMatch = text.match(/^HEAD:([0-9a-f]{7,40})?\s*$/im);
  const behindMatch = text.match(/^BEHIND:(\d+)\s*$/m);
  const aheadMatch = text.match(/^AHEAD:(\d+)\s*$/m);
  const conflictExitMatch = text.match(/^CONFLICT_EXIT:(\d+)\s*$/m);
  const behindMain = behindMatch ? parseRevListCount(behindMatch[1]) : 0;
  const aheadMain = aheadMatch ? parseRevListCount(aheadMatch[1]) : 0;
  // merge-tree --write-tree: 0 = clean, 1 = conflicts. Missing marker → fail closed (unknown).
  const conflictExit = conflictExitMatch ? Number.parseInt(conflictExitMatch[1], 10) : 0;
  const mergeConflicts = conflictExit === 1;

  let tree = '';
  const begin = text.indexOf('TREE_BEGIN');
  const end = text.indexOf('TREE_END');
  if (begin >= 0 && end > begin) {
    tree = text.slice(begin + 'TREE_BEGIN'.length, end).replace(/^\n/, '');
  }

  const paths = parseMergeTreeConflictPaths(tree);
  const headSha = headMatch?.[1] && /^[0-9a-f]{7,40}$/i.test(headMatch[1]) ? headMatch[1] : undefined;
  const hint = formatBranchFreshnessHint({
    behindMain,
    mergeConflicts,
    mergeConflictPaths: paths,
    defaultBranch: branch,
    strategy,
  });
  return {
    behindMain,
    aheadMain,
    mergeConflicts,
    mergeConflictPaths: paths,
    defaultBranch: branch,
    ...(headSha ? { headSha } : {}),
    hint,
  };
}

/**
 * Run the non-destructive probe on a slot worktree. Returns null when the slot
 * cannot be probed (no slot vars / exec failure) so callers can soft-omit fields.
 */
export async function probeSlotBranchFreshness(
  vars: SlotVars,
  defaultBranch: string,
  strategy: MergeMainStrategy = 'merge',
): Promise<BranchFreshnessSummary | null> {
  if (!vars.remoteRepo) return null;
  const branch = sanitizeDefaultBranch(defaultBranch);
  const script = buildBranchFreshnessProbeScript(vars.remoteRepo, branch);
  try {
    const result = await execOnSlot(vars, script, { timeout: 45_000 });
    // Even non-zero exit may still carry markers after set +e.
    if (!result.stdout.includes('BEHIND:') || !result.stdout.includes('CONFLICT_EXIT:')) {
      console.warn(
        `[run-engine] branch-freshness probe produced incomplete markers for ${vars.remoteRepo}: exit=${result.exitCode}`,
      );
      return null;
    }
    return parseBranchFreshnessProbeOutput(result.stdout, branch, strategy);
  } catch (err) {
    console.warn(
      `[run-engine] branch-freshness probe failed for ${vars.remoteRepo}: ${(err as Error).message.slice(0, 200)}`,
    );
    return null;
  }
}

/** Prefer project merge_main_strategy when set; default merge for open review loops. */
export function resolveBranchUpdateStrategy(
  projectJson: unknown,
): MergeMainStrategy {
  // Reuse the slot-tracking helper (same key, same default) — do not re-roll the in-check.
  return resolveMergeMainStrategy(
    (projectJson && typeof projectJson === 'object' ? projectJson : {}) as Parameters<
      typeof resolveMergeMainStrategy
    >[0],
  );
}
