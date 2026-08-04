import { buildHash, parseHashRoute } from '../../utils/url-state.js';
import type { LightboxItem } from '../shared/media-lightbox-types.js';

export interface RunDetailArtifactSelection {
  artifactRun: string | null;
  artifact: string | null;
}

const STEP_PARAM = 'step';
const ARTIFACT_RUN_PARAM = 'artifactRun';
const ARTIFACT_PARAM = 'artifact';

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
  };
}

export function runDetailStepHash(
  runId: string,
  stepName: string | null,
  hash: string = location.hash,
): string {
  const { route, params } = parseHashRoute(hash);
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
): string {
  const { route, params } = parseHashRoute(hash);
  if (item) {
    params.set(ARTIFACT_RUN_PARAM, runId);
    params.set(ARTIFACT_PARAM, item.path);
  } else {
    params.delete(ARTIFACT_RUN_PARAM);
    params.delete(ARTIFACT_PARAM);
  }
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
  ]) {
    params.delete(key);
  }
  return buildHash('runs', params);
}

function runDetailRoute(runId: string): string {
  return `run/${runId}`;
}
