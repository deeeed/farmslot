import { existsSync, readFileSync } from 'node:fs';

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

function buildResolution(
  request: ResolveRequest,
  winner: { tier: ResolutionTier; path: string },
  existing: { tier: ResolutionTier; path: string }[],
): ResolutionSource {
  return {
    kind: request.kind,
    resolvedPath: winner.path,
    tier: winner.tier,
    // Every existing lower-precedence file is a shadow - non-silent overriding.
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
  const existing = candidatesByTier(request).filter((c) => existsSync(c.path));
  if (existing.length === 0) {
    throw new Error(
      `resolveFile(${request.kind}): shipped default missing at ${request.defaultPath}. ` +
        'Next: this is a packaging bug - reinstall @farmslot/handoff.',
    );
  }
  const resolution = buildResolution(request, existing[0], existing);
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
 * override (unreadable file, parse error) degrades to the shipped default with a
 * warning, never a throw. The returned resolution then records `tier: 'default'`
 * with the broken override listed in `shadows`, so provenance.json carries the
 * fallback audit (a default winner shadowed by a higher-tier file is exactly the
 * fallback signature).
 *
 * Only a broken/missing shipped default still throws - that is a packaging bug,
 * not a customization error.
 */
export function resolveContent<T>(
  request: ResolveRequest,
  parse: (raw: string, path: string) => T,
  ctx: ResolveContext = {},
): ResolvedContent<T> {
  const existing = candidatesByTier(request).filter((c) => existsSync(c.path));
  if (existing.length === 0) {
    throw new Error(
      `resolveContent(${request.kind}): shipped default missing at ${request.defaultPath}. ` +
        'Next: this is a packaging bug - reinstall @farmslot/handoff.',
    );
  }

  const winner = existing[0];
  try {
    const value = parse(readFileSync(winner.path, 'utf8'), winner.path);
    const resolution = buildResolution(request, winner, existing);
    ctx.logger?.(resolution);
    return { value, resolution };
  } catch (error) {
    if (winner.tier === 'default') {
      throw new Error(
        `resolveContent(${request.kind}): shipped default at ${winner.path} is broken ` +
          `(${(error as Error).message}). Next: this is a packaging bug - reinstall @farmslot/handoff.`,
      );
    }
    ctx.warn?.(
      `resolveContent(${request.kind}): ${winner.tier} override ${winner.path} is broken ` +
        `(${(error as Error).message}); falling back to the shipped default. ` +
        'Next: fix or remove the override file - the run continues on defaults.',
    );
    // Deliberately straight to the shipped default, not the next tier down:
    // the unhappy-path contract prescribes "use the default" for a broken
    // override, keeping degradation predictable (one warning, one known-good
    // tier) instead of cascading through possibly-also-broken files.
    const fallback = { tier: 'default' as const, path: request.defaultPath };
    const value = parse(readFileSync(fallback.path, 'utf8'), fallback.path);
    const resolution = buildResolution(request, fallback, existing);
    ctx.logger?.(resolution);
    return { value, resolution };
  }
}
