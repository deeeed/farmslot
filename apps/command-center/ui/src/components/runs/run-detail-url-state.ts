import { buildHash, hashRoute, parseHashRoute } from '../../utils/url-state.js';
import type { LightboxItem } from '../shared/media-lightbox-types.js';

export interface RunDetailArtifactSelection {
  artifactRun: string | null;
  artifact: string | null;
}

const STEP_PARAM = 'step';
const ARTIFACT_RUN_PARAM = 'artifactRun';
const ARTIFACT_PARAM = 'artifact';

export function isRunDetailHashForRun(runId: string, hash: string = location.hash): boolean {
  return hashRoute(hash) === runDetailRoute(runId);
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
  const { params } = parseHashRoute(hash);
  if (stepName) {
    params.set(STEP_PARAM, stepName);
  } else {
    params.delete(STEP_PARAM);
  }
  return buildHash(runDetailRoute(runId), params);
}

export function runDetailEvidenceArtifactHash(
  runId: string,
  item: Pick<LightboxItem, 'path'> | null,
  hash: string = location.hash,
): string {
  const { params } = parseHashRoute(hash);
  if (item) {
    params.set(ARTIFACT_RUN_PARAM, runId);
    params.set(ARTIFACT_PARAM, item.path);
  } else {
    params.delete(ARTIFACT_RUN_PARAM);
    params.delete(ARTIFACT_PARAM);
  }
  return buildHash(runDetailRoute(runId), params);
}

function runDetailRoute(runId: string): string {
  return `run/${runId}`;
}
