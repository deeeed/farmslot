import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type {
  FamilyObservabilityArtifact,
  FamilyObservabilityGetResult,
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
  FamilyReport,
  LLMConfigGetResult,
  Run,
  RunDecision,
  RunGetResult,
  RunSessionCommandResult,
} from '@farmslot/protocol';
import {
  buildRunResolveDecisionParams,
  Events,
  isRunEvidenceVideoArtifact,
  Methods,
  sourceObservationAge,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import '../shared/media-lightbox.js';
import '../shared/diff-viewer-modal.js';
import './grade-semantic-picker.js';

import { gateway } from '../../gateway-client.js';
import { getResourceWorkspaceKey } from '../../resource-cache.js';
import { type AppState, getState, subscribe } from '../../state.js';
import { copyTextToClipboard } from '../../utils/clipboard.js';
import { gatewayHttpFetch } from '../../utils/gateway-origin.js';
import { putCapped } from '../../utils/markdown.js';
import { buildHash, parseHashRoute } from '../../utils/url-state.js';
import type { LightboxPair } from '../shared/media-lightbox-types.js';
import { ResourceQueryController } from '../shared/resource-query-controller.js';
import { slotViewHash } from '../slot-view/slot-view-url-state.js';
import type { RecipeOutputPanel } from '../workspace/recipe-output-panel.js';

import {
  familyArtifactCaption,
  familyArtifactKey,
  familyArtifactUrl,
} from './family-observability-artifact-model.js';
import {
  crossComparePrompt,
  familyCopilotCompareRequest,
  familyRunLabel,
} from './family-observability-compare-model.js';
import type { CompareTab } from './family-observability-comparison-renderers.js';
import { createFamilyDiffLinkRenderers } from './family-observability-diff-link-renderers.js';
import {
  familyArtifactForDiffSelection,
  familyDiffModalHashAction,
  familyDiffModalState,
  renderFamilyDiffModal,
  restoreFamilyDiffModalOpener,
  updateFamilyDiffModalHash,
} from './family-observability-diff-modal.js';
import {
  buildFamilyEvidenceGroups,
  type EvidenceGroup,
  familyEvidenceArtifactsForFilter,
  type FamilyEvidenceFilter,
  familyRunBadgeLabel,
  visibleFamilyEvidenceArtifacts,
} from './family-observability-evidence.js';
import { buildEvidenceComparisonMatrix } from './family-observability-evidence-matrix.js';
import { familyObservabilityEvidenceStyles } from './family-observability-evidence-styles.js';
import {
  createGradeDraft,
  type GradeDraft,
  hasFailingGradeVerdict,
  humanGradeFromDraft,
  updateGradeDraftNote,
  updateGradeDraftVerdict,
  type VerdictValue,
} from './family-observability-grading.js';
import { familyObservabilityLayoutStyles } from './family-observability-layout-styles.js';
import {
  renderFamilyChangeLedger,
  renderFamilyLedgerDiffDetail,
} from './family-observability-ledger-renderers.js';
import {
  familyLightboxItemsForArtifacts,
  familyLightboxPairForArtifact,
  familyLightboxPairsForSnapshot,
  familyRunForArtifact,
  familyVisibleLightboxArtifacts,
  selectedFamilyRun,
} from './family-observability-lightbox-model.js';
import {
  familyMarkdownPreviewText,
  renderFamilyMarkdownPreview,
} from './family-observability-markdown-preview.js';
import { renderFamilyRunOutputComparisonSummary } from './family-observability-output-renderers.js';
import { renderFamilyObservabilityPage } from './family-observability-page-renderers.js';
import {
  renderFamilyConvergedPill,
  renderFamilyRecipeSection,
} from './family-observability-recipe-section-renderers.js';
import { renderFamilyEvidence } from './family-observability-renderers.js';
import { familyWarmSlotRerunCheck } from './family-observability-rerun-model.js';
import { renderFamilySelectedRunDetail } from './family-observability-selected-run-renderers.js';
import { FamilyObservabilityState } from './family-observability-state.js';
import {
  compareViewFromFamilyHash,
  evidenceFilterFromFamilyHash,
  familyCompareViewHash,
  familyEvidenceFilterHash,
  familyGateViewFromHash,
  familyGateViewHash,
  familyRunHash,
  familyTokenViewHash,
  slotHistoryHashForRun,
  tokenViewFromFamilyHash,
} from './family-observability-url-state.js';
import type { SemanticPickerDetail } from './grade-semantic-picker.js';
import { isSemanticChoice } from './grade-semantic-picker.js';
import { openRunnerSessionOnHost } from './run-detail-session-open.js';
import {
  runSessionCommandTextForKind,
  type RunSessionCopyKind,
  type RunSessionRow,
  runSessionRowStateFromResult,
} from './run-detail-session-renderers.js';

const MD_CACHE_LIMIT = 50;
const COPY_COMPARE_PROMPT = 'compare-prompt';

@customElement('family-observability')
export class FamilyObservability extends FamilyObservabilityState {
  private boundFamilyId = '';
  @state() private observationNow = Date.now();
  private ageTimer?: ReturnType<typeof setInterval>;
  private readonly familyQuery = new ResourceQueryController<FamilyObservabilityGetResult>(
    this,
    (observation) => {
      if (this.snapshotOverride) return;
      this.snapshot = observation.data?.snapshot ?? null;
      this.loading = observation.status === 'loading' && !observation.data;
      this.error = observation.error?.message ?? '';
      if (this.snapshot) {
        const ids = this.snapshot.runs.map(({ runId }) => runId);
        const { route, params } = parseHashRoute();
        const requested =
          route === `family/${this.familyId}` ? params.get('run') : this.initialRunId;
        this.selectedRunId =
          requested && ids.includes(requested)
            ? requested
            : ids.includes(this.selectedRunId)
              ? this.selectedRunId
              : this.initialRunId && ids.includes(this.initialRunId)
                ? this.initialRunId
                : (this.snapshot.runs[0]?.runId ?? '');
        if (
          route === `family/${this.familyId}` &&
          this.selectedRunId &&
          params.get('run') !== this.selectedRunId
        ) {
          params.set('run', this.selectedRunId);
          history.replaceState(null, '', buildHash(route, params));
        }
        this._applyDiffModalFromHash();
      } else {
        this.report = null;
        this._diffModal = null;
        this._lightboxOpen = false;
        this._selectedStep = null;
        this._gradeDraft = new Map();
        this._editingRunId = '';
        this._sessionStates = {};
        this._sessionRequestSeq = {};
        this._mdPreviewCache.clear();
      }
      this._ensureFullRun(this.selectedRunId || this.initialRunId);
      this._syncAgeTimer();
    },
  );
  private readonly fullRunQuery = new ResourceQueryController<RunGetResult>(this, () =>
    this._syncAgeTimer(),
  );

  private _syncAgeTimer(): void {
    const stale = [this.familyQuery.state, this.fullRunQuery.state].some(
      (value) => value.data && value.status === 'stale',
    );
    if (stale && !this.ageTimer)
      this.ageTimer = setInterval(() => {
        this.observationNow = Date.now();
      }, 1000);
    if (!stale && this.ageTimer) {
      clearInterval(this.ageTimer);
      this.ageTimer = undefined;
    }
  }

  private _fullRunFor(runId: string): Run | null {
    if (this.snapshotOverride) return this.fullRunOverrides.find(({ id }) => id === runId) ?? null;
    const run = this.fullRunQuery.state.data?.run;
    return run?.id === runId ? run : null;
  }

  private _captureCurrent(runId?: string): () => boolean {
    const key = getResourceWorkspaceKey();
    const generation = gateway.resourceConnectionId;
    const familyId = this.familyId;
    return () =>
      this.isConnected &&
      key === getResourceWorkspaceKey() &&
      generation === gateway.resourceConnectionId &&
      gateway.connectionState === 'connected' &&
      this.familyId === familyId &&
      (!runId || runId === this.selectedRunId);
  }

  private _requireRunReady(runId: string): Run {
    this.familyQuery.requireReady();
    const run = this.fullRunQuery.requireReady().run;
    if (run.id !== runId) throw new Error('Select the current run before acting.');
    return run;
  }

  private _selectRun = (runId: string) => {
    if (this.selectedRunId !== runId) {
      this._selectedStep = null;
      this._sessionStates = {};
      this._sessionRequestSeq = {};
    }
    this.selectedRunId = runId;
    void this._ensureFullRun(runId);
    if (!this.familyId || this.snapshotOverride) return;
    const newHash = familyRunHash(this.familyId, runId, {
      evidence: this._evidenceFilter === 'all' ? undefined : this._evidenceFilter,
      tokens: this._tokenScope === 'family' ? undefined : this._tokenScope,
      trajectory: this._tokenTrajectory === 'all-runs' ? undefined : this._tokenTrajectory,
      gate: this._gateMaximized ? 'max' : this._gateOpen || undefined,
    });
    if (window.location.hash !== newHash) {
      history.replaceState(null, '', newHash);
    }
  };

  private async _onReplayStep(
    stepName: string,
    skipPrepare?: boolean,
    prepareProfile?: string,
    freshDispatch?: boolean,
  ): Promise<void> {
    const runId = this.selectedRunId;
    if (!runId) return;
    if (
      freshDispatch &&
      !window.confirm('Abandon the ambiguous retained handoff, stop its runner, and launch fresh?')
    ) {
      return;
    }
    // Re-entry guard: a fast double-click would otherwise fire two parallel
    // RUN_REPLAY_STEP requests, racing the snapshot reload that follows.
    if (this._replayingStep) return;
    this._replayingStep = true;
    this._replayError = '';
    const current = this._captureCurrent(runId);
    try {
      this._requireRunReady(runId);
      await gateway.request(Methods.RUN_REPLAY_STEP, {
        runId,
        stepName,
        skipPrepare: skipPrepare || undefined,
        prepareProfile: prepareProfile || undefined,
        freshDispatch: freshDispatch || undefined,
      });
      if (current()) this._selectedStep = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (current()) this._replayError = msg;
      console.error('[family-observability] replay step failed', err);
    } finally {
      if (current()) this._replayingStep = false;
    }
  }

  private _ensureFullRun(runId: string): void {
    this.fullRunQuery.setQuery(
      !this.snapshotOverride && runId
        ? resourceQuery<RunGetResult>(Methods.RUN_GET, { runId })
        : undefined,
    );
  }
  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this._onModalKeyDown);
    window.addEventListener('hashchange', this._onHashChange);
    this._applyEvidenceFilterFromHash();
    this._applyCompareViewFromHash();
    this._applyTokenViewFromHash();
    this._applyGateOpenFromHash();
    void this._loadSnapshot();
    this._fleetSlots = getState().fleet?.slots ?? [];
    this._prs = getState().prs ?? [];
    this._unsubState = subscribe((s: AppState) => {
      this._fleetSlots = s.fleet?.slots ?? [];
      this._prs = s.prs ?? [];
    });
    this._unsubDecisionEvent = gateway.subscribe<{ runId: string; decision: RunDecision }>(
      Events.RUN_DECISION_NEW,
      (payload) => this._onDecisionNew(payload),
    );
    this._unsubDecisionUpdated = gateway.subscribe<{ runId?: string; decision: RunDecision }>(
      Events.RUN_DECISION_UPDATED,
      (payload) => this._onDecisionUpdated(payload),
    );
    this._unsubImprovementFail = gateway.subscribe<{ runId: string; error: string }>(
      Events.RUN_IMPROVEMENT_FAILED,
      (payload) => this._onImprovementFailed(payload),
    );
    void this._loadImprovementModel();
  }

  private async _loadImprovementModel(): Promise<void> {
    try {
      const res = await gateway.request<LLMConfigGetResult>(Methods.LLM_CONFIG_GET, {});
      this._improvementModel = res.improvementModel ?? '';
    } catch (error) {
      // Family observability still works without an improvement model; keep
      // the UI usable while surfacing the optional config read failure.
      console.warn('[family-observability] failed to load improvement model', error);
      this._improvementModel = '';
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._onModalKeyDown);
    window.removeEventListener('hashchange', this._onHashChange);
    this._unsubState?.();
    this._unsubDecisionEvent?.();
    this._unsubDecisionUpdated?.();
    this._unsubImprovementFail?.();
    this._proposalTracker.dispose();
    this._copyFeedback.clear();
    this._mdPreviewCache.clear();
    this._pairsCache = null;
    this._evidenceMatrixCache = null;
    clearInterval(this.ageTimer);
    this.ageTimer = undefined;
    this._diffModal = null;
  }

  private _onHashChange = () => {
    if (this._suppressDiffHashSync) return;
    this._applyDiffModalFromHash();
    this._applyEvidenceFilterFromHash();
    this._applyCompareViewFromHash();
    this._applyTokenViewFromHash();
    this._applyGateOpenFromHash();
  };

  private _applyTokenViewFromHash(): void {
    const view = tokenViewFromFamilyHash();
    this._tokenScope = view.scope;
    this._tokenTrajectory = view.trajectory;
  }

  private _persistTokenViewHash(): void {
    if (!this.familyId) return;
    const newHash = familyTokenViewHash(this._tokenScope, this._tokenTrajectory);
    if (window.location.hash !== newHash) {
      history.replaceState(null, '', newHash);
    }
  }

  private _applyEvidenceFilterFromHash(): void {
    const filter = evidenceFilterFromFamilyHash();
    this._evidenceFilter = filter ?? 'all';
  }

  private _applyGateOpenFromHash(): void {
    const view = familyGateViewFromHash();
    this._gateOpen = view !== 'closed';
    this._gateMaximized = view === 'max';
    if (this._gateOpen && this.selectedRunId) void this._ensureFullRun(this.selectedRunId);
  }

  private _persistGateViewHash(): void {
    const view = !this._gateOpen ? 'closed' : this._gateMaximized ? 'max' : 'open';
    const newHash = familyGateViewHash(view, location.hash, {
      clearWorkspaceParams: view === 'closed' && !this._diffModal,
    });
    if (window.location.hash !== newHash) history.replaceState(null, '', newHash);
  }

  private _togglePublishGate = () => {
    this._gateOpen = !this._gateOpen;
    if (!this._gateOpen) this._gateMaximized = false;
    if (this._gateOpen && this.selectedRunId) void this._ensureFullRun(this.selectedRunId);
    this._persistGateViewHash();
  };

  private _togglePublishGateMaximize = () => {
    if (!this._gateOpen) {
      this._gateOpen = true;
      if (this.selectedRunId) void this._ensureFullRun(this.selectedRunId);
    }
    this._gateMaximized = !this._gateMaximized;
    this._persistGateViewHash();
  };

  override _restorePublishGateMaximize(): void {
    if (!this._gateMaximized) return;
    this._gateMaximized = false;
    this._persistGateViewHash();
  }

  override _publishGateWorkspaceOverlayOpen(): boolean {
    const workspace = this.renderRoot.querySelector('ready-workspace');
    return Boolean(workspace?.hasOpenOverlay());
  }

  updated(changed: Map<string, unknown>): void {
    this.classList.toggle('gate-maximized', this._gateOpen && this._gateMaximized);
    if (changed.has('familyId') || changed.has('snapshotOverride')) this._loadSnapshot();
    if (changed.has('fullRunOverrides')) this.requestUpdate();
    if (changed.has('initialRunId') && this.initialRunId) {
      this._selectRun(this.initialRunId);
    }
    if (changed.has('selectedRunId') && this.selectedRunId) {
      void this._ensureFullRun(this.selectedRunId);
    }
    // Move focus into the diff modal on open so keyboard users land inside the
    // dialog instead of leaving focus on the now-stale trigger button.
    if (changed.has('_diffModal') && this._diffModal && !changed.get('_diffModal')) {
      const closeBtn = this.renderRoot.querySelector<HTMLElement>('.dvm-close');
      closeBtn?.focus();
    }
  }

  private get _selectedRun(): FamilyObservabilityRunSummary | null {
    return selectedFamilyRun(this.snapshot, this.selectedRunId);
  }

  private _loadSnapshot(): void {
    if (this.boundFamilyId !== this.familyId) {
      this.boundFamilyId = this.familyId;
      this.selectedRunId = this.initialRunId;
      this.report = null;
      this._sessionStates = {};
      this._sessionRequestSeq = {};
      this._gradeDraft = new Map();
      this._mdPreviewCache.clear();
    }
    this.familyQuery.setQuery(
      !this.snapshotOverride && this.familyId
        ? resourceQuery(Methods.FAMILY_OBSERVABILITY_GET, { familyId: this.familyId })
        : undefined,
    );
    if (this.snapshotOverride) {
      this.snapshot = this.snapshotOverride;
      this.selectedRunId = this.initialRunId || this.snapshotOverride.runs[0]?.runId || '';
      this.loading = false;
      this.error = '';
      this._applyDiffModalFromHash();
    }
    this._ensureFullRun(this.selectedRunId || this.initialRunId);
  }

  private async _generateReport() {
    if (!this.familyId) return;
    this.reportLoading = true;
    const current = this._captureCurrent();
    try {
      this.familyQuery.requireReady();
      const result = await gateway.request<{
        snapshot: FamilyObservabilitySnapshot;
        report: FamilyReport;
      }>(Methods.FAMILY_REPORT_GENERATE, { familyId: this.familyId, forceRefresh: true });
      if (current()) this.report = result.report;
    } catch (error) {
      if (current()) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (current()) this.reportLoading = false;
    }
  }

  private _isBrokenArtifact(artifact: FamilyObservabilityArtifact): boolean {
    return this.brokenArtifacts.includes(familyArtifactKey(artifact));
  }

  private _markArtifactBroken(artifact: FamilyObservabilityArtifact) {
    const key = familyArtifactKey(artifact);
    if (!this.brokenArtifacts.includes(key)) {
      this.brokenArtifacts = [...this.brokenArtifacts, key];
    }
  }

  private _openArtifact(artifact: FamilyObservabilityArtifact, event: Event) {
    event.stopPropagation();
    // Drop any cross-run evidence pair so this snapshot-driven open can't pick
    // up a stale override via the _pairs getter.
    this._lightboxPairOverride = null;
    const lightboxArtifacts = this._evidenceArtifactsForCurrentFilter;
    this._lightboxOverride = lightboxArtifacts;
    const pair = this._pairForArtifact(artifact);
    if (pair) {
      this._lightboxOverride = null;
      this._lightboxPairIndex = pair.index;
      this._lightboxMode = 'compare';
      this._lightboxOpen = true;
      return;
    }
    const idx = lightboxArtifacts.findIndex(
      (a) => a.runId === artifact.runId && a.path === artifact.path,
    );
    this._lightboxIndex = idx >= 0 ? idx : 0;
    this._lightboxMode = 'single';
    this._lightboxOpen = true;
  }

  private _openStepArtifact(artifacts: FamilyObservabilityArtifact[], index: number, event: Event) {
    event.preventDefault();
    event.stopPropagation();
    this._lightboxPairOverride = null;
    this._lightboxOverride = artifacts;
    this._lightboxIndex = index;
    this._lightboxMode = 'single';
    this._lightboxOpen = true;
  }

  private _openCompare(pairIndex: number, event: Event) {
    event.stopPropagation();
    this._lightboxPairOverride = null;
    this._lightboxPairIndex = pairIndex;
    this._lightboxMode = 'compare';
    this._lightboxOpen = true;
  }

  private get _visibleArtifacts(): FamilyObservabilityArtifact[] {
    return familyVisibleLightboxArtifacts(this._lightboxOverride, this._visibleEvidenceArtifacts);
  }

  private get _evidenceArtifactsForCurrentFilter(): FamilyObservabilityArtifact[] {
    return familyEvidenceArtifactsForFilter(
      this._evidenceGroups(this.snapshot),
      this._evidenceFilter,
    );
  }

  private get _lightboxItems() {
    return familyLightboxItemsForArtifacts(this._visibleArtifacts, this.snapshot);
  }

  private get _pairs(): LightboxPair[] {
    if (this._lightboxPairOverride) return this._lightboxPairOverride;
    if (this._pairsCache && this._pairsCache.source === this.snapshot)
      return this._pairsCache.pairs;
    const pairs = familyLightboxPairsForSnapshot(this.snapshot);
    this._pairsCache = { source: this.snapshot, pairs };
    return pairs;
  }

  private get _evidenceMatrix() {
    if (this._evidenceMatrixCache && this._evidenceMatrixCache.source === this.snapshot)
      return this._evidenceMatrixCache.matrix;
    const matrix = buildEvidenceComparisonMatrix(this.snapshot);
    this._evidenceMatrixCache = { source: this.snapshot, matrix };
    return matrix;
  }

  private _onSelectCompareTab(tab: CompareTab): void {
    this._compareTab = tab;
    this._syncCompareViewHash();
  }

  private _onSortCompare(sortKey: string): void {
    this._compareSortKey = sortKey;
    this._syncCompareViewHash();
  }

  private _syncCompareViewHash(): void {
    const newHash = familyCompareViewHash(this._compareTab, this._compareSortKey);
    if (window.location.hash !== newHash) history.replaceState(null, '', newHash);
  }

  private _applyCompareViewFromHash(): void {
    const view = compareViewFromFamilyHash();
    this._compareTab = view.tab ?? 'leaderboard';
    this._compareSortKey = view.sortKey ?? 'score';
  }

  // Cross-run evidence stepping reuses the single-mode override viewer: the
  // artifacts are one screen captured across sibling runs, in column order.
  private _openEvidenceCell(artifacts: FamilyObservabilityArtifact[], index: number): void {
    this._lightboxPairOverride = null;
    this._lightboxOverride = artifacts;
    this._lightboxIndex = index;
    this._lightboxMode = 'single';
    this._lightboxOpen = true;
  }

  // Overlay two lanes' captures of the same screen via the existing before/after
  // slider — run A becomes "before", run B "after".
  private _compareEvidencePair(
    a: FamilyObservabilityArtifact,
    b: FamilyObservabilityArtifact,
  ): void {
    const [beforeItem, afterItem] = familyLightboxItemsForArtifacts([a, b], this.snapshot);
    const kind: 'image' | 'video' =
      isRunEvidenceVideoArtifact(a) || isRunEvidenceVideoArtifact(b) ? 'video' : 'image';
    this._lightboxOverride = null;
    this._lightboxPairOverride = [{ before: beforeItem, after: afterItem, stem: '', kind }];
    this._lightboxPairIndex = 0;
    this._lightboxMode = 'compare';
    this._lightboxOpen = true;
  }

  private _pairForArtifact(artifact: FamilyObservabilityArtifact): { index: number } | null {
    return familyLightboxPairForArtifact(this._pairs, artifact);
  }

  private _runForArtifact(
    artifact: FamilyObservabilityArtifact,
  ): FamilyObservabilityRunSummary | null {
    return familyRunForArtifact(this.snapshot, artifact);
  }

  private _evidenceGroups(snapshot: FamilyObservabilitySnapshot | null): EvidenceGroup[] {
    return buildFamilyEvidenceGroups(snapshot, (artifact) =>
      familyRunForArtifact(snapshot, artifact),
    );
  }

  private get _visibleEvidenceArtifacts(): FamilyObservabilityArtifact[] {
    return visibleFamilyEvidenceArtifacts(this._evidenceGroups(this.snapshot));
  }

  private _canRerunOnWarmSlot(run: FamilyObservabilityRunSummary | null) {
    return familyWarmSlotRerunCheck(run, this._fleetSlots);
  }

  private async _rerunOnWarmSlot(run: FamilyObservabilityRunSummary) {
    if (!this.familyQuery.ready || !this.fullRunQuery.ready) {
      this.error = 'Wait for current run details before acting.';
      return;
    }
    const current = this._captureCurrent(run.runId);
    const check = this._canRerunOnWarmSlot(run);
    if (!check.ok || !check.slotId) return;
    this._showRerunOutput = true;
    await this.updateComplete;
    if (!current() || !this.familyQuery.ready || !this.fullRunQuery.ready) return;
    const panel = this.renderRoot.querySelector<RecipeOutputPanel>('recipe-output-panel');
    panel?.rerun();
  }

  private _openSlotHistoryAt(run: FamilyObservabilityRunSummary) {
    if (!run.slotId) return;
    location.hash = slotHistoryHashForRun(run.slotId, run.runId);
  }

  private _renderRunOutputComparisonSummary(
    snapshot: FamilyObservabilitySnapshot,
    selectedRun: FamilyObservabilityRunSummary | null,
  ) {
    return renderFamilyRunOutputComparisonSummary({
      snapshot,
      selectedRun,
      runLabel: familyRunLabel,
      runBadgeLabel: (run) => familyRunBadgeLabel(run),
      renderRunDiffLink: (sourceSnapshot, run) =>
        this._familyDiffLinkRenderers().renderRunDiffLink(sourceSnapshot, run),
    });
  }

  private async _copyCrossComparePrompt(snapshot: FamilyObservabilitySnapshot): Promise<void> {
    const prompt = crossComparePrompt(snapshot);
    await navigator.clipboard.writeText(prompt);
    this._copyFeedback.show(COPY_COMPARE_PROMPT, 1800);
  }

  private _askCopilotToCompare(snapshot: FamilyObservabilitySnapshot): void {
    this.dispatchEvent(
      new CustomEvent('copilot-prompt-request', {
        detail: familyCopilotCompareRequest(snapshot, this.selectedRunId),
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async _resolveRetrospective(
    run: FamilyObservabilityRunSummary,
    decision: RunDecision,
    actionId: string,
  ) {
    const current = this._captureCurrent(run.runId);
    try {
      const full = this._requireRunReady(run.runId);
      const selected = full.decisions.find(({ id }) => id === decision.id);
      if (!selected || selected.resolvedAt)
        throw new Error('The decision changed. Review the current run.');
      await gateway.request(
        Methods.RUN_RESOLVE_DECISION,
        buildRunResolveDecisionParams({ runId: run.runId, decision: selected, actionId }),
      );
    } catch (error) {
      if (current()) this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private _renderReadStatus() {
    return [this.familyQuery.state, this.fullRunQuery.state].map((value, index) =>
      value.data && value.status === 'stale' && value.observedAt !== undefined
        ? html`<div role="status">
            Saved ${index ? 'run' : 'family'},
            ${sourceObservationAge(value.observedAt, this.observationNow)}. Actions wait for a
            current read.
          </div>`
        : '',
    );
  }

  private async _retryReads(): Promise<void> {
    const failed = [this.familyQuery, this.fullRunQuery].filter((query) => query.state.error);
    await Promise.all((failed.length ? failed : [this.familyQuery]).map((query) => query.retry()));
  }

  override render() {
    if (!this.snapshot) {
      const savedRun = this.fullRunQuery.state.data?.run;
      return html`${this._renderReadStatus()}
        <div class="empty">
          ${this.error ||
          (gateway.connectionState === 'connected'
            ? 'Loading retrospective…'
            : 'Connect to load the family summary.')}
        </div>
        ${savedRun
          ? html`<div>${savedRun.ticketOrPr}</div>
              <a href="#run/${savedRun.id}">Open saved run</a>`
          : ''}
        ${this.error
          ? html`<button @click=${() => void this._retryReads()}>Retry family</button>`
          : ''}`;
    }
    const snapshot = this.snapshot;
    const selectedRun = this._selectedRun;
    return html`${this._renderReadStatus()}${this.error || this.fullRunQuery.state.error
      ? html`<div role="alert">
          ${this.error || this.fullRunQuery.state.error?.message}<button
            @click=${() => void this._retryReads()}
          >
            Retry family
          </button>
        </div>`
      : ''}${renderFamilyObservabilityPage({
      snapshot,
      selectedRun,
      selectedRunId: this.selectedRunId,
      prs: this._prs,
      report: this.report,
      reportLoading: this.reportLoading,
      commandsReady: this.familyQuery.ready,
      selectedExperimentKey: this._selectedExperimentKey,
      copiedPrompt: this._copiedAction === COPY_COMPARE_PROMPT,
      compareTab: this._compareTab,
      compareSortKey: this._compareSortKey,
      evidenceMatrix: this._evidenceMatrix,
      pairCount: this._pairs.length,
      lightboxItems: this._lightboxItems,
      lightboxPairs: this._pairs,
      lightboxOpen: this._lightboxOpen,
      lightboxIndex: this._lightboxIndex,
      lightboxPairIndex: this._lightboxPairIndex,
      lightboxMode: this._lightboxMode,
      renderConvergedPill: () => renderFamilyConvergedPill(snapshot.runs),
      renderFamilyDiffLink: (targetSnapshot) =>
        this._familyDiffLinkRenderers().renderFamilyDiffLink(targetSnapshot),
      renderRunDiffLink: (targetSnapshot, run, compact) =>
        this._familyDiffLinkRenderers().renderRunDiffLink(targetSnapshot, run, compact),
      renderDiffModalLink: (label, artifact) =>
        this._familyDiffLinkRenderers().renderDiffModalLink(label, artifact),
      renderChangeLedger: (targetSnapshot) => this._renderChangeLedger(targetSnapshot),
      renderRunOutputComparisonSummary: (targetSnapshot, targetRun) =>
        this._renderRunOutputComparisonSummary(targetSnapshot, targetRun),
      renderEvidence: (targetSnapshot) =>
        renderFamilyEvidence(targetSnapshot, this._familyEvidenceRenderContext()),
      renderRecipePanel: (targetRun) =>
        renderFamilyRecipeSection({
          selectedRun: targetRun,
          rerunCheck:
            this.familyQuery.ready && this.fullRunQuery.ready
              ? this._canRerunOnWarmSlot(targetRun)
              : { ok: false, reason: 'Wait for current run details before acting.' },
          commandsReady: this.familyQuery.ready && this.fullRunQuery.ready,
          recipeView: this._recipeView,
          showRerunOutput: this._showRerunOutput,
          editingRunId: this._editingRunId,
          submittingGradeFor: this._submittingGradeFor,
          gradeError: this._gradeError,
          improvementModel: this._improvementModel,
          proposingFor: this._proposingFor,
          proposalError: this._proposalError,
          gradeDraft: (run) => this._getGradeDraft(run),
          elapsedSeconds: (runId) => this._proposalTracker.elapsedSeconds(runId),
          onRecipeViewChange: (view) => {
            this._recipeView = view;
          },
          onRerunOnWarmSlot: (run) => {
            void this._rerunOnWarmSlot(run);
          },
          onOpenSlotHistoryAt: (run) => this._openSlotHistoryAt(run),
          onRerunRunningChange: (event) => this._onRerunRunningChange(event),
          onStartEditingGrade: (run) => this._startEditingGrade(run),
          onVerdictChange: (run, targetId, verdict) =>
            this._onVerdictChange(run, targetId, verdict),
          onVerdictNoteInput: (run, targetId, note) =>
            this._onVerdictNoteInput(run, targetId, note),
          onPickerChange: (runId, detail) => this._onPickerChange(runId, detail),
          onCancelEditingGrade: () => {
            this._editingRunId = '';
          },
          onSubmitGrade: (run) => {
            void this._submitGrade(run);
          },
          onProposeImprovement: (run) => {
            void this._proposeImprovement(run);
          },
        }),
      renderRunDetail: (targetRun) => this._renderRunDetail(targetRun),
      renderDiffModal: () => this._renderDiffModal(),
      onBackToRuns: () => {
        location.hash = 'runs';
      },
      onGenerateReport: () => {
        void this._generateReport();
      },
      onSelectExperiment: (experimentKey) => {
        this._selectedExperimentKey = experimentKey;
      },
      onAskCopilot: (targetSnapshot) => this._askCopilotToCompare(targetSnapshot),
      onCopyPrompt: (targetSnapshot) => this._copyCrossComparePrompt(targetSnapshot),
      onSelectRun: (runId) => this._selectRun(runId),
      onSelectCompareTab: (tab) => this._onSelectCompareTab(tab),
      onSortCompare: (sortKey) => this._onSortCompare(sortKey),
      onOpenEvidenceCell: (artifacts, index) => this._openEvidenceCell(artifacts, index),
      onCompareEvidencePair: (a, b) => this._compareEvidencePair(a, b),
      evidenceThumbUrl: (artifact) => familyArtifactUrl(artifact),
      onOpenSlot: (slotId, event) => {
        event.stopPropagation();
        location.hash = `slot/${slotId}`;
      },
      onLightboxClose: () => {
        this._lightboxOpen = false;
        this._lightboxOverride = null;
        this._lightboxPairOverride = null;
      },
      onLightboxNavigate: (index) => {
        this._lightboxIndex = index;
      },
      onLightboxPairNavigate: (index) => {
        this._lightboxPairIndex = index;
      },
      onLightboxModeChange: (mode) => {
        this._lightboxMode = mode;
      },
      tokenScope: this._tokenScope,
      tokenTrajectory: this._tokenTrajectory,
      onTokenScopeChange: (scope) => {
        this._tokenScope = scope;
        this._persistTokenViewHash();
      },
      onTokenTrajectoryChange: (trajectory) => {
        this._tokenTrajectory = trajectory;
        this._persistTokenViewHash();
      },
    })}`;
  }

  private _getGradeDraft(run: FamilyObservabilityRunSummary): GradeDraft {
    return this._gradeDraft.get(run.runId) ?? createGradeDraft(run);
  }

  private _startEditingGrade(run: FamilyObservabilityRunSummary): void {
    const seeded = this._getGradeDraft(run);
    this._updateDraft(run.runId, seeded);
    this._editingRunId = run.runId;
  }

  private _updateDraft(runId: string, next: GradeDraft): void {
    const copy = new Map(this._gradeDraft);
    copy.set(runId, next);
    this._gradeDraft = copy;
  }

  private _onVerdictChange(
    run: FamilyObservabilityRunSummary,
    targetId: string,
    verdict: VerdictValue,
  ) {
    this._updateDraft(
      run.runId,
      updateGradeDraftVerdict(this._getGradeDraft(run), targetId, verdict),
    );
  }

  private _onVerdictNoteInput(run: FamilyObservabilityRunSummary, targetId: string, note: string) {
    this._updateDraft(run.runId, updateGradeDraftNote(this._getGradeDraft(run), targetId, note));
  }

  private _onPickerChange(runId: string, detail: SemanticPickerDetail) {
    const run = this.snapshot?.runs.find((r) => r.runId === runId);
    if (!run) return;
    const draft = this._getGradeDraft(run);
    this._updateDraft(runId, {
      ...draft,
      reasoning: detail.reasoning,
      ...(detail.value !== '' ? { semantic: detail.value, overridden: true } : {}),
    });
  }

  private async _submitGrade(run: FamilyObservabilityRunSummary) {
    const draft = this._getGradeDraft(run);
    if (!isSemanticChoice(draft.semantic)) {
      this._gradeError = 'Select overall semantic (good/ok/bad)';
      return;
    }
    const failingVerdicts = hasFailingGradeVerdict(draft);
    if ((draft.semantic === 'bad' || failingVerdicts) && !draft.reasoning.trim()) {
      this._gradeError = 'Reasoning required when marking bad or any target failed';
      return;
    }
    this._gradeError = '';
    this._submittingGradeFor = run.runId;
    const grade = humanGradeFromDraft({ ...draft, semantic: draft.semantic });
    const current = this._captureCurrent(run.runId);
    try {
      this._requireRunReady(run.runId);
      await gateway.request(Methods.RUN_GRADE, { runId: run.runId, grade });
      if (!current()) return;
      this._editingRunId = '';
      const next = new Map(this._gradeDraft);
      next.delete(run.runId);
      this._gradeDraft = next;
    } catch (err) {
      if (current()) this._gradeError = err instanceof Error ? err.message : String(err);
    } finally {
      if (current()) this._submittingGradeFor = '';
    }
  }

  private _onDecisionNew(payload: { runId: string; decision: RunDecision }): void {
    if (payload.decision?.type !== 'improvement') return;
    if (!this.snapshot?.runs.some((r) => r.runId === payload.runId)) return;
    // Don't clear pending state on the analyzing placeholder — the LLM is
    // still running; completion arrives via RUN_DECISION_UPDATED with a
    // terminal analysisStatus.
    if (!this.familyQuery.belongsToWorkspace) return;
    const status = (payload.decision.payload as { analysisStatus?: string } | undefined)
      ?.analysisStatus;
    if (status === 'analyzing') {
      return;
    }
    this._proposalTracker.markDone(payload.runId);
    this._proposalTracker.setError(payload.runId, null);
  }

  private _onDecisionUpdated(payload: { runId?: string; decision: RunDecision }): void {
    if (payload.decision?.type !== 'improvement') return;
    const runId = payload.runId;
    if (
      !this.familyQuery.belongsToWorkspace ||
      !runId ||
      !this.snapshot?.runs.some((r) => r.runId === runId)
    )
      return;
    const status = (
      payload.decision.payload as { analysisStatus?: string; analysisError?: string } | undefined
    )?.analysisStatus;
    if (!status || status === 'analyzing') return;
    this._proposalTracker.markDone(runId);
    if (status === 'error') {
      const message = (payload.decision.payload as { analysisError?: string } | undefined)
        ?.analysisError;
      this._proposalTracker.setError(runId, message ?? 'Improvement analysis failed');
    } else {
      this._proposalTracker.setError(runId, null);
    }
  }

  private _onImprovementFailed(payload: { runId: string; error: string }): void {
    if (!this.familyQuery.belongsToWorkspace || !this._proposingFor.has(payload.runId)) return;
    this._proposalTracker.markDone(payload.runId);
    this._proposalTracker.setError(payload.runId, payload.error || 'Improvement analysis failed');
  }

  private async _proposeImprovement(run: FamilyObservabilityRunSummary) {
    this._proposalTracker.start(run.runId);
    const current = this._captureCurrent(run.runId);
    try {
      this._requireRunReady(run.runId);
      await gateway.request(Methods.RUN_PROPOSE_IMPROVEMENT, { runId: run.runId });
    } catch (err) {
      if (!current()) return;
      this._proposalTracker.setError(run.runId, err instanceof Error ? err.message : String(err));
      this._proposalTracker.markDone(run.runId);
    }
  }

  private _onRerunRunningChange(_event: CustomEvent<boolean>) {
    this.requestUpdate();
  }

  private _familyDiffLinkRenderers() {
    return createFamilyDiffLinkRenderers({
      snapshot: this.snapshot,
      onOpenDiff: (label, artifact, opener) => {
        this._diffModalOpener = opener;
        this._openDiffModal(label, artifact);
      },
    });
  }

  private _artifactForDiffSelection(
    runId: string,
    pathValue: string,
  ): FamilyObservabilityArtifact | null {
    return familyArtifactForDiffSelection(this.snapshot, runId, pathValue);
  }

  private _updateDiffModalHash(artifact: FamilyObservabilityArtifact | null): void {
    updateFamilyDiffModalHash(artifact, this._suppressDiffHashSync, (suppressed) => {
      this._suppressDiffHashSync = suppressed;
    });
  }

  _applyDiffModalFromHash(): void {
    const action = familyDiffModalHashAction(this.snapshot, this._diffModal);
    if (action.kind === 'close') {
      this._closeDiffModal(false);
      return;
    }
    if (action.kind === 'open') {
      this._openDiffModal(action.label, action.artifact, false);
    }
  }

  private _openDiffModal(
    label: string,
    artifact: FamilyObservabilityArtifact,
    syncHash = true,
  ): void {
    this._diffModal = familyDiffModalState(label, artifact);
    if (syncHash) this._updateDiffModalHash(artifact);
  }

  _closeDiffModal = (syncHash = true) => {
    this._diffModal = null;
    if (syncHash) this._updateDiffModalHash(null);
    const opener = this._diffModalOpener;
    this._diffModalOpener = null;
    restoreFamilyDiffModalOpener(opener);
  };

  private _renderDiffModal() {
    return renderFamilyDiffModal(this._diffModal, () => this._closeDiffModal());
  }

  private _familyLedgerRenderContext() {
    return this._familyDiffLinkRenderers();
  }

  private _renderLedgerDiffDetail(run: FamilyObservabilityRunSummary) {
    return renderFamilyLedgerDiffDetail(this.snapshot, run, this._familyLedgerRenderContext());
  }

  private _renderChangeLedger(snapshot: FamilyObservabilitySnapshot) {
    return renderFamilyChangeLedger(snapshot, this._familyLedgerRenderContext());
  }

  private _familyEvidenceRenderContext() {
    return {
      evidenceFilter: this._evidenceFilter,
      evidenceGroups: (snapshot: FamilyObservabilitySnapshot) => this._evidenceGroups(snapshot),
      visibleEvidenceArtifacts: this._visibleEvidenceArtifacts,
      setEvidenceFilter: (filter: FamilyEvidenceFilter) => {
        this._evidenceFilter = filter;
        const newHash = familyEvidenceFilterHash(filter);
        if (window.location.hash !== newHash) {
          history.replaceState(null, '', newHash);
        }
      },
      artifactUrl: (artifact: FamilyObservabilityArtifact) => familyArtifactUrl(artifact),
      artifactCaption: (artifact: FamilyObservabilityArtifact) => familyArtifactCaption(artifact),
      isBrokenArtifact: (artifact: FamilyObservabilityArtifact) => this._isBrokenArtifact(artifact),
      markArtifactBroken: (artifact: FamilyObservabilityArtifact) =>
        this._markArtifactBroken(artifact),
      pairForArtifact: (artifact: FamilyObservabilityArtifact) => this._pairForArtifact(artifact),
      openArtifact: (artifact: FamilyObservabilityArtifact, event: Event) =>
        this._openArtifact(artifact, event),
      openCompare: (pairIndex: number, event: Event) => this._openCompare(pairIndex, event),
      runBadgeLabel: (run: FamilyObservabilityRunSummary) => familyRunBadgeLabel(run),
      renderMarkdownPreview: (artifact: FamilyObservabilityArtifact, url: string) =>
        this._renderMarkdownPreview(artifact, url),
    };
  }

  private _renderRunDetail(run: FamilyObservabilityRunSummary) {
    return renderFamilySelectedRunDetail({
      run,
      runs: this.snapshot?.runs ?? [],
      prs: this._prs,
      fullRun: this._fullRunFor(run.runId),
      commandsReady: this.familyQuery.ready && this.fullRunQuery.ready,
      fullRunLoading: this.fullRunQuery.state.status === 'loading',
      fullRunError: this.fullRunQuery.state.error?.message,
      selectedStep: this._selectedStep,
      replayingStep: this._replayingStep,
      replayError: this._replayError,
      onResolveRetrospective: (targetRun, decision, actionId) => {
        void this._resolveRetrospective(targetRun, decision, actionId);
      },
      onOpenStepArtifact: (artifacts, index, event) =>
        this._openStepArtifact(artifacts, index, event),
      onSelectStep: (step) => {
        this._selectedStep = step;
      },
      onCloseStepInspector: () => {
        this._selectedStep = null;
      },
      onReplayStep: (stepName, skipPrepare, prepareProfile, freshDispatch) =>
        this._onReplayStep(stepName, skipPrepare, prepareProfile, freshDispatch),
      renderLedgerDiffDetail: (targetRun) => this._renderLedgerDiffDetail(targetRun),
      gateOpen: this._gateOpen,
      gateMaximized: this._gateMaximized,
      onTogglePublishGate: this._togglePublishGate,
      onTogglePublishGateMaximize: this._togglePublishGateMaximize,
      sessionStates: this._sessionStates,
      onCopySession: (row, kind) => {
        const fullRun = this._fullRunFor(run.runId);
        if (fullRun) void this._copyRunnerSessionCommand(fullRun.id, row, kind);
      },
      onOpenOnHost: (row) => {
        const fullRun = this._fullRunFor(run.runId);
        if (fullRun) void this._openRunnerSessionOnHost(fullRun.id, fullRun.status, row);
      },
    });
  }

  private async _openRunnerSessionOnHost(
    runId: string,
    runStatus: Run['status'],
    row: RunSessionRow,
  ): Promise<void> {
    if (!this.familyQuery.ready || !this.fullRunQuery.ready) {
      this.error = 'Wait for current run details before acting.';
      return;
    }
    const current = this._captureCurrent(runId);
    const requestSeq = (this._sessionRequestSeq[row.contextId] ?? 0) + 1;
    this._sessionRequestSeq = { ...this._sessionRequestSeq, [row.contextId]: requestSeq };
    const requestStillCurrent = () =>
      current() &&
      requestSeq === this._sessionRequestSeq[row.contextId] &&
      this.selectedRunId === runId;
    this._sessionStates = { ...this._sessionStates, [row.contextId]: { status: 'opening' } };
    const opened = await openRunnerSessionOnHost({
      runId,
      runStatus,
      row,
      isCurrent: () => requestStillCurrent() && this.fullRunQuery.ready,
    });
    if (!requestStillCurrent()) return;
    this._sessionStates = {
      ...this._sessionStates,
      [row.contextId]: {
        status: opened.ok ? 'ready' : 'error',
        liveness: opened.liveness,
        command: opened.command,
        machine: opened.machine,
        slotId: opened.slotId ?? undefined,
        tmuxTarget: opened.tmuxTarget,
        ownership: opened.ownership,
        ownerRunId: opened.ownerRunId,
        message: opened.message,
      },
    };
    if (!opened.ok || !opened.slotId) return;
    location.hash = slotViewHash({
      slotId: opened.slotId,
      runId,
      contextId: opened.contextId,
    });
  }

  private async _copyRunnerSessionCommand(
    runId: string,
    row: RunSessionRow,
    kind: RunSessionCopyKind,
  ): Promise<void> {
    if (!this.familyQuery.ready || !this.fullRunQuery.ready) {
      this.error = 'Wait for current run details before acting.';
      return;
    }
    const current = this._captureCurrent(runId);
    const requestSeq = (this._sessionRequestSeq[row.contextId] ?? 0) + 1;
    this._sessionRequestSeq = { ...this._sessionRequestSeq, [row.contextId]: requestSeq };
    const requestStillCurrent = () =>
      current() &&
      requestSeq === this._sessionRequestSeq[row.contextId] &&
      this.selectedRunId === runId;
    this._sessionStates = { ...this._sessionStates, [row.contextId]: { status: 'loading' } };
    try {
      const result = await gateway.request<RunSessionCommandResult>(Methods.RUN_SESSION_COMMAND, {
        runId,
        contextId: row.contextId,
        role: row.role,
      });
      if (!requestStillCurrent()) return;
      const command = runSessionCommandTextForKind(result, kind);
      let copyError: string | null = null;
      if (command) {
        // A refused clipboard must not hide the liveness the gateway proved,
        // and must never be reported as a successful copy.
        try {
          await copyTextToClipboard(command);
        } catch (err) {
          copyError = (err as Error).message;
        }
      }
      if (!requestStillCurrent()) return;
      this._sessionStates = {
        ...this._sessionStates,
        [row.contextId]: runSessionRowStateFromResult(result, kind, copyError),
      };
    } catch (err) {
      if (!requestStillCurrent()) return;
      this._sessionStates = {
        ...this._sessionStates,
        [row.contextId]: { status: 'error', message: (err as Error).message },
      };
    }
  }

  private _ensureMdPreview(artifact: FamilyObservabilityArtifact, url: string): void {
    const key = familyArtifactKey(artifact);
    if (this._mdPreviewCache.has(key)) return;
    putCapped(this._mdPreviewCache, key, { status: 'loading' }, MD_CACHE_LIMIT);
    const current = this._captureCurrent();
    gatewayHttpFetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        if (!current()) return;
        putCapped(
          this._mdPreviewCache,
          key,
          { status: 'ok', data: familyMarkdownPreviewText(text) },
          MD_CACHE_LIMIT,
        );
        this._mdPreviewVersion += 1;
      })
      .catch((err: Error) => {
        if (!current()) return;
        putCapped(this._mdPreviewCache, key, { status: 'err', error: err.message }, MD_CACHE_LIMIT);
        this._mdPreviewVersion += 1;
      });
  }

  private _renderMarkdownPreview(artifact: FamilyObservabilityArtifact, url: string) {
    void this._mdPreviewVersion;
    this._ensureMdPreview(artifact, url);
    return renderFamilyMarkdownPreview(
      artifact,
      this._mdPreviewCache.get(familyArtifactKey(artifact)),
    );
  }

  static styles = [familyObservabilityLayoutStyles, familyObservabilityEvidenceStyles];
}

declare global {
  interface HTMLElementTagNameMap {
    'family-observability': FamilyObservability;
  }
}
