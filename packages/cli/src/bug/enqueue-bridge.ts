// Autonomous intake bridge: after `bug batch` scores issues,
// create backlog items for the ones likely to be one-shot fixable so the farm
// feeds itself. Operator-invoked via `--enqueue-threshold`; items land as
// `candidate` (never auto-dispatch) so marking ready stays an explicit gate.
import path from 'node:path';

import type { BacklogItem } from '@farmslot/protocol';

import { readScoreFile } from './score-file.js';

/**
 * Canonical dedup key for a source ref. The gateway stores GitHub refs as
 * `owner/repo#N` while score files can carry the URL form (hand-provided
 * `--github <url>` inputs) — both must collapse to one key or a re-run
 * double-files the issue. Jira keys just fold case.
 */
export function canonicalSourceRef(ref: string): string {
  const trimmed = ref.trim();
  const url = trimmed.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/i);
  if (url) return `${url[1]}/${url[2]}#${url[3]}`.toLowerCase();
  return trimmed.toLowerCase();
}

/**
 * Parse the --enqueue-threshold value. Distinct from `Number(raw)` because
 * `Number('') === 0`: a blank value must be a usage error, not "enqueue
 * everything".
 */
export function parseEnqueueThreshold(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const value = trimmed === '' ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw Object.assign(new Error(`--enqueue-threshold must be a number in [0,1], got: ${raw}`), {
      code: 'USAGE_ERROR',
      userAction: 'Pass e.g. --enqueue-threshold 0.7.',
    });
  }
  return value;
}

/** Minimal gateway surface the bridge needs — injectable for tests. */
export interface BridgeGatewayClient {
  call<T>(method: string, params: unknown): Promise<T>;
}

export interface EnqueueBridgeOptions {
  project: string;
  source: 'github' | 'jira';
  scoresDir: string;
  /** Score-file keys whose files reflect THIS run — pass BatchResult.scoredKeys,
   * never BatchResult.keys: failed issues can leave stale score files behind. */
  keys: string[];
  /** Minimum p(one-shot) — final score preferred, heuristic fallback. */
  threshold: number;
}

export interface EnqueueBridgeResult {
  threshold: number;
  considered: number;
  created: Array<{ ref: string; itemRef: string; probability: number }>;
  skippedExisting: Array<{ ref: string; itemRef: string }>;
  skippedBelowThreshold: number;
  skippedInvalid: string[];
  skippedNoScore: string[];
  /** Per-item bridge failures — reported, never silently dropped. */
  failures: Array<{ ref: string; error: string }>;
}

/**
 * The probability the bridge gates on: the LLM-blended final score when the
 * batch ran grading, else the heuristic. Missing both = not comparable.
 */
function probabilityOf(score: {
  final?: { one_shot_probability?: number };
  heuristic?: { one_shot_probability?: number };
}): number | null {
  const p = score.final?.one_shot_probability ?? score.heuristic?.one_shot_probability;
  return typeof p === 'number' && Number.isFinite(p) ? p : null;
}

export async function enqueueScoredBugs(
  client: BridgeGatewayClient,
  opts: EnqueueBridgeOptions,
): Promise<EnqueueBridgeResult> {
  const result: EnqueueBridgeResult = {
    threshold: opts.threshold,
    considered: 0,
    created: [],
    skippedExisting: [],
    skippedBelowThreshold: 0,
    skippedInvalid: [],
    skippedNoScore: [],
    failures: [],
  };

  // One list up front for dedup: an issue already tracked (any lifecycle state)
  // must not get a second item — re-runs of the batch are idempotent.
  const { items } = await client.call<{ items: BacklogItem[] }>('backlog.list', {
    project: opts.project,
    includeArchived: true,
  });
  const existingBySourceRef = new Map(
    items
      .filter((item) => item.sourceRef)
      .map((item) => [canonicalSourceRef(item.sourceRef), item.sourceRef]),
  );

  for (const key of opts.keys) {
    const file = path.join(opts.scoresDir, `${key}.json`);
    let ref = key;
    try {
      const score = await readScoreFile(file);
      if (!score) {
        result.skippedNoScore.push(key);
        continue;
      }
      ref = score.issue_ref ?? key;
      const probability = probabilityOf(score);
      if (probability === null) {
        result.skippedNoScore.push(ref);
        continue;
      }
      result.considered += 1;
      if (score.validation && score.validation.still_valid === false) {
        result.skippedInvalid.push(ref);
        continue;
      }
      if (probability < opts.threshold) {
        result.skippedBelowThreshold += 1;
        continue;
      }
      if (!score.issue_ref) {
        // A source-kind item needs a real ref for the gateway to resolve; a
        // score file without one cannot be bridged.
        result.failures.push({ ref: key, error: 'score file has no issue_ref' });
        continue;
      }
      const existing = existingBySourceRef.get(canonicalSourceRef(score.issue_ref));
      if (existing) {
        result.skippedExisting.push({ ref: score.issue_ref, itemRef: existing });
        continue;
      }
      const title = score.bug_input?.title?.trim() || score.issue_ref;
      const { item } = await client.call<{ item: BacklogItem }>('backlog.create', {
        project: opts.project,
        title,
        sourceKind: opts.source,
        sourceRef: score.issue_ref,
        flowType: 'fix-bug',
        notes: `Auto-enqueued by \`bug batch --enqueue-threshold ${opts.threshold}\`: p(one-shot)=${probability}${score.final ? ` (final, model=${score.final.recommended_model ?? 'n/a'})` : ' (heuristic)'}.`,
        tags: ['bug-intake'],
      });
      // Key by BOTH the gateway's canonical stored ref and the raw score ref, so
      // a same-batch sibling in either form still dedups.
      existingBySourceRef.set(canonicalSourceRef(item.sourceRef), item.sourceRef);
      existingBySourceRef.set(canonicalSourceRef(score.issue_ref), item.sourceRef);
      result.created.push({
        ref: score.issue_ref,
        itemRef: item.sourceRef ?? item.id,
        probability,
      });
    } catch (err) {
      // Per-item continuation: one bad score file or a create rejection must
      // not abort the rest of the bridge; every failure is surfaced.
      result.failures.push({ ref, error: (err as Error).message });
    }
  }
  return result;
}
