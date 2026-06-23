// <ready-workspace> — Rich human-gate workspace for fix-bug/dev flows (D8)
// Shows worker report, diff, recipe, artifacts, and self-review verdict.

import { nothing } from 'lit';
import { customElement } from 'lit/decorators.js';

import {
  type ArtifactRef,
  isInternalRunArtifactPath,
  type ReadyGatePayload,
} from '@farmslot/protocol';

import '../diff-viewer/diff-review.js';
import '../recipe-graph/recipe-graph.js';
import '../shared/media-lightbox.js';
import '../shared/diff-viewer-modal.js';
import '../reviews/review-loop-timeline.js';
import './recipe-runner-controls.js';

import { gateway } from '../../gateway-client.js';
import type { ReviewLoopArtifactOpenDetail } from '../reviews/review-loop-timeline.js';

import { ReadyWorkspaceActionPresenter } from './ready-workspace-action-presenter.js';
import {
  renderReadyArtifactCard,
  renderReadyArtifactGroups,
  renderReadySelectedRecipeRunArtifacts,
} from './ready-workspace-artifact-renderers.js';
import {
  renderReadyWorkspaceEmpty,
  renderReadyWorkspaceFrame,
} from './ready-workspace-frame-renderers.js';
import {
  renderReadyInputArtifactViewer,
  renderReadyReviewRequestModal,
  type ReviewRunnerChoice,
} from './ready-workspace-modal-renderers.js';
import {
  renderReadyPackagePanel,
  renderReadyResolvedBanner,
} from './ready-workspace-package-renderers.js';
import {
  renderReadyDiffTab,
  renderReadyTabBar,
  renderReadyTopBar,
} from './ready-workspace-shell-renderers.js';
import {
  renderReadyEvidenceSelectionToolbar,
  renderReadyEvidenceTab,
  renderReadyInputTab,
  renderReadyLearningsTab,
  renderReadyPrPreviewTab,
  renderReadyQualityTab,
  renderReadyRecipeTab,
} from './ready-workspace-tab-renderers.js';
import {
  isWorkspaceDiffArtifact,
  MEDIA_EXTS,
  workspaceArtifactBasename,
} from './workspace-artifacts.js';

@customElement('ready-workspace')
export class ReadyWorkspace extends ReadyWorkspaceActionPresenter {
  // ─── Render ───

  override render() {
    const payload = this._payload;
    if (!payload) return renderReadyWorkspaceEmpty();
    return renderReadyWorkspaceFrame({
      payload,
      splitPct: this._splitPct,
      recovering: this._isRecovering,
      recoveryPhase: this._recoveryPhase,
      recoveryMessage: this._recoveryMessage,
      gatewayConnected: gateway.connectionState === 'connected',
      renderTopBar: () => this._renderTopBar(payload),
      renderResolvedBanner: () => this._renderResolvedBanner(payload),
      renderPackagePanel: () => this._renderPackagePanel(payload),
      renderReportEvidence: () => this._renderSelectedRecipeRunArtifacts(payload),
      renderTabBar: () => this._renderTabBar(payload),
      renderTabContent: () => this._renderTabContent(payload),
      renderInputArtifactViewer: () => this._renderInputArtifactViewer(payload),
      renderReviewRequestModal: () => this._renderReviewRequestModal(),
      beginRecovery: () => void this._beginRecovery(),
      onResizeStart: this._splitResizer.start,
      lightbox: {
        items: this._lightboxItems(payload),
        pairs: this._lightboxPairs(payload),
        open: this._lightboxOpen,
        selectedIndex: this._lightboxIndex,
        mode: this._lightboxMode,
        pairIndex: this._lightboxPairIndex,
        scopeLabel: this._lightboxScopeLabel,
        totalItems: this._lightboxSourceArtifacts(payload).filter((artifact) =>
          this._opensInLightbox(artifact),
        ).length,
        close: () => {
          this._lightboxOpen = false;
          this._syncViewStateToHash();
        },
        navigate: (index) => {
          this._lightboxIndex = index;
          this._syncViewStateToHash();
        },
        changeMode: (mode) => {
          this._lightboxMode = mode;
        },
        navigatePair: (index) => {
          this._lightboxPairIndex = index;
        },
        clearScope: (path) => this._clearLightboxScope(payload, path),
      },
      diffModal: {
        open: this._diffModalOpen,
        title: this._diffModalTitle,
        diffText: this._diffModalText,
        artifactUrl: this._diffModalUrl,
        close: () => {
          this._diffModalOpen = false;
          this._syncViewStateToHash();
        },
      },
    });
  }

  private _renderInputArtifactViewer(payload: ReadyGatePayload) {
    const artifact =
      this._inputArtifacts(payload).find((entry) => entry.id === this._selectedInputArtifactId) ??
      this._inputArtifacts(payload)[0] ??
      null;
    return renderReadyInputArtifactViewer({
      open: this._inputArtifactViewerOpen,
      artifact,
      close: () => {
        this._inputArtifactViewerOpen = false;
      },
    });
  }

  private _renderReviewRequestModal() {
    return renderReadyReviewRequestModal({
      open: this._reviewModalOpen,
      loops: this._reviewLoops,
      currentRunner: this._currentRunner as ReviewRunnerChoice,
      acting: this._acting,
      runnerLabel: (runner) => this._runnerLabel(runner),
      close: () => this._closeReviewRequestModal(),
      addLoop: () => this._addReviewLoop(),
      removeLoop: (id) => this._removeReviewLoop(id),
      setRunner: (id, runner) => this._setReviewLoopRunner(id, runner),
      setDepth: (id, validationDepth) => this._setReviewLoopDepth(id, validationDepth),
      submit: () => this._submitReviewRequest(),
    });
  }

  private _renderTopBar(payload: ReadyGatePayload) {
    const diffArtifact = this._primaryDiffArtifact(payload);
    return renderReadyTopBar({
      payload,
      decision: this.decision,
      publicationTarget: this._publicationTarget,
      pendingConfirm: this._pendingConfirm,
      acting: this._acting,
      recovering: this._isRecovering,
      diffArtifact,
      fileDiffAvailable: Boolean(this._fileDiff),
      actionMessage: this._actionMessage,
      actionTone: this._actionTone,
      openDiff: (title, artifact) => this._openDiffModal(title, artifact),
      openReviewRequestModal: () => this._openReviewRequestModal(),
      confirmAction: (actionId) => this._confirmAction(actionId),
    });
  }

  private _renderPackagePanel(payload: ReadyGatePayload) {
    const packageArtifact = this._packagePreviewArtifact(payload);
    const publishEvidence = this._publishEvidenceArtifacts(payload);
    return renderReadyPackagePanel({
      payload,
      packageArtifact,
      publishEvidence,
      selectedEvidence: this._publishEvidenceSet(payload),
      selectedEvidenceKeys: this._selectedEvidenceKeys ?? undefined,
      expanded: this._packagePanelExpanded,
      resolved: Boolean(this.decision?.resolvedAt),
      refreshingPackage: this._refreshingPackage,
      acting: this._acting,
      recovering: this._isRecovering,
      publicationTarget: this._publicationTarget,
      openPackageArtifact: (artifact) => this._openArtifact(payload, artifact),
      toggleExpanded: () => {
        this._packagePanelExpanded = !this._packagePanelExpanded;
      },
      refreshPackage: () => this._refreshPublishPackage(payload),
      setPublicationTarget: (target) => {
        this._publicationTarget = target;
      },
      artifactUrl: (artifact) => this._artifactUrl(artifact.path, artifact),
      openReviewArtifact: (detail) => this._openReviewArtifact(payload, detail),
      openReviewDiff: (detail) =>
        this._openDiffModal(
          workspaceArtifactBasename(detail.artifact.path, 'Review diff'),
          detail.artifact,
        ),
    });
  }

  private _openReviewArtifact(
    payload: ReadyGatePayload,
    detail: ReviewLoopArtifactOpenDetail,
  ): void {
    const artifact = detail.artifact;
    if (isWorkspaceDiffArtifact(artifact)) {
      this._openDiffModal(workspaceArtifactBasename(artifact.path, 'Review diff'), artifact);
      return;
    }
    if (this._opensInLightbox(artifact)) {
      this._openArtifact(payload, artifact, {
        paths: detail.artifacts.map((entry) => entry.path),
        label: detail.label,
      });
    }
  }

  private _renderResolvedBanner(payload: ReadyGatePayload) {
    return renderReadyResolvedBanner({ payload, resolvedAt: this.decision?.resolvedAt });
  }

  private _renderTabBar(payload: ReadyGatePayload) {
    return renderReadyTabBar({
      payload,
      activeTab: this._activeTab,
      hideRecipeTab: this.hideRecipeTab,
      evidenceCount: this._evidenceArtifacts(payload).length,
      qualityCount: this._qualityItemCount(payload),
      inputCount: this._inputItemCount(payload),
      diffFileCount: this._diffFiles.length,
      setActiveTab: (tab) => this._setActiveTab(tab),
    });
  }

  private _renderTabContent(payload: ReadyGatePayload) {
    switch (this._activeTab) {
      case 'pr-preview':
        return this._renderPrPreviewTab(payload);
      case 'input':
        return this._renderInputTab(payload);
      case 'diff':
        return this._renderDiffTab();
      case 'evidence':
        return this._renderEvidenceTab(payload);
      case 'quality':
        return this._renderQualityTab(payload);
      case 'recipe':
        return this._renderRecipeTab(payload);
      case 'learnings':
        return this._renderLearningsTab(payload);
      default:
        return nothing;
    }
  }

  private _renderPrPreviewTab(payload: ReadyGatePayload) {
    return renderReadyPrPreviewTab({
      payload,
      publicationTarget: this._publicationTarget,
      markdown: this._renderPrPreviewMarkdown(payload),
      fallback: () => this._renderDiffTab(),
    });
  }

  private _renderInputTab(payload: ReadyGatePayload) {
    return renderReadyInputTab({
      artifacts: this._inputArtifacts(payload),
      openInputArtifact: (id) => this._openInputArtifact(id),
    });
  }

  private _renderDiffTab() {
    return renderReadyDiffTab({
      slotId: this.slotId,
      diffLoading: this._diffLoading,
      diffError: this._diffError,
      diffFiles: this._diffFiles,
      selectedFile: this._selectedFile,
      recovering: this._isRecovering,
      fileDiffLoading: this._fileDiffLoading,
      fileDiff: this._fileDiff,
      selectFile: (path) => this._selectFile(path),
    });
  }

  private _renderRecipeTab(payload: ReadyGatePayload) {
    // Recipe runner events are composed+bubbling; slot-view/run-detail decide whether to handle
    // completion and artifact navigation from this reusable workspace.
    return renderReadyRecipeTab({
      payload,
      recipeView: this._recipeView,
      runId: this.runId,
      slotId: this.slotId,
      recovering: this._isRecovering,
      setRecipeView: (view) => {
        this._recipeView = view;
      },
    });
  }

  private _renderSelectedRecipeRunArtifacts(payload: ReadyGatePayload) {
    const group = this._selectedRecipeRun();
    const selectedArtifacts = this._selectedRecipeRunArtifacts();
    const packageEvidencePaths = new Set(
      payload.prPackage?.evidenceManifest?.map((artifact) => artifact.path) ?? [],
    );
    const artifacts = selectedArtifacts.filter((artifact) => {
      if (packageEvidencePaths.size > 0) return packageEvidencePaths.has(artifact.path);
      if (isInternalRunArtifactPath(artifact.path)) return false;
      return MEDIA_EXTS.test(artifact.path);
    });
    return renderReadySelectedRecipeRunArtifacts({
      group,
      artifacts,
      openCompare: (selectedGroup, scopedArtifacts) => {
        this._lightboxRecipeRunId = selectedGroup.id;
        this._lightboxScopePaths = scopedArtifacts.map((artifact) => artifact.path);
        this._lightboxScopeLabel = selectedGroup.label;
        this._lightboxMode = 'compare';
        this._lightboxPairIndex = 0;
        this._lightboxOpen = true;
        this._syncViewStateToHash();
      },
      artifactUrl: (selectedGroup, artifact) => this._recipeRunArtifactUrl(selectedGroup, artifact),
      openArtifact: (selectedGroup, artifact, scopedArtifacts) =>
        this._openRecipeRunArtifact(payload, selectedGroup, artifact, {
          paths: scopedArtifacts.map((entry) => entry.path),
          label: selectedGroup.label,
        }),
    });
  }

  private _renderEvidenceTab(payload: ReadyGatePayload) {
    const artifacts = this._evidenceArtifacts(payload);
    return renderReadyEvidenceTab({
      payload,
      artifacts,
      selectionToolbar: this._renderEvidenceSelectionToolbar(payload),
      artifactGroups: this._renderArtifactGroups(artifacts, payload, {
        publishSelectable: !!payload.prPackage,
      }),
    });
  }

  private _renderEvidenceSelectionToolbar(payload: ReadyGatePayload) {
    return renderReadyEvidenceSelectionToolbar({
      publishEvidence: this._publishEvidenceArtifacts(payload),
      selected: this._publishEvidenceSet(payload),
      setAllEvidenceIncluded: (included) => this._setAllEvidenceIncluded(payload, included),
      excludeEvidenceVideos: () => this._excludeEvidenceVideos(payload),
    });
  }

  private _renderQualityTab(payload: ReadyGatePayload) {
    return renderReadyQualityTab(payload);
  }

  private _renderLearningsTab(payload: ReadyGatePayload) {
    return renderReadyLearningsTab(payload);
  }

  private _renderArtifactGroups(
    artifacts: ArtifactRef[],
    payload: ReadyGatePayload,
    options: { hideFilter?: boolean; publishSelectable?: boolean } = {},
  ) {
    return renderReadyArtifactGroups({
      artifacts,
      artifactFilter: this._artifactFilter,
      artifactTypeFilter: this._artifactTypeFilter,
      hideFilter: options.hideFilter,
      publishSelectable: options.publishSelectable,
      setArtifactFilter: (filter) => {
        this._artifactFilter = filter;
      },
      setArtifactTypeFilter: (filter) => {
        this._artifactTypeFilter = filter;
      },
      openCompare: () => {
        this._lightboxRecipeRunId = null;
        this._lightboxScopePaths = null;
        this._lightboxScopeLabel = '';
        this._lightboxMode = 'compare';
        this._lightboxPairIndex = 0;
        this._lightboxOpen = true;
        this._syncViewStateToHash();
      },
      renderArtifactCard: (artifact, cardOptions) =>
        this._renderArtifactCard(artifact, payload, cardOptions),
    });
  }

  private _renderArtifactCard(
    artifact: ArtifactRef,
    payload: ReadyGatePayload,
    options: { compact?: boolean; publishSelectable?: boolean } = {},
  ) {
    const isDiff = isWorkspaceDiffArtifact(artifact);
    const opensInLightbox = this._opensInLightbox(artifact);
    const mediaUrl =
      MEDIA_EXTS.test(artifact.path) && this.runId
        ? this._artifactUrl(artifact.path, artifact)
        : null;
    const selectable =
      options.publishSelectable === true && this._isPublishEvidenceArtifact(payload, artifact);
    const selected = selectable ? this._publishEvidenceSet(payload).has(artifact.path) : false;

    return renderReadyArtifactCard({
      artifact,
      compact: options.compact,
      selectable,
      selected,
      opensInLightbox,
      mediaUrl,
      open: () => {
        if (opensInLightbox) this._openArtifact(payload, artifact);
        else if (isDiff)
          this._openDiffModal(workspaceArtifactBasename(artifact.path, 'Diff'), artifact);
      },
      setIncluded: (included) => this._setEvidenceIncluded(payload, artifact, included),
    });
  }

  // ─── Styles (light DOM) ───
}

declare global {
  interface HTMLElementTagNameMap {
    'ready-workspace': ReadyWorkspace;
  }
}
