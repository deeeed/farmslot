import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

// Local types (protocol types not imported in isolated phase)
type GitChangeStatus = 'M' | 'A' | 'D' | '?' | 'R';
interface GitChange {
  path: string;
  status: GitChangeStatus;
  staged: boolean;
  oldPath?: string;
}

type BranchDiffStatus = 'M' | 'A' | 'D' | 'R';
interface BranchDiffFile {
  path: string;
  status: BranchDiffStatus;
  oldPath?: string;
  additions: number;
  deletions: number;
}

type FileListViewMode = 'tree' | 'list';

interface ChangeTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children: ChangeTreeNode[];
  count: number;
  additions: number;
  deletions: number;
  change?: GitChange;
  committedFile?: BranchDiffFile;
}

function statusColor(status: GitChangeStatus): string {
  switch (status) {
    case 'M':
      return '#6366f1';
    case 'A':
      return '#00ff88';
    case 'D':
      return '#ff4444';
    case '?':
      return '#888';
    case 'R':
      return '#ffcc00';
  }
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

function dirname(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/') + '/';
}

function buildChangeTree(args: {
  changes?: GitChange[];
  committedFiles?: BranchDiffFile[];
}): ChangeTreeNode[] {
  const root: ChangeTreeNode[] = [];
  const dirMap = new Map<string, ChangeTreeNode>();

  function ensureDir(dirPath: string): ChangeTreeNode {
    const existing = dirMap.get(dirPath);
    if (existing) return existing;
    const parts = dirPath.split('/');
    const node: ChangeTreeNode = {
      name: parts[parts.length - 1],
      path: dirPath,
      type: 'dir',
      children: [],
      count: 0,
      additions: 0,
      deletions: 0,
    };
    dirMap.set(dirPath, node);
    if (parts.length === 1) {
      root.push(node);
    } else {
      ensureDir(parts.slice(0, -1).join('/')).children.push(node);
    }
    return node;
  }

  for (const change of args.changes ?? []) {
    const parts = change.path.split('/');
    const node: ChangeTreeNode = {
      name: parts[parts.length - 1],
      path: change.path,
      type: 'file',
      children: [],
      count: 1,
      additions: 0,
      deletions: 0,
      change,
    };
    if (parts.length === 1) root.push(node);
    else ensureDir(parts.slice(0, -1).join('/')).children.push(node);
  }

  for (const file of args.committedFiles ?? []) {
    const parts = file.path.split('/');
    const node: ChangeTreeNode = {
      name: parts[parts.length - 1],
      path: file.path,
      type: 'file',
      children: [],
      count: 1,
      additions: file.additions,
      deletions: file.deletions,
      committedFile: file,
    };
    if (parts.length === 1) root.push(node);
    else ensureDir(parts.slice(0, -1).join('/')).children.push(node);
  }

  function rollUp(node: ChangeTreeNode): void {
    for (const child of node.children) {
      rollUp(child);
      node.count += child.count;
      node.additions += child.additions;
      node.deletions += child.deletions;
    }
  }
  for (const node of root) rollUp(node);

  function sortNodes(nodes: ChangeTreeNode[]): void {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) sortNodes(node.children);
  }
  sortNodes(root);
  return root;
}

@customElement('git-changes')
export class GitChanges extends LitElement {
  @property({ attribute: false }) changes: GitChange[] = [];
  @property({ attribute: false }) committedFiles: BranchDiffFile[] = [];
  @property() branch = '';
  @property({ type: Number }) ahead = 0;
  @property({ type: Number }) behind = 0;
  @property() branchDiffBase = '';

  @property() selectedPath = '';
  @state() private _stagedOpen = true;
  @state() private _changesOpen = true;
  @state() private _untrackedOpen = true;
  @state() private _committedOpen = true;
  @state() private _confirmDiscard = '';
  @state() private _viewMode: FileListViewMode = 'tree';
  @state() private _collapsedTreePaths = new Set<string>();

  static styles = css`
    :host {
      display: block;
      background: transparent;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 13px;
      color: #e0e0e0;
    }

    .header {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.lg)};
      padding: ${unsafeCSS(spacing.lg)} ${unsafeCSS(spacing.xl)};
      background: ${unsafeCSS(colors.bgSurface)};
      border-bottom: 1px solid #1e1e36;
    }

    .branch {
      font-weight: 600;
      color: ${unsafeCSS(colors.accent)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sync-info {
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      display: flex;
      gap: ${unsafeCSS(spacing.md)};
    }

    .ahead {
      color: ${unsafeCSS(colors.statusOk)};
    }
    .behind {
      color: ${unsafeCSS(colors.statusWarn)};
    }

    .file-count {
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      margin-left: auto;
      white-space: nowrap;
    }

    .file-list {
      overflow-y: auto;
    }

    .file-list::-webkit-scrollbar {
      width: 6px;
    }
    .file-list::-webkit-scrollbar-thumb {
      background: ${unsafeCSS(colors.textMuted)};
      border-radius: 3px;
    }

    .group-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px ${unsafeCSS(spacing.xl)};
      cursor: pointer;
      user-select: none;
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .group-header:hover {
      color: ${unsafeCSS(colors.textSecondary)};
      background: rgba(99, 102, 241, 0.05);
    }

    .group-arrow {
      font-size: 10px;
      width: 12px;
      text-align: center;
    }

    .group-badge {
      margin-left: auto;
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
    }

    .file-row {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.xl)};
      padding-left: 28px;
      cursor: pointer;
      transition: background 0.1s;
      position: relative;
    }

    .file-row:hover {
      background: rgba(99, 102, 241, 0.1);
    }

    .file-row.selected {
      background: rgba(99, 102, 241, 0.18);
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border-radius: ${unsafeCSS(radii.sm)};
      font-size: 11px;
      font-weight: 700;
      flex-shrink: 0;
    }

    .file-path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      flex: 1;
    }

    .file-basename {
      font-weight: 600;
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .file-dir {
      color: ${unsafeCSS(colors.textMuted)};
    }

    .old-path {
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      margin-left: 46px;
      padding: 0 ${unsafeCSS(spacing.xl)} ${unsafeCSS(spacing.sm)};
    }

    .file-actions {
      display: flex;
      gap: 2px;
      opacity: 0;
      flex-shrink: 0;
      transition: opacity 0.1s;
    }

    .file-row:hover .file-actions {
      opacity: 1;
    }

    .file-action-btn {
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: transparent;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 13px;
      cursor: pointer;
      border-radius: 3px;
      font-family: ${unsafeCSS(fonts.mono)};
    }

    .file-action-btn:hover {
      background: rgba(99, 102, 241, 0.15);
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .file-action-btn.danger:hover {
      background: rgba(255, 68, 68, 0.15);
      color: ${unsafeCSS(colors.statusFail)};
    }

    .file-action-btn.confirming {
      background: rgba(255, 204, 0, 0.2);
      color: ${unsafeCSS(colors.statusWarn)};
      opacity: 1;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.xxl)};
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      text-align: center;
    }

    .file-stats {
      display: flex;
      gap: 6px;
      font-size: ${unsafeCSS(fonts.sizeXs)};
      flex-shrink: 0;
    }

    .view-toggle {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      margin-left: auto;
      padding: 2px;
      border: 1px solid rgba(99, 102, 241, 0.25);
      border-radius: ${unsafeCSS(radii.sm)};
      background: rgba(99, 102, 241, 0.08);
    }

    .view-toggle-btn {
      border: 0;
      border-radius: 3px;
      background: transparent;
      color: ${unsafeCSS(colors.textMuted)};
      cursor: pointer;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      padding: 2px 6px;
    }

    .view-toggle-btn.active {
      background: rgba(99, 102, 241, 0.24);
      color: ${unsafeCSS(colors.accent)};
    }

    .tree-dir-row {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.sm)};
      padding: 3px ${unsafeCSS(spacing.xl)};
      cursor: pointer;
      user-select: none;
    }

    .tree-dir-row:hover {
      background: rgba(99, 102, 241, 0.05);
    }

    .tree-arrow {
      width: 12px;
      text-align: center;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 10px;
    }

    .tree-dir-name {
      color: ${unsafeCSS(colors.textSecondary)};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tree-dir-meta {
      display: flex;
      gap: 6px;
      margin-left: auto;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      white-space: nowrap;
    }
  `;

  private _select(change: GitChange) {
    this.selectedPath = change.path;
    this.dispatchEvent(
      new CustomEvent('change-select', {
        detail: { path: change.path, status: change.status },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _stage(path: string, e: Event) {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent('git-stage', {
        detail: { path },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _unstage(path: string, e: Event) {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent('git-unstage', {
        detail: { path },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _discard(path: string, e: Event) {
    e.stopPropagation();
    if (this._confirmDiscard === path) {
      this._confirmDiscard = '';
      this.dispatchEvent(
        new CustomEvent('git-discard', {
          detail: { path },
          bubbles: true,
          composed: true,
        }),
      );
    } else {
      this._confirmDiscard = path;
      setTimeout(() => {
        this._confirmDiscard = '';
      }, 3000);
    }
  }

  private _selectCommitted(file: BranchDiffFile) {
    this.selectedPath = file.path;
    this.dispatchEvent(
      new CustomEvent('committed-select', {
        detail: { path: file.path, status: file.status },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _renderCommittedGroup() {
    if (this.committedFiles.length === 0) return nothing;
    const sorted = [...this.committedFiles].sort((a, b) => a.path.localeCompare(b.path));
    const open = this._committedOpen;

    return html`
      <div
        class="group-header"
        @click=${() => {
          this._committedOpen = !open;
        }}
      >
        <span class="group-arrow">${open ? '▾' : '▸'}</span>
        <span>Committed${this.branchDiffBase ? ` vs ${this.branchDiffBase}` : ''}</span>
        <span class="group-badge">${this.committedFiles.length}</span>
      </div>
      ${open
        ? this._viewMode === 'tree'
          ? this._renderTree(buildChangeTree({ committedFiles: sorted }), 'committed', 'committed')
          : sorted.map((f) => this._renderCommittedFileRow(f))
        : nothing}
    `;
  }

  private _toggleTreePath(scope: string, path: string) {
    const key = `${scope}:${path}`;
    const next = new Set(this._collapsedTreePaths);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this._collapsedTreePaths = next;
  }

  private _renderTree(
    nodes: ChangeTreeNode[],
    scope: string,
    group: 'staged' | 'unstaged' | 'untracked' | 'committed',
    depth = 0,
  ): unknown {
    return nodes.map((node) => this._renderTreeNode(node, scope, group, depth));
  }

  private _renderTreeNode(
    node: ChangeTreeNode,
    scope: string,
    group: 'staged' | 'unstaged' | 'untracked' | 'committed',
    depth: number,
  ): unknown {
    const indent = 20 + depth * 16;
    if (node.type === 'dir') {
      const collapsed = this._collapsedTreePaths.has(`${scope}:${node.path}`);
      return html`
        <div
          class="tree-dir-row"
          style="padding-left:${indent}px"
          @click=${() => this._toggleTreePath(scope, node.path)}
        >
          <span class="tree-arrow">${collapsed ? '▸' : '▾'}</span>
          <span class="tree-dir-name">${node.name}</span>
          <span class="tree-dir-meta">
            <span>${node.count}</span>
            ${node.additions > 0
              ? html`<span style="color:${statusColor('A')}">+${node.additions}</span>`
              : nothing}
            ${node.deletions > 0
              ? html`<span style="color:${statusColor('D')}">-${node.deletions}</span>`
              : nothing}
          </span>
        </div>
        ${collapsed ? nothing : this._renderTree(node.children, scope, group, depth + 1)}
      `;
    }
    if (node.committedFile) return this._renderCommittedFileRow(node.committedFile, indent);
    if (node.change)
      return this._renderFileRow(node.change, group as 'staged' | 'unstaged' | 'untracked', indent);
    return nothing;
  }

  private _renderCommittedFileRow(f: BranchDiffFile, indent?: number) {
    const color = statusColor(f.status as GitChangeStatus);
    return html`
      <div
        class="file-row ${this.selectedPath === f.path ? 'selected' : ''}"
        style=${indent === undefined ? nothing : `padding-left:${indent}px`}
        @click=${() => this._selectCommitted(f)}
      >
        <span class="status-badge" style="background: ${color}22; color: ${color};"
          >${f.status}</span
        >
        <span class="file-path">
          <span class="file-basename">${basename(f.path)}</span>
          ${this._viewMode === 'list'
            ? html`<span class="file-dir">${dirname(f.path)}</span>`
            : nothing}
        </span>
        <span class="file-stats">
          ${f.additions > 0
            ? html`<span style="color: ${statusColor('A')}">+${f.additions}</span>`
            : nothing}
          ${f.deletions > 0
            ? html`<span style="color: ${statusColor('D')}">-${f.deletions}</span>`
            : nothing}
        </span>
      </div>
      ${f.status === 'R' && f.oldPath ? html`<div class="old-path">&larr; ${f.oldPath}</div>` : ''}
    `;
  }

  private _renderGroup(
    title: string,
    items: GitChange[],
    open: boolean,
    toggleKey: '_stagedOpen' | '_changesOpen' | '_untrackedOpen',
    actions: 'staged' | 'unstaged' | 'untracked',
  ) {
    if (items.length === 0) return nothing;
    const sorted = [...items].sort((a, b) => a.path.localeCompare(b.path));

    return html`
      <div
        class="group-header"
        @click=${() => {
          (this as any)[toggleKey] = !open;
        }}
      >
        <span class="group-arrow">${open ? '▾' : '▸'}</span>
        <span>${title}</span>
        <span class="group-badge">${items.length}</span>
      </div>
      ${open
        ? this._viewMode === 'tree'
          ? this._renderTree(buildChangeTree({ changes: sorted }), title, actions)
          : sorted.map((c) => this._renderFileRow(c, actions))
        : nothing}
    `;
  }

  private _renderFileRow(
    c: GitChange,
    group: 'staged' | 'unstaged' | 'untracked',
    indent?: number,
  ) {
    const color = statusColor(c.status);
    return html`
      <div
        class="file-row ${this.selectedPath === c.path && c.staged === (group === 'staged')
          ? 'selected'
          : ''}"
        style=${indent === undefined ? nothing : `padding-left:${indent}px`}
        @click=${() => this._select(c)}
      >
        <span class="status-badge" style="background: ${color}22; color: ${color};"
          >${c.status}</span
        >
        <span class="file-path">
          <span class="file-basename">${basename(c.path)}</span>
          ${this._viewMode === 'list'
            ? html`<span class="file-dir">${dirname(c.path)}</span>`
            : nothing}
        </span>
        <span class="file-actions">
          ${group === 'staged'
            ? html`
                <button
                  class="file-action-btn"
                  title="Unstage"
                  @click=${(e: Event) => this._unstage(c.path, e)}
                >
                  &minus;
                </button>
              `
            : html`
                <button
                  class="file-action-btn"
                  title="Stage"
                  @click=${(e: Event) => this._stage(c.path, e)}
                >
                  +
                </button>
              `}
          ${group !== 'staged'
            ? html`
                <button
                  class="file-action-btn danger ${this._confirmDiscard === c.path
                    ? 'confirming'
                    : ''}"
                  title="${this._confirmDiscard === c.path
                    ? 'Click again to confirm'
                    : 'Discard changes'}"
                  @click=${(e: Event) => this._discard(c.path, e)}
                >
                  ${'↩'}
                </button>
              `
            : nothing}
        </span>
      </div>
      ${c.status === 'R' && c.oldPath ? html`<div class="old-path">&larr; ${c.oldPath}</div>` : ''}
    `;
  }

  render() {
    const staged = this.changes.filter((c) => c.staged);
    const unstaged = this.changes.filter((c) => !c.staged && c.status !== '?');
    const untracked = this.changes.filter((c) => !c.staged && c.status === '?');
    const uncommitted = this.changes.length;
    const committed = this.committedFiles.length;
    const total = uncommitted + committed;

    return html`
      <div class="header">
        <span class="branch">${this.branch || 'detached'}</span>
        <span class="sync-info">
          ${this.ahead > 0 ? html`<span class="ahead">${'↑'}${this.ahead}</span>` : ''}
          ${this.behind > 0 ? html`<span class="behind">${'↓'}${this.behind}</span>` : ''}
        </span>
        <span class="view-toggle" title="Switch changed files view">
          ${(['tree', 'list'] as const).map(
            (mode) =>
              html`<button
                class="view-toggle-btn ${this._viewMode === mode ? 'active' : ''}"
                @click=${() => {
                  this._viewMode = mode;
                }}
              >
                ${mode}
              </button>`,
          )}
        </span>
        <span class="file-count">${total} change${total !== 1 ? 's' : ''}</span>
      </div>
      <div class="file-list">
        ${total === 0
          ? html`<div class="empty-state"><div>No changes</div></div>`
          : html`
              ${this._renderGroup(
                'Staged Changes',
                staged,
                this._stagedOpen,
                '_stagedOpen',
                'staged',
              )}
              ${this._renderGroup(
                'Changes',
                unstaged,
                this._changesOpen,
                '_changesOpen',
                'unstaged',
              )}
              ${this._renderGroup(
                'Untracked',
                untracked,
                this._untrackedOpen,
                '_untrackedOpen',
                'untracked',
              )}
              ${this._renderCommittedGroup()}
            `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'git-changes': GitChanges;
  }
}
