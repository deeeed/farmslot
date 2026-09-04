import { html } from 'lit';
import { customElement } from 'lit/decorators.js';

import type {
  CiCheckUpdatedPayload,
  DevInteractiveCompletionAction,
  FamilyObservabilityArtifact,
  PRStatus,
  PRStatusResult,
  RecipeRunArtifactGroup,
  ResourcePostureGateChoice,
  Run,
  RunDecision,
  RunGetResult,
  RunListResult,
  RunSessionCommandResult,
  RuntimePosturePreviewResult,
  RuntimePostureStatusResult,
  TaskProgressResult,
  TaskProgressUpdatedPayload,
} from '@farmslot/protocol';
import { buildRunResolveDecisionParams, Events, Methods } from '@farmslot/protocol';

import './step-inspector.js';
import './run-pipeline-mini.js';
import './run-tag-editor.js';
import '../shared/media-lightbox.js';
import '../shared/step-artifacts.js';
import '../workspace/review-workspace.js';
import '../workspace/ready-workspace.js';
import '../terminal/terminal-view.js';
import '../shared/hydrating-placeholder.js';
import '../shared/slot-prepare-popover.js';
import '../interactive/interactive-operator-packets.js';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, isHydrating, subscribe } from '../../state.js';
import { copyTextToClipboard } from '../../utils/clipboard.js';
import { togglePinnedSlot } from '../../utils/pinned-slots.js';
import type { LightboxItem } from '../shared/media-lightbox-types.js';
import { selectedRecipeRun } from '../shared/recipe-run-selection-model.js';
import type { RecipeCompleteDetail } from '../workspace/recipe-output-panel.js';
import { runArtifactUrl } from '../workspace/workspace-artifacts.js';

import { CIWatchPokeController } from './ci-watch-actions.js';
import {
  checkInteractiveHandoffSignal,
  confirmForceComplete,
  confirmRunDecision,
  confirmRunLifecycleAction,
  jumpToSuccessorWhenAvailable,
  rescueRunLinkage,
  resolveBranchNudgePick,
  resolveInteractiveDevAction,
  resolveSlotPick,
} from './run-detail-actions.js';
import { renderRunCiStatus } from './run-detail-ci-status-renderer.js';
import { renderRunGateSection } from './run-detail-decision-renderers.js';
import {
  buildRerunAlongsideHref,
  buildRunDiagnosisPrompt,
  currentRunCiStatus,
  hasActiveInlineCiFix,
  isLiveTimeoutPrStatusAllGreen,
  isTaskProgressRunActive,
  pendingCITimeoutDecision,
  readCiWatchOutputs,
  runDetailDesiredRecipeRunId,
  runEvidenceLightboxItems,
  runFamilyPrStatus,
  shouldAcceptTaskProgressUpdate,
  shouldShowRunCiStatus,
} from './run-detail-model.js';
import { canResolveWithPostureChoice } from './run-detail-posture-gate-renderers.js';
import { renderRunPostureSummary } from './run-detail-posture-renderers.js';
import {
  renderInteractiveDevGate,
  renderRunDetailView,
  renderRunEvidence,
  renderRunGrade,
} from './run-detail-renderers.js';
import {
  renderRunAgentSessions,
  runSessionCommandTextForKind,
  type RunSessionCopyKind,
  type RunSessionRow,
  runSessionRowStateFromResult,
} from './run-detail-session-renderers.js';
import { RunDetailState } from './run-detail-state.js';
import { runDetailStyles } from './run-detail-styles.js';
import {
  artifactSelectionFromRunDetailHash,
  isRunDetailHashForRun,
  runDetailEvidenceArtifactHash,
  runDetailStepHash,
  runInventoryHashFromDetail,
  selectedStepNameFromRunDetailHash,
} from './run-detail-url-state.js';
import { publicationReviewStepForName } from './run-pipeline-model.js';
import {
  collectRunEvidenceArtifacts,
  collectRunInteractivePacketArtifacts,
  sortRunsForFamilyView,
} from './run-utils.js';

@customElement('run-detail')
export class RunDetail extends RunDetailState {
  static styles = runDetailStyles;

  private readonly _ciPoke = new CIWatchPokeController((state) => {
    this._ciPoking = state.poking;
    this._ciPokeStatus = state.status;
  });

  connectedCallback() {
    super.connectedCallback();
    this.syncRun(getState());
    window.addEventListener('hashchange', this._onHashChange);
    this.unsub = subscribe((s) => this.syncRun(s));
    this.unsubProgress = gateway.subscribe<TaskProgressUpdatedPayload>(
      Events.TASK_PROGRESS_UPDATED,
      (p) => {
        if (
          p.progress?.structured &&
          this.run?.slotId === p.slotId &&
          p.runId === this.runId &&
          shouldAcceptTaskProgressUpdate(this.run, p)
        ) {
          this.taskProgress = p.progress.structured;
        }
      },
    );
    this.unsubCI = gateway.subscribe<CiCheckUpdatedPayload>(Events.CI_CHECK_UPDATED, (p) => {
      if (p.runId === this.runId) {
        this.ciStatus = p;
        this._ciPoke.observePoll(p.runId, p.pollCount);
      }
    });
    this._clock = setInterval(() => {
      this._now = Date.now();
      this._maybeRefreshLiveTimeoutPrStatus();
      this._maybeRefreshTaskProgress();
    }, 1000);
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has('runId') || changed.has('mockData') || changed.has('mockRun')) {
      this.syncRun(getState());
    }
  }

  private _maybeRefreshTaskProgress(): void {
    if (!this.run?.slotId) return;
    if (!isTaskProgressRunActive(this.run, { includeCompleting: true })) return;
    if (Date.now() - this._lastTaskProgressFetchAt < 10_000) return;
    void this.fetchTaskProgress(this.run.slotId);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this._onHashChange);
    this.unsub?.();
    this.unsubProgress?.();
    this.unsubCI?.();
    if (this._clock) clearInterval(this._clock);
    if (this._jumpTimer) clearTimeout(this._jumpTimer);
    if (this._recipeRunsDelayedRefreshTimer) clearTimeout(this._recipeRunsDelayedRefreshTimer);
    this._ciPoke.dispose();
  }

  private syncRun(s: AppState) {
    if (this.mockData && this.mockRun) {
      const prev = this.run;
      this._hydrating = false;
      this._bootstrapFailed = false;
      this._connectionStale = false;
      this._directRunUnavailable = false;
      this._directRunRefreshFailed = false;
      this._directRunRefreshing = false;
      this._missingRunFetchAttempted = false;
      this.run = this.mockRun;
      this.prStatus = runFamilyPrStatus(this.run, [this.run, ...s.runs], s.prs ?? []);
      if (prev?.id !== this.run.id) this._applySelectedStepFromHash();
      return;
    }
    const prev = this.run;
    const wasHydrating = this._hydrating;
    if (this.runId !== this._lastRequestedRunId) {
      this._lastRequestedRunId = this.runId;
      // Copied/error/liveness state belongs to the run it was fetched for.
      // Carrying it across would label the next run's contexts with the
      // previous run's liveness.
      this._sessionStates = {};
      this._sessionRequestSeq = {};
      this._ciPoke.reset();
      this._missingRunFetchAttempted = false;
      this._directRunRefreshFailed = false;
      this._directRunUnavailable = false;
      this._directRun = null;
      this._directRunRefreshing = false;
      this._directRunRequestSeq++;
      this._taskProgressRequestSeq++;
      this._siblingsRequestSeq++;
      this._lastTaskProgressFetchAt = 0;
      this.taskProgress = null;
      this.selectedStepProgress = null;
      this._selectedStepProgressKey = '';
      this.ciStatus = null;
      this.siblings = [];
      this._resetRecipeRuns();
      this._handoffSignalCheckBusy = false;
      this._handoffSignalCheckError = null;
      // Posture belongs to the run it was read for; carrying it across would
      // describe the previous run's providers under this run's id.
      this._postureStatus = { status: 'idle' };
      this._postureGate = { choice: null, status: 'idle' };
      this._postureStatusKey = '';
      this._postureStatusRequestSeq++;
      this._posturePreviewRequestSeq++;
    }
    this._hydrating = isHydrating(s, 'runs');
    this._bootstrapFailed = s.bootstrapFailed.runs;
    this._connectionStale = s.connection !== 'connected';
    if (wasHydrating && !this._hydrating) this._missingRunFetchAttempted = false;
    const sharedRun = s.runs.find((r) => r.id === this.runId) ?? null;
    if (sharedRun) {
      if (
        this._directRun ||
        this._directRunRefreshing ||
        this._directRunRefreshFailed ||
        this._directRunUnavailable
      ) {
        this._directRunRequestSeq++;
        this._directRunRefreshing = false;
      }
      this._directRun = null;
      this._directRunRefreshFailed = false;
      this._directRunUnavailable = false;
    }
    this.run = sharedRun ?? (this._directRun?.id === this.runId ? this._directRun : null);
    // Reset transient nudge-decision-card state when the bound run changes or when the
    // current `branch_affinity_nudge` decision has been resolved server-side. Without this,
    // _branchNudgeShowPicker / _selectedSlotId leak into the next decision render and the
    // operator clicks "Use <slot>" against a stale selection.
    const prevPendingNudge =
      prev?.decisions.find(
        (d) =>
          !d.resolvedAt &&
          (d.payload as { kind?: string } | undefined)?.kind === 'branch_affinity_nudge',
      ) ?? null;
    const currPendingNudge =
      this.run?.decisions.find(
        (d) =>
          !d.resolvedAt &&
          (d.payload as { kind?: string } | undefined)?.kind === 'branch_affinity_nudge',
      ) ?? null;
    const runChanged = prev?.id !== this.run?.id;
    const nudgeDecisionResolved =
      !!prevPendingNudge && (!currPendingNudge || currPendingNudge.id !== prevPendingNudge.id);
    if (runChanged || nudgeDecisionResolved) {
      this._branchNudgeShowPicker = false;
      this._selectedSlotId = null;
    }
    const activeTaskChanged =
      prev?.id === this.run?.id && prev?.activeTaskFile !== this.run?.activeTaskFile;
    if (activeTaskChanged) {
      this._taskProgressRequestSeq++;
      this._lastTaskProgressFetchAt = 0;
      this.taskProgress = null;
    }
    const runsForMeta = this.run && !sharedRun ? [this.run, ...s.runs] : s.runs;
    this.prStatus = this.run ? runFamilyPrStatus(this.run, runsForMeta, s.prs ?? []) : null;
    if (this.run) {
      this._missingRunFetchAttempted = false;
    }
    if (this.run && this.selectedStep) {
      this.selectedStep =
        this.run.steps.find((step) => step.name === this.selectedStep?.name) ??
        publicationReviewStepForName(this.run, this.selectedStep.name) ??
        this.selectedStep;
      void this._loadSelectedStepProgress();
    }
    // The shared RUN_LIST is capped and can omit deep-linked historical runs.
    // Retry the route target directly once the slice is no longer hydrating so
    // reconnects do not fall through to "not found" prematurely.
    if (!this.run && this.runId && !this._hydrating && !this._missingRunFetchAttempted) {
      this._missingRunFetchAttempted = true;
      void this.fetchRun(this.runId);
    }
    if (wasHydrating && !this._hydrating && !sharedRun && this._directRun?.id === this.runId) {
      void this.fetchRun(this.runId);
    }
    // Fetch initial task progress when entering monitoring (or on mount if already monitoring)
    const isWorkerActive = this.run ? isTaskProgressRunActive(this.run) : false;
    const inlineCIFixActive = this.run ? hasActiveInlineCiFix(this.run) : false;
    const shouldRefreshTaskProgress =
      !this.taskProgress ||
      activeTaskChanged ||
      (inlineCIFixActive && Date.now() - this._lastTaskProgressFetchAt > 5_000);
    if (isWorkerActive && this.run?.slotId && shouldRefreshTaskProgress) {
      this.fetchTaskProgress(this.run!.slotId);
    }
    if (this.run && prev?.id !== this.run.id) {
      void this.fetchSiblings(this.run);
      void this._refreshRecipeRunsForRun(this.run);
      this._applySelectedStepFromHash();
    }
    if (this.run) this._applyEvidenceArtifactFromHash();
    this._maybeRefreshLiveTimeoutPrStatus();
    this._maybeRefreshPostureStatus();
  }

  /**
   * Re-read `runtime.posture.status` whenever the run record changes. The run
   * carries the persisted desired policy, but only the RPC re-merges it with
   * what the providers are observed to be doing, so the panel must not be
   * rendered from `run.resourcePosture` alone.
   */
  private _maybeRefreshPostureStatus(): void {
    const run = this.run;
    if (!run) return;
    if (this.mockData) return;
    const key = `${run.id}:${run.updatedAt}`;
    if (key === this._postureStatusKey) return;
    this._postureStatusKey = key;
    void this._refreshPostureStatus(run.id);
  }

  private async _refreshPostureStatus(runId: string): Promise<void> {
    const requestSeq = ++this._postureStatusRequestSeq;
    const stillCurrent = () => requestSeq === this._postureStatusRequestSeq && this.runId === runId;
    if (this._postureStatus.status === 'idle') {
      this._postureStatus = { status: 'loading' };
    }
    try {
      const result = await gateway.request<RuntimePostureStatusResult>(
        Methods.RUNTIME_POSTURE_STATUS,
        { runId },
      );
      if (!stillCurrent()) return;
      this._postureStatus = {
        status: 'ready',
        slotId: result.slotId,
        state: result.state,
      };
    } catch (err) {
      if (!stillCurrent()) return;
      // Never fall back to "no posture": an unreadable status is its own state.
      this._postureStatus = {
        status: 'error',
        message: `Posture status unavailable: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Ask the Gateway what the chosen gate choice would do. The plan shown to the
   * operator is the Gateway's, never one this client assembled.
   */
  private async _selectPostureGateChoice(
    runId: string,
    choice: ResourcePostureGateChoice | null,
  ): Promise<void> {
    const requestSeq = ++this._posturePreviewRequestSeq;
    if (!choice) {
      this._postureGate = { choice: null, status: 'idle' };
      return;
    }
    this._postureGate = { choice, status: 'loading' };
    try {
      const plan = await gateway.request<RuntimePosturePreviewResult>(
        Methods.RUNTIME_POSTURE_PREVIEW,
        { runId, gateChoice: choice },
      );
      if (requestSeq !== this._posturePreviewRequestSeq || this.runId !== runId) return;
      this._postureGate = { choice, status: 'ready', plan };
    } catch (err) {
      if (requestSeq !== this._posturePreviewRequestSeq || this.runId !== runId) return;
      this._postureGate = {
        choice,
        status: 'error',
        message: `Posture preview failed: ${(err as Error).message}`,
      };
    }
  }

  private _shouldShowCiStatus(run: Run): boolean {
    return shouldShowRunCiStatus(run);
  }

  private _maybeRefreshLiveTimeoutPrStatus(): void {
    const run = this.run;
    if (!run?.prNumber || !pendingCITimeoutDecision(run)) {
      if (
        this.liveTimeoutPrStatus ||
        this.liveTimeoutPrStatusFailed ||
        this.liveTimeoutPrStatusRefreshing
      ) {
        this._liveTimeoutRequestSeq++;
      }
      this.liveTimeoutPrStatus = null;
      this.liveTimeoutPrStatusFailed = false;
      this.liveTimeoutPrStatusRefreshing = false;
      this._liveTimeoutKey = '';
      return;
    }

    const key = `${run.id}:${run.project}:${run.prNumber}`;
    if (key !== this._liveTimeoutKey) {
      this._liveTimeoutKey = key;
      this.liveTimeoutPrStatus = null;
      this.liveTimeoutPrStatusFailed = false;
      this._lastLiveTimeoutFetchAt = 0;
      this._liveTimeoutRequestSeq++;
    }

    if (this.liveTimeoutPrStatusRefreshing || this._connectionStale) return;
    if (Date.now() - this._lastLiveTimeoutFetchAt < 30_000) return;
    void this._fetchLiveTimeoutPrStatus(run);
  }

  private async _fetchLiveTimeoutPrStatus(run: Run): Promise<void> {
    if (!run.prNumber) return;
    const requestSeq = ++this._liveTimeoutRequestSeq;
    const key = `${run.id}:${run.project}:${run.prNumber}`;
    this.liveTimeoutPrStatusRefreshing = true;
    this.liveTimeoutPrStatusFailed = false;
    this._lastLiveTimeoutFetchAt = Date.now();
    try {
      const res = await gateway.request<PRStatusResult>(
        Methods.PR_STATUS,
        { pr: run.prNumber, project: run.project, force: true },
        30_000,
      );
      if (requestSeq !== this._liveTimeoutRequestSeq || key !== this._liveTimeoutKey) return;
      this.liveTimeoutPrStatus = res.pr;
      void this._autoResolveRecoveredCITimeout(run, res.pr);
    } catch (err) {
      if (requestSeq !== this._liveTimeoutRequestSeq || key !== this._liveTimeoutKey) return;
      console.warn('Failed to refresh live CI status:', err);
      this.liveTimeoutPrStatusFailed = true;
    } finally {
      if (requestSeq === this._liveTimeoutRequestSeq && key === this._liveTimeoutKey) {
        this.liveTimeoutPrStatusRefreshing = false;
      }
    }
  }

  private async _autoResolveRecoveredCITimeout(run: Run, pr: PRStatus): Promise<void> {
    const decision = pendingCITimeoutDecision(run);
    if (!decision) return;
    if (this._autoResolvedTimeoutDecisionIds.has(decision.id)) return;
    const summary = pr.checkSummary;
    // Skipped checks count toward total but must not block auto-resolve.
    if (!(summary.total > 0 && summary.passed > 0 && summary.failed === 0 && summary.pending === 0))
      return;

    this._autoResolvedTimeoutDecisionIds.add(decision.id);
    try {
      await gateway.request(
        Methods.RUN_RESOLVE_DECISION,
        buildRunResolveDecisionParams({
          runId: run.id,
          decision,
          actionId: 'continue',
        }),
        30_000,
      );
    } catch (err) {
      this._autoResolvedTimeoutDecisionIds.delete(decision.id);
      console.warn('Failed to auto-resolve recovered CI timeout:', err);
    }
  }

  private async fetchRun(runId: string) {
    const requestSeq = ++this._directRunRequestSeq;
    const requestStillCurrent = () =>
      requestSeq === this._directRunRequestSeq && this.runId === runId;
    this._directRunRefreshing = true;
    this._directRunRefreshFailed = false;
    this._directRunUnavailable = false;
    try {
      const res = await gateway.request<RunGetResult>(Methods.RUN_GET, { runId });
      if (!requestStillCurrent()) return;
      if (res.run) {
        this._directRun = res.run;
        this.run = res.run;
        this._directRunRefreshFailed = false;
        this._directRunUnavailable = false;
        void this.fetchSiblings(res.run);
        void this._refreshRecipeRunsForRun(res.run);
        this._applySelectedStepFromHash();
      } else {
        this._markDirectRunUnavailable(runId);
      }
    } catch (err) {
      if (!requestStillCurrent()) return;
      if (this._isRunNotFoundError(err)) {
        this._markDirectRunUnavailable(runId);
      } else {
        this._directRunRefreshFailed = true;
      }
    } finally {
      if (requestStillCurrent()) this._directRunRefreshing = false;
    }
  }

  private _markDirectRunUnavailable(runId: string): void {
    if (this._directRun?.id === runId) {
      this._directRun = null;
      this.run = null;
    }
    this._directRunRefreshFailed = false;
    this._directRunUnavailable = true;
  }

  private _isRunNotFoundError(err: unknown): boolean {
    return err instanceof Error && /^Run not found(?::|$)/.test(err.message);
  }

  private _resetRecipeRuns(): void {
    this._recipeRunsRefreshToken = Symbol('run-detail-recipe-runs');
    this._recipeRunsRefreshInFlight = null;
    this._recipeRunsRefreshInFlightRunId = '';
    this._pendingRecipeRunSelectionId = '';
    if (this._recipeRunsDelayedRefreshTimer) clearTimeout(this._recipeRunsDelayedRefreshTimer);
    this._recipeRunsDelayedRefreshTimer = undefined;
    this._recipeRuns = [];
    this._selectedRecipeRunId = '';
  }

  private _selectedRecipeRun(): RecipeRunArtifactGroup | null {
    return selectedRecipeRun(this._recipeRuns, this._selectedRecipeRunId);
  }

  private async _refreshRecipeRunsForRun(
    run: Run,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (
      !options.force &&
      this._recipeRunsRefreshInFlight &&
      this._recipeRunsRefreshInFlightRunId === run.id
    ) {
      return this._recipeRunsRefreshInFlight;
    }
    const refreshPromise = this._refreshRecipeRunsForRunUncoalesced(run);
    this._recipeRunsRefreshInFlight = refreshPromise;
    this._recipeRunsRefreshInFlightRunId = run.id;
    try {
      await refreshPromise;
    } finally {
      if (this._recipeRunsRefreshInFlight === refreshPromise) {
        this._recipeRunsRefreshInFlight = null;
        this._recipeRunsRefreshInFlightRunId = '';
      }
    }
  }

  private async _refreshRecipeRunsForRunUncoalesced(run: Run): Promise<void> {
    const refreshToken = Symbol('run-detail-recipe-runs');
    this._recipeRunsRefreshToken = refreshToken;
    try {
      const result = await gateway.request<{
        recipeRuns: RecipeRunArtifactGroup[];
        selectedRecipeRunId: string | null;
      }>(Methods.RUN_RECIPE_RUNS_FOR_RUN, { runId: run.id });
      if (refreshToken !== this._recipeRunsRefreshToken || this.run?.id !== run.id) return;
      this._recipeRuns = result.recipeRuns;
      const pendingRecipeRunId = this._pendingRecipeRunSelectionId;
      const desiredId = runDetailDesiredRecipeRunId({
        recipeRuns: result.recipeRuns,
        pendingRecipeRunId,
        currentRecipeRunId: this._selectedRecipeRunId,
        gatewaySelectedRecipeRunId: result.selectedRecipeRunId,
      });
      this._selectedRecipeRunId = desiredId;
      if (pendingRecipeRunId && desiredId === pendingRecipeRunId) {
        this._pendingRecipeRunSelectionId = '';
      }
    } catch (err) {
      if (refreshToken !== this._recipeRunsRefreshToken || this.run?.id !== run.id) return;
      // Recipe-run evidence is optional in run-detail. Keep the gate usable if
      // an older run has no recipe artifact index or the mirror is temporarily unavailable.
      this._recipeRuns = [];
      this._selectedRecipeRunId = '';
      console.warn('Failed to load run recipe evidence:', err);
    }
  }

  private _handleRecipeRunArtifacts(
    run: Run,
    detail: RecipeCompleteDetail,
    delayed: boolean,
  ): void {
    if (detail.requestId) {
      this._pendingRecipeRunSelectionId = `live-run:${detail.requestId}`;
    }
    void this._refreshRecipeRunsForRun(run, { force: true });
    if (!delayed || !detail.requestId) return;
    const pendingId = `live-run:${detail.requestId}`;
    if (this._recipeRunsDelayedRefreshTimer) clearTimeout(this._recipeRunsDelayedRefreshTimer);
    this._recipeRunsDelayedRefreshTimer = setTimeout(() => {
      this._recipeRunsDelayedRefreshTimer = undefined;
      if (this.run?.id === run.id && this._pendingRecipeRunSelectionId === pendingId) {
        void this._refreshRecipeRunsForRun(run, { force: true });
      }
    }, 1500);
  }

  private _actionsBlocked(): boolean {
    return (
      this._connectionStale ||
      this._hydrating ||
      this._bootstrapFailed ||
      this._directRunRefreshing ||
      this._directRunRefreshFailed
    );
  }

  private async fetchSiblings(run: Run) {
    const requestSeq = ++this._siblingsRequestSeq;
    const requestStillCurrent = () =>
      requestSeq === this._siblingsRequestSeq && this.runId === run.id;
    try {
      const res = await gateway.request<RunListResult>(Methods.RUN_LIST, {
        familyId: run.familyId,
      });
      if (!requestStillCurrent()) return;
      this.siblings = sortRunsForFamilyView((res.runs ?? []).filter((r) => r.id !== run.id));
    } catch (err) {
      if (!requestStillCurrent()) return;
      this.siblings = [];
      console.warn(`Failed to load siblings for ${run.id}: ${(err as Error).message}`);
    }
  }

  private _onHashChange = () => {
    if (isRunDetailHashForRun(this.runId)) {
      this._applySelectedStepFromHash();
      this._applyEvidenceArtifactFromHash();
    }
  };

  private _applySelectedStepFromHash() {
    if (!this.run) return;
    const stepName = selectedStepNameFromRunDetailHash();
    if (!stepName) {
      this.selectedStep = null;
      this.selectedStepProgress = null;
      this._selectedStepProgressKey = '';
      return;
    }
    this.selectedStep =
      this.run.steps.find((s) => s.name === stepName) ??
      publicationReviewStepForName(this.run, stepName);
    void this._loadSelectedStepProgress();
  }

  private _lightboxItemsForArtifacts(artifacts: FamilyObservabilityArtifact[]): LightboxItem[] {
    return runEvidenceLightboxItems(artifacts, this._artifactUrl);
  }

  private _applyEvidenceArtifactFromHash(): void {
    if (!this.run) return;
    const { artifactRun, artifact } = artifactSelectionFromRunDetailHash();
    if (!artifact) {
      if (this._evidenceLightboxOpen) {
        this._evidenceLightboxOpen = false;
        this._evidenceLightboxItems = [];
        this._evidenceLightboxIndex = 0;
      }
      return;
    }
    if (artifactRun && artifactRun !== this.runId) return;
    const artifacts = collectRunEvidenceArtifacts(this.run);
    const index = artifacts.findIndex((candidate) => candidate.path === artifact);
    if (index < 0) return;
    this._evidenceLightboxItems = this._lightboxItemsForArtifacts(artifacts);
    this._evidenceLightboxIndex = index;
    this._evidenceLightboxOpen = true;
  }

  private _syncSelectedStepToHash() {
    if (this._suppressHashSync) return;
    const stepName = this.selectedStep?.name;
    const next = runDetailStepHash(this.runId, stepName ?? null);
    if (location.hash !== next) {
      this._suppressHashSync = true;
      location.hash = next;
      queueMicrotask(() => {
        this._suppressHashSync = false;
      });
    }
  }

  private _requestCopilotRunDiagnosis(run: Run) {
    this.dispatchEvent(
      new CustomEvent('copilot-prompt-request', {
        detail: {
          prompt: buildRunDiagnosisPrompt(run),
          intent: 'diagnostic-readonly',
          runId: run.id,
          sourceSurface: 'run-detail',
          contextOverride: {
            selectedRunId: run.id,
            surfaceId: 'run-detail',
            affordances: ['failed-run-diagnosis', 'recovery-proposal'],
          },
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async fetchTaskProgress(slotId: string) {
    const runId = this.runId;
    const requestSeq = ++this._taskProgressRequestSeq;
    const requestStillCurrent = () =>
      requestSeq === this._taskProgressRequestSeq &&
      this.runId === runId &&
      this.run?.slotId === slotId;
    this._lastTaskProgressFetchAt = Date.now();
    try {
      const res = await gateway.request<TaskProgressResult>(Methods.TASK_PROGRESS, {
        slotId,
        runId,
      });
      if (!requestStillCurrent()) return;
      if (res.structured) this.taskProgress = res.structured;
    } catch (err) {
      if (!requestStillCurrent()) return;
      // During slot release/replay the slot can briefly have no task file; keep
      // the existing UI snapshot instead of failing the whole run detail render.
      console.debug(`Task progress unavailable for ${slotId}: ${(err as Error).message}`);
    }
  }

  private async _loadSelectedStepProgress(): Promise<void> {
    const step = this.selectedStep;
    const run = this.run;
    const artifactPath = (step?.outputs as Record<string, unknown> | undefined)
      ?.taskProgressArtifactPath;
    const key = `${run?.id ?? ''}:${step?.name ?? ''}:${typeof artifactPath === 'string' ? artifactPath : ''}`;
    if (key === this._selectedStepProgressKey) return;
    this._selectedStepProgressKey = key;
    this.selectedStepProgress = null;
    if (!run?.slotId || !step || typeof artifactPath !== 'string' || !artifactPath.trim()) return;
    try {
      const res = await gateway.request<TaskProgressResult>(
        Methods.TASK_PROGRESS,
        { slotId: run.slotId, runId: run.id, taskFile: artifactPath },
        15_000,
      );
      if (key !== this._selectedStepProgressKey) return;
      this.selectedStepProgress = res.structured ?? null;
    } catch (err) {
      console.warn(
        `Task progress artifact unavailable for ${step.name}: ${(err as Error).message}`,
      );
    }
  }

  private _artifactUrl = (artifact: FamilyObservabilityArtifact): string => {
    return runArtifactUrl(artifact.runId, artifact);
  };

  private _updateEvidenceArtifactHash(item: LightboxItem | null): void {
    const next = runDetailEvidenceArtifactHash(this.runId, item);
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  private _closeEvidenceLightbox(): void {
    this._evidenceLightboxOpen = false;
    this._updateEvidenceArtifactHash(null);
  }

  private _navigateEvidenceLightbox(index: number): void {
    this._evidenceLightboxIndex = index;
    this._updateEvidenceArtifactHash(this._evidenceLightboxItems[index] ?? null);
  }

  private _onEvidenceArtifactClick(
    e: CustomEvent<{ artifacts: FamilyObservabilityArtifact[]; index: number }>,
  ): void {
    const { artifacts, index } = e.detail;
    this._evidenceLightboxItems = this._lightboxItemsForArtifacts(artifacts);
    this._evidenceLightboxIndex = index;
    this._evidenceLightboxOpen = true;
    this._updateEvidenceArtifactHash(this._evidenceLightboxItems[index] ?? null);
  }

  private _renderRunEvidence(run: Run) {
    return renderRunEvidence(run, {
      evidenceLightboxItems: this._evidenceLightboxItems,
      evidenceLightboxOpen: this._evidenceLightboxOpen,
      evidenceLightboxIndex: this._evidenceLightboxIndex,
      artifactUrl: this._artifactUrl,
      onEvidenceArtifactClick: (event) => this._onEvidenceArtifactClick(event),
      closeEvidenceLightbox: () => this._closeEvidenceLightbox(),
      navigateEvidenceLightbox: (index) => this._navigateEvidenceLightbox(index),
    });
  }

  private _renderInteractivePackets(run: Run) {
    const artifacts = collectRunInteractivePacketArtifacts(run);
    if (artifacts.length === 0) return null;
    return html`
      <interactive-operator-packets
        .runId=${run.id}
        .slotId=${run.slotId}
        .decisions=${run.decisions}
        .artifacts=${artifacts}
        .artifactTextLoader=${this.mockData ? this.mockArtifactTextLoader : null}
      ></interactive-operator-packets>
    `;
  }

  render() {
    return renderRunDetailView({
      embedded: this.embedded,
      run: this.run,
      prStatus: this.prStatus,
      siblings: this.siblings,
      taskProgress: this.taskProgress,
      selectedStep: this.selectedStep,
      selectedStepProgress: this.selectedStepProgress,
      _hydrating: this._hydrating,
      _bootstrapFailed: this._bootstrapFailed,
      _connectionStale: this._connectionStale,
      _directRunRefreshing: this._directRunRefreshing,
      _directRunRefreshFailed: this._directRunRefreshFailed,
      _directRunUnavailable: this._directRunUnavailable,
      _rescueInProgress: this._rescueInProgress,
      _pendingConfirm: this._pendingConfirm,
      _showTerminal: this._showTerminal,
      _actionsBlocked: () => this._actionsBlocked(),
      _rescueLinkage: (runId) => this._rescueLinkage(runId),
      _confirmForceComplete: (run) => this._confirmForceComplete(run),
      _confirmLifecycleAction: (run, action) =>
        confirmRunLifecycleAction(run, action, {
          actionsBlocked: () => this._actionsBlocked(),
          pendingConfirm: () => this._pendingConfirm,
          setPendingConfirm: (pending) => {
            this._pendingConfirm = pending;
          },
          confirmTimer: () => this._confirmTimer,
          setConfirmTimer: (timer) => {
            this._confirmTimer = timer;
          },
          navigateToRuns: () => {
            location.hash = runInventoryHashFromDetail();
          },
        }).catch((err) => alert(`Run ${action} failed: ${(err as Error).message}`)),
      _requestCopilotRunDiagnosis: (run) => this._requestCopilotRunDiagnosis(run),
      _buildRerunAlongsideHref: buildRerunAlongsideHref,
      _slotBranchForRun: (run) =>
        getState().fleet?.slots.find((slot) => slot.slot === run.slotId)?.branch ?? '',
      _slotHealthForRun: (run) =>
        getState().fleet?.slots.find((slot) => slot.slot === run.slotId)?.health ?? null,
      _setRunTags: (run, raw) => this._setRunTags(run, raw),
      _togglePinnedSlot: (slotId) => {
        togglePinnedSlot(slotId);
        this.requestUpdate();
      },
      _renderInteractiveDevGate: (run) =>
        renderInteractiveDevGate(run, {
          busyAction: this._interactiveDevActionInProgress,
          actionsBlocked: this._actionsBlocked(),
          resolveInteractiveDev: (targetRun, action) =>
            this._resolveInteractiveDev(targetRun, action),
        }),
      _currentCiStatus: (run) => currentRunCiStatus(run, this.ciStatus),
      _shouldShowCiStatus: (run) => this._shouldShowCiStatus(run),
      _renderCiStatus: (run) =>
        renderRunCiStatus(run, {
          ci: currentRunCiStatus(run, this.ciStatus),
          timeoutDecision: pendingCITimeoutDecision(run),
          liveTimeoutPrStatus: this.liveTimeoutPrStatus,
          prStatus: this.prStatus,
          liveTimeoutPrStatusRefreshing: this.liveTimeoutPrStatusRefreshing,
          liveTimeoutPrStatusFailed: this.liveTimeoutPrStatusFailed,
          poking: this._ciPoking,
          pokeStatus: this._ciPokeStatus,
          onPokeNow: () => void this._pokeCIWatch(run.id),
          now: this._now,
        }),
      _renderRunEvidence: (run) => this._renderRunEvidence(run),
      _renderPosture: () => renderRunPostureSummary(this._postureStatus),
      _renderInteractivePackets: (run) => this._renderInteractivePackets(run),
      _renderAgentSessions: (run) =>
        renderRunAgentSessions(run, {
          states: this._sessionStates,
          onCopy: (row, kind) => void this._copyRunnerSessionCommand(run, row, kind),
        }),
      _onReplayStep: (stepName, skipPrepare, prepareProfile, freshDispatch) =>
        this._onReplayStep(stepName, skipPrepare, prepareProfile, freshDispatch),
      renderGateSection: (run) => this.renderGateSection(run),
      renderGrade: renderRunGrade,
      onStepSelect: (step) => {
        this.selectedStep = step;
        this._syncSelectedStepToHash();
        void this._loadSelectedStepProgress();
      },
      onStepInspectorClose: () => {
        this.selectedStep = null;
        this._syncSelectedStepToHash();
      },
      toggleTerminal: () => {
        this._showTerminal = !this._showTerminal;
      },
    });
  }

  /**
   * Copy the gateway-built command for one agent context. The command is never
   * assembled here — `run.sessionCommand` owns the runner CLI syntax, and its
   * structured liveness is what labels the row.
   */
  private async _copyRunnerSessionCommand(
    run: Run,
    row: RunSessionRow,
    kind: RunSessionCopyKind,
  ): Promise<void> {
    // Sequenced per context: one global counter meant a click on a second row
    // invalidated the first row's in-flight request, leaving it stuck on
    // "Loading…" forever.
    const requestSeq = (this._sessionRequestSeq[row.contextId] ?? 0) + 1;
    this._sessionRequestSeq = { ...this._sessionRequestSeq, [row.contextId]: requestSeq };
    // A response that lands after the operator moved to another run, or after a
    // newer click on this row, must not overwrite what is on screen now.
    const requestStillCurrent = () =>
      requestSeq === this._sessionRequestSeq[row.contextId] && this.runId === run.id;
    this._sessionStates = { ...this._sessionStates, [row.contextId]: { status: 'loading' } };
    try {
      const result = await gateway.request<RunSessionCommandResult>(Methods.RUN_SESSION_COMMAND, {
        runId: run.id,
        // The exact context this row renders. Role alone would resolve to the
        // newest context sharing that role, which is the wrong reviewer.
        contextId: row.contextId,
        role: row.role,
      });
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

  private async _setRunTags(run: Run, tags: string[]) {
    await gateway.request(Methods.RUN_TAGS_SET, { runId: run.id, tags });
  }

  private async _pokeCIWatch(runId: string): Promise<void> {
    const ciStep = this.run?.steps.find((step) => step.name === 'ci-watch');
    const outputPollCount = readCiWatchOutputs(ciStep?.outputs)?.pollCount;
    const beforePoll = this.ciStatus?.pollCount ?? outputPollCount;
    await this._ciPoke.poke(runId, typeof beforePoll === 'number' ? beforePoll : null);
  }

  private renderGateSection(run: Run) {
    return renderRunGateSection(run, {
      allRuns: getState().runs,
      pendingDecisions: getState().decisions,
      bootstrapFailed: this._bootstrapFailed,
      directRunRefreshFailed: this._directRunRefreshFailed,
      actionsBlocked: this._actionsBlocked(),
      pendingConfirm: this._pendingConfirm,
      recipeRuns: this._recipeRuns,
      selectedRecipeRunId: this._selectedRecipeRunId,
      selectedSlotId: this._selectedSlotId,
      resetBranch: this._resetBranch,
      branchNudgeShowPicker: this._branchNudgeShowPicker,
      liveTimeoutPrStatus: this.liveTimeoutPrStatus,
      liveTimeoutPrStatusRefreshing: this.liveTimeoutPrStatusRefreshing,
      liveTimeoutPrStatusFailed: this.liveTimeoutPrStatusFailed,
      isLiveTimeoutAllGreen: () => isLiveTimeoutPrStatusAllGreen(this.liveTimeoutPrStatus),
      setSelectedSlot: (slotId, resetBranch) => {
        this._selectedSlotId = slotId;
        if (resetBranch !== undefined) this._resetBranch = resetBranch;
      },
      setResetBranch: (resetBranch) => {
        this._resetBranch = resetBranch;
      },
      setBranchNudgeShowPicker: (show) => {
        this._branchNudgeShowPicker = show;
      },
      confirmResolve: (runId, decision, actionId) =>
        this._confirmResolve(runId, decision, actionId),
      posture: this._postureGate,
      postureResolveBlocked: !canResolveWithPostureChoice(this._postureGate),
      selectPostureChoice: (choice) => void this._selectPostureGateChoice(run.id, choice),
      checkInteractiveHandoffSignal: (runId, decision) =>
        this._checkInteractiveHandoffSignal(runId, decision),
      handoffSignalCheckBusy: this._handoffSignalCheckBusy,
      handoffSignalCheckError: this._handoffSignalCheckError,
      resolveSlotPick: (runId, decisionId) => this._resolveSlotPick(runId, decisionId),
      resolveBranchNudgePick: (runId, decisionId) =>
        this._resolveBranchNudgePick(runId, decisionId),
      handleRecipeRunArtifacts: (targetRun, detail, preferSelectedArtifacts) =>
        this._handleRecipeRunArtifacts(targetRun, detail, preferSelectedArtifacts),
    });
  }

  private async _rescueLinkage(runId: string) {
    await rescueRunLinkage(runId, {
      actionsBlocked: () => this._actionsBlocked(),
      rescueInProgress: () => this._rescueInProgress,
      setRescueInProgress: (inProgress) => {
        this._rescueInProgress = inProgress;
      },
    });
  }

  private async _resolveInteractiveDev(run: Run, action: DevInteractiveCompletionAction) {
    await resolveInteractiveDevAction(run, action, {
      actionsBlocked: () => this._actionsBlocked(),
      busyAction: () => this._interactiveDevActionInProgress,
      setBusyAction: (busyAction) => {
        this._interactiveDevActionInProgress = busyAction as DevInteractiveCompletionAction | null;
      },
    });
  }

  private _confirmForceComplete(run: Run) {
    confirmForceComplete(run, this._confirmTimerContext());
  }

  private _confirmResolve(runId: string, decision: RunDecision, actionId: string) {
    // A choice the Gateway already refused in preview must not be sent: the
    // decision would be consumed and the refusal repeated with nothing to undo.
    if (!canResolveWithPostureChoice(this._postureGate)) return;
    confirmRunDecision(runId, decision, actionId, {
      ...this._confirmTimerContext(),
      jumpToSuccessorWhenAvailable: (originRunId) =>
        this._jumpToSuccessorWhenAvailable(originRunId),
      resourcePosture: () => this._postureGate.choice,
      onDecisionResolved: (run) => {
        // The apply outcome is the Gateway's, read back from the run it returned.
        const transition = run.resourcePosture?.lastTransition;
        this._postureGate = {
          ...this._postureGate,
          ...(transition ? { appliedTransition: transition } : {}),
        };
        this._postureStatusKey = '';
        void this._refreshPostureStatus(run.id);
      },
    });
  }

  private async _checkInteractiveHandoffSignal(runId: string, decision: RunDecision) {
    // A refused posture choice blocks the resume for the same reason it blocks
    // any other resolution: the decision would be consumed by a refusal.
    if (!canResolveWithPostureChoice(this._postureGate)) return;
    await checkInteractiveHandoffSignal(runId, decision, {
      actionsBlocked: () => this._actionsBlocked(),
      busy: () => this._handoffSignalCheckBusy,
      setBusy: (busy) => {
        this._handoffSignalCheckBusy = busy;
      },
      setError: (error) => {
        this._handoffSignalCheckError = error;
      },
      resourcePosture: () => this._postureGate.choice,
      onDecisionResolved: (run) => {
        const transition = run.resourcePosture?.lastTransition;
        this._postureGate = {
          ...this._postureGate,
          ...(transition ? { appliedTransition: transition } : {}),
        };
        this._postureStatusKey = '';
        void this._refreshPostureStatus(run.id);
      },
    });
  }

  private _jumpToSuccessorWhenAvailable(originRunId: string): void {
    jumpToSuccessorWhenAvailable(originRunId, {
      jumpTimer: () => this._jumpTimer,
      setJumpTimer: (timer) => {
        this._jumpTimer = timer;
      },
      isConnected: () => this.isConnected,
      allRuns: () => getState().runs ?? [],
      navigateToRun: (runId) => {
        location.hash = `run/${runId}`;
      },
    });
  }

  private _confirmTimerContext() {
    return {
      actionsBlocked: () => this._actionsBlocked(),
      pendingConfirm: () => this._pendingConfirm,
      setPendingConfirm: (pending: string | null) => {
        this._pendingConfirm = pending;
      },
      confirmTimer: () => this._confirmTimer,
      setConfirmTimer: (timer: ReturnType<typeof setTimeout> | undefined) => {
        this._confirmTimer = timer;
      },
    };
  }

  private _resolveBranchNudgePick(runId: string, decisionId: string) {
    resolveBranchNudgePick(runId, decisionId, this._slotDecisionContext());
  }

  private _resolveSlotPick(runId: string, decisionId: string) {
    resolveSlotPick(runId, decisionId, this._slotDecisionContext());
  }

  private _slotDecisionContext() {
    return {
      actionsBlocked: () => this._actionsBlocked(),
      selectedSlotId: () => this._selectedSlotId,
      resetBranch: () => this._resetBranch,
      setSelectedSlotId: (slotId: string | null) => {
        this._selectedSlotId = slotId;
      },
      setResetBranch: (resetBranch: boolean) => {
        this._resetBranch = resetBranch;
      },
      setBranchNudgeShowPicker: (show: boolean) => {
        this._branchNudgeShowPicker = show;
      },
    };
  }

  private async _onReplayStep(
    stepName: string,
    skipPrepare?: boolean,
    prepareProfile?: string,
    freshDispatch?: boolean,
  ) {
    if (this._actionsBlocked()) return;
    if (!this.run) return;
    if (
      freshDispatch &&
      !window.confirm('Abandon the ambiguous retained handoff, stop its runner, and launch fresh?')
    ) {
      return;
    }
    try {
      await gateway.request(Methods.RUN_REPLAY_STEP, {
        runId: this.run.id,
        stepName,
        skipPrepare: skipPrepare || undefined,
        prepareProfile: prepareProfile || undefined,
        freshDispatch: freshDispatch || undefined,
      });
      this.selectedStep = null;
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      console.error('Replay step failed:', err);
      alert(`Retry from "${stepName}" failed: ${msg}`);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'run-detail': RunDetail;
  }
}
