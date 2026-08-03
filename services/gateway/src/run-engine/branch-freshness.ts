// branch-freshness.ts — Early behind-main + merge-tree conflict probe for
// human-gate rework and ready-gate soft chips. Non-destructive: never rebases
// or force-pushes; only reports counts/conflict state and operator-facing hints.

import type { SlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';

/** Soft-gate fields exposed on ready-gate / package-refresh summaries. */
export interface BranchFreshnessSummary {
  /** Commits HEAD is behind origin/<defaultBranch> (`git rev-list --count HEAD..origin/<branch>`). */
  behindMain: number;
  /** True when a non-destructive merge-tree probe reports conflicts with origin/<defaultBranch>. */
  mergeConflicts: boolean;
  /** Sample of conflicted paths (capped) for operator copy. */
  mergeConflictPaths: string[];
  defaultBranch: string;
  /**
   * Operator-facing next command: prefer merge during open review loops;
   * rebase only when the project already standardizes on it.
   */
  hint: string;
}

export type BranchUpdateStrategy = 'merge' | 'rebase';

const CONFLICT_PATH_CAP = 8;

/** Parse `git rev-list --count` stdout into a non-negative integer. */
export function parseRevListCount(stdout: string): number {
  const n = Number.parseInt(String(stdout ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Detect conflicts from classic `git merge-tree <base> <ours> <theirs>` output.
 * Looks for conflict markers and "CONFLICT (...)" lines; collects path samples.
 */
export function parseMergeTreeConflicts(mergeTreeOutput: string): {
  mergeConflicts: boolean;
  paths: string[];
} {
  const text = String(mergeTreeOutput ?? '');
  const paths = new Set<string>();

  const hasMarkers = /^(<<<<<<<|=======|>>>>>>>)/m.test(text);

  for (const line of text.split('\n')) {
    const conflict = line.match(/^CONFLICT \([^)]+\):\s*(.+)$/i);
    if (conflict) {
      const rest = conflict[1];
      // Common forms: "Merge conflict in path", "path added in both", etc.
      const inPath = rest.match(/\bin\s+(\S+)\s*$/i);
      if (inPath) paths.add(inPath[1].replace(/[.,;:]+$/, ''));
      else {
        const token = rest.match(/(\S+\.\w[\w.]*)/);
        if (token) paths.add(token[1]);
      }
      continue;
    }
    // merge-tree may emit "changed in both" style headers with path tokens.
    const both = line.match(/changed in both\s+(\S+)/i);
    if (both) paths.add(both[1]);
  }

  const mergeConflicts = hasMarkers || paths.size > 0 || /\bCONFLICT\b/i.test(text);
  return {
    mergeConflicts,
    paths: [...paths].slice(0, CONFLICT_PATH_CAP),
  };
}

/** Build operator-facing copy: behind count, optional paths, next git command. */
export function formatBranchFreshnessHint(params: {
  behindMain: number;
  mergeConflicts: boolean;
  mergeConflictPaths?: readonly string[];
  defaultBranch: string;
  strategy?: BranchUpdateStrategy;
}): string {
  const branch = params.defaultBranch || 'main';
  const strategy: BranchUpdateStrategy = params.strategy === 'rebase' ? 'rebase' : 'merge';
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
 * Build a non-destructive probe script (fetch + rev-list count + merge-tree).
 * Default branch is sanitized to safe ref characters before interpolation.
 * Output markers keep parsing stable across shells. Never rebases or pushes.
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
    `behind=$(git -C ${repo} rev-list --count "HEAD..origin/${branch}" 2>/dev/null || echo 0)`,
    `base=$(git -C ${repo} merge-base HEAD "origin/${branch}" 2>/dev/null)`,
    'tree=""',
    'if [ -n "$base" ]; then',
    `  tree=$(git -C ${repo} merge-tree "$base" HEAD "origin/${branch}" 2>/dev/null)`,
    'fi',
    'printf "BEHIND:%s\\n" "${behind:-0}"',
    'printf "TREE_BEGIN\\n"',
    'printf "%s\\n" "$tree"',
    'printf "TREE_END\\n"',
  ].join('\n');
}

export function sanitizeDefaultBranch(raw: string | null | undefined): string {
  const candidate = String(raw ?? 'main').trim() || 'main';
  // Only allow typical branch name characters so the token is safe in shell refs.
  if (!/^[A-Za-z0-9._/-]+$/.test(candidate)) return 'main';
  return candidate;
}

/** Parse combined probe stdout produced by {@link buildBranchFreshnessProbeScriptSafe}. */
export function parseBranchFreshnessProbeOutput(
  stdout: string,
  defaultBranch: string,
  strategy: BranchUpdateStrategy = 'merge',
): BranchFreshnessSummary {
  const branch = sanitizeDefaultBranch(defaultBranch);
  const text = String(stdout ?? '');
  const behindMatch = text.match(/^BEHIND:(\d+)\s*$/m);
  const behindMain = behindMatch ? parseRevListCount(behindMatch[1]) : 0;

  let tree = '';
  const begin = text.indexOf('TREE_BEGIN');
  const end = text.indexOf('TREE_END');
  if (begin >= 0 && end > begin) {
    tree = text.slice(begin + 'TREE_BEGIN'.length, end).replace(/^\n/, '');
  }

  const { mergeConflicts, paths } = parseMergeTreeConflicts(tree);
  const hint = formatBranchFreshnessHint({
    behindMain,
    mergeConflicts,
    mergeConflictPaths: paths,
    defaultBranch: branch,
    strategy,
  });
  return {
    behindMain,
    mergeConflicts,
    mergeConflictPaths: paths,
    defaultBranch: branch,
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
  strategy: BranchUpdateStrategy = 'merge',
): Promise<BranchFreshnessSummary | null> {
  if (!vars.remoteRepo) return null;
  const branch = sanitizeDefaultBranch(defaultBranch);
  const script = buildBranchFreshnessProbeScript(vars.remoteRepo, branch);
  try {
    const result = await execOnSlot(vars, script, { timeout: 45_000 });
    // Even non-zero exit may still carry BEHIND/TREE markers after set +e.
    if (!result.stdout.includes('BEHIND:')) {
      console.warn(
        `[run-engine] branch-freshness probe produced no BEHIND marker for ${vars.remoteRepo}: exit=${result.exitCode}`,
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
): BranchUpdateStrategy {
  const field =
    projectJson &&
    typeof projectJson === 'object' &&
    'merge_main_strategy' in projectJson
      ? (projectJson as { merge_main_strategy?: unknown }).merge_main_strategy
      : undefined;
  return field === 'rebase' ? 'rebase' : 'merge';
}
