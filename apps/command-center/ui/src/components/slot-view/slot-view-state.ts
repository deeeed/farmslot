import { LitElement } from 'lit';
import { property, state } from 'lit/decorators.js';

import type {
  ArtifactRef,
  Diagnostic,
  EvidenceManifestStandalone,
  GitBranchDiffFile,
  PRReviewThread,
  RecipeRunArtifactGroup,
  Run,
  SlotActionSummary,
  SlotResource,
  SlotStatus,
  TaskProgressStructured,
} from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { type RecoveryPhase } from '../../utils/reconnect.js';
import { ConfirmActionTimer } from '../shared/confirm-action-model.js';
import { CopyFeedbackTimer } from '../shared/copy-feedback-model.js';
import type { FileEntry } from '../workspace/file-tree.js';

import {
  type CheckResult,
  type EditorId,
  type GitData,
  type OpenFile,
  type TaskStep,
} from './slot-view-model.js';
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
  @state() _taskSteps: TaskStep[] = [];
  @state() _taskProgress = 0;
  @state() _structuredProgress?: TaskProgressStructured;
  @state() _selectedAgentContextId = 'primary';
  @state() _selectedAgentContextIds: Record<string, string> = {};
  _lastLinkedRunId: string | null = null;
  @state() _repoPath = '';
  @state() _editor: EditorId = 'cursor';

  // --- Workspace state ---
  @state() _openFiles: OpenFile[] = [];
  @state() _activeFile = '';
  @state() _liveEntries: FileEntry[] = [];
  @state() _liveGitData: GitData | null = null;
  @state() _liveFileContents = new Map<string, string>();
  @state() _liveDiffContents = new Map<string, string>();
  @state() _wsLoading = false;
  @state() _wsError = '';
  @state() _recoveryPhase: RecoveryPhase = 'live';
  @state() _recoveryMessage = '';

  // --- Branch diff state ---
  @state() _branchDiffFiles: GitBranchDiffFile[] = [];
  @state() _branchDiffBase = 'main';
  @state() _branchDiffHead = '';
  @state() _branchDiffTotalAdd = 0;
  @state() _branchDiffTotalDel = 0;
  @state() _branchDiffLoading = false;
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
  @state() _newFilePrompt = false;
  @state() _newFilePath = '';
  @state() _showIgnored = true;
  @state() _pinnedFolder = '';
  // Cache the taskRelPath that auto-pin already probed so re-renders don't
  // re-issue 4 SSH FS_LIST round trips (one per candidate prefix) every time.
  _autoPinProbedFor: string | null = null;
  @state() _pinnedEntries: FileEntry[] = [];
  @state() _bottomTab: 'terminal' | 'problems' | 'comments' = 'terminal';
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
  @state() _historyOpen = false;
  @state() _historyRunId = '';
  @state() _loadRunOpen = false;
  @state() _manualToggling = false;
  @state() _sidebarOpen = true;
  @state() _terminalOpen = true;
  @state() _sidebarWidth = 260;
  _linkedRunRefreshToken = Symbol('linked-run-refresh');
  _recipeRunsRefreshToken = Symbol('recipe-runs-refresh');
  @state() _terminalHeight = 250;
  @state() _pinnedHeight = 200;
  @state() _reviewPanelOpen = false;
  @state() _reviewPanelWidth = 480;
  @state() _reviewFullWidth = false;
  @state() _reviewDrawerMode: 'primary' | 'recipe' = 'primary';
  _dismissedReviewDrawerKey = '';
  @state() _slotRecipeView: 'graph' | 'json' = 'graph';
  @state() _recipeRuns: RecipeRunArtifactGroup[] = [];
  @state() _selectedRecipeRunId = '';
  @state() _selectedRecipeFlowPath = '';
  @state() _selectedRecipeFlowJson = '';
  @state() _selectedRecipeFlowLoading = false;
  @state() _selectedRecipeFlowError = '';
  @state() _selectedRecipeEvidenceManifest: EvidenceManifestStandalone[] = [];
  @state() _selectedRecipeNodeId = '';
  @state() _recipeEvidenceMode: 'all' | 'node' = 'all';
  @state() _recipeEvidenceKindFilter: 'all' | 'before' | 'after' | 'setup' = 'all';
  @state() _selectedRecipeArtifactPath: string | null = null;
  @state() _recipeRunsLoading = false;
  @state() _recipeRunsError = '';
  @state() _recipeRunsCollapsed = false;
  @state() _recipeFlowsCollapsed = false;
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
  @state() _mirrorRefreshFeedback = '';
  @state() _artifactMirrorEpoch = 0;
  _selectedRecipeFlowLoadToken = Symbol('recipe-flow-load');
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
  _unsubSlot?: () => void;
  _unsubState?: () => void;
  _unsubConn?: () => void;
  _unsubRunUpdated?: () => void;
  _unsubRunCreated?: () => void;
  _unsubStateChange?: () => void;
  _unsubTaskProgress?: () => void;
  _unsubResourceStatus?: () => void;
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
  _gitPollTimer: ReturnType<typeof setInterval> | null = null;
  _fileRestoreRetryTimer: ReturnType<typeof setTimeout> | null = null;
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
    return this._isLive && this._recoveryPhase !== 'live';
  }

  get _canRetryRecovery(): boolean {
    return (
      this._isLive && gateway.connectionState === 'connected' && this._recoveryPhase === 'error'
    );
  }
}
