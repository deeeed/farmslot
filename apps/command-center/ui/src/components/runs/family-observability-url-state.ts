import type { FamilyObservabilityArtifact } from '@farmslot/protocol';

import { buildHash, parseHashRoute } from '../../utils/url-state.js';

import type { FamilyEvidenceFilter } from './family-observability-evidence.js';

export interface FamilyDiffSelection {
  runId: string | null;
  path: string | null;
}

export function familyRunHash(
  familyId: string,
  runId: string,
  options: { evidence?: FamilyEvidenceFilter } = {},
): string {
  const params = new URLSearchParams({ run: runId });
  if (options.evidence) params.set('evidence', options.evidence);
  return buildHash(`family/${familyId}`, params);
}

export function evidenceFilterFromFamilyHash(
  hash: string = location.hash,
): FamilyEvidenceFilter | null {
  const { params } = parseHashRoute(hash);
  const value = params.get('evidence');
  return value === 'all' ||
    value === 'before' ||
    value === 'after' ||
    value === 'setup' ||
    value === 'videos'
    ? value
    : null;
}

export function slotHistoryHashForRun(slotId: string, runId: string): string {
  const params = new URLSearchParams({
    history: '1',
    historyRun: runId,
  });
  return buildHash(`slot/${slotId}`, params);
}

export function diffSelectionFromFamilyHash(hash: string = location.hash): FamilyDiffSelection {
  const { params } = parseHashRoute(hash);
  return {
    runId: params.get('diffRun'),
    path: params.get('diffArtifact'),
  };
}

export function familyDiffModalHash(
  artifact: Pick<FamilyObservabilityArtifact, 'runId' | 'path'> | null,
  hash: string = location.hash,
): string {
  const { route, params } = parseHashRoute(hash);
  if (artifact) {
    params.set('diffRun', artifact.runId);
    params.set('diffArtifact', artifact.path);
  } else {
    params.delete('diffRun');
    params.delete('diffArtifact');
  }
  return buildHash(route, params);
}
