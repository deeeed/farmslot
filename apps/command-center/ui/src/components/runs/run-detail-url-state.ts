import { buildHash, parseHashRoute } from '../../utils/url-state.js';
import type { ArtifactBrowserView } from '../shared/artifact-browser-model.js';
import type { LightboxItem } from '../shared/media-lightbox-types.js';
import { ARTIFACT_TYPES } from '../workspace/workspace-artifacts.js';

export interface RunDetailArtifactSelection {
  artifactRun: string | null;
  artifact: string | null;
  /** Which viewer opened the artifact; `step` means the step inspector owns it. */
  artifactView: string | null;
  /** The acceptance criterion whose evidence the lightbox was stepping through. */
  artifactAc: string | null;
}

const STEP_PARAM = 'step';
const BROWSER_QUERY = 'artifactQuery';
const BROWSER_TYPES = 'artifactTypes';
const BROWSER_FILE = 'artifactFile';
const BROWSER_PREVIEW = 'artifactPreview';

export function artifactBrowserViewFromRunDetailHash(
  hash: string = location.hash,
): ArtifactBrowserView {
  const { params } = parseHashRoute(hash);
  const path = params.get(BROWSER_FILE) || null;
  const requestedTypes = new Set((params.get(BROWSER_TYPES) ?? '').split(','));
  return {
    query: params.get(BROWSER_QUERY) ?? '',
    types: new Set(ARTIFACT_TYPES.filter((type) => requestedTypes.has(type))),
    path,
    preview: Boolean(path) && params.get(BROWSER_PREVIEW) !== 'closed',
  };
}

export function runDetailArtifactBrowserHash(
  runId: string,
  view: ArtifactBrowserView,
  hash: string = location.hash,
): string {
  const { route, params } = parseHashRoute(hash);
  if (view.query) params.set(BROWSER_QUERY, view.query);
  else params.delete(BROWSER_QUERY);
  const types = ARTIFACT_TYPES.filter((type) => view.types.has(type));
  if (types.length) params.set(BROWSER_TYPES, types.join(','));
  else params.delete(BROWSER_TYPES);
  if (view.path) params.set(BROWSER_FILE, view.path);
  else params.delete(BROWSER_FILE);
  if (view.path && !view.preview) params.set(BROWSER_PREVIEW, 'closed');
  else params.delete(BROWSER_PREVIEW);
  if (!route.startsWith('runs')) params.delete('run');
  return buildHash(route.startsWith('runs') ? route : runDetailRoute(runId), params);
}
export const ARTIFACT_RUN_PARAM = 'artifactRun';
export const ARTIFACT_PARAM = 'artifact';
export const ARTIFACT_AC_PARAM = 'artifactAc';
/**
 * Marks an artifact the step inspector opened in its own viewer. Both viewers
 * share `artifactRun`/`artifact`, and run detail must not answer for a step
 * file it never listed.
 */
export const ARTIFACT_VIEW_PARAM = 'artifactView';
export const STEP_ARTIFACT_VIEW = 'step';
/** A criterion's file gallery, opened from the review; it stays in run detail. */
export const GALLERY_ARTIFACT_VIEW = 'gallery';

export function isRunDetailHashForRun(runId: string, hash: string = location.hash): boolean {
  const { route, params } = parseHashRoute(hash);
  return (
    route === runDetailRoute(runId) || (route.startsWith('runs') && params.get('run') === runId)
  );
}

export function selectedStepNameFromRunDetailHash(hash: string = location.hash): string | null {
  const { params } = parseHashRoute(hash);
  return params.get(STEP_PARAM);
}

export function artifactSelectionFromRunDetailHash(
  hash: string = location.hash,
): RunDetailArtifactSelection {
  const { params } = parseHashRoute(hash);
  return {
    artifactRun: params.get(ARTIFACT_RUN_PARAM),
    artifact: params.get(ARTIFACT_PARAM),
    artifactView: params.get(ARTIFACT_VIEW_PARAM),
    artifactAc: params.get(ARTIFACT_AC_PARAM),
  };
}

export function runDetailStepHash(
  runId: string,
  stepName: string | null,
  hash: string = location.hash,
): string {
  const { route, params } = parseHashRoute(hash);
  // Choosing another step closes the file the last step had open. Only here:
  // back/forward lands on a URL whose step and file already belong together.
  if (
    params.get(ARTIFACT_VIEW_PARAM) === STEP_ARTIFACT_VIEW &&
    params.get(STEP_PARAM) !== stepName
  ) {
    params.delete(ARTIFACT_RUN_PARAM);
    params.delete(ARTIFACT_PARAM);
    params.delete(ARTIFACT_AC_PARAM);
    params.delete(ARTIFACT_VIEW_PARAM);
  }
  if (stepName) {
    params.set(STEP_PARAM, stepName);
  } else {
    params.delete(STEP_PARAM);
  }
  if (!route.startsWith('runs')) params.delete('run');
  return buildHash(route.startsWith('runs') ? route : runDetailRoute(runId), params);
}

export function runDetailEvidenceArtifactHash(
  runId: string,
  item: Pick<LightboxItem, 'path'> | null,
  hash: string = location.hash,
  /** Set when the lightbox steps through one acceptance criterion's evidence. */
  criterionId: string | null = null,
  /** Run detail's gallery of the criterion's files, rather than its review. */
  gallery = false,
): string {
  const { route, params } = parseHashRoute(hash);
  params.delete('artifactTrace');
  params.delete('artifactPhase');
  if (item) {
    params.set(ARTIFACT_RUN_PARAM, runId);
    params.set(ARTIFACT_PARAM, item.path);
  } else {
    params.delete(ARTIFACT_RUN_PARAM);
    params.delete(ARTIFACT_PARAM);
  }
  if (item && criterionId) params.set(ARTIFACT_AC_PARAM, criterionId);
  else params.delete(ARTIFACT_AC_PARAM);
  // Run detail's own viewer: never inherit the step inspector's claim.
  if (item && criterionId && gallery) params.set(ARTIFACT_VIEW_PARAM, GALLERY_ARTIFACT_VIEW);
  else params.delete(ARTIFACT_VIEW_PARAM);
  if (!route.startsWith('runs')) params.delete('run');
  return buildHash(route.startsWith('runs') ? route : runDetailRoute(runId), params);
}

export function standaloneRunDetailHash(runId: string, hash: string = location.hash): string {
  const { params } = parseHashRoute(hash);
  params.delete('run');
  return buildHash(runDetailRoute(runId), params);
}

export function runInventoryHashFromDetail(hash: string = location.hash): string {
  const { params } = parseHashRoute(hash);
  for (const key of [
    'run',
    'tab',
    'file',
    'commentFile',
    'commentLine',
    'comment',
    'commentHead',
    'modal',
    'diffArtifact',
    'lightboxIndex',
    'lightboxRecipeRunId',
    'evidencePreview',
    'step',
    'artifactRun',
    'artifact',
    ARTIFACT_AC_PARAM,
    ARTIFACT_VIEW_PARAM,
    'artifactTrace',
    'artifactPhase',
    BROWSER_QUERY,
    BROWSER_TYPES,
    BROWSER_FILE,
    BROWSER_PREVIEW,
  ]) {
    params.delete(key);
  }
  return buildHash('runs', params);
}

function runDetailRoute(runId: string): string {
  return `run/${runId}`;
}
