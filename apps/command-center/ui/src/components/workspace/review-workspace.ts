// <review-workspace> — PR review gate with diff viewer + line comments
// Shows the PR diff with review comments overlaid so the reviewer can
// see exactly what code each comment refers to before posting.

import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type {
  ArtifactRef,
  FsReadResult,
  GitBranchDiffFile,
  GitBranchDiffResult,
  GitDiffResult,
  ReviewGatePayload,
  ReviewLineComment,
  RunDecision,
} from '@farmslot/protocol';
import { buildRunResolveDecisionParams, Events, Methods } from '@farmslot/protocol';

import '../diff-viewer/diff-review.js';
import '../diff-viewer/code-viewer.js';
import '../shared/media-lightbox.js';
import '../shared/diff-viewer-modal.js';
import './recipe-output-panel.js';

import { gateway } from '../../gateway-client.js';
import { colors } from '../../styles/theme-tokens.js';
import { renderMarkdown } from '../../utils/markdown.js';
import { currentRecoveryEpoch, isRecoveryEpochCurrent } from '../../utils/reconnect.js';
import { renderRecipeQualityCockpit } from '../recipe/recipe-quality-cockpit.js';
import { createReviewWorkspaceRecipeHostEntry } from '../recipe/recipe-quality-hosts.js';
import type { LightboxItem } from '../shared/media-lightbox-types.js';
import {
  committedReviewBranchDiffRequest,
  committedReviewFileDiffRequest,
  normalizeReviewBaseRef,
} from '../slot-view/slot-view-branch-model.js';

import {
  renderWorkspaceLearningsTab,
  renderWorkspaceQualityTab,
} from './ready-workspace-tab-renderers.js';
import type { RecipeOutputPanel } from './recipe-output-panel.js';
import { reviewEvidenceArtifacts } from './review-evidence.js';
import { reviewWorkspaceLanguageForPath } from './review-workspace-code-model.js';
import {
  reviewCommentCountByFile,
  reviewCommentKey,
  reviewCommentsByFile,
  reviewThreadsForFile,
} from './review-workspace-comment-model.js';
import { renderReviewWorkspaceStyles } from './review-workspace-renderers.js';
import {
  renderReviewBranchBanner,
  renderReviewCommentItem,
  renderReviewFileTab,
  renderReviewLoadingBanner,
  renderReviewTabBar,
  renderReviewTopBar,
} from './review-workspace-shell-renderers.js';
import { ReviewWorkspaceState } from './review-workspace-state.js';
import { runArtifactUrl, workspaceArtifactBasename } from './workspace-artifacts.js';
import {
  dedupeWorkspaceEvidenceArtifacts,
  renderWorkspaceEvidencePreview,
} from './workspace-evidence-preview.js';
import type { ReviewWorkspaceTab } from './workspace-url-state.js';

@customElement('review-workspace')
export class ReviewWorkspace extends ReviewWorkspaceState {
  private readonly _onHashChange = () => {
    this._readTabFromHash();
    this._normalizeActiveTab();
  };

  private get _payload(): ReviewGatePayload {
    return this.decision.payload as ReviewGatePayload;
  }

  private get _baseRef(): string {
    return normalizeReviewBaseRef(this._payload?.reviewSnapshot?.baseRef ?? this._payload?.baseRef);
  }

  private get _comments(): ReviewLineComment[] {
    return this._payload?.lineComments ?? [];
  }

  /** Media artifacts from the review gate payload */
  private get _mediaArtifacts(): ArtifactRef[] {
    return dedupeWorkspaceEvidenceArtifacts(
      reviewEvidenceArtifacts(this._payload?.artifactManifest),
    );
  }

  /** Lightbox items derived from media artifacts */
  private _lightboxItems(mediaArtifacts: ArtifactRef[]): LightboxItem[] {
    return mediaArtifacts.map((a) => ({
      url: runArtifactUrl(this.runId, a),
      path: a.path,
      purpose: a.purpose,
    }));
  }

  private _openReviewInputDiff(): void {
    const diffPath =
      this._payload.reviewSnapshot?.diffPath ??
      this._payload.reviewInputArtifactPaths?.find(
        (path) => path.endsWith('diff.txt') || path.endsWith('.diff'),
      );
    if (!diffPath) return;
    this._diffModalTitle = `Review input ${this._payload.reviewSnapshot?.headSha?.slice(0, 7) ?? 'diff'}`;
    this._diffModalUrl =
      this._payload.artifactUrls?.[diffPath] ??
      this._payload.artifactUrls?.[workspaceArtifactBasename(diffPath)] ??
      runArtifactUrl(this.runId, { path: diffPath });
    this._diffModalOpen = true;
  }

  /** Map of file path → comments for that file */
  private get _commentsByFile(): Map<string, ReviewLineComment[]> {
    return reviewCommentsByFile(this._comments);
  }

  /** Comment count per file path */
  private get _commentCountByFile(): Map<string, number> {
    return reviewCommentCountByFile(this._commentsByFile);
  }

  private _unsubSlot?: () => void;
  private _unsubConn?: () => void;
  private _unsubDecision?: () => void;
  private _unsubImprovementFail?: () => void;
  private _proposingTimer?: ReturnType<typeof setTimeout>;
  private static readonly PROPOSING_TIMEOUT_MS = 120_000;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('hashchange', this._onHashChange);
    // Re-check branch when slot changes (e.g. after external checkout)
    this._unsubSlot = gateway.subscribe(Events.SLOT_CHANGED, () => {
      if (this._branchMismatch) this._loadBranchDiff();
    });
    this._unsubConn = gateway.onConnectionChange((state) => {
      if (!this._initialized) return;
      if (state === 'disconnected') {
        this._recoveryPhase = 'stale';
        this._recoveryMessage = 'Waiting for gateway to resume review context…';
        return;
      }
      if (state === 'connected' && this._recoveryPhase !== 'live') {
        void this._beginRecovery();
      }
    });
    this._unsubDecision = gateway.subscribe<{ runId: string; decision: RunDecision }>(
      Events.RUN_DECISION_NEW,
      (p) => {
        if (p.runId !== this.runId) return;
        if (p.decision?.type !== 'improvement') return;
        this._clearProposingLatch();
      },
    );
    this._unsubImprovementFail = gateway.subscribe<{ runId: string; error: string }>(
      Events.RUN_IMPROVEMENT_FAILED,
      (p) => {
        if (p.runId !== this.runId) return;
        this._proposeError = p.error || 'Improvement analysis failed';
        this._clearProposingLatch();
      },
    );
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this._onHashChange);
    this._unsubSlot?.();
    this._unsubConn?.();
    this._unsubDecision?.();
    this._unsubImprovementFail?.();
    this._clearProposingLatch();
    this._splitResizer.disconnect();
    this._confirmTimer.clear();
  }

  private _clearProposingLatch() {
    if (this._proposingTimer) {
      clearTimeout(this._proposingTimer);
      this._proposingTimer = undefined;
    }
    this._proposing = false;
  }

  willUpdate() {
    if (!this._initialized && this.decision) {
      this._includedComments = new Set(this._comments.map((_, i) => i));
      this._selectedRecommendation = this._payload.recommendation ?? 'COMMENT';
      this._initialized = true;
      this._readTabFromHash();
      this._normalizeActiveTab();
      void this._beginRecovery();
    }
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has('decision') && this._initialized) {
      if (this._preservedInclusion) {
        // Refresh in progress — preserve reviewer curation across payload replace.
        // New comments (no match) default to included, matching initial seeding.
        const snapshot = this._preservedInclusion;
        this._preservedInclusion = undefined;
        const next = new Set<number>();
        this._comments.forEach((c, i) => {
          const wasIncluded = snapshot.get(this._commentKey(c));
          if (wasIncluded === undefined || wasIncluded) next.add(i);
        });
        this._includedComments = next;
      } else {
        this._includedComments = new Set(this._comments.map((_, i) => i));
      }
      if (this._preservedIncludeEvidence !== undefined) {
        this._includeEvidence = this._preservedIncludeEvidence;
        this._preservedIncludeEvidence = undefined;
      } else {
        this._includeEvidence = true;
      }
      this._normalizeActiveTab();
    }
    // Re-check if slotId changes
    if (changed.has('slotId') && this._initialized) {
      void this._beginRecovery();
    }
  }

  private _commentKey(c: ReviewLineComment): string {
    return reviewCommentKey(c);
  }

  private _preservedInclusion?: Map<string, boolean>;
  private _preservedIncludeEvidence?: boolean;

  private get _isRecovering(): boolean {
    return this._recoveryPhase !== 'live';
  }

  private async _beginRecovery() {
    if (!this.slotId) {
      // No slot context (e.g. dev harness) — skip recovery, show content directly
      this._recoveryPhase = 'live';
      this._recoveryMessage = '';
      return;
    }
    if (gateway.connectionState !== 'connected') {
      this._recoveryPhase = 'stale';
      this._recoveryMessage = 'Waiting for gateway to resume review context…';
      return;
    }
    // Coalesce double-fire from willUpdate + updated lifecycles so we don't
    // burn an extra ~400ms branch-diff round trip per panel open.
    if (this._recoveryInFlight) return;
    this._recoveryInFlight = true;

    // Diff view has no dependency on fleet/runs/decisions bootstrap — fire git
    // RPCs immediately rather than blocking on waitForCoreHydration (which can
    // add 0.15–3s on cold page loads).
    const epoch = currentRecoveryEpoch();
    this._recoveryEpoch = epoch;
    this._recoveryPhase = 'rehydrating';
    this._recoveryMessage = 'Refreshing review workspace from gateway…';
    try {
      await this._loadBranchDiff(epoch);
    } finally {
      this._recoveryInFlight = false;
    }
  }

  // --- Data loading ---

  private async _loadBranchDiff(
    epoch = this._recoveryEpoch || currentRecoveryEpoch(),
    opts: { forceRefreshSlotBranch?: boolean } = {},
  ) {
    if (!this.slotId) return;
    this._diffLoading = true;
    this._branchMismatch = false;
    const t0 = performance.now();
    try {
      // Check current branch — only if we have an expected branch to compare against.
      // Reuse slotBranch from slot-view's _liveGitData when provided to skip the
      // redundant git.status RPC (one less SSH round-trip, ~0.22s on remote slots).
      // Callers recovering from a mismatch (post-checkout reload) MUST set
      // forceRefreshSlotBranch — slot-view's _liveGitData is event-driven and
      // can lag a checkout by hundreds of ms, which would otherwise leave the
      // diff view stuck on a stale mismatch banner.
      if (this.branch) {
        let currentBranch = opts.forceRefreshSlotBranch ? '' : this.slotBranch;
        if (!currentBranch) {
          const status = await gateway.request<{ branch: string }>(Methods.GIT_STATUS, {
            slotId: this.slotId,
          });
          if (epoch !== this._recoveryEpoch || !isRecoveryEpochCurrent(epoch)) return;
          currentBranch = status.branch;
        }
        this._slotBranch = currentBranch;
        console.log(`[review-workspace] slot branch="${currentBranch}" expected="${this.branch}"`);

        // Mismatch: slot on main/different branch
        if (currentBranch !== this.branch && !currentBranch.endsWith(this.branch)) {
          this._branchMismatch = true;
          this._recoveryPhase = 'live';
          this._recoveryMessage = '';
          return;
        }
      }

      const result = await gateway.request<GitBranchDiffResult>(
        Methods.GIT_BRANCH_DIFF,
        committedReviewBranchDiffRequest(this.slotId, this._baseRef),
      );
      if (epoch !== this._recoveryEpoch || !isRecoveryEpochCurrent(epoch)) return;
      this._diffFiles = result.files;
      // Auto-select first file with comments, or first file
      const firstCommented = result.files.find((f) => this._commentCountByFile.has(f.path));
      const first = firstCommented ?? result.files[0];
      if (first) this._selectFile(first.path);
    } catch (err) {
      if (epoch !== this._recoveryEpoch || !isRecoveryEpochCurrent(epoch)) return;
      console.error('[review-workspace] branch diff failed:', err);
      this._recoveryPhase = 'error';
      this._recoveryMessage = 'Review workspace failed to recover — retry when ready.';
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
      console.log(
        `[review-workspace] branchDiff ${(performance.now() - t0).toFixed(0)}ms (files=${this._diffFiles.length})`,
      );
    }
  }

  private async _checkoutBranch() {
    if (!this.slotId || !this.branch || this._isRecovering) return;
    this._checkingOut = true;
    try {
      await gateway.request(Methods.SLOT_PREPARE, {
        slotId: this.slotId,
        branch: this.branch,
      });
      // Reload diff after checkout. Force a fresh GIT_STATUS — the parent
      // slot-view's _liveGitData is event-driven and can still hold the
      // pre-checkout branch at this point, which would leave the workspace
      // stuck on a stale mismatch banner even though checkout succeeded.
      this._branchMismatch = false;
      await this._loadBranchDiff(undefined, { forceRefreshSlotBranch: true });
    } catch (err) {
      console.error('[review-workspace] checkout failed:', err);
    } finally {
      this._checkingOut = false;
    }
  }

  private async _selectFile(path: string) {
    this._selectedFile = path;
    // Clear comment selection when navigating via file tab (not comment click)
    this._selectedCommentIdx = -1;
    this._commentFileContent = '';
    this._fileDiffLoading = true;
    this._fileDiff = '';
    try {
      const result = await gateway.request<GitDiffResult>(
        Methods.GIT_DIFF,
        committedReviewFileDiffRequest(this.slotId, path, this._baseRef),
      );
      this._fileDiff = result.diff;
    } catch (err) {
      console.error('[review-workspace] file diff failed:', err);
      this._fileDiff = '';
    } finally {
      this._fileDiffLoading = false;
    }
  }

  // --- Actions ---

  private _toggleComment(idx: number) {
    if (this._isRecovering) return;
    const next = new Set(this._includedComments);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    this._includedComments = next;
  }

  private _confirmAction(actionId: string, fn: () => void) {
    this._confirmTimer.confirm(actionId, fn);
  }

  private _handlePost() {
    if (this._isRecovering) return;
    this._confirmAction('post', async () => {
      this._posting = true;
      try {
        await gateway.request(
          Methods.RUN_RESOLVE_DECISION,
          buildRunResolveDecisionParams({
            runId: this.runId,
            decision: this.decision,
            actionId: 'post',
            selectionData: {
              includedIndices: [...this._includedComments],
              recommendation: this._selectedRecommendation,
              includeEvidence: this._includeEvidence,
              ...(this._evidenceOverrides.size > 0
                ? { evidenceOverrides: Object.fromEntries(this._evidenceOverrides) }
                : {}),
            },
          }),
        );
      } catch (err) {
        console.error('Failed to post review:', err);
      } finally {
        this._posting = false;
      }
    });
  }

  private _handleDismiss() {
    if (this._isRecovering) return;
    this._confirmAction('dismiss', async () => {
      this._posting = true;
      try {
        await gateway.request(
          Methods.RUN_RESOLVE_DECISION,
          buildRunResolveDecisionParams({
            runId: this.runId,
            decision: this.decision,
            actionId: 'dismiss',
          }),
        );
      } catch (err) {
        console.error('Failed to dismiss review:', err);
      } finally {
        this._posting = false;
      }
    });
  }

  private async _handleRefresh() {
    if (this._isRecovering || this._refreshing) return;
    this._refreshing = true;
    // Snapshot reviewer's curation keyed on comment identity so it survives
    // the payload replace that refreshReviewGate triggers.
    this._preservedInclusion = new Map(
      this._comments.map((c, i) => [this._commentKey(c), this._includedComments.has(i)]),
    );
    this._preservedIncludeEvidence = this._includeEvidence;
    try {
      await gateway.request(Methods.RUN_REFRESH_REVIEW_GATE, { runId: this.runId });
    } catch (err) {
      console.error('Failed to refresh review artifacts:', err);
      this._preservedInclusion = undefined;
      this._preservedIncludeEvidence = undefined;
    } finally {
      this._refreshing = false;
    }
  }

  private async _handleProposeImprovement() {
    if (this._isRecovering || this._proposing) return;
    this._proposing = true;
    this._proposeError = null;
    // Latch stays held until the improvement decision arrives via RUN_DECISION_NEW
    // or the timeout fires — run.proposeImprovement is fire-and-forget, so the
    // RPC returning doesn't mean analysis finished.
    this._proposingTimer = setTimeout(() => {
      this._clearProposingLatch();
    }, ReviewWorkspace.PROPOSING_TIMEOUT_MS);
    try {
      await gateway.request(Methods.RUN_PROPOSE_IMPROVEMENT, {
        runId: this.runId,
        rationale:
          'review-pr human gate — analyze what went wrong in the evidence review / recipe coverage and propose a recipe/process fix',
      });
    } catch (err) {
      const msg = (err as Error).message || 'Unknown error';
      console.error('Failed to propose improvement:', err);
      this._proposeError = msg;
      this._clearProposingLatch();
    }
  }

  private async _handleRecipeRerun() {
    this._setActiveTab('recipe');
    await this.updateComplete;
    this.querySelector<RecipeOutputPanel>('recipe-output-panel')?.rerun();
  }

  private _handleRecipeCancel() {
    this.querySelector<RecipeOutputPanel>('recipe-output-panel')?.cancel();
  }

  // --- Render ---

  // Styles injected in render() since we use light DOM

  override render() {
    if (!this.decision) return html`<div class="diff-empty">No review decision</div>`;
    const payload = this._payload;
    if (!payload) return html`<div class="diff-empty">Invalid review payload</div>`;
    const recipeHost = createReviewWorkspaceRecipeHostEntry({
      runId: this.runId,
      slotId: this.slotId,
      branch: this.branch || null,
      payload,
    });
    const mediaArtifacts = this._mediaArtifacts;

    return html`
      ${renderReviewWorkspaceStyles(this._recoveryPhase)} ${this._renderTopBar()}
      ${this._renderLoadingBanner()} ${this._branchMismatch ? this._renderBranchBanner() : nothing}
      <div class="rw-split">
        ${this._isRecovering
          ? html`
              <div class="rw-recovery-overlay" role="status" aria-live="polite">
                <div class="rw-recovery-card">
                  <div class="rw-recovery-eyebrow">
                    ${this._recoveryPhase === 'error'
                      ? 'Recovery blocked'
                      : 'Recovering review workspace'}
                  </div>
                  <div class="rw-recovery-title">
                    ${this._recoveryPhase === 'error'
                      ? 'Retry review recovery'
                      : 'Refreshing review data from gateway'}
                  </div>
                  <div class="rw-recovery-copy">${this._recoveryMessage}</div>
                  ${this._recoveryPhase === 'error' && gateway.connectionState === 'connected'
                    ? html`
                        <div class="rw-recovery-actions">
                          <button class="rw-recovery-btn" @click=${() => this._beginRecovery()}>
                            Retry now
                          </button>
                        </div>
                      `
                    : nothing}
                </div>
              </div>
            `
          : nothing}
        ${payload.reviewSnapshot
          ? html`
              <div class="rw-review-snapshot">
                <span
                  >Reviewed
                  ${payload.reviewSnapshot.headSha?.slice(0, 7) ??
                  payload.reviewSnapshot.source}</span
                >
                ${payload.stale ? html`<span class="rw-snapshot-stale">stale</span>` : nothing}
                ${payload.reviewSnapshot.diffStat
                  ? html`
                      <button class="rw-snapshot-diff" @click=${() => this._openReviewInputDiff()}>
                        <span style="color:${colors.statusOk}"
                          >+${payload.reviewSnapshot.diffStat.additions}</span
                        >
                        <span style="color:${colors.statusFail}"
                          >-${payload.reviewSnapshot.diffStat.deletions}</span
                        >
                        <span>${payload.reviewSnapshot.diffStat.files} files</span>
                      </button>
                    `
                  : nothing}
              </div>
            `
          : nothing}
        ${this._renderTabBar(mediaArtifacts.length, payload)}
        <div class="rw-tab-pane-host" style="flex: ${this._splitPct} 1 0%">
          ${this._renderTabContent(payload, recipeHost, mediaArtifacts)}
          ${this._renderRecipeOutputPanel(recipeHost)}
        </div>
        <div class="rw-resize" @mousedown=${this._splitResizer.start}></div>
        <div class="rw-bottom" style="flex: ${100 - this._splitPct} 1 0%">
          ${this._comments.length > 0
            ? html`
                <div class="rw-comments-sb">
                  <div class="rw-sb-header">Line Comments (${this._comments.length})</div>
                  <div class="rw-comment-list">
                    ${this._comments.map((c, i) => this._renderCommentItem(c, i))}
                  </div>
                </div>
              `
            : nothing}
          <div class="rw-diff-area">
            ${this._branchMismatch
              ? nothing
              : this._diffLoading
                ? html`<div class="rw-diff-loading">Loading diff...</div>`
                : this._diffFiles.length > 0
                  ? html`
                      <div class="rw-file-tabs">
                        ${this._diffFiles.map((f) => this._renderFileTab(f))}
                      </div>
                      ${this._renderCodePanel()}
                    `
                  : html`<div class="rw-diff-empty">
                      ${this._selectedFile ? 'No diff' : 'No changed files'}
                    </div>`}
          </div>
        </div>
      </div>
      <media-lightbox
        .items=${this._lightboxItems(mediaArtifacts)}
        .open=${this._lightboxOpen}
        .selectedIndex=${this._lightboxIndex}
        @lightbox-close=${() => {
          this._lightboxOpen = false;
        }}
        @lightbox-navigate=${(e: CustomEvent) => {
          this._lightboxIndex = e.detail.index;
        }}
      ></media-lightbox>
      <diff-viewer-modal
        .open=${this._diffModalOpen}
        .title=${this._diffModalTitle}
        .artifactUrl=${this._diffModalUrl}
        @diff-modal-close=${() => {
          this._diffModalOpen = false;
        }}
      ></diff-viewer-modal>
    `;
  }

  private _activeLoadingPhase(): string | null {
    // Recovery has its own full-panel overlay — don't double up the banner.
    if (this._isRecovering) return null;
    if (this._refreshing) return 'Refreshing review artifacts from gateway…';
    if (this._diffLoading) return 'Loading changed files (git branch diff)…';
    if (this._commentFileLoading) return 'Loading file content for code review…';
    if (this._fileDiffLoading) return 'Loading file diff…';
    if (this._checkingOut) return `Checking out ${this.branch}…`;
    if (this._posting) return 'Posting review to GitHub…';
    return null;
  }

  private _renderLoadingBanner() {
    return renderReviewLoadingBanner(this._activeLoadingPhase());
  }

  private _renderBranchBanner() {
    return renderReviewBranchBanner({
      slotBranch: this._slotBranch,
      branch: this.branch,
      checkingOut: this._checkingOut,
      recovering: this._isRecovering,
      refresh: () => this._loadBranchDiff(undefined, { forceRefreshSlotBranch: true }),
      checkout: () => this._checkoutBranch(),
    });
  }

  private _normalizeActiveTab() {
    const payload = this._payload;
    if (!payload) return;
    const evidenceCount = this._mediaArtifacts.length;
    const qualityAvailable = payload.qualityReport != null;
    let tab: ReviewWorkspaceTab = this._activeTab;
    if (tab === 'evidence' && evidenceCount === 0) tab = 'review';
    if (tab === 'quality' && !qualityAvailable) tab = 'review';
    if (tab === 'recipe' && !payload.recipeJson) tab = 'review';
    if (tab === 'learnings' && !payload.workerLearnings) tab = 'review';
    if (tab !== this._activeTab) {
      this._activeTab = tab;
      this._syncTabToHash();
    }
  }

  private _renderRecipeOutputPanel(
    recipeHost: ReturnType<typeof createReviewWorkspaceRecipeHostEntry>,
  ) {
    if (!recipeHost.outputTarget) return nothing;
    const visible = this._activeTab === 'recipe' || this._recipeRunning;
    return html`
      <div class="rw-recipe-output-host" style="${visible ? '' : 'display:none'}">
        <recipe-output-panel
          runId=${recipeHost.outputTarget.runId}
          slotId=${recipeHost.outputTarget.slotId}
          @running-change=${(e: CustomEvent<boolean>) => {
            this._recipeRunning = e.detail;
            if (e.detail) this._setActiveTab('recipe');
          }}
        ></recipe-output-panel>
      </div>
    `;
  }

  private _renderTabBar(evidenceCount: number, payload: ReviewGatePayload) {
    return renderReviewTabBar({
      activeTab: this._activeTab,
      evidenceCount,
      qualityCount: payload.qualityReport?.acVerdicts.length ?? null,
      hasRecipe: Boolean(payload.recipeJson),
      hasLearnings: Boolean(payload.workerLearnings),
      setActiveTab: (tab) => this._setActiveTab(tab),
    });
  }

  private _renderTabContent(
    payload: ReviewGatePayload,
    recipeHost: ReturnType<typeof createReviewWorkspaceRecipeHostEntry>,
    mediaArtifacts: ArtifactRef[],
  ) {
    switch (this._activeTab) {
      case 'evidence':
        return mediaArtifacts.length > 0
          ? html`<div class="rw-md-section rw-evidence-tab">
              ${renderWorkspaceEvidencePreview({
                title: 'Review evidence',
                subtitle:
                  'Screenshot and video artifacts attached to this review gate — inspect before posting.',
                items: mediaArtifacts.map((artifact, index) => ({
                  artifact,
                  url: runArtifactUrl(this.runId, artifact),
                  open: () => {
                    this._lightboxIndex = index;
                    this._lightboxOpen = true;
                  },
                })),
              })}
            </div>`
          : html`<div class="rw-tab-empty">No evidence</div>`;
      case 'quality':
        return html`<div class="rw-md-section">${renderWorkspaceQualityTab(payload)}</div>`;
      case 'learnings':
        return html`<div class="rw-md-section">${renderWorkspaceLearningsTab(payload)}</div>`;
      case 'recipe':
        return html`<div class="rw-md-section">
          ${renderRecipeQualityCockpit({
            recipeJson: recipeHost.recipeJson,
            recipeView: this._recipeView,
            onRecipeViewChange: (view) => {
              this._recipeView = view;
            },
            recipeQualityArtifact: recipeHost.recipeQualityArtifact,
            qualityReport: recipeHost.qualityReport,
            qualityOverrides: this._evidenceOverrides,
            onQualityOverridesChange: (overrides) => {
              this._evidenceOverrides = overrides;
            },
            showQuality: false,
            showLearnings: false,
            showRecipe: true,
            actionContent:
              recipeHost.capabilities.canCancel && this._recipeRunning
                ? html`<button
                    class="rw-recipe-toggle"
                    style="color:${colors.statusFail}"
                    @click=${this._handleRecipeCancel}
                  >
                    Cancel
                  </button>`
                : recipeHost.capabilities.canRerun
                  ? html`<button
                      class="rw-recipe-toggle"
                      style="color:${colors.statusOk}"
                      ?disabled=${!this.slotId}
                      @click=${() => void this._handleRecipeRerun()}
                    >
                      Rerun Recipe
                    </button>`
                  : undefined,
          })}
        </div>`;
      case 'review':
      default:
        return html`<div class="rw-md-section">
          ${unsafeHTML(renderMarkdown(payload.reviewMd))}
        </div>`;
    }
  }

  private _renderTopBar() {
    return renderReviewTopBar({
      comments: this._comments,
      includedComments: this._includedComments.size,
      selectedRecommendation: this._selectedRecommendation,
      setRecommendation: (recommendation) => {
        this._selectedRecommendation = recommendation;
      },
      hasLearnings: Boolean(this._payload?.workerLearnings),
      evidenceCount: this._mediaArtifacts.length,
      includeEvidence: this._includeEvidence,
      setIncludeEvidence: (includeEvidence) => {
        this._includeEvidence = includeEvidence;
      },
      posting: this._posting,
      recovering: this._isRecovering,
      refreshing: this._refreshing,
      proposing: this._proposing,
      proposeError: this._proposeError,
      pendingConfirm: this._pendingConfirm,
      refresh: () => this._handleRefresh(),
      proposeImprovement: () => this._handleProposeImprovement(),
      post: () => this._handlePost(),
      dismiss: () => this._handleDismiss(),
    });
  }

  private _renderFileTab(f: GitBranchDiffFile) {
    return renderReviewFileTab({
      file: f,
      selectedFile: this._selectedFile,
      commentCount: this._commentCountByFile.get(f.path) ?? 0,
      recovering: this._isRecovering,
      selectFile: (path) => this._selectFile(path),
    });
  }

  private _renderCommentItem(c: ReviewLineComment, idx: number) {
    return renderReviewCommentItem({
      comment: c,
      selected: this._selectedCommentIdx === idx,
      included: this._includedComments.has(idx),
      toggle: () => this._toggleComment(idx),
      navigate: () => this._navigateToComment(c, idx),
    });
  }

  private async _navigateToComment(c: ReviewLineComment, idx: number) {
    if (this._isRecovering) return;
    this._selectedCommentIdx = idx;
    this._revealLine = 0; // reset so Lit detects change when we set it again
    // Switch file diff (without clearing comment selection)
    if (this._selectedFile !== c.path) {
      this._selectedFile = c.path;
      this._fileDiffLoading = true;
      this._fileDiff = '';
      const tDiff = performance.now();
      gateway
        .request<GitDiffResult>(
          Methods.GIT_DIFF,
          committedReviewFileDiffRequest(this.slotId, c.path, this._baseRef),
        )
        .then((r) => {
          this._fileDiff = r.diff;
        })
        .catch((err) => {
          console.error('[review-workspace] file diff navigation failed:', err);
        })
        .finally(() => {
          this._fileDiffLoading = false;
          console.log(
            `[review-workspace] fileDiff ${(performance.now() - tDiff).toFixed(0)}ms path=${c.path}`,
          );
        });
    }
    // Load file content for code-viewer with ViewZone
    this._commentFileLoading = true;
    this._commentFileContent = '';
    const tFs = performance.now();
    try {
      const result = await gateway.request<FsReadResult>(Methods.FS_READ, {
        slotId: this.slotId,
        path: c.path,
      });
      this._commentFileContent = result.content;
    } catch {
      this._commentFileContent = '';
    } finally {
      this._commentFileLoading = false;
      console.log(
        `[review-workspace] fsRead ${(performance.now() - tFs).toFixed(0)}ms path=${c.path}`,
      );
    }
    // Set revealLine after content is loaded — use requestAnimationFrame
    // to ensure code-viewer has processed the content update first
    await this.updateComplete;
    requestAnimationFrame(() => {
      this._revealLine = c.line;
    });
  }

  private _renderCodePanel() {
    const comment = this._selectedCommentIdx >= 0 ? this._comments[this._selectedCommentIdx] : null;

    // When a comment is selected and file is loaded → show code-viewer with ViewZone
    if (comment && this._commentFileContent && this._selectedFile === comment.path) {
      const threads = reviewThreadsForFile(this._commentsByFile, comment.path);
      const basename = workspaceArtifactBasename(comment.path);
      return html`
        <code-viewer
          .content=${this._commentFileContent}
          .language=${reviewWorkspaceLanguageForPath(comment.path)}
          .filename=${basename}
          .filePath=${comment.path}
          .commentThreads=${threads}
          .showComments=${true}
          .revealLine=${this._revealLine}
        ></code-viewer>
      `;
    }

    if (comment && this._commentFileLoading) {
      return html`<div class="rw-diff-loading">Loading file...</div>`;
    }

    // Default: show diff
    if (this._fileDiffLoading) {
      return html`<div class="rw-diff-loading">Loading diff...</div>`;
    }
    if (!this._fileDiff) {
      return html`<div class="rw-diff-empty">
        ${this._selectedFile ? 'No diff available' : 'Select a file'}
      </div>`;
    }

    const basename = workspaceArtifactBasename(this._selectedFile);
    return html` <diff-review .diff=${this._fileDiff} .filename=${basename}></diff-review> `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'review-workspace': ReviewWorkspace;
  }
}
