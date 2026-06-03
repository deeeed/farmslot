import type { createSlotViewRecipeHostEntry } from '../recipe/recipe-quality-hosts.js';

import { traceEntriesToEvidenceManifest } from './slot-view-live-effects.js';
import {
  isVisualRecipeArtifact,
  parseEvidenceManifestEntriesWithDiagnostics,
  recipeNodeExists,
} from './slot-view-recipe-helpers.js';
import type { SlotViewRecipePresenter } from './slot-view-recipe-presenter.js';

export async function loadSelectedSlotViewRecipeFlow(
  view: SlotViewRecipePresenter,
  recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
): Promise<void> {
  const loadToken = Symbol('recipe-flow-load');
  view._selectedRecipeFlowLoadToken = loadToken;
  const selectedFlow = view._selectedRecipeFlowArtifact(recipeHost);
  if (!selectedFlow) {
    if (loadToken !== view._selectedRecipeFlowLoadToken) return;
    view._selectedRecipeFlowJson = '';
    view._selectedRecipeFlowError = '';
    view._selectedRecipeFlowLoading = false;
    return;
  }
  view._selectedRecipeFlowLoading = true;
  view._selectedRecipeFlowError = '';
  try {
    const response = await fetch(view._artifactUrl(recipeHost, selectedFlow.path));
    if (loadToken !== view._selectedRecipeFlowLoadToken) return;
    if (!response.ok) throw new Error(`${response.status}`);
    const recipeFlowJson = await response.text();
    if (loadToken !== view._selectedRecipeFlowLoadToken) return;
    view._selectedRecipeFlowJson = recipeFlowJson;
    if (
      view._selectedRecipeNodeId &&
      !recipeNodeExists(view._selectedRecipeFlowJson, view._selectedRecipeNodeId)
    ) {
      view._selectedRecipeNodeId = '';
      view._recipeEvidenceMode = 'all';
      view._selectedRecipeArtifactPath = null;
      view._recipeEvidenceCache = null;
    }
  } catch (error) {
    if (loadToken !== view._selectedRecipeFlowLoadToken) return;
    view._selectedRecipeFlowJson = '';
    view._selectedRecipeFlowError = error instanceof Error ? error.message : String(error);
  } finally {
    if (loadToken === view._selectedRecipeFlowLoadToken) view._selectedRecipeFlowLoading = false;
  }
}

export async function loadSelectedSlotViewRecipeArtifactPreview(
  view: SlotViewRecipePresenter,
  recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
): Promise<void> {
  const loadToken = Symbol('recipe-artifact-preview-load');
  view._selectedRecipeArtifactPreviewLoadToken = loadToken;
  const artifact = view._selectedRecipeArtifact(recipeHost);
  if (!artifact) {
    if (loadToken !== view._selectedRecipeArtifactPreviewLoadToken) return;
    clearSelectedSlotViewRecipeArtifactPreview(view);
    return;
  }
  if (isVisualRecipeArtifact(artifact)) {
    if (loadToken !== view._selectedRecipeArtifactPreviewLoadToken) return;
    clearSelectedSlotViewRecipeArtifactPreview(view);
    return;
  }
  view._selectedRecipeArtifactLoading = true;
  view._selectedRecipeArtifactError = '';
  try {
    const response = await fetch(view._artifactUrl(recipeHost, artifact.path));
    if (loadToken !== view._selectedRecipeArtifactPreviewLoadToken) return;
    if (!response.ok) throw new Error(`${response.status}`);
    const artifactText = await response.text();
    if (loadToken !== view._selectedRecipeArtifactPreviewLoadToken) return;
    view._selectedRecipeArtifactText = artifactText;
  } catch (error) {
    if (loadToken !== view._selectedRecipeArtifactPreviewLoadToken) return;
    view._selectedRecipeArtifactText = '';
    view._selectedRecipeArtifactError = error instanceof Error ? error.message : String(error);
  } finally {
    if (loadToken === view._selectedRecipeArtifactPreviewLoadToken) {
      view._selectedRecipeArtifactLoading = false;
    }
  }
}

export async function loadSelectedSlotViewRecipeEvidenceManifest(
  view: SlotViewRecipePresenter,
  recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
): Promise<void> {
  const loadToken = Symbol('recipe-evidence-manifest-load');
  view._selectedRecipeEvidenceManifestLoadToken = loadToken;
  if (!recipeHost) {
    if (loadToken !== view._selectedRecipeEvidenceManifestLoadToken) return;
    view._selectedRecipeEvidenceManifest = [];
    view._recipeEvidenceCache = null;
    return;
  }
  const manifest = recipeHost.artifactManifest?.find((artifact) =>
    artifact.path.endsWith('evidence-manifest.json'),
  );
  const trace = recipeHost.artifactManifest?.find(
    (artifact) => artifact.path.split(/[\\/]/).pop() === 'trace.json',
  );
  if (!manifest && !trace) {
    if (loadToken !== view._selectedRecipeEvidenceManifestLoadToken) return;
    view._selectedRecipeEvidenceManifest = [];
    view._selectedRecipeEvidenceManifestDroppedVideoCount = 0;
    view._recipeEvidenceCache = null;
    return;
  }
  try {
    const artifact = manifest ?? trace;
    if (!artifact) return;
    const response = await fetch(view._artifactUrl(recipeHost, artifact.path));
    if (loadToken !== view._selectedRecipeEvidenceManifestLoadToken) return;
    if (!response.ok) throw new Error(String(response.status));
    const json = await response.json();
    if (loadToken !== view._selectedRecipeEvidenceManifestLoadToken) return;
    if (manifest) {
      const parsed = parseEvidenceManifestEntriesWithDiagnostics(json);
      view._selectedRecipeEvidenceManifest = parsed.entries;
      view._selectedRecipeEvidenceManifestDroppedVideoCount = parsed.droppedVideoEntryCount;
    } else {
      view._selectedRecipeEvidenceManifest = traceEntriesToEvidenceManifest(json);
      view._selectedRecipeEvidenceManifestDroppedVideoCount = 0;
    }
  } catch (err) {
    console.warn(
      '[slot-view] evidence manifest load failed:',
      err instanceof Error ? err.message : String(err),
    );
    if (loadToken !== view._selectedRecipeEvidenceManifestLoadToken) return;
    view._selectedRecipeEvidenceManifest = [];
    view._selectedRecipeEvidenceManifestDroppedVideoCount = 0;
  } finally {
    if (loadToken === view._selectedRecipeEvidenceManifestLoadToken) {
      view._recipeEvidenceCache = null;
    }
  }
}

function clearSelectedSlotViewRecipeArtifactPreview(view: SlotViewRecipePresenter): void {
  view._selectedRecipeArtifactText = '';
  view._selectedRecipeArtifactError = '';
  view._selectedRecipeArtifactLoading = false;
}
