import type {
  ArtifactRef,
  EvidenceManifestStandalone,
  RecipeRunArtifactGroup,
  Run,
} from '@farmslot/protocol';

import { createSlotViewRecipeHostEntry } from '../recipe/recipe-quality-hosts.js';
import type { LightboxItem, LightboxPair } from '../shared/media-lightbox-types.js';
import { selectedRecipeRun } from '../shared/recipe-run-selection-model.js';

import { slotViewReadyGateDecision } from './slot-view-model.js';
import { renderRecipeArtifactPreview } from './slot-view-recipe-artifact-renderers.js';
import {
  copySlotViewRecipeCommand,
  handleSlotViewRecipeExecutionComplete,
  startSlotViewRecipeExecution,
} from './slot-view-recipe-command-effects.js';
import { renderRecipeExecutionOverlay } from './slot-view-recipe-execution-renderers.js';
import {
  computeRecipeEvidenceArtifacts,
  effectiveRecipeJsonForSelection,
  type SlotViewRecipeEvidenceResult,
} from './slot-view-recipe-helpers.js';
import {
  clearedSlotViewRecipeLightboxScopeIndex,
  slotViewRecipeLightboxItems,
  slotViewRecipeLightboxPairs,
} from './slot-view-recipe-lightbox-model.js';
import {
  loadSelectedSlotViewRecipeArtifactPreview,
  loadSelectedSlotViewRecipeEvidenceManifest,
  loadSelectedSlotViewRecipeFlow,
} from './slot-view-recipe-load-effects.js';
import {
  renderRecipeEvidenceSection,
  renderRecipeFlowsList,
  renderSlotRecipePanel,
} from './slot-view-recipe-renderers.js';
import {
  refreshSlotViewArtifactMirror,
  refreshSlotViewRecipeRuns,
  resetSlotViewRecipePanelState,
} from './slot-view-recipe-run-effects.js';
import { renderRecipeRunsList } from './slot-view-recipe-run-list-renderers.js';
import {
  selectedSlotViewRecipeArtifact,
  selectedSlotViewRecipeFlowArtifact,
  slotViewRecipeArtifactUrl,
  slotViewRecipeFlowArtifacts,
  slotViewRecipeJsonFallbackWarning,
  slotViewRecipeNodeEvidenceState,
} from './slot-view-recipe-view-model.js';
import { SlotViewState } from './slot-view-state.js';

export abstract class SlotViewRecipePresenter extends SlotViewState {
  abstract _syncUrlState(): void;
  abstract _saveLayout(): void;
  abstract _refreshLinkedRun(prevRunStatus: string | null): Promise<string | null>;
  abstract _onResizeStart(type: 'review', event: MouseEvent): void;
  abstract _requestedRecipeRunFromUrl(): string | null;
  abstract _requestedRecipeArtifactFromUrl(): string | null;
  abstract _requestedRecipeFlowFromUrl(): string | null;

  _selectedRecipeRun(): RecipeRunArtifactGroup | null {
    return selectedRecipeRun(this._recipeRuns, this._selectedRecipeRunId);
  }

  _resetRecipePanelState() {
    resetSlotViewRecipePanelState(this);
  }

  _readyGateDecision(): Run['decisions'][number] | null {
    return slotViewReadyGateDecision(this._linkedRun);
  }

  _selectedRecipeFlowLabel(recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>): string {
    const selectedFlow = selectedSlotViewRecipeFlowArtifact(
      recipeHost,
      this._selectedRecipeFlowPath,
    );
    return selectedFlow
      ? selectedFlow.path.replace(/^artifacts\/recipe-flows\//, '')
      : 'Main recipe';
  }

  _selectedRecipeArtifactLabel(): string {
    if (!this._selectedRecipeArtifactPath) return 'None';
    return this._selectedRecipeArtifactPath.replace(/^artifacts\//, '');
  }

  _recipeFlowArtifacts(recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>) {
    return slotViewRecipeFlowArtifacts(recipeHost);
  }

  _selectedRecipeFlowArtifact(recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>) {
    return selectedSlotViewRecipeFlowArtifact(recipeHost, this._selectedRecipeFlowPath);
  }

  _effectiveRecipeJson(
    recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
  ): string | null {
    const packageRun = this._recipeRuns.find((group) => group.groupKind === 'current-artifacts');
    return effectiveRecipeJsonForSelection({
      selectedRecipeFlowJson: this._selectedRecipeFlowJson,
      recipeHostRecipeJson: recipeHost?.recipeJson,
      packageRunRecipeJson: packageRun?.recipeJson,
    });
  }

  _recipeJsonFallbackWarning(
    recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
  ): string | null {
    const selectedRun = this._selectedRecipeRun();
    const packageRun = this._recipeRuns.find((group) => group.groupKind === 'current-artifacts');
    return slotViewRecipeJsonFallbackWarning({
      selectedRun,
      recipeHostRecipeJson: recipeHost?.recipeJson,
      packageRunRecipeJson: packageRun?.recipeJson,
    });
  }

  async _loadSelectedRecipeFlow(recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>) {
    return loadSelectedSlotViewRecipeFlow(this, recipeHost);
  }

  _artifactUrl(
    recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
    artifactPath: string,
  ): string {
    return slotViewRecipeArtifactUrl({
      origin: window.location.origin,
      runId: recipeHost?.runId,
      linkedRunId: this._linkedRun?.id,
      artifactPath,
      artifactManifest: recipeHost?.artifactManifest,
      selectedRun: this._selectedRecipeRun(),
      artifactMirrorEpoch: this._artifactMirrorEpoch,
    });
  }

  async _refreshArtifactMirror(): Promise<void> {
    return refreshSlotViewArtifactMirror(this);
  }

  _recipeEvidenceArtifacts(
    recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
  ): SlotViewRecipeEvidenceResult {
    if (!recipeHost?.artifactManifest?.length) {
      return {
        allArtifacts: [],
        effectiveArtifacts: [],
        hiddenDiagnosticCount: 0,
        usedCuratedManifest: false,
        usedTypedManifest: false,
      };
    }
    const selectedRun = this._selectedRecipeRun();
    const usedTypedArtifactManifest = selectedRun?.usedTypedArtifactManifest ?? false;
    const recipeJson = this._effectiveRecipeJson(recipeHost);
    const artifactManifest = recipeHost.artifactManifest as ArtifactRef[];
    const evidenceManifest = this._selectedRecipeEvidenceManifest as EvidenceManifestStandalone[];
    if (
      this._recipeEvidenceCache &&
      this._recipeEvidenceCache.artifactManifest === artifactManifest &&
      this._recipeEvidenceCache.evidenceManifest === evidenceManifest &&
      this._recipeEvidenceCache.recipeRunId === (selectedRun?.id ?? null) &&
      this._recipeEvidenceCache.recipeJson === recipeJson &&
      this._recipeEvidenceCache.selectedNodeId === this._selectedRecipeNodeId &&
      this._recipeEvidenceCache.mode === this._recipeEvidenceMode &&
      this._recipeEvidenceCache.usedTypedArtifactManifest === usedTypedArtifactManifest
    ) {
      return this._recipeEvidenceCache.result;
    }
    const result = computeRecipeEvidenceArtifacts({
      artifactManifest,
      recipeJson,
      selectedNodeId: this._selectedRecipeNodeId,
      evidenceManifest,
      mode: this._recipeEvidenceMode,
      usedTypedArtifactManifest,
    });
    this._recipeEvidenceCache = {
      artifactManifest,
      evidenceManifest,
      recipeRunId: selectedRun?.id ?? null,
      recipeJson,
      selectedNodeId: this._selectedRecipeNodeId,
      mode: this._recipeEvidenceMode,
      usedTypedArtifactManifest,
      result,
    };
    return result;
  }

  _effectiveRecipeEvidenceArtifacts(
    recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
  ): ArtifactRef[] {
    return this._recipeEvidenceArtifacts(recipeHost).effectiveArtifacts;
  }

  _selectedRecipeArtifact(recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>) {
    return selectedSlotViewRecipeArtifact(
      this._effectiveRecipeEvidenceArtifacts(recipeHost),
      this._selectedRecipeArtifactPath,
    );
  }

  async _loadSelectedRecipeArtifactPreview(
    recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
  ) {
    return loadSelectedSlotViewRecipeArtifactPreview(this, recipeHost);
  }

  _recipeNodeEvidenceState(recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>): {
    mode: 'all' | 'node';
    nodeExists: boolean;
    hasEvidence: boolean;
  } {
    return slotViewRecipeNodeEvidenceState({
      mode: this._recipeEvidenceMode,
      selectedNodeId: this._selectedRecipeNodeId,
      recipeJson: this._effectiveRecipeJson(recipeHost),
      evidenceArtifacts: this._effectiveRecipeEvidenceArtifacts(recipeHost),
    });
  }

  _renderRecipeArtifactPreview(recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>) {
    return renderRecipeArtifactPreview(this, recipeHost);
  }

  async _loadSelectedRecipeEvidenceManifest(
    recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
  ) {
    return loadSelectedSlotViewRecipeEvidenceManifest(this, recipeHost);
  }

  _recipeLightboxItems(
    recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
  ): LightboxItem[] {
    if (!recipeHost) return [];
    return slotViewRecipeLightboxItems({
      artifacts: this._effectiveRecipeEvidenceArtifacts(recipeHost),
      scopePaths: this._recipeLightboxScopePaths,
      kindFilter: this._recipeEvidenceKindFilter,
      artifactUrl: (artifact) => this._artifactUrl(recipeHost, artifact.path),
    });
  }

  _recipeLightboxPairs(
    recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
  ): LightboxPair[] {
    if (!recipeHost) return [];
    return slotViewRecipeLightboxPairs({
      artifacts: this._effectiveRecipeEvidenceArtifacts(recipeHost),
      scopePaths: this._recipeLightboxScopePaths,
      artifactUrl: (artifact) => this._artifactUrl(recipeHost, artifact.path),
    });
  }

  _clearRecipeLightboxScope(
    recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>,
    path?: string | null,
  ): void {
    const index = clearedSlotViewRecipeLightboxScopeIndex(
      this._recipeLightboxItems(recipeHost),
      path,
    );
    this._recipeLightboxScopePaths = null;
    this._recipeLightboxScopeLabel = '';
    if (index !== null) this._recipeLightboxIndex = index;
  }

  async _refreshRecipeRuns(run: Run | null): Promise<void> {
    return refreshSlotViewRecipeRuns(this, run);
  }

  async _copyRecipeCommand(recipeArtifactPath = '', useSelectedRecipeRun = false) {
    return copySlotViewRecipeCommand(this, recipeArtifactPath, useSelectedRecipeRun);
  }

  _startRecipeExecution(label: string, recipeArtifactPath = '', useSelectedRecipeRun = false) {
    startSlotViewRecipeExecution(this, label, recipeArtifactPath, useSelectedRecipeRun);
  }

  _handleRecipeExecutionComplete(detail: { requestId?: string; exitCode?: number }) {
    handleSlotViewRecipeExecutionComplete(this, detail);
  }

  _renderRecipeRunsList() {
    return renderRecipeRunsList(this);
  }

  _renderRecipeFlowsList(recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>) {
    return renderRecipeFlowsList(this, recipeHost);
  }

  _renderRecipeEvidenceSection(recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>) {
    return renderRecipeEvidenceSection(this, recipeHost);
  }

  _renderRecipeExecutionOverlay(recipeHost: ReturnType<typeof createSlotViewRecipeHostEntry>) {
    return renderRecipeExecutionOverlay(this, recipeHost);
  }

  _renderSlotRecipePanel() {
    return renderSlotRecipePanel(this);
  }
}
