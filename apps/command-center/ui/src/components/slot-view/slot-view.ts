import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';

import type { AgentContextSummary, Run, SlotActionSummary, SlotStatus } from '@farmslot/protocol';

import '../workspace/file-tree.js';
import '../progress-tracker/progress-tracker.js';
import '../workspace/git-changes.js';
import '../workspace/branch-changed-files.js';
import '../workspace/tab-bar.js';
import '../workspace/pr-comments-panel.js';
import '../workspace/problems-panel.js';
import '../workspace/ready-workspace.js';
import '../workspace/recipe-output-panel.js';
import '../terminal/terminal-view.js';
import '../diff-viewer/diff-review.js';
import '../diff-viewer/code-viewer.js';
import '../stream-feed/stream-feed.js';
import '../resources/resource-panel.js';
import '../config/slot-toggle.js';
import '../slot-actions/slot-actions-panel.js';
import '../shared/prepare-progress-panel.js';
import { renderSlotPreparePreconditionStrip } from '../shared/slot-prepare-precondition-strip.js';
import './slot-history-modal.js';
import './slot-load-run-modal.js';
import '../runs/run-pipeline.js';
import '../runs/step-inspector.js';
import '../workspace/review-workspace.js';
import '../shared/media-lightbox.js';
import '../workspace/recipe-runner-controls.js';

import { gateway } from '../../gateway-client.js';
import { colors, lifecycleColor } from '../../styles/theme-tokens.js';
import { setPinnedSlotLabel, togglePinnedSlot } from '../../utils/pinned-slots.js';
import {
  currentRecoveryEpoch,
  isRecoveryEpochCurrent,
  waitForRecoveryHydration,
} from '../../utils/reconnect.js';
import type { FileEntry } from '../workspace/file-tree.js';

import {
  agentContextKey,
  deriveSlotViewAgentContexts,
  isAgentContextUnavailable,
  selectSlotViewAgentContext,
} from './slot-view-agent-contexts.js';
import { connectSlotView, disconnectSlotView } from './slot-view-connection-effects.js';
import {
  handleSlotViewBack,
  hasSlotViewModalOpen,
  pauseSlotViewRun,
  replaySlotViewRunStep,
  requestSlotViewSwitcherUpdate,
  resumeSlotViewRun,
  setSlotViewActivity,
  slotViewSwitcherEntries,
  switchSlotViewRelativeSlot,
  switchSlotViewSlot,
  toggleSlotViewManualMode,
  toggleSlotViewSection,
  toggleSlotViewSidebar,
} from './slot-view-control-effects.js';
import {
  fetchSlotViewActions,
  fetchSlotViewRepoPath,
  fetchSlotViewResources,
  fetchSlotViewStructuredProgress,
  loadSlotViewSlot,
  parseSlotViewTaskSteps,
} from './slot-view-data-effects.js';
import {
  openSlotViewEditor,
  revealSlotViewArtifacts,
  runSlotViewGitAction,
  saveSlotViewFile,
  setSlotViewEditor,
} from './slot-view-file-command-effects.js';
import {
  handleSlotViewGlyphClick,
  navigateSlotViewComment,
  openSlotViewIndexedFile,
} from './slot-view-file-navigation-effects.js';
import { renderSlotPrepareBanner, renderSlotViewHeader } from './slot-view-header-renderers.js';
import { renderSlotViewInfoPanel, renderSlotViewSidebarInfo } from './slot-view-info-renderers.js';
import { handleSlotViewGlobalKey } from './slot-view-keyboard-effects.js';
import { saveLayout } from './slot-view-layout.js';
import {
  applySlotViewLinkedRun,
  clearSelectedSlotViewAgentContextForSlot,
  refreshSlotViewLinkedRun,
  requestedSlotViewRunFromUrl,
} from './slot-view-linked-run-effects.js';
import {
  createSlotViewFile,
  handleSlotViewChangeSelect,
  handleSlotViewFileSelect,
  handleSlotViewTreeAction,
  initSlotViewLive,
  loadSlotViewDirectory,
  openSlotViewFile,
  pinSlotViewFile,
  refreshSlotViewGitStatus,
  reloadSlotViewTree,
  slotViewResourceHealthItems,
  teardownSlotViewLive,
  toggleSlotViewEditorMode,
} from './slot-view-live-effects.js';
import { type EditorId, type SlotSwitcherEntry } from './slot-view-model.js';
import {
  renderSlotViewActivityPanel,
  renderSlotViewAgentContexts,
  renderSlotViewBody,
  renderSlotViewChangesPanel,
  renderSlotViewExplorerPanel,
  renderSlotViewSidebarActions,
  renderSlotViewSidebarFiles,
  renderSlotViewSidebarSource,
  renderSlotViewSidebarTask,
  renderSlotViewTaskBreadcrumb,
} from './slot-view-panel-renderers.js';
import {
  autoPinSlotViewTaskFolder,
  handleSlotViewPinnedDirExpand,
  loadSlotViewPinnedEntries,
  loadSlotViewPinnedSubdir,
  pinSlotViewFolder,
  unpinSlotViewFolder,
} from './slot-view-pinned-effects.js';
import { SlotViewRecipePresenter } from './slot-view-recipe-presenter.js';
import {
  endSlotViewResize,
  moveSlotViewResize,
  type SlotViewResizeType,
  startSlotViewResize,
} from './slot-view-resize-effects.js';
import {
  closeSlotViewResourcePanel,
  openSlotViewResourcePanelResource,
} from './slot-view-resource-panel-effects.js';
import {
  detectSlotViewPR,
  handleSlotViewBranchDiffBaseChange,
  handleSlotViewBranchDiffSelect,
  loadSlotViewBranchDiff,
  loadSlotViewBranchList,
  loadSlotViewPRComments,
  openSlotViewBranchDiffFile,
  slotViewCommentThreadsForFile,
} from './slot-view-review-effects.js';
import {
  executeSlotViewSearch,
  handleSlotViewDiagnosticNavigate,
  handleSlotViewSearchInput,
  loadSlotViewFileIndex,
  openSlotViewSearchResult,
  runSlotViewDiagnostics,
} from './slot-view-search-effects.js';
import { fuzzyFilterSlotViewFiles } from './slot-view-search-model.js';
import {
  copySlotViewText,
  executeConfiguredSlotViewAction,
  runConfiguredSlotViewAction,
  slotViewHeaderActions,
  slotViewResourcePanelActions,
} from './slot-view-slot-action-effects.js';
import {
  renderContentSearchResults,
  renderEditor,
  renderEditorHeader,
  renderFileSearchResults,
  renderSearchPanel,
  renderSourcePanel,
} from './slot-view-source-renderers.js';
import { renderSlotViewStyles } from './slot-view-styles.js';
import {
  formatSlotViewDuration,
  hasSlotViewActiveTask,
  shouldShowSlotViewTaskUi,
} from './slot-view-task-model.js';
import { updateSlotViewTreeChildren } from './slot-view-tree-model.js';
import { handleSlotViewUpdated } from './slot-view-update-effects.js';
import {
  cancelSlotViewFileRestoreRetry,
  cancelSlotViewResourceRestoreRetry,
  ensureSlotViewResourcePanelSelection,
  handleSlotViewHashChange,
  openSlotViewFileFromUrl,
  restoreSlotViewFileFromUrl,
  restoreSlotViewHistoryFromUrl,
  restoreSlotViewResourceFromUrl,
  scheduleSlotViewUrlRestoreRetry,
  syncSlotViewUrlState,
} from './slot-view-url-effects.js';
import {
  getSlotViewHashParam,
  requestedFileFromHash,
  requestedRecipeArtifactFromHash,
  requestedRecipeEvidenceModeFromHash,
  requestedRecipeFlowFromHash,
  requestedRecipeNodeFromHash,
  requestedRecipeRunFromHash,
  requestedRecipeViewerModeFromHash,
  requestedResourceFromHash,
  requestedReviewDrawerModeFromHash,
} from './slot-view-url-state.js';

@customElement('slot-view')
export class SlotView extends SlotViewRecipePresenter {
  async _retryRecovery() {
    if (!this._isLive || gateway.connectionState !== 'connected') return;
    await this._beginLiveRecovery();
  }

  // --- Lifecycle ---

  _handleGlobalKey(e: KeyboardEvent) {
    handleSlotViewGlobalKey(this, e);
  }

  _applyLinkedRun(
    run: Run | null,
    prevRunStatus: string | null,
    source: 'cache' | 'rpc' = 'rpc',
  ): string | null {
    return applySlotViewLinkedRun(this, run, prevRunStatus, source);
  }

  _clearSelectedAgentContextForSlot() {
    clearSelectedSlotViewAgentContextForSlot(this);
  }

  _requestedRunFromUrl(): string | null {
    return requestedSlotViewRunFromUrl();
  }

  async _refreshLinkedRun(prevRunStatus: string | null): Promise<string | null> {
    return refreshSlotViewLinkedRun(this, prevRunStatus);
  }

  _onHashChange = () => {
    handleSlotViewHashChange(this);
  };

  /** Read ?history=1&historyRun=<id> from the current hash and apply. */
  _restoreHistoryFromUrl() {
    restoreSlotViewHistoryFromUrl(this);
  }

  connectedCallback() {
    super.connectedCallback();
    connectSlotView(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    disconnectSlotView(this);
  }

  updated(changed: Map<string, unknown>) {
    handleSlotViewUpdated(this, changed);
  }

  /** Set after initial file-from-URL restore is complete (prevents clearing ?file= before it's read) */
  _fileUrlReady = false;

  /** Update URL hash with current local slot-view state (replaceState to avoid history spam) */
  _syncUrlState() {
    syncSlotViewUrlState(this);
  }

  /** Read ?file= from current hash and open it */
  async _restoreFileFromUrl() {
    await restoreSlotViewFileFromUrl(this);
  }

  _getHashParam(name: string): string | null {
    return getSlotViewHashParam(name);
  }

  _requestedFileFromUrl(): string | null {
    return requestedFileFromHash();
  }

  _requestedResourceFromUrl(): string | null {
    return requestedResourceFromHash();
  }

  _requestedRecipeRunFromUrl(): string | null {
    return requestedRecipeRunFromHash();
  }

  _requestedRecipeFlowFromUrl(): string | null {
    return requestedRecipeFlowFromHash();
  }

  _requestedRecipeNodeFromUrl(): string | null {
    return requestedRecipeNodeFromHash();
  }

  _requestedRecipeArtifactFromUrl(): string | null {
    return requestedRecipeArtifactFromHash();
  }

  _requestedRecipeEvidenceModeFromUrl(): 'all' | 'node' | null {
    return requestedRecipeEvidenceModeFromHash();
  }

  _requestedRecipeViewerModeFromUrl(): 'single' | 'compare' {
    return requestedRecipeViewerModeFromHash();
  }

  _requestedReviewDrawerModeFromUrl(): 'primary' | 'recipe' | null {
    return requestedReviewDrawerModeFromHash();
  }

  _restoreResourceFromUrl() {
    restoreSlotViewResourceFromUrl(this);
  }

  _ensureResourcePanelSelection(resourceId: string, attemptsLeft = 4) {
    ensureSlotViewResourcePanelSelection(this, resourceId, attemptsLeft);
  }

  _cancelResourceRestoreRetry() {
    cancelSlotViewResourceRestoreRetry(this);
  }

  _cancelFileRestoreRetry() {
    cancelSlotViewFileRestoreRetry(this);
  }

  _scheduleUrlRestoreRetry(file: string, attemptsLeft = 2) {
    scheduleSlotViewUrlRestoreRetry(this, file, attemptsLeft);
  }

  async _openFileFromUrl(file: string) {
    await openSlotViewFileFromUrl(this, file);
  }

  // --- Slot data (from slot-detail) ---

  _loadSlot() {
    loadSlotViewSlot(this);
  }

  async _fetchRepoPath(machine: string) {
    await fetchSlotViewRepoPath(this, machine);
  }

  async _fetchResources() {
    await fetchSlotViewResources(this);
  }

  async _fetchSlotActions() {
    await fetchSlotViewActions(this);
  }

  _onResourcePanelClose() {
    closeSlotViewResourcePanel(this);
  }

  _onHeaderResourceClick(resourceId: string) {
    openSlotViewResourcePanelResource(this, resourceId);
  }

  async _parseTaskSteps() {
    await parseSlotViewTaskSteps(this);
  }

  async _fetchStructuredProgress() {
    await fetchSlotViewStructuredProgress(this);
  }

  _agentContexts(): AgentContextSummary[] {
    return deriveSlotViewAgentContexts({ linkedRun: this._linkedRun, slot: this._slot });
  }

  _selectedAgentContext(): AgentContextSummary | null {
    return selectSlotViewAgentContext(this._agentContexts(), this._selectedAgentContextId);
  }

  _contextKey(ctx: AgentContextSummary): string {
    return agentContextKey(ctx);
  }

  _isContextUnavailable(ctx: AgentContextSummary): boolean {
    return isAgentContextUnavailable(ctx, this._unavailableContextKeys);
  }

  _selectAgentContext(ctx: AgentContextSummary): void {
    if (this._isContextUnavailable(ctx)) return;
    this._selectedAgentContextId = ctx.id;
    if (this.slotId) {
      this._selectedAgentContextIds = { ...this._selectedAgentContextIds, [this.slotId]: ctx.id };
    }
    this._saveLayout();
    this._structuredProgress = undefined;
    this._taskSteps = [];
    this._fetchStructuredProgress();
    this._parseTaskSteps();
  }

  _renderTaskBreadcrumb() {
    return renderSlotViewTaskBreadcrumb(this);
  }

  _renderAgentContexts() {
    return renderSlotViewAgentContexts(this);
  }

  async _beginLiveRecovery() {
    const epoch = currentRecoveryEpoch();
    this._recoveryEpoch = epoch;
    this._recoveryPhase = 'rehydrating';
    this._recoveryMessage = 'Recovering workspace from gateway…';
    this._wsError = '';
    this._wsLoading = true;

    const hydrated = await waitForRecoveryHydration(epoch);
    if (!hydrated || this._recoveryEpoch !== epoch) return;

    await this._initLive(epoch);
    const requestedFile = this._requestedFileFromUrl();
    if (
      requestedFile &&
      !this._activeFile &&
      isRecoveryEpochCurrent(epoch) &&
      this._recoveryEpoch === epoch
    ) {
      await this._openFileFromUrl(requestedFile);
      if (!this._activeFile) {
        this._scheduleUrlRestoreRetry(requestedFile);
      }
    }
  }

  // 3-second double-click confirmation gate for configured slot_actions
  // (slot-header strip + resource panel). The built-in lifecycle actions
  // moved to <slot-actions-panel> which manages its own confirm flow.
  _confirmAction(actionId: string, fn: () => void) {
    this._confirmTimer.confirm(actionId, fn);
  }

  _slotHeaderActions(): SlotActionSummary[] {
    return slotViewHeaderActions(this);
  }

  _resourcePanelActions(): SlotActionSummary[] {
    return slotViewResourcePanelActions(this);
  }

  _runConfiguredSlotAction(actionId: string) {
    runConfiguredSlotViewAction(this, actionId);
  }

  async _executeConfiguredSlotAction(action: SlotActionSummary) {
    await executeConfiguredSlotViewAction(this, action);
  }

  async _copyText(text: string) {
    await copySlotViewText(text);
  }

  // Cleanup button is only meaningful when the slot isn't busy and at least
  // one watched resource is still up. Recycle is the right tool for busy slots.
  // Note: raw `released` is mapped to `ready` by mapLifecycleAndPhase before
  // reaching the UI, so checking `ready` covers both shapes.
  //
  async _openEditor() {
    await openSlotViewEditor(this);
  }

  async _revealArtifacts() {
    await revealSlotViewArtifacts(this);
  }

  _setEditor(id: EditorId) {
    setSlotViewEditor(this, id);
  }

  // --- Workspace data (from slot-workspace) ---

  async _initLive(epoch = this._recoveryEpoch || currentRecoveryEpoch()) {
    return await initSlotViewLive(this, epoch);
  }

  _teardownLive() {
    teardownSlotViewLive(this);
  }

  async _refreshGitStatus() {
    return await refreshSlotViewGitStatus(this);
  }

  async _loadDirectory(dirPath: string) {
    return await loadSlotViewDirectory(this, dirPath);
  }

  _updateTreeChildren(
    entries: FileEntry[],
    targetPath: string,
    children: FileEntry[],
  ): FileEntry[] {
    return updateSlotViewTreeChildren(entries, targetPath, children);
  }

  async _handleFileSelect(path: string) {
    return await handleSlotViewFileSelect(this, path);
  }

  async _handleChangeSelect(path: string, status?: string) {
    return await handleSlotViewChangeSelect(this, path, status);
  }

  _isChangedFile(path: string): boolean {
    return this._git?.changes.some((c) => c.path === path) ?? false;
  }

  async _toggleEditorMode() {
    return await toggleSlotViewEditorMode(this);
  }

  _handleDirExpand(path: string) {
    if (this._isLive) {
      this._loadDirectory(path);
    }
  }

  _openFile(path: string, type: 'file' | 'diff' = 'file', pin = false) {
    openSlotViewFile(this, path, type, pin);
  }

  _pinFile(path: string) {
    pinSlotViewFile(this, path);
  }

  // --- Git actions ---

  async _gitAction(method: string, path: string) {
    await runSlotViewGitAction(this, method, path);
  }

  // --- Editing ---

  async _handleTreeAction(detail: { action: string; path: string; type: string }) {
    return await handleSlotViewTreeAction(this, detail);
  }

  async _createNewFile() {
    return await createSlotViewFile(this);
  }

  async _saveFile() {
    await saveSlotViewFile(this);
  }

  // --- UI helpers ---

  _saveLayout() {
    saveLayout({
      sidebarWidth: this._sidebarWidth,
      terminalHeight: this._terminalHeight,
      pinnedHeight: this._pinnedHeight,
      terminalOpen: this._terminalOpen,
      sidebarOpen: this._sidebarOpen,
      sections: this._sections,
      activity: this._activity,
      streamWidth: this._streamWidth,
      reviewPanelWidth: this._reviewPanelWidth,
      selectedAgentContextIds: this._selectedAgentContextIds,
    });
  }

  // --- Resize handlers ---

  _onResizeStart(type: SlotViewResizeType, e: MouseEvent) {
    startSlotViewResize(this, type, e);
  }

  _onResizeMove = (e: MouseEvent) => {
    moveSlotViewResize(this, e);
  };

  _onResizeEnd = () => {
    endSlotViewResize(this);
  };

  _handleBack() {
    handleSlotViewBack(this);
  }

  _slotSwitcherEntries(): SlotSwitcherEntry[] {
    return slotViewSwitcherEntries(this);
  }

  _requestSlotSwitcherUpdate(slots: readonly SlotStatus[]) {
    requestSlotViewSwitcherUpdate(this, slots);
  }

  _hasModalOpen(): boolean {
    return hasSlotViewModalOpen(this);
  }

  _switchSlot(nextSlotId: string) {
    switchSlotViewSlot(this, nextSlotId);
  }

  _switchRelativeSlot(direction: -1 | 1) {
    switchSlotViewRelativeSlot(this, direction);
  }

  async _toggleManual(toManual: boolean) {
    return await toggleSlotViewManualMode(this, toManual);
  }

  _togglePinnedSlot() {
    if (!this.slotId) return;
    togglePinnedSlot(this.slotId);
    this.requestUpdate();
  }

  _renamePinnedSlot() {
    if (!this.slotId) return;
    const label = window.prompt('Pinned slot label (blank to use slot id):', this.slotId);
    if (label === null) return;
    setPinnedSlotLabel(this.slotId, label);
    this.requestUpdate();
  }

  async _pauseRun() {
    return await pauseSlotViewRun(this);
  }

  async _resumeRun() {
    return await resumeSlotViewRun(this);
  }

  _toggleSidebar() {
    toggleSlotViewSidebar(this);
  }

  _setActivity(activity: typeof this._activity) {
    setSlotViewActivity(this, activity);
  }

  _toggleSection(name: string) {
    toggleSlotViewSection(this, name);
  }

  _formatDuration(ms: number): string {
    return formatSlotViewDuration(ms);
  }

  _hasActiveTask(): boolean {
    return hasSlotViewActiveTask(this._structuredProgress, this._taskSteps);
  }

  _shouldShowTaskUI(): boolean {
    return shouldShowSlotViewTaskUi(this._slot, this._structuredProgress, this._taskSteps);
  }

  async _onRunStepReplay(stepName: string, skipPrepare?: boolean, prepareProfile?: string) {
    return await replaySlotViewRunStep(this, stepName, skipPrepare, prepareProfile);
  }

  // --- Render ---

  _renderSidebarFiles() {
    return renderSlotViewSidebarFiles(this);
  }

  _renderSidebarSource() {
    return renderSlotViewSidebarSource(this);
  }

  _renderSidebarInfo() {
    return renderSlotViewSidebarInfo(this);
  }

  _resourceHealthItems(slot: SlotStatus) {
    return slotViewResourceHealthItems(slot);
  }

  _renderSidebarActions() {
    return renderSlotViewSidebarActions(this);
  }

  _renderSidebarTask() {
    return renderSlotViewSidebarTask(this);
  }

  _renderActivityPanel() {
    return renderSlotViewActivityPanel(this);
  }

  _renderChangesPanel() {
    return renderSlotViewChangesPanel(this);
  }

  _renderExplorerPanel() {
    return renderSlotViewExplorerPanel(this);
  }

  async _reloadTree() {
    return await reloadSlotViewTree(this);
  }

  // --- Pinned folder ---

  async _autoPinTaskFolder() {
    return await autoPinSlotViewTaskFolder(this);
  }

  _pinFolder(path: string) {
    pinSlotViewFolder(this, path);
  }

  _unpinFolder() {
    unpinSlotViewFolder(this);
  }

  async _loadPinnedEntries() {
    return await loadSlotViewPinnedEntries(this);
  }

  _handlePinnedDirExpand(path: string) {
    handleSlotViewPinnedDirExpand(this, path);
  }

  async _loadPinnedSubdir(dirPath: string) {
    return await loadSlotViewPinnedSubdir(this, dirPath);
  }

  // --- PR Comments ---

  async _detectPR() {
    return await detectSlotViewPR(this);
  }

  async _loadPRComments() {
    return await loadSlotViewPRComments(this);
  }

  async _loadBranchDiff() {
    return await loadSlotViewBranchDiff(this);
  }

  async _loadBranchList() {
    return await loadSlotViewBranchList(this);
  }

  _handleBranchDiffBaseChange(base: string) {
    handleSlotViewBranchDiffBaseChange(this, base);
  }

  async _handleBranchDiffSelect(path: string, status: string) {
    return await handleSlotViewBranchDiffSelect(this, path, status);
  }

  _openBranchDiffFile(path: string, cacheKey: string) {
    openSlotViewBranchDiffFile(this, path, cacheKey);
  }

  get _branchDiffCommentCounts(): Map<string, number> {
    const map = new Map<string, number>();
    for (const t of this._prThreads) {
      if (!t.resolved) {
        map.set(t.path, (map.get(t.path) ?? 0) + 1);
      }
    }
    return map;
  }

  get _hasBranchChanges(): boolean {
    return this._branchDiffFiles.length > 0;
  }

  _getCommentThreadsForFile(path: string): import('@farmslot/protocol').PRReviewThread[] {
    return slotViewCommentThreadsForFile(this, path);
  }

  async _handleCommentNavigate(detail: { path: string; line: number | null }) {
    await navigateSlotViewComment(this, detail);
  }

  async _handleOpenFile(path: string, line: number) {
    await openSlotViewIndexedFile(this, path, line);
  }

  _handleGlyphClick(line: number) {
    handleSlotViewGlyphClick(this, line);
  }

  // --- Diagnostics ---

  async _runDiagnostics() {
    return await runSlotViewDiagnostics(this);
  }

  async _handleDiagnosticNavigate(detail: { path: string; line: number }) {
    return await handleSlotViewDiagnosticNavigate(this, detail);
  }

  _renderSearchPanel() {
    return renderSearchPanel(this);
  }

  _renderFileSearchResults() {
    return renderFileSearchResults(this);
  }

  _renderContentSearchResults() {
    return renderContentSearchResults(this);
  }

  _renderSourcePanel() {
    return renderSourcePanel(this);
  }

  _renderInfoPanel() {
    return renderSlotViewInfoPanel(this);
  }

  async _executeSearch() {
    return await executeSlotViewSearch(this);
  }

  _openSearchResult(file: string, _line: number) {
    openSlotViewSearchResult(this, file, _line);
  }

  async _loadFileIndex() {
    return await loadSlotViewFileIndex(this);
  }

  _onSearchInput() {
    handleSlotViewSearchInput(this);
  }

  _fuzzyFilterFiles(query: string): string[] {
    return fuzzyFilterSlotViewFiles(this._fileIndex, query);
  }

  _renderEditorHeader() {
    return renderEditorHeader(this);
  }

  _renderEditor() {
    return renderEditor(this);
  }

  override render() {
    const slot = this._slot;
    if (this._loading && !slot) {
      return html`<div style="padding:24px; color:${colors.textMuted}">Loading...</div>`;
    }
    // When no slot data is available (e.g., dev harness with just fileEntries), render workspace only
    const hasSlotData = !!slot;
    const hasResources = this._resources.length > 0;

    const lcColor = hasSlotData ? lifecycleColor(slot!.lifecycle) : colors.statusUnknown;

    return html`
      ${renderSlotViewStyles(this._recoveryPhase)}
      ${renderSlotViewHeader(this, { slot, hasSlotData, hasResources, lcColor })}
      ${hasSlotData
        ? renderSlotPreparePreconditionStrip({
            slot,
            slotBranch: this._git?.branch ?? slot?.branch,
            activePrepareLabel:
              this._activePrepare &&
              (this._activePrepare.running || this._activePrepare.exitCode !== null)
                ? this._activePrepare.label
                : '',
          })
        : nothing}
      ${renderSlotPrepareBanner(this)} ${renderSlotViewBody(this, { hasSlotData, hasResources })}
      <slot-history-modal
        slot-id=${this.slotId}
        .project=${this._slot?.project ?? ''}
        slot-branch=${this._git?.branch ?? this._slot?.branch ?? ''}
        .slotHealth=${this._slot?.health ?? null}
        selected-run-id=${this._historyRunId}
        .open=${this._historyOpen}
        @close=${() => {
          this._historyOpen = false;
          this._historyRunId = '';
          this._syncUrlState();
        }}
      ></slot-history-modal>
      <slot-load-run-modal
        slot-id=${this.slotId}
        .project=${this._slot?.project ?? ''}
        slot-branch=${this._git?.branch ?? this._slot?.branch ?? ''}
        .slotHealth=${this._slot?.health ?? null}
        .open=${this._loadRunOpen}
        @close=${() => {
          this._loadRunOpen = false;
        }}
      ></slot-load-run-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'slot-view': SlotView;
  }
}
