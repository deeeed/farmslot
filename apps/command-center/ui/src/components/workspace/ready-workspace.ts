// <ready-workspace> — Rich human-gate workspace for fix-bug/dev flows (D8)
// Shows worker report, diff, recipe, artifacts, and review verdict.
import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import {
  createEvidenceReviewModel,
  type EvidenceReviewModel,
} from '@farmslot/adapter-sdk/evidence';
import type { RunRecipeRunsForRunResult } from '@farmslot/protocol';
import {
  acceptanceCriterionId,
  type ArtifactRef,
  buildRunDecisionActionRequest,
  isInternalRunArtifactPath,
  MARK_CLAIM_UNTESTABLE_ACTION,
  Methods,
  type ReadyGatePayload,
  validVisualJudgmentReason,
} from '@farmslot/protocol';
import { resolveReviewDispatchDefaults } from '@farmslot/review-dispatch';

import '../diff-viewer/diff-review.js';
import '../recipe-graph/recipe-graph.js';
import '../shared/media-lightbox.js';
import '../shared/diff-viewer-modal.js';
import '../reviews/review-loop-timeline.js';
import './recipe-runner-controls.js';

import { gateway } from '../../gateway-client.js';
import { formatDiffFileCount } from '../../utils/diff-test-filter.js';
import { summarizeReviewCounts } from '../../utils/review-gate-display.js';
import { requestProjectConfigs } from '../dispatch/dispatch-wizard-loaders.js';
import { renderAcceptancePanel } from '../progress-tracker/acceptance-panel.js';
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
  readyWorkspaceLightboxItems,
  readyWorkspaceLightboxPairs,
} from './ready-workspace-lightbox.js';
import {
  renderReadyInputArtifactViewer,
  renderReadyReviewFlowModal,
  renderReadyReviewRequestModal,
} from './ready-workspace-modal-renderers.js';
import {
  renderReadyPackagePanel,
  renderReadyResolvedBanner,
} from './ready-workspace-package-renderers.js';
import { readyReviewRequestProgress } from './ready-workspace-review-request-model.js';
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
import { loadRecipeRunnerUiOptionsForProject } from './recipe-runner-options-model.js';
import {
  isWorkspaceDiffArtifact,
  MEDIA_EXTS,
  workspaceArtifactBasename,
} from './workspace-artifacts.js';
import { renderWorkspaceEvidencePreview } from './workspace-evidence-preview.js';

@customElement('ready-workspace')
export class ReadyWorkspace extends ReadyWorkspaceActionPresenter {
  @state() private _claimOverrideId: string | null = null;
  @state() private _claimOverrideReason = '';
  @state() private _visualReviewReasons: Record<string, string> = {};
  @state() private _attestingDecisionId: string | null = null;
  @state() private _evidenceLoading = true;
  @state() private _evidenceError = '';
  @state() private _evidenceModel: EvidenceReviewModel | null = null;
  private _evidenceRequest = 0;
  private _evidenceScope = '';
  private _evidenceRecipeRunId: string | null = null;
  private _evidenceItems: import('../shared/media-lightbox-types.js').LightboxItem[] | null = null;
  private async _loadReviewEvidence(): Promise<void> {
    const request = ++this._evidenceRequest;
    const scope = JSON.stringify([
      this.runId,
      this.decision?.id,
      this._payload?.prPackage?.packageHash,
    ]);
    if (scope !== this._evidenceScope) {
      this._evidenceModel = this._reviewEvidenceModel();
      this._claimOverrideId = null;
      this._claimOverrideReason = '';
      this._visualReviewReasons = {};
      this._evidenceScope = scope;
      this._evidenceItems = null;
      this._lightboxOpen = false;
    }
    if (!this.runId || this.mockData) {
      this._evidenceLoading = false;
      return;
    }
    this._evidenceLoading = true;
    this._evidenceError = '';
    try {
      const source = await gateway.request<RunRecipeRunsForRunResult>(
        'run.recipeRunsForRun',
        {
          runId: this.runId,
          includeRecordedEvidence: true,
          decisionId: this.decision?.id,
          evidenceSnapshotHash: this._payload?.prPackage?.packageHash,
        },
        60_000,
      );
      if (request !== this._evidenceRequest || !this.isConnected) return;
      this._evidenceModel = this._reviewEvidenceModel(source.recordedEvidence);
      this._evidenceRecipeRunId = source.selectedRecipeRunId;
    } catch (error) {
      if (request === this._evidenceRequest && this.isConnected) {
        this._evidenceError = error instanceof Error ? error.message : String(error);
        this._evidenceModel = this._reviewEvidenceModel(undefined, [
          error instanceof Error ? error.message : String(error),
        ]);
      }
    } finally {
      if (request === this._evidenceRequest) this._evidenceLoading = false;
    }
  }
  private _reviewEvidenceModel(
    source?: RunRecipeRunsForRunResult['recordedEvidence'],
    readErrors?: string[],
  ): EvidenceReviewModel {
    return createEvidenceReviewModel({
      context: 'pr-preview',
      gateDecision: this.decision,
      criteria:
        this._payload?.acceptanceStatus?.criteria ??
        this._payload?.acceptanceCriteria?.map((text, index) => ({
          id: acceptanceCriterionId(index),
          text,
        })),
      ledger: this._payload?.acceptanceStatus,
      artifacts: this._payload ? this._evidenceArtifacts(this._payload) : [],
      comparisonSnapshot: this._payload?.prPackage?.reviewSnapshot,
      criterionSourceUrl: this.run?.links?.find((link) => link.label === 'Jira')?.url,
      package: source?.input,
      contractVersion: source?.contractVersion,
      claimOverrideAuthority: source?.claimOverrideAuthority,
      visualReviewAuthority: source?.visualReviewAuthority,
      visualReviewContext: source?.visualReviewContext,
      artifactPrefix: source?.artifactPrefix,
      packagePath: source?.packagePath,
      readErrors: source?.errors ?? readErrors,
    });
  }
  private _renderClaimReview() {
    const model = this._evidenceModel;
    if (!model) return nothing;
    return renderAcceptancePanel(
      { schemaVersion: 1, criteria: [] },
      {
        evidenceModel: model,
        overrideEditor: {
          claimId: this._claimOverrideId,
          reason: this._claimOverrideReason,
          select: (id) => {
            this._claimOverrideId = id;
          },
          change: (reason) => {
            this._claimOverrideReason = reason;
          },
        },
        markUntestable: this.decision?.resolvedAt
          ? undefined
          : async (claimId, reason) => {
              if (!this.decision || this._acting) return;
              const candidate = model.claimOverrideCandidate(claimId);
              if (!candidate) return;
              this._acting = true;
              try {
                const request = buildRunDecisionActionRequest({
                  runId: this.runId,
                  decision: this.decision,
                  actionId: MARK_CLAIM_UNTESTABLE_ACTION,
                  ...candidate,
                  claimOverrideReason: reason,
                });
                await gateway.request(request.method, request.params);
                await this._loadReviewEvidence();
                this._actionMessage =
                  'Claim marked untestable. Refresh and review the gate package.';
              } catch (error) {
                this._actionMessage = error instanceof Error ? error.message : String(error);
              } finally {
                this._acting = false;
              }
            },
        evidenceHref: (path) => this._lightboxArtifactUrl({ path, purpose: 'evidence' }),
        openEvidence: ({ criterion, evidence, index }) => {
          this._lightboxRecipeRunId = this._evidenceRecipeRunId;
          model.selectClaim(criterion.id, evidence[index]);
          this._evidenceItems = evidence.map((path) => ({
            path,
            purpose: 'evidence',
            url: this._lightboxArtifactUrl({ path, purpose: 'evidence' }),
            evidenceModel: model,
            resolveArtifactUrl: (path) => this._lightboxArtifactUrl({ path, purpose: 'evidence' }),
          }));
          this._lightboxIndex = index;
          this._lightboxMode = 'single';
          this._lightboxOpen = true;
        },
      },
    );
  }
  private async _recordVisualReview(
    claimId: string,
    verdict: 'confirmed' | 'rejected',
  ): Promise<void> {
    const model = this._evidenceModel;
    if (!model || this._acting) return;
    this._acting = true;
    try {
      const params = model.visualReviewRequest(
        claimId,
        gateway.authenticatedPrincipal,
        verdict,
        validVisualJudgmentReason(
          model.visualReviewKind(claimId, gateway.authenticatedPrincipal) ?? undefined,
          verdict,
        )
          ? undefined
          : this._visualReviewReasons[claimId],
      );
      if (params.runId !== this.runId) throw new Error('The run changed. Refresh the evidence.');
      await gateway.request(Methods.RUN_REVIEW_VISUAL_CLAIM, params);
      await this._loadReviewEvidence();
      this._actionMessage = 'Visual judgment recorded.';
      this._actionTone = 'success';
    } catch (error) {
      this._actionMessage = error instanceof Error ? error.message : String(error);
      this._actionTone = 'error';
    } finally {
      this._acting = false;
    }
  }
  override updated(changed: Map<string, unknown>): void {
    super.updated(changed);
    if (['runId', 'decision', 'selectedRecipeRunId'].some((key) => changed.has(key)))
      void this._loadReviewEvidence();
    if (changed.has('run')) {
      const projectName = this.run?.project ?? '';
      this._reviewPicker.setContext({
        ...this._reviewPicker.context,
        defaults: resolveReviewDispatchDefaults(undefined, 'review-pr'),
      });
      void loadRecipeRunnerUiOptionsForProject(projectName, async () => {
        const configs = await requestProjectConfigs();
        if (this.run?.project === projectName)
          this._reviewPicker.setContext({
            ...this._reviewPicker.context,
            defaults: resolveReviewDispatchDefaults(
              configs.find((project) => project.name === projectName),
              'review-pr',
            ),
          });
        return configs;
      }).then((options) => {
        this._recipeRunnerUiOptions = options;
      });
    }
  }

  // ─── Render ───

  override _openLightboxArtifact(
    payload: ReadyGatePayload,
    artifact: ArtifactRef,
    scope?: { paths: string[]; label: string },
  ) {
    this._evidenceModel?.clearSelection();
    super._openLightboxArtifact(payload, artifact, scope);
  }

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
      renderReviewFlowModal: () => this._renderReviewFlowModal(payload),
      beginRecovery: () => void this._beginRecovery(),
      onResizeStart: this._splitResizer.start,
      lightbox: {
        items: this._evidenceItems ?? this._lightboxItems(payload),
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
          this._evidenceItems = null;
          this._syncViewStateToHash();
        },
        navigate: (index) => {
          this._lightboxIndex = index;
          this._syncViewStateToHash();
        },
        replace: ({ items, index }) => {
          this._evidenceItems = items;
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
        testPatterns: this._diffTestPatterns,
        close: () => this._closeDiffModal(),
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
      viewModel: this._reviewPicker,
      acting: this._acting || this.actionsBlocked,
      close: () => this._closeReviewRequestModal(),
      changed: () => this.requestUpdate(),
      submit: () => this._submitReviewRequest(),
    });
  }

  private _renderReviewFlowModal(payload: ReadyGatePayload) {
    const reviewCounts = summarizeReviewCounts(payload);
    return renderReadyReviewFlowModal({
      open: this._reviewFlowModalOpen,
      reviews: payload.reviews ?? [],
      passingReviews: reviewCounts.trustedPassingReviews,
      reviewProgress: readyReviewRequestProgress(this.run),
      unresolvedFindings: reviewCounts.unresolvedFindings,
      staleIgnoredReviews: reviewCounts.staleIgnoredReviews,
      continuationActive: (this.run?.agentContexts ?? []).some(
        (context) =>
          context.role === 'review-fix' &&
          ['launching', 'working', 'waiting'].includes(context.status),
      ),
      activeReviewIds: new Set(
        (this.run?.agentContexts ?? []).flatMap((context) =>
          context.role === 'review' &&
          ['launching', 'working', 'waiting'].includes(context.status) &&
          context.artifactScope
            ? [context.artifactScope]
            : [],
        ),
      ),
      view: this._reviewFlowView,
      selected: this._reviewFlowSelection,
      reviewSummary: payload.reviewSummary,
      artifactUrl: (artifact) => this._artifactUrl(artifact.path, artifact),
      close: () => {
        this._reviewFlowModalOpen = false;
      },
      setView: (view) => {
        this._reviewFlowView = view;
      },
      select: (selection) => {
        this._reviewFlowSelection = selection;
      },
      openReviewArtifact: (detail) => this._openReviewArtifact(payload, detail),
      openReviewDiff: (detail) =>
        this._openReviewFlowDiff(
          workspaceArtifactBasename(detail.artifact.path, 'Review diff'),
          detail.artifact,
        ),
    });
  }

  private _renderTopBar(payload: ReadyGatePayload) {
    const diffArtifact = this._primaryDiffArtifact(payload);
    return renderReadyTopBar({
      payload,
      decision: this.decision,
      publicationTarget: this._publicationTarget,
      pendingConfirm: this._pendingConfirm,
      attestationReason: this._evidenceAttestationReason,
      attesting: this._attestingDecisionId === this.decision?.id,
      chooseAttestation: () => {
        this._attestingDecisionId = this.decision?.id ?? null;
      },
      setAttestationReason: (value) => this._setEvidenceAttestationReason(value),
      acting: this._acting || this.actionsBlocked,
      recovering: this._isRecovering,
      diffArtifact,
      fileDiffAvailable: Boolean(this._fileDiff),
      actionMessage: this._actionMessage,
      reviewProgress: readyReviewRequestProgress(this.run),
      actionTone: this._actionTone,
      openDiff: (title, artifact) => this._openDiffModal(title, artifact),
      openReviewRequestModal: () => this._openReviewRequestModal(),
      confirmAction: (actionId) => this._confirmAction(actionId),
      loading: this.actionsBlocked || (this._evidenceLoading && !this.mockData),
      loadError: this.loadError || this._evidenceError,
      retry: () => (this.loadError ? location.reload() : void this._loadReviewEvidence()),
      claims: (this._evidenceModel ?? this._reviewEvidenceModel()).claims,
      judgmentRows: this._evidenceModel?.judgmentRows(gateway.authenticatedPrincipal),
      reviewReason: (id) => this._visualReviewReasons[id] ?? '',
      changeReviewReason: (id, reason) => {
        this._visualReviewReasons = { ...this._visualReviewReasons, [id]: reason };
      },
      recordReview: (id, verdict) => void this._recordVisualReview(id, verdict),
      refreshPackage: () => void this._refreshPublishPackage(payload),
      pendingVisualClaimIds: this._evidenceModel?.pendingVisualClaimIds,
      focusClaim: async (id) => {
        const details = this.querySelector<HTMLDetailsElement>('.rdy-review-content');
        if (details) details.open = true;
        this._setActiveTab('evidence');
        this._evidenceModel?.setComparisonFilter('all');
        this._evidenceModel?.selectClaim(id);
        this.requestUpdate();
        await this.updateComplete;
        this.renderRoot
          ?.querySelector(`[data-ac="${CSS.escape(id)}"]`)
          ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      },
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
      acting: this._acting || this.actionsBlocked,
      recovering: this._isRecovering,
      publicationTarget: this._publicationTarget,
      openPackageArtifact: (artifact) => this._openArtifact(payload, artifact),
      openReviewFlow: () => {
        this._reviewFlowSelection = 'overall';
        this._reviewFlowModalOpen = true;
      },
      toggleExpanded: () => {
        this._packagePanelExpanded = !this._packagePanelExpanded;
      },
      refreshPackage: () => this._refreshPublishPackage(payload),
      setPublicationTarget: (target) => {
        this._publicationTarget = target;
      },
    });
  }

  private _openReviewArtifact(
    payload: ReadyGatePayload,
    detail: ReviewLoopArtifactOpenDetail,
  ): void {
    const artifact = detail.artifact;
    if (isWorkspaceDiffArtifact(artifact)) {
      this._openReviewFlowDiff(workspaceArtifactBasename(artifact.path, 'Review diff'), artifact);
      return;
    }
    if (this._opensInLightbox(artifact)) {
      this._openArtifact(payload, artifact, {
        paths: detail.artifacts.map((entry) => entry.path),
        label: detail.label,
      });
    }
  }

  private _openReviewFlowDiff(
    title: string,
    artifact: Pick<ArtifactRef, 'path' | 'sha256' | 'sizeBytes'>,
  ): void {
    this._openDiffModal(title, artifact);
    this._returnToReviewFlowAfterDiff = true;
    this._reviewFlowModalOpen = false;
  }

  _closeDiffModal(): void {
    this._diffModalOpen = false;
    if (this._returnToReviewFlowAfterDiff) this._reviewFlowModalOpen = true;
    this._returnToReviewFlowAfterDiff = false;
    this._syncViewStateToHash();
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
      diffCount: formatDiffFileCount(this._diffSplit()),
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
      claims: this._renderClaimReview(),
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
      retryDiff: () => void this._loadBranchDiff(),
      diffFiles: this._diffFiles,
      testFilter: this._testFilter,
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
      recipeRunnerUiOptions: this._recipeRunnerUiOptions,
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
      if (isInternalRunArtifactPath(artifact.path)) return false;
      if (packageEvidencePaths.size > 0) return packageEvidencePaths.has(artifact.path);
      return MEDIA_EXTS.test(artifact.path);
    });
    return renderReadySelectedRecipeRunArtifacts({
      group,
      artifacts,
      evidenceModel: this._evidenceModel,
      evidenceCollapsed: this._recipePackageEvidenceCollapsed,
      toggleEvidenceCollapsed: () => {
        this._recipePackageEvidenceCollapsed = !this._recipePackageEvidenceCollapsed;
        this._syncViewStateToHash();
      },
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
      loading: this.actionsBlocked || (this._evidenceLoading && !this.mockData),
      error: this._evidenceError,
      retry: () => (this.loadError ? location.reload() : void this._loadReviewEvidence()),
      selectionToolbar: this._renderEvidenceSelectionToolbar(payload),
      artifactGroups: this._evidenceModel
        ? html`${renderWorkspaceEvidencePreview({
            title: 'Compare by AC',
            items: [],
            comparison: {
              model: this._evidenceModel,
              reviewer: gateway.authenticatedPrincipal,
              reviewReason: (id) => this._visualReviewReasons[id] ?? '',
              changeReviewReason: (id, reason) => {
                this._visualReviewReasons = { ...this._visualReviewReasons, [id]: reason };
              },
              reviewing: this._acting || this.actionsBlocked,
              recordReview: (id, verdict) => this._recordVisualReview(id, verdict),
              artifactUrl: (path) => this._lightboxArtifactUrl({ path, purpose: 'evidence' }),
              changed: () => this.requestUpdate(),
              openMedia: (media, clipIndex) => {
                const model = this._evidenceModel!;
                model.selectComparisonMedia(media.identity);
                if (clipIndex !== undefined) model.cueClip(clipIndex);
                this._openComparisonSelection(clipIndex !== undefined, media.artifactPath);
              },
              openMoment: (claimId, index) => {
                this._evidenceModel!.selectClaim(claimId);
                this._evidenceModel!.cueClip(index);
                this._openComparisonSelection(true);
              },
            },
          })}${payload.prPackage && !this.decision?.resolvedAt
            ? html`<details class="rdy-publish-file-selection">
                <summary>Choose files to include in PR</summary>
                ${this._renderArtifactGroups(artifacts, payload, { publishSelectable: true })}
              </details>`
            : nothing}`
        : this._renderArtifactGroups(artifacts, payload, {
            publishSelectable: !!payload.prPackage,
          }),
    });
  }

  private _openComparisonSelection(video: boolean, mediaPath?: string): void {
    const model = this._evidenceModel;
    if (!model?.selection) return;
    const clip = model.playback.clip;
    const path = video && clip ? model.artifactPath(clip.videoPath) : mediaPath;
    if (!path) return;
    this._lightboxRecipeRunId = this._evidenceRecipeRunId;
    this._evidenceItems = [
      {
        path,
        purpose: 'evidence',
        caption: model.selection.caption,
        url: this._lightboxArtifactUrl({ path, purpose: 'evidence' }),
        evidenceModel: model,
        fullscreen: video,
        ...(video && clip ? { initialTraceIndex: clip.traceIndex } : {}),
        resolveArtifactUrl: (path) => this._lightboxArtifactUrl({ path, purpose: 'evidence' }),
      },
    ];
    this._lightboxIndex = 0;
    this._lightboxMode = 'single';
    this._lightboxOpen = true;
  }

  override _lightboxItems(payload: ReadyGatePayload) {
    return readyWorkspaceLightboxItems(
      this._lightboxSourceArtifacts(payload),
      (artifact) => this._lightboxArtifactUrl(artifact),
      this._evidenceModel,
    );
  }

  override _lightboxPairs(payload: ReadyGatePayload) {
    return readyWorkspaceLightboxPairs(
      this._lightboxSourceArtifacts(payload),
      (artifact) => this._lightboxArtifactUrl(artifact),
      this._evidenceModel,
    );
  }

  private _renderEvidenceSelectionToolbar(payload: ReadyGatePayload) {
    if (this.decision?.resolvedAt) return nothing;
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
      evidenceModel: this._evidenceModel,
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
