import { buildHash, hashParams, navigateHash, parseHashRoute } from '../../utils/url-state.js';

/** What the review shows, as a shareable link records it. */
export interface EvidenceReviewerView {
  claimId: string;
  /** A screenshot or file in the main view; absent means the recording. */
  path?: string;
  /** The timeline source when the main view shows another file. */
  recordingPath?: string;
  /** Digest of the recording and its verified timing sidecar when present. */
  recordingRevision?: string;
  /** Run Detail recipe group owning the linked recording and files. */
  recipeGroupId?: string;
  /** The exact publication gate when the recording belongs to a frozen decision. */
  decisionId?: string;
  atMs?: number;
  /** The step whose check is open, by trace index. */
  check?: number;
  /** Page in the open recording timeline. */
  timelinePage?: number;
}

const REVIEW_PARAM = 'review';
const REVIEW_FILE_PARAM = 'reviewFile';
const REVIEW_AT_PARAM = 'reviewAt';
const REVIEW_CHECK_PARAM = 'reviewCheck';
const REVIEW_TIMELINE_PARAM = 'reviewTimeline';
const REVIEW_RECORDING_PARAM = 'reviewRecording';
const REVIEW_REVISION_PARAM = 'reviewRevision';
const REVIEW_RECIPE_PARAM = 'reviewRecipe';
const REVIEW_DECISION_PARAM = 'reviewDecision';

/** The hash parameters the evidence review owns. */
export const EVIDENCE_REVIEWER_PARAMS = [
  REVIEW_PARAM,
  REVIEW_FILE_PARAM,
  REVIEW_AT_PARAM,
  REVIEW_CHECK_PARAM,
  REVIEW_TIMELINE_PARAM,
  REVIEW_RECORDING_PARAM,
  REVIEW_REVISION_PARAM,
  REVIEW_RECIPE_PARAM,
  REVIEW_DECISION_PARAM,
] as const;

export function evidenceReviewerViewFromHash(
  hash: string = location.hash,
): EvidenceReviewerView | null {
  const params = hashParams(hash);
  const claimId = params.get(REVIEW_PARAM);
  if (!claimId) return null;
  const path = params.get(REVIEW_FILE_PARAM);
  const recordingPath = params.get(REVIEW_RECORDING_PARAM);
  const recordingRevision = params.get(REVIEW_REVISION_PARAM);
  const recipeGroupId = params.get(REVIEW_RECIPE_PARAM);
  const decisionId = params.get(REVIEW_DECISION_PARAM);
  const atMs = Math.round(Number(params.get(REVIEW_AT_PARAM)) * 1000);
  const check = Number(params.get(REVIEW_CHECK_PARAM));
  const page = params.get(REVIEW_TIMELINE_PARAM);
  const timelinePage = Number(page);
  return {
    claimId,
    ...(path ? { path } : {}),
    ...(recordingPath ? { recordingPath } : {}),
    ...(recordingRevision ? { recordingRevision } : {}),
    ...(recipeGroupId ? { recipeGroupId } : {}),
    ...(decisionId ? { decisionId } : {}),
    ...(params.has(REVIEW_AT_PARAM) && Number.isSafeInteger(atMs) && atMs >= 0 ? { atMs } : {}),
    ...(params.has(REVIEW_CHECK_PARAM) && Number.isInteger(check) ? { check } : {}),
    ...(page !== null && /^\d+$/.test(page) && Number.isSafeInteger(timelinePage)
      ? { timelinePage }
      : {}),
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
    if (view.recordingPath) params.set(REVIEW_RECORDING_PARAM, view.recordingPath);
    if (view.recordingRevision) params.set(REVIEW_REVISION_PARAM, view.recordingRevision);
    if (view.recipeGroupId) params.set(REVIEW_RECIPE_PARAM, view.recipeGroupId);
    if (view.decisionId) params.set(REVIEW_DECISION_PARAM, view.decisionId);
    if (view.atMs !== undefined) params.set(REVIEW_AT_PARAM, (view.atMs / 1000).toFixed(3));
    if (view.check !== undefined) params.set(REVIEW_CHECK_PARAM, String(view.check));
    if (view.timelinePage !== undefined)
      params.set(REVIEW_TIMELINE_PARAM, String(view.timelinePage));
  }
  return buildHash(route, params);
}

/** One string per view as the link records it (times to a millisecond). */
export function evidenceReviewerViewKey(view: EvidenceReviewerView | null): string {
  return view ? evidenceReviewerHash(view, '#') : '';
}

export function reviewLinkMatchesRun(runId: string, hash: string = location.hash): boolean {
  const { route, params } = parseHashRoute(hash);
  if (route === 'runs') return params.get('run') === runId;
  if (route.startsWith('run/')) return route === `run/${encodeURIComponent(runId)}`;
  return true;
}

export function writeEvidenceReviewerHash(
  view: EvidenceReviewerView | null,
  notifyRoute = false,
): void {
  const next = evidenceReviewerHash(view);
  if (location.hash === next) return;
  const before = location.href;
  navigateHash(next, 'replace');
  // Gate selection lives in Run Detail, which listens to route changes.
  if (notifyRoute && location.href !== before)
    window.dispatchEvent(
      new HashChangeEvent('hashchange', { oldURL: before, newURL: location.href }),
    );
}
