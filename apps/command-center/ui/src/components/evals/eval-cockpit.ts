import { customElement } from 'lit/decorators.js';

import type {
  EvalSuiteCapGetResult,
  EvalSuiteCapUpdateResult,
  EvalTaskProfile,
  EvalTrialResultGetResult,
  QueueItem,
  ResultPackageManifest,
  Run,
  WorkerTemplateOption,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import '../queue/dispatch-queue-panel.js';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, subscribe } from '../../state.js';

import { renderEvalCockpitCandidateMatrix } from './eval-cockpit-candidate-renderer.js';
import { renderEvalCockpitCaseBrowser } from './eval-cockpit-case-renderer.js';
import {
  evalCatalogProjectOptions,
  evalCatalogStatusOptions,
} from './eval-cockpit-catalog-options.js';
import { launchEvalCockpitLocalSuite } from './eval-cockpit-launcher.js';
import { renderEvalCockpitManualEntry } from './eval-cockpit-manual-renderer.js';
import {
  activeEvalRunCount,
  applyCandidateRunner,
  candidateLabel,
  candidateModelOptions,
  type CandidateTemplateChoice,
  candidateTemplateChoices,
  candidateTemplateForTaskProfile,
  candidateTemplateSummary,
  candidateVariant,
  capGroupIdForDataset,
  datasetIdForSelectedCases,
  defaultRows,
  enabledCandidateRows,
  generatedCandidateLabel,
  manualEvalProjectOptions,
  manualEvalProjectValue,
  type PackageRow,
  packageRowsForEvalCockpit,
  queuedEvalItemsForCapGroup,
  templateName,
} from './eval-cockpit-model.js';
import { renderEvalCockpitOperationalSummary } from './eval-cockpit-operational-renderer.js';
import { renderEvalCockpitPackageMatrix } from './eval-cockpit-package-renderer.js';
import {
  renderEvalPreviewLinks,
  renderEvalPreviewStats,
  renderProductModelGuide,
} from './eval-cockpit-render-helpers.js';
import { renderEvalCockpitShell } from './eval-cockpit-shell-renderer.js';
import { EvalCockpitState } from './eval-cockpit-state.js';
import { evalCockpitStyles } from './eval-cockpit-styles.js';
import {
  applyEvalPackageToLaunchCells,
  syncEvalSuiteCellsFromRuns,
} from './eval-cockpit-suite-sync-model.js';
import { type CandidateRow } from './eval-cockpit-url-state.js';
import {
  evalCockpitUrlStateChanged,
  restoreEvalCockpitUrlViewState,
  writeEvalCockpitUrlViewState,
} from './eval-cockpit-url-sync.js';
import {
  addCasesToBasket,
  buildCaseCatalog,
  catalogItemFromManual,
  type EvalCaseCatalogItem,
  type EvalCaseSortKey,
  type EvalSelectedCase,
  filterCaseCatalog,
  findCatalogItemForPrRef,
  selectedCaseFromCatalog,
  sortCaseCatalog,
  updateSelectedCase,
} from './eval-suite-helpers.js';
import { type EvalLaunchCell, patchCell } from './eval-suite-launch-model.js';

@customElement('eval-cockpit')
export class EvalCockpit extends EvalCockpitState {
  connectedCallback(): void {
    super.connectedCallback();
    this._restoreUrlState();
    window.addEventListener('hashchange', this._onHashChange);
    this._syncState(getState());
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this._onHashChange);
    this._unsub?.();
  }

  protected firstUpdated(): void {
    this._unsub = subscribe((state) => this._syncState(state));
    this._seedInitialCases();
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has('evalResultOverride') || changed.has('appendResultsOverride')) {
      this._evalResult = this.evalResultOverride;
      this._evalResultsByCase = {};
      this._appendResults = this.appendResultsOverride;
    }
    if (changed.has('caseCatalogOverride') || changed.has('initialSelectedCaseIds'))
      this._seedInitialCases();
    if (changed.has('_selectedCases')) {
      this._maybeLoadSlotCapPreview();
      void this._loadCandidateTemplateOptions();
    }
    if (changed.has('_project')) void this._loadCandidateTemplateOptions();
    if (evalCockpitUrlStateChanged(this._urlRestoring, changed)) this._writeUrlState();
  }

  _restoreUrlState(): void {
    const restored = restoreEvalCockpitUrlViewState(this._lastUrlState);
    if (!restored) return;
    this._urlRestoring = true;
    try {
      this._caseQuery = restored.state.caseQuery;
      this._caseKindFilter = restored.state.caseKindFilter;
      this._caseProjectFilter = restored.state.caseProjectFilter;
      this._caseTaskProfileFilter = restored.state.caseTaskProfileFilter;
      this._caseStatusFilter = restored.state.caseStatusFilter;
      this._previewCaseId = restored.state.previewCaseId;
      this._referencePickerOpen = restored.state.referencePickerOpen;
      this._caseSortKey = restored.state.caseSortKey;
      this._caseSortDirection = restored.state.caseSortDirection;
      this._selectedCases = restored.state.selectedCases;
      this._candidateRows = restored.state.candidateRows;
      this._nextCandidateNumber = this._candidateRows.length + 1;
      this._manualEntryOpen = restored.state.manualEntryOpen;
      this._advancedStrategyOpen = restored.state.advancedStrategyOpen;
      this._lastUrlState = restored.encoded;
    } finally {
      this._urlRestoring = false;
    }
  }

  private _writeUrlState(): void {
    this._lastUrlState = writeEvalCockpitUrlViewState(
      {
        caseQuery: this._caseQuery,
        caseKindFilter: this._caseKindFilter,
        caseProjectFilter: this._caseProjectFilter,
        caseTaskProfileFilter: this._caseTaskProfileFilter,
        caseStatusFilter: this._caseStatusFilter,
        previewCaseId: this._previewCaseId,
        referencePickerOpen: this._referencePickerOpen,
        caseSortKey: this._caseSortKey,
        caseSortDirection: this._caseSortDirection,
        selectedCases: this._selectedCases,
        candidateRows: this._candidateRows,
        manualEntryOpen: this._manualEntryOpen,
        advancedStrategyOpen: this._advancedStrategyOpen,
      },
      this._lastUrlState,
    );
  }

  private _syncState(state: AppState): void {
    this._runs = state.runs ?? [];
    this._prs = state.prs ?? [];
    this._queueItems = state.queueItems ?? [];
    this._globalProjectFilters = state.globalFilters.projects ?? [];
    this._syncSuiteCellsFromRuns(this._runs);
    this._maybeLoadSlotCapPreview();
    const firstProject =
      state.runs.find((run) => run.project)?.project ??
      state.prs.find((pr) => pr.project)?.project ??
      state.fleet?.slots.find((slot) => slot.project)?.project;
    if (firstProject && this._project === 'farmslot') this._project = firstProject;
  }

  private _applyEvalPackageToCells(
    run: Run,
    pkg: ResultPackageManifest,
    packagePath: string,
  ): void {
    this._suiteCells = applyEvalPackageToLaunchCells(this._suiteCells, run, pkg, packagePath);
  }

  private _loadEvalPackageForRun(run: Run): void {
    if (this.mock) return;
    const link = run.engineState?.evalExperiment;
    if (!link?.packagePath) return;
    const revision = `${run.id}:${run.updatedAt}:${link.packagePath}`;
    const cached = this._evalPackageSnapshots.get(link.packagePath);
    if (cached?.revision === revision) return;
    if (this._evalPackageLoads.has(revision)) return;
    this._evalPackageLoads.add(revision);
    gateway
      .request<EvalTrialResultGetResult>(Methods.EVAL_TRIAL_RESULT_GET, { runId: run.id }, 30_000)
      .then((result) => {
        this._evalPackageSnapshots.set(result.candidatePackagePath, {
          revision,
          pkg: result.candidatePackage,
          packagePath: result.candidatePackagePath,
        });
        this._applyEvalPackageToCells(
          result.run,
          result.candidatePackage,
          result.candidatePackagePath,
        );
      })
      .catch((error) => {
        this._error = `Failed to load eval package for run ${run.id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`;
      })
      .finally(() => {
        this._evalPackageLoads.delete(revision);
      });
  }

  private _syncSuiteCellsFromRuns(runs: readonly Run[]): void {
    const { cells, packageRunsToLoad } = syncEvalSuiteCellsFromRuns({
      cells: this._suiteCells,
      runs,
      packageSnapshots: this._evalPackageSnapshots,
    });
    this._suiteCells = cells;
    for (const run of packageRunsToLoad) this._loadEvalPackageForRun(run);
  }

  private _catalogItems(): EvalCaseCatalogItem[] {
    const cached = this._catalogCache;
    // AppState replaces runs/prs arrays on update; it does not mutate them in
    // place. Reference equality is therefore the cache invalidation boundary.
    if (
      cached &&
      cached.override === this.caseCatalogOverride &&
      cached.runs === this._runs &&
      cached.prs === this._prs &&
      cached.globalProjects === this._globalProjectFilters
    ) {
      return cached.items;
    }
    const globalProjectSet = new Set(this._globalProjectFilters);
    const items = (
      this.caseCatalogOverride ?? buildCaseCatalog({ prs: this._prs, runs: this._runs })
    ).filter((item) => globalProjectSet.size === 0 || globalProjectSet.has(item.project));
    this._catalogCache = {
      override: this.caseCatalogOverride,
      runs: this._runs,
      prs: this._prs,
      globalProjects: this._globalProjectFilters,
      items,
    };
    return items;
  }

  private _filteredCatalogItems(): EvalCaseCatalogItem[] {
    return sortCaseCatalog(
      filterCaseCatalog(this._catalogItems(), {
        query: this._caseQuery,
        kind: this._caseKindFilter,
        project: this._caseProjectFilter,
        taskProfile: this._caseTaskProfileFilter,
        status: this._caseStatusFilter,
      }),
      this._caseSortKey,
      this._caseSortDirection,
    );
  }

  private _setCaseSort(sortKey: EvalCaseSortKey): void {
    if (this._caseSortKey === sortKey) {
      this._caseSortDirection = this._caseSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this._caseSortKey = sortKey;
      this._caseSortDirection = sortKey === 'date' ? 'desc' : 'asc';
    }
  }

  private _manualProjectValue(): string {
    return manualEvalProjectValue({
      manualProject: this._manualProject,
      currentProject: this._project,
      catalogProjects: evalCatalogProjectOptions(this._catalogItems()),
    });
  }

  private _manualProjectOptions(): string[] {
    return manualEvalProjectOptions({
      manualProjectValue: this._manualProjectValue(),
      currentProject: this._project,
      catalogProjects: evalCatalogProjectOptions(this._catalogItems()),
      selectedProjects: this._selectedCases.map((item) => item.project),
    });
  }

  private _previewCase(): EvalCaseCatalogItem | null {
    const items = this._filteredCatalogItems();
    return items.find((item) => item.id === this._previewCaseId) ?? items[0] ?? null;
  }

  private _catalogItemForSelectedCase(selected: EvalSelectedCase): EvalCaseCatalogItem | null {
    return (
      this._catalogItems().find(
        (item) =>
          item.sourceKey === selected.sourceKey ||
          (selected.runId && item.runId === selected.runId) ||
          (selected.familyId &&
            item.familyId === selected.familyId &&
            item.label === selected.label),
      ) ?? null
    );
  }

  private _seedInitialCases(): void {
    if (!this.initialSelectedCaseIds.length || this._selectedCases.length) return;
    const byId = new Map(this._catalogItems().map((item) => [item.id, item]));
    const selected = this.initialSelectedCaseIds.flatMap((id) => {
      const item = byId.get(id);
      return item ? [selectedCaseFromCatalog(item)] : [];
    });
    if (selected.length) this._selectedCases = selected;
  }

  private _enabledCandidates(): CandidateRow[] {
    return enabledCandidateRows(this._candidateRows);
  }

  private _datasetId(): string {
    return datasetIdForSelectedCases(this._selectedCases, this._project);
  }

  private _capGroupId(datasetId = this._datasetId()): string {
    return capGroupIdForDataset(datasetId);
  }

  private _maybeLoadSlotCapPreview(): void {
    if (
      this.mock ||
      this._suiteCells.length ||
      !this._selectedCases.length ||
      gateway.connectionState !== 'connected'
    )
      return;
    const capGroupId = this._capGroupId();
    if (this._loadedSlotCapGroupId === capGroupId) return;
    if (this._slotCapDirty && this._slotCapDirtyGroupId === capGroupId) return;
    this._loadedSlotCapGroupId = capGroupId;
    gateway
      .request<EvalSuiteCapGetResult>(Methods.EVAL_SUITE_CAP_GET, { capGroupId }, 30_000)
      .then((result) => {
        if (this._capGroupId() !== result.capGroupId) return;
        if (this._slotCapDirty && this._slotCapDirtyGroupId === result.capGroupId) return;
        this._evalSlotCap = result.cap;
      })
      .catch((error) => {
        if (this._loadedSlotCapGroupId === capGroupId) this._loadedSlotCapGroupId = '';
        this._error = `Slot cap preview load failed: ${error instanceof Error ? error.message : String(error)}`;
      });
  }

  private _activeEvalCount(): number {
    const capGroupId = this._suiteCapGroupId || this._capGroupId();
    return activeEvalRunCount(this._runs, capGroupId);
  }

  private _queuedEvalItems(): QueueItem[] {
    const capGroupId = this._suiteCapGroupId || this._capGroupId();
    return queuedEvalItemsForCapGroup(this._queueItems, capGroupId);
  }

  private async _setEvalSlotCap(value: number): Promise<void> {
    const previousCap = this._evalSlotCap;
    this._slotCapDirty = true;
    const capGroupId = this._suiteCapGroupId || this._capGroupId();
    this._slotCapDirtyGroupId = capGroupId;
    const cap = Math.max(1, Math.floor(Number.isFinite(value) ? value : 1));
    this._evalSlotCap = cap;
    const requestSeq = ++this._slotCapRequestSeq;
    if (this.mock) return;
    try {
      const result = await gateway.request<EvalSuiteCapUpdateResult>(
        Methods.EVAL_SUITE_CAP_UPDATE,
        {
          capGroupId,
          suiteId: this._datasetId(),
          cap,
        },
        30_000,
      );
      if (requestSeq === this._slotCapRequestSeq) {
        this._evalSlotCap = result.cap;
        this._slotCapDirty = false;
        this._slotCapDirtyGroupId = '';
        this._loadedSlotCapGroupId = result.capGroupId;
      }
    } catch (error) {
      if (requestSeq === this._slotCapRequestSeq) {
        this._evalSlotCap = previousCap;
        this._slotCapDirty = false;
        this._slotCapDirtyGroupId = '';
      }
      this._error = `Slot cap update failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async _slotCapForLaunch(capGroupId: string): Promise<number> {
    if (this.mock) return this._evalSlotCap;
    if (this._slotCapDirty) {
      if (this._slotCapDirtyGroupId === capGroupId) return this._evalSlotCap;
      this._slotCapDirty = false;
      this._slotCapDirtyGroupId = '';
    }
    const result = await gateway.request<EvalSuiteCapGetResult>(
      Methods.EVAL_SUITE_CAP_GET,
      { capGroupId },
      30_000,
    );
    this._evalSlotCap = result.cap;
    this._loadedSlotCapGroupId = result.capGroupId;
    return result.cap;
  }

  private _addCaseToBasket(item: EvalCaseCatalogItem): void {
    if (!item.selectable) {
      this._error = item.warnings[0] ?? 'Case cannot be selected yet';
      return;
    }
    const wasEmpty = this._selectedCases.length === 0;
    this._selectedCases = addCasesToBasket(this._selectedCases, [item]);
    if (wasEmpty) this._alignDefaultCandidatesToTaskProfile(item.taskProfile);
    this._error = '';
    if (this._project === 'farmslot') this._project = item.project;
  }

  private _manualItem(): EvalCaseCatalogItem | null {
    return catalogItemFromManual({
      kind: this._manualKind,
      project: this._manualProjectValue(),
      label: this._manualLabel,
      taskProfile: this._manualTaskProfile,
      objective: this._manualObjective,
      prRef: this._manualPrRef,
      runId: this._manualRunId,
      packagePath: this._manualPackagePath,
      gitRef: this._manualGitRef,
      gitRepository: this._manualGitRepository,
    });
  }

  private _matchingManualPrCatalogItem(): EvalCaseCatalogItem | null {
    if (this._manualKind !== 'merged-pr') return null;
    return findCatalogItemForPrRef(this._catalogItems(), this._manualPrRef);
  }

  private _addManualCase(): void {
    const item = this._matchingManualPrCatalogItem() ?? this._manualItem();
    if (!item) {
      this._error = 'Fill the manual case source before adding it';
      return;
    }
    this._addCaseToBasket(item);
    this._manualLabel = '';
    this._manualObjective = '';
  }

  private _removeBasketCase(selectionId: string): void {
    this._selectedCases = this._selectedCases.filter((item) => item.selectionId !== selectionId);
  }

  private _updateBasketCase(
    selectionId: string,
    patch: Partial<Pick<EvalSelectedCase, 'label' | 'objective' | 'taskProfile'>>,
  ): void {
    const current = this._selectedCases.find((item) => item.selectionId === selectionId);
    if (!current) return;
    const updated = updateSelectedCase(current, patch);
    const others = this._selectedCases.filter((item) => item.selectionId !== selectionId);
    const collision = others.find((item) => item.datasetItemId === updated.datasetItemId);
    if (collision) {
      this._error = `Basket edit would duplicate "${collision.label}". Change the objective or task profile, or remove the duplicate case first.`;
      return;
    }
    this._selectedCases = this._selectedCases.map((item) =>
      item.selectionId === selectionId ? updated : item,
    );
    if ('taskProfile' in patch) this._alignDefaultCandidatesToTaskProfile(updated.taskProfile);
    this._error = '';
  }

  private _updateRow(id: string, patch: Partial<CandidateRow>): void {
    this._candidateRows = this._candidateRows.map((row) =>
      row.id === id ? { ...row, ...patch } : row,
    );
  }

  private _candidateTemplateChoices(taskProfile: EvalTaskProfile): CandidateTemplateChoice[] {
    return candidateTemplateChoices(taskProfile, this._candidateTemplateOptions);
  }

  private async _loadCandidateTemplateOptions(): Promise<void> {
    const primaryCase = this._selectedCases[0];
    const project = primaryCase?.project || this._project.trim();
    const taskProfile = primaryCase?.taskProfile ?? 'fix-bug';
    if (this.mock || !project) {
      this._candidateTemplateOptions = [];
      this._candidateTemplateOptionsError = '';
      return;
    }
    const key = `${project}:${taskProfile}`;
    this._candidateTemplateOptionsKey = key;
    this._candidateTemplateOptionsLoading = true;
    this._candidateTemplateOptionsError = '';
    try {
      const res = await gateway.request<{ options: WorkerTemplateOption[] }>(
        Methods.CONFIG_TEMPLATE_OPTIONS,
        { project, flowType: taskProfile },
      );
      if (this._candidateTemplateOptionsKey !== key) return;
      this._candidateTemplateOptions = res.options;
      const validPaths = new Set(
        res.options.map((option) => `templates/worker/${option.fileName}`),
      );
      const defaultOption = res.options.find((option) => option.isDefault) ?? res.options[0];
      if (defaultOption) {
        const defaultPath = `templates/worker/${defaultOption.fileName}`;
        this._candidateRows = this._candidateRows.map((row) => {
          const customized = Boolean(
            row.templateHash.trim() ||
            row.promptHash.trim() ||
            row.baseRecipePath.trim() ||
            row.baseRecipeHash.trim(),
          );
          if (customized || validPaths.has(row.templatePath)) return row;
          return { ...row, templatePath: defaultPath, promptName: taskProfile };
        });
      }
    } catch (err: unknown) {
      if (this._candidateTemplateOptionsKey !== key) return;
      this._candidateTemplateOptions = [];
      this._candidateTemplateOptionsError =
        err instanceof Error ? err.message : 'Template options failed to load';
    } finally {
      if (this._candidateTemplateOptionsKey === key) this._candidateTemplateOptionsLoading = false;
    }
  }

  private _alignDefaultCandidatesToTaskProfile(taskProfile: EvalTaskProfile): void {
    const option =
      this._candidateTemplateChoices(taskProfile)[0] ??
      candidateTemplateForTaskProfile(taskProfile);
    this._candidateRows = this._candidateRows.map((row) => {
      const pathIsKnown = this._candidateTemplateChoices(taskProfile).some(
        (entry) => entry.path === row.templatePath,
      );
      const exactTemplateCustomized = Boolean(
        row.templateHash.trim() ||
        row.promptHash.trim() ||
        row.baseRecipePath.trim() ||
        row.baseRecipeHash.trim(),
      );
      if (!pathIsKnown || exactTemplateCustomized) return row;
      return {
        ...row,
        templatePath: option.path,
        promptName: option.promptName,
      };
    });
  }

  private _candidateModelOptions(runner: string): string[] {
    return candidateModelOptions(runner);
  }

  private _setCandidateRunner(id: string, runner: string): void {
    this._candidateRows = this._candidateRows.map((row) => {
      if (row.id !== id) return row;
      return applyCandidateRunner(row, runner);
    });
  }

  private _setCandidateTemplate(id: string, templatePath: string): void {
    const option = this._candidateTemplateChoices(
      this._selectedCases[0]?.taskProfile ?? 'fix-bug',
    ).find((entry) => entry.path === templatePath);
    this._updateRow(id, {
      templatePath,
      templateHash: '',
      ...(option ? { promptName: option.promptName } : {}),
    });
  }

  private _candidateTemplateSummary(row: CandidateRow): string {
    return candidateTemplateSummary(row);
  }

  private _generatedCandidateLabel(row: CandidateRow): string {
    const primaryCase = this._selectedCases[0];
    return generatedCandidateLabel(
      row,
      primaryCase,
      this._candidateTemplateChoices(primaryCase?.taskProfile ?? 'fix-bug'),
    );
  }

  private _candidateLabel(row: CandidateRow): string {
    const primaryCase = this._selectedCases[0];
    return candidateLabel(
      row,
      primaryCase,
      this._candidateTemplateChoices(primaryCase?.taskProfile ?? 'fix-bug'),
    );
  }

  private _templateName(row: CandidateRow): string {
    return templateName(row);
  }

  private _generatedVariant(row: CandidateRow): string {
    const primaryCase = this._selectedCases[0];
    return candidateVariant(row, primaryCase);
  }

  private _candidateVariant(row: CandidateRow): string {
    return this._generatedVariant(row);
  }

  private _addRow(): void {
    const id = `candidate-${this._nextCandidateNumber++}`;
    this._candidateRows = [
      ...this._candidateRows,
      {
        ...defaultRows()[0],
        id,
        label: '',
        templateHash: '',
        promptName: 'fix-bug',
      },
    ];
    this._error = '';
  }

  private _removeRow(id: string): void {
    this._candidateRows = this._candidateRows.filter((row) => row.id !== id);
  }

  private _patchSuiteCell(cellId: string, patch: Partial<EvalLaunchCell>): void {
    this._suiteCells = patchCell(this._suiteCells, cellId, patch);
  }

  private async _launchLocalSuite(): Promise<void> {
    const datasetId = this._datasetId();
    const capGroupId = this._capGroupId(datasetId);
    await launchEvalCockpitLocalSuite({
      mock: this.mock,
      project: this._project,
      evalResultOverride: this.evalResultOverride,
      selectedCases: this._selectedCases,
      rows: this._enabledCandidates(),
      datasetId,
      capGroupId,
      candidateLabel: (row) => this._candidateLabel(row),
      slotCapForLaunch: (groupId) => this._slotCapForLaunch(groupId),
      candidateTemplateChoices: (taskProfile) => this._candidateTemplateChoices(taskProfile),
      getSuiteCells: () => this._suiteCells,
      setError: (message) => {
        this._error = message;
      },
      setBusy: (message) => {
        this._busy = message;
      },
      setSuiteCapGroupId: (groupId) => {
        this._suiteCapGroupId = groupId;
      },
      setSuiteCells: (cells) => {
        this._suiteCells = cells;
      },
      patchSuiteCell: (cellId, patch) => this._patchSuiteCell(cellId, patch),
      clearEvalPackageSnapshots: () => this._evalPackageSnapshots.clear(),
      resetAppendResults: () => {
        this._appendResults = [];
      },
      resetEvalResultsByCase: () => {
        this._evalResultsByCase = {};
      },
      setEvalResult: (result) => {
        this._evalResult = result;
      },
      recordEvalResultForCase: (selectionId, result) => {
        this._evalResultsByCase = {
          ...this._evalResultsByCase,
          [selectionId]: result,
        };
      },
      markSlotCapSynced: (groupId) => {
        this._slotCapDirty = false;
        this._slotCapDirtyGroupId = '';
        this._loadedSlotCapGroupId = groupId;
      },
    });
  }

  private _packageRows(): PackageRow[] {
    return packageRowsForEvalCockpit({
      evalResult: this._evalResult ?? this.evalResultOverride,
      evalResultsByCase: this._evalResultsByCase,
      appendResults: this._appendResults,
      appendResultsOverride: this.appendResultsOverride,
      snapshots: this._evalPackageSnapshots.values(),
      suiteCells: this._suiteCells,
    });
  }

  private _renderCaseBrowser() {
    return renderEvalCockpitCaseBrowser({
      items: this._filteredCatalogItems(),
      preview: this._previewCase(),
      projects: evalCatalogProjectOptions(this._catalogItems()),
      statuses: evalCatalogStatusOptions(this._catalogItems()),
      selectedCases: this._selectedCases,
      enabledCandidateCount: this._enabledCandidates().length,
      referencePickerOpen: this._referencePickerOpen,
      caseQuery: this._caseQuery,
      caseProjectFilter: this._caseProjectFilter,
      caseTaskProfileFilter: this._caseTaskProfileFilter,
      caseStatusFilter: this._caseStatusFilter,
      caseKindFilter: this._caseKindFilter,
      caseSortKey: this._caseSortKey,
      caseSortDirection: this._caseSortDirection,
      previewCaseId: this._previewCaseId,
      manualEntryOpen: this._manualEntryOpen,
      openReferencePicker: () => {
        this._referencePickerOpen = true;
      },
      closeReferencePicker: () => {
        this._referencePickerOpen = false;
      },
      catalogItemForSelectedCase: (selected) => this._catalogItemForSelectedCase(selected),
      renderPreviewLinks: renderEvalPreviewLinks,
      renderPreviewStats: renderEvalPreviewStats,
      updateBasketCase: (selectionId, patch) => this._updateBasketCase(selectionId, patch),
      removeBasketCase: (selectionId) => this._removeBasketCase(selectionId),
      setCaseQuery: (value) => {
        this._caseQuery = value;
      },
      setCaseProjectFilter: (value) => {
        this._caseProjectFilter = value;
      },
      setCaseTaskProfileFilter: (value) => {
        this._caseTaskProfileFilter = value;
      },
      setCaseStatusFilter: (value) => {
        this._caseStatusFilter = value;
      },
      setCaseKindFilter: (value) => {
        this._caseKindFilter = value;
      },
      setCaseSort: (sortKey) => this._setCaseSort(sortKey),
      setPreviewCaseId: (id) => {
        this._previewCaseId = id;
      },
      addCaseToBasket: (item) => this._addCaseToBasket(item),
      setManualEntryOpen: (open) => {
        this._manualEntryOpen = open;
      },
      renderManualEntry: () => this._renderManualEntry(),
    });
  }

  private _renderManualEntry() {
    return renderEvalCockpitManualEntry({
      manualProject: this._manualProjectValue(),
      manualProjects: this._manualProjectOptions(),
      manualKind: this._manualKind,
      manualTaskProfile: this._manualTaskProfile,
      manualPrRef: this._manualPrRef,
      manualRunId: this._manualRunId,
      manualPackagePath: this._manualPackagePath,
      manualGitRef: this._manualGitRef,
      manualGitRepository: this._manualGitRepository,
      manualLabel: this._manualLabel,
      manualObjective: this._manualObjective,
      matchingPrReference: this._matchingManualPrCatalogItem(),
      setManualProject: (value) => {
        this._manualProject = value;
      },
      setManualKind: (value) => {
        this._manualKind = value;
      },
      setManualTaskProfile: (value) => {
        this._manualTaskProfile = value;
      },
      setManualPrRef: (value) => {
        this._manualPrRef = value;
      },
      setManualRunId: (value) => {
        this._manualRunId = value;
      },
      setManualPackagePath: (value) => {
        this._manualPackagePath = value;
      },
      setManualGitRef: (value) => {
        this._manualGitRef = value;
      },
      setManualGitRepository: (value) => {
        this._manualGitRepository = value;
      },
      setManualLabel: (value) => {
        this._manualLabel = value;
      },
      setManualObjective: (value) => {
        this._manualObjective = value;
      },
      addManualCase: () => this._addManualCase(),
    });
  }

  private _renderCandidateMatrix() {
    return renderEvalCockpitCandidateMatrix({
      candidateRows: this._candidateRows,
      selectedCaseCount: this._selectedCases.length,
      enabledCandidateCount: this._enabledCandidates().length,
      selectedTaskProfile: this._selectedCases[0]?.taskProfile ?? 'fix-bug',
      advancedStrategyOpen: this._advancedStrategyOpen,
      candidateTemplateOptionsLoading: this._candidateTemplateOptionsLoading,
      candidateTemplateOptionsError: this._candidateTemplateOptionsError,
      addRow: () => this._addRow(),
      removeRow: (id) => this._removeRow(id),
      updateRow: (id, patch) => this._updateRow(id, patch),
      setCandidateRunner: (id, runner) => this._setCandidateRunner(id, runner),
      setCandidateTemplate: (id, templatePath) => this._setCandidateTemplate(id, templatePath),
      setAdvancedStrategyOpen: (open) => {
        this._advancedStrategyOpen = open;
      },
      candidateLabel: (row) => this._candidateLabel(row),
      generatedCandidateLabel: (row) => this._generatedCandidateLabel(row),
      candidateModelOptions: (runner) => this._candidateModelOptions(runner),
      candidateTemplateChoices: (taskProfile) => this._candidateTemplateChoices(taskProfile),
      candidateTemplateSummary: (row) => this._candidateTemplateSummary(row),
      candidateVariant: (row) => this._candidateVariant(row),
    });
  }

  private _renderOperationalSummary() {
    return renderEvalCockpitOperationalSummary({
      suiteCells: this._suiteCells,
      selectedCaseCount: this._selectedCases.length,
      enabledCandidateCount: this._enabledCandidates().length,
      busy: this._busy,
      evalSlotCap: this._evalSlotCap,
      activeEvalCount: this._activeEvalCount(),
      queuedEvalItems: this._queuedEvalItems(),
      launchLocalSuite: () => void this._launchLocalSuite(),
      setEvalSlotCap: (value) => void this._setEvalSlotCap(value),
    });
  }

  override render() {
    const selectedCaseCount = this._selectedCases.length;
    const enabledCandidateCount = this._enabledCandidates().length;
    return renderEvalCockpitShell({
      evalResult: this._evalResult ?? this.evalResultOverride,
      selectedCaseCount,
      enabledCandidateCount,
      trialCount: selectedCaseCount * enabledCandidateCount,
      datasetId: this._datasetId(),
      busy: this._busy,
      error: this._error,
      renderProductModelGuide,
      renderCaseBrowser: () => this._renderCaseBrowser(),
      renderCandidateMatrix: () => this._renderCandidateMatrix(),
      renderOperationalSummary: () => this._renderOperationalSummary(),
      renderPackageMatrix: () => renderEvalCockpitPackageMatrix(this._packageRows()),
    });
  }

  static override styles = evalCockpitStyles;
}
