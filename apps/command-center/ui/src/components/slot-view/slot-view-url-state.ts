import { buildHash, getHashParam, hashRoute } from '../../utils/url-state.js';

export type RecipeEvidenceMode = 'all' | 'node';
export type RecipeViewerMode = 'single' | 'compare';
export type ReviewDrawerMode = 'primary' | 'recipe';

export interface SlotViewUrlState {
  slotId: string;
  runId?: string;
  file?: string;
  resource?: string;
  recipeRun?: string;
  recipeDependency?: string;
  recipeNode?: string;
  recipeEvidenceMode?: RecipeEvidenceMode;
  recipeArtifact?: string | null;
  recipeViewerOpen?: boolean;
  recipeViewerMode?: RecipeViewerMode;
  recipeViewerPair?: number;
  reviewDrawerMode?: ReviewDrawerMode;
  historyOpen?: boolean;
  historyRun?: string;
}

export function isSlotViewHashForSlot(slotId: string, hash: string = location.hash): boolean {
  return hashRoute(hash) === `slot/${slotId}`;
}

export function slotViewHash(state: SlotViewUrlState): string {
  const params = new URLSearchParams();
  if (state.runId) params.set('runId', state.runId);
  if (state.file) params.set('file', state.file);
  if (state.resource) params.set('resource', state.resource);
  if (state.recipeRun) params.set('recipeRun', state.recipeRun);
  if (state.recipeDependency) params.set('recipeDependency', state.recipeDependency);
  if (state.recipeNode) params.set('recipeNode', state.recipeNode);
  if (state.recipeNode && state.recipeEvidenceMode)
    params.set('recipeEvidenceMode', state.recipeEvidenceMode);
  if (state.recipeArtifact) params.set('recipeArtifact', state.recipeArtifact);
  if (state.recipeViewerOpen) {
    params.set('recipeViewer', '1');
    if (state.recipeViewerMode === 'compare') {
      params.set('recipeViewerMode', 'compare');
      if (state.recipeViewerPair && state.recipeViewerPair > 0) {
        params.set('recipeViewerPair', String(state.recipeViewerPair));
      }
    }
  }
  if (state.reviewDrawerMode === 'recipe') params.set('reviewDrawer', 'recipe');
  if (state.historyOpen) {
    params.set('history', '1');
    if (state.historyRun) params.set('historyRun', state.historyRun);
  }
  return buildHash(`slot/${state.slotId}`, params);
}

export function getSlotViewHashParam(name: string, hash: string = location.hash): string | null {
  return getHashParam(name, hash);
}

export function requestedFileFromHash(hash?: string): string | null {
  return getSlotViewHashParam('file', hash);
}

export function requestedResourceFromHash(hash?: string): string | null {
  return getSlotViewHashParam('resource', hash);
}

export function requestedRunFromHash(hash?: string): string | null {
  return getSlotViewHashParam('runId', hash);
}

export function requestedRecipeRunFromHash(hash?: string): string | null {
  return getSlotViewHashParam('recipeRun', hash);
}

export function requestedRecipeDependencyFromHash(hash?: string): string | null {
  return getSlotViewHashParam('recipeDependency', hash);
}

export function requestedRecipeNodeFromHash(hash?: string): string | null {
  return getSlotViewHashParam('recipeNode', hash);
}

export function requestedRecipeArtifactFromHash(hash?: string): string | null {
  return getSlotViewHashParam('recipeArtifact', hash);
}

export function requestedRecipeEvidenceModeFromHash(hash?: string): RecipeEvidenceMode | null {
  const mode = getSlotViewHashParam('recipeEvidenceMode', hash);
  return mode === 'all' || mode === 'node' ? mode : null;
}

export function requestedRecipeViewerModeFromHash(hash?: string): RecipeViewerMode {
  return getSlotViewHashParam('recipeViewerMode', hash) === 'compare' ? 'compare' : 'single';
}

export function requestedReviewDrawerModeFromHash(hash?: string): ReviewDrawerMode | null {
  return getSlotViewHashParam('reviewDrawer', hash) === 'recipe' ? 'recipe' : null;
}
