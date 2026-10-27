import { LitElement } from 'lit';
import { property, state } from 'lit/decorators.js';

import type { Draft, DraftStore } from '@farmslot/local-store/drafts';
import type {
  ArtifactRef,
  Diagnostic,
  EvidenceManifestStandalone,
  GitBranchDiffFile,
  NodesListResult,
  PRReviewThread,
  RecipeRunArtifactGroup,
  Run,
  SlotActionSummary,
  SlotResource,
  SlotStatus,
  TaskProgressResult,
  TaskProgressStructured,
} from '@farmslot/protocol';
import type { ResourceQueryState } from '@farmslot/protocol/client-cache';
import type { ChecklistProgressStep } from '@farmslot/review-dispatch';

import { gateway } from '../../gateway-client.js';
import { type RecoveryPhase } from '../../utils/reconnect.js';
import { ConfirmActionTimer } from '../shared/confirm-action-model.js';
import { CopyFeedbackTimer } from '../shared/copy-feedback-model.js';
import type { PrepareProgressState } from '../shared/prepare-progress-model.js';
import { ResourceQueryController } from '../shared/resource-query-controller.js';
import type { FileEntry } from '../workspace/file-tree.js';
import {
  type RecipeRunnerUiOptions,
  recipeRunnerUiOptions,
} from '../workspace/recipe-runner-options-model.js';
import { WorkspaceReads } from '../workspace/workspace-reads.js';

import { type CheckResult, type EditorId, type GitData, type OpenFile } from './slot-view-model.js';
import type { SlotViewRecipeEvidenceResult } from './slot-view-recipe-helpers.js';
import type { SlotViewResizeType } from './slot-view-resize-effects.js';

export abstract class SlotViewState extends LitElement {
  abstract _handleGlobalKey(event: KeyboardEvent): void;

  @property() slotId = '';

  // Dev harness props (for isolated testing without gateway)
  @property({ attribute: false }) fileEntries: FileEntry[] = [];
  @property({ attribute: false }) gitData: GitData | null = null;
  @property({ attribute: false }) fileContents: Map<string, string> = new Map();
  @property({ attribute: false }) diffContents: Map<string, string> = new Map();

  // --- Slot detail state ---
  @state() _slot: SlotStatus | null = null;
  @state() _checks: CheckResult[] = [];
  @state() _loading = false;
  // _pendingConfirm gates the 3s double-click confirmation flow used by the
  // configured slot_actions render below (slot-header strip + resource panel).
  // The built-in lifecycle actions (Prepare/Release/Refresh/Recycle/Cleanup)
  // moved to <slot-actions-panel>, which manages its own confirm state.
  @state() _pendingConfirm: string | null = null;
  @state() _taskSteps: ChecklistProgressStep[] = [];
  @state() _taskProgress = 0;
  @state() _structuredProgress?: TaskProgressStructured;
  @state() _progressObservation: ResourceQueryState<TaskProgressResult> = { status: 'loading' };
  @state() _selectedAgentContextId = 'primary';
  @state() _tmuxSessionSelection: string | null = null;
  @state() _selectedAgentContextIds: Record<string, string> = {};
  _lastLinkedRunId: string | null = null;
  _lastLinkedRunActiveTaskFile: string | null = null;
  _lastLinkedRunReviewProgress: string | null = null;
  @state() _repoPath = '';
  @state() _editor: EditorId = 'cursor';

  // --- Workspace state ---
  @state() _openFiles: OpenFile[] = [];
  @state() _activeFile = '';
  @state() _liveEntries: FileEntry[] = [];
  @state() _liveGitData: GitData | null = null;
  @state() _liveFileContents = new Map<string, string>();
  /** The hash each file's current `fs.read` reported; absent when the host sends none. */
  @state() _liveFileHashes = new Map<string, string | undefined>();
  @state() _liveDiffContents = new Map<string, string>();
  @state() _wsLoading = false;
  @state() _wsError = '';
  @state() _recoveryPhase: RecoveryPhase = 'live';
  @state() _recoveryMessage = '';

  // --- Branch diff state ---
  @state() _branchDiffFiles: GitBranchDiffFile[] = [];
  @state() _branchDiffTestPatterns: readonly string[] | null = null;
  @state() _branchDiffBase = 'main';
  @state() _branchDiffHead = '';
  @state() _branchDiffTotalAdd = 0;
  @state() _branchDiffTotalDel = 0;
  @state() _branchDiffLoading = false;
  @state() _branchDiffError: string | null = null;
  /** Bumped on every slot switch — stales in-flight branch-diff completions (A→B→A safe). */
  _branchDiffGeneration = 0;
  @state() _branchDiffBranches: string[] = [];

  // --- Layout state ---
  @state() _activity: 'explorer' | 'search' | 'source' | 'changes' | 'info' = 'explorer';
  @state() _sections: Record<string, boolean> = {
    source: true,
    info: true,
    actions: true,
    run: true,
    task: false,
  };
  @state() _runPanelOpen = false;
  @state() _runPanelSelectedStep: import('@farmslot/protocol').RunStep | null = null;

  // --- Search state ---
  @state() _searchMode: 'files' | 'content' = 'files';
  @state() _searchQuery = '';
  @state() _searchResults: Array<{ file: string; line: number; column: number; text: string }> = [];
  @state() _searchLoading = false;
  @state() _searchTruncated = false;
  @state() _fileIndex: string[] = [];
  @state() _fileSearchResults: string[] = [];
  @state() _saveFeedback: '' | 'saving' | 'saved' = '';

  // --- Editing (ADR-009 Amendment 1) ---
  _draftStore?: DraftStore;
  /** This slot's drafts the user may see: current ones, and read-only ones for an older run. */
  @state() _slotDrafts: Draft[] = [];
  /** Current-run drafts by path; the editor shows their edited content. */
  @state() _fileDrafts = new Map<string, Draft>();
  _draftRefresh = 0;
  /** The connection a draft may autosave on; restored and reconnected drafts are absent. */
  _autosaveArmed = new Map<string, number>();
  _autosaveTimer?: ReturnType<typeof setTimeout>;
  /** What the user last saved per path, to tell a worker's later write apart. */
  _userSaves = new Map<string, { hash: string; content: string }>();
  @state() _saveConflict?: {
    path: string;
    mine: string;
    theirs?: string;
    theirsHash: string | null;
  };
  @state() _editNotice = '';
  /** The path whose last save was refused for its run, its host or an error. */
  @state() _saveRefused = '';
  /** The saved file a worker then changed; the user's version is kept as a draft. */
  @state() _fileChangedNotice = '';
  /** Bumped to replace the editor's text, such as after keeping the file's own version. */
  @state() _editorRevision = 0;
  /** The node refused a conditional write; the editor stays read-only for this slot. */
  @state() _conditionalWritesRefused = false;
  readonly _nodesQuery = new ResourceQueryController<NodesListResult>(this, () =>
    this.requestUpdate(),
  );
  @state() _newFilePrompt = false;
  @state() _newFilePath = '';
  @state() _showIgnored = true;
  @state() _pinnedFolder = '';
  // Cache the taskRelPath that auto-pin already probed so re-renders don't
  // re-issue 4 SSH FS_LIST round trips (one per candidate prefix) every time.
  _autoPinProbedFor: string | null = null;
  @state() _pinnedEntries: FileEntry[] = [];
  @state() _bottomTab: 'terminal' | 'history' | 'problems' | 'comments' = 'terminal';
  @state() _workerHistoryEnabled = false;
  @state() _resources: SlotResource[] = [];
  @state() _slotActions: SlotActionSummary[] = [];
  @state() _runningSlotActionIds: string[] = [];
  @state() _resourcePanelOpen = false;
  @state() _activeResourceId = '';
  @state() _streamWidth = 320;
  @state() _taskPanelOpen = true;
  @state() _taskPanelWidth = 280;
  @state() _prNumber: number | null = null;
  @state() _prRepo: string | null = null;
  @state() _prThreads: PRReviewThread[] = [];
  @state() _prCurrentUser = '';
  @state() _prCommentsLoading = false;
  @state() _diagnostics: Diagnostic[] = [];
  @state() _diagnosticsLoading = false;
  @state() _diagnosticsTruncated = false;
  @state() _unavailableContextKeys = new Set<string>();
  @state() _revealLine = 0;
  @state() _showInlineComments = false;
  @state() _linkedRun: Run | null = null;
  @state() _linkedRunCurrent = false;
  @state() _linkedRunReadError = '';
  @state() _runCommandError = '';
  @state() _linkedRunObservedAt?: number;
  @state() _recipeRunsCurrent = false;
  @state() _tmuxRestoreRunning = false;
  _tmuxRestoreRequest?: symbol;
  @state() _tmuxRestoreFeedback = '';
  @state() _tmuxRestoreError = '';
  @state() _recipeRunnerUiOptions: RecipeRunnerUiOptions = recipeRunnerUiOptions(null);
  @state() _historyOpen = false;
  @state() _historyRunId = '';
  @state() _loadRunOpen = false;
  /** In-flight operator-initiated slot.prepare (load-run / switch-branch). */
  @state() _activePrepare: PrepareProgressState | null = null;
  @state() _manualToggling = false;
  @state() _sidebarOpen = true;
  @state() _terminalOpen = true;
  @state() _sidebarWidth = 260;
  @state() _terminalHeight = 250;
  /** Live height of `.sv-right-col` — used to clamp persisted terminal height. */
  @state() _rightColHeight = 0;
  _rightColObserver?: ResizeObserver;
  @state() _pinnedHeight = 200;
  @state() _reviewPanelOpen = false;
  @state() _reviewPanelWidth = 480;
  @state() _reviewFullWidth = false;
  @state() _reviewDrawerMode: 'primary' | 'recipe' = 'primary';
  _dismissedReviewDrawerKey = '';
  @state() _slotRecipeView: 'graph' | 'json' = 'graph';
  @state() _recipeRuns: RecipeRunArtifactGroup[] = [];
  @state() _selectedRecipeRunId = '';
  @state() _selectedRecipeDependencyPath = '';
  @state() _selectedRecipeDependencyJson = '';
  @state() _selectedRecipeDependencyLoading = false;
  @state() _selectedRecipeDependencyError = '';
  @state() _selectedRecipeEvidenceManifest: EvidenceManifestStandalone[] = [];
  @state() _selectedRecipeNodeId = '';
  @state() _recipeEvidenceMode: 'all' | 'node' = 'all';
  @state() _recipeEvidenceKindFilter: 'all' | 'before' | 'after' | 'setup' = 'all';
  @state() _selectedRecipeArtifactPath: string | null = null;
  @state() _recipeRunsLoading = false;
  @state() _recipeRunsError = '';
  @state() _recipeRunsCollapsed = false;
  @state() _recipeDependenciesCollapsed = false;
  @state() _recipeEvidenceCollapsed = false;
  @state() _recipeQualityCollapsed = true;
  @state() _recipeDefinitionCollapsed = false;
  @state() _recipeCommandFeedback: '' | 'copied' = '';
  @state() _copiedSlotActionId = '';
  /** Inline error feedback for configured slot_actions failures in the slot-header strip. */
  @state() _failedSlotActionId = '';
  @state() _failedSlotActionMsg = '';
  @state() _recipeExecutionOpen = false;
  @state() _recipeExecutionLabel = '';
  @state() _recipeExecutionArtifactPath = '';
  @state() _recipeExecutionRecipeRunId = '';
  _pendingRecipeRunSelectionId = '';
  @state() _selectedRecipeArtifactText = '';
  @state() _selectedRecipeArtifactLoading = false;
  @state() _selectedRecipeArtifactError = '';
  @state() _recipeLightboxOpen = false;
  @state() _recipeLightboxIndex = 0;
  @state() _recipeLightboxMode: 'single' | 'compare' = 'single';
  @state() _recipeLightboxPairIndex = 0;
  @state() _recipeLightboxScopePaths: string[] | null = null;
  @state() _recipeLightboxScopeLabel = '';
  @state() _selectedRecipeEvidenceManifestDroppedVideoCount = 0;
  @state() _mirrorRefreshing = false;
  _mirrorRequest?: symbol;
  @state() _mirrorRefreshFeedback = '';
  @state() _artifactMirrorEpoch = 0;
  _selectedRecipeDependencyLoadToken = Symbol('recipe-library-load');
  _selectedRecipeEvidenceManifestLoadToken = Symbol('recipe-evidence-manifest-load');
  _selectedRecipeArtifactPreviewLoadToken = Symbol('recipe-artifact-preview-load');
  _recipeEvidenceCache: {
    artifactManifest: ArtifactRef[] | null;
    evidenceManifest: EvidenceManifestStandalone[];
    recipeRunId: string | null;
    recipeJson: string | null;
    selectedNodeId: string;
    mode: 'all' | 'node';
    usedTypedArtifactManifest: boolean;
    result: SlotViewRecipeEvidenceResult;
  } | null = null;
  _resizing: SlotViewResizeType | null = null;
  _resizeStartX = 0;
  _resizeStartY = 0;
  _resizeStartValue = 0;

  // --- Subscriptions ---
  _unsubState?: () => void;
  _unsubDrafts?: () => void;
  _unsubConn?: () => void;
  _unsubResourceStatus?: () => void;
  _unsubPrepareTracker?: () => void;
  _liveInitPending = false;
  _recoveryEpoch = 0;
  _confirmTimer = new ConfirmActionTimer({
    pendingConfirm: () => this._pendingConfirm,
    setPendingConfirm: (pending) => {
      this._pendingConfirm = pending;
    },
  });
  _copyFeedback = new CopyFeedbackTimer({
    copiedKey: () => this._copiedSlotActionId,
    setCopiedKey: (key) => {
      this._copiedSlotActionId = key;
    },
  });
  readonly _workspaceReads: WorkspaceReads = new WorkspaceReads(
    this,
    () => {
      if (this._workspaceReads?.ready) {
        this._recoveryPhase = 'live';
        this._recoveryMessage = '';
        this._wsError = '';
      }
    },
    () => this._linkedRun?.id,
    () => {
      this._liveEntries = [];
      this._pinnedEntries = [];
      this._liveGitData = null;
      this._liveFileContents = new Map();
      this._liveFileHashes = new Map();
      this._liveDiffContents = new Map();
    },
  );
  _resourceRestoreRetryTimer: ReturnType<typeof setTimeout> | null = null;
  _prevSlotId = '';
  _slotSwitcherSignature = '';
  _boundKeyHandler = this._handleGlobalKey.bind(this);

  // Light DOM so Monaco and diff2html CSS from document.head works
  protected override createRenderRoot() {
    return this;
  }

  // --- Live mode detection ---
  get _isLive(): boolean {
    return this.slotId !== '' && this.fileEntries.length === 0;
  }

  get _entries(): FileEntry[] {
    return this._isLive ? this._liveEntries : this.fileEntries;
  }

  get _git(): GitData | null {
    return this._isLive ? this._liveGitData : this.gitData;
  }

  get _files(): Map<string, string> {
    return this._isLive ? this._liveFileContents : this.fileContents;
  }

  get _diffs(): Map<string, string> {
    return this._isLive ? this._liveDiffContents : this.diffContents;
  }

  get _gitStatusMap(): Map<string, string> {
    const map = new Map<string, string>();
    const git = this._git;
    if (git) {
      for (const c of git.changes) {
        // If a file appears in both staged and unstaged, unstaged status takes precedence for tree coloring
        if (!map.has(c.path)) {
          map.set(c.path, c.status);
        }
      }
    }
    return map;
  }

  get _isLocal(): boolean {
    return this._slot?.health.ssh === 'LOCAL';
  }

  get _isRecoveryBlocked(): boolean {
    return this._isLive && !this._workspaceReads.hasData && this._recoveryPhase !== 'live';
  }

  get _runActionsBlocked(): boolean {
    return (
      this._isRecoveryBlocked ||
      !this._workspaceReads.ready ||
      !this._linkedRunCurrent ||
      gateway.connectionState !== 'connected'
    );
  }

  get _canRetryRecovery(): boolean {
    return (
      this._isLive && gateway.connectionState === 'connected' && this._recoveryPhase === 'error'
    );
  }
}
