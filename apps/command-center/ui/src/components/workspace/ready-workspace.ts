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
  type ArtifactRef,
  buildRunDecisionActionRequest,
  isInternalRunArtifactPath,
  isRunArtifactMediaPath,
  MARK_CLAIM_UNTESTABLE_ACTION,
  Methods,
  type ReadyGatePayload,
  sourceObservationAge,
  validVisualJudgmentReason,
} from '@farmslot/protocol';
import {
  acceptanceClaimRows,
  anotherReviewRoundParams,
  criterionDraftsAvailable,
  publicationGateBlockers,
  publicationGateCriteria,
  publicationGateView,
  resolveReviewDispatchDefaults,
  type VisualJudgmentFeedback,
} from '@farmslot/review-dispatch';

import '../diff-viewer/diff-review.js';
import '../recipe-graph/recipe-graph.js';
import '../shared/evidence-reviewer.js';
import '../shared/media-lightbox.js';
import '../shared/diff-viewer-modal.js';
import '../runs/review-history-panel.js';
import './recipe-runner-controls.js';

import { gateway } from '../../gateway-client.js';
import { getResourceWorkspaceKey } from '../../resource-cache.js';
import { formatDiffFileCount } from '../../utils/diff-test-filter.js';
import { requestProjectConfigs } from '../dispatch/dispatch-wizard-loaders.js';
import { renderAcceptancePanel } from '../progress-tracker/acceptance-panel.js';
import {
  type EvidenceReviewerJudgments,
  type EvidenceReviewerSelection,
  evidenceReviewerSelection,
} from '../shared/evidence-reviewer.js';
import {
  type EvidenceReviewerView,
  evidenceReviewerViewFromHash,
  evidenceReviewerViewKey,
  writeEvidenceReviewerHash,
} from '../shared/evidence-reviewer-url-state.js';
import type { LightboxItem } from '../shared/media-lightbox-types.js';
import { RetainedNotice } from '../shared/retained-notice.js';

import { ReadyWorkspaceActionPresenter } from './ready-workspace-action-presenter.js';
import {
  renderReadyArtifactCard,
  renderReadyArtifactGroups,
  renderReadySelectedRecipeRunArtifacts,
} from './ready-workspace-artifact-renderers.js';
import { type ReadyBlockerSheet, renderReadyBlockers } from './ready-workspace-blockers.js';
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
  renderReadyReviewRequestModal,
} from './ready-workspace-modal-renderers.js';
import {
  readyResolvedNotice,
  renderReadyPackagePanel,
  renderReadyPackageSkeleton,
  renderReadyResolvedBanner,
} from './ready-workspace-package-renderers.js';
import { readyReviewRequestProgress } from './ready-workspace-review-request-model.js';
import {
  renderReadyDiffTab,
  renderReadyPackageMetadata,
  renderReadyTabBar,
  renderReadyTopBar,
} from './ready-workspace-shell-renderers.js';
import {
  renderPrPreviewSkeleton,
  renderReadyEvidenceSelectionToolbar,
  renderReadyEvidenceTab,
  renderReadyInputTab,
  renderReadyLearningsTab,
  renderReadyPrPreviewTab,
  renderReadyQualityTab,
  renderReadyRecipeTab,
} from './ready-workspace-tab-renderers.js';
import { loadRecipeRunnerUiOptionsForProject } from './recipe-runner-options-model.js';
import { isWorkspaceDiffArtifact, workspaceArtifactBasename } from './workspace-artifacts.js';

@customElement('ready-workspace')
export class ReadyWorkspace extends ReadyWorkspaceActionPresenter {
  @state() private _claimOverrideId: string | null = null;
  @state() private _claimOverrideReason = '';
  @state() private _visualJudgmentFeedback?: VisualJudgmentFeedback;
  @state() private _visualReviewReasons: Record<string, string> = {};
  @state() private _attestingDecisionId: string | null = null;
  @state() private _acceptingFindingsDecisionId: string | null = null;
  /** The reason sheet open in the blocker list, if any. */
  @state() private _blockerSheet: ReadyBlockerSheet | null = null;
  @state() private _evidenceLoading = true;
  @state() private _evidenceError = '';
  @state() private _evidenceModel: EvidenceReviewModel | null = null;
  private _evidenceSource?: RunRecipeRunsForRunResult;
  private _evidenceDecision?: import('@farmslot/protocol').RunDecision;
  private _evidencePending?: boolean;
  private _evidenceScope = '';
  private _evidenceRecipeRunId: string | null = null;
  private _evidenceItems: import('../shared/media-lightbox-types.js').LightboxItem[] | null = null;

  override _sharedWorkspaceQueriesChanged(): void {
    const scope = JSON.stringify([
      getResourceWorkspaceKey(),
      this.runId,
      this.slotId,
      this.decision?.id,
      this._payload?.prPackage?.packageHash,
    ]);
    if (scope !== this._evidenceScope) {
      this._evidenceScope = scope;
      this._evidenceSource = undefined;
      this._evidenceDecision = undefined;
      this._evidencePending = undefined;
      this._claimOverrideId = null;
      this._claimOverrideReason = '';
      this._visualReviewReasons = {};
      this._visualJudgmentFeedback = undefined;
      this._blockerSheet = null;
      this._attestingDecisionId = null;
      this._acceptingFindingsDecisionId = null;
      this._reviewLinkKey = '';
      this._evidenceItems = null;
      this._evidenceRecipeRunId = null;
      this._lightboxOpen = false;
      this._review = null;
    }
    const read = this._queries.evidence;
    const source = read.belongsToWorkspace ? read.state.data : undefined;
    this._evidenceLoading = !source && read.state.status === 'loading';
    this._evidenceError = read.state.error?.message ?? '';
    if (
      source !== this._evidenceSource ||
      this._gateDecision !== this._evidenceDecision ||
      this._evidenceLoading !== this._evidencePending
    ) {
      this._evidenceSource = source;
      this._evidenceDecision = this._gateDecision;
      // A model built while the shared evidence read loads marks its criteria pending.
      this._evidencePending = this._evidenceLoading;
      this._evidenceModel = this._gateDecision
        ? this._reviewEvidenceModel(source?.recordedEvidence, undefined, this._evidenceLoading)
        : null;
      this._evidenceRecipeRunId = source?.selectedRecipeRunId ?? null;
    }
    this.requestUpdate();
  }

  private _reviewEvidenceModel(
    source?: RunRecipeRunsForRunResult['recordedEvidence'],
    readErrors?: string[],
    evidencePending = false,
  ): EvidenceReviewModel {
    return createEvidenceReviewModel({
      context: 'pr-preview',
      evidencePending,
      gateDecision: this._gateDecision,
      criteria: publicationGateCriteria(this._payload),
      ledger: this._payload?.acceptanceStatus,
      artifacts: this._payload ? this._evidenceArtifacts(this._payload) : [],
      comparisonSnapshot: this._payload?.prPackage?.reviewSnapshot,
      criterionSourceUrl: this._canonicalRun?.links?.find((link) => link.label === 'Jira')?.url,
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
  /** A criterion's "Review evidence" opens the full-screen review on it. */
  private _focusEvidenceClaim(id: string): void {
    this._evidenceModel?.selectClaim(id);
    this._openReview(id, undefined);
  }

  /**
   * Opens a criterion's full-screen review from outside the gate (run detail's own
   * criteria and pipeline), so the gate's review stays the one owner of review links.
   * False until the gate's evidence knows the criterion.
   */
  openEvidenceReview(claimId: string, opened?: LightboxItem): boolean {
    const model = this._evidenceModel;
    if (!model?.claims.some((claim) => claim.id === claimId)) return false;
    model.selectClaim(claimId, opened?.path);
    this._openReview(
      claimId,
      opened
        ? {
            ...this._evidenceItem(opened.path),
            ...(opened.initialTraceIndex !== undefined
              ? {
                  initialTraceIndex: opened.initialTraceIndex,
                  initialTracePhase: opened.initialTracePhase,
                }
              : {}),
          }
        : undefined,
    );
    return true;
  }
  protected override _criterionExecution(claimId: string): string | undefined {
    return this._evidenceModel?.claimOverrideCandidate(claimId)?.recipeRunId;
  }
  private _draftUnsubscribe?: () => void;
  override connectedCallback(): void {
    super.connectedCallback();
    this._draftUnsubscribe = this._criterionDrafts.subscribe(() => this.requestUpdate());
    this.requestUpdate();
  }
  override disconnectedCallback(): void {
    this._draftUnsubscribe?.();
    this._criterionDrafts.deactivate();
    super.disconnectedCallback();
  }
  private _visualReviewControls() {
    return {
      drafts:
        criterionDraftsAvailable(this._gateDecision) &&
        gateway.authenticatedPrincipal?.subjectKind === 'person'
          ? {
              model: this._criterionDrafts,
              canSkip: (id: string) =>
                this._evidenceLoading || Boolean(this._evidenceModel?.claimOverrideCandidate(id)),
              skipDisabledReason: (id: string) =>
                this._evidenceLoading || this._evidenceModel?.claimOverrideCandidate(id)
                  ? undefined
                  : 'This criterion has no recorded evidence that can be skipped.',
              choose: (id: string, choice: 'confirm' | 'skip', note?: string) => {
                const claim = this._evidenceModel?.claims.find((claim) => claim.id === id);
                if (!claim || this._actionsPaused || this._acting) return;
                const candidate = this._evidenceModel?.claimOverrideCandidate(id);
                this._criterionDrafts.choose(
                  claim,
                  choice,
                  note,
                  candidate?.recipeRunId,
                  this._payload?.gateSummary?.review,
                );
                this._confirmTimer.clear();
                this._pendingConfirm = null;
              },
            }
          : undefined,
      judgmentRows: this._evidenceModel?.judgmentRows(gateway.authenticatedPrincipal) ?? [],
      busy: this._acting || this._refreshingPackage || this._actionsPaused,
      feedback: this._visualJudgmentFeedback,
      reviewReason: (id: string) => this._visualReviewReasons[id] ?? '',
      changeReviewReason: (id: string, reason: string) => {
        this._visualReviewReasons = { ...this._visualReviewReasons, [id]: reason };
      },
      recordReview: this._gateDecision?.resolvedAt
        ? undefined
        : (id: string, verdict: 'confirmed' | 'rejected') =>
            void this._recordVisualReview(id, verdict),
      focusClaim: (id: string) => this._focusEvidenceClaim(id),
    };
  }
  private _renderClaimReview() {
    const model = this._evidenceModel;
    if (!model) return nothing;
    const controls = this._visualReviewControls();
    return renderAcceptancePanel(
      { schemaVersion: 1, criteria: [] },
      {
        expanded: true,
        criteria: publicationGateCriteria(this._payload),
        criterionDrafts: this._gateDecision?.resolvedAt ? [] : this._criterionDrafts.entries,
        attestationReason: this._evidenceAttestationReason,
        evidenceModel: model,
        judgments: { ...controls, rows: controls.judgmentRows },
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
        markUntestable:
          this._visualReviewControls().drafts || this._gateDecision?.resolvedAt
            ? undefined
            : (claimId, reason) => void this._skipCriterion(claimId, reason),
        evidenceHref: (path) => this._lightboxArtifactUrl({ path, purpose: 'evidence' }),
        openEvidence: ({ criterion, evidence, index }) => {
          this._lightboxRecipeRunId = this._evidenceRecipeRunId;
          model.selectClaim(criterion.id, evidence[index]);
          this._evidenceItems = evidence.map((path) => this._evidenceItem(path));
          this._lightboxIndex = index;
          this._lightboxMode = 'single';
          this._openReview(criterion.id, this._evidenceItems[index]);
        },
      },
    );
  }
  /** Skip a criterion: the gateway records the untestable override with its reason. */
  private async _skipCriterion(claimId: string, reason: string): Promise<void> {
    const model = this._evidenceModel;
    if (!this._gateDecision || !model || this._acting) return;
    const candidate = model.claimOverrideCandidate(claimId);
    if (!candidate) return;
    const command = this._beginWorkspaceCommand();
    if (!command) return;
    this._acting = true;
    try {
      const request = buildRunDecisionActionRequest({
        runId: this.runId,
        decision: command.decision,
        actionId: MARK_CLAIM_UNTESTABLE_ACTION,
        ...candidate,
        claimOverrideReason: reason,
      });
      await gateway.request(request.method, request.params);
      if (!command.current()) return;
      this._claimOverrideId = null;
      this._claimOverrideReason = '';
      this._blockerSheet = null;
      this._actionMessage = `${claimId} skipped as untestable. Refresh the package to publish.`;
    } catch (error) {
      if (!command.current()) return;
      this._actionMessage = error instanceof Error ? error.message : String(error);
    } finally {
      command.finish();
    }
  }

  /** One more review round (admin): the gateway raises the run's limit for this head. */
  private async _giveAnotherRound(payload: ReadyGatePayload, brief: string): Promise<void> {
    if (payload !== this._payload) return;
    const budget = payload.reviewRoundBudget;
    const headSha = payload.prPackage?.headSha;
    if (!budget || !headSha || !this._gateDecision || this._acting) return;
    const command = this._beginWorkspaceCommand();
    if (!command) return;
    this._acting = true;
    try {
      await gateway.request(
        Methods.RUN_EXTEND_REVIEW_BUDGET,
        anotherReviewRoundParams({
          runId: this.runId,
          decisionId: this._gateDecision.id,
          budget,
          headSha,
          brief,
        }),
      );
      if (!command.current()) return;
      this._blockerSheet = null;
      this._actionMessage =
        'One more review round granted. Send it back to the agent to fix and review again.';
    } catch (error) {
      if (!command.current()) return;
      this._actionMessage = error instanceof Error ? error.message : String(error);
    } finally {
      command.finish();
    }
  }

  /** What blocks publish, at the top of the gate, with one plain action per blocker. */
  private _renderBlockers(payload: ReadyGatePayload) {
    const model = this._evidenceModel;
    const resolved = Boolean(this._gateDecision?.resolvedAt);
    const controls = this._visualReviewControls();
    const view = publicationGateView({
      run: this._canonicalRun,
      gate: this._gateDecision,
      actions: this._gateDecision?.actions ?? [],
      judgmentRows: controls.judgmentRows,
      criterionDrafts: this._gateDecision?.resolvedAt ? [] : this._criterionDrafts.entries,
      attestationReason: this._evidenceAttestationReason,
      pendingVisualClaimIds: model?.pendingVisualClaimIds,
      readiness: payload.gateReadiness,
      resolved,
    });
    return renderReadyBlockers({
      blockers: publicationGateBlockers({
        view,
        readiness: payload.gateReadiness,
        gate: this._gateDecision,
        resolved,
        canSkip: () => false,
        budget: payload.reviewRoundBudget,
      }),
      sheet: this._blockerSheet,
      budget: payload.reviewRoundBudget,
      busy: this._acting || this._actionsPaused,
      choose: (action) => {
        if (action.kind === 'request-review') {
          this._blockerSheet = null;
          this._acceptingFindingsDecisionId = null;
          this._openReviewRequestModal();
          return;
        }
        if (action.kind === 'review-evidence') {
          this.openEvidenceReview(action.claimId);
          return;
        }
        if (action.kind === 'see-findings') return;
        if (action.kind === 'accept-findings') {
          this._blockerSheet = null;
          this._acceptingFindingsDecisionId = this._gateDecision?.id ?? null;
          void this.updateComplete.then(() =>
            this.querySelector<HTMLTextAreaElement>(
              '[data-testid="accept-findings-reason"]',
            )?.focus(),
          );
        } else {
          this._acceptingFindingsDecisionId = null;
          this._blockerSheet =
            action.kind === 'skip-criterion'
              ? { kind: 'skip-criterion', claimId: action.claimId, text: '' }
              : { kind: 'another-round', text: '' };
        }
      },
      changeSheet: (text) => {
        if (this._blockerSheet) this._blockerSheet = { ...this._blockerSheet, text };
      },
      cancelSheet: () => {
        this._blockerSheet = null;
      },
      skip: (claimId, reason) => void this._skipCriterion(claimId, reason),
      anotherRound: (brief) => void this._giveAnotherRound(payload, brief),
    });
  }

  private async _recordVisualReview(
    claimId: string,
    verdict: 'confirmed' | 'rejected',
  ): Promise<void> {
    const model = this._evidenceModel;
    if (!model || this._acting) return;
    const command = this._beginWorkspaceCommand();
    if (!command) return;
    this._acting = true;
    this._visualJudgmentFeedback = { claimId, phase: 'saving' };
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
      await gateway.request(Methods.RUN_REVIEW_VISUAL_CLAIM, params, { timeout: null });
      if (!command.current()) return;
      this._visualJudgmentFeedback = undefined;
    } catch (error) {
      if (!command.current()) return;
      this._visualJudgmentFeedback = {
        claimId,
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      command.finish();
    }
  }
  /** The view the hash holds as applied or reported, so only a new link reapplies. */
  private _reviewLinkKey = '';
  private _reviewLinkCount = 0;

  /**
   * A review link opens the review once the package's evidence has loaded, and a
   * new link (pasted, or back and forward) moves a review already open to its view.
   */
  private _restoreReviewFromHash(): void {
    const model = this._evidenceModel;
    const view = evidenceReviewerViewFromHash();
    const key = evidenceReviewerViewKey(view);
    if (!view) this._reviewLinkKey = '';
    if (!model || !view || key === this._reviewLinkKey) return;
    if (!model.claims.some((claim) => claim.id === view.claimId)) return;
    this._reviewLinkKey = key;
    model.selectClaim(view.claimId);
    this._review = {
      ...evidenceReviewerSelection({
        model,
        claimId: view.claimId,
        resolveUrl: (path) => this._lightboxArtifactUrl({ path, purpose: 'evidence' }),
        opened: view.path ? this._evidenceItem(view.path) : undefined,
      }),
      atMs: view.atMs,
      check: view.check,
      link: ++this._reviewLinkCount,
    };
  }

  /** The review reports its view; the link follows it. */
  private _onReviewerView(view: EvidenceReviewerView): void {
    this._reviewLinkKey = evidenceReviewerViewKey(view);
    writeEvidenceReviewerHash(view);
  }

  override updated(changed: Map<string, unknown>): void {
    super.updated(changed);
    this._restoreReviewFromHash();
    if (changed.has('run')) {
      const projectName = this._canonicalRun?.project ?? '';
      this._reviewPicker.setContext({
        ...this._reviewPicker.context,
        defaults: resolveReviewDispatchDefaults(undefined, 'review-pr'),
      });
      void loadRecipeRunnerUiOptionsForProject(projectName, async () => {
        const configs = await requestProjectConfigs();
        if (this._canonicalRun?.project === projectName)
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
    return html` ${renderReadyWorkspaceFrame({
      payload,
      renderReview: () =>
        this._review && this._evidenceModel
          ? html`<evidence-reviewer
              .selection=${this._reviewSelection(this._review, this._evidenceModel)}
              @reviewer-close=${() => {
                this._review = null;
                writeEvidenceReviewerHash(null);
              }}
              @reviewer-view=${(event: CustomEvent<EvidenceReviewerView>) =>
                this._onReviewerView(event.detail)}
              @reviewer-files=${(event: CustomEvent<{ claimId: string }>) =>
                this._openClaimGallery(event.detail.claimId)}
            ></evidence-reviewer>`
          : nothing,
      packagePending: this._packagePending,
      splitPct: this._splitPct,
      // A held package diff keeps the gate readable offline; its actions still wait.
      recovering: this._isRecovering && !this._readingHeldDiff,
      recoveryPhase: this._recoveryPhase,
      recoveryMessage: this._recoveryMessage,
      gatewayConnected: gateway.connectionState === 'connected',
      renderTopBar: () => this._renderTopBar(payload),
      renderBlockers: () => this._renderBlockers(payload),
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
        notice: this._diffModalNotice,
        testPatterns: this._diffTestPatterns,
        close: () => this._closeDiffModal(),
      },
    })}`;
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
      acting: this._acting || this._actionsPaused,
      message: this._actionMessage,
      close: () => this._closeReviewRequestModal(),
      changed: () => this.requestUpdate(),
      submit: () => this._submitReviewRequest(),
    });
  }

  private _renderReviewFlow() {
    return this._canonicalRun
      ? html`<review-history-panel .run=${this._canonicalRun}></review-history-panel>`
      : nothing;
  }

  private _renderTopBar(payload: ReadyGatePayload) {
    const diffArtifact = this._primaryDiffArtifact(payload);
    return renderReadyTopBar({
      run: this._canonicalRun,
      payload,
      decision: this._gateDecision,
      publicationTarget: this._publicationTarget,
      pendingConfirm: this._pendingConfirm,
      attestationReason: this._evidenceAttestationReason,
      criterionDrafts: this._gateDecision?.resolvedAt ? [] : this._criterionDrafts.entries,
      claims: this._evidenceModel?.claims,
      attesting: this._attestingDecisionId === this._gateDecision?.id,
      chooseAttestation: () => {
        this._attestingDecisionId = this._gateDecision?.id ?? null;
      },
      acceptingFindings: this._acceptingFindingsDecisionId === this._gateDecision?.id,
      chooseAcceptFindings: () => {
        this._blockerSheet = null;
        this._acceptingFindingsDecisionId = this._gateDecision?.id ?? null;
      },
      setAttestationReason: (value) => this._setEvidenceAttestationReason(value),
      acting: this._acting || this._refreshingPackage,
      pausedRetry:
        this.loadError || this._queries.run.state.error || this._evidenceError
          ? () => void this._queries.retry()
          : undefined,
      pausedReason: this._actionsPaused
        ? this.loadError
          ? 'Run refresh failed; saved gate visible, actions paused'
          : 'Refreshing run; actions paused'
        : undefined,
      recovering: this._isRecovering,
      diffArtifact,
      fileDiffAvailable: Boolean(this._fileDiff),
      actionMessage: this._actionMessage,
      reviewProgress: readyReviewRequestProgress(this._canonicalRun),
      actionTone: this._actionTone,
      openDiff: (title, artifact) => this._openDiffModal(title, artifact),
      openReviewRequestModal: () => this._openReviewRequestModal(),
      confirmAction: (actionId) => this._confirmAction(actionId),
      ...this._visualReviewControls(),
      showClaims: false,
      // Recorded media may still be loading. The captured gate's actions and
      // acceptance already exist, and have their own current-read fences.
      loading: this._packagePending,
      retry: () => void this._queries.retry(),
      refreshPackage: () => void this._refreshPublishPackage(payload),
      pendingVisualClaimIds: this._evidenceModel?.pendingVisualClaimIds,
    });
  }

  private _renderPackagePanel(payload: ReadyGatePayload) {
    if (this._packagePending && !payload.prPackage) return renderReadyPackageSkeleton();
    const packageArtifact = this._packagePreviewArtifact(payload);
    const publishEvidence = this._publishEvidenceArtifacts(payload);
    return renderReadyPackagePanel({
      payload,
      packageArtifact,
      publishEvidence,
      selectedEvidence: this._publishEvidenceSet(payload),
      selectedEvidenceKeys: this._selectedEvidenceKeys ?? undefined,
      expanded: this._packagePanelExpanded,
      resolved: Boolean(this._gateDecision?.resolvedAt),
      refreshingPackage: this._refreshingPackage,
      acting: this._acting || this._actionsPaused,
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
    });
  }

  _closeDiffModal(): void {
    this._diffModalOpen = false;
    this._diffModalRequest++;
    this._syncViewStateToHash();
  }

  private readonly _resolvedNotice = new RetainedNotice();
  private _renderResolvedBanner(payload: ReadyGatePayload) {
    const ordinary = this._queries.run.state;
    const savedMessage =
      !this._queries.run.ready && (ordinary.observedAt || this._queries.showsSnapshot)
        ? `${
            ordinary.observedAt
              ? `Saved gate · ${sourceObservationAge(ordinary.observedAt)}`
              : ordinary.error
                ? 'Stored gate'
                : 'Stored gate · checking current readiness'
          }${ordinary.error ? ` · ${ordinary.error.message}` : ''}`
        : undefined;
    const owner = this._usesMockData ? 'mock' : getResourceWorkspaceKey();
    const scope = owner ? JSON.stringify([owner, this.runId, this.decision?.id]) : undefined;
    const observed = this._usesMockData ? this.decision : this._queries.decision;
    const message = this._resolvedNotice.read(
      scope,
      readyResolvedNotice(payload, observed?.resolvedAt),
      !observed,
    );
    return renderReadyResolvedBanner({ message, savedMessage });
  }

  /** Media may arrive through the recorded-source read after the light gate payload. */
  private _visibleEvidenceArtifacts(
    payload: ReadyGatePayload,
  ): import('@farmslot/protocol').ArtifactRef[] {
    if (this._selectedRecipeRun())
      return this._selectedRecipeRunArtifacts().filter((artifact) =>
        isRunArtifactMediaPath(artifact.path),
      );
    const captured = this._evidenceArtifacts(payload);
    const model = this._evidenceModel;
    if (captured.length || !model || model.errors.length) return captured;
    const media = [
      ...model.claims.flatMap((claim) =>
        claim.evidence.map(({ artifactPath }) => ({ path: artifactPath, purpose: 'evidence' })),
      ),
      ...model.recordings.map(({ videoPath }) => ({
        path: model.artifactPath(videoPath),
        purpose: 'evidence',
      })),
    ].filter((artifact) => isRunArtifactMediaPath(artifact.path));
    return [...new Map(media.map((artifact) => [artifact.path, artifact])).values()];
  }

  private _renderTabBar(payload: ReadyGatePayload) {
    return renderReadyTabBar({
      payload,
      packagePending: this._packagePending,
      activeTab: this._activeTab,
      hideRecipeTab: this.hideRecipeTab,
      evidenceCount: this._visibleEvidenceArtifacts(payload).length,
      qualityCount: this._qualityItemCount(payload),
      inputCount: this._inputItemCount(payload),
      diffCount: this._branchDiffLoaded
        ? formatDiffFileCount(this._diffSplit())
        : String(payload.diffStat?.files ?? '…'),
      setActiveTab: (tab) => this._setActiveTab(tab),
    });
  }

  private _renderTabContent(payload: ReadyGatePayload) {
    switch (this._activeTab) {
      case 'criteria':
        // Criteria live in the Evidence tab's review; old links land there.
        return this._renderEvidenceTab(payload);
      case 'pr-preview':
        return this._renderPrPreviewTab(payload);
      case 'input':
        return this._renderInputTab(payload);
      case 'diff':
        return this._renderDiffTab();
      case 'evidence':
        return this._renderEvidenceTab(payload);
      case 'quality':
        return html`<div class="rdy-checks-tab">
          ${this._renderPackagePanel(payload)}${this._renderReviewFlow()}${this._renderQualityTab(
            payload,
          )}
        </div>`;
      case 'recipe':
        return this._renderRecipeTab(payload);
      case 'learnings':
        return this._renderLearningsTab(payload);
      default:
        return nothing;
    }
  }

  private _renderPrPreviewTab(payload: ReadyGatePayload) {
    if (this._packagePending && !payload.prPackage) return renderPrPreviewSkeleton();
    return html`${renderReadyPackageMetadata({
      payload,
      decision: this._gateDecision,
      publicationTarget: this._publicationTarget,
      pendingConfirm: null,
      acting: this._acting,
      recovering: this._isRecovering,
      fileDiffAvailable: Boolean(this._fileDiff),
      diffArtifact: this._primaryDiffArtifact(payload),
      actionMessage: '',
      actionTone: '',
      openDiff: (title, artifact) => this._openDiffModal(title, artifact),
      openReviewRequestModal: () => this._openReviewRequestModal(),
      confirmAction: (id) => this._confirmAction(id),
    })}${renderReadyPrPreviewTab({
      payload,
      publicationTarget: this._publicationTarget,
      markdown: this._renderPrPreviewMarkdown(payload),
      fallback: () => this._renderDiffTab(),
      claims: nothing,
    })}`;
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
      recovering: this._isRecovering && !this._readingHeldDiff,
      fileDiffLoading: this._fileDiffLoading,
      fileDiffError: this._fileDiffError,
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
      recovering: this._isRecovering || this._actionsPaused,
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
      return isRunArtifactMediaPath(artifact.path);
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
    const artifacts = this._visibleEvidenceArtifacts(payload);
    return renderReadyEvidenceTab({
      payload,
      artifacts,
      criteria: this._renderClaimReview(),
      loading: (this._packagePending || this._evidenceLoading) && !this.mockData,
      error:
        this._evidenceError ||
        (this._evidenceModel?.errors.length ? 'Evidence files could not be verified.' : ''),
      retry: () => void this._queries.retry(),
      selectionToolbar: this._renderEvidenceSelectionToolbar(payload),
      artifactGroups: this._evidenceModel
        ? html` ${payload.prPackage && !this._gateDecision?.resolvedAt
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

  private _reviewJudgments(): EvidenceReviewerJudgments | undefined {
    const model = this._evidenceModel;
    if (!model) return undefined;
    const controls = this._visualReviewControls();
    return {
      rows: acceptanceClaimRows({
        criterionDrafts: this._gateDecision?.resolvedAt ? [] : this._criterionDrafts.entries,
        attestationReason: this._evidenceAttestationReason,
        claims: model.claims.map((claim) => ({
          ...claim,
          evidenceLinked: claim.evidence.length > 0,
        })),
        judgmentRows: controls.judgmentRows,
        pendingVisualClaimIds: model.pendingVisualClaimIds,
        recording: model.recording,
      }),
      busy: controls.busy,
      feedback: controls.feedback,
      reviewReason: controls.reviewReason,
      changeReviewReason: controls.changeReviewReason,
      recordReview: controls.recordReview,
    };
  }

  /** One evidence file of the open package, served and reviewed through the gate's model. */
  private _evidenceItem(path: string): LightboxItem {
    return {
      path,
      purpose: 'evidence',
      url: this._lightboxArtifactUrl({ path, purpose: 'evidence' }),
      ...(this._evidenceModel ? { evidenceModel: this._evidenceModel } : {}),
      resolveArtifactUrl: (artifact) =>
        this._lightboxArtifactUrl({ path: artifact, purpose: 'evidence' }),
    };
  }

  /** The gallery of the criterion the review shows, which may not be the one it opened on. */
  private _openClaimGallery(claimId: string): void {
    const claim = this._evidenceModel?.claims.find((candidate) => candidate.id === claimId);
    // The review offers All files only for a criterion with files; never show another's.
    if (!claim?.evidence.length) return;
    this._review = null;
    writeEvidenceReviewerHash(null);
    this._evidenceModel?.selectClaim(claimId);
    this._evidenceItems = claim.evidence.map((artifact) =>
      this._evidenceItem(artifact.artifactPath),
    );
    this._lightboxIndex = 0;
    this._lightboxMode = 'single';
    this._lightboxOpen = true;
  }

  /**
   * The open review over the gate's current model: a reload or a late recording
   * replaces the model, and the review follows it rather than the one it opened on.
   */
  private _reviewSelection(
    review: EvidenceReviewerSelection,
    model: EvidenceReviewModel,
  ): EvidenceReviewerSelection {
    return {
      ...evidenceReviewerSelection({
        model,
        claimId: review.claimId,
        resolveUrl: (path) => this._lightboxArtifactUrl({ path, purpose: 'evidence' }),
        opened: review.opened,
      }),
      atMs: review.atMs,
      check: review.check,
      link: review.link,
      judgments: this._reviewJudgments(),
    };
  }

  /** One criterion's evidence opens in the shared review, on the chosen file. */
  private _openReview(claimId: string | undefined, opened: LightboxItem | undefined): void {
    const model = this._evidenceModel;
    if (!model || !claimId) {
      this._lightboxOpen = true;
      return;
    }
    this._review = evidenceReviewerSelection({
      model,
      claimId,
      resolveUrl: (path) => this._lightboxArtifactUrl({ path, purpose: 'evidence' }),
      opened,
    });
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
    if (this._gateDecision?.resolvedAt) return nothing;
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
      isRunArtifactMediaPath(artifact.path) && this.runId
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
