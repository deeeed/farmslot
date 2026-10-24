import type {
  ArtifactRef,
  GitBranchDiffResult,
  GitDiffResult,
  ReadyGateInputSnapshot,
  ReadyGatePayload,
  RecipeRunArtifactGroup,
  RunRefreshPublishPackageResult,
} from '@farmslot/protocol';
import {
  buildRunResolveDecisionParams,
  evidenceAttestationAvailable,
  Methods,
  publicationApprovalReasonFields,
  withArtifactBundleDigest,
} from '@farmslot/protocol';
import {
  buildArtifactUrlResolver,
  ReviewDispatchViewModel,
  reviewLineagesForRun,
} from '@farmslot/review-dispatch';

import { gateway } from '../../gateway-client.js';
import {
  DECISION_RESOLVE_SLOW_MS,
  DECISION_RESOLVE_TIMEOUT_MS,
  GatewayRequestTimeoutError,
  transferBoundRequestOptions,
} from '../../gateway-request-timeout.js';
import { rewriteMarkdownArtifactUrls } from '../../utils/artifact-markdown.js';
import { diffSelectionHandOff, visibleDiffSelection } from '../../utils/diff-test-filter.js';
import { gatewayHttpFetch, gatewayResourceUrl } from '../../utils/gateway-origin.js';
import {
  currentRecoveryEpoch,
  isRecoveryEpochCurrent,
  waitForRecoveryHydration,
} from '../../utils/reconnect.js';
import { DiffTestFilterController } from '../shared/diff-test-filter-controller.js';
import { type LightboxItem, type LightboxPair } from '../shared/media-lightbox-types.js';
import { selectedRecipeRun } from '../shared/recipe-run-selection-model.js';
import {
  committedReviewBranchDiffRequest,
  committedReviewFileDiffRequest,
} from '../slot-view/slot-view-branch-model.js';

import {
  isReadyPublicationApproval,
  readyActionRequiresConfirmation,
  readyDecisionActionStateKey,
  readyDecisionSubmittingMessage,
  readyDecisionSuccessMessage,
  readyRefreshPublishPackageFeedback,
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
import { ReadyWorkspaceQueries } from './ready-workspace-queries.js';
import {
  excludeReadyEvidenceVideos,
  initialReadyEvidenceSelection,
  readyEvidenceSelectionKey,
  readyPrDescription,
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

type DecisionOutcome =
  | { kind: 'applied' }
  | { kind: 'other'; action: string }
  | { kind: 'pending' }
  | { kind: 'unknown' };

export abstract class ReadyWorkspaceActionPresenter extends ReadyWorkspaceState {
  readonly _queries = new ReadyWorkspaceQueries(this);
  private _commandRequest: object | undefined;
  private _fileDiffRequest?: object;

  get _gateDecision() {
    return this._usesMockData ? this.decision : this._queries.decision;
  }

  get _canonicalRun() {
    return this._usesMockData
      ? this.run
      : this._queries.run.belongsToWorkspace && this._queries.run.state.data?.run.id === this.runId
        ? this._queries.run.state.data.run
        : null;
  }

  override get _packagePending(): boolean {
    const decision = this._gateDecision;
    return (
      decision?.payload?.kind === 'ready' &&
      !decision.payload.prPackage &&
      Boolean(decision.payloadTrimmed?.includes('prPackage'))
    );
  }

  get _actionsPaused(): boolean {
    return this.actionsBlocked || this._packagePending || !this._queries.ready;
  }

  _sharedWorkspaceQueriesChanged(): void {
    this.requestUpdate();
  }

  _retireWorkspaceCommands(): void {
    this._commandRequest = undefined;
    this._acting = false;
    this._refreshingPackage = false;
    this._pendingConfirm = null;
    this._actionMessage = '';
    this._actionTone = '';
    this._pendingPackageSelection = undefined;
    this._selectedEvidenceKeys = null;
    this._evidenceSelectionKey = '';
    this._publicationTargetKey = '';
    this._decisionActionStateKey = '';
    this._evidenceAttestationReason = '';
    this._publicationTarget = 'ready';
    this._fileDiffRequest = undefined;
    this._selectedFile = '';
    this._diffError = '';
    this._diffTestPatterns = null;
    this._diffModalText = '';
    this._diffModalUrl = '';
    this._fileDiffLoading = false;
    this._diffLoading = false;
    this._initialized = false;
    this._diffFiles = [];
    this._fileDiff = '';
    this._diffModalOpen = false;
    this._legacyTaskPromptText = '';
    this._legacyTaskPromptLoading = false;
    this._legacyTaskPromptError = '';
    this._reviewModalOpen = false;
    this._inputArtifactViewerOpen = false;
    this._confirmTimer.clear();
  }

  _beginWorkspaceCommand() {
    if (this._commandRequest || this._acting || this._refreshingPackage) return;
    try {
      if (this._actionsPaused || this._isRecovering)
        throw new Error('Wait for current run and evidence reads before acting.');
      const decision = this._queries.requireDecision();
      const request = {};
      const captured = this._queries.capture();
      this._commandRequest = request;
      return {
        decision,
        current: () => this._commandRequest === request && captured.current(),
        finish: () => {
          if (this._commandRequest !== request || !captured.ownsView()) return;
          this._commandRequest = undefined;
          this._acting = false;
          this._refreshingPackage = false;
        },
      };
    } catch (error) {
      this._actionMessage = error instanceof Error ? error.message : String(error);
      this._actionTone = 'error';
      return;
    }
  }

  /** A failed command may have committed despite losing its reply. */
  private async _decisionOutcome(decisionId: string, actionId: string): Promise<DecisionOutcome> {
    const state = await this._queries.run.retry();
    if (!this._queries.run.ready || state.status !== 'ready' || !state.data)
      return { kind: 'unknown' };
    const current = state.data.run.decisions.find(({ id }) => id === decisionId);
    if (!current) return { kind: 'unknown' };
    if (!current.resolvedAt) return { kind: 'pending' };
    return current.resolvedAction === actionId
      ? { kind: 'applied' }
      : { kind: 'other', action: current.resolvedAction ?? 'another action' };
  }

  readonly _testFilter = new DiffTestFilterController(this, {
    patterns: () => this._diffTestPatterns,
    onChange: () => this._onHideTestsChanged(),
  });

  get _payload(): ReadyGatePayload | undefined {
    const payload = this._gateDecision?.payload;
    return payload?.kind === 'ready' ? payload : undefined;
  }

  get _currentRunner(): string {
    return this.runner?.trim() || this._payload?.reviews?.[0]?.runner?.trim() || 'same';
  }

  _runnerLabel(runner: string): string {
    return runner.charAt(0).toUpperCase() + runner.slice(1);
  }

  willUpdate() {
    this._queries.sync();
    if (!this._initialized && this._gateDecision && this.slotId) {
      this._initialized = true;
      this._hydratePublicationTarget();
      void this._beginRecovery();
    }
    if (this._gateDecision) this._syncDecisionActionState();
    if (this._gateDecision) this._hydratePublicationTarget();
    if (this._gateDecision) this._hydrateEvidenceSelection();
    this._applyPendingPackageSelection();
    if (this.hideRecipeTab && this._activeTab === 'recipe') {
      this._activeTab = this._payload?.prPackage ? 'evidence' : 'diff';
    }
    if (
      (this._payload?.prPackage || this._packagePending) &&
      !this._defaultPackageTabSelected &&
      !this._hashTabRequested
    ) {
      this._activeTab = 'evidence';
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
    return !this._gateDecision?.resolvedAt && this._recoveryPhase !== 'live';
  }

  get _usesMockData(): boolean {
    return this.mockData || window.location.hash.startsWith('#dev/');
  }

  _artifactUrl(
    path: string,
    artifact?: Pick<ArtifactRef, 'sha256' | 'sizeBytes' | 'bundleDigest'>,
  ): string {
    const params = new URLSearchParams({
      runId: this.runId,
      path,
    });
    if (artifact?.sha256) params.set('v', artifact.sha256.slice(0, 12));
    else if (typeof artifact?.sizeBytes === 'number') params.set('v', `s${artifact.sizeBytes}`);
    if (typeof artifact?.sizeBytes === 'number') params.set('vsize', String(artifact.sizeBytes));
    return gatewayResourceUrl(
      withArtifactBundleDigest(
        `/api/run-artifact?${params.toString()}`,
        artifact?.bundleDigest ?? this._payload?.prPackage?.artifactBundle?.bundleDigest,
      ),
    );
  }

  _recipeRunArtifactUrl(group: RecipeRunArtifactGroup, artifact: ArtifactRef): string {
    return recipeRunArtifactUrl(this.runId, group, artifact);
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
      rewriteMarkdownArtifactUrls(readyPrDescription(payload).body, resolveUrl),
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
    return readyWorkspaceInputSnapshot(payload, this._canonicalRun);
  }

  _inputItemCount(payload: ReadyGatePayload): number {
    return readyWorkspaceInputItemCount(payload, this._canonicalRun, {
      legacyTaskPromptText: this._legacyTaskPromptText,
      legacyTaskPromptLoading: this._legacyTaskPromptLoading,
      legacyTaskPromptError: this._legacyTaskPromptError,
    });
  }

  _inputArtifacts(payload: ReadyGatePayload): ReadyInputArtifact[] {
    return readyWorkspaceInputArtifacts(payload, this._canonicalRun, {
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
    const captured = this._queries.capture();
    this._legacyTaskPromptLoading = true;
    this._legacyTaskPromptError = '';
    try {
      const params = new URLSearchParams({ runId: this.runId, path: 'TASK.md' });
      const response = await gatewayHttpFetch(`/api/run-artifact?${params}`);
      if (!response.ok) throw new Error(`${response.status}`);
      const text = await response.text();
      if (captured.current()) this._legacyTaskPromptText = text;
    } catch (error) {
      if (!captured.current()) return;
      this._legacyTaskPromptError = error instanceof Error ? error.message : String(error);
    } finally {
      if (captured.ownsView()) this._legacyTaskPromptLoading = false;
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
    if (this._gateDecision?.resolvedAt) {
      this._recoveryPhase = 'live';
      this._recoveryMessage = '';
      return;
    }
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
    const captured = this._queries.capture();
    const packageHash = this._payload?.prPackage?.packageHash;
    const current = () =>
      captured.current() && this._payload?.prPackage?.packageHash === packageHash;
    this._diffLoading = true;
    try {
      const result = await gateway.request<GitBranchDiffResult>(
        Methods.GIT_BRANCH_DIFF,
        committedReviewBranchDiffRequest(
          this.slotId,
          this._payload?.prPackage?.reviewSnapshot?.baseRef,
          this._payload?.prPackage?.reviewSnapshot,
        ),
      );
      if (!current() || epoch !== this._recoveryEpoch || !isRecoveryEpochCurrent(epoch)) return;
      this._diffError = '';
      this._diffFiles = result.files;
      this._diffTestPatterns = result.testFilePatterns ?? null;
      const selected = visibleDiffSelection(this._diffSplit().visible, this._selectedFile);
      if (selected) {
        this._selectFile(selected);
      } else {
        // Nothing visible: drop the previous selection and its diff so showing
        // tests fetches this branch's file instead of reusing a stale one.
        this._selectedFile = '';
        this._fileDiff = '';
      }
    } catch (err) {
      if (!current() || epoch !== this._recoveryEpoch || !isRecoveryEpochCurrent(epoch)) return;
      console.error('[ready-workspace] branch diff failed:', err);
      if (this._payload?.prPackage) {
        this._diffFiles = [];
        this._diffTestPatterns = null;
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
      if (captured.ownsView() && epoch === this._recoveryEpoch) this._diffLoading = false;
      if (
        current() &&
        epoch === this._recoveryEpoch &&
        isRecoveryEpochCurrent(epoch) &&
        this._recoveryPhase !== 'error'
      ) {
        this._recoveryPhase = 'live';
        this._recoveryMessage = '';
      }
    }
  }

  _diffSplit() {
    return this._testFilter.split(this._diffFiles);
  }

  /**
   * A newly hidden test file hands the viewer to the first visible file; a
   * selection whose diff is not loaded (dropped while everything was hidden)
   * is fetched again; nothing listed drops the selection.
   */
  _onHideTestsChanged(): void {
    const handOff = diffSelectionHandOff(
      this._diffSplit().visible,
      this._selectedFile,
      Boolean(this._fileDiff) || this._fileDiffLoading,
    );
    if (handOff.kind === 'select') {
      void this._selectFile(handOff.path);
    } else if (handOff.kind === 'clear') {
      this._selectedFile = '';
      this._fileDiff = '';
    }
  }

  async _selectFile(filePath: string) {
    const request = {};
    this._fileDiffRequest = request;
    const captured = this._queries.capture();
    const packageHash = this._payload?.prPackage?.packageHash;
    const current = () =>
      captured.current() &&
      this._fileDiffRequest === request &&
      this._selectedFile === filePath &&
      this._payload?.prPackage?.packageHash === packageHash;
    this._selectedFile = filePath;
    this._syncViewStateToHash();
    this._fileDiffLoading = true;
    this._fileDiff = '';
    try {
      const result = await gateway.request<GitDiffResult>(
        Methods.GIT_DIFF,
        committedReviewFileDiffRequest(
          this.slotId,
          filePath,
          this._payload?.prPackage?.reviewSnapshot?.baseRef,
          this._payload?.prPackage?.reviewSnapshot,
        ),
      );
      if (!current()) return;
      this._fileDiff = result.diff;
      if (this._diffModalOpen && !this._diffModalUrl) {
        this._diffModalTitle = `${workspaceArtifactBasename(filePath)} diff`;
        this._diffModalText = result.diff;
      }
    } catch (err) {
      if (!current()) return;
      this._diffError = err instanceof Error ? err.message : String(err);
    } finally {
      if (captured.ownsView() && this._fileDiffRequest === request) this._fileDiffLoading = false;
    }
  }

  // ─── Actions ───

  _hydratePublicationTarget() {
    const payload = this._payload;
    if (!payload) return;
    const key = readyPublicationTargetKey({ decisionId: this._gateDecision?.id, payload });
    if (key === this._publicationTargetKey) return;
    this._publicationTargetKey = key;
    this._publicationTarget = readyPublicationTarget(payload);
  }

  _syncDecisionActionState(): void {
    const key = readyDecisionActionStateKey(this._gateDecision);
    if (key === this._decisionActionStateKey) return;
    this._decisionActionStateKey = key;
    this._acting = false;
    this._pendingConfirm = null;
    this._evidenceAttestationReason = '';
    this._actionMessage = '';
    this._actionTone = '';
  }

  _hydrateEvidenceSelection() {
    const payload = this._payload;
    if (!payload?.prPackage) return;
    const key = readyEvidenceSelectionKey({ decisionId: this._gateDecision?.id, payload });
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

  _setEvidenceAttestationReason(value: string) {
    this._evidenceAttestationReason = value;
    this._confirmTimer.clear();
    this._pendingConfirm = null;
  }

  _confirmAction(actionId: string) {
    if (this._actionsPaused || this._acting || this._refreshingPackage || this._isRecovering)
      return;
    const packageGate = Boolean(this._payload?.prPackage);
    if (readyActionRequiresConfirmation(actionId, packageGate)) {
      this._confirmTimer.confirm(actionId, () => this._resolve(actionId));
      return;
    }
    void this._resolve(actionId);
  }

  _openReviewRequestModal() {
    if (this._actionsPaused || this._gateDecision?.resolvedAt || this._isRecovering || this._acting)
      return;
    this._reviewPicker = new ReviewDispatchViewModel({
      context: {
        allowedActions: ['request-review'],
        allowSequence: true,
        reviewLineages: reviewLineagesForRun(this._canonicalRun),
        // ADR-063 Amendment 5: rows preselect their runner's latest available lineage in WARM.
        lineageOptions: this._payload?.reviewLineageOptions,
        defaults: this._reviewPicker.context.defaults,
      },
    });
    this._actionMessage = '';
    this._reviewModalOpen = true;
    this._syncViewStateToHash();
  }

  _closeReviewRequestModal() {
    this._reviewModalOpen = false;
    this._syncViewStateToHash();
  }

  async _submitReviewRequest() {
    if (this._acting || !this._reviewPicker.canInvoke('request-review')) return;
    const reviewRequest = this._reviewPicker.toRequestPayload();
    const captured = this._queries.capture();
    const applied = await this._resolve('request-review', { reviewRequest });
    if (applied && captured.current()) this._closeReviewRequestModal();
  }

  async _resolve(actionId: string, extraSelectionData: Record<string, unknown> = {}) {
    if (this._gateDecision?.resolvedAt) return;
    // A posture choice the Gateway already refused must not ride along with a
    // resolution: the decision would be consumed and the refusal repeated.
    if (this.postureBlockedReason) {
      this._actionMessage = this.postureBlockedReason;
      this._actionTone = 'error';
      return;
    }
    const command = this._beginWorkspaceCommand();
    if (!command) return;
    this._acting = true;
    const payload = this._payload;
    const requestingReview = actionId === 'request-review';
    const approving = isReadyPublicationApproval(actionId, !!payload?.prPackage);
    this._actionMessage = requestingReview
      ? 'Requesting review…'
      : readyDecisionSubmittingMessage(approving);
    this._actionTone = '';
    // This view is reused across runs: a reply for a gate it no longer shows is not its to report.
    const decisionId = command.decision.id;
    const stillShown = command.current;
    // The gateway checks the gate against its slot before it answers, which can be slow.
    const slow = setTimeout(() => {
      if (stillShown() && this._acting)
        this._actionMessage =
          'Still waiting for the gateway; it checks the gate before applying it.';
    }, DECISION_RESOLVE_SLOW_MS);
    let failure: unknown;
    try {
      await gateway.request(
        Methods.RUN_RESOLVE_DECISION,
        buildRunResolveDecisionParams({
          runId: this.runId,
          decision: command.decision,
          actionId,
          ...publicationApprovalReasonFields(
            actionId,
            this._evidenceAttestationReason,
            evidenceAttestationAvailable(payload?.gateReadiness, actionId),
          ),
          ...(this.resourcePosture ? { resourcePosture: this.resourcePosture } : {}),
          publicationTarget: this._publicationTarget,
          selectedEvidenceKeys: payload ? this._selectedEvidenceKeysForSubmit(payload) : [],
          selectionData: extraSelectionData,
        }),
        DECISION_RESOLVE_TIMEOUT_MS,
      );
    } catch (err) {
      failure = err;
    } finally {
      clearTimeout(slow);
    }
    // A failed request can still have been applied (a lost reply, or a second click whose
    // first submission won): report what the gateway did, not how the request ended.
    const outcome: DecisionOutcome =
      failure === undefined
        ? { kind: 'applied' }
        : stillShown()
          ? await this._decisionOutcome(decisionId, actionId)
          : { kind: 'unknown' };
    if (!stillShown()) {
      command.finish();
      return;
    }
    command.finish();
    if (outcome.kind === 'applied') {
      this._actionMessage = requestingReview
        ? 'Review requested; preparing the reviewer.'
        : readyDecisionSuccessMessage(approving);
      this._actionTone = 'success';
      return true;
    }
    this._acting = false;
    if (!(failure instanceof GatewayRequestTimeoutError)) {
      this._actionMessage = `Failed to submit decision: ${failure instanceof Error ? failure.message : String(failure)}`;
      this._actionTone = 'error';
      return;
    }
    this._actionTone = '';
    this._actionMessage =
      outcome.kind === 'other'
        ? `The gateway did not reply; this decision was resolved as ${outcome.action} instead.`
        : outcome.kind === 'pending'
          ? 'The gateway did not reply and has not applied this decision. Check the run before submitting again.'
          : 'The gateway did not reply and the run could not be read. Check the run before submitting again.';
  }

  async _refreshPublishPackage(payload: ReadyGatePayload) {
    if (!payload.prPackage || payload !== this._payload) return;
    const command = this._beginWorkspaceCommand();
    if (!command) return;
    this._refreshingPackage = true;
    this._actionMessage = 'Refreshing publish package…';
    this._actionTone = '';
    try {
      const result = await gateway.request<RunRefreshPublishPackageResult>(
        Methods.RUN_REFRESH_PUBLISH_PACKAGE,
        {
          runId: this.runId,
          decisionId: command.decision.id,
          selectedEvidenceKeys: this._selectedEvidenceKeysForSubmit(payload),
          publicationTarget: this._publicationTarget,
        },
        transferBoundRequestOptions(this.runId),
      );
      if (!command.current()) return;
      // The reply reports the command, while notifications refresh the canonical gate.
      // Preserve curation only for the package the command produced.
      this._pendingPackageSelection = {
        packageHash: result.packageHash,
        keys: refreshedReadyEvidenceSelection(result),
      };
      this._applyPendingPackageSelection();
      const feedback = readyRefreshPublishPackageFeedback(result);
      this._actionMessage = feedback.message;
      this._actionTone = feedback.tone;
    } catch (err) {
      if (!command.current()) return;
      this._actionMessage = `Failed to refresh package: ${err instanceof Error ? err.message : String(err)}`;
      this._actionTone = 'error';
    } finally {
      command.finish();
    }
  }

  private _pendingPackageSelection?: { packageHash: string; keys: string[] | null };

  private _applyPendingPackageSelection(): void {
    const pending = this._pendingPackageSelection;
    if (
      !pending ||
      !this._queries.ready ||
      this._payload?.prPackage?.packageHash !== pending.packageHash
    )
      return;
    if (pending.keys) this._selectedEvidenceKeys = pending.keys;
    this._pendingPackageSelection = undefined;
  }
}
