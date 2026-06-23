/**
 * Shared before/after pairing logic. Both the family retrospective and
 * the slot-view recipe-evidence lightbox build pairs the same way:
 * group artifacts by stem (filename without ext, with leading/trailing
 * before-/after markers and leading evidence- stripped), then keep only
 * buckets that have both a before and an after capture.
 */
import { artifactKind } from './artifact-kind.js';

export interface PairableArtifact {
  path: string;
  purpose: string;
  runId?: string | null;
  stepName?: string | null;
}

export interface BeforeAfterPair<T> {
  before: T;
  after: T;
  stem: string;
}

type PairBucket<T> = { before?: T; after?: T; stem: string };

function filenameStem(path: string): {
  base: string;
  ext: string;
  stem: string;
  stemForKey: string;
} {
  const base = path.split('/').pop() ?? path;
  const ext = (base.match(/\.[^.]+$/) ?? [''])[0].toLowerCase();
  const noExt = ext ? base.slice(0, -ext.length) : base;
  const stem = noExt
    .replace(/^(before|after)[-_.]*/i, '')
    .replace(/^evidence-/i, '')
    .replace(/[-_.]*(before|after)$/i, '');
  // Empty stems collide across unrelated bare-prefix files (`before.mp4`
  // vs `before-.mp4`). Fall back to the unstripped basename so each
  // bucket gets a distinct key — last-write-wins on truly identical
  // file/step pairs is fine, but accidental coalescing is a silent
  // disappear-from-compare-strip bug.
  const stemForKey = stem || noExt || base;
  return { base, ext, stem, stemForKey };
}

/**
 * Normalized comparison key for an evidence artifact — filename without
 * extension, before/after markers, or leading `evidence-`. Shared by
 * before/after pairing and the cross-run evidence matrix so the same logical
 * screen lines up across sibling runs.
 */
export function artifactStem(path: string): string {
  return filenameStem(path).stemForKey.toLowerCase();
}

export function acceptanceCriteriaKey(path: string): string | null {
  const base = path.split('/').pop()?.toLowerCase() ?? '';
  const match = base.match(/(?:^|[-_.])(ac\d+)(?:[-_.]|$)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function stripStageMarkers(value: string): string {
  return value
    .replace(/^(before|after)(?:-evidence)?[-_.]*/i, '')
    .replace(/^evidence[-_.]*/i, '')
    .replace(/[-_.]*(before|after)$/i, '');
}

function acPairSpecificity(path: string): number {
  const base = path.split('/').pop() ?? path;
  const ext = (base.match(/\.[^.]+$/) ?? [''])[0];
  const noExt = ext ? base.slice(0, -ext.length) : base;
  // In an AC fallback bucket, prefer the canonical before/after evidence
  // captures over navigation/origin/setup screenshots. Example:
  // `before-evidence-ac2-market-list-leverage.png` should pair with
  // `after-ac2-market-list-leverage.png`, not `after-ac2-market-list-origin.png`.
  return stripStageMarkers(noExt).replace(/[-_.]origin$/i, '').length;
}

export function buildBeforeAfterPairs<T extends PairableArtifact>(
  artifacts: T[],
): BeforeAfterPair<T>[] {
  const bucket = new Map<string, PairBucket<T>>();
  for (const a of artifacts) {
    const kind = artifactKind(a.path, a.purpose);
    if (kind !== 'before' && kind !== 'after') continue;
    const { base, ext, stem, stemForKey } = filenameStem(a.path);
    const key = `${a.runId ?? ''}::${a.stepName ?? ''}::${stemForKey}::${ext}`;
    const slot = bucket.get(key) ?? { stem: stem || base };
    if (kind === 'before') slot.before = a;
    else slot.after = a;
    bucket.set(key, slot);
  }
  const exactPairs = [...bucket.values()].filter(
    (s): s is { before: T; after: T; stem: string } => s.before != null && s.after != null,
  );
  const pairedPaths = new Set(exactPairs.flatMap((pair) => [pair.before.path, pair.after.path]));
  const fallbackByAc = new Map<
    string,
    PairBucket<T> & { beforeCount: number; afterCount: number }
  >();
  for (const a of artifacts) {
    if (pairedPaths.has(a.path)) continue;
    const kind = artifactKind(a.path, a.purpose);
    if (kind !== 'before' && kind !== 'after') continue;
    const acKey = acceptanceCriteriaKey(a.path);
    if (!acKey) continue;
    const { ext } = filenameStem(a.path);
    // AC-number fallback intentionally ignores stepName: baseline captures are
    // often copied into the task root without a producing step, while after
    // captures are attached to `complete`/recipe steps. Require exactly one
    // before and one after in the run+AC+extension bucket below to avoid
    // silently pairing ambiguous multi-step captures.
    const key = `${a.runId ?? ''}::${acKey}::${ext}`;
    const slot = fallbackByAc.get(key) ?? {
      stem: acKey,
      beforeCount: 0,
      afterCount: 0,
    };
    if (kind === 'before') {
      if (!slot.before || acPairSpecificity(a.path) > acPairSpecificity(slot.before.path)) {
        slot.before = a;
      }
      slot.beforeCount += 1;
    } else {
      if (!slot.after || acPairSpecificity(a.path) > acPairSpecificity(slot.after.path)) {
        slot.after = a;
      }
      slot.afterCount += 1;
    }
    fallbackByAc.set(key, slot);
  }
  const acPairs = [...fallbackByAc.values()].filter(
    (s): s is { before: T; after: T; stem: string; beforeCount: number; afterCount: number } =>
      s.before != null && s.after != null && s.beforeCount >= 1 && s.afterCount >= 1,
  );
  return [...exactPairs, ...acPairs];
}
