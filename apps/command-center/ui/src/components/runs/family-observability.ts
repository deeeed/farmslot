import { html } from 'lit';
import { customElement } from 'lit/decorators.js';

import type {
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
  FamilyReport,
  LLMConfigGetResult,
  Run,
  RunDecision,
} from '@farmslot/protocol';
import { Events, Methods } from '@farmslot/protocol';

import '../shared/media-lightbox.js';
import '../shared/diff-viewer-modal.js';
import './grade-semantic-picker.js';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, subscribe } from '../../state.js';
import { gatewayHttpOrigin } from '../../utils/gateway-origin.js';
import { putCapped } from '../../utils/markdown.js';
import type { LightboxPair } from '../shared/media-lightbox-types.js';
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
  familyMarkdownPreviewFetchPath,
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
  evidenceFilterFromFamilyHash,
  familyEvidenceFilterHash,
  familyRunHash,
  slotHistoryHashForRun,
} from './family-observability-url-state.js';
import type { SemanticPickerDetail } from './grade-semantic-picker.js';
import { isSemanticChoice } from './grade-semantic-picker.js';

const GATEWAY_BASE = gatewayHttpOrigin();
const MD_CACHE_LIMIT = 50;
const COPY_COMPARE_PROMPT = 'compare-prompt';

@customElement('family-observability')
export class FamilyObservability extends FamilyObservabilityState {
  private _selectRun = (runId: string) => {
    if (this.selectedRunId !== runId) this._selectedStep = null;
    this.selectedRunId = runId;
    void this._ensureFullRun(runId);
    if (!this.familyId) return;
    const newHash = familyRunHash(this.familyId, runId, {
      evidence: this._evidenceFilter === 'all' ? undefined : this._evidenceFilter,
    });
    if (window.location.hash !== newHash) {
      history.replaceState(null, '', newHash);
    }
  };

  private async _onReplayStep(
    stepName: string,
    skipPrepare?: boolean,
    prepareProfile?: string,
  ): Promise<void> {
    const runId = this.selectedRunId;
    if (!runId) return;
    // Re-entry guard: a fast double-click would otherwise fire two parallel
    // RUN_REPLAY_STEP requests, racing the snapshot reload that follows.
    if (this._replayingStep) return;
    this._replayingStep = true;
    this._replayError = '';
    try {
      await gateway.request(Methods.RUN_REPLAY_STEP, {
        runId,
        stepName,
        skipPrepare: skipPrepare || undefined,
        prepareProfile: prepareProfile || undefined,
      });
      this._selectedStep = null;
      // Drop the cached Run so the next selection re-fetches the post-replay
      // pipeline state instead of rendering the stale snapshot.
      const next = new Map(this._fullRuns);
      next.delete(runId);
      this._fullRuns = next;
      void this._loadSnapshot();
      void this._ensureFullRun(runId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._replayError = msg;
      console.error('[family-observability] replay step failed', err);
    } finally {
      this._replayingStep = false;
    }
  }

  private async _ensureFullRun(runId: string): Promise<void> {
    if (!runId || this._fullRuns.has(runId) || this._fullRunLoading.has(runId)) return;
    const nextLoading = new Set(this._fullRunLoading);
    nextLoading.add(runId);
    this._fullRunLoading = nextLoading;
    if (this._fullRunError.has(runId)) {
      const nextErr = new Map(this._fullRunError);
      nextErr.delete(runId);
      this._fullRunError = nextErr;
    }
    try {
      const res = await gateway.request<{ run: Run }>(Methods.RUN_GET, { runId });
      if (!this.isConnected) return;
      if (this._fullRuns.get(runId) === res.run) return;
      const next = new Map(this._fullRuns);
      next.set(runId, res.run);
      this._fullRuns = next;
    } catch (error) {
      if (!this.isConnected) return;
      const msg = error instanceof Error ? error.message : String(error);
      const nextErr = new Map(this._fullRunError);
      nextErr.set(runId, msg);
      this._fullRunError = nextErr;
    } finally {
      if (this._fullRunLoading.has(runId)) {
        const next = new Set(this._fullRunLoading);
        next.delete(runId);
        this._fullRunLoading = next;
      }
    }
  }
  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this._onModalKeyDown);
    window.addEventListener('hashchange', this._onHashChange);
    this._applyEvidenceFilterFromHash();
    void this._loadSnapshot();
    this._fleetSlots = getState().fleet?.slots ?? [];
    this._prs = getState().prs ?? [];
    this._unsubState = subscribe((s: AppState) => {
      this._fleetSlots = s.fleet?.slots ?? [];
      this._prs = s.prs ?? [];
    });
    this._unsubGateway = gateway.onConnectionChange((state) => {
      if (state === 'connected' && !this.snapshot && !this.snapshotOverride && this.familyId) {
        void this._loadSnapshot();
      }
      if (state === 'connected' && this.selectedRunId) {
        void this._ensureFullRun(this.selectedRunId);
      }
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
    this._unsubGateway?.();
    this._unsubDecisionEvent?.();
    this._unsubDecisionUpdated?.();
    this._unsubImprovementFail?.();
    this._proposalTracker.dispose();
    this._copyFeedback.clear();
    this._mdPreviewCache.clear();
    this._pairsCache = null;
    this._fullRuns = new Map();
    this._fullRunLoading = new Set();
    this._fullRunError = new Map();
    this._diffModal = null;
  }

  private _onHashChange = () => {
    if (this._suppressDiffHashSync) return;
    this._applyDiffModalFromHash();
    this._applyEvidenceFilterFromHash();
  };

  private _applyEvidenceFilterFromHash(): void {
    const filter = evidenceFilterFromFamilyHash();
    this._evidenceFilter = filter ?? 'all';
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has('familyId') || changed.has('snapshotOverride')) {
      void this._loadSnapshot();
    }
    if (changed.has('fullRunOverrides')) {
      this._applyFullRunOverrides();
    }
    if (changed.has('initialRunId') && this.initialRunId) {
      this.selectedRunId = this.initialRunId;
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

  private async _loadSnapshot() {
    this.report = null;
    if (this.snapshotOverride) {
      this.snapshot = this.snapshotOverride;
      this.selectedRunId = this.initialRunId || this.snapshotOverride.runs[0]?.runId || '';
      this._applyFullRunOverrides();
      this._applyDiffModalFromHash();
      this.error = '';
      return;
    }
    if (!this.familyId) return;
    if (this.loading) return;
    this.loading = true;
    this.error = '';
    try {
      const result = await gateway.request<{ snapshot: FamilyObservabilitySnapshot }>(
        Methods.FAMILY_OBSERVABILITY_GET,
        { familyId: this.familyId },
      );
      this.snapshot = result.snapshot;
      this.selectedRunId =
        this.initialRunId || this.selectedRunId || result.snapshot.runs[0]?.runId || '';
      this._applyDiffModalFromHash();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.snapshot = null;
    } finally {
      this.loading = false;
    }
  }

  private _applyFullRunOverrides(): void {
    if (!this.fullRunOverrides.length) return;
    const next = new Map(this._fullRuns);
    for (const run of this.fullRunOverrides) {
      next.set(run.id, run);
    }
    this._fullRuns = next;
  }

  private async _generateReport() {
    if (!this.familyId) return;
    this.reportLoading = true;
    try {
      const result = await gateway.request<{
        snapshot: FamilyObservabilitySnapshot;
        report: FamilyReport;
      }>(Methods.FAMILY_REPORT_GENERATE, { familyId: this.familyId, forceRefresh: true });
      this.snapshot = result.snapshot;
      this.report = result.report;
      if (!this.selectedRunId) this.selectedRunId = result.snapshot.runs[0]?.runId ?? '';
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.reportLoading = false;
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
    this._lightboxOverride = artifacts;
    this._lightboxIndex = index;
    this._lightboxMode = 'single';
    this._lightboxOpen = true;
  }

  private _openCompare(pairIndex: number, event: Event) {
    event.stopPropagation();
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
    return familyLightboxItemsForArtifacts(GATEWAY_BASE, this._visibleArtifacts, this.snapshot);
  }

  private get _pairs(): LightboxPair[] {
    if (this._pairsCache && this._pairsCache.source === this.snapshot)
      return this._pairsCache.pairs;
    const pairs = familyLightboxPairsForSnapshot(GATEWAY_BASE, this.snapshot);
    this._pairsCache = { source: this.snapshot, pairs };
    return pairs;
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
    const check = this._canRerunOnWarmSlot(run);
    if (!check.ok || !check.slotId) return;
    this._showRerunOutput = true;
    await this.updateComplete;
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
    try {
      await gateway.request(Methods.RUN_RESOLVE_DECISION, {
        runId: run.runId,
        decisionId: decision.id,
        actionId,
      });
      await this._loadSnapshot();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  override render() {
    if (this.loading) return html`<div class="empty">Loading retrospective…</div>`;
    if (this.error) return html`<div class="empty">${this.error}</div>`;
    if (!this.snapshot) return html`<div class="empty">No retrospective data</div>`;
    const snapshot = this.snapshot;
    const selectedRun = this._selectedRun;
    return renderFamilyObservabilityPage({
      snapshot,
      selectedRun,
      selectedRunId: this.selectedRunId,
      prs: this._prs,
      report: this.report,
      reportLoading: this.reportLoading,
      selectedExperimentKey: this._selectedExperimentKey,
      copiedPrompt: this._copiedAction === COPY_COMPARE_PROMPT,
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
          rerunCheck: this._canRerunOnWarmSlot(targetRun),
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
      onOpenSlot: (slotId, event) => {
        event.stopPropagation();
        location.hash = `slot/${slotId}`;
      },
      onLightboxClose: () => {
        this._lightboxOpen = false;
        this._lightboxOverride = null;
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
    });
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
    try {
      await gateway.request(Methods.RUN_GRADE, { runId: run.runId, grade });
      this._editingRunId = '';
      const next = new Map(this._gradeDraft);
      next.delete(run.runId);
      this._gradeDraft = next;
      await this._loadSnapshot();
    } catch (err) {
      this._gradeError = err instanceof Error ? err.message : String(err);
    } finally {
      this._submittingGradeFor = '';
    }
  }

  private _onDecisionNew(payload: { runId: string; decision: RunDecision }): void {
    if (payload.decision?.type !== 'improvement') return;
    if (!this.snapshot?.runs.some((r) => r.runId === payload.runId)) return;
    // Don't clear pending state on the analyzing placeholder — the LLM is
    // still running; completion arrives via RUN_DECISION_UPDATED with a
    // terminal analysisStatus.
    const status = (payload.decision.payload as { analysisStatus?: string } | undefined)
      ?.analysisStatus;
    if (status === 'analyzing') {
      void this._loadSnapshot();
      return;
    }
    this._proposalTracker.markDone(payload.runId);
    this._proposalTracker.setError(payload.runId, null);
    void this._loadSnapshot();
  }

  private _onDecisionUpdated(payload: { runId?: string; decision: RunDecision }): void {
    if (payload.decision?.type !== 'improvement') return;
    const runId = payload.runId;
    if (!runId || !this.snapshot?.runs.some((r) => r.runId === runId)) return;
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
    void this._loadSnapshot();
  }

  private _onImprovementFailed(payload: { runId: string; error: string }): void {
    if (!this._proposingFor.has(payload.runId)) return;
    this._proposalTracker.markDone(payload.runId);
    this._proposalTracker.setError(payload.runId, payload.error || 'Improvement analysis failed');
  }

  private async _proposeImprovement(run: FamilyObservabilityRunSummary) {
    this._proposalTracker.start(run.runId);
    try {
      await gateway.request(Methods.RUN_PROPOSE_IMPROVEMENT, { runId: run.runId });
    } catch (err) {
      this._proposalTracker.setError(run.runId, err instanceof Error ? err.message : String(err));
      this._proposalTracker.markDone(run.runId);
    }
  }

  private _onRerunRunningChange(event: CustomEvent<boolean>) {
    if (event.detail === false) {
      void this._loadSnapshot();
    }
  }

  private _familyDiffLinkRenderers() {
    return createFamilyDiffLinkRenderers({
      snapshot: this.snapshot,
      gatewayBase: GATEWAY_BASE,
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
      artifactUrl: (artifact: FamilyObservabilityArtifact) =>
        familyArtifactUrl(GATEWAY_BASE, artifact),
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
      gatewayBase: GATEWAY_BASE,
      fullRun: this._fullRuns.get(run.runId) ?? null,
      fullRunLoading: this._fullRunLoading.has(run.runId),
      fullRunError: this._fullRunError.get(run.runId),
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
      onReplayStep: (stepName, skipPrepare, prepareProfile) =>
        this._onReplayStep(stepName, skipPrepare, prepareProfile),
      renderLedgerDiffDetail: (targetRun) => this._renderLedgerDiffDetail(targetRun),
    });
  }

  private _ensureMdPreview(artifact: FamilyObservabilityArtifact, url: string): void {
    const key = familyArtifactKey(artifact);
    if (this._mdPreviewCache.has(key)) return;
    putCapped(this._mdPreviewCache, key, { status: 'loading' }, MD_CACHE_LIMIT);
    const fetchUrl = familyMarkdownPreviewFetchPath(GATEWAY_BASE, url);
    fetch(fetchUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        putCapped(
          this._mdPreviewCache,
          key,
          { status: 'ok', data: familyMarkdownPreviewText(text) },
          MD_CACHE_LIMIT,
        );
        this._mdPreviewVersion += 1;
      })
      .catch((err: Error) => {
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
