import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  FsListResult,
  FsReadResult,
  GitDiffResult,
  GitStatusResult,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import './file-tree.js';
import './git-changes.js';
import './tab-bar.js';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

import type { FileEntry } from './file-tree.js';
// NOTE: diff-review and code-viewer use createRenderRoot()=>this (no Shadow DOM)
// so they don't work inside slot-workspace's Shadow DOM. We use a plain text
// viewer for file content. Diff rendering uses a simple pre-formatted view.

interface OpenFile {
  path: string;
  type: 'file' | 'diff';
}

interface GitData {
  branch: string;
  ahead: number;
  behind: number;
  changes: Array<{ path: string; status: string; oldPath?: string }>;
}

const QUICK_ACCESS = [
  { path: 'TASK.md', label: 'TASK.md' },
  { path: 'recipe.json', label: 'recipe.json' },
  { path: 'artifacts/', label: 'artifacts/' },
];

@customElement('slot-workspace')
export class SlotWorkspace extends LitElement {
  @property() slotId = '';
  @property({ attribute: false }) fileEntries: FileEntry[] = [];
  @property({ attribute: false }) gitData: GitData | null = null;
  @property({ attribute: false }) fileContents: Map<string, string> = new Map();
  @property({ attribute: false }) diffContents: Map<string, string> = new Map();

  @state() private sidebarTab: 'files' | 'source' = 'files';
  @state() private openFiles: OpenFile[] = [];
  @state() private activeFile = '';
  @state() private bottomPanelOpen = false;

  // Live mode state
  @state() private _liveEntries: FileEntry[] = [];
  @state() private _liveGitData: GitData | null = null;
  @state() private _liveFileContents = new Map<string, string>();
  @state() private _liveDiffContents = new Map<string, string>();
  @state() private _loading = false;
  @state() private _error = '';

  private _gitPollTimer: ReturnType<typeof setInterval> | null = null;
  private _prevSlotId = '';

  private get _isLive(): boolean {
    return this.slotId !== '' && this.fileEntries.length === 0;
  }

  private get _entries(): FileEntry[] {
    return this._isLive ? this._liveEntries : this.fileEntries;
  }

  private get _git(): GitData | null {
    return this._isLive ? this._liveGitData : this.gitData;
  }

  private get _files(): Map<string, string> {
    return this._isLive ? this._liveFileContents : this.fileContents;
  }

  private get _diffs(): Map<string, string> {
    return this._isLive ? this._liveDiffContents : this.diffContents;
  }

  static styles = css`
    :host {
      display: grid;
      grid-template-rows: auto 1fr;
      grid-template-columns: 260px 1fr;
      height: 100%;
      background: ${unsafeCSS(colors.bgBase)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: ${unsafeCSS(fonts.mono)};
      overflow: hidden;
    }

    .workspace-header {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.lg)};
      background: ${unsafeCSS(colors.bgSurface)};
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
      height: 34px;
      box-sizing: border-box;
    }

    .header-slot-id {
      font-size: ${unsafeCSS(fonts.sizeSm)};
      font-weight: 600;
      color: ${unsafeCSS(colors.accent)};
    }

    .quick-access {
      display: flex;
      gap: ${unsafeCSS(spacing.xs)};
      margin-left: ${unsafeCSS(spacing.lg)};
    }

    .quick-btn {
      padding: 2px 8px;
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: ${unsafeCSS(radii.sm)};
      background: transparent;
      color: ${unsafeCSS(colors.textSecondary)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      cursor: pointer;
      transition:
        background 0.1s,
        color 0.1s;
    }
    .quick-btn:hover {
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .sidebar {
      display: flex;
      flex-direction: column;
      background: ${unsafeCSS(colors.bgSurface)};
      border-right: 1px solid ${unsafeCSS(colors.bgCard)};
      overflow: hidden;
      min-width: 0;
    }

    .sidebar-tabs {
      display: flex;
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
      flex-shrink: 0;
    }

    .sidebar-tab {
      flex: 1;
      padding: ${unsafeCSS(spacing.sm)} 0;
      border: none;
      background: transparent;
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 2px solid transparent;
      transition:
        color 0.1s,
        border-color 0.1s;
    }
    .sidebar-tab:hover {
      color: ${unsafeCSS(colors.textSecondary)};
    }
    .sidebar-tab.active {
      color: ${unsafeCSS(colors.accent)};
      border-bottom-color: ${unsafeCSS(colors.accent)};
    }

    .sidebar-content {
      flex: 1;
      overflow-y: auto;
      padding: ${unsafeCSS(spacing.sm)};
    }
    .sidebar-content::-webkit-scrollbar {
      width: 6px;
    }
    .sidebar-content::-webkit-scrollbar-thumb {
      background: ${unsafeCSS(colors.textMuted)};
      border-radius: 3px;
    }

    .editor-area {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 0;
      min-height: 0;
    }

    .editor-content {
      flex: 1;
      overflow: hidden;
      position: relative;
      min-height: 0;
    }

    .editor-content > * {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }

    /* Plain text fallback viewer */
    .plain-viewer {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      overflow: auto;
      padding: ${unsafeCSS(spacing.lg)};
      box-sizing: border-box;
      white-space: pre;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textSecondary)};
      background: ${unsafeCSS(colors.bgBase)};
      line-height: 1.5;
      tab-size: 2;
    }

    .empty-editor {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }

    .bottom-panel {
      border-top: 1px solid ${unsafeCSS(colors.bgCard)};
      background: ${unsafeCSS(colors.bgSurface)};
    }

    .bottom-toggle {
      display: flex;
      align-items: center;
      padding: ${unsafeCSS(spacing.xs)} ${unsafeCSS(spacing.lg)};
      cursor: pointer;
      user-select: none;
    }
    .bottom-toggle span {
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .bottom-body {
      height: 150px;
      padding: ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.lg)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textMuted)};
      overflow-y: auto;
    }
  `;

  updated(changed: Map<string, unknown>) {
    if (changed.has('slotId') && this.slotId !== this._prevSlotId) {
      this._prevSlotId = this.slotId;
      if (this._isLive) {
        this._initLive();
      } else {
        this._teardownLive();
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._teardownLive();
  }

  private async _initLive() {
    this._teardownLive();
    this._loading = true;
    this._error = '';
    this._liveEntries = [];
    this._liveGitData = null;
    this._liveFileContents = new Map();
    this._liveDiffContents = new Map();

    try {
      const [fsResult, gitResult] = await Promise.all([
        gateway.request<FsListResult>(Methods.FS_LIST, { slotId: this.slotId, path: '.' }),
        gateway.request<GitStatusResult>(Methods.GIT_STATUS, { slotId: this.slotId }),
      ]);
      this._liveEntries = fsResult.entries;
      this._liveGitData = {
        branch: gitResult.branch,
        ahead: gitResult.ahead,
        behind: gitResult.behind,
        changes: gitResult.changes,
      };
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to load workspace';
    } finally {
      this._loading = false;
    }

    // Poll git status every 30s
    this._gitPollTimer = setInterval(() => this._refreshGitStatus(), 30_000);
  }

  private _teardownLive() {
    if (this._gitPollTimer) {
      clearInterval(this._gitPollTimer);
      this._gitPollTimer = null;
    }
  }

  private async _refreshGitStatus() {
    if (!this._isLive) return;
    try {
      const result = await gateway.request<GitStatusResult>(Methods.GIT_STATUS, {
        slotId: this.slotId,
      });
      this._liveGitData = {
        branch: result.branch,
        ahead: result.ahead,
        behind: result.behind,
        changes: result.changes,
      };
    } catch {
      // Silently ignore poll failures
    }
  }

  private async _loadDirectory(dirPath: string) {
    try {
      const result = await gateway.request<FsListResult>(Methods.FS_LIST, {
        slotId: this.slotId,
        path: dirPath,
      });
      this._liveEntries = this._updateTreeChildren(this._liveEntries, dirPath, result.entries);
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to load directory';
    }
  }

  private _updateTreeChildren(
    entries: FileEntry[],
    targetPath: string,
    children: FileEntry[],
  ): FileEntry[] {
    if (targetPath === '.') return children;
    return entries.map((e) => {
      if (e.path === targetPath) {
        return { ...e, children };
      }
      if (e.children && targetPath.startsWith(e.path + '/')) {
        return { ...e, children: this._updateTreeChildren(e.children, targetPath, children) };
      }
      return e;
    });
  }

  private async _handleFileSelect(path: string) {
    if (this._isLive && !this._liveFileContents.has(path)) {
      try {
        const result = await gateway.request<FsReadResult>(Methods.FS_READ, {
          slotId: this.slotId,
          path,
        });
        const next = new Map(this._liveFileContents);
        next.set(path, result.content);
        this._liveFileContents = next;
      } catch (err) {
        const next = new Map(this._liveFileContents);
        next.set(path, `Error: ${err instanceof Error ? err.message : 'Failed to read file'}`);
        this._liveFileContents = next;
      }
    }
    this._openFile(path, 'file');
  }

  private async _handleChangeSelect(path: string) {
    if (this._isLive && !this._liveDiffContents.has(path)) {
      try {
        const result = await gateway.request<GitDiffResult>(Methods.GIT_DIFF, {
          slotId: this.slotId,
          path,
        });
        const next = new Map(this._liveDiffContents);
        next.set(path, result.diff);
        this._liveDiffContents = next;
      } catch (err) {
        const next = new Map(this._liveDiffContents);
        next.set(path, `Error: ${err instanceof Error ? err.message : 'Failed to load diff'}`);
        this._liveDiffContents = next;
      }
    }
    this._openFile(path, 'diff');
  }

  private _handleDirExpand(path: string) {
    if (this._isLive) {
      this._loadDirectory(path);
    }
  }

  private _openFile(path: string, type: 'file' | 'diff' = 'file') {
    const exists = this.openFiles.find((f) => f.path === path);
    if (!exists) {
      this.openFiles = [...this.openFiles, { path, type }];
    }
    this.activeFile = path;
  }

  private _renderSidebar() {
    if (this._loading) {
      return html`<div
        style="padding: ${spacing.lg}; color: ${colors.textMuted}; font-size: ${fonts.sizeSm}"
      >
        Loading...
      </div>`;
    }
    if (this._error) {
      return html`<div
        style="padding: ${spacing.lg}; color: ${colors.statusFail}; font-size: ${fonts.sizeSm}"
      >
        ${this._error}
      </div>`;
    }

    if (this.sidebarTab === 'files') {
      return html`<file-tree
        .entries=${this._entries}
        @file-select=${(e: CustomEvent) => this._handleFileSelect(e.detail.path)}
        @dir-expand=${(e: CustomEvent) => this._handleDirExpand(e.detail.path)}
      ></file-tree>`;
    }

    const git = this._git;
    if (!git) {
      return html`<div
        style="padding: ${spacing.lg}; color: ${colors.textMuted}; font-size: ${fonts.sizeSm}"
      >
        No git data
      </div>`;
    }

    return html`<git-changes
      .changes=${git.changes}
      .branch=${git.branch}
      .ahead=${git.ahead}
      .behind=${git.behind}
      @change-select=${(e: CustomEvent) => this._handleChangeSelect(e.detail.path)}
    ></git-changes>`;
  }

  private _renderEditor() {
    if (!this.activeFile) {
      return html`<div class="empty-editor">Select a file to view</div>`;
    }

    const tab = this.openFiles.find((f) => f.path === this.activeFile);
    if (!tab) {
      return html`<div class="empty-editor">Select a file to view</div>`;
    }

    if (tab.type === 'diff') {
      const diff = this._diffs.get(this.activeFile) ?? '';
      return this._renderDiffView(diff);
    }

    const content = this._files.get(this.activeFile) ?? '';
    return html`<div class="plain-viewer">${content || 'Empty file'}</div>`;
  }

  private _renderDiffView(diff: string) {
    if (!diff) return html`<div class="empty-editor">No diff available</div>`;
    // Render diff as color-coded pre-formatted text (no Shadow DOM issues)
    const lines = diff.split('\n');
    return html`<div class="plain-viewer">
      ${lines.map((line) => {
        let color: string = colors.textSecondary;
        if (line.startsWith('+') && !line.startsWith('+++')) color = colors.statusOk;
        else if (line.startsWith('-') && !line.startsWith('---')) color = colors.statusFail;
        else if (line.startsWith('@@')) color = colors.accent;
        else if (line.startsWith('diff') || line.startsWith('index')) color = colors.textMuted;
        return html`<div style="color: ${color}">${line}</div>`;
      })}
    </div>`;
  }

  render() {
    return html`
      <div class="workspace-header">
        <span class="header-slot-id">${this.slotId || 'workspace'}</span>
        <div class="quick-access">
          ${QUICK_ACCESS.map(
            (qa) => html`
              <button class="quick-btn" @click=${() => this._handleFileSelect(qa.path)}>
                ${qa.label}
              </button>
            `,
          )}
        </div>
      </div>

      <div class="sidebar">
        <div class="sidebar-tabs">
          <button
            class="sidebar-tab ${this.sidebarTab === 'files' ? 'active' : ''}"
            @click=${() => {
              this.sidebarTab = 'files';
            }}
          >
            Files
          </button>
          <button
            class="sidebar-tab ${this.sidebarTab === 'source' ? 'active' : ''}"
            @click=${() => {
              this.sidebarTab = 'source';
            }}
          >
            Source
          </button>
        </div>
        <div class="sidebar-content">${this._renderSidebar()}</div>
      </div>

      <div class="editor-area">
        <tab-bar
          .tabs=${this.openFiles}
          .activeTab=${this.activeFile}
          @tab-select=${(e: CustomEvent) => {
            this.activeFile = e.detail.path;
          }}
          @tab-close=${(e: CustomEvent) => {
            const path = e.detail.path;
            const next = this.openFiles.filter((f) => f.path !== path);
            this.openFiles = next;
            if (this.activeFile === path) {
              this.activeFile = next.length > 0 ? next[next.length - 1].path : '';
            }
          }}
        ></tab-bar>
        <div class="editor-content">${this._renderEditor()}</div>
        <div class="bottom-panel">
          <div
            class="bottom-toggle"
            @click=${() => {
              this.bottomPanelOpen = !this.bottomPanelOpen;
            }}
          >
            <span>${this.bottomPanelOpen ? '\u25BE' : '\u25B8'} Metro logs</span>
          </div>
          ${this.bottomPanelOpen
            ? html`<div class="bottom-body">Metro log output will appear here (M6.5)</div>`
            : nothing}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'slot-workspace': SlotWorkspace;
  }
}
