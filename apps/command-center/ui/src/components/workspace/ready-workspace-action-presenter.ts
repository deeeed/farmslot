import type {
  ArtifactRef,
  GitBranchDiffResult,
  GitDiffResult,
  ReadyGateInputSnapshot,
  ReadyGatePayload,
  RecipeRunArtifactGroup,
  ReviewValidationDepth,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import {
  buildArtifactUrlResolver,
  rewriteMarkdownArtifactUrls,
} from '../../utils/artifact-markdown.js';
import { gatewayApiUrl, gatewayHttpOrigin } from '../../utils/gateway-origin.js';
import {
  currentRecoveryEpoch,
  isRecoveryEpochCurrent,
  waitForRecoveryHydration,
} from '../../utils/reconnect.js';
import { type LightboxItem, type LightboxPair } from '../shared/media-lightbox-types.js';
import { selectedRecipeRun } from '../shared/recipe-run-selection-model.js';

import {
  isReadyPublicationApproval,
  readyDecisionActionStateKey,
  readyDecisionSubmittingMessage,
  readyDecisionSuccessMessage,
  readyRefreshPublishPackageFeedback,
  type ReadyRefreshPublishPackageResult,
  readyResolveSelectionData,
  refreshedReadyEvidenceSelection,
} from './ready-workspace-action-model.js';
import {
  readyWorkspaceAllArtifacts,
  readyWorkspaceEvidenceArtifacts,
  readyWorkspacePackagePreviewArtifact,
  readyWorkspacePrimaryDiffArtifact,
  readyWorkspacePublishEvidenceArtifacts,
} from './ready-workspace-artifact-model.js';
import {
  type ReadyInputArtifact,
  readyWorkspaceInputArtifacts,
  readyWorkspaceInputItemCount,
  readyWorkspaceInputSnapshot,
  readyWorkspaceQualityItemCount,
} from './ready-workspace-inputs.js';
import {
  readyWorkspaceLightboxItems,
  readyWorkspaceLightboxPairs,
  readyWorkspaceLightboxSourceArtifacts,
  readyWorkspaceOpensInLightbox,
  selectedReadyWorkspaceLightboxRecipeRun,
} from './ready-workspace-lightbox.js';
import { renderReadyWorkspaceMarkdown } from './ready-workspace-markdown.js';
import type { ReviewRunnerChoice } from './ready-workspace-modal-renderers.js';
import {
  addReadyReviewLoop,
  createReadyReviewLoop,
  readyReviewLoopRequestPayload,
  readyRunnerLabel,
  removeReadyReviewLoop,
  setReadyReviewLoopDepth,
  setReadyReviewLoopRunner,
} from './ready-workspace-review-request-model.js';
import {
  excludeReadyEvidenceVideos,
  initialReadyEvidenceSelection,
  readyEvidenceSelectionKey,
  readyPublicationTarget,
  readyPublicationTargetKey,
  readyPublishEvidenceSet,
  selectedReadyEvidenceKeysForSubmit,
  setAllReadyEvidenceIncluded,
  setReadyEvidenceIncluded,
} from './ready-workspace-selection-model.js';
import { ReadyWorkspaceState } from './ready-workspace-state.js';
import { recipeRunArtifactUrl, workspaceArtifactBasename } from './workspace-artifacts.js';
import {
  parseReadyWorkspaceHashState,
  type ReadyWorkspaceHashWriteState,
  type ReadyWorkspaceTab,
  writeReadyWorkspaceHashState,
} from './workspace-url-state.js';

type TabId = ReadyWorkspaceTab;

const GATEWAY_BASE = gatewayHttpOrigin();

const DEV_FALLBACK_DIFF = `diff --git a/src/gate.ts b/src/gate.ts
index 1111111..2222222 100644
--- a/src/gate.ts
+++ b/src/gate.ts
@@ -1,5 +1,7 @@
 export function publishGate(status: string) {
-  return status === 'approved';
+  const locallyApproved = status === 'approved';
+  const reviewFresh = true;
+  return locallyApproved && reviewFresh;
 }
`;

export abstract class ReadyWorkspaceActionPresenter extends ReadyWorkspaceState {
  get _payload(): ReadyGatePayload | undefined {
    return this.decision?.payload as ReadyGatePayload | undefined;
  }

  get _currentRunner(): string {
    return this.runner?.trim() || this._payload?.independentReviews?.[0]?.runner?.trim() || 'same';
  }

  _runnerLabel(runner: string): string {
    return readyRunnerLabel(runner, this._currentRunner);
  }

  willUpdate() {
    if (!this._initialized && this.decision && this.slotId) {
      this._initialized = true;
      this._hydratePublicationTarget();
      void this._beginRecovery();
    }
    if (this.decision) this._syncDecisionActionState();
    if (this.decision) this._hydratePublicationTarget();
    if (this.decision) this._hydrateEvidenceSelection();
    if (this.hideRecipeTab && this._activeTab === 'recipe') {
      this._activeTab = this._payload?.prPackage ? 'pr-preview' : 'diff';
    }
    if (this._payload?.prPackage && !this._defaultPackageTabSelected && !this._hashTabRequested) {
      this._activeTab = 'pr-preview';
      this._defaultPackageTabSelected = true;
      this._syncViewStateToHash();
    }
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has('slotId') && this._initialized) {
      void this._beginRecovery();
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    this._readViewStateFromHash();
    window.addEventListener('hashchange', this._boundHashChange);
    window.addEventListener('keydown', this._boundKeydown);
    this._unsubConn = gateway.onConnectionChange((state) => {
      if (!this._initialized) return;
      if (this._usesMockData) return;
      if (state === 'disconnected') {
        this._recoveryPhase = 'stale';
        this._recoveryMessage = 'Waiting for gateway to restore ready-state data…';
        return;
      }
      if (state === 'connected' && this._recoveryPhase !== 'live') {
        void this._beginRecovery();
      }
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this._boundHashChange);
    window.removeEventListener('keydown', this._boundKeydown);
    this._unsubConn?.();
    this._splitResizer.disconnect();
    this._confirmTimer.clear();
  }

  _readViewStateFromHash(): void {
    const hashState = parseReadyWorkspaceHashState();
    this._suppressHashSync = true;
    try {
      if (hashState.tab) {
        this._activeTab = hashState.tab;
        this._hashTabRequested = true;
        this._defaultPackageTabSelected = true;
      }
      if (hashState.file) this._selectedFile = hashState.file;
      this._diffModalOpen = hashState.modal === 'diff';
      this._reviewModalOpen = hashState.modal === 'review';
      this._lightboxOpen = hashState.modal === 'lightbox';
      if (hashState.diffArtifact) {
        this._diffModalArtifactPath = hashState.diffArtifact;
        this._diffModalTitle = workspaceArtifactBasename(hashState.diffArtifact, 'Diff');
        this._diffModalText = '';
        this._diffModalUrl = this._usesMockData ? '' : this._artifactUrl(hashState.diffArtifact);
      }
      if (hashState.lightboxIndex !== undefined) this._lightboxIndex = hashState.lightboxIndex;
      this._lightboxRecipeRunId = hashState.lightboxRecipeRunId ?? null;
      if (hashState.recipePackageEvidenceCollapsed !== undefined) {
        this._recipePackageEvidenceCollapsed = hashState.recipePackageEvidenceCollapsed;
      }
    } finally {
      this._suppressHashSync = false;
    }
  }

  _syncViewStateToHash(): void {
    if (this._suppressHashSync) return;
    const nextState: ReadyWorkspaceHashWriteState = {
      tab: this._activeTab,
      file: this._selectedFile || undefined,
      recipePackageEvidenceCollapsed: this._recipePackageEvidenceCollapsed || undefined,
    };
    if (this._diffModalOpen) {
      nextState.modal = 'diff';
      nextState.diffArtifact = this._diffModalArtifactPath || undefined;
    } else if (this._reviewModalOpen) {
      nextState.modal = 'review';
    } else if (this._lightboxOpen) {
      nextState.modal = 'lightbox';
      nextState.lightboxIndex = this._lightboxIndex;
      nextState.lightboxRecipeRunId = this._lightboxRecipeRunId ?? undefined;
    }
    writeReadyWorkspaceHashState(nextState);
  }

  _setActiveTab(tab: TabId): void {
    this._activeTab = tab;
    this._syncViewStateToHash();
  }

  get _isRecovering(): boolean {
    return this._recoveryPhase !== 'live';
  }

  get _usesMockData(): boolean {
    return this.mockData || window.location.hash.startsWith('#dev/');
  }

  _artifactUrl(path: string, artifact?: Pick<ArtifactRef, 'sha256' | 'sizeBytes'>): string {
    const params = new URLSearchParams({
      runId: this.runId,
      path,
    });
    if (artifact?.sha256) params.set('v', artifact.sha256.slice(0, 12));
    else if (typeof artifact?.sizeBytes === 'number') params.set('v', `s${artifact.sizeBytes}`);
    if (typeof artifact?.sizeBytes === 'number') params.set('vsize', String(artifact.sizeBytes));
    return gatewayApiUrl(`${GATEWAY_BASE}/api/run-artifact?${params.toString()}`);
  }

  _recipeRunArtifactUrl(group: RecipeRunArtifactGroup, artifact: ArtifactRef): string {
    return recipeRunArtifactUrl(GATEWAY_BASE, this.runId, group, artifact);
  }

  _selectedRecipeRun(): RecipeRunArtifactGroup | null {
    return selectedRecipeRun(this.recipeRuns, this.selectedRecipeRunId);
  }

  _selectedRecipeRunArtifacts(): ArtifactRef[] {
    const group = this._selectedRecipeRun();
    return group?.artifactManifest ?? [];
  }

  _renderPrPreviewMarkdown(payload: ReadyGatePayload): string {
    const artifacts = this._allArtifacts(payload);
    const artifactByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
    const resolveUrl = buildArtifactUrlResolver(
      artifacts.map((artifact) => artifact.path),
      (artifactPath) => this._artifactUrl(artifactPath, artifactByPath.get(artifactPath)),
    );
    return renderReadyWorkspaceMarkdown(
      rewriteMarkdownArtifactUrls(payload.prPackage?.draftBody || '', resolveUrl),
    );
  }

  _allArtifacts(payload: ReadyGatePayload): ArtifactRef[] {
    return readyWorkspaceAllArtifacts(payload);
  }

  _evidenceArtifacts(payload: ReadyGatePayload): ArtifactRef[] {
    return readyWorkspaceEvidenceArtifacts(payload);
  }

  _qualityItemCount(payload: ReadyGatePayload): number {
    return readyWorkspaceQualityItemCount(payload);
  }

  _inputSnapshot(payload: ReadyGatePayload): ReadyGateInputSnapshot | null {
    return readyWorkspaceInputSnapshot(payload, this.run);
  }

  _inputItemCount(payload: ReadyGatePayload): number {
    return readyWorkspaceInputItemCount(payload, this.run, {
      legacyTaskPromptText: this._legacyTaskPromptText,
      legacyTaskPromptLoading: this._legacyTaskPromptLoading,
      legacyTaskPromptError: this._legacyTaskPromptError,
    });
  }

  _inputArtifacts(payload: ReadyGatePayload): ReadyInputArtifact[] {
    return readyWorkspaceInputArtifacts(payload, this.run, {
      legacyTaskPromptText: this._legacyTaskPromptText,
      legacyTaskPromptLoading: this._legacyTaskPromptLoading,
      legacyTaskPromptError: this._legacyTaskPromptError,
    });
  }

  _openInputArtifact(id: string): void {
    this._selectedInputArtifactId = id;
    this._inputArtifactViewerOpen = true;
    if (id === 'task-prompt' && !this._legacyTaskPromptText) {
      void this._loadLegacyTaskPrompt();
    }
  }

  async _loadLegacyTaskPrompt(): Promise<void> {
    const payload = this._payload;
    const input = payload ? this._inputSnapshot(payload) : null;
    if (!input?.taskFile || input.taskPrompt || this._legacyTaskPromptLoading) return;
    this._legacyTaskPromptLoading = true;
    this._legacyTaskPromptError = '';
    try {
      const params = new URLSearchParams({ runId: this.runId, path: 'TASK.md' });
      const response = await fetch(gatewayApiUrl(`/api/run-artifact?${params}`));
      if (!response.ok) throw new Error(`${response.status}`);
      this._legacyTaskPromptText = await response.text();
    } catch (error) {
      this._legacyTaskPromptError = error instanceof Error ? error.message : String(error);
    } finally {
      this._legacyTaskPromptLoading = false;
    }
  }

  _lightboxSourceArtifacts(payload: ReadyGatePayload): ArtifactRef[] {
    return readyWorkspaceLightboxSourceArtifacts({
      recipeRuns: this.recipeRuns,
      lightboxRecipeRunId: this._lightboxRecipeRunId,
      allArtifacts: this._allArtifacts(payload),
      scopePaths: this._lightboxScopePaths,
    });
  }

  _lightboxArtifactUrl(artifact: ArtifactRef): string {
    const recipeRun = selectedReadyWorkspaceLightboxRecipeRun(
      this.recipeRuns,
      this._lightboxRecipeRunId,
    );
    if (recipeRun) return this._recipeRunArtifactUrl(recipeRun, artifact);
    return this._artifactUrl(artifact.path, artifact);
  }

  _lightboxItems(payload: ReadyGatePayload): LightboxItem[] {
    return readyWorkspaceLightboxItems(this._lightboxSourceArtifacts(payload), (artifact) =>
      this._lightboxArtifactUrl(artifact),
    );
  }

  _lightboxPairs(payload: ReadyGatePayload): LightboxPair[] {
    return readyWorkspaceLightboxPairs(this._lightboxSourceArtifacts(payload), (artifact) =>
      this._lightboxArtifactUrl(artifact),
    );
  }

  _openArtifact(
    payload: ReadyGatePayload,
    artifact: ArtifactRef,
    scope?: { paths: string[]; label: string },
  ) {
    this._lightboxRecipeRunId = null;
    this._openLightboxArtifact(payload, artifact, scope);
  }

  _openRecipeRunArtifact(
    payload: ReadyGatePayload,
    group: RecipeRunArtifactGroup,
    artifact: ArtifactRef,
    scope?: { paths: string[]; label: string },
  ) {
    this._lightboxRecipeRunId = group.id;
    this._openLightboxArtifact(payload, artifact, scope);
  }

  _openLightboxArtifact(
    payload: ReadyGatePayload,
    artifact: ArtifactRef,
    scope?: { paths: string[]; label: string },
  ) {
    this._lightboxScopePaths = scope?.paths?.length ? scope.paths : null;
    this._lightboxScopeLabel = scope?.paths?.length ? scope.label : '';
    const index = this._lightboxItems(payload).findIndex((item) => item.path === artifact.path);
    if (index < 0) return;
    this._lightboxIndex = index;
    const pairIndex = this._lightboxPairs(payload).findIndex(
      (pair) => pair.before.path === artifact.path || pair.after.path === artifact.path,
    );
    if (pairIndex >= 0) {
      this._lightboxPairIndex = pairIndex;
      this._lightboxMode = 'compare';
    } else {
      this._lightboxMode = 'single';
    }
    this._lightboxOpen = true;
    this._syncViewStateToHash();
  }

  _clearLightboxScope(payload: ReadyGatePayload, path?: string | null) {
    this._lightboxScopePaths = null;
    this._lightboxScopeLabel = '';
    this._lightboxRecipeRunId = null;
    if (path) {
      const index = this._lightboxItems(payload).findIndex((item) => item.path === path);
      if (index >= 0) this._lightboxIndex = index;
    }
  }

  _opensInLightbox(artifact: Pick<ArtifactRef, 'path'>): boolean {
    return readyWorkspaceOpensInLightbox(artifact);
  }

  _packagePreviewArtifact(payload: ReadyGatePayload): ArtifactRef | undefined {
    return readyWorkspacePackagePreviewArtifact(payload);
  }

  _openDiffModal(
    title: string,
    artifact?: Pick<ArtifactRef, 'path' | 'sha256' | 'sizeBytes'>,
  ): void {
    this._diffModalTitle = title;
    this._diffModalText = this._usesMockData
      ? this._fileDiff || DEV_FALLBACK_DIFF
      : artifact
        ? ''
        : this._fileDiff;
    this._diffModalUrl =
      !this._usesMockData && artifact ? this._artifactUrl(artifact.path, artifact) : '';
    this._diffModalArtifactPath = artifact?.path ?? '';
    this._diffModalOpen = true;
    this._syncViewStateToHash();
  }

  _primaryDiffArtifact(payload: ReadyGatePayload): ArtifactRef | undefined {
    return readyWorkspacePrimaryDiffArtifact(payload);
  }

  async _beginRecovery() {
    if (this._usesMockData) {
      this._diffFiles = [{ path: 'src/gate.ts', status: 'M', additions: 2, deletions: 1 }];
      if (!this._selectedFile) this._selectedFile = 'src/gate.ts';
      this._fileDiff = DEV_FALLBACK_DIFF;
      this._diffError =
        'Mock data mode: live branch diff hydration is disabled for the dev harness.';
      this._recoveryPhase = 'live';
      this._recoveryMessage = '';
      return;
    }
    if (!this.slotId || gateway.connectionState !== 'connected') {
      this._recoveryPhase = 'stale';
      this._recoveryMessage = 'Waiting for gateway to restore ready-state data…';
      return;
    }
    const epoch = currentRecoveryEpoch();
    this._recoveryEpoch = epoch;
    this._recoveryPhase = 'rehydrating';
    this._recoveryMessage = 'Refreshing ready workspace from gateway…';
    const hydrated = await waitForRecoveryHydration(epoch);
    if (!hydrated || this._recoveryEpoch !== epoch) return;
    await this._loadBranchDiff(epoch);
  }

  // ─── Data loading ───

  async _loadBranchDiff(epoch = this._recoveryEpoch || currentRecoveryEpoch()) {
    if (!this.slotId) return;
    this._diffLoading = true;
    try {
      const result = await gateway.request<GitBranchDiffResult>(Methods.GIT_BRANCH_DIFF, {
        slotId: this.slotId,
        base: 'main',
      });
      if (epoch !== this._recoveryEpoch || !isRecoveryEpochCurrent(epoch)) return;
      this._diffError = '';
      this._diffFiles = result.files;
      const selected =
        this._selectedFile && result.files.some((file) => file.path === this._selectedFile)
          ? this._selectedFile
          : result.files[0]?.path;
      if (selected) this._selectFile(selected);
    } catch (err) {
      if (epoch !== this._recoveryEpoch || !isRecoveryEpochCurrent(epoch)) return;
      console.error('[ready-workspace] branch diff failed:', err);
      if (this._payload?.prPackage) {
        this._diffFiles = [];
        this._selectedFile = '';
        this._fileDiff = '';
        this._diffError =
          'Live slot diff is unavailable. Review the immutable package snapshot and artifacts above; retry diff after the slot is reachable.';
        this._recoveryPhase = 'live';
        this._recoveryMessage = '';
        return;
      }
      this._recoveryPhase = 'error';
      this._recoveryMessage = 'Ready workspace failed to recover — retry when ready.';
    } finally {
      if (epoch === this._recoveryEpoch) this._diffLoading = false;
      if (
        epoch === this._recoveryEpoch &&
        isRecoveryEpochCurrent(epoch) &&
        this._recoveryPhase !== 'error'
      ) {
        this._recoveryPhase = 'live';
        this._recoveryMessage = '';
      }
    }
  }

  async _selectFile(filePath: string) {
    this._selectedFile = filePath;
    this._syncViewStateToHash();
    this._fileDiffLoading = true;
    this._fileDiff = '';
    try {
      const result = await gateway.request<GitDiffResult>(Methods.GIT_DIFF, {
        slotId: this.slotId,
        path: filePath,
        base: 'main',
      });
      this._fileDiff = result.diff;
      if (this._diffModalOpen && !this._diffModalUrl) {
        this._diffModalTitle = `${workspaceArtifactBasename(filePath)} diff`;
        this._diffModalText = result.diff;
      }
    } catch (err) {
      console.error('[ready-workspace] file diff failed:', err);
    } finally {
      this._fileDiffLoading = false;
    }
  }

  // ─── Actions ───

  _hydratePublicationTarget() {
    const payload = this._payload;
    if (!payload) return;
    const key = readyPublicationTargetKey({ decisionId: this.decision?.id, payload });
    if (key === this._publicationTargetKey) return;
    this._publicationTargetKey = key;
    this._publicationTarget = readyPublicationTarget(payload);
  }

  _syncDecisionActionState(): void {
    const key = readyDecisionActionStateKey(this.decision);
    if (key === this._decisionActionStateKey) return;
    this._decisionActionStateKey = key;
    this._acting = false;
    this._pendingConfirm = null;
    this._actionMessage = '';
    this._actionTone = '';
  }

  _hydrateEvidenceSelection() {
    const payload = this._payload;
    if (!payload?.prPackage) return;
    const key = readyEvidenceSelectionKey({ decisionId: this.decision?.id, payload });
    if (key === this._evidenceSelectionKey) return;
    this._evidenceSelectionKey = key;
    this._selectedEvidenceKeys = initialReadyEvidenceSelection(
      payload,
      this._publishEvidenceArtifacts(payload).map((artifact) => artifact.path),
    );
  }

  _publishEvidenceArtifacts(payload: ReadyGatePayload): ArtifactRef[] {
    return readyWorkspacePublishEvidenceArtifacts(payload);
  }

  _publishEvidenceSet(payload: ReadyGatePayload): Set<string> {
    return readyPublishEvidenceSet(
      this._selectedEvidenceKeys,
      this._publishEvidenceArtifacts(payload).map((artifact) => artifact.path),
    );
  }

  _isPublishEvidenceArtifact(payload: ReadyGatePayload, artifact: ArtifactRef): boolean {
    return this._publishEvidenceArtifacts(payload).some(
      (candidate) => candidate.path === artifact.path,
    );
  }

  _setEvidenceIncluded(payload: ReadyGatePayload, artifact: ArtifactRef, included: boolean): void {
    this._selectedEvidenceKeys = setReadyEvidenceIncluded({
      selectedEvidenceKeys: this._selectedEvidenceKeys,
      candidateKeys: this._publishEvidenceArtifacts(payload).map((entry) => entry.path),
      artifactPath: artifact.path,
      included,
    });
  }

  _setAllEvidenceIncluded(payload: ReadyGatePayload, included: boolean): void {
    this._selectedEvidenceKeys = setAllReadyEvidenceIncluded(
      this._publishEvidenceArtifacts(payload).map((artifact) => artifact.path),
      included,
    );
  }

  _excludeEvidenceVideos(payload: ReadyGatePayload): void {
    this._selectedEvidenceKeys = excludeReadyEvidenceVideos({
      selectedEvidenceKeys: this._selectedEvidenceKeys,
      candidates: this._publishEvidenceArtifacts(payload),
    });
  }

  _selectedEvidenceKeysForSubmit(payload: ReadyGatePayload): string[] {
    return selectedReadyEvidenceKeysForSubmit(
      this._selectedEvidenceKeys,
      this._publishEvidenceArtifacts(payload).map((artifact) => artifact.path),
    );
  }

  _confirmAction(actionId: string) {
    if (this._isRecovering) return;
    if (actionId === 'ready' || actionId === 'approve-publish' || actionId.startsWith('request-')) {
      void this._resolve(actionId);
      return;
    }
    this._confirmTimer.confirm(actionId, () => this._resolve(actionId));
  }

  _openReviewRequestModal() {
    if (this._isRecovering || this._acting) return;
    this._reviewLoops = [createReadyReviewLoop(this._nextReviewLoopId++, this._currentRunner)];
    this._reviewModalOpen = true;
    this._syncViewStateToHash();
  }

  _closeReviewRequestModal() {
    this._reviewModalOpen = false;
    this._syncViewStateToHash();
  }

  _addReviewLoop() {
    const next = addReadyReviewLoop({
      loops: this._reviewLoops,
      nextId: this._nextReviewLoopId,
      currentRunner: this._currentRunner,
    });
    this._reviewLoops = next.loops;
    this._nextReviewLoopId = next.nextId;
  }

  _removeReviewLoop(id: number) {
    this._reviewLoops = removeReadyReviewLoop(this._reviewLoops, id);
  }

  _setReviewLoopRunner(id: number, runner: ReviewRunnerChoice) {
    this._reviewLoops = setReadyReviewLoopRunner(this._reviewLoops, id, runner);
  }

  _setReviewLoopDepth(id: number, validationDepth: ReviewValidationDepth) {
    this._reviewLoops = setReadyReviewLoopDepth(this._reviewLoops, id, validationDepth);
  }

  async _submitReviewRequest() {
    const request = readyReviewLoopRequestPayload(this._reviewLoops, this._currentRunner);
    this._reviewModalOpen = false;
    await this._resolve('request-extra-review', {
      reviewRequest: {
        extraLoopsRequested: request.loops.length,
        requireCrossRunner: request.requireCrossRunner,
        loops: request.loops,
      },
    });
  }

  async _resolve(actionId: string, extraSelectionData: Record<string, unknown> = {}) {
    if (this._isRecovering) return;
    this._acting = true;
    const payload = this._payload;
    const approving = isReadyPublicationApproval(actionId, !!payload?.prPackage);
    this._actionMessage = readyDecisionSubmittingMessage(approving);
    this._actionTone = '';
    try {
      await gateway.request(Methods.RUN_RESOLVE_DECISION, {
        runId: this.runId,
        decisionId: this.decision.id,
        actionId,
        selectionData: readyResolveSelectionData({
          payload,
          publicationTarget: this._publicationTarget,
          selectedEvidenceKeys: payload ? this._selectedEvidenceKeysForSubmit(payload) : [],
          extraSelectionData,
        }),
      });
      this._actionMessage = readyDecisionSuccessMessage(approving);
      this._actionTone = 'success';
    } catch (err) {
      console.error('[ready-workspace] resolve failed:', err);
      this._actionMessage = `Failed to submit decision: ${err instanceof Error ? err.message : String(err)}`;
      this._actionTone = 'error';
      this._acting = false;
    }
  }

  async _refreshPublishPackage(payload: ReadyGatePayload) {
    if (this._refreshingPackage || this._acting || this._isRecovering || !payload.prPackage) return;
    this._refreshingPackage = true;
    this._actionMessage = 'Refreshing publish package…';
    this._actionTone = '';
    try {
      const result = (await gateway.request(Methods.RUN_REFRESH_PUBLISH_PACKAGE, {
        runId: this.runId,
        decisionId: this.decision.id,
        selectedEvidenceKeys: this._selectedEvidenceKeysForSubmit(payload),
        publicationTarget: this._publicationTarget,
      })) as ReadyRefreshPublishPackageResult;
      const nextSelection = refreshedReadyEvidenceSelection(result);
      if (nextSelection) this._selectedEvidenceKeys = nextSelection;
      const feedback = readyRefreshPublishPackageFeedback(result);
      this._actionMessage = feedback.message;
      this._actionTone = feedback.tone;
    } catch (err) {
      console.error('[ready-workspace] refresh publish package failed:', err);
      this._actionMessage = `Failed to refresh package: ${err instanceof Error ? err.message : String(err)}`;
      this._actionTone = 'error';
    } finally {
      this._refreshingPackage = false;
    }
  }
}
