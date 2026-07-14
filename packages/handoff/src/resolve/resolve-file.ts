import { accessSync, constants, lstatSync, readFileSync } from 'node:fs';

import type { ResolutionSource, ResolutionTier } from '../spec/types.js';

/**
 * One resolution request: candidate override files per tier plus the shipped
 * default. Override points are FILES the caller owns, never code forks; the
 * package ships only the `default` tier.
 */
export interface ResolveRequest {
  /** What is being resolved, e.g. "task-template", "pr-template", "learning.config". */
  kind: string;
  /** Personal-tier candidate absolute paths ($FARMSLOT_HOME), highest precedence. */
  personal?: string[];
  /** Domain-tier candidate absolute paths (active domain overlay). */
  domain?: string[];
  /** Farm-tier candidate absolute paths (farm repo root). */
  farm?: string[];
  /** The shipped default. MUST exist - the chain is always resolvable. */
  defaultPath: string;
}

/** Sinks for non-silent resolution logging and unhappy-path warnings. */
export interface ResolveContext {
  logger?: (event: ResolutionSource) => void;
  warn?: (message: string) => void;
}

const TIER_ORDER: ResolutionTier[] = ['personal', 'domain', 'farm', 'default'];

function candidatesByTier(request: ResolveRequest): { tier: ResolutionTier; path: string }[] {
  const out: { tier: ResolutionTier; path: string }[] = [];
  for (const tier of TIER_ORDER) {
    const paths = tier === 'default' ? [request.defaultPath] : (request[tier] ?? []);
    for (const path of paths) out.push({ tier, path });
  }
  return out;
}

/**
 * Reason a PRESENT candidate cannot be used as an override: a valid candidate
 * is a plain, readable, regular FILE (lstat - symlinks are excluded, consistent
 * with the rest of the gate). A directory, special file, or unreadable file is
 * a BROKEN override per the unhappy-path contract: warn and continue the walk.
 */
/**
 * Discovery is lstat-aware: existsSync FOLLOWS symlinks, so a dangling symlink
 * override would silently vanish instead of being classified as the broken
 * override it is (warned, skipped, recorded in shadows).
 */
function discoverCandidates(request: ResolveRequest): { tier: ResolutionTier; path: string }[] {
  return candidatesByTier(request).filter((c) => {
    try {
      lstatSync(c.path);
      return true;
    } catch {
      return false;
    }
  });
}

function brokenCandidateReason(candidatePath: string): string | undefined {
  let stats;
  try {
    stats = lstatSync(candidatePath);
  } catch (error) {
    return `cannot be inspected (${(error as Error).message})`;
  }
  if (stats.isSymbolicLink()) return 'is a symlink';
  if (stats.isDirectory()) return 'is a directory';
  if (!stats.isFile()) return 'is not a regular file';
  try {
    accessSync(candidatePath, constants.R_OK);
  } catch {
    return 'is not readable';
  }
  return undefined;
}

/**
 * Walk the existing candidates in precedence order, warning past broken ones
 * (directory/symlink/unreadable) until a valid file wins. A broken or missing
 * shipped default is a packaging bug and throws.
 */
function selectWinner(
  request: ResolveRequest,
  ctx: ResolveContext,
  label: string,
): {
  winner: { tier: ResolutionTier; path: string };
  existing: { tier: ResolutionTier; path: string }[];
} {
  const existing = discoverCandidates(request);
  for (const candidate of existing) {
    const broken = brokenCandidateReason(candidate.path);
    if (broken === undefined) return { winner: candidate, existing };
    if (candidate.tier === 'default') {
      throw new Error(
        `${label}(${request.kind}): shipped default at ${candidate.path} ${broken}. ` +
          'Next: this is a packaging bug - reinstall @farmslot/handoff.',
      );
    }
    ctx.warn?.(
      `${label}(${request.kind}): ${candidate.tier} override ${candidate.path} ${broken}; ` +
        'skipping it and continuing down the resolution chain. Next: fix or remove the ' +
        'override - the run continues.',
    );
  }
  throw new Error(
    `${label}(${request.kind}): shipped default missing at ${request.defaultPath}. ` +
      'Next: this is a packaging bug - reinstall @farmslot/handoff.',
  );
}

function buildResolution(
  request: ResolveRequest,
  winner: { tier: ResolutionTier; path: string },
  existing: { tier: ResolutionTier; path: string }[],
): ResolutionSource {
  return {
    kind: request.kind,
    resolvedPath: winner.path,
    tier: winner.tier,
    // Every existing non-winning candidate is a shadow - lower-precedence files AND
    // broken higher-precedence candidates that were warned and skipped. Non-silent.
    shadows: existing
      .filter((c) => c.path !== winner.path)
      .map((c) => ({ path: c.path, tier: c.tier })),
  };
}

/**
 * The one override engine: first-match resolution walking
 * `personal > domain > farm > default` (spec section 3.7). Returns the winner
 * plus every shadowed lower-tier file, and logs the event via `ctx.logger`.
 */
export function resolveFile(request: ResolveRequest, ctx: ResolveContext = {}): ResolutionSource {
  const { winner, existing } = selectWinner(request, ctx, 'resolveFile');
  const resolution = buildResolution(request, winner, existing);
  ctx.logger?.(resolution);
  return resolution;
}

/** A resolved file's parsed content together with its provenance record. */
export interface ResolvedContent<T> {
  value: T;
  resolution: ResolutionSource;
}

/**
 * Resolve, read, and parse - with the binding unhappy-path contract: a BROKEN
 * override at any tier (stat-broken like a directory/symlink/unreadable file,
 * or parse-broken content) is warned, recorded in `shadows`/provenance, and
 * SKIPPED - the walk continues to the next tier's candidate; the shipped
 * default is the TERMINAL fallback only. One rule for all broken shapes,
 * never a throw for a customization error.
 *
 * Only a broken/missing shipped default still throws - that is a packaging bug,
 * not a customization error.
 */
export function resolveContent<T>(
  request: ResolveRequest,
  parse: (raw: string, path: string) => T,
  ctx: ResolveContext = {},
): ResolvedContent<T> {
  const existing = discoverCandidates(request);
  for (const candidate of existing) {
    let failure = brokenCandidateReason(candidate.path);
    if (failure === undefined) {
      try {
        const value = parse(readFileSync(candidate.path, 'utf8'), candidate.path);
        const resolution = buildResolution(request, candidate, existing);
        ctx.logger?.(resolution);
        return { value, resolution };
      } catch (error) {
        failure = `is broken (${(error as Error).message})`;
      }
    }
    if (candidate.tier === 'default') {
      throw new Error(
        `resolveContent(${request.kind}): shipped default at ${candidate.path} ${failure}. ` +
          'Next: this is a packaging bug - reinstall @farmslot/handoff.',
      );
    }
    ctx.warn?.(
      `resolveContent(${request.kind}): ${candidate.tier} override ${candidate.path} ${failure}; ` +
        'skipping it and continuing down the resolution chain. Next: fix or remove the ' +
        'override - the run continues.',
    );
  }
  throw new Error(
    `resolveContent(${request.kind}): shipped default missing at ${request.defaultPath}. ` +
      'Next: this is a packaging bug - reinstall @farmslot/handoff.',
  );
}
