import { html, nothing } from 'lit';

import { agentRoleShortLabel } from '@farmslot/protocol';

import { getState } from '../../state.js';
import { colors, fonts, spacing } from '../../styles/theme-tokens.js';
import { buildRerunAlongsideHref, canReplayRunSteps } from '../runs/run-detail-model.js';
import { isTerminalRunStatus, routeForRun, runStatusColor } from '../runs/run-utils.js';

import type { SlotView } from './slot-view.js';
import { realPath, slotBoundRunIdForSlot, slotViewTerminalRunId } from './slot-view-model.js';
import { slotViewEffectiveTerminalHeight } from './slot-view-resize-effects.js';
import { requestedRunFromHash } from './slot-view-url-state.js';

export interface SlotViewBodyRenderContext {
  hasResources: boolean;
}

export function renderSlotViewTaskBreadcrumb(view: SlotView) {
  const contexts = view._agentContexts();
  if (contexts.length < 2) return nothing;
  const selected = view._selectedAgentContext();
  return html`
    <div class="sv-task-breadcrumb" aria-label="Role pipeline">
      ${contexts.map((ctx, i) => {
        const isActive = selected?.id === ctx.id;
        const dead = view._isContextUnavailable(ctx);
        const cls = ['sv-task-crumb'];
        if (isActive) cls.push('active');
        if (dead) cls.push('disabled');
        return html`
          ${i > 0 ? html`<span class="sv-task-crumb-sep">›</span>` : nothing}
          <button
            class="${cls.join(' ')}"
            ?disabled=${isActive || dead}
            title="${ctx.label || ctx.role}${dead ? ' — tmux unavailable' : ''}"
            @click=${() => view._selectAgentContext(ctx)}
          >
            ${agentRoleShortLabel(ctx.role)}
          </button>
        `;
      })}
    </div>
  `;
}

export function renderSlotViewAgentContexts(view: SlotView) {
  const contexts = view._agentContexts();
  if (contexts.length === 0) return nothing;
  const selected = view._selectedAgentContext();
  const totalSteps = view._structuredProgress?.totalSteps ?? view._taskSteps.length;
  const doneSteps =
    view._structuredProgress?.completedSteps ?? view._taskSteps.filter((s) => s.checked).length;
  return html`
    <div class="sv-agent-contexts" aria-label="Agent roles">
      ${contexts.map((ctx) => {
        const dead = view._isContextUnavailable(ctx);
        const isActive = selected?.id === ctx.id;
        const showCount = isActive && totalSteps > 0;
        const cls = ['sv-agent-context'];
        if (isActive) cls.push('active');
        if (dead) cls.push('disabled');
        const tooltip = dead
          ? 'tmux window unavailable — terminal not attachable'
          : (ctx.target?.target ?? ctx.signalFile ?? ctx.taskFile ?? ctx.label);
        return html`
          <button
            class="${cls.join(' ')}"
            title="${tooltip}"
            ?disabled=${dead}
            aria-disabled=${dead}
            @click=${() => view._selectAgentContext(ctx)}
          >
            <span class="sv-agent-role">${ctx.label || ctx.role}</span>
            <span class="sv-agent-status">${dead ? 'unavailable' : ctx.status}</span>
            ${showCount
              ? html`<span class="sv-agent-count">${doneSteps}/${totalSteps}</span>`
              : nothing}
            ${ctx.taskFile
              ? html`<span class="sv-agent-task">${ctx.taskFile.split('/').pop()}</span>`
              : nothing}
          </button>
        `;
      })}
    </div>
  `;
}

export function renderSlotViewSidebarFiles(view: SlotView) {
  if (view._wsLoading) {
    return html`<div
      style="padding: ${spacing.lg}; color: ${colors.textMuted}; font-size: ${fonts.sizeSm}"
    >
      Loading...
    </div>`;
  }
  if (view._wsError) {
    return html`<div
      style="padding: ${spacing.lg}; color: ${colors.statusFail}; font-size: ${fonts.sizeSm}"
    >
      ${view._wsError}
    </div>`;
  }
  return html`<file-tree
    .entries=${view._entries}
    .gitStatus=${view._gitStatusMap}
    .selectedPath=${realPath(view._activeFile)}
    @file-select=${(e: CustomEvent) => view._handleFileSelect(e.detail.path)}
    @file-pin=${(e: CustomEvent) => {
      view._handleFileSelect(e.detail.path);
      view._pinFile(e.detail.path);
    }}
    @dir-expand=${(e: CustomEvent) => view._handleDirExpand(e.detail.path)}
    @tree-action=${(e: CustomEvent) => view._handleTreeAction(e.detail)}
  ></file-tree>`;
}

export function renderSlotViewSidebarSource(view: SlotView) {
  const git = view._git;
  if (!git) {
    return html`<div
      style="padding: ${spacing.lg}; color: ${colors.textMuted}; font-size: ${fonts.sizeSm}"
    >
      No git data
    </div>`;
  }
  return html`<git-changes
    .changes=${git.changes}
    .committedFiles=${view._branchDiffFiles}
    .branch=${git.branch}
    .ahead=${git.ahead}
    .behind=${git.behind}
    .branchDiffBase=${view._branchDiffBase}
    .selectedPath=${realPath(view._activeFile)}
    @change-select=${(e: CustomEvent) => view._handleChangeSelect(e.detail.path, e.detail.status)}
    @committed-select=${(e: CustomEvent) =>
      view._handleBranchDiffSelect(e.detail.path, e.detail.status)}
    @git-stage=${(e: CustomEvent) => view._gitAction('git.stage', e.detail.path)}
    @git-unstage=${(e: CustomEvent) => view._gitAction('git.unstage', e.detail.path)}
    @git-discard=${(e: CustomEvent) => view._gitAction('git.discard', e.detail.path)}
  ></git-changes>`;
}

export function renderSlotViewSidebarActions(view: SlotView) {
  // Shared <slot-actions-panel> owns built-in lifecycle actions (Prepare,
  // Release, Refresh, Recycle, Cleanup) plus configured slot_actions —
  // including their live output streaming. Same component is used by the
  // fleet-view actions modal so behavior stays consistent.
  return html`<slot-actions-panel slot-id=${view.slotId}></slot-actions-panel>`;
}

export function renderSlotViewSidebarTask(view: SlotView) {
  const slot = view._slot;
  if (!slot || !view._shouldShowTaskUI()) {
    return html`<div
      style="padding: ${spacing.sm}; color: ${colors.textMuted}; font-size: ${fonts.sizeXs}"
    >
      No active task
    </div>`;
  }

  const breadcrumb = view._renderTaskBreadcrumb();

  // Structured progress (phase accordion) when available
  if (view._structuredProgress) {
    return html`
      ${breadcrumb}
      <progress-tracker .structured=${view._structuredProgress}></progress-tracker>
    `;
  }

  // Fallback to flat step list
  if (view._taskSteps.length === 0) {
    return html`
      ${breadcrumb}
      <div style="padding: ${spacing.sm}; color: ${colors.textMuted}; font-size: ${fonts.sizeXs}">
        No active task
      </div>
    `;
  }

  return html`
    ${breadcrumb}
    <div class="sv-task-header">Progress ${Math.round(view._taskProgress * 100)}%</div>
    <div class="sv-progress-bar">
      <div class="sv-progress-fill" style="width:${view._taskProgress * 100}%"></div>
    </div>
    ${view._taskSteps.map(
      (step) => html`
        <div class="sv-task-step">
          <div class="sv-task-checkbox ${step.checked ? 'checked' : ''}">
            ${step.checked ? '\u2713' : ''}
          </div>
          <span class="sv-task-text ${step.checked ? 'checked' : ''}">${step.text}</span>
        </div>
      `,
    )}
  `;
}

export function renderSlotViewActivityPanel(view: SlotView) {
  switch (view._activity) {
    case 'explorer':
      return view._renderExplorerPanel();
    case 'search':
      return view._renderSearchPanel();
    case 'source':
      return view._renderSourcePanel();
    case 'changes':
      return view._renderChangesPanel();
    case 'info':
      return view._renderInfoPanel();
  }
}

export function renderSlotViewChangesPanel(view: SlotView) {
  if (view._branchDiffLoading) {
    return html`<div style="padding: 12px; color: ${colors.textMuted}; font-size: ${fonts.sizeSm}">
      Loading branch diff...
    </div>`;
  }
  return html`<branch-changed-files
    .files=${view._branchDiffFiles}
    .base=${view._branchDiffBase}
    .head=${view._branchDiffHead}
    .totalAdditions=${view._branchDiffTotalAdd}
    .totalDeletions=${view._branchDiffTotalDel}
    .commentCounts=${view._branchDiffCommentCounts}
    .selectedPath=${view._activeFile}
    .branches=${view._branchDiffBranches}
    @file-select=${(e: CustomEvent) => view._handleBranchDiffSelect(e.detail.path, e.detail.status)}
    @base-change=${(e: CustomEvent) => view._handleBranchDiffBaseChange(e.detail.base)}
  ></branch-changed-files>`;
}

export function renderSlotViewExplorerPanel(view: SlotView) {
  return html`
    <div class="sv-explorer-filters">
      <button
        class="sv-filter-btn ${view._showIgnored ? 'active' : ''}"
        title="Show gitignored files"
        @click=${() => {
          view._showIgnored = !view._showIgnored;
          view._reloadTree();
        }}
      >
        ignored
      </button>
    </div>
    ${view._renderSidebarFiles()}
  `;
}

export function renderSlotViewBody(view: SlotView, { hasResources }: SlotViewBodyRenderContext) {
  return html`
    <!-- Body: activity bar + sidebar + editor -->
    <div class="sv-body">
      ${view._isRecoveryBlocked
        ? html`
            <div class="sv-recovery-overlay" role="status" aria-live="polite">
              <div class="sv-recovery-card">
                <div class="sv-recovery-eyebrow">
                  ${view._recoveryPhase === 'error'
                    ? 'Recovery blocked'
                    : view._recoveryPhase === 'stale'
                      ? 'Connection lost'
                      : 'Recovering from gateway'}
                </div>
                <div class="sv-recovery-title">
                  ${view._recoveryPhase === 'error'
                    ? 'Workspace recovery needs a retry'
                    : 'Workspace is reconnecting'}
                </div>
                <div class="sv-recovery-copy">
                  ${view._recoveryMessage || 'Refreshing slot data from gateway…'}
                </div>
                <div class="sv-recovery-meta">
                  Gateway remains the source of truth. Local view state is preserved and the
                  workspace will unblock when rehydration completes.
                </div>
                ${view._canRetryRecovery
                  ? html`
                      <div class="sv-recovery-actions">
                        <button class="sv-recovery-btn" @click=${() => view._retryRecovery()}>
                          Retry now
                        </button>
                      </div>
                    `
                  : nothing}
              </div>
            </div>
          `
        : nothing}
      <!-- Activity bar -->
      <div class="sv-activity-bar">
        <button
          class="sv-activity-btn ${view._activity === 'explorer' && view._sidebarOpen
            ? 'active'
            : ''}"
          title="Explorer (Cmd+B)"
          @click=${() => {
            view._setActivity('explorer');
          }}
        >
          ☰
        </button>
        <button
          class="sv-activity-btn ${view._activity === 'search' && view._sidebarOpen
            ? 'active'
            : ''}"
          title="Search (Cmd+B)"
          @click=${() => {
            view._setActivity('search');
          }}
        >
          ⌕
        </button>
        <button
          class="sv-activity-btn ${view._activity === 'source' && view._sidebarOpen
            ? 'active'
            : ''}"
          title="Source Control (Cmd+B)"
          @click=${() => {
            view._setActivity('source');
          }}
        >
          ◎
          ${view._git && view._git.changes.length > 0
            ? html` <span class="sv-activity-badge">${view._git.changes.length}</span> `
            : ''}
        </button>
        ${view._hasBranchChanges
          ? html`
              <button
                class="sv-activity-btn ${view._activity === 'changes' && view._sidebarOpen
                  ? 'active'
                  : ''}"
                title="Branch Changes (Cmd+B)"
                @click=${() => {
                  view._setActivity('changes');
                }}
              >
                Δ
                <span class="sv-activity-badge">${view._branchDiffFiles.length}</span>
              </button>
            `
          : ''}
        <button
          class="sv-activity-btn ${view._activity === 'info' && view._sidebarOpen ? 'active' : ''}"
          title="Info & Actions (Cmd+B)"
          @click=${() => {
            view._setActivity('info');
          }}
        >
          ℹ
        </button>
      </div>

      <!-- Sidebar panel for active activity -->
      ${view._sidebarOpen
        ? html`
            <div class="sv-sidebar" style="width:${view._sidebarWidth}px">
              <div
                class="sv-sidebar-content ${view._activity === 'source' ? 'sv-source-layout' : ''}"
              >
                ${view._renderActivityPanel()}
              </div>
            </div>

            <!-- Sidebar resize handle -->
            <div
              class="sv-resize-h ${view._resizing === 'sidebar' ? 'active' : ''}"
              @mousedown=${(e: MouseEvent) => view._onResizeStart('sidebar', e)}
            ></div>
          `
        : nothing}

      <!-- Right column: editor + terminal stacked vertically -->
      <div class="sv-right-col">
        <!-- New file prompt (Cmd+N) -->
        ${view._newFilePrompt
          ? html`
              <div class="sv-new-file-bar">
                <span class="sv-new-file-label">New file:</span>
                <input
                  class="sv-new-file-input"
                  type="text"
                  placeholder="path/to/file.md (relative to repo root)"
                  .value=${view._newFilePath}
                  @input=${(e: InputEvent) => {
                    view._newFilePath = (e.target as HTMLInputElement).value;
                  }}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter') view._createNewFile();
                    if (e.key === 'Escape') {
                      view._newFilePrompt = false;
                    }
                  }}
                />
                <button class="sv-new-file-ok" @click=${() => view._createNewFile()}>Create</button>
                <button
                  class="sv-new-file-cancel"
                  @click=${() => {
                    view._newFilePrompt = false;
                  }}
                >
                  Cancel
                </button>
              </div>
            `
          : nothing}

        <!-- Editor row: editor + optional resource panel side by side -->
        <div class="sv-editor-row">
          <div class="sv-editor" style="${view._reviewFullWidth ? 'display:none' : ''}">
            <div class="sv-tab-row">
              <tab-bar
                .tabs=${view._openFiles}
                .activeTab=${view._activeFile}
                @tab-select=${(e: CustomEvent) => {
                  view._activeFile = e.detail.path;
                }}
                @tab-pin=${(e: CustomEvent) => {
                  view._pinFile(e.detail.path);
                }}
                @tab-close=${(e: CustomEvent) => {
                  const path = e.detail.path;
                  const next = view._openFiles.filter((f) => f.path !== path);
                  view._openFiles = next;
                  if (view._activeFile === path) {
                    view._activeFile = next.length > 0 ? next[next.length - 1].path : '';
                  }
                }}
              ></tab-bar>
              <button
                class="sv-new-file-btn"
                title="New file"
                @click=${() => {
                  view._newFilePrompt = true;
                  view._newFilePath = '';
                }}
              >
                +
              </button>
            </div>
            ${view._renderEditorHeader()}
            <div class="sv-editor-content">${view._renderEditor()}</div>
          </div>
          <!-- Resource panel (right of editor, same height) -->
          ${!view._reviewFullWidth && (hasResources || view._resourcePanelOpen)
            ? html`
                ${view._resourcePanelOpen
                  ? html`
                      <div
                        class="sv-resize-h ${view._resizing === 'stream' ? 'active' : ''}"
                        @mousedown=${(e: MouseEvent) => view._onResizeStart('stream', e)}
                      ></div>
                      <div class="sv-stream-col" style="width:${view._streamWidth}px">
                        <resource-panel
                          .slotId=${view.slotId}
                          .resources=${view._resources}
                          .actions=${view._resourcePanelActions()}
                          .runningActionIds=${view._runningSlotActionIds}
                          @resource-streams-changed=${(e: CustomEvent<{ activeIds: string[] }>) => {
                            view._activeResourceId =
                              e.detail.activeIds[0] ?? view._requestedResourceFromUrl() ?? '';
                          }}
                          @slot-action-run=${(e: CustomEvent<{ actionId: string }>) =>
                            view._runConfiguredSlotAction(e.detail.actionId)}
                          @panel-close=${() => view._onResourcePanelClose()}
                          style="height:100%"
                        ></resource-panel>
                      </div>
                    `
                  : html`
                      <div
                        class="sv-stream-collapsed"
                        @click=${() => {
                          view._resourcePanelOpen = true;
                          view._saveLayout();
                          view._syncUrlState();
                        }}
                        title="Open resource streams"
                      >
                        <span class="sv-stream-collapsed-label">STREAMS</span>
                      </div>
                    `}
              `
            : ''}
          ${(() => {
            if (view._reviewFullWidth || !view._taskPanelOpen) return nothing;
            const ctx = view._selectedAgentContext();
            const ctxLabel = ctx ? ctx.label || ctx.role : '';
            const totalSteps = view._structuredProgress?.totalSteps ?? view._taskSteps.length;
            const doneSteps =
              view._structuredProgress?.completedSteps ??
              view._taskSteps.filter((s) => s.checked).length;
            return html`
              <div class="sv-task-panel-col" style="width:${view._taskPanelWidth}px">
                <div class="sv-task-panel-header" title="${ctx?.taskFile ?? ''}">
                  <span>TASK</span>
                  ${ctxLabel ? html`<span class="sv-task-panel-role">${ctxLabel}</span>` : ''}
                  ${totalSteps > 0
                    ? html`
                        <span style="color:${colors.textMuted}">${doneSteps}/${totalSteps}</span>
                      `
                    : ''}
                  <button
                    class="sv-task-panel-close"
                    @click=${() => {
                      view._taskPanelOpen = false;
                    }}
                  >
                    ×
                  </button>
                </div>
                <div class="sv-task-panel-body">
                  ${view._hasActiveTask()
                    ? view._renderSidebarTask()
                    : html`<div
                        style="padding:24px 16px; color:${colors.textMuted}; font-size:${fonts.sizeXs}; text-align:center"
                      >
                        No active task
                      </div>`}
                </div>
              </div>
            `;
          })()}
          ${view._reviewFullWidth || view._taskPanelOpen
            ? nothing
            : html`
                <div
                  class="sv-stream-collapsed"
                  @click=${() => {
                    view._taskPanelOpen = true;
                  }}
                  title="Open task progress"
                >
                  <span class="sv-stream-collapsed-label">TASK</span>
                </div>
              `}

          <!-- Recipe/review panel (right drawer, shown when recipe context exists or review is pending) -->
          ${view._renderSlotRecipePanel()}
        </div>

        <!-- Run pipeline panel (collapsible, above terminal) -->
        ${view._linkedRun
          ? html`
              <div class="sv-run-panel">
                <div
                  class="sv-run-bar"
                  @click=${() => {
                    view._runPanelOpen = !view._runPanelOpen;
                  }}
                >
                  <span style="font-weight:600;color:${colors.textPrimary}">RUN</span>
                  <span
                    style="padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;background:${runStatusColor(
                      view._linkedRun.status,
                    )}22;color:${runStatusColor(view._linkedRun.status)}"
                    >${view._linkedRun.status}</span
                  >
                  <span
                    style="color:${colors.textMuted};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                    >${view._linkedRun.summary || view._linkedRun.ticketOrPr}</span
                  >
                  ${view._linkedRun.metrics.durationMs
                    ? html`<span style="color:${colors.textMuted}"
                        >${view._formatDuration(view._linkedRun.metrics.durationMs)}</span
                      >`
                    : nothing}
                  <a
                    class="sv-run-link"
                    href=${`#${routeForRun(view._linkedRun)}`}
                    @click=${(e: Event) => e.stopPropagation()}
                    >open detail</a
                  >
                  <span style="color:${colors.textMuted};width:12px;text-align:center"
                    >${view._runPanelOpen ? '\u25BE' : '\u25B8'}</span
                  >
                </div>
                ${view._runPanelOpen
                  ? html`
                      <div class="sv-run-body">
                        <div class="sv-run-actions">
                          <a class="sv-run-action" href=${`#${routeForRun(view._linkedRun)}`}>
                            Open full run detail
                          </a>
                          <a
                            class="sv-run-action muted"
                            href=${`#family/${view._linkedRun.familyId}?run=${encodeURIComponent(
                              view._linkedRun.id,
                            )}`}
                          >
                            Retrospective / evidence
                          </a>
                          ${isTerminalRunStatus(view._linkedRun.status)
                            ? html`
                                <a
                                  class="sv-run-action accent"
                                  href=${buildRerunAlongsideHref(view._linkedRun)}
                                  title="Fork a new comparison run from this one (own slot + worker) to compare runners/models side by side. Opens the dispatch wizard prefilled; the original run is untouched."
                                >
                                  Re-run alongside →
                                </a>
                              `
                            : nothing}
                        </div>
                        <run-pipeline
                          .run=${view._linkedRun}
                          @step-select=${(e: CustomEvent) => {
                            view._runPanelSelectedStep = e.detail.step;
                          }}
                        >
                        </run-pipeline>
                        ${view._runPanelSelectedStep
                          ? html`
                              <step-inspector
                                .step=${view._runPanelSelectedStep}
                                .run=${view._linkedRun}
                                .allowReplay=${canReplayRunSteps(
                                  view._linkedRun,
                                  view._isRecoveryBlocked,
                                )}
                                @inspector-close=${() => {
                                  view._runPanelSelectedStep = null;
                                }}
                                @step-replay=${(e: CustomEvent) =>
                                  view._onRunStepReplay(
                                    e.detail.stepName,
                                    e.detail.skipPrepare,
                                    e.detail.prepareProfile,
                                  )}
                              >
                              </step-inspector>
                            `
                          : nothing}
                      </div>
                    `
                  : nothing}
              </div>
            `
          : nothing}

        <!-- Bottom panel (Terminal / Problems / Comments) -->
        ${view.slotId
          ? html`
              ${view._terminalOpen
                ? html`
                    <div
                      class="sv-resize-v ${view._resizing === 'terminal' ? 'active' : ''}"
                      @mousedown=${(e: MouseEvent) => view._onResizeStart('terminal', e)}
                    ></div>
                  `
                : nothing}
              <div class="sv-terminal-panel">
                <div
                  class="sv-bottom-tabs"
                  style="cursor:pointer"
                  @click=${(e: MouseEvent) => {
                    if (!(e.target as Element).closest('button')) {
                      view._terminalOpen = !view._terminalOpen;
                      view._saveLayout();
                    }
                  }}
                >
                  <button
                    class="sv-bottom-tab ${view._bottomTab === 'terminal' ? 'active' : ''}"
                    @click=${() => {
                      view._bottomTab = 'terminal';
                      view._terminalOpen = true;
                      view._saveLayout();
                    }}
                  >
                    Terminal
                  </button>
                  <button
                    class="sv-bottom-tab ${view._bottomTab === 'problems' ? 'active' : ''}"
                    @click=${() => {
                      view._bottomTab = 'problems';
                      view._terminalOpen = true;
                      view._saveLayout();
                    }}
                  >
                    Problems
                    ${view._diagnostics.length > 0
                      ? html`<span
                          class="sv-bottom-tab-badge ${view._diagnostics.some(
                            (d) => d.severity === 'error',
                          )
                            ? 'error'
                            : 'warn'}"
                          >${view._diagnostics.length}</span
                        >`
                      : ''}
                  </button>
                  ${view._prNumber
                    ? html`
                        <button
                          class="sv-bottom-tab ${view._bottomTab === 'comments' ? 'active' : ''}"
                          @click=${() => {
                            view._bottomTab = 'comments';
                            view._terminalOpen = true;
                            view._saveLayout();
                          }}
                        >
                          Comments
                          ${view._prThreads.length > 0
                            ? html`<span class="sv-bottom-tab-badge"
                                >${view._prThreads.filter((t) => !t.resolved).length}</span
                              >`
                            : ''}
                        </button>
                      `
                    : ''}
                  <button
                    class="sv-bottom-collapse"
                    @click=${() => {
                      view._terminalOpen = !view._terminalOpen;
                      view._saveLayout();
                    }}
                    title="${view._terminalOpen ? 'Collapse' : 'Expand'}"
                  >
                    ${view._terminalOpen ? '\u25BE' : '\u25B8'}
                  </button>
                </div>
                ${view._terminalOpen
                  ? html`
                      <div
                        class="sv-terminal-body"
                        style="height:${slotViewEffectiveTerminalHeight(view)}px"
                      >
                        ${view._bottomTab === 'terminal'
                          ? html`
                              ${view._renderAgentContexts()}
                              <terminal-view
                                .slotId=${view.slotId}
                                .runId=${slotViewTerminalRunId(
                                  view.slotId,
                                  view._linkedRun,
                                  requestedRunFromHash(),
                                  slotBoundRunIdForSlot(
                                    view.slotId,
                                    view._slot?.currentRunId,
                                    getState().fleet?.slots,
                                  ),
                                )}
                                .role=${view._selectedAgentContext()?.role === 'primary'
                                  ? ''
                                  : (view._selectedAgentContext()?.role ?? '')}
                                .contextId=${view._selectedAgentContext()?.id === 'primary'
                                  ? ''
                                  : (view._selectedAgentContext()?.id ?? '')}
                                @terminal-subscribe-failed=${(
                                  e: CustomEvent<{ contextId?: string; role?: string }>,
                                ) => {
                                  const selected = view._selectedAgentContext();
                                  const key =
                                    e.detail?.contextId ||
                                    (selected
                                      ? view._contextKey(selected)
                                      : e.detail?.role
                                        ? `${e.detail.role}:${view.slotId}`
                                        : '');
                                  if (!key) return;
                                  const next = new Set(view._unavailableContextKeys);
                                  next.add(key);
                                  view._unavailableContextKeys = next;
                                }}
                              ></terminal-view>
                            `
                          : view._bottomTab === 'comments'
                            ? html`
                                <pr-comments-panel
                                  .threads=${view._prThreads}
                                  .pr=${view._prNumber ?? 0}
                                  .repo=${view._prRepo ?? ''}
                                  .currentUser=${view._prCurrentUser}
                                  .loading=${view._prCommentsLoading}
                                  @comment-navigate=${(e: CustomEvent) =>
                                    view._handleCommentNavigate(e.detail)}
                                  @thread-resolved=${() => view._loadPRComments()}
                                ></pr-comments-panel>
                              `
                            : html`
                                <problems-panel
                                  .diagnostics=${view._diagnostics}
                                  .loading=${view._diagnosticsLoading}
                                  .truncated=${view._diagnosticsTruncated}
                                  @diagnostic-navigate=${(e: CustomEvent) =>
                                    view._handleDiagnosticNavigate(e.detail)}
                                  @diagnostics-refresh=${() => view._runDiagnostics()}
                                ></problems-panel>
                              `}
                      </div>
                    `
                  : nothing}
              </div>
            `
          : ''}
      </div>
    </div>
  `;
}
