/**
 * Acceptance evidence (ADR-060) in the artifact viewer: one criterion's evidence
 * as an ordered, swipeable set opened on the entry the operator tapped, and the
 * route that reaches it. Evidence paths are task-dir relative, which is what the
 * gateway's run-artifact route serves without a recipe run.
 */
import {
  type ArtifactMediaType,
  classifyArtifact,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
} from './artifact-url';
import type { AcceptanceLedgerRow, AcceptanceLedgerView } from './task-progress-view';

/** The viewer renders text for anything that is not an image or a video. */
export type AcceptanceEvidenceMediaType = Exclude<ArtifactMediaType, 'other'>;

export interface AcceptanceEvidenceViewerItem {
  path: string;
  uri: string;
  title: string;
  /** Criterion, verdict, proof mode and recipe nodes, shown on the viewer header. */
  detail: string;
  mediaType: AcceptanceEvidenceMediaType;
}

export interface AcceptanceEvidenceViewer {
  items: AcceptanceEvidenceViewerItem[];
  initialIndex: number;
}

export interface AcceptanceEvidenceStripItem {
  criterionId: string;
  path: string;
  name: string;
  mediaType: AcceptanceEvidenceMediaType;
}

export function acceptanceEvidenceMediaType(path: string): AcceptanceEvidenceMediaType {
  const mediaType = classifyArtifact(path);
  return mediaType === 'other' ? 'document' : mediaType;
}

export function acceptanceEvidenceDetail(row: AcceptanceLedgerRow): string {
  const status = row.criterion.status;
  if (!status) return `${row.criterion.id} · not assessed`;
  const nodes = status.recipeNodes.length
    ? `node ${status.recipeNodes.join(', ')}`
    : 'no recipe node';
  return [row.criterion.id, status.verdict, status.proofMode ?? 'no proof mode', nodes].join(' · ');
}

/**
 * The criterion's evidence in ledger order, opened on `openPath`. Null when
 * `openPath` is not evidence of this criterion: the viewer must not open an
 * unrelated file under this criterion's verdict.
 */
export function acceptanceEvidenceViewer(
  row: AcceptanceLedgerRow,
  openPath: string,
  urlFor: (path: string) => string,
): AcceptanceEvidenceViewer | null {
  const detail = acceptanceEvidenceDetail(row);
  const items = row.evidence.map(({ path, name }) => ({
    path,
    uri: urlFor(path),
    title: name,
    detail,
    mediaType: acceptanceEvidenceMediaType(path),
  }));
  const initialIndex = items.findIndex((item) => item.path === openPath);
  return initialIndex < 0 ? null : { items, initialIndex };
}

/** Every criterion's evidence once, attributed to the first criterion that cites it. */
export function acceptanceEvidenceStrip(
  view: Pick<AcceptanceLedgerView, 'rows'>,
): AcceptanceEvidenceStripItem[] {
  const strip = view.rows.flatMap((row) =>
    row.evidence.map(({ path, name }) => ({
      criterionId: row.criterion.id,
      path,
      name,
      mediaType: acceptanceEvidenceMediaType(path),
    })),
  );
  return uniqueByPath(strip);
}

function uniqueByPath<T extends { path: string }>(entries: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  });
}

/**
 * The run files viewer as its own stack screen, so closing it always returns to
 * the screen that opened it rather than switching tabs inside the run workspace.
 */
export function acceptanceEvidenceHref(runId: string, criterionId: string, path: string) {
  return {
    pathname: '/evidence/[runId]' as const,
    params: {
      runId,
      ac: criterionId,
      evidence: path,
      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
    },
  };
}
