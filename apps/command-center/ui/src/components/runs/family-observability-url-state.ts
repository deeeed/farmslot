import type { FamilyObservabilityArtifact } from '@farmslot/protocol';

import { buildHash, parseHashRoute } from '../../utils/url-state.js';

import type { CompareTab } from './family-observability-comparison-renderers.js';
import type { FamilyEvidenceFilter } from './family-observability-evidence.js';
import type {
  FamilyTokenScope,
  FamilyTokenTrajectory,
} from './family-observability-token-model.js';

const COMPARE_TABS: CompareTab[] = ['leaderboard', 'matrix', 'evidence', 'cards'];
const TOKEN_SCOPES: FamilyTokenScope[] = ['family', 'run'];
const TOKEN_TRAJECTORIES: FamilyTokenTrajectory[] = ['all-runs', 'pr-complete-milestones'];

export interface FamilyCompareView {
  tab: CompareTab | null;
  sortKey: string | null;
}

export function compareViewFromFamilyHash(hash: string = location.hash): FamilyCompareView {
  const { params } = parseHashRoute(hash);
  const tab = params.get('cmpTab');
  const sortKey = params.get('cmpSort');
  return {
    tab: COMPARE_TABS.includes(tab as CompareTab) ? (tab as CompareTab) : null,
    sortKey: sortKey || null,
  };
}

export function familyCompareViewHash(
  tab: CompareTab,
  sortKey: string,
  hash: string = location.hash,
): string {
  const { route, params } = parseHashRoute(hash);
  // 'leaderboard' + 'score' are the defaults — omit them so shared links stay clean.
  if (tab === 'leaderboard') params.delete('cmpTab');
  else params.set('cmpTab', tab);
  if (sortKey === 'score') params.delete('cmpSort');
  else params.set('cmpSort', sortKey);
  return buildHash(route, params);
}

export interface FamilyDiffSelection {
  runId: string | null;
  path: string | null;
}

export function familyRunHash(
  familyId: string,
  runId: string,
  options: {
    evidence?: FamilyEvidenceFilter;
    tokens?: FamilyTokenScope;
    trajectory?: FamilyTokenTrajectory;
  } = {},
): string {
  const params = new URLSearchParams({ run: runId });
  if (options.evidence) params.set('evidence', options.evidence);
  if (options.tokens && options.tokens !== 'family') params.set('tokens', options.tokens);
  if (options.trajectory && options.trajectory !== 'all-runs') {
    params.set('trajectory', options.trajectory);
  }
  return buildHash(`family/${familyId}`, params);
}

export function tokenViewFromFamilyHash(hash: string = location.hash): {
  scope: FamilyTokenScope;
  trajectory: FamilyTokenTrajectory;
} {
  const { params } = parseHashRoute(hash);
  const scope = params.get('tokens');
  const trajectory = params.get('trajectory');
  return {
    scope: TOKEN_SCOPES.includes(scope as FamilyTokenScope)
      ? (scope as FamilyTokenScope)
      : 'family',
    trajectory: TOKEN_TRAJECTORIES.includes(trajectory as FamilyTokenTrajectory)
      ? (trajectory as FamilyTokenTrajectory)
      : 'all-runs',
  };
}

export function familyTokenViewHash(
  scope: FamilyTokenScope,
  trajectory: FamilyTokenTrajectory,
  hash: string = location.hash,
): string {
  const { route, params } = parseHashRoute(hash);
  if (scope === 'family') params.delete('tokens');
  else params.set('tokens', scope);
  if (trajectory === 'all-runs') params.delete('trajectory');
  else params.set('trajectory', trajectory);
  return buildHash(route, params);
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

export function familyEvidenceFilterHash(
  filter: FamilyEvidenceFilter,
  hash: string = location.hash,
): string {
  const { route, params } = parseHashRoute(hash);
  if (filter === 'all') {
    params.delete('evidence');
  } else {
    params.set('evidence', filter);
  }
  return buildHash(route, params);
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
