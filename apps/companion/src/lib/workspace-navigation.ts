import {
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
} from './artifact-url';
import { diffArtifactCandidate } from './diff';

export type DecisionWorkspaceRouteParams = {
  workspace?: 'ready' | 'review' | 'retro';
  decisionKind?: string;
};

export type WorkspaceRouteWorkspace =
  | 'family'
  | 'slot'
  | 'run'
  | 'pr'
  | 'ready'
  | 'review'
  | 'retro'
  | 'copilot'
  | 'terminal'
  | 'artifacts'
  | 'compare'
  | 'recipe'
  | 'diff';

export type WorkspaceRouteContext = {
  workspace?: WorkspaceRouteWorkspace;
  decisionKind?: string;
};

const WORKSPACE_ROUTE_WORKSPACES = new Set<WorkspaceRouteWorkspace>([
  'family',
  'slot',
  'run',
  'pr',
  'ready',
  'review',
  'retro',
  'copilot',
  'terminal',
  'artifacts',
  'compare',
  'recipe',
  'diff',
]);

export type WorkspaceNavFocusable =
  | 'ready'
  | 'review'
  | 'retro'
  | 'compare'
  | 'artifacts'
  | 'recipe'
  | 'diff'
  | 'terminal';

const WORKSPACE_NAV_FOCUSABLE = new Set<WorkspaceNavFocusable>([
  'ready',
  'review',
  'retro',
  'compare',
  'artifacts',
  'recipe',
  'diff',
  'terminal',
]);

export function workspaceNavCurrentForRoute<TFallback extends WorkspaceRouteWorkspace>(
  fallback: TFallback,
  routeWorkspace: WorkspaceRouteWorkspace | null | undefined,
): TFallback | WorkspaceNavFocusable {
  if (routeWorkspace && WORKSPACE_NAV_FOCUSABLE.has(routeWorkspace as WorkspaceNavFocusable)) {
    return routeWorkspace as WorkspaceNavFocusable;
  }
  return fallback;
}

export function workspaceForFamilySection(
  section: string | null | undefined,
): WorkspaceRouteWorkspace | undefined {
  const normalized = section?.trim().toLowerCase();
  if (normalized === 'compare') return 'compare';
  if (normalized === 'ledger') return 'diff';
  if (normalized === 'retros') return 'retro';
  if (normalized === 'evidence') return 'artifacts';
  if (normalized === 'runs') return 'run';
  if (normalized === 'focus') return 'family';
  return undefined;
}

export function familySectionRouteContextParams(
  section: string | null | undefined,
  decisionKind?: string | null | undefined,
): WorkspaceRouteContext {
  return workspaceRouteContextParams(workspaceForFamilySection(section), decisionKind, 'family');
}

export function workspaceRouteContextParams(
  workspace: string | null | undefined,
  decisionKind: string | null | undefined,
  fallbackWorkspace?: WorkspaceRouteWorkspace,
): WorkspaceRouteContext {
  const normalizedWorkspace = workspace?.trim().toLowerCase();
  const validRouteWorkspace = normalizedWorkspace
    ? WORKSPACE_ROUTE_WORKSPACES.has(normalizedWorkspace as WorkspaceRouteWorkspace)
    : false;
  const routeWorkspace =
    normalizedWorkspace && validRouteWorkspace
      ? (normalizedWorkspace as WorkspaceRouteWorkspace)
      : fallbackWorkspace;
  const normalizedDecisionKind = decisionKind?.trim().toLowerCase();
  return {
    ...(routeWorkspace ? { workspace: routeWorkspace } : {}),
    ...(normalizedDecisionKind ? { decisionKind: normalizedDecisionKind } : {}),
  };
}

export function decisionWorkspaceRouteParams(
  decisionKind: string | null | undefined,
): DecisionWorkspaceRouteParams {
  const normalized = decisionKind?.trim().toLowerCase();
  if (!normalized) return {};
  if (normalized === 'ready') return { workspace: 'ready', decisionKind: 'ready' };
  if (normalized === 'retrospective' || normalized === 'retro') {
    return { workspace: 'retro', decisionKind: 'retrospective' };
  }
  if (normalized === 'review' || normalized === 'no-change' || normalized === 'no_change') {
    return {
      workspace: 'review',
      decisionKind: normalized === 'no_change' ? 'no-change' : normalized,
    };
  }
  return {};
}

export function recipeWorkspaceParam(recipeRunId: string | null | undefined): string {
  const normalized = recipeRunId?.trim();
  if (normalized && normalized !== DECISION_EVIDENCE_RECIPE_RUN_PARAM) return normalized;
  return CURRENT_ARTIFACTS_RECIPE_RUN_PARAM;
}

export function recipeWorkspaceScopeLabel(
  recipeRunId: string | null | undefined,
): 'current' | 'selected' {
  const normalized = recipeRunId?.trim();
  if (
    normalized &&
    normalized !== DECISION_EVIDENCE_RECIPE_RUN_PARAM &&
    normalized !== CURRENT_ARTIFACTS_RECIPE_RUN_PARAM
  ) {
    return 'selected';
  }
  return 'current';
}

export function shouldPreserveArtifactForRecipeContext(
  recipeRunId: string | null | undefined,
  artifactPath: string | null | undefined,
): boolean {
  const normalizedRecipeRunId = recipeRunId?.trim();
  const normalizedArtifactPath = artifactPath?.trim();
  return Boolean(
    normalizedArtifactPath &&
    normalizedRecipeRunId &&
    normalizedRecipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  );
}

export function shouldPreserveArtifactForDecisionEvidenceContext(
  recipeRunId: string | null | undefined,
  artifactPath: string | null | undefined,
): boolean {
  const normalizedRecipeRunId = recipeRunId?.trim();
  const normalizedArtifactPath = artifactPath?.trim();
  return Boolean(
    normalizedArtifactPath &&
    (!normalizedRecipeRunId || normalizedRecipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM),
  );
}

export function terminalDetailsParamForWorkspaceNav(
  current: string | null | undefined,
): '1' | undefined {
  return current && current !== 'terminal' ? '1' : undefined;
}

export function workspaceArtifactPathParam(
  artifactPath: string | null | undefined,
): string | undefined {
  const normalized = artifactPath?.trim();
  return normalized || undefined;
}

export function familySectionParamForWorkspaceNav(
  current: string | null | undefined,
): 'focus' | 'compare' | 'ledger' | 'retros' | 'evidence' | undefined {
  if (!current) return undefined;
  if (current === 'compare') return 'compare';
  if (current === 'retro') return 'retros';
  if (current === 'artifacts') return 'evidence';
  if (current === 'diff') return 'ledger';
  if (
    current === 'ready' ||
    current === 'review' ||
    current === 'recipe' ||
    current === 'run' ||
    current === 'slot' ||
    current === 'terminal' ||
    current === 'pr'
  ) {
    return 'focus';
  }
  return undefined;
}

export function familyRouteContextForWorkspaceNav(
  current: string | null | undefined,
  decisionKind?: string | null | undefined,
): WorkspaceRouteContext {
  return familySectionRouteContextParams(familySectionParamForWorkspaceNav(current), decisionKind);
}

export function targetWorkspaceRouteContextParams(
  targetWorkspace: WorkspaceRouteWorkspace,
  decisionKind?: string | null | undefined,
): WorkspaceRouteContext {
  return workspaceRouteContextParams(targetWorkspace, decisionKind);
}

export function artifactFilterParamForWorkspaceNav(
  current: string | null | undefined,
): 'review' | 'diffs' | 'recipes' | 'visual' | undefined {
  if (current === 'ready' || current === 'review' || current === 'retro') return 'review';
  if (current === 'diff') return 'diffs';
  if (current === 'recipe') return 'recipes';
  if (current === 'compare') return 'visual';
  return undefined;
}

export function targetWorkspaceForArtifactRoute(
  recipeRunId: string | null | undefined,
  artifactFilter: string | null | undefined,
): Extract<WorkspaceRouteWorkspace, 'artifacts' | 'recipe' | 'compare'> {
  const normalizedFilter = artifactFilter?.trim().toLowerCase();
  const normalizedRecipeRunId = recipeRunId?.trim();
  if (normalizedFilter === 'visual') return 'compare';
  if (
    normalizedFilter === 'recipes' ||
    (normalizedRecipeRunId && normalizedRecipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM)
  ) {
    return 'recipe';
  }
  return 'artifacts';
}

export function artifactWorkspaceNavCurrent(
  recipeRunId: string | null | undefined,
  artifactFilter: string | null | undefined,
  visualPairCount: number,
): 'artifacts' | 'recipe' | 'compare' {
  if (artifactFilter === 'visual' && visualPairCount > 0) return 'compare';
  const normalizedRecipeRunId = recipeRunId?.trim();
  if (
    artifactFilter === 'recipes' ||
    (normalizedRecipeRunId && normalizedRecipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM)
  ) {
    return 'recipe';
  }
  return 'artifacts';
}

export function workspaceSignalTargetForDecisionLabel(
  label: string,
): 'diff' | 'artifacts' | 'compare' | null {
  const normalized = label.trim().toLowerCase();
  if (normalized === 'diff') return 'diff';
  if (
    normalized === 'visual pairs' ||
    normalized === 'before→after' ||
    normalized === 'before/after'
  ) {
    return 'compare';
  }
  if (normalized === 'evidence') return 'artifacts';
  return null;
}

export function artifactFilterParamForArtifactPath(
  artifactPath: string | null | undefined,
): 'diffs' | 'recipes' | 'visual' | undefined {
  const normalized = artifactPath?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (diffArtifactCandidate([{ path: normalized }])) return 'diffs';
  if (normalized.includes('recipe') || normalized.endsWith('/recipe.json')) return 'recipes';
  if (/\.(png|jpe?g|gif|webp|mp4|mov|m4v|webm)$/.test(normalized)) return 'visual';
  return undefined;
}

export function shouldPreserveArtifactForDiffContext(
  artifactPath: string | null | undefined,
): boolean {
  const normalizedArtifactPath = artifactPath?.trim();
  if (!normalizedArtifactPath) return false;
  return Boolean(diffArtifactCandidate([{ path: normalizedArtifactPath }]));
}
