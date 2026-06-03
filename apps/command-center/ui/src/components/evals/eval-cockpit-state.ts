import { LitElement } from 'lit';
import { property, state } from 'lit/decorators.js';

import type {
  EvalExperimentCreateResult,
  EvalTaskProfile,
  EvalTrialStartResult,
  PRStatus,
  QueueItem,
  ResultPackageManifest,
  Run,
  WorkerTemplateOption,
} from '@farmslot/protocol';

import { DEFAULT_CANDIDATE_ROW_COUNT, defaultRows } from './eval-cockpit-model.js';
import type { CandidateRow } from './eval-cockpit-url-state.js';
import type {
  EvalCaseCatalogItem,
  EvalCaseFilterKind,
  EvalCaseFilterTaskProfile,
  EvalCaseSortDirection,
  EvalCaseSortKey,
  EvalCaseSourceKind,
  EvalSelectedCase,
} from './eval-suite-helpers.js';
import type { EvalLaunchCell } from './eval-suite-launch-model.js';

export abstract class EvalCockpitState extends LitElement {
  abstract _restoreUrlState(): void;

  @property({ type: Boolean }) mock = false;
  @property({ attribute: false }) evalResultOverride: EvalExperimentCreateResult | null = null;
  @property({ attribute: false }) appendResultsOverride: EvalTrialStartResult[] = [];
  @property({ attribute: false }) caseCatalogOverride: EvalCaseCatalogItem[] | null = null;
  @property({ attribute: false }) initialSelectedCaseIds: string[] = [];

  @state() _project = 'farmslot-farm';
  @state() _caseQuery = '';
  @state() _caseKindFilter: EvalCaseFilterKind = 'all';
  @state() _caseProjectFilter = 'all';
  @state() _caseTaskProfileFilter: EvalCaseFilterTaskProfile = 'all';
  @state() _caseStatusFilter = 'all';
  @state() _referencePickerOpen = false;
  @state() _caseSortKey: EvalCaseSortKey = 'date';
  @state() _caseSortDirection: EvalCaseSortDirection = 'desc';
  @state() _selectedCases: EvalSelectedCase[] = [];
  @state() _previewCaseId = '';
  @state() _manualKind: EvalCaseSourceKind = 'merged-pr';
  @state() _manualPrRef = '';
  @state() _manualRunId = '';
  @state() _manualPackagePath = '';
  @state() _manualGitRef = 'main';
  @state() _manualGitRepository = '';
  @state() _manualProject = '';
  @state() _manualLabel = '';
  @state() _manualObjective = '';
  @state() _manualTaskProfile: EvalTaskProfile = 'fix-bug';
  @state() _candidateRows: CandidateRow[] = defaultRows();
  @state() _candidateTemplateOptions: WorkerTemplateOption[] = [];
  @state() _candidateTemplateOptionsLoading = false;
  @state() _candidateTemplateOptionsError = '';
  _candidateTemplateOptionsKey = '';
  @state() _manualEntryOpen = false;
  @state() _advancedStrategyOpen = false;
  @state() _evalResult: EvalExperimentCreateResult | null = null;
  @state() _evalResultsByCase: Record<string, EvalExperimentCreateResult> = {};
  @state() _appendResults: EvalTrialStartResult[] = [];
  @state() _suiteCells: EvalLaunchCell[] = [];
  @state() _busy = '';
  @state() _error = '';
  @state() _runs: Run[] = [];
  @state() _prs: PRStatus[] = [];
  @state() _queueItems: QueueItem[] = [];
  @state() _evalSlotCap = 1;
  @state() _suiteCapGroupId = '';
  @state() _globalProjectFilters: string[] = [];
  _nextCandidateNumber = DEFAULT_CANDIDATE_ROW_COUNT + 1;
  readonly _evalPackageSnapshots = new Map<
    string,
    { revision: string; pkg: ResultPackageManifest; packagePath: string }
  >();
  readonly _evalPackageLoads = new Set<string>();
  _slotCapRequestSeq = 0;
  _slotCapDirty = false;
  _slotCapDirtyGroupId = '';
  _loadedSlotCapGroupId = '';
  _urlRestoring = false;
  _lastUrlState = '';
  readonly _onHashChange = () => this._restoreUrlState();
  _unsub?: () => void;
  _catalogCache: {
    override: EvalCaseCatalogItem[] | null;
    runs: Run[];
    prs: PRStatus[];
    globalProjects: string[];
    items: EvalCaseCatalogItem[];
  } | null = null;
}
