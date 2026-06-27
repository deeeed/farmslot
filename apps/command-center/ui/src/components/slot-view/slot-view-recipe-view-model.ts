import { gatewayApiUrl } from '../../utils/gateway-origin.js';

import type { ArtifactRef, RecipeRunArtifactGroup } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';
import { desiredRecipeRunId, recipeRunIdExists } from '../shared/recipe-run-selection-model.js';

import { recipeNodeExists, selectedRecipeRunRequestId } from './slot-view-recipe-helpers.js';

export interface SlotViewRecipeHostLike {
  artifactManifest?: ArtifactRef[] | null;
  recipeJson?: string | null;
  runId?: string;
}

export function slotViewRecipeRunIdExists(
  recipeRuns: readonly Pick<RecipeRunArtifactGroup, 'id'>[],
  recipeRunId: string | null | undefined,
): recipeRunId is string {
  return recipeRunIdExists(recipeRuns, recipeRunId);
}

export function slotViewDesiredRecipeRunId(input: {
  recipeRuns: readonly Pick<RecipeRunArtifactGroup, 'id'>[];
  requestedRecipeRunId: string | null;
  pendingRecipeRunId: string;
  currentRecipeRunId: string;
  gatewaySelectedRecipeRunId: string | null;
}): string {
  return desiredRecipeRunId(input.recipeRuns, [
    input.requestedRecipeRunId,
    input.pendingRecipeRunId,
    input.currentRecipeRunId,
    input.gatewaySelectedRecipeRunId,
  ]);
}

export function slotViewSelectedRecipeFlowPath(input: {
  selectedRun: Pick<RecipeRunArtifactGroup, 'artifactManifest'> | null;
  requestedFlow: string | null;
}): string {
  const flows =
    input.selectedRun?.artifactManifest?.filter((artifact) => artifact.purpose === 'recipe-flow') ??
    [];
  return input.requestedFlow && flows.some((artifact) => artifact.path === input.requestedFlow)
    ? input.requestedFlow
    : '';
}

export function slotViewSelectedRecipeArtifactPath(input: {
  desiredRecipeArtifactPath: string | null;
  selectedRun: Pick<RecipeRunArtifactGroup, 'artifactManifest'> | null;
  recipeHost: SlotViewRecipeHostLike | null;
}): string | null {
  if (!input.desiredRecipeArtifactPath) return null;
  const hostHasArtifact =
    input.selectedRun?.artifactManifest?.some(
      (artifact) => artifact.path === input.desiredRecipeArtifactPath,
    ) ||
    input.recipeHost?.artifactManifest?.some(
      (artifact) => artifact.path === input.desiredRecipeArtifactPath,
    ) ||
    false;
  return hostHasArtifact ? input.desiredRecipeArtifactPath : null;
}

export function slotViewRecipeRunKindLabel(group: RecipeRunArtifactGroup): string {
  if (group.groupKind === 'latest-valid') return 'Promoted';
  if (group.groupKind === 'live-run') return 'Attempted';
  return 'Bundle';
}

export function slotViewRecipeRunStatusLabel(group: RecipeRunArtifactGroup): string {
  if (group.status === 'pass') return 'Valid';
  if (group.status === 'fail') return 'Failed';
  return 'Info';
}

export function slotViewRecipeRunStatusColor(group: RecipeRunArtifactGroup): string {
  if (group.status === 'pass') return colors.statusOk;
  if (group.status === 'fail') return colors.statusFail;
  return colors.textMuted;
}

export function slotViewRecipeRunHelpText(group: RecipeRunArtifactGroup | null): string {
  if (!group) {
    return 'Recipe package = task-level definition and review assets. Latest passing evidence = promoted successful run proof.';
  }
  if (group.groupKind === 'latest-valid') {
    return 'Latest passing evidence = promoted successful run proof backing the current evidence view.';
  }
  if (group.groupKind === 'live-run') {
    return 'Attempted run = inspectable execution attempt, not promoted as default evidence until it passes.';
  }
  return 'Recipe package = task-level definition and review assets. Latest passing evidence = promoted successful run proof.';
}

export function slotViewRecipeRunSourceDetail(
  group: RecipeRunArtifactGroup,
  taskFile?: string | null,
): string | null {
  if (!group.artifactRoot) return null;
  if (group.groupKind !== 'current-artifacts') return null;
  if (!taskFile) return null;
  const localArtifactsRoot = `${taskFile.slice(0, taskFile.lastIndexOf('/'))}/artifacts`;
  if (
    group.artifactRoot === localArtifactsRoot ||
    group.artifactRoot.startsWith(`${localArtifactsRoot}/`)
  ) {
    return 'Source: local cache';
  }
  return 'Source: worker bundle';
}

export function slotViewRecipeFlowArtifacts(recipeHost: SlotViewRecipeHostLike | null) {
  return (
    recipeHost?.artifactManifest?.filter(
      (artifact) =>
        artifact.purpose === 'recipe-flow' && artifact.path.startsWith('artifacts/recipe-flows/'),
    ) ?? []
  );
}

export function selectedSlotViewRecipeFlowArtifact(
  recipeHost: SlotViewRecipeHostLike | null,
  selectedRecipeFlowPath: string,
) {
  const flows = slotViewRecipeFlowArtifacts(recipeHost);
  if (flows.length === 0) return null;
  return flows.find((artifact) => artifact.path === selectedRecipeFlowPath) ?? null;
}

export function selectedSlotViewRecipeFlowLabel(
  recipeHost: SlotViewRecipeHostLike | null,
  selectedRecipeFlowPath: string,
): string {
  const selectedFlow = selectedSlotViewRecipeFlowArtifact(recipeHost, selectedRecipeFlowPath);
  return selectedFlow ? selectedFlow.path.replace(/^artifacts\/recipe-flows\//, '') : 'Main recipe';
}

export function selectedSlotViewRecipeArtifactLabel(
  selectedRecipeArtifactPath: string | null,
): string {
  if (!selectedRecipeArtifactPath) return 'None';
  return selectedRecipeArtifactPath.replace(/^artifacts\//, '');
}

export function slotViewRecipeJsonFallbackWarning(input: {
  selectedRun: RecipeRunArtifactGroup | null;
  recipeHostRecipeJson?: string | null;
  packageRunRecipeJson?: string | null;
}): string | null {
  if (
    !input.selectedRun ||
    input.selectedRun.groupKind === 'current-artifacts' ||
    input.recipeHostRecipeJson ||
    !input.packageRunRecipeJson
  ) {
    return null;
  }
  return 'Selected recipe run does not include its own recipe.json. Showing the bundle recipe as fallback; verify the evidence still matches this definition.';
}

export function slotViewRecipeArtifactUrl(input: {
  origin: string;
  runId?: string;
  linkedRunId?: string;
  artifactPath: string;
  artifactManifest?: ArtifactRef[] | null;
  selectedRun: Pick<RecipeRunArtifactGroup, 'id' | 'groupKind'> | null | undefined;
  artifactMirrorEpoch: number;
}): string {
  const params = new URLSearchParams({
    runId: input.runId ?? input.linkedRunId ?? '',
    path: input.artifactPath,
  });
  const recipeRunId = selectedRecipeRunRequestId(input.selectedRun);
  if (recipeRunId) params.set('recipeRunId', recipeRunId);
  const entry = input.artifactManifest?.find(
    (manifestEntry) => manifestEntry.path === input.artifactPath,
  );
  if (entry?.sha256) params.set('v', entry.sha256.slice(0, 12));
  else if (typeof entry?.sizeBytes === 'number') params.set('v', `s${entry.sizeBytes}`);
  if (typeof entry?.sizeBytes === 'number') params.set('vsize', String(entry.sizeBytes));
  if (input.artifactMirrorEpoch > 0) params.set('m', String(input.artifactMirrorEpoch));
  return gatewayApiUrl(`${input.origin}/api/run-artifact?${params.toString()}`);
}

export function selectedSlotViewRecipeArtifact(
  artifacts: ArtifactRef[],
  selectedRecipeArtifactPath: string | null,
) {
  if (artifacts.length === 0) return null;
  if (!selectedRecipeArtifactPath) return artifacts[0];
  return artifacts.find((artifact) => artifact.path === selectedRecipeArtifactPath) ?? artifacts[0];
}

export function slotViewRecipeNodeEvidenceState(input: {
  mode: 'all' | 'node';
  selectedNodeId: string;
  recipeJson: string | null;
  evidenceArtifacts: ArtifactRef[];
}): {
  mode: 'all' | 'node';
  nodeExists: boolean;
  hasEvidence: boolean;
} {
  if (input.mode === 'all' || !input.selectedNodeId) {
    return {
      mode: 'all',
      nodeExists: true,
      hasEvidence: input.evidenceArtifacts.length > 0,
    };
  }
  return {
    mode: 'node',
    nodeExists: recipeNodeExists(input.recipeJson, input.selectedNodeId),
    hasEvidence: input.evidenceArtifacts.length > 0,
  };
}
