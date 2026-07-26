import { customElement } from 'lit/decorators.js';

import type {
  DispatchCandidatesResult,
  FlowType,
  PRStatus,
  ReviewRunnerId,
  ReviewValidationDepth,
  Run,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, isHydrating, subscribe } from '../../state.js';
import {
  COMPARISON_LANE_RUNNERS,
  DEFAULT_MODEL,
  RUNNER_OPTIONS,
} from '../../utils/runner-options.js';

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
  requestProjectConfigs,
  requestTemplateOptions,
} from './dispatch-wizard-loaders.js';
import {
  parseDispatchWizardHash,
  shouldUsePrefillSlot,
  syncPublicationReviewsHash,
} from './dispatch-wizard-prefill.js';
import {
  candidateDispatchable,
  dispatchableCandidates,
  findSameTaskSlot,
  resolveTargetBranch,
  selectedNudgeIntent,
  slotSummaryLabel,
} from './dispatch-wizard-selectors.js';
import { DispatchWizardState } from './dispatch-wizard-state.js';
import {
  deriveCandidateResultState,
  deriveDispatchFleetViewState,
  deriveIssueTypeFlowState,
  findActiveRunConflict,
} from './dispatch-wizard-state-model.js';
import { dispatchWizardStyles } from './dispatch-wizard-styles.js';
import {
  clearTemplateOptionsState,
  deriveTemplateOptionsState,
  templateOptionsRequestKey,
} from './dispatch-wizard-template-options.js';
import { renderDispatchWizardView } from './dispatch-wizard-view-renderer.js';

@customElement('dispatch-wizard')
export class DispatchWizard extends DispatchWizardState {
  updated(changed: Map<string, unknown>) {
    super.updated(changed);
    if (this.mockMode && changed.has('mockInitial')) {
      this._applyMockInitial();
      this._syncFleet(getState());
    }
    if (this.mockMode && changed.has('mockProjectConfigs') && this.mockProjectConfigs) {
      this._projectConfigs = this.mockProjectConfigs;
      this._syncSelectedAppForProject(this._project);
    }
    if (this.mockMode && changed.has('mockCandidates') && this._project) {
      void this._fetchCandidates(this._project);
      void this._fetchTemplateOptions();
    }
    // Any change that might flip `_resolveTargetBranch`'s output must re-score
    // candidates — otherwise the wizard keeps the stale ranking (and the
    // pinned _slotOverride) until some unrelated state change triggers
    // _syncFleet's re-fetch path. Covers:
    //   - flow flip (pr-complete ↔ fix-bug, etc.) — targetBranch toggles on/off
    //   - ticket edit — PR number change swaps the target branch
    //   - normalized ticket landing — `123` → `owner/repo#123` resolves a new PR
    const tickers = ['_flowType', '_ticketId', '_normalizedTicket'];
    if (tickers.some((k) => changed.has(k)) && this._project) {
      void this._fetchCandidates(this._project);
    }
    if ((changed.has('_flowType') || changed.has('_project')) && this._project && this._flowType) {
      void this._fetchTemplateOptions();
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
    if (this.mockMode && this.mockProjectConfigs) {
      this._projectConfigs = this.mockProjectConfigs;
      this._syncSelectedAppForProject(this._project);
    } else {
      void this._loadProjectConfigs();
    }
    this._unsubConn = gateway.onConnectionChange((st) => {
      if (this.mockMode) return;
      if (st === 'connected') {
        if (this._projectConfigs.length === 0) {
          void this._loadProjectConfigs();
        }
        if (this._project && this._flowType) {
          void this._fetchTemplateOptions();
        }
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
  }

  private _syncFleet(s: AppState) {
    const wasHydrating = this._hydrating;
    this._hydrating = this.mockMode ? false : isHydrating(s, 'fleet');
    this._bootstrapFailed = this.mockMode ? false : s.bootstrapFailed.fleet;
    this._connectionStale = this.mockMode ? false : s.connection !== 'connected';
    const { projects: fp, machines: fm } = s.globalFilters;
    const fleetView = deriveDispatchFleetViewState({
      slots: s.fleet?.slots ?? [],
      currentProject: this._project,
      globalProjectFilters: fp,
      globalMachineFilters: fm,
    });
    this._availableProjects = fleetView.availableProjects;

    // Auto-select project if exactly 1 available (from filter or fleet)
    if (fleetView.projectAutoSelected) {
      this._project = fleetView.project;
      this._slotOverride = '';
      this._syncSelectedAppForProject(this._project);
      void this._fetchCandidates(this._project);
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
    }

    this._allProjectSlots = fleetView.allProjectSlots;
    this._queueItems = s.queueItems ?? [];

    const machineSig = fleetView.machineFilterSignature;
    const hydrationJustFinished = wasHydrating && !this._hydrating && !this._bootstrapFailed;
    const machineFilterChanged = machineSig !== this._lastFetchMachines;
    const targetBranchNow = this._resolveTargetBranch(s.prs);
    const targetBranchChanged = targetBranchNow !== this._lastFetchTargetBranch;
    if (this._project && (hydrationJustFinished || machineFilterChanged || targetBranchChanged)) {
      void this._fetchCandidates(this._project);
    }

    const comparisonFilterKey = `${[...fp].sort().join(',')}|${machineSig}`;
    if (this._comparePickerOpen && comparisonFilterKey !== this._comparisonPickerFilterKey) {
      void this._loadComparisonPickerRuns();
    }

    this._tryHydrateComparisonParentEngine(s.runs ?? []);
  }

  private _tryHydrateComparisonParentEngine(runs: readonly Run[]): void {
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
      return;
    }
    if (this._loadingProjectConfigs) return;
    this._loadingProjectConfigs = true;
    try {
      this._projectConfigs = await requestProjectConfigs();
      this._syncSelectedAppForProject(this._project);
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

  private async _fetchTemplateOptions(): Promise<void> {
    if (!this._project || !this._flowType || this.mockMode) {
      const cleared = clearTemplateOptionsState();
      this._templateOptions = cleared.options;
      this._templateOptionsError = cleared.error;
      this._selectedTaskTemplateFileName = cleared.selectedFileName;
      this._executionTemplates = null;
      this._selectedExecutionTemplateId = '';
      return;
    }
    const platform = this._allProjectSlots.find(
      (slot) => slot.slot === this._slotOverride,
    )?.platform;
    const filters = {
      ...(platform ? { platform } : {}),
      runMode: this._catalogMode,
      ...(this._domain ? { domain: this._domain } : {}),
    };
    const key = templateOptionsRequestKey(this._project, this._flowType, filters);
    this._templateOptionsKey = key;
    this._templateOptionsLoading = true;
    this._templateOptionsError = '';
    try {
      const result = await requestTemplateOptions(this._project, this._flowType, filters);
      if (this._templateOptionsKey !== key) return;
      const options = result.options;
      const previousSelectionStillValid = options.some(
        (option) => option.fileName === this._selectedTaskTemplateFileName,
      );
      const next = deriveTemplateOptionsState(options, this._selectedTaskTemplateFileName);
      if (
        !result.executionTemplates &&
        !previousSelectionStillValid &&
        this._flowType &&
        modeForFlow(this._flowType) === 'interactive'
      ) {
        next.selectedFileName =
          interactiveTemplateOption(next.options)?.fileName ?? next.selectedFileName;
      }
      this._templateOptions = next.options;
      this._templateOptionsError = next.error;
      this._selectedTaskTemplateFileName = next.selectedFileName;
      this._executionTemplates = result.executionTemplates ?? null;
      if (result.executionTemplates) {
        const selectedStillValid = result.executionTemplates.options.some(
          (option) => option.id === this._selectedExecutionTemplateId,
        );
        this._selectedExecutionTemplateId = selectedStillValid
          ? this._selectedExecutionTemplateId
          : (result.executionTemplates.selectedId ??
            (result.executionTemplates.options.length === 1
              ? result.executionTemplates.options[0]!.id
              : ''));
      } else {
        this._selectedExecutionTemplateId = '';
        this._domain = '';
      }
    } catch (err: unknown) {
      if (this._templateOptionsKey !== key) return;
      this._templateOptions = [];
      this._templateOptionsError =
        err instanceof Error ? err.message : 'Template options failed to load';
      this._selectedTaskTemplateFileName = '';
      this._executionTemplates = null;
      this._selectedExecutionTemplateId = '';
    } finally {
      if (this._templateOptionsKey === key) this._templateOptionsLoading = false;
    }
  }
  private _selectProject(project: string, autoProject = ''): void {
    this._project = project;
    this._autoProject = autoProject;
    this._slotOverride = '';
    this._domain = '';
    this._selectedExecutionTemplateId = '';
    this._executionTemplates = null;
    this._prepareProfile = '';
    this._syncSelectedAppForProject(project);
    this._syncFleet(getState());
    void this._fetchCandidates(project);
    void this._fetchTemplateOptions();
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
      this._syncSelectedAppForProject(this._project);
      void this._fetchCandidates(this._project);
    }
  }

  private _setTicket(ticketId: string): void {
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

  private async _fetchCandidates(project: string): Promise<void> {
    if (!project) {
      this._candidates = [];
      this._slotOverride = '';
      this._lastFetchMachines = '';
      this._fetchGen++;
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
    this._loadingCandidates = true;
    this._candidateRefreshFailed = false;
    const prevOverride = this._slotOverride;
    try {
      const res = await requestDispatchWizardCandidates({
        project,
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
        mockMode: this.mockMode,
        mockCandidates: this.mockCandidates,
      });
      if (!this.mockMode) this._candidatesEverLoaded = true;
      if (gen !== this._fetchGen) return; // superseded by newer filter/project change
      this._applyCandidateResult(res, prevOverride);
      void this._fetchProfileFitSuggestion(project, gen);
    } catch (err) {
      if (gen !== this._fetchGen) return;
      console.warn('[dispatch-wizard] dispatch.candidates failed:', err);
      this._candidates = [];
      this._slotOverride = '';
      this._candidateRefreshFailed = true;
    } finally {
      if (gen === this._fetchGen) this._loadingCandidates = false;
    }
  }

  private async _fetchProfileFitSuggestion(project: string, gen: number): Promise<void> {
    if (
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
    this._slotOverride = next.slotOverride;
    if (next.slotOverride !== prevOverride) void this._fetchTemplateOptions();
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
    this._assignFlowType(run.flowType);
    this._autoFlowType = false;
    this._autoProject = '';
    if (run.project) {
      this._selectProject(run.project);
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
      await gateway.request(Methods.RUN_CANCEL, { runId: this._activeRunConflict.id });
      this._activeRunConflict = null;
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
    if (prefill.flowType) {
      this._assignFlowType(prefill.flowType);
      if (prefill.ticketId) this._ticketId = prefill.ticketId;
    }
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
      const machinesActive = getState().globalFilters.machines;
      if (shouldUsePrefillSlot(prefill.slot, machinesActive)) {
        this._slotOverride = prefill.slot ?? '';
      }
      void this._fetchCandidates(prefill.project);
      this._syncSelectedAppForProject(prefill.project);
    }
  }

  private _syncPublicationReviewsToHash(): void {
    const nextHash = syncPublicationReviewsHash(location.hash, this._publicationReviewLoops);
    if (nextHash && location.hash !== nextHash) history.replaceState(null, '', nextHash);
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
    void this._fetchTemplateOptions();
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
    });
    const templateReason = this._templateOptionsError
      ? 'Execution-template options are unavailable.'
      : this._templateOptionsLoading
        ? 'Loading execution-template options.'
        : this._executionTemplates && !this._selectedExecutionTemplateId
          ? this._executionTemplates.options.length === 0
            ? 'No compatible execution template is available.'
            : 'Select one exact execution template.'
          : null;
    const queueTemplateReason =
      templateReason ??
      (this._executionTemplates && !this._slotOverride
        ? 'Select a slot before queuing a configured execution template.'
        : null);
    return {
      ...base,
      dispatchBlockedReason: templateReason ?? base.dispatchBlockedReason,
      dispatchBlocked: base.dispatchBlocked || templateReason !== null,
      queueBlockedReason: queueTemplateReason ?? base.queueBlockedReason,
      queueBlocked: base.queueBlocked || queueTemplateReason !== null,
    };
  }

  private _dispatchPayloadDraft() {
    const mode = this._executionTemplates
      ? this._catalogMode
      : selectedTemplateMode(
          this._flowType,
          this._templateOptions,
          this._selectedTaskTemplateFileName,
        );
    const taskTemplate = this._executionTemplates
      ? undefined
      : selectedTaskTemplate(this._templateOptions, this._selectedTaskTemplateFileName);
    return buildDispatchWizardPayloadDraft({
      flowType: this._flowType,
      project: this._project,
      ticketId: this._ticketId,
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
      reviewTier: this._reviewTier,
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
    this._assignFlowType(flowType);
    this._selectedExecutionTemplateId = '';
    this._executionTemplates = null;
    this._autoFlowType = false;
    void this._fetchTemplateOptions();
  }

  private _assignFlowType(flowType: FlowType): void {
    this._flowType = flowType;
    this._catalogMode = modeForFlow(flowType);
  }

  private _setRunner(runner: string) {
    if (runner === this._runner) return;
    this._runner = runner;
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
    const mode = this._executionTemplates
      ? this._catalogMode
      : selectedTemplateMode(
          this._flowType,
          this._templateOptions,
          this._selectedTaskTemplateFileName,
        );
    return renderDispatchWizardView({
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
      reviewTier: this._reviewTier,
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
        // App drives companion-resource eligibility on candidate rows.
        void this._fetchCandidates(this._project);
      },
      setTaskTemplateFileName: (fileName) => {
        this._selectedTaskTemplateFileName = fileName;
      },
      setExecutionTemplateId: (id) => {
        this._selectedExecutionTemplateId = id;
      },
      setDomain: (domain) => {
        this._domain = domain;
        this._selectedExecutionTemplateId = '';
        void this._fetchTemplateOptions();
      },
      setMode: (mode) => {
        this._catalogMode = mode;
        this._selectedExecutionTemplateId = '';
        void this._fetchTemplateOptions();
      },
      setRunner: (runner) => this._setRunner(runner),
      setModel: (model) => this._setModel(model),
      setEffort: (effort) => {
        this._effort = effort;
      },
      setReviewTier: (reviewTier) => {
        this._reviewTier = reviewTier;
      },
      setSkipPrepare: (skipPrepare) => {
        this._skipPrepare = skipPrepare;
      },
      setPrepareProfile: (prepareProfile) => {
        this._prepareProfile = prepareProfile;
        this._profileFitSuggestion = null;
        void this._fetchCandidates(this._project);
      },
      applySuggestedPrepareProfile: (prepareProfile) => {
        this._prepareProfile = prepareProfile;
        this._profileFitSuggestion = null;
        void this._fetchCandidates(this._project);
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
        this._slotOverride = slotId;
        void this._fetchTemplateOptions();
      },
      setNudgeIntent: (slotId, intent) => this._setNudgeIntent(slotId, intent),
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
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dispatch-wizard': DispatchWizard;
  }
}
