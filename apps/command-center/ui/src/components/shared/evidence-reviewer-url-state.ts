import { buildHash, hashParams, parseHashRoute } from '../../utils/url-state.js';

/** What the review shows, as a shareable link records it. */
export interface EvidenceReviewerView {
  claimId: string;
  /** A screenshot or file in the main view; absent means the recording. */
  path?: string;
  atMs?: number;
  /** The step whose check is open, by trace index. */
  check?: number;
}

const REVIEW_PARAM = 'review';
const REVIEW_FILE_PARAM = 'reviewFile';
const REVIEW_AT_PARAM = 'reviewAt';
const REVIEW_CHECK_PARAM = 'reviewCheck';

/** The hash parameters the evidence review owns. */
export const EVIDENCE_REVIEWER_PARAMS = [
  REVIEW_PARAM,
  REVIEW_FILE_PARAM,
  REVIEW_AT_PARAM,
  REVIEW_CHECK_PARAM,
] as const;

export function evidenceReviewerViewFromHash(
  hash: string = location.hash,
): EvidenceReviewerView | null {
  const params = hashParams(hash);
  const claimId = params.get(REVIEW_PARAM);
  if (!claimId) return null;
  const path = params.get(REVIEW_FILE_PARAM);
  const at = Number(params.get(REVIEW_AT_PARAM));
  const check = Number(params.get(REVIEW_CHECK_PARAM));
  return {
    claimId,
    ...(path ? { path } : {}),
    ...(params.has(REVIEW_AT_PARAM) && Number.isFinite(at) ? { atMs: at * 1000 } : {}),
    ...(params.has(REVIEW_CHECK_PARAM) && Number.isInteger(check) ? { check } : {}),
  };
}

/** The hash with the review's view in it, or without when the review closes. */
export function evidenceReviewerHash(
  view: EvidenceReviewerView | null,
  hash: string = location.hash,
): string {
  const { route, params } = parseHashRoute(hash);
  for (const key of EVIDENCE_REVIEWER_PARAMS) params.delete(key);
  if (view) {
    params.set(REVIEW_PARAM, view.claimId);
    if (view.path) params.set(REVIEW_FILE_PARAM, view.path);
    if (view.atMs !== undefined) params.set(REVIEW_AT_PARAM, (view.atMs / 1000).toFixed(1));
    if (view.check !== undefined) params.set(REVIEW_CHECK_PARAM, String(view.check));
  }
  return buildHash(route, params);
}

/** One string per view as the link records it (times to a tenth of a second). */
export function evidenceReviewerViewKey(view: EvidenceReviewerView | null): string {
  return view ? evidenceReviewerHash(view, '#') : '';
}

export function writeEvidenceReviewerHash(view: EvidenceReviewerView | null): void {
  const next = evidenceReviewerHash(view);
  if (location.hash !== next) history.replaceState(null, '', next);
}
