// branch-freshness.ts — Early behind-main + merge-tree conflict probe for
// human-gate rework and ready-gate soft chips. Non-destructive: never rebases
// or force-pushes; only reports counts/conflict state and operator-facing hints.
//
// Fail-closed: when origin/<branch> is missing or a count cannot be computed,
// fields are omitted (unknown) — never treated as ahead=0 or mergeConflicts=true.

import type { SlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import {
  type MergeMainStrategy,
  resolveMergeMainStrategy,
} from '../methods/slot/slot-tracking.js';

/** Soft-gate fields exposed on ready-gate / package-refresh summaries. */
export interface BranchFreshnessSummary {
  /**
   * Commits HEAD is behind origin/<defaultBranch>.
   * Omitted when the count could not be computed (ref missing / rev-list failed).
   */
  behindMain?: number;
  /**
   * Commits HEAD is ahead of origin/<defaultBranch>.
   * Omitted when unknown — callers must not treat missing as zero (close-as-shipped).
   */
  aheadMain?: number;
  /**
   * True/false only when merge-tree ran against a verified ref.
   * Omitted when the remote ref is missing or the probe is incomplete.
   */
  mergeConflicts?: boolean;
  /** Sample of conflicted paths (capped) for operator copy. */
  mergeConflictPaths: string[];
  defaultBranch: string;
  /** Slot HEAD SHA when the probe ran (optional). */
  headSha?: string;
  /** True when origin/<defaultBranch> resolved after fetch. */
  remoteRefOk: boolean;
  /**
   * Operator-facing next command / status. Prefer merge during open review loops;
   * rebase only when the project already standardizes on it.
   */
  hint: string;
}

const CONFLICT_PATH_CAP = 8;

/** Parse `git rev-list --count` stdout into a non-negative integer, or null if not a count. */
export function parseRevListCount(stdout: string): number | null {
  const n = Number.parseInt(String(stdout ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Extract conflicted path samples from `git merge-tree --write-tree --name-only`
 * stdout (CONFLICT lines + bare name-only paths). Does **not** decide conflict
 * status — that comes from the merge-tree exit code when the ref is verified.
 */
export function parseMergeTreeConflictPaths(mergeTreeOutput: string): string[] {
  const text = String(mergeTreeOutput ?? '');
  const paths = new Set<string>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Only the "Merge conflict in <path>" form — trailing "in origin/main" on
    // modify/delete lines is a ref, not a conflicted path (name-only lines carry those).
    const mergeIn = trimmed.match(/^CONFLICT \([^)]+\):\s*Merge conflict in (\S+)/i);
    if (mergeIn) {
      paths.add(mergeIn[1].replace(/[.,;:]+$/, ''));
      continue;
    }
    if (/^CONFLICT \(/i.test(trimmed)) continue;

    // Skip tree OIDs, auto-merge chatter, and classic marker noise.
    if (/^[0-9a-f]{40}$/i.test(trimmed)) continue;
    if (/^Auto-merging\b/i.test(trimmed)) continue;
    if (/^(<<<<<<<|=======|>>>>>>>)/.test(trimmed)) continue;
    if (/^\+?(<<<<<<<|=======|>>>>>>>)/.test(trimmed)) continue;

    // name-only path lines: "f.txt" or "apps/foo/bar.ts" (must look like a path).
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

/** Build operator-facing copy: behind count, optional paths, next git command. */
export function formatBranchFreshnessHint(params: {
  behindMain?: number;
  mergeConflicts?: boolean;
  mergeConflictPaths?: readonly string[];
  defaultBranch: string;
  strategy?: MergeMainStrategy;
  remoteRefOk?: boolean;
}): string {
  const branch = params.defaultBranch || 'main';
  const strategy: MergeMainStrategy = params.strategy === 'rebase' ? 'rebase' : 'merge';

  if (params.remoteRefOk === false) {
    return (
      `Branch freshness unknown: origin/${branch} is not available after fetch ` +
      `(not treated as a merge conflict or zero-ahead). Re-run after a successful fetch.`
    );
  }

  if (params.mergeConflicts === undefined || params.behindMain === undefined) {
    return (
      `Branch freshness incomplete for origin/${branch} ` +
      `(behind/merge status unknown — not treated as zero-ahead or conflicts).`
    );
  }

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
 * Build a non-destructive probe script (fetch + rev-parse verify + rev-list +
 * merge-tree --write-tree --name-only). Unknown markers when the remote ref or
 * a count cannot be resolved. Never rebases or pushes.
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
    // Fail closed: only treat origin/<branch> as mergeable after rev-parse --verify.
    `git -C ${repo} rev-parse --verify --quiet "origin/${branch}^{commit}" >/dev/null 2>&1`,
    'ref_rc=$?',
    'if [ "$ref_rc" -eq 0 ]; then',
    '  ref_ok=1',
    `  behind=$(git -C ${repo} rev-list --count "HEAD..origin/${branch}" 2>/dev/null)`,
    '  behind_rc=$?',
    `  ahead=$(git -C ${repo} rev-list --count "origin/${branch}..HEAD" 2>/dev/null)`,
    '  ahead_rc=$?',
    // --write-tree: exit 0 clean, exit 1 conflicts (only when ref exists).
    `  mt_out=$(git -C ${repo} merge-tree --write-tree --name-only HEAD "origin/${branch}" 2>&1)`,
    '  mt_rc=$?',
    'else',
    '  ref_ok=0',
    '  behind=""',
    '  behind_rc=1',
    '  ahead=""',
    '  ahead_rc=1',
    '  mt_out=""',
    '  mt_rc=""',
    'fi',
    'printf "HEAD:%s\\n" "${head:-}"',
    'printf "REF_OK:%s\\n" "${ref_ok}"',
    'if [ "$behind_rc" -eq 0 ] && [ -n "$behind" ]; then printf "BEHIND:%s\\n" "$behind"; else printf "BEHIND:unknown\\n"; fi',
    'if [ "$ahead_rc" -eq 0 ] && [ -n "$ahead" ]; then printf "AHEAD:%s\\n" "$ahead"; else printf "AHEAD:unknown\\n"; fi',
    'if [ "$ref_ok" -eq 1 ] && [ -n "$mt_rc" ]; then printf "CONFLICT_EXIT:%s\\n" "$mt_rc"; else printf "CONFLICT_EXIT:unknown\\n"; fi',
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

/** Parse optional `BEHIND:N` / `AHEAD:N` / `unknown` markers. */
function parseCountMarker(text: string, label: 'BEHIND' | 'AHEAD'): number | undefined {
  const unknown = text.match(new RegExp(`^${label}:unknown\\s*$`, 'm'));
  if (unknown) return undefined;
  const match = text.match(new RegExp(`^${label}:(\\d+)\\s*$`, 'm'));
  if (!match) return undefined;
  const n = parseRevListCount(match[1]);
  return n === null ? undefined : n;
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
  const refOkMatch = text.match(/^REF_OK:([01])\s*$/m);
  const conflictExitMatch = text.match(/^CONFLICT_EXIT:(\d+|unknown)\s*$/m);
  const remoteRefOk = refOkMatch ? refOkMatch[1] === '1' : false;
  const behindMain = parseCountMarker(text, 'BEHIND');
  const aheadMain = parseCountMarker(text, 'AHEAD');

  // mergeConflicts only when ref verified and merge-tree reported a numeric exit.
  // Missing / unknown → omit (fail closed). Never treat "ref missing" exit 1 as conflict.
  let mergeConflicts: boolean | undefined;
  if (remoteRefOk && conflictExitMatch && conflictExitMatch[1] !== 'unknown') {
    const conflictExit = Number.parseInt(conflictExitMatch[1], 10);
    if (conflictExit === 0) mergeConflicts = false;
    else if (conflictExit === 1) mergeConflicts = true;
    // Other exit codes (tool errors) stay unknown — do not claim conflicts.
  }

  let tree = '';
  const begin = text.indexOf('TREE_BEGIN');
  const end = text.indexOf('TREE_END');
  if (begin >= 0 && end > begin) {
    tree = text.slice(begin + 'TREE_BEGIN'.length, end).replace(/^\n/, '');
  }

  // Only surface path samples when we know there are conflicts; otherwise ignore noise.
  const mergeConflictPaths =
    mergeConflicts === true ? parseMergeTreeConflictPaths(tree) : [];

  const headSha = headMatch?.[1] && /^[0-9a-f]{7,40}$/i.test(headMatch[1]) ? headMatch[1] : undefined;
  const hint = formatBranchFreshnessHint({
    behindMain,
    mergeConflicts,
    mergeConflictPaths,
    defaultBranch: branch,
    strategy,
    remoteRefOk,
  });
  return {
    ...(behindMain !== undefined ? { behindMain } : {}),
    ...(aheadMain !== undefined ? { aheadMain } : {}),
    ...(mergeConflicts !== undefined ? { mergeConflicts } : {}),
    mergeConflictPaths,
    defaultBranch: branch,
    remoteRefOk,
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
    if (
      !result.stdout.includes('REF_OK:') ||
      !result.stdout.includes('BEHIND:') ||
      !result.stdout.includes('CONFLICT_EXIT:')
    ) {
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
export function resolveBranchUpdateStrategy(projectJson: unknown): MergeMainStrategy {
  // Reuse the slot-tracking helper (same key, same default) — do not re-roll the in-check.
  return resolveMergeMainStrategy(
    (projectJson && typeof projectJson === 'object' ? projectJson : {}) as Parameters<
      typeof resolveMergeMainStrategy
    >[0],
  );
}
