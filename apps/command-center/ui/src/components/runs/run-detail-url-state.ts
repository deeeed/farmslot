import { buildHash, parseHashRoute } from '../../utils/url-state.js';
import type { LightboxItem } from '../shared/media-lightbox-types.js';

export interface RunDetailArtifactSelection {
  artifactRun: string | null;
  artifact: string | null;
  /** Which viewer opened the artifact; `step` means the step inspector owns it. */
  artifactView: string | null;
  /** The acceptance criterion whose evidence the lightbox was stepping through. */
  artifactAc: string | null;
}

const STEP_PARAM = 'step';
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
  params.delete(ARTIFACT_VIEW_PARAM);
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
  ]) {
    params.delete(key);
  }
  return buildHash('runs', params);
}

function runDetailRoute(runId: string): string {
  return `run/${runId}`;
}
