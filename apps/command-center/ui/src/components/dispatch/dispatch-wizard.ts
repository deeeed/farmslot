import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';

import type {
  ConfigTemplateOptionsResult,
  DispatchCandidatesResult,
  ExecutionTemplateCatalogOption,
  FlowType,
  NativeSessionCatalogResult,
  PRStatus,
  ReviewRunnerId,
  ReviewValidationDepth,
  Run,
  RunCancelResult,
} from '@farmslot/protocol';
import { failedRunCancelEffects, Methods } from '@farmslot/protocol';

import './execution-template-preview-modal.js';
import './dispatch-native-profiles.js';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, isHydrating, subscribe } from '../../state.js';
import {
  COMPARISON_LANE_RUNNERS,
  DEFAULT_MODEL,
  RUNNER_OPTIONS,
} from '../../utils/runner-options.js';
import {
  deriveExecutionTemplatePickerView,
  pickCompatibleExecutionTemplateId,
} from '../shared/execution-template-picker-model.js';

import {
  dispatchNativeProfileKey,
  type DispatchNativeProfileSelection,
  nativeDispatchNodeSlots,
  nativeDispatchProfileReason,
} from './dispatch-native-profile-model.js';
import {
  addDispatchQueueItemFromDraft,
  buildDispatchWizardPayloadDraft,
  dispatchRunCreateFromDraft,
} from './dispatch-wizard-actions.js';
import { deriveDispatchWizardBlockingState } from './dispatch-wizard-blockers.js';
import {
  buildComparisonRunParams,
  comparisonBranchHint,
  comparisonVariantInputBlocked,
  deriveComparisonVariantState,
  exitedComparisonModeState,
  forkComparisonStateFromRun,
  hydrateComparisonEngineFromParent,
  resolveComparisonVariant,
  shouldHydrateComparisonParentEngine,
} from './dispatch-wizard-comparison-state.js';
import {
  appLabel,
  buildPublicationReviewGateParams,
  buildPublicationReviewPlan,
  defaultExtraReviewRunner,
  interactiveTemplateOption,
  modeForFlow,
  projectApps,
  projectPrepareProfiles,
  publicationReviewsEnabled,
  qaDispatchFields,
  selectedDispatchApp,
  selectedTaskTemplate,
  selectedTemplateMode,
  syncSelectedAppForProject,
} from './dispatch-wizard-draft.js';
import {
  lookupRecentRunsForComparisonPicker,
  requestDispatchProfileFit,
  requestDispatchProjectMatch,
  requestDispatchWizardCandidates,
  requestExecutionTemplatePreview,
  requestProjectConfigs,
  requestUnfilteredTemplateOptions,
} from './dispatch-wizard-loaders.js';
import { parseDispatchWizardHash, syncPublicationReviewsHash } from './dispatch-wizard-prefill.js';
import {
  candidateDispatchable,
  dispatchableCandidates,
  findSameTaskSlot,
  pressureOverrideAvailable,
  resolveTargetBranch,
  selectedCandidate,
  selectedNudgeIntent,
  slotSummaryLabel,
} from './dispatch-wizard-selectors.js';
import { DispatchWizardState } from './dispatch-wizard-state.js';
import {
  deriveCandidateResultState,
  deriveDispatchFleetViewState,
  deriveIssueTypeFlowState,
  filterDispatchCandidatesForProject,
  findActiveRunConflict,
} from './dispatch-wizard-state-model.js';
import { dispatchWizardStyles } from './dispatch-wizard-styles.js';
import {
  clearTemplateOptionsState,
  deriveTemplateOptionsState,
} from './dispatch-wizard-template-options.js';
import {
  loadDispatchTemplatePreference,
  persistDispatchTemplatePreference,
  selectedExecutionTemplatePreference,
} from './dispatch-wizard-template-preferences.js';
import { renderDispatchWizardView } from './dispatch-wizard-view-renderer.js';

@customElement('dispatch-wizard')
export class DispatchWizard extends DispatchWizardState {
  private readonly _templateOptionsCache = new Map<string, ConfigTemplateOptionsResult>();

  updated(changed: Map<string, unknown>) {
    super.updated(changed);
    if (this.mockMode && changed.has('mockInitial')) {
      this._applyMockInitial();
      this._syncFleet(getState());
    }
    if (this.mockMode && changed.has('mockProjectConfigs') && this.mockProjectConfigs) {
      this._projectConfigs = this.mockProjectConfigs;
      this._syncSelectedAppForProject(this._project);
      this._syncWorkflowSelection();
      this._syncFleet(getState());
    }
    if (this.mockMode && changed.has('mockCandidates') && this._project) {
      void this._fetchCandidates();
      void this._fetchTemplateOptions();
    }
    if (changed.has('_flowType') && this._project && this._flowType) {
      this._applyVisibleCatalog();
    }
    // Ticket identity can change target-branch scoring and nudge rows. Keep the
    // current snapshot on screen and rescore in the background.
    const scoringTickers = ['_ticketId', '_normalizedTicket'];
    if (scoringTickers.some((k) => changed.has(k))) {
      if (this._scoringFetchTimer) clearTimeout(this._scoringFetchTimer);
      this._scoringFetchTimer = setTimeout(() => {
        this._scoringFetchTimer = null;
        void this._fetchCandidates({ silent: this._allCandidates.length > 0 });
      }, 250);
    }
    if (changed.has('_comparePickerOpen') && this._comparePickerOpen) {
      void this.updateComplete.then(() => {
        this.shadowRoot?.querySelector<HTMLElement>('.compare-modal-backdrop')?.focus();
      });
    }
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('keydown', this._onComparePickerKeydown);
    this._parseHashParams();
    this._applyMockInitial();
    this._syncFleet(getState());
    if (!this.mockMode && gateway.connectionState === 'connected') void this._loadNativeWorkers();
    if (this.mockMode && this.mockProjectConfigs) {
      this._projectConfigs = this.mockProjectConfigs;
      this._syncSelectedAppForProject(this._project);
      this._syncWorkflowSelection();
      this._syncFleet(getState());
    } else {
      void this._loadProjectConfigs();
    }
    this._unsubConn = gateway.onConnectionChange((st) => {
      if (this.mockMode) return;
      if (st !== 'connected') {
        this._nativeCatalogReady = false;
        this._nativeCatalogGeneration++;
      }
      if (st === 'connected') {
        void this._loadNativeWorkers();
        this._templateOptionsCache.clear();
        this._allCandidates = [];
        if (this._projectConfigs.length === 0) {
          void this._loadProjectConfigs();
        }
        void this._fetchTemplateOptions();
        void this._fetchCandidates();
      }
    });
    this._unsubState = subscribe((s) => this._syncFleet(s));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this._onComparePickerKeydown);
    this._unsubConn?.();
    this._unsubState?.();
    if (this._matchTimer) clearTimeout(this._matchTimer);
    if (this._scoringFetchTimer) clearTimeout(this._scoringFetchTimer);
  }

  private async _loadNativeWorkers(): Promise<void> {
    const generation = ++this._nativeCatalogGeneration;
    const epoch = gateway.connectionEpoch;
    const scope = `${gateway.gatewayUrl}:${gateway.authenticatedPrincipalId}`;
    if (scope !== this._nativeProfileScope) {
      this._nativeProfileScope = scope;
      this._nativeProfileSelection = null;
      this._nativeCatalog = undefined;
    }
    this._nativeCatalogReady = false;
    this._nativeWorkerRunners = [];
    this._nativeQueueRunners = [];
    try {
      const result = await gateway.request<NativeSessionCatalogResult>(
        Methods.NATIVE_SESSION_CATALOG,
        {},
      );
      if (
        !this.isConnected ||
        gateway.connectionState !== 'connected' ||
        epoch !== gateway.connectionEpoch ||
        generation !== this._nativeCatalogGeneration
      )
        return;
      this._nativeCatalog = result;
      this._nativeCatalogReady = true;
      this._nativeProfileRefreshVersion++;
      this._nativeWorkerRunners = result.runners
        .filter((runner) => runner.supportsWorkers)
        .map((runner) => runner.runner);
      this._nativeCatalogError = '';
      this._nativeQueueRunners = result.runners
        .filter((runner) => runner.supportsWorkers && runner.supportsQueuedWorkers)
        .map((runner) => runner.runner);
    } catch (error) {
      if (this.isConnected && generation === this._nativeCatalogGeneration)
        this._nativeCatalogError = `Native worker choices unavailable: ${(error as Error).message}`;
    }
  }

  private _syncFleet(s: AppState) {
    const wasHydrating = this._hydrating;
    this._hydrating = this.mockMode ? false : isHydrating(s, 'fleet');
    this._bootstrapFailed = this.mockMode ? false : s.bootstrapFailed.fleet;
    this._connectionStale = this.mockMode ? false : s.connection !== 'connected';
    const { projects: fp, machines: fm } = s.globalFilters;
    const fleetView = deriveDispatchFleetViewState({
      slots: s.fleet?.slots ?? [],
      configuredProjects: this._projectConfigs.map((project) => project.name),
      currentProject: this._project,
      globalProjectFilters: fp,
      globalMachineFilters: fm,
    });
    this._availableProjects = fleetView.availableProjects;

    // Auto-select project if exactly 1 available (from filter or fleet)
    if (fleetView.projectAutoSelected) {
      this._project = fleetView.project;
      this._slotOverride = '';
      this._slotOverrideExplicit = false;
      this._restoreTemplatePreference();
      this._syncSelectedAppForProject(this._project);
      this._applyVisibleCandidates();
      void this._fetchTemplateOptions();
      void this._fetchCandidates({ silent: this._allCandidates.length > 0 });
    }
    // Clear project if it's no longer in the filtered list. Skip when the
    // fleet hasn't produced any projects yet (initial mount before fleet
    // state arrives) — otherwise a hash-prefilled project from an upstream
    // link (e.g. PR dashboard "Complete PR") gets clobbered on first sync.
    if (fleetView.projectCleared) {
      this._project = fleetView.project;
      this._app = '';
      this._candidates = [];
      this._allProjectSlots = [];
      this._restoreTemplatePreference();
    }

    this._allProjectSlots = fleetView.allProjectSlots;
    this._syncWorkflowSelection();
    this._queueItems = s.queueItems ?? [];

    const machineSig = fleetView.machineFilterSignature;
    const hydrationJustFinished = wasHydrating && !this._hydrating && !this._bootstrapFailed;
    const machineFilterChanged = machineSig !== this._lastFetchMachines;
    const targetBranchNow = this._resolveTargetBranch(s.prs);
    const targetBranchChanged = targetBranchNow !== this._lastFetchTargetBranch;
    this._prefetchMissingCatalogs(fleetView.availableProjects);
    if (hydrationJustFinished || machineFilterChanged || targetBranchChanged) {
      void this._fetchCandidates({
        silent: this._allCandidates.length > 0 && !machineFilterChanged && !hydrationJustFinished,
      });
    }

    const comparisonFilterKey = `${[...fp].sort().join(',')}|${machineSig}`;
    if (this._comparePickerOpen && comparisonFilterKey !== this._comparisonPickerFilterKey) {
      void this._loadComparisonPickerRuns();
    }

    this._tryHydrateComparisonParentEngine(s.runs ?? []);
  }

  private _tryHydrateComparisonParentEngine(runs: readonly Run[]): void {
    const parentTransport = runs.find((run) => run.id === this._comparisonParentRunId);
    if (parentTransport && !this._transportChosen && this._flowType !== 'review-pr') {
      this._transport = parentTransport.transport ?? 'tmux';
      this._transportChosen = true;
    }
    if (
      !shouldHydrateComparisonParentEngine({
        hydrated: this._comparisonParentEngineHydrated,
        comparisonFlow: this._comparisonFlow,
        parentRunId: this._comparisonParentRunId,
        hashPinnedEngine: this._comparisonHashPinnedEngine,
      })
    ) {
      return;
    }
    const parent = runs.find((run) => run.id === this._comparisonParentRunId);
    if (!parent) return;
    const next = hydrateComparisonEngineFromParent(
      parent,
      { runner: this._runner, model: this._model },
      COMPARISON_LANE_RUNNERS,
    );
    this._runner = next.runner;
    this._model = next.model;
    this._comparisonParentEngineHydrated = true;
    this._recomputeVariantCollision();
  }

  private async _loadProjectConfigs(): Promise<void> {
    if (this.mockMode && this.mockProjectConfigs) {
      this._projectConfigs = this.mockProjectConfigs;
      this._syncSelectedAppForProject(this._project);
      this._syncWorkflowSelection();
      this._syncFleet(getState());
      return;
    }
    if (this._loadingProjectConfigs) return;
    this._loadingProjectConfigs = true;
    try {
      this._projectConfigs = await requestProjectConfigs();
      this._syncSelectedAppForProject(this._project);
      this._syncWorkflowSelection();
      this._syncFleet(getState());
    } catch (err) {
      // Config loading is optional for single-app projects; keep the wizard usable
      // and retry on the next reconnect/manual project selection.
      console.warn('[dispatch-wizard] config projects failed:', err);
      this._projectConfigs = [];
    } finally {
      this._loadingProjectConfigs = false;
    }
  }

  private _syncSelectedAppForProject(projectName: string): void {
    this._app = syncSelectedAppForProject(
      projectApps(this._projectConfigs, projectName),
      this._app,
    );
  }

  private _selectedSlotPlatform(): string | undefined {
    return this._allProjectSlots.find((slot) => slot.slot === this._slotOverride)?.platform;
  }

  private _applyVisibleCatalog(): void {
    if (this._flowType === 'review-pr' || this._flowType === 'qa') {
      this._executionTemplates = null;
      this._selectedExecutionTemplateId = '';
      this._templateOptions = [];
      this._selectedTaskTemplateFileName = '';
      this._templateOptionsError = '';
      this._templateOptionsLoading = false;
      return;
    }
    if (!this._project || !this._flowType) {
      const cleared = clearTemplateOptionsState();
      this._templateOptions = cleared.options;
      this._templateOptionsError = cleared.error;
      this._selectedTaskTemplateFileName = cleared.selectedFileName;
      this._executionTemplates = null;
      this._selectedExecutionTemplateId = '';
      return;
    }
    const cached = this._templateOptionsCache.get(this._project);
    if (!cached) return;
    const workerOptions = cached.options.filter((option) => option.flowType === this._flowType);
    const previousSelectionStillValid = workerOptions.some(
      (option) => option.fileName === this._selectedTaskTemplateFileName,
    );
    const next = deriveTemplateOptionsState(workerOptions, this._selectedTaskTemplateFileName);
    if (
      !cached.executionTemplates &&
      !previousSelectionStillValid &&
      modeForFlow(this._flowType) === 'interactive'
    ) {
      next.selectedFileName =
        interactiveTemplateOption(next.options)?.fileName ?? next.selectedFileName;
    }
    this._templateOptions = next.options;
    this._templateOptionsError = next.error;
    this._selectedTaskTemplateFileName = next.selectedFileName;
    this._executionTemplates = cached.executionTemplates ?? null;
    if (!cached.executionTemplates) {
      this._selectedExecutionTemplateId = '';
      this._domain = '';
      return;
    }
    if (this._domain && !cached.executionTemplates.availableDomains.includes(this._domain)) {
      this._domain = '';
    }
    const platform = this._selectedSlotPlatform();
    const view = deriveExecutionTemplatePickerView(
      cached.executionTemplates,
      this._selectedExecutionTemplateId,
      {
        domain: this._domain,
        runMode: this._catalogMode,
        flow: this._flowType,
        ...(platform ? { platform } : {}),
      },
    );
    if (!view.selectionValid || !this._selectedExecutionTemplateId) {
      this._selectedExecutionTemplateId = pickCompatibleExecutionTemplateId({
        options: view.rows.map((row) => row.option),
        defaults: cached.executionTemplates.defaults,
        flow: this._flowType,
        runMode: this._catalogMode,
        domain: this._domain,
        platform,
        preferredId: this._preferredExecutionTemplateId(),
      });
    }
    this._persistTemplatePreference();
  }

  private _prefetchMissingCatalogs(projects: readonly string[]): void {
    if (this.mockMode || this._flowType === 'review-pr' || this._flowType === 'qa') return;
    for (const project of projects) {
      if (!project || this._templateOptionsCache.has(project)) continue;
      void requestUnfilteredTemplateOptions(project)
        .then((result) => {
          this._templateOptionsCache.set(project, result);
          if (this._project === project) this._applyVisibleCatalog();
        })
        .catch((err: unknown) => {
          // Prefetch is optional; the next explicit load for this farm retries.
          console.warn(`[dispatch-wizard] template catalog prefetch failed for ${project}:`, err);
        });
    }
  }

  private async _fetchTemplateOptions(): Promise<void> {
    if (
      !this._project ||
      this.mockMode ||
      this._flowType === 'review-pr' ||
      this._flowType === 'qa'
    ) {
      this._applyVisibleCatalog();
      return;
    }
    const project = this._project;
    const cached = this._templateOptionsCache.get(project);
    if (cached) {
      this._templateOptionsLoading = false;
      this._applyVisibleCatalog();
      this._prefetchMissingCatalogs(this._availableProjects);
      return;
    }
    this._templateOptionsKey = project;
    this._templateOptionsError = '';
    this._templateOptionsLoading = true;
    try {
      const result = await requestUnfilteredTemplateOptions(project);
      this._templateOptionsCache.set(project, result);
      if (this._project !== project) return;
      this._applyVisibleCatalog();
      this._prefetchMissingCatalogs(this._availableProjects);
    } catch (err: unknown) {
      if (this._project !== project) return;
      this._templateOptions = [];
      this._templateOptionsError =
        err instanceof Error ? err.message : 'Template options failed to load';
      this._selectedTaskTemplateFileName = '';
      this._executionTemplates = null;
      this._selectedExecutionTemplateId = '';
    } finally {
      if (this._project === project) this._templateOptionsLoading = false;
    }
  }

  private async _previewExecutionTemplate(
    option: ExecutionTemplateCatalogOption,
    trigger?: HTMLElement,
  ): Promise<void> {
    if (!this._project || !this._flowType) return;
    const activeElement = trigger ?? this.shadowRoot?.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      activeElement.classList.contains('template-preview')
    ) {
      this._executionTemplatePreviewTrigger = activeElement;
    }
    const generation = ++this._executionTemplatePreviewGeneration;
    this._executionTemplatePreviewOption = option;
    this._executionTemplatePreview = null;
    this._executionTemplatePreviewError = '';
    this._executionTemplatePreviewLoading = true;
    try {
      const result = await requestExecutionTemplatePreview(this._project, this._flowType, option);
      if (this._executionTemplatePreviewGeneration !== generation) return;
      this._executionTemplatePreview = result.template;
    } catch (error) {
      if (this._executionTemplatePreviewGeneration !== generation) return;
      this._executionTemplatePreviewError =
        error instanceof Error ? error.message : 'Template preview failed to load';
    } finally {
      if (this._executionTemplatePreviewGeneration === generation) {
        this._executionTemplatePreviewLoading = false;
      }
    }
  }

  private _closeExecutionTemplatePreview(restoreFocus = true): void {
    const trigger = restoreFocus ? this._executionTemplatePreviewTrigger : null;
    this._executionTemplatePreviewGeneration += 1;
    this._executionTemplatePreviewOption = null;
    this._executionTemplatePreview = null;
    this._executionTemplatePreviewLoading = false;
    this._executionTemplatePreviewError = '';
    this._executionTemplatePreviewTrigger = null;
    if (trigger) void this.updateComplete.then(() => trigger.focus());
  }

  private async _refreshExecutionTemplatePreview(): Promise<void> {
    const previous = this._executionTemplatePreviewOption;
    const trigger = this._executionTemplatePreviewTrigger;
    this._closeExecutionTemplatePreview(false);
    await this._fetchTemplateOptions();
    const refreshed = this._executionTemplates?.options.find(
      (option) => option.id === previous?.id && option.sourceId === previous.sourceId,
    );
    if (refreshed) {
      this._executionTemplatePreviewTrigger = trigger;
      await this._previewExecutionTemplate(refreshed, trigger ?? undefined);
      return;
    }
    this._executionTemplatePreviewOption = previous;
    this._executionTemplatePreviewTrigger = trigger;
    this._executionTemplatePreviewError =
      'This template is no longer available. Close the preview and choose another template.';
  }

  private _selectProject(project: string, autoProject = ''): void {
    this._closeExecutionTemplatePreview(false);
    const preservePin = Boolean(
      autoProject && project === this._project && this._slotOverrideExplicit,
    );
    this._project = project;
    this._autoProject = autoProject;
    if (!preservePin) {
      this._slotOverride = '';
      this._slotOverrideExplicit = false;
    }
    this._restoreTemplatePreference();
    this._prepareProfile = '';
    this._syncSelectedAppForProject(project);
    this._syncFleet(getState());
    this._applyVisibleCandidates(this._slotOverride);
    void this._fetchTemplateOptions();
    void this._fetchCandidates({ silent: this._allCandidates.length > 0 });
    this._checkActiveRunConflict();
    if (this._projectConfigs.length === 0) {
      void this._loadProjectConfigs();
    }
  }

  private _applyMockInitial(): void {
    if (!this.mockMode || !this.mockInitial) return;
    if (this.mockInitial.flowType) this._assignFlowType(this.mockInitial.flowType);
    if (this.mockInitial.ticketId !== undefined) this._ticketId = this.mockInitial.ticketId;
    if (this.mockInitial.normalizedTicket !== undefined)
      this._normalizedTicket = this.mockInitial.normalizedTicket;
    if (this.mockInitial.runner) this._runner = this.mockInitial.runner;
    if (this.mockInitial.model) this._model = this.mockInitial.model;
    if (this.mockInitial.project && this._project !== this.mockInitial.project) {
      this._project = this.mockInitial.project;
      this._restoreTemplatePreference();
      this._syncSelectedAppForProject(this._project);
      void this._fetchCandidates();
    }
  }

  private _setTicket(ticketId: string): void {
    if (ticketId !== this._ticketId && this._nudgeIntents.size) {
      this._nudgeIntents.clear();
      this._nudgeIntentVersion++;
    }
    this._ticketId = ticketId;
    this._normalizedTicket = '';
    this._error = '';
    this._activeRunConflict = null;
    this._scheduleMatchProject(this._ticketId);
  }

  private _resolveTargetBranch(prs: ReadonlyArray<PRStatus>): string | undefined {
    return resolveTargetBranch({
      prs,
      flowType: this._flowType,
      ticketId: this._ticketId,
      normalizedTicket: this._normalizedTicket,
      project: this._project,
    });
  }

  private _applyVisibleCandidates(previousOverride?: string): void {
    if (this._flowType === 'review-pr') {
      this._candidates = [];
      this._slotOverride = '';
      this._slotOverrideExplicit = false;
      return;
    }
    let visible = filterDispatchCandidatesForProject(this._allCandidates, this._project);
    if (
      this._transport === 'native' &&
      this._nativeAutomaticSlot &&
      this._nativeProfileSelection?.executionNodeId
    ) {
      const slots = nativeDispatchNodeSlots(
        this._nativeCatalog,
        this._nativeProfileSelection.executionNodeId,
        this._project,
      );
      visible = visible.filter((candidate) => slots.includes(candidate.slotId));
    }
    this._applyCandidateResult({ candidates: visible }, previousOverride ?? this._slotOverride);
  }

  private async _fetchCandidates(
    options: { silent?: boolean; force?: boolean } = {},
  ): Promise<void> {
    if (this._flowType === 'review-pr') {
      this._fetchGen++;
      this._candidates = [];
      this._slotOverride = '';
      this._slotOverrideExplicit = false;
      this._loadingCandidates = false;
      this._candidateRefreshFailed = false;
      return;
    }
    const st = getState();
    const machines = [...st.globalFilters.machines].sort();
    this._lastFetchMachines = machines.join(',');
    // For PR-bound flows, hand the server the PR's head branch so the slot
    // already sitting on that branch wins auto-select instead of losing to
    // the +50 stale penalty. PR metadata is already in state from pr.list —
    // no extra gh round trip.
    const targetBranch = this._resolveTargetBranch(st.prs);
    this._lastFetchTargetBranch = targetBranch;
    const gen = ++this._fetchGen;
    const hasCache = this._allCandidates.length > 0;
    const silent = options.silent === true && hasCache && options.force !== true;
    if (!silent) {
      this._loadingCandidates = true;
      this._candidateRefreshFailed = false;
    }
    const prevOverride = this._slotOverride;
    try {
      const res = await requestDispatchWizardCandidates({
        flowType: this._flowType || undefined,
        machines,
        targetBranch,
        ticketOrPr: this._ticketId || undefined,
        app: this._app || undefined,
        prepareProfile: this._prepareProfile.trim() || undefined,
        comparison:
          this._comparisonLane && this._comparisonFamilyId
            ? {
                familyId: this._comparisonFamilyId,
                variant: this._resolveVariantForDispatch(),
              }
            : undefined,
        candidatesEverLoaded: this._candidatesEverLoaded,
        forceRefresh: options.force === true,
        mockMode: this.mockMode,
        mockCandidates: this.mockCandidates,
      });
      if (!this.mockMode) this._candidatesEverLoaded = true;
      if (gen !== this._fetchGen) return; // superseded by newer filter/project change
      this._allCandidates = res.candidates;
      this._candidateRefreshFailed = false;
      // Prefer the CURRENT selection over the fetch-start snapshot: a row the
      // operator clicked while this fetch was in flight (e.g. a pressure
      // Override pick) must survive the apply instead of being auto-replaced.
      this._applyVisibleCandidates(this._slotOverride || prevOverride);
      void this._fetchProfileFitSuggestion(this._project, gen);
    } catch (err) {
      if (gen !== this._fetchGen) return;
      console.warn('[dispatch-wizard] dispatch.candidates failed:', err);
      this._candidateRefreshFailed = true;
      if (!silent) {
        this._allCandidates = [];
        this._candidates = [];
        if (!this._slotOverrideExplicit) this._slotOverride = '';
      }
    } finally {
      if (gen === this._fetchGen) this._loadingCandidates = false;
    }
  }

  private _refreshDispatchSnapshot(): void {
    if (!this.mockMode) void this._loadNativeWorkers();
    this._templateOptionsCache.clear();
    this._allCandidates = [];
    void this._fetchTemplateOptions();
    void this._fetchCandidates({ force: true });
  }

  private async _fetchProfileFitSuggestion(project: string, gen: number): Promise<void> {
    if (
      this._flowType === 'review-pr' ||
      this._flowType === 'qa' ||
      project !== 'farmslot-farm' ||
      !this._flowType ||
      !this._ticketId.trim() ||
      this._prepareProfile.trim() ||
      this.mockMode
    ) {
      this._profileFitSuggestion = null;
      return;
    }
    try {
      const suggestion = await requestDispatchProfileFit({
        project,
        flowType: this._flowType,
        ticketOrPr: this._ticketId.trim(),
        slotId: this._slotOverride || undefined,
        mode: this._catalogMode,
        domain: this._domain || undefined,
        executionTemplateId: this._selectedExecutionTemplateId || undefined,
        app: this._app || undefined,
        freshReuse:
          this._candidates.find((candidate) => candidate.slotId === this._slotOverride)
            ?.replaceableWarm === true || undefined,
      });
      if (gen !== this._fetchGen) return;
      this._profileFitSuggestion = suggestion;
    } catch (err) {
      if (gen !== this._fetchGen) return;
      console.warn('[dispatch-wizard] dispatch.preview profile fit failed:', err);
      this._profileFitSuggestion = null;
    }
  }

  private _applyCandidateResult(res: DispatchCandidatesResult, prevOverride: string): void {
    const next = deriveCandidateResultState({
      candidates: res.candidates,
      previousOverride: prevOverride,
      explicitOverride: this._slotOverrideExplicit,
      nudgeIntents: this._nudgeIntents,
      flowType: this._flowType,
      normalizedTicket: this._normalizedTicket,
      ticketId: this._ticketId,
      comparisonLane: this._comparisonLane,
      comparisonFamilyId: this._comparisonFamilyId,
      lastFetchScoringKey: this._lastFetchScoringKey,
    });
    this._candidates = next.candidates;
    this._nudgeIntents = next.nudgeIntents;
    if (next.nudgeIntentsChanged) this._nudgeIntentVersion++;
    this._lastFetchScoringKey = next.scoringKey;
    this._slotOverride =
      this._transport === 'native' && this._nativeAutomaticSlot ? '' : next.slotOverride;
    // Fresh candidates carry fresh pressure evidence. A half-completed
    // override confirmation must not survive onto a decision it never saw.
    this._resetPressureOverrideDraft();
    if (next.slotOverride !== prevOverride) this._applyVisibleCatalog();
  }

  // Debounced server-side project resolution
  private _scheduleMatchProject(ticket: string): void {
    if (this._matchTimer) clearTimeout(this._matchTimer);
    if (!ticket.trim()) {
      this._autoProject = '';
      this._issueType = '';
      this._matchingProject = false;
      return;
    }
    // Jira key or URL: match immediately
    // PR number: debounce 400ms (needs GitHub API call)
    const isJira = /^[A-Z]+-\d/i.test(ticket) || /atlassian\.net\/browse\//i.test(ticket);
    const delay = isJira ? 0 : 400;
    this._matchingProject = true;
    this._matchTimer = setTimeout(() => this._doMatchProject(ticket), delay);
  }

  private async _doMatchProject(ticket: string): Promise<void> {
    try {
      const res = await requestDispatchProjectMatch(ticket, this._flowType);
      // Don't overwrite the user's input — server normalizes at dispatch time.
      // Store normalized form only for internal matching (active-run conflict check).
      if (res.normalizedTicket) {
        this._normalizedTicket = res.normalizedTicket;
      }
      // Auto-detect flow type from issue type
      if (res.issueType) {
        this._issueType = res.issueType;
        const flowState = deriveIssueTypeFlowState(
          res.issueType,
          this._flowType,
          this._autoFlowType,
        );
        if (flowState) {
          this._assignFlowType(flowState.flowType);
          this._autoFlowType = flowState.autoFlowType;
        }
      }
      if (res.project) {
        this._selectProject(res.project, res.project);
      } else {
        this._autoProject = '';
      }
    } catch (err) {
      // Ticket matching is an advisory wizard convenience. Dispatch itself still validates
      // normalized refs server-side, so the safe recovery is to keep manual project selection.
      console.warn('[dispatch-wizard] project match failed', err);
      this._autoProject = '';
    } finally {
      this._matchingProject = false;
      this._checkActiveRunConflict();
    }
  }

  private _enterNormalFlow(): void {
    if (this._comparisonFlow || this._comparisonLane) {
      this._exitComparisonMode();
    }
    this._comparisonFlow = false;
    this._comparePickerOpen = false;
  }

  private _enterComparisonFlow(): void {
    this._comparisonFlow = true;
    this._error = '';
    this._checkActiveRunConflict();
    if (!this._comparisonParentRunId) {
      void this._openComparisonPicker();
    }
  }

  private async _loadComparisonPickerRuns(): Promise<void> {
    const state = getState();
    const projectFilters = state.globalFilters.projects;
    const machineFilters = state.globalFilters.machines;
    const filterKey = `${[...projectFilters].sort().join(',')}|${[...machineFilters].sort().join(',')}`;
    this._comparisonPickerFilterKey = filterKey;
    const fetchGen = ++this._comparisonPickerFetchGen;
    this._comparisonPickerLoading = true;
    try {
      const runs = await lookupRecentRunsForComparisonPicker({
        mockMode: this.mockMode,
        stateRuns: this.mockMode && this.mockPriorRuns ? this.mockPriorRuns : (state.runs ?? []),
        projectFilters,
        machineFilters,
      });
      if (
        fetchGen === this._comparisonPickerFetchGen &&
        this._comparisonPickerFilterKey === filterKey
      ) {
        this._comparisonPickerRuns = runs;
      }
    } catch (err) {
      console.warn('[dispatch-wizard] comparison run picker failed', err);
      if (
        fetchGen === this._comparisonPickerFetchGen &&
        this._comparisonPickerFilterKey === filterKey
      ) {
        this._comparisonPickerRuns = [];
      }
    } finally {
      if (
        fetchGen === this._comparisonPickerFetchGen &&
        this._comparisonPickerFilterKey === filterKey
      ) {
        this._comparisonPickerLoading = false;
      }
    }
  }

  private async _openComparisonPicker(): Promise<void> {
    this._comparePickerSearch = '';
    this._comparePickerOpen = true;
    await this._loadComparisonPickerRuns();
  }

  private _onComparePickerKeydown = (event: KeyboardEvent): void => {
    if (!this._comparePickerOpen || event.key !== 'Escape') return;
    event.preventDefault();
    this._comparePickerOpen = false;
  };

  private _exitComparisonMode(): void {
    this._transport = this._flowType === 'review-pr' ? 'native' : 'tmux';
    this._transportChosen = false;
    const next = exitedComparisonModeState();
    this._comparisonLane = next.comparisonLane;
    this._comparisonFamilyId = next.comparisonFamilyId;
    this._comparisonParentRunId = next.comparisonParentRunId;
    this._comparisonVariant = next.comparisonVariant;
    this._variantCollision = next.variantCollision;
    this._variantInput = next.variantInput;
    this._comparisonFlow = false;
    this._comparePickerOpen = false;
    this._comparisonPickerRuns = [];
    this._comparisonParentEngineHydrated = false;
    this._comparisonHashPinnedEngine = false;
    this._checkActiveRunConflict();
  }

  private _applyComparisonBaseline(run: Run): void {
    this._transport = run.transport ?? 'tmux';
    this._transportChosen = true;
    this._comparisonFlow = true;
    const next = forkComparisonStateFromRun(
      run,
      { runner: this._runner, model: this._model },
      COMPARISON_LANE_RUNNERS,
    );
    this._comparisonLane = next.comparisonLane;
    this._comparisonFamilyId = next.comparisonFamilyId;
    this._comparisonParentRunId = next.comparisonParentRunId;
    this._comparisonVariant = next.comparisonVariant;
    this._runner = next.runner;
    this._model = next.model;
    this._ticketId = run.ticketOrPr;
    this._normalizedTicket = '';
    this._assignFlowType(
      run.flowType === 'review-pr' && run.reviewValidationDepth === 'full-live'
        ? 'qa'
        : run.flowType,
    );
    this._autoFlowType = false;
    this._autoProject = '';
    if (run.project) {
      this._selectProject(run.project);
    }
    if (run.flowType === 'qa' && run.qa) {
      this._qaProfileId = run.qa.profile.id;
      this._qaInputsText = JSON.stringify(run.qa.inputs, null, 2);
    }
    this._comparePickerOpen = false;
    this._comparisonParentEngineHydrated = true;
    this._recomputeVariantCollision();
    this._checkActiveRunConflict();
    void this._fetchTemplateOptions();
  }

  private _recomputeVariantCollision(): void {
    const next = deriveComparisonVariantState({
      comparisonLane: this._comparisonLane,
      comparisonFamilyId: this._comparisonFamilyId,
      runs: getState().runs ?? [],
      runner: this._runner,
      model: this._model,
      variantInput: this._variantInput,
    });
    this._variantCollision = next.variantCollision;
    this._variantInput = next.variantInput;
  }

  private _variantInputBlocked(): boolean {
    return comparisonVariantInputBlocked({
      comparisonLane: this._comparisonLane,
      comparisonFamilyId: this._comparisonFamilyId,
      runs: getState().runs ?? [],
      variantInput: this._variantInput,
      variantCollision: this._variantCollision,
    });
  }

  private _resolveVariantForDispatch(): string {
    return resolveComparisonVariant(this._variantInput, this._runner, this._model);
  }

  private async _cancelConflictingRun(): Promise<void> {
    if (!this._activeRunConflict) return;
    try {
      const result = await gateway.request<RunCancelResult>(Methods.RUN_CANCEL, {
        runId: this._activeRunConflict.id,
      });
      this._activeRunConflict = null;
      // The conflict is genuinely resolved — the run is terminal — but a failed slot
      // release means the slot may still be claimed, and this wizard is about to
      // dispatch into it. Say so instead of proceeding silently.
      const failed = failedRunCancelEffects(result.effects);
      if (failed.length) {
        this._error = `Run cancelled, but teardown was incomplete (${failed
          .map((effect) => effect.name)
          .join(', ')}) — the slot may still be claimed.`;
      }
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Cancel failed';
    }
  }

  private _checkActiveRunConflict(): void {
    // Comparison siblings intentionally run alongside the baseline (often blocked).
    if (this._comparisonFlow) {
      this._activeRunConflict = null;
      return;
    }
    this._activeRunConflict = findActiveRunConflict(getState().runs ?? [], {
      ticket: this._ticketId,
      normalizedTicket: this._normalizedTicket,
      project: this._project,
    });
  }

  private _parseHashParams() {
    const prefill = parseDispatchWizardHash(location.hash, RUNNER_OPTIONS);
    if (!prefill) return;
    if (prefill.transport) {
      this._transport = prefill.transport;
      this._transportChosen = true;
    }
    if (prefill.flowType) {
      this._assignFlowType(prefill.flowType);
      if (prefill.ticketId) this._ticketId = prefill.ticketId;
    }
    if (prefill.reviewMachine) this._reviewMachine = prefill.reviewMachine;
    if (prefill.qaProfileId) this._qaProfileId = prefill.qaProfileId;
    if (prefill.qaInputs !== undefined) this._qaInputsText = prefill.qaInputs;
    this._legacyReviewPlacementError = prefill.configurationError ?? '';
    if (prefill.publicationReviewLoops.length > 0) {
      this._publicationReviewLoops = prefill.publicationReviewLoops;
      this._nextPublicationReviewLoopId = prefill.publicationReviewLoops.length + 1;
    }
    if (prefill.startRefRedirectHash) {
      this._error =
        'Direct startRef dispatch moved to #evals so replay creates Reference/Candidate packages instead of a plain run.';
      history.replaceState(null, '', prefill.startRefRedirectHash);
    }
    if (prefill.comparison) {
      this._comparisonFlow = Boolean(prefill.comparison.parentRunId);
      this._comparisonLane = true;
      this._comparisonFamilyId = prefill.comparison.familyId;
      this._comparisonVariant = prefill.comparison.variant;
      this._comparisonParentRunId = prefill.comparison.parentRunId;
      const runner = prefill.comparison.runner;
      const model = prefill.comparison.model;
      this._comparisonHashPinnedEngine = Boolean(runner && COMPARISON_LANE_RUNNERS.has(runner));
      if (runner && COMPARISON_LANE_RUNNERS.has(runner)) {
        this._runner = runner;
        this._model = model || DEFAULT_MODEL[runner];
      }
      if (this._comparisonHashPinnedEngine) {
        this._comparisonParentEngineHydrated = true;
      }
      this._recomputeVariantCollision();
      this._checkActiveRunConflict();
      this._tryHydrateComparisonParentEngine(getState().runs ?? []);
    }
    if (prefill.comparisonIntent) {
      this._comparisonFlow = true;
      this._checkActiveRunConflict();
      void this._openComparisonPicker();
    }
    if (prefill.project) {
      this._project = prefill.project;
      this._restoreTemplatePreference();
      if (prefill.slot) {
        this._slotOverride = prefill.slot;
        this._slotOverrideExplicit = true;
      }
      void this._fetchCandidates();
      void this._fetchTemplateOptions();
      this._syncSelectedAppForProject(prefill.project);
    }
  }

  private _syncPublicationReviewsToHash(): void {
    const nextHash = syncPublicationReviewsHash(location.hash, this._publicationReviewLoops);
    if (nextHash && location.hash !== nextHash) history.replaceState(null, '', nextHash);
  }

  /** Backend pressure decision for the currently selected candidate row. */
  private _selectedPressureDecision() {
    return selectedCandidate(this._candidates, this._slotOverride)?.pressureAdmission ?? null;
  }

  private _pressureOverrideReady(): boolean {
    return this._pressureOverrideConfirmed && this._pressureOverrideReason.trim().length > 0;
  }

  /** Any change of slot or evidence invalidates a half-completed override. */
  private _resetPressureOverrideDraft(): void {
    this._pressureOverrideConfirmed = false;
    this._pressureOverrideReason = '';
  }

  private _beginPressureOverride(slotId: string, intent?: 'nudge' | 'fresh'): void {
    this._closeExecutionTemplatePreview(false);
    this._slotOverride = slotId;
    this._slotOverrideExplicit = true;
    this._resetPressureOverrideDraft();
    // A rejected busy nudge candidate keeps its explicit reuse intent through
    // the override flow. The created run carries nudgeReuse/freshReuse, never
    // an invalid busy-slot plain dispatch.
    if (intent) {
      this._nudgeIntents.set(slotId, intent);
      this._nudgeIntentVersion++;
    }
    this._applyVisibleCatalog();
  }

  private _setNudgeIntent(slotId: string, intent: 'nudge' | 'fresh'): void {
    // Defensive: the click handler closes over the candidate list at render time, but
    // `_fetchCandidates` can replace the array (machine filter flip, WS reconnect) before
    // the click fires. A non-null assertion would crash with "Cannot read properties of
    // undefined" — guard with a lookup + nullish check that mirrors `_selectedCandidate`.
    const candidate = this._candidates.find((c) => c.slotId === slotId);
    if (!candidate || !candidateDispatchable(candidate)) return;
    this._nudgeIntents.set(slotId, intent);
    this._nudgeIntentVersion++;
    // Selecting an action implies selecting the row — the operator's click on Nudge/Fresh is
    // also their pick of the slot. Without this, the intent flips on a row that's not the
    // active one and the next Dispatch click ignores it.
    this._slotOverride = slotId;
    this._slotOverrideExplicit = true;
    this._applyVisibleCatalog();
  }

  private _blockingState() {
    const state = getState();
    const base = deriveDispatchWizardBlockingState({
      flowType: this._flowType,
      ticketId: this._ticketId,
      project: this._project,
      matchingProject: this._matchingProject,
      slotOverride: this._slotOverride,
      candidates: this._candidates,
      machineFilters: state.globalFilters.machines,
      fleetSlots: state.fleet?.slots ?? [],
      dispatching: this._dispatching,
      connectionStale: this._connectionStale,
      hydrating: this._hydrating,
      bootstrapFailed: this._bootstrapFailed,
      loadingCandidates: this._loadingCandidates,
      candidateRefreshFailed: this._candidateRefreshFailed,
      activeRunConflict: !!this._activeRunConflict && !this._comparisonFlow,
      variantInputBlocked: this._variantInputBlocked(),
      comparisonFlow: this._comparisonFlow,
      comparisonParentRunId: this._comparisonParentRunId,
      pressureOverrideReady: this._pressureOverrideReady(),
    });
    const workflowReason = this._workflowSelectionError();
    if (this._flowType === 'review-pr') {
      return {
        ...base,
        allowedSlots: undefined,
        dispatchBlockedReason: workflowReason ?? base.dispatchBlockedReason,
        queueBlockedReason: workflowReason ?? base.queueBlockedReason,
        dispatchBlocked: base.dispatchBlocked || !!workflowReason,
        queueBlocked: base.queueBlocked || !!workflowReason,
      };
    }
    const catalogView =
      this._executionTemplates && this._flowType
        ? deriveExecutionTemplatePickerView(
            this._executionTemplates,
            this._selectedExecutionTemplateId,
            {
              domain: this._domain,
              runMode: this._catalogMode,
              flow: this._flowType,
              ...(this._selectedSlotPlatform() ? { platform: this._selectedSlotPlatform() } : {}),
            },
          )
        : null;
    const templateReason =
      workflowReason ??
      (this._templateOptionsError
        ? 'Execution-template options are unavailable.'
        : this._templateOptionsLoading
          ? 'Loading execution-template options.'
          : catalogView && !this._selectedExecutionTemplateId
            ? catalogView.rows.length === 0
              ? 'No compatible execution template is available.'
              : 'Select one exact execution template.'
            : null);
    const profileContext = {
      runner: this._runner,
      slotId: this._slotOverride,
      project: this._project,
      refreshVersion: this._nativeProfileRefreshVersion,
    };
    const profileReason =
      this._transport === 'native'
        ? nativeDispatchProfileReason({
            ...profileContext,
            selection: this._nativeProfileSelection,
            catalog: this._nativeCatalog,
            catalogReady: this._nativeCatalogReady,
          })
        : null;
    const node =
      this._transport === 'native' ? this._nativeProfileSelection?.executionNodeId : undefined;
    const allowedSlots = node
      ? nativeDispatchNodeSlots(this._nativeCatalog, node, this._project).filter(
          (slot) => !base.allowedSlots || base.allowedSlots.includes(slot),
        )
      : base.allowedSlots;
    const nodeReason =
      node && !allowedSlots?.length
        ? 'No eligible slots match the selected node and machine filters.'
        : null;
    const transportReason =
      profileReason ??
      nodeReason ??
      (this._transport === 'native' && !this._nativeWorkerRunners.includes(this._runner)
        ? 'The selected runner does not support native worker dispatch.'
        : null);
    const queueTemplateReason =
      transportReason ??
      (this._transport === 'native' && !this._nativeQueueRunners.includes(this._runner)
        ? 'Native worker queueing is unavailable on this gateway.'
        : null) ??
      templateReason ??
      (selectedNudgeIntent({
        candidates: this._candidates,
        slotOverride: this._slotOverride,
        intents: this._nudgeIntents,
      })
        ? 'The selected worker action must dispatch now; it cannot be queued against changing slot state.'
        : null) ??
      (this._executionTemplates && !this._slotOverride
        ? 'Select a slot before queuing a configured execution template.'
        : null);
    return {
      ...base,
      allowedSlots,
      dispatchBlockedReason: transportReason ?? templateReason ?? base.dispatchBlockedReason,
      dispatchBlocked: base.dispatchBlocked || templateReason !== null || transportReason !== null,
      queueBlockedReason: queueTemplateReason ?? base.queueBlockedReason,
      queueBlocked: base.queueBlocked || queueTemplateReason !== null,
    };
  }

  private _dispatchPayloadDraft() {
    const mode =
      this._flowType === 'review-pr' || this._flowType === 'qa'
        ? 'autonomous'
        : this._executionTemplates
          ? this._catalogMode
          : selectedTemplateMode(
              this._flowType,
              this._templateOptions,
              this._selectedTaskTemplateFileName,
            );
    const taskTemplate = this._executionTemplates
      ? undefined
      : selectedTaskTemplate(this._templateOptions, this._selectedTaskTemplateFileName);
    // Forward the backend-rendered decision identity: a confirmed override for
    // a rejected machine, or the admitted decision's preview identity so
    // execution can reject stale evidence. Values come from the gateway
    // decision verbatim. The wizard computes nothing.
    const selectedPressure = this._selectedPressureDecision();
    const pressureOverride =
      selectedPressure?.outcome === 'rejected' &&
      selectedPressure.overridable &&
      selectedPressure.evidence.generation &&
      this._pressureOverrideReady()
        ? {
            machine: selectedPressure.machine,
            pressureGeneration: selectedPressure.evidence.generation,
            reason: this._pressureOverrideReason.trim(),
          }
        : undefined;
    const pressureAdmissionRef =
      !pressureOverride &&
      selectedPressure?.outcome === 'admitted' &&
      selectedPressure.evidence.generation
        ? {
            machine: selectedPressure.machine,
            pressureGeneration: selectedPressure.evidence.generation,
          }
        : undefined;
    return buildDispatchWizardPayloadDraft({
      transport: this._flowType === 'review-pr' ? 'native' : this._transport,
      nativeProfile:
        this._transport === 'native' && this._flowType !== 'review-pr'
          ? this._nativeProfileSelection?.profile
          : undefined,
      pressureOverride,
      pressureAdmissionRef,
      flowType: this._flowType,
      project: this._project,
      ticketId: this._ticketId,
      reviewMachine: this._flowType === 'review-pr' ? this._workspaceMachine() : undefined,
      ...(this._flowType === 'qa' ? this._qaFields() : {}),
      slotOverride: this._slotOverride,
      allowedSlots: this._blockingState().allowedSlots,
      branch: this._resolveTargetBranch(getState().prs),
      model: this._model,
      runner: this._runner,
      effort: this._effort,
      app: selectedDispatchApp(projectApps(this._projectConfigs, this._project), this._app),
      taskTemplate,
      domain: this._domain || undefined,
      executionTemplateId: this._selectedExecutionTemplateId || undefined,
      skipPrepare: this._skipPrepare,
      prepareProfile: this._prepareProfile,
      nudgeIntent: selectedNudgeIntent({
        candidates: this._candidates,
        slotOverride: this._slotOverride,
        intents: this._nudgeIntents,
      }),
      mode,
      devInteractiveProfile: this._devInteractiveProfile,

      ...buildPublicationReviewGateParams(
        this._flowType,
        this._runner,
        this._publicationReviewLoops,
        RUNNER_OPTIONS,
        mode,
      ),
      comparison: buildComparisonRunParams({
        comparisonLane: this._comparisonLane,
        comparisonFamilyId: this._comparisonFamilyId,
        comparisonParentRunId: this._comparisonParentRunId,
        variant: this._resolveVariantForDispatch(),
      }),
    });
  }

  private async _dispatch() {
    if (this._blockingState().dispatchBlocked) return;
    this._dispatching = true;
    this._error = '';

    try {
      const payloadDraft = this._dispatchPayloadDraft();
      if (!payloadDraft) return;
      const runId = await dispatchRunCreateFromDraft(payloadDraft);
      location.hash = `run/${runId}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Dispatch failed';
      this._error = msg;
    } finally {
      this._dispatching = false;
    }
  }

  private async _addToQueue() {
    if (this._blockingState().queueBlocked) return;
    try {
      const payloadDraft = this._dispatchPayloadDraft();
      if (!payloadDraft) return;
      await addDispatchQueueItemFromDraft(payloadDraft);
      this._ticketId = '';
      this._normalizedTicket = '';
      this._error = '';
    } catch (err: unknown) {
      this._error = err instanceof Error ? err.message : 'Queue add failed';
    }
  }

  private _selectFlowType(flowType: FlowType): void {
    this._legacyReviewPlacementError = '';
    this._assignFlowType(flowType);
    this._autoFlowType = false;
    this._applyVisibleCatalog();
    void this._fetchCandidates({ silent: this._allCandidates.length > 0 });
  }

  private _assignFlowType(flowType: FlowType): void {
    if (this._flowType !== flowType) this._closeExecutionTemplatePreview(false);
    this._flowType = flowType;
    this._catalogMode = modeForFlow(flowType);
    this._restoreTemplatePreference();
    this._syncWorkflowSelection();
  }

  private _syncWorkflowSelection(): void {
    if (this._flowType !== 'review-pr' && this._flowType !== 'qa') {
      this._workflowSelectionKey = '';
      return;
    }
    if (this._flowType === 'review-pr') this._transport = 'native';
    const project = this._projectConfigs.find((entry) => entry.name === this._project);
    if (!project) return;
    const key = `${this._project}|${this._flowType}`;
    if (key === this._workflowSelectionKey) return;
    const changedContext = !!this._workflowSelectionKey;
    this._workflowSelectionKey = key;
    this._catalogMode = 'autonomous';
    if (changedContext) {
      this._qaProfileId = '';
      this._qaInputsText = '';
      this._reviewMachine = '';
    }
    this._nativeProfileSelection = null;
    this._nativeProfileRefreshVersion++;
    const execution = project.workflowDefaults?.[this._flowType]?.execution;
    const model = execution?.models[0];
    if (model && !this._comparisonLane) {
      this._runner = model.runner;
      this._model = model.model;
      this._effort = (model.effort ?? '') as typeof this._effort;
    }
    if (this._flowType === 'qa' && !this._transportChosen)
      this._transport = execution?.transport ?? 'tmux';
    if (changedContext || this._flowType === 'review-pr') {
      this._slotOverride = '';
      this._slotOverrideExplicit = false;
    }
    this._skipPrepare = false;
    this._prepareProfile = '';
  }

  private _qaFields() {
    return qaDispatchFields(
      this._projectConfigs.find((entry) => entry.name === this._project)?.qa,
      this._qaProfileId,
      this._qaInputsText,
    );
  }

  private _workspaceMachine(): string {
    const filters = getState().globalFilters.machines;
    return this._reviewMachine.trim() || (filters.length === 1 ? filters[0] : '');
  }

  private _workflowSelectionError(): string | null {
    if (this._flowType === 'qa') {
      try {
        this._qaFields();
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    }
    if (this._flowType !== 'review-pr') return null;
    if (this._legacyReviewPlacementError) return this._legacyReviewPlacementError;
    const filters = getState().globalFilters.machines;
    const machine = this._workspaceMachine();
    if (filters.length > 1 && !machine)
      return 'Choose a review machine from the active machine filter.';
    if (filters.length && machine && !filters.includes(machine))
      return 'Review machine is outside the active machine filter.';
    return null;
  }

  private _renderWorkflowControls() {
    if (this._flowType === 'review-pr')
      return html`<div class="config-group">
        <label class="section-label" for="review-machine">Review machine</label>
        <input
          id="review-machine"
          data-testid="dispatch-review-machine"
          class="ticket-input"
          placeholder="Farm default"
          .value=${this._reviewMachine}
          @input=${(event: InputEvent) => {
            this._reviewMachine = (event.target as HTMLInputElement).value;
            this._legacyReviewPlacementError = '';
          }}
        />
        <p class="section-help">
          Static source review in a managed workspace. No app slot or preparation is used. Leave the
          machine empty to inherit farm defaults. Active machine filters still apply.
        </p>
        ${this._workflowSelectionError()
          ? html`<p class="section-help" role="alert">${this._workflowSelectionError()}</p>`
          : nothing}
      </div>`;
    if (this._flowType !== 'qa') return nothing;
    const config = this._projectConfigs.find((entry) => entry.name === this._project)?.qa;
    const selectedId = this._qaProfileId || config?.default_profile || '';
    const selected = config?.profiles.find((profile) => profile.id === selectedId);
    const error = this._workflowSelectionError();
    return html`<div class="config-group" data-testid="dispatch-qa-profile-controls">
      <label class="section-label" for="qa-profile">QA profile</label>
      <select
        id="qa-profile"
        class="ticket-input"
        data-testid="dispatch-qa-profile"
        .value=${selectedId}
        @change=${(event: Event) => {
          this._qaProfileId = (event.target as HTMLSelectElement).value;
          this._qaInputsText = '';
        }}
      >
        ${!config
          ? html`<option value="">No farm QA profiles configured</option>`
          : config.profiles.map(
              (profile) =>
                html`<option value=${profile.id} ?selected=${profile.id === selectedId}>
                  ${profile.title}${profile.id === config.default_profile ? ' (farm default)' : ''}
                </option>`,
            )}
      </select>
      ${selected?.description ? html`<p class="section-help">${selected.description}</p>` : nothing}
      <label class="section-label" for="qa-inputs">Input overrides (JSON)</label>
      <textarea
        id="qa-inputs"
        data-testid="dispatch-qa-inputs"
        class="ticket-input"
        rows="4"
        .value=${this._qaInputsText}
        placeholder=${JSON.stringify(selected?.inputs ?? {}, null, 2)}
        @input=${(event: InputEvent) => {
          this._qaInputsText = (event.target as HTMLTextAreaElement).value;
        }}
      ></textarea>
      <p class="section-help">
        Leave empty to use the profile inputs. The farm's skill selects its validation recipes.
      </p>
      ${error ? html`<p class="section-help" role="alert">${error}</p>` : nothing}
    </div>`;
  }

  private _preferredExecutionTemplateId(): string {
    if (!this._project || !this._flowType) return '';
    return selectedExecutionTemplatePreference(
      loadDispatchTemplatePreference(this._project, this._flowType),
      this._domain,
      this._catalogMode,
    );
  }

  private _restoreTemplatePreference(): void {
    if (!this._project || !this._flowType) {
      this._domain = '';
      this._selectedExecutionTemplateId = '';
      return;
    }
    const preference = loadDispatchTemplatePreference(this._project, this._flowType);
    if (preference) {
      this._domain = preference.domain;
      this._catalogMode = preference.mode;
    } else {
      this._domain = '';
    }
    this._selectedExecutionTemplateId = selectedExecutionTemplatePreference(
      preference,
      this._domain,
      this._catalogMode,
    );
  }

  private _persistTemplatePreference(): void {
    if (!this._project || !this._flowType || !this._executionTemplates) return;
    persistDispatchTemplatePreference({
      project: this._project,
      flowType: this._flowType,
      domain: this._domain,
      mode: this._catalogMode,
      executionTemplateId: this._selectedExecutionTemplateId,
    });
  }

  private _setTransport(transport: 'tmux' | 'native') {
    this._transport = transport;
    if (transport === 'tmux') {
      this._nativeProfileSelection = null;
      this._nativeAutomaticSlot = false;
    }
    this._applyVisibleCandidates();
    this._transportChosen = true;
    this._error = '';
  }

  private _setRunner(runner: string) {
    if (runner === this._runner) return;
    this._runner = runner;
    if (
      this._nativeCatalogReady &&
      this._transport === 'native' &&
      !this._nativeWorkerRunners.includes(runner)
    )
      this._setTransport('tmux');
    this._model = DEFAULT_MODEL[runner] ?? '';
    this._effort = '';
    this._recomputeVariantCollision();
  }

  private _setModel(model: string) {
    if (model === this._model) return;
    this._model = model;
    this._recomputeVariantCollision();
  }

  private _addPublicationReviewLoop(
    runner: ReviewRunnerId = defaultExtraReviewRunner(this._runner, RUNNER_OPTIONS),
  ): void {
    if (this._publicationReviewLoops.length >= 5) return;
    this._publicationReviewLoops = [
      ...this._publicationReviewLoops,
      { id: this._nextPublicationReviewLoopId++, runner },
    ];
    this._syncPublicationReviewsToHash();
  }

  private _removePublicationReviewLoop(id: number): void {
    this._publicationReviewLoops = this._publicationReviewLoops.filter((loop) => loop.id !== id);
    this._syncPublicationReviewsToHash();
  }

  private _setPublicationReviewRunner(id: number, runner: ReviewRunnerId): void {
    this._publicationReviewLoops = this._publicationReviewLoops.map((loop) =>
      loop.id === id ? { ...loop, runner } : loop,
    );
    this._syncPublicationReviewsToHash();
  }

  private _setPublicationReviewDepth(id: number, validationDepth: ReviewValidationDepth): void {
    this._publicationReviewLoops = this._publicationReviewLoops.map((loop) =>
      loop.id === id ? { ...loop, validationDepth } : loop,
    );
    this._syncPublicationReviewsToHash();
  }

  static styles = dispatchWizardStyles;

  render() {
    const blockers = this._blockingState();
    const mode =
      this._flowType === 'review-pr' || this._flowType === 'qa'
        ? 'autonomous'
        : this._executionTemplates
          ? this._catalogMode
          : selectedTemplateMode(
              this._flowType,
              this._templateOptions,
              this._selectedTaskTemplateFileName,
            );
    const view = renderDispatchWizardView({
      transport: this._transport,
      nativeWorkerAvailable: this._nativeWorkerRunners.includes(this._runner),
      nativeCatalogError: this._nativeCatalogError,
      nativeProfileControl: keyed(
        this._nativeProfileScope,
        html`<dispatch-native-profiles
          .catalog=${this._nativeCatalog}
          .runner=${this._runner}
          .slotId=${this._slotOverride}
          .project=${this._project}
          .refreshVersion=${this._nativeProfileRefreshVersion}
          .disabled=${this._dispatching || this._connectionStale || !this._nativeCatalogReady}
          @dispatch-native-profile-change=${(
            event: CustomEvent<DispatchNativeProfileSelection>,
          ) => {
            if (
              event.detail.key !==
              dispatchNativeProfileKey({
                runner: this._runner,
                slotId: this._slotOverride,
                project: this._project,
                refreshVersion: this._nativeProfileRefreshVersion,
              })
            )
              return;
            if (this._transport !== 'native') return;
            const previousNode = this._nativeProfileSelection?.executionNodeId;
            this._nativeProfileSelection = event.detail;
            if (this._nativeAutomaticSlot && previousNode !== event.detail.executionNodeId)
              this._applyVisibleCandidates();
          }}
        ></dispatch-native-profiles>`,
      ),
      setTransport: (transport) => this._setTransport(transport),
      hydrating: this._hydrating,
      bootstrapFailed: this._bootstrapFailed,
      connectionStale: this._connectionStale,
      availableProjects: this._availableProjects,
      ticketId: this._ticketId,
      matchingProject: this._matchingProject,
      issueType: this._issueType,
      autoFlowType: this._autoFlowType,
      flowType: this._flowType,
      autoProject: this._autoProject,
      project: this._project,
      selectedSlotOverride: this._slotOverride,
      allowAutomaticSlot: this._transport === 'native',
      selectedSlotPlatform: this._selectedSlotPlatform() ?? '',
      refreshSlots: () => this._refreshDispatchSnapshot(),
      projectApps: projectApps(this._projectConfigs, this._project),
      selectedDispatchApp: selectedDispatchApp(
        projectApps(this._projectConfigs, this._project),
        this._app,
      ),
      templateOptions: this._templateOptions,
      templateOptionsLoading: this._templateOptionsLoading,
      templateOptionsError: this._templateOptionsError,
      selectedTaskTemplateFileName: this._selectedTaskTemplateFileName,
      executionTemplates: this._executionTemplates,
      selectedExecutionTemplateId: this._selectedExecutionTemplateId,
      domain: this._domain,
      runner: this._runner,
      model: this._model,
      effort: this._effort,
      workflowControls: this._renderWorkflowControls(),
      skipPrepare: this._skipPrepare,
      prepareProfiles: projectPrepareProfiles(this._projectConfigs, this._project),
      prepareProfile: this._prepareProfile,
      profileFitSuggestion: this._profileFitSuggestion,
      mode,
      devInteractiveProfile: this._devInteractiveProfile,
      comparisonLane: this._comparisonLane,
      comparisonFamilyId: this._comparisonFamilyId,
      comparisonParentRunId: this._comparisonParentRunId,
      variantPreview: this._resolveVariantForDispatch(),
      comparisonBranchHint: comparisonBranchHint({
        comparisonLane: this._comparisonLane,
        variant: this._resolveVariantForDispatch(),
        flowType: this._flowType,
        ticketOrPr: this._ticketId,
      }),
      comparisonFlow: this._comparisonFlow,
      comparisonPickerRuns: this._comparisonPickerRuns,
      comparisonPickerLoading: this._comparisonPickerLoading,
      comparePickerOpen: this._comparePickerOpen,
      comparePickerSearch: this._comparePickerSearch,
      variantCollision: this._variantCollision,
      variantInput: this._variantInput,
      publicationReviewsEnabled: publicationReviewsEnabled(this._flowType, mode),
      publicationReviewLoops: this._publicationReviewLoops,
      publicationReviewPlan: buildPublicationReviewPlan(
        this._flowType,
        this._runner,
        this._publicationReviewLoops,
        RUNNER_OPTIONS,
        mode,
      ),
      runnerOptions: RUNNER_OPTIONS,
      loadingCandidates: this._loadingCandidates,
      candidates: this._candidates,
      dispatchableCandidates: dispatchableCandidates(this._candidates),
      nudgeIntents: this._nudgeIntents,
      nudgeIntentVersion: this._nudgeIntentVersion,
      sameTaskSlot: findSameTaskSlot(this._allProjectSlots, this._ticketId),
      dispatching: this._dispatching,
      activeRunConflict: this._activeRunConflict,
      error: this._error,
      candidateRefreshFailed: this._candidateRefreshFailed,
      queueItems: this._queueItems,
      appLabel: (app) => appLabel(app),
      setTicket: (ticketId) => this._setTicket(ticketId),
      submitTicket: () => this._dispatch(),
      selectFlowType: (flowType) => this._selectFlowType(flowType),
      selectProject: (project) => this._selectProject(project),
      setApp: (app) => {
        this._app = app;
        void this._fetchCandidates({ silent: this._allCandidates.length > 0 });
      },
      setTaskTemplateFileName: (fileName) => {
        this._selectedTaskTemplateFileName = fileName;
      },
      setExecutionTemplateId: (id) => {
        this._selectedExecutionTemplateId = id;
        this._persistTemplatePreference();
      },
      previewExecutionTemplate: (option, trigger) => {
        void this._previewExecutionTemplate(option, trigger);
      },
      setDomain: (domain) => {
        this._closeExecutionTemplatePreview(false);
        this._domain = domain;
        this._selectedExecutionTemplateId = this._preferredExecutionTemplateId();
        this._applyVisibleCatalog();
      },
      setMode: (mode) => {
        this._closeExecutionTemplatePreview(false);
        this._catalogMode = mode;
        this._selectedExecutionTemplateId = this._preferredExecutionTemplateId();
        this._applyVisibleCatalog();
      },
      setRunner: (runner) => this._setRunner(runner),
      setModel: (model) => this._setModel(model),
      setEffort: (effort) => {
        this._effort = effort;
      },
      setSkipPrepare: (skipPrepare) => {
        this._skipPrepare = skipPrepare;
      },
      setPrepareProfile: (prepareProfile) => {
        this._prepareProfile = prepareProfile;
        this._profileFitSuggestion = null;
        void this._fetchCandidates({ silent: this._allCandidates.length > 0 });
      },
      applySuggestedPrepareProfile: (prepareProfile) => {
        this._prepareProfile = prepareProfile;
        this._profileFitSuggestion = null;
        void this._fetchCandidates({ silent: this._allCandidates.length > 0 });
      },
      setDevInteractiveProfile: (profile) => {
        this._devInteractiveProfile = profile;
      },
      openEvals: () => {
        location.hash = 'evals';
      },
      enterComparisonFlow: () => this._enterComparisonFlow(),
      enterNormalFlow: () => this._enterNormalFlow(),
      openComparisonPicker: () => {
        void this._openComparisonPicker();
      },
      onSelectBaselineRun: (run) => this._applyComparisonBaseline(run),
      setComparePickerOpen: (open) => {
        this._comparePickerOpen = open;
      },
      setComparePickerSearch: (search) => {
        this._comparePickerSearch = search;
      },
      exitComparisonMode: () => this._exitComparisonMode(),
      setVariantInput: (variantInput) => {
        this._variantInput = variantInput;
      },
      setPublicationReviewRunner: (id, runner) => this._setPublicationReviewRunner(id, runner),
      setPublicationReviewDepth: (id, validationDepth) =>
        this._setPublicationReviewDepth(id, validationDepth),
      removePublicationReviewLoop: (id) => this._removePublicationReviewLoop(id),
      addWorkerReviewLoop: () =>
        this._addPublicationReviewLoop(
          (RUNNER_OPTIONS.includes(this._runner as ReviewRunnerId)
            ? this._runner
            : 'claude') as ReviewRunnerId,
        ),
      addExternalReviewLoop: () => this._addPublicationReviewLoop(),
      candidateDispatchable,
      slotSummaryLabel: (slotId) =>
        slotSummaryLabel({ slotId, slots: this._allProjectSlots, runs: getState().runs ?? [] }),
      selectSlot: (slotId) => {
        this._nativeAutomaticSlot = !slotId;
        this._closeExecutionTemplatePreview(false);
        if (this._slotOverride !== slotId) this._resetPressureOverrideDraft();
        this._slotOverride = slotId;
        this._slotOverrideExplicit = Boolean(slotId);
        this._applyVisibleCandidates();
        this._applyVisibleCatalog();
      },
      setNudgeIntent: (slotId, intent) => this._setNudgeIntent(slotId, intent),
      pressureOverrideAvailable,
      beginPressureOverride: (slotId, intent) => this._beginPressureOverride(slotId, intent),
      selectedPressureDecision: this._selectedPressureDecision(),
      pressureOverrideConfirmed: this._pressureOverrideConfirmed,
      pressureOverrideReason: this._pressureOverrideReason,
      setPressureOverrideConfirmed: (confirmed) => {
        this._pressureOverrideConfirmed = confirmed;
      },
      setPressureOverrideReason: (reason) => {
        this._pressureOverrideReason = reason;
      },
      refreshPressureDecision: () => {
        void this._fetchCandidates({ silent: this._allCandidates.length > 0 });
      },
      dispatchBlocked: () => blockers.dispatchBlocked,
      dispatchBlockedReason: () => blockers.dispatchBlockedReason,
      queueBlocked: () => blockers.queueBlocked,
      queueBlockedReason: () => blockers.queueBlockedReason,
      canDispatch: () => blockers.canDispatch,
      validationHint: () => blockers.validationHint,
      dispatch: () => this._dispatch(),
      addToQueue: () => this._addToQueue(),
      cancelConflictingRun: () => this._cancelConflictingRun(),
    });
    return html`
      ${view}
      <execution-template-preview-modal
        .open=${this._executionTemplatePreviewOption !== null}
        .option=${this._executionTemplatePreviewOption}
        .preview=${this._executionTemplatePreview}
        .loading=${this._executionTemplatePreviewLoading}
        .error=${this._executionTemplatePreviewError}
        @preview-close=${() => this._closeExecutionTemplatePreview()}
        @preview-refresh=${() => void this._refreshExecutionTemplatePreview()}
      ></execution-template-preview-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dispatch-wizard': DispatchWizard;
  }
}
