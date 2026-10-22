// <review-workspace> — PR review gate with diff viewer + line comments
// Shows the PR diff with review comments overlaid so the reviewer can
// see exactly what code each comment refers to before posting.

import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';

import type {
  ArtifactRef,
  GitBranchDiffResult,
  GitDiffResult,
  GitShowResult,
  ReviewGatePayload,
  ReviewLineComment,
  RunDecision,
  RunGetResult,
} from '@farmslot/protocol';
import {
  buildRunResolveDecisionParams,
  Events,
  Methods,
  reviewCommentIndex,
  reviewCommentLocation,
  reviewedFindingContext,
  reviewPostingFingerprint,
  reviewPostRecommendation,
  sourceObservationAge,
} from '@farmslot/protocol';
import { refreshReviewGateView } from '@farmslot/review-dispatch';

import '../runs/review-history-panel.js';
import '../diff-viewer/diff-review.js';
import '../diff-viewer/code-viewer.js';
import '../shared/media-lightbox.js';
import '../shared/step-artifacts.js';
import '../shared/diff-viewer-modal.js';
import './recipe-output-panel.js';

import { gateway } from '../../gateway-client.js';
import { colors } from '../../styles/theme-tokens.js';
import { diffSelectionHandOff } from '../../utils/diff-test-filter.js';
import { renderMarkdown } from '../../utils/markdown.js';
import { currentRecoveryEpoch, isRecoveryEpochCurrent } from '../../utils/reconnect.js';
import { renderRecipeQualityCockpit } from '../recipe/recipe-quality-cockpit.js';
import { createReviewWorkspaceRecipeHostEntry } from '../recipe/recipe-quality-hosts.js';
import { DiffTestFilterController } from '../shared/diff-test-filter-controller.js';
import { gatewayMediaHtml } from '../shared/gateway-media-src.js';
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
import { ReviewWorkspaceQueries } from './review-workspace-queries.js';
import { renderReviewWorkspaceStyles } from './review-workspace-renderers.js';
import {
  renderReviewBranchBanner,
  renderReviewCommentItem,
  renderReviewDiffFiles,
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
import {
  parseReviewWorkspaceHashState,
  type ReviewWorkspaceTab,
  writeReviewWorkspaceHashState,
} from './workspace-url-state.js';

@customElement('review-workspace')
export class ReviewWorkspace extends ReviewWorkspaceState {
  readonly _queries = new ReviewWorkspaceQueries(this);
  private _commandRequest?: object;
  private _recoveryRequest?: object;
  private _restoreReviewSource = false;
  private _proposeScope?: { current(): boolean };

  get _usesMockData(): boolean {
    return window.location.hash.startsWith('#dev/');
  }

  _reviewInputsChanged(): void {
    this.requestUpdate();
  }

  _retireReviewScope(): void {
    this._commandRequest = undefined;
    this._recoveryRequest = undefined;
    this._posting = false;
    this._refreshing = false;
    this._checkingOut = false;
    this._actionError = '';
    this._preservedInclusion = undefined;
    this._preservedIncludeEvidence = undefined;
    this._clearProposingLatch();
    this._proposeError = null;
    this._confirmTimer.clear();
    this._sourceLoadEpoch++;
    this._initialized = false;
    this._lastCurationFingerprint = '';
    this._recoveryInFlight = false;
    this._selectedFile = '';
    this._selectedCommentIdx = -1;
    this._diffFiles = [];
    this._fileDiff = '';
    this._fileDiffLoading = false;
    this._diffLoading = false;
    this._commentFileContent = '';
    this._commentFileError = '';
    this._commentFileLoading = false;
    this._diffModalOpen = false;
    this._diffModalUrl = '';
    this._lightboxOpen = false;
    this._artifactLightboxItems = null;
    this._recipeRunning = false;
    this._evidenceOverrides = new Map();
  }

  private get _actionsPaused(): boolean {
    return this.readOnly || this._isRecovering || (!this._usesMockData && !this._queries.ready);
  }

  private _beginReviewCommand(actionId?: string) {
    if (this._commandRequest) return;
    try {
      if (this._actionsPaused) throw new Error('Wait for current review inputs before acting.');
      const decision = this._queries.requireDecision(actionId);
      const captured = this._queries.capture();
      const runId = this.runId;
      const request = {};
      this._confirmTimer.clear();
      this._commandRequest = request;
      this._actionError = '';
      return {
        runId,
        decision,
        current: () => this._commandRequest === request && captured.current(),
        ownsView: () => this._commandRequest === request && captured.ownsView(),
        finish: () => {
          if (this._commandRequest !== request || !captured.ownsView()) return;
          this._commandRequest = undefined;
          this._posting = false;
          this._refreshing = false;
          this._checkingOut = false;
        },
      };
    } catch (error) {
      this._actionError = error instanceof Error ? error.message : String(error);
      return;
    }
  }
  private readonly _testFilter = new DiffTestFilterController(this, {
    patterns: () => this._diffTestPatterns,
    onChange: () => this._onHideTestsChanged(),
  });

  private readonly _onHashChange = () => {
    this._readTabFromHash();
    this._normalizeActiveTab();
    if (this._initialized && !this._isRecovering) void this._restoreSourceFromHash();
  };

  private _sourceLoadEpoch = 0;

  private _syncSourceToHash() {
    const comment = this._comments[this._selectedCommentIdx];
    writeReviewWorkspaceHashState({
      tab: this._activeTab,
      source: comment
        ? reviewCommentLocation(comment, this._payload?.reviewSnapshot?.headSha ?? undefined)
        : this._selectedFile
          ? { file: this._selectedFile }
          : null,
    });
  }

  private async _restoreSourceFromHash() {
    const { source } = parseReviewWorkspaceHashState();
    if (!source) {
      this._commentFileError = '';
      if (this._selectedCommentIdx >= 0) await this._selectFile(this._selectedFile, false);
      return;
    }
    if (source.comment) {
      const index = reviewCommentIndex(
        this._comments,
        source,
        this._payload?.reviewSnapshot?.headSha ?? undefined,
      );
      if (index < 0) {
        this._sourceLoadEpoch++;
        this._selectedCommentIdx = -1;
        this._commentFileLoading = false;
        this._commentFileError =
          'This finding is unavailable in the current saved review. Open a finding from its recorded review.';
        return;
      }
      if (
        this._selectedCommentIdx === index &&
        this._selectedFile === source.file &&
        (this._commentFileLoading || this._commentFileContent)
      )
        return;
      await this._navigateToComment(this._comments[index], index, false);
    } else if (this._selectedFile !== source.file || this._selectedCommentIdx >= 0) {
      await this._selectFile(source.file, false);
    }
  }

  private get _payload(): ReviewGatePayload | undefined {
    const decision = this._queries.decision;
    return decision?.payload?.kind === 'review' ? decision.payload : undefined;
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
      this._payload?.reviewSnapshot?.diffPath ??
      this._payload?.reviewInputArtifactPaths?.find(
        (path) => path.endsWith('diff.txt') || path.endsWith('.diff'),
      );
    if (!diffPath) return;
    this._diffModalTitle = `Review input ${this._payload?.reviewSnapshot?.headSha?.slice(0, 7) ?? 'diff'}`;
    this._diffModalUrl =
      this._payload?.artifactUrls?.[diffPath] ??
      this._payload?.artifactUrls?.[workspaceArtifactBasename(diffPath)] ??
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

  private _artifactLightboxItems: LightboxItem[] | null = null;

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
        if (p.runId !== this.runId || !this._proposeScope?.current()) return;
        if (p.decision?.type !== 'improvement') return;
        this._clearProposingLatch();
      },
    );
    this._unsubImprovementFail = gateway.subscribe<{ runId: string; error: string }>(
      Events.RUN_IMPROVEMENT_FAILED,
      (p) => {
        if (p.runId !== this.runId || !this._proposeScope?.current()) return;
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
    this._proposeScope = undefined;
  }

  private _lastCurationFingerprint = '';

  willUpdate(changed: Map<string, unknown>) {
    this._queries.sync();
    if (changed.has('resourcePosture') || changed.has('postureBlockedReason'))
      this._confirmTimer.clear();
    const payload = this._payload;
    if (payload) {
      const next = reviewPostingFingerprint(payload);
      if (this._lastCurationFingerprint !== next) {
        this._restoreReviewSource = true;
        this._confirmTimer.clear();
        const preserved = this._preservedInclusion;
        this._preservedInclusion = undefined;
        this._includedComments = new Set(
          this._comments.flatMap((comment, index) =>
            !preserved || preserved.get(this._commentKey(comment)) !== false ? [index] : [],
          ),
        );
        this._includeEvidence = this._preservedIncludeEvidence ?? true;
        this._preservedIncludeEvidence = undefined;
        this._selectedRecommendation = reviewPostRecommendation(payload);
        this._lastCurationFingerprint = next;
        this._sourceLoadEpoch++;
        this._commentFileContent = '';
        this._commentFileError = '';
        this._commentFileLoading = false;
        this._fileDiff = '';
        this._fileDiffLoading = false;
        this._selectedCommentIdx = -1;
        this._lightboxOpen = false;
        this._artifactLightboxItems = null;
        this._normalizeActiveTab();
      }
    }
    if (!this._initialized && payload) {
      this._includedComments = new Set(this._comments.map((_, i) => i));
      this._selectedRecommendation = reviewPostRecommendation(payload);
      this._initialized = true;
      this._readTabFromHash();
      this._normalizeActiveTab();
      void this._beginRecovery();
    }
  }

  override updated(changed: Map<string, unknown>) {
    if (this._restoreReviewSource && this._initialized && this._payload) {
      this._restoreReviewSource = false;
      if (!this._isRecovering) void this._restoreSourceFromHash();
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
    if (!this._payload) return;
    if (!this.slotId && !this.workspaceView) {
      // No slot context (e.g. dev harness) — skip recovery, show content directly
      this._recoveryPhase = 'live';
      this._recoveryMessage = '';
      await this._restoreSourceFromHash();
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
    const request = {};
    this._recoveryRequest = request;
    const captured = this._queries.capture();

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
      if (this._recoveryRequest === request && captured.ownsView()) {
        this._recoveryInFlight = false;
        this._recoveryRequest = undefined;
      }
    }
    if (captured.current() && !this._isRecovering) await this._restoreSourceFromHash();
  }

  // --- Data loading ---

  private async _loadBranchDiff(
    epoch = this._recoveryEpoch || currentRecoveryEpoch(),
    opts: { forceRefreshSlotBranch?: boolean } = {},
  ) {
    if (!this.slotId && !this.workspaceView) return;
    const captured = this._queries.capture();
    const current = () =>
      captured.current() && epoch === this._recoveryEpoch && isRecoveryEpochCurrent(epoch);
    this._diffLoading = true;
    this._diffError = '';
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
      if (this.slotId && this.branch && !this._payload?.reviewSnapshot?.headSha) {
        let currentBranch = opts.forceRefreshSlotBranch ? '' : this.slotBranch;
        if (!currentBranch) {
          const status = await gateway.request<{ branch: string }>(Methods.GIT_STATUS, {
            slotId: this.slotId,
          });
          if (!current()) return;
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

      const result = await gateway.request<GitBranchDiffResult>(Methods.GIT_BRANCH_DIFF, {
        ...committedReviewBranchDiffRequest(
          this.slotId,
          this._baseRef,
          this._payload?.reviewSnapshot,
        ),
        ...(this.workspaceView ? { runId: this.runId } : {}),
      });
      if (!current()) return;
      this._diffFiles = result.files;
      this._diffTestPatterns = result.testFilePatterns ?? null;
      // Auto-select the first listed file with comments, or the first listed file
      const visible = this._testFilter.split(result.files).visible;
      const { source } = parseReviewWorkspaceHashState();
      const first =
        visible.find((f) => f.path === source?.file) ??
        visible.find((f) => this._commentCountByFile.has(f.path)) ??
        visible[0];
      if (first) {
        await this._selectFile(first.path, false);
      } else {
        // Nothing listed: drop a previous selection so showing tests loads this diff's file.
        this._selectedFile = '';
        this._fileDiff = '';
      }
    } catch (err) {
      if (!current()) return;
      console.error('[review-workspace] branch diff failed:', err);
      if (this.workspaceView) {
        // Saved evidence is independent of the Git source. Keep it readable when the source is unavailable.
        this._diffError = err instanceof Error ? err.message : String(err);
        this._diffFiles = [];
        this._diffTestPatterns = null;
        this._fileDiff = '';
        this._recoveryPhase = 'live';
      } else {
        this._recoveryPhase = 'error';
        this._recoveryMessage = 'Review workspace failed to recover — retry when ready.';
      }
    } finally {
      if (captured.ownsView() && epoch === this._recoveryEpoch) this._diffLoading = false;
      if (current() && this._recoveryPhase !== 'error') {
        this._recoveryPhase = 'live';
        this._recoveryMessage = '';
      }
      console.log(
        `[review-workspace] branchDiff ${(performance.now() - t0).toFixed(0)}ms (files=${this._diffFiles.length})`,
      );
    }
  }

  private async _checkoutBranch() {
    if (!this.slotId || !this.branch) return;
    const command = this._beginReviewCommand();
    if (!command) return;
    this._checkingOut = true;
    try {
      this._queries.requireSlot();
      await gateway.request(Methods.SLOT_PREPARE, {
        slotId: this.slotId,
        branch: this.branch,
      });
      if (!command.current()) return;
      // Reload diff after checkout. Force a fresh GIT_STATUS — the parent
      // slot-view's _liveGitData is event-driven and can still hold the
      // pre-checkout branch at this point, which would leave the workspace
      // stuck on a stale mismatch banner even though checkout succeeded.
      this._branchMismatch = false;
      await this._loadBranchDiff(undefined, { forceRefreshSlotBranch: true });
    } catch (err) {
      if (command.current()) this._actionError = err instanceof Error ? err.message : String(err);
    } finally {
      command.finish();
    }
  }

  /** A newly hidden selected file hands the viewer to the first listed file. */
  private _onHideTestsChanged(): void {
    const handOff = diffSelectionHandOff(
      this._testFilter.split(this._diffFiles).visible,
      this._selectedFile,
      Boolean(this._fileDiff) || this._fileDiffLoading,
    );
    if (handOff.kind === 'select') {
      void this._selectFile(handOff.path);
    } else if (handOff.kind === 'clear') {
      // Only tests changed: drop the open test file (and its finding) so the
      // pane shows the all-hidden state instead of a diff the tabs no longer list.
      this._selectedFile = '';
      this._fileDiff = '';
      this._selectedCommentIdx = -1;
      this._commentFileContent = '';
      this._commentFileError = '';
      this._sourceLoadEpoch++;
      this._revealLine = 0;
      this._syncSourceToHash();
    }
  }

  private async _selectFile(path: string, syncHash = true) {
    const epoch = ++this._sourceLoadEpoch;
    const captured = this._queries.capture();
    this._selectedFile = path;
    // Clear comment selection when navigating via file tab (not comment click)
    this._selectedCommentIdx = -1;
    this._commentFileContent = '';
    this._commentFileLoading = false;
    this._commentFileError = '';
    this._revealLine = 0;
    if (syncHash) this._syncSourceToHash();
    this._fileDiffLoading = true;
    this._fileDiff = '';
    try {
      const result = await gateway.request<GitDiffResult>(Methods.GIT_DIFF, {
        ...committedReviewFileDiffRequest(
          this.slotId,
          path,
          this._baseRef,
          this._payload?.reviewSnapshot,
        ),
        ...(this.workspaceView ? { runId: this.runId } : {}),
      });
      if (captured.current() && epoch === this._sourceLoadEpoch) this._fileDiff = result.diff;
    } catch (err) {
      if (captured.current() && epoch === this._sourceLoadEpoch) {
        this._fileDiff = '';
        this._diffError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (captured.ownsView() && epoch === this._sourceLoadEpoch) this._fileDiffLoading = false;
    }
  }

  // --- Actions ---

  private _toggleComment(idx: number) {
    if (this._actionsPaused) return;
    const next = new Set(this._includedComments);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    this._includedComments = next;
  }

  private _confirmAction(actionId: string, fn: () => void) {
    this._confirmTimer.confirm(actionId, fn);
  }

  private _handlePost() {
    if (this._actionsPaused || this._refreshing || !this._postAvailable || !this._payload) return;

    // A posture choice the Gateway already refused must not ride along with a
    // resolution: the decision would be consumed and the refusal repeated.
    if (this.postureBlockedReason) return;
    const selectionData = {
      reviewFingerprint: reviewPostingFingerprint(this._payload),
      includedIndices: [...this._includedComments],
      recommendation: this._selectedRecommendation,
      includeEvidence: this._includeEvidence,
      ...(this._evidenceOverrides.size > 0
        ? { evidenceOverrides: Object.fromEntries(this._evidenceOverrides) }
        : {}),
    };
    this._confirmAction('post', async () => {
      const command = this._beginReviewCommand('post');
      if (!command) return;
      this._posting = true;
      try {
        await gateway.request(
          Methods.RUN_RESOLVE_DECISION,
          buildRunResolveDecisionParams({
            runId: command.runId,
            decision: command.decision,
            actionId: 'post',
            ...(this.resourcePosture ? { resourcePosture: this.resourcePosture } : {}),
            selectionData,
          }),
        );
      } catch (err) {
        if (command.current()) this._actionError = err instanceof Error ? err.message : String(err);
      } finally {
        command.finish();
      }
    });
  }

  private _handleDismiss() {
    if (this._actionsPaused) return;
    // A posture choice the Gateway already refused must not ride along with a
    // resolution: the decision would be consumed and the refusal repeated.
    if (this.postureBlockedReason) return;
    this._confirmAction('dismiss', async () => {
      const command = this._beginReviewCommand('dismiss');
      if (!command) return;
      this._posting = true;
      try {
        await gateway.request(
          Methods.RUN_RESOLVE_DECISION,
          buildRunResolveDecisionParams({
            runId: command.runId,
            decision: command.decision,
            actionId: 'dismiss',
            ...(this.resourcePosture ? { resourcePosture: this.resourcePosture } : {}),
          }),
        );
      } catch (err) {
        if (command.current()) this._actionError = err instanceof Error ? err.message : String(err);
      } finally {
        command.finish();
      }
    });
  }

  private async _handleRefresh() {
    if (this._refreshing) return;
    const command = this._beginReviewCommand();
    if (!command) return;
    this._refreshing = true;
    // Snapshot reviewer's curation keyed on comment identity so it survives
    // the payload replace that refreshReviewGate triggers.
    this._preservedInclusion = new Map(
      this._comments.map((c, i) => [this._commentKey(c), this._includedComments.has(i)]),
    );
    this._preservedIncludeEvidence = this._includeEvidence;
    try {
      const refreshed = await refreshReviewGateView(
        () =>
          gateway.request<RunGetResult>(Methods.RUN_REFRESH_REVIEW_GATE, { runId: command.runId }),
        async () => {
          if (!command.current()) throw new Error('The review view changed during refresh.');
          const state = await this._queries.run.retry();
          if (state.status !== 'ready' || !state.data)
            throw state.error ?? new Error('The current review run is unavailable.');
          return state.data;
        },
      );
      if (command.current() && refreshed.error) {
        this._actionError = refreshed.error;
        this._preservedInclusion = undefined;
        this._preservedIncludeEvidence = undefined;
      }
    } finally {
      command.finish();
    }
  }

  private async _handleProposeImprovement() {
    if (this._proposing) return;
    const command = this._beginReviewCommand();
    if (!command) return;
    const scope = this._queries.capture();
    this._proposeScope = scope;
    this._proposing = true;
    this._proposeError = null;
    // Latch stays held until the improvement decision arrives via RUN_DECISION_NEW
    // or the timeout fires — run.proposeImprovement is fire-and-forget, so the
    // RPC returning doesn't mean analysis finished.
    this._proposingTimer = setTimeout(() => {
      if (this._proposeScope === scope && scope.ownsView()) this._clearProposingLatch();
    }, ReviewWorkspace.PROPOSING_TIMEOUT_MS);
    try {
      await gateway.request(Methods.RUN_PROPOSE_IMPROVEMENT, {
        runId: command.runId,
        rationale:
          'review-pr human gate — analyze what went wrong in the evidence review / recipe coverage and propose a recipe/process fix',
      });
    } catch (err) {
      if (command.current()) {
        this._proposeError = err instanceof Error ? err.message : String(err);
        this._clearProposingLatch();
      }
    } finally {
      command.finish();
    }
  }

  private async _handleRecipeRerun() {
    if (this._actionsPaused) return;
    const scope = this._queries.capture();
    this._setActiveTab('recipe');
    await this.updateComplete;
    if (!scope.current() || this._actionsPaused) return;
    this.querySelector<RecipeOutputPanel>('recipe-output-panel')?.rerun();
  }

  private _handleRecipeCancel() {
    this.querySelector<RecipeOutputPanel>('recipe-output-panel')?.cancel();
  }

  // --- Render ---

  // Styles injected in render() since we use light DOM

  override render() {
    const observation = this._queries.run.state;
    const observations = this._usesMockData
      ? nothing
      : html`
          ${observation.status === 'stale' && observation.observedAt !== undefined
            ? html`<div class="rw-loading-banner" data-testid="review-run-age">
                Saved review run, ${sourceObservationAge(observation.observedAt)}. Actions wait for
                a current read.
              </div>`
            : nothing}
          ${observation.error
            ? html`<div role="alert" data-testid="review-run-error">
                Could not read review run: ${observation.error.message}
                <button @click=${() => this._queries.run.retry()}>Retry</button>
              </div>`
            : nothing}
          ${observation.status === 'unsupported'
            ? html`<div role="status">
                Live review run updates are unavailable on this gateway.
              </div>`
            : nothing}
          ${this._actionError
            ? html`<div role="alert" data-testid="review-action-error">${this._actionError}</div>`
            : nothing}
        `;
    if (!this._queries.decision)
      return html`${observations}
        <div class="diff-empty">No saved review decision is available.</div>`;
    const payload = this._payload;
    if (!payload)
      return html`${observations}
        <div class="diff-empty">Invalid review payload</div>`;
    const recipeHost = createReviewWorkspaceRecipeHostEntry({
      runId: this.runId,
      slotId: this.slotId,
      branch: this.branch || null,
      payload,
    });
    const mediaArtifacts = this._mediaArtifacts;

    return html`
      ${renderReviewWorkspaceStyles(this._recoveryPhase)} ${observations} ${this._renderTopBar()}
      ${this._renderLoadingBanner()}
      ${this.showHistory && this._queries.run.state.data?.run
        ? html`<review-history-panel
            .run=${this._queries.run.state.data.run}
          ></review-history-panel>`
        : nothing}
      ${this._branchMismatch ? this._renderBranchBanner() : nothing}

      <div class="rw-split">
        ${this._isRecovering && observation.status !== 'stale'
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
                  ? this._renderDiffFiles()
                  : html`<div class="rw-diff-empty">
                      ${this._diffError
                        ? html`<div role="alert">
                            Diff unavailable: ${this._diffError}
                            <button class="rw-recovery-btn" @click=${() => this._beginRecovery()}>
                              Retry diff
                            </button>
                          </div>`
                        : this._selectedFile
                          ? 'No diff'
                          : 'No changed files'}
                    </div>`}
          </div>
        </div>
      </div>
      <media-lightbox
        .items=${this._artifactLightboxItems ?? this._lightboxItems(mediaArtifacts)}
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
        .testPatterns=${this._diffTestPatterns}
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
      recovering: this._isRecovering || (!this._usesMockData && !this._queries.ready),
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
    const owner = this._queries.capture();
    const visible = this._activeTab === 'recipe' || this._recipeRunning;
    return html`
      <div class="rw-recipe-output-host" style="${visible ? '' : 'display:none'}">
        <recipe-output-panel
          runId=${recipeHost.outputTarget.runId}
          slotId=${recipeHost.outputTarget.slotId}
          .disabled=${this._actionsPaused}
          .beforeRun=${() => {
            this._queries.requireDecision();
            this._queries.requireSlot();
          }}
          @running-change=${(e: CustomEvent<boolean>) => {
            if (e.detail ? !owner.current() : !owner.ownsView()) return;
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
                    this._artifactLightboxItems = null;
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
                      ?disabled=${!this.slotId || this._actionsPaused}
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
          ${gatewayMediaHtml(renderMarkdown(payload.reviewMd))}
          <step-artifacts
            stepName="Review artifacts"
            status="done"
            .artifacts=${(payload.artifactManifest ?? []).map((artifact) => ({
              ...artifact,
              runId: this.runId,
              familyId: this.runId,
              source: 'artifact-manifest',
            }))}
            .artifactUrl=${(artifact: ArtifactRef) => runArtifactUrl(this.runId, artifact)}
            @step-artifact-click=${(
              event: CustomEvent<{ artifacts: ArtifactRef[]; index: number }>,
            ) => {
              const artifacts = event.detail.artifacts;
              this._artifactLightboxItems = this._lightboxItems(artifacts);
              this._lightboxIndex = event.detail.index;
              this._lightboxOpen = true;
            }}
          ></step-artifacts>
        </div>`;
    }
  }

  private _renderTopBar() {
    if (this.readOnly)
      return html`<div class="rw-top-bar">
        <strong>${this._payload?.recommendation}</strong
        ><span>Saved review · ${this._comments.length} line comments</span>
      </div>`;
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
      postAvailable: this._postAvailable,
      recovering: this._actionsPaused,

      refreshing: this._refreshing,
      proposing: this._proposing,
      proposeError: this._proposeError,
      pendingConfirm: this._pendingConfirm,
      refresh: () => this._handleRefresh(),
      proposeImprovement: () => this._handleProposeImprovement(),
      post: () => this._handlePost(),
      dismiss: () => this._handleDismiss(),
      reviewerHref: this.reviewerHref,
      reviewerUnavailable: this.reviewerUnavailable,
    });
  }

  private get _postAvailable() {
    return Boolean(
      this._queries.decision &&
      !this._queries.decision.resolvedAt &&
      this._queries.decision.actions.some((action) => action.id === 'post'),
    );
  }

  private _renderDiffFiles() {
    return renderReviewDiffFiles({
      files: this._diffFiles,
      testFilter: this._testFilter,
      selectedFile: this._selectedFile,
      findingOpen: this._selectedCommentIdx >= 0 || Boolean(this._commentFileError),
      commentCounts: this._commentCountByFile,
      recovering: this._isRecovering,
      selectFile: (path) => this._selectFile(path),
      renderCodePanel: () => this._renderCodePanel(),
    });
  }

  private _renderCommentItem(c: ReviewLineComment, idx: number) {
    return renderReviewCommentItem({
      readOnly: this._actionsPaused,
      comment: c,
      selected: this._selectedCommentIdx === idx,
      included: this._includedComments.has(idx),
      toggle: () => this._toggleComment(idx),
      navigate: () => this._navigateToComment(c, idx),
    });
  }

  private async _navigateToComment(c: ReviewLineComment, idx: number, syncHash = true) {
    if (this._isRecovering) return;
    const epoch = ++this._sourceLoadEpoch;
    const captured = this._queries.capture();
    this._selectedCommentIdx = idx;
    this._selectedFile = c.path;
    this._revealLine = 0;
    this._commentFileContent = '';
    this._commentFileError = '';
    this._commentFileLoading = true;
    this._fileDiffLoading = false;
    if (syncHash) this._syncSourceToHash();
    const reviewedHead = this._payload?.reviewSnapshot?.headSha?.trim();
    if (!reviewedHead) {
      this._commentFileError =
        'The reviewed revision was not recorded. Source for this finding is unavailable.';
      this._commentFileLoading = false;
      return;
    }
    try {
      const result = await gateway.request<GitShowResult>(Methods.GIT_SHOW, {
        slotId: this.slotId,
        ...(this.workspaceView ? { runId: this.runId } : {}),
        ref: reviewedHead,
        path: c.path,
      });
      if (!captured.current() || epoch !== this._sourceLoadEpoch) return;
      this._commentFileContent = result.content;
      const context = reviewedFindingContext(result.content, c.line);
      if (context.available) this._revealLine = c.line;
      else this._commentFileError = context.note;
    } catch (error) {
      if (captured.current() && epoch === this._sourceLoadEpoch)
        this._commentFileError =
          error instanceof Error ? error.message : 'Reviewed source is unavailable.';
    } finally {
      if (captured.ownsView() && epoch === this._sourceLoadEpoch) this._commentFileLoading = false;
    }
  }

  private _renderCodePanel() {
    const comment = this._selectedCommentIdx >= 0 ? this._comments[this._selectedCommentIdx] : null;
    const reviewedHead = this._payload?.reviewSnapshot?.headSha;
    const sourceHeader = comment
      ? html` <div class="rw-source-context" title=${reviewedHead ?? ''}>
          ${reviewedHead ? `Reviewed ${reviewedHead.slice(0, 8)}` : 'Reviewed revision unavailable'}
          · ${workspaceArtifactBasename(comment.path)}:${comment.line}
        </div>`
      : nothing;
    const sourceError = this._commentFileError
      ? html` <div class="rw-source-context" role="alert">
          ${this._commentFileError}
          ${comment && reviewedHead
            ? html`<button
                class="rw-panel-toggle"
                @click=${() => this._navigateToComment(comment, this._selectedCommentIdx)}
              >
                Retry source
              </button>`
            : nothing}
        </div>`
      : nothing;

    // When a comment is selected and file is loaded → show code-viewer with ViewZone
    if (comment && this._commentFileContent && this._selectedFile === comment.path) {
      const threads = reviewThreadsForFile(this._commentsByFile, comment.path);
      const basename = workspaceArtifactBasename(comment.path);
      return html`
        ${sourceHeader}${sourceError}
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

    if (this._commentFileError) return html`${sourceHeader}${sourceError}`;

    if (comment && this._commentFileLoading) {
      return html`${sourceHeader}
        <div class="rw-diff-loading">Loading file...</div>`;
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
