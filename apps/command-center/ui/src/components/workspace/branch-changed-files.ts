import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { gitStateChips, gitStatusColor } from '../../styles/git-status.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

type BranchDiffStatus = 'M' | 'A' | 'D' | 'R';
type FileListViewMode = 'tree' | 'list';

export interface BranchDiffFile {
  path: string;
  status: BranchDiffStatus;
  oldPath?: string;
  additions: number;
  deletions: number;
  /** Worktree scope: file also has committed changes vs base. */
  committed?: boolean;
}

/** Working-tree entry used to derive per-file state chips (staged/unstaged/untracked). */
export interface WorktreeChangeEntry {
  path: string;
  status: string;
  staged: boolean;
}

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  status?: BranchDiffStatus;
  oldPath?: string;
  committed?: boolean;
  additions: number;
  deletions: number;
  children: TreeNode[];
  commentCount: number;
}

const statusColor = gitStatusColor;

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

function buildTree(files: BranchDiffFile[], commentCounts: Map<string, number>): TreeNode[] {
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();

  function ensureDir(dirPath: string): TreeNode {
    if (dirMap.has(dirPath)) return dirMap.get(dirPath)!;
    const parts = dirPath.split('/');
    const name = parts[parts.length - 1];
    const node: TreeNode = {
      name,
      path: dirPath,
      type: 'dir',
      additions: 0,
      deletions: 0,
      children: [],
      commentCount: 0,
    };
    dirMap.set(dirPath, node);

    if (parts.length === 1) {
      root.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join('/');
      const parent = ensureDir(parentPath);
      parent.children.push(node);
    }
    return node;
  }

  for (const file of files) {
    const parts = file.path.split('/');
    const fileNode: TreeNode = {
      name: parts[parts.length - 1],
      path: file.path,
      type: 'file',
      status: file.status,
      oldPath: file.oldPath,
      committed: file.committed,
      additions: file.additions,
      deletions: file.deletions,
      children: [],
      commentCount: commentCounts.get(file.path) ?? 0,
    };

    if (parts.length === 1) {
      root.push(fileNode);
    } else {
      const dirPath = parts.slice(0, -1).join('/');
      const parent = ensureDir(dirPath);
      parent.children.push(fileNode);
    }
  }

  // Roll up stats to directories
  function rollUp(node: TreeNode) {
    for (const child of node.children) {
      rollUp(child);
      node.additions += child.additions;
      node.deletions += child.deletions;
      node.commentCount += child.commentCount;
    }
  }
  for (const node of root) rollUp(node);

  // Sort: dirs first, then alphabetically
  function sortNodes(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.children.length > 0) sortNodes(n.children);
    }
  }
  sortNodes(root);

  return root;
}

@customElement('branch-changed-files')
export class BranchChangedFiles extends LitElement {
  @property({ attribute: false }) files: BranchDiffFile[] = [];
  @property() base = 'main';
  @property() head = '';
  @property({ type: Number }) totalAdditions = 0;
  @property({ type: Number }) totalDeletions = 0;
  @property({ attribute: false }) commentCounts: Map<string, number> = new Map();
  @property() selectedPath = '';
  @property({ attribute: false }) branches: string[] = [];
  /** Working-tree status entries — enables IDE-style C/S/M/U state chips per row. */
  @property({ attribute: false }) changes: WorktreeChangeEntry[] = [];

  @state() private _collapsed = new Set<string>();
  @state() private _baseInput = '';
  @state() private _viewMode: FileListViewMode = 'tree';
  @state() private _showDropdown = false;

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
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.lg)} ${unsafeCSS(spacing.xl)};
      background: ${unsafeCSS(colors.bgSurface)};
      border-bottom: 1px solid #1e1e36;
      flex-wrap: wrap;
    }

    .base-selector {
      position: relative;
      display: inline-flex;
      align-items: center;
    }

    .base-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      background: rgba(99, 102, 241, 0.12);
      border: 1px solid rgba(99, 102, 241, 0.3);
      border-radius: ${unsafeCSS(radii.sm)};
      color: ${unsafeCSS(colors.accent)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      cursor: pointer;
      white-space: nowrap;
    }

    .base-btn:hover {
      background: rgba(99, 102, 241, 0.2);
    }

    .base-dropdown {
      position: absolute;
      top: 100%;
      left: 0;
      z-index: 100;
      min-width: 180px;
      max-height: 200px;
      overflow-y: auto;
      background: ${unsafeCSS(colors.bgCard)};
      border: 1px solid #2a2a4a;
      border-radius: ${unsafeCSS(radii.md)};
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
      padding: 4px 0;
    }

    .base-dropdown::-webkit-scrollbar {
      width: 6px;
    }
    .base-dropdown::-webkit-scrollbar-thumb {
      background: ${unsafeCSS(colors.textMuted)};
      border-radius: 3px;
    }

    .base-dropdown-input {
      display: block;
      width: calc(100% - 12px);
      margin: 4px 6px;
      padding: 3px 6px;
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid #2a2a4a;
      border-radius: ${unsafeCSS(radii.sm)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      outline: none;
    }

    .base-dropdown-item {
      padding: 4px 12px;
      cursor: pointer;
      font-size: ${unsafeCSS(fonts.sizeXs)};
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .base-dropdown-item:hover {
      background: rgba(99, 102, 241, 0.15);
    }

    .base-dropdown-item.active {
      color: ${unsafeCSS(colors.accent)};
      font-weight: 600;
    }

    .arrow {
      font-size: 9px;
    }

    .head-label {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }

    .head-name {
      color: ${unsafeCSS(colors.accent)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      font-weight: 600;
    }

    .summary {
      margin-left: auto;
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      white-space: nowrap;
    }

    .state-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 700;
      margin-right: 2px;
    }

    .add-stat {
      color: #00ff88;
    }
    .del-stat {
      color: #ff4444;
    }

    .view-toggle {
      display: inline-flex;
      align-items: center;
      gap: 2px;
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

    .tree {
      overflow-y: auto;
    }

    .tree::-webkit-scrollbar {
      width: 6px;
    }
    .tree::-webkit-scrollbar-thumb {
      background: ${unsafeCSS(colors.textMuted)};
      border-radius: 3px;
    }

    .dir-row {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.sm)};
      padding: 3px ${unsafeCSS(spacing.xl)};
      cursor: pointer;
      user-select: none;
    }

    .dir-row:hover {
      background: rgba(99, 102, 241, 0.05);
    }

    .dir-arrow {
      font-size: 10px;
      width: 12px;
      text-align: center;
      color: ${unsafeCSS(colors.textMuted)};
    }

    .dir-name {
      font-size: 13px;
      color: ${unsafeCSS(colors.textSecondary)};
    }

    .dir-stats {
      margin-left: auto;
      font-size: 11px;
      color: ${unsafeCSS(colors.textMuted)};
      white-space: nowrap;
    }

    .file-row {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: 3px ${unsafeCSS(spacing.xl)};
      cursor: pointer;
      transition: background 0.1s;
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

    .file-name {
      font-weight: 600;
      color: ${unsafeCSS(colors.textPrimary)};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-dir {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-stats {
      margin-left: auto;
      font-size: 11px;
      white-space: nowrap;
      display: flex;
      gap: 6px;
      align-items: center;
      flex-shrink: 0;
    }

    .comment-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      border-radius: 8px;
      background: rgba(99, 102, 241, 0.25);
      color: ${unsafeCSS(colors.accent)};
      font-size: 10px;
      font-weight: 700;
      flex-shrink: 0;
    }

    .old-path {
      font-size: 11px;
      color: ${unsafeCSS(colors.textMuted)};
      padding: 0 ${unsafeCSS(spacing.xl)} 2px;
    }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: ${unsafeCSS(spacing.xxl)};
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._baseInput = this.base;
    document.addEventListener('click', this._onDocClick);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('click', this._onDocClick);
  }

  private _onDocClick = (e: MouseEvent) => {
    if (
      this._showDropdown &&
      !this.shadowRoot?.querySelector('.base-selector')?.contains(e.composedPath()[0] as Node)
    ) {
      this._showDropdown = false;
    }
  };

  private _toggleDropdown() {
    this._showDropdown = !this._showDropdown;
    if (this._showDropdown) {
      this._baseInput = '';
      requestAnimationFrame(() => {
        this.shadowRoot?.querySelector<HTMLInputElement>('.base-dropdown-input')?.focus();
      });
    }
  }

  private _selectBase(branch: string) {
    this._showDropdown = false;
    if (branch !== this.base) {
      this.dispatchEvent(
        new CustomEvent('base-change', {
          detail: { base: branch },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private _toggleDir(path: string) {
    const next = new Set(this._collapsed);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    this._collapsed = next;
  }

  private _selectFile(path: string, status: BranchDiffStatus, oldPath?: string) {
    this.dispatchEvent(
      new CustomEvent('file-select', {
        detail: { path, status, oldPath },
        bubbles: true,
        composed: true,
      }),
    );
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('files')) {
      // Auto-collapse if >= 30 files
      if (this.files.length >= 30) {
        const tree = buildTree(this.files, this.commentCounts);
        this._collapsed = new Set(tree.filter((n) => n.type === 'dir').map((n) => n.path));
      } else {
        this._collapsed = new Set();
      }
    }
    if (changed.has('selectedPath') && this.selectedPath) {
      this._revealPath(this.selectedPath);
    }
  }

  /** Expand all ancestor directories so the given path is visible */
  private _revealPath(filePath: string) {
    // For branch diff, selectedPath might be a cache key like "branch:main:path/to/file"
    const actualPath = filePath.startsWith('branch:')
      ? filePath.split(':').slice(2).join(':')
      : filePath;
    const parts = actualPath.split('/');
    if (parts.length <= 1) return;
    let changed = false;
    const next = new Set(this._collapsed);
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/');
      if (next.has(ancestor)) {
        next.delete(ancestor);
        changed = true;
      }
    }
    if (changed) {
      this._collapsed = next;
    }
  }

  private _renderNode(node: TreeNode, depth: number): unknown {
    const indent = 12 + depth * 16;

    if (node.type === 'dir') {
      const collapsed = this._collapsed.has(node.path);
      return html`
        <div
          class="dir-row"
          style="padding-left:${indent}px"
          @click=${() => this._toggleDir(node.path)}
        >
          <span class="dir-arrow">${collapsed ? '\u25B8' : '\u25BE'}</span>
          <span class="dir-name">${node.name}</span>
          <span class="dir-stats">
            ${node.additions > 0 ? html`<span class="add-stat">+${node.additions}</span>` : ''}
            ${node.deletions > 0 ? html`<span class="del-stat">-${node.deletions}</span>` : ''}
          </span>
        </div>
        ${collapsed ? nothing : node.children.map((c) => this._renderNode(c, depth + 1))}
      `;
    }

    const color = statusColor(node.status!);
    return html`
      <div
        class="file-row ${this.selectedPath === node.path ? 'selected' : ''}"
        style="padding-left:${indent}px"
        @click=${() => this._selectFile(node.path, node.status!, node.oldPath)}
      >
        <span class="status-badge" style="background:${color}22; color:${color};"
          >${node.status}</span
        >
        <span class="file-name">${node.name}</span>
        <span class="file-stats">
          ${this._renderStateChips(node.path, node.committed)}
          ${node.commentCount > 0
            ? html`<span class="comment-badge">${node.commentCount}</span>`
            : ''}
          ${node.additions > 0 ? html`<span class="add-stat">+${node.additions}</span>` : ''}
          ${node.deletions > 0 ? html`<span class="del-stat">-${node.deletions}</span>` : ''}
        </span>
      </div>
      ${node.status === 'R' && node.oldPath
        ? html`<div class="old-path" style="padding-left:${indent + 30}px">
            &larr; ${node.oldPath}
          </div>`
        : ''}
    `;
  }

  private _renderStateChips(path: string, committed: boolean | undefined) {
    if (this.changes.length === 0 && committed === undefined) return nothing;
    return gitStateChips({
      committed,
      worktreeEntries: this.changes.filter((entry) => entry.path === path),
    }).map(
      (chip) =>
        html`<span
          class="state-chip"
          style="background: ${chip.color}22; color: ${chip.color};"
          title=${chip.title}
          >${chip.label}</span
        >`,
    );
  }

  private _renderListFile(file: BranchDiffFile): unknown {
    const color = statusColor(file.status);
    return html`
      <div
        class="file-row ${this.selectedPath === file.path ? 'selected' : ''}"
        @click=${() => this._selectFile(file.path, file.status, file.oldPath)}
      >
        <span class="status-badge" style="background:${color}22; color:${color};"
          >${file.status}</span
        >
        <span class="file-name">${basename(file.path)}</span>
        <span class="file-dir">${file.path.slice(0, -basename(file.path).length)}</span>
        <span class="file-stats">
          ${this._renderStateChips(file.path, file.committed)}
          ${(this.commentCounts.get(file.path) ?? 0) > 0
            ? html`<span class="comment-badge">${this.commentCounts.get(file.path)}</span>`
            : nothing}
          ${file.additions > 0 ? html`<span class="add-stat">+${file.additions}</span>` : nothing}
          ${file.deletions > 0 ? html`<span class="del-stat">-${file.deletions}</span>` : nothing}
        </span>
      </div>
      ${file.status === 'R' && file.oldPath
        ? html`<div class="old-path">&larr; ${file.oldPath}</div>`
        : nothing}
    `;
  }

  render() {
    const tree = buildTree(this.files, this.commentCounts);
    const filteredBranches = this._baseInput
      ? this.branches.filter((b) => b.toLowerCase().includes(this._baseInput.toLowerCase()))
      : this.branches;

    return html`
      <div class="header">
        <div class="base-selector">
          <button class="base-btn" @click=${() => this._toggleDropdown()}>
            ${this.base} <span class="arrow">▾</span>
          </button>
          ${this._showDropdown
            ? html`
                <div class="base-dropdown">
                  <input
                    class="base-dropdown-input"
                    type="text"
                    placeholder="Filter branches..."
                    .value=${this._baseInput}
                    @input=${(e: InputEvent) => {
                      this._baseInput = (e.target as HTMLInputElement).value;
                    }}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === 'Enter' && filteredBranches.length > 0) {
                        this._selectBase(filteredBranches[0]);
                      }
                      if (e.key === 'Escape') {
                        this._showDropdown = false;
                      }
                    }}
                  />
                  ${filteredBranches.map(
                    (b) => html`
                      <div
                        class="base-dropdown-item ${b === this.base ? 'active' : ''}"
                        @click=${() => this._selectBase(b)}
                      >
                        ${b}
                      </div>
                    `,
                  )}
                </div>
              `
            : nothing}
        </div>
        <span class="head-label">←</span>
        <span class="head-name">${this.head || 'HEAD'}</span>
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
        <span class="summary">
          ${this.files.length} file${this.files.length !== 1 ? 's' : ''}
          <span class="add-stat">+${this.totalAdditions}</span>
          <span class="del-stat">-${this.totalDeletions}</span>
        </span>
      </div>
      <div class="tree">
        ${this.files.length === 0
          ? html`<div class="empty-state">No changes vs ${this.base}</div>`
          : this._viewMode === 'tree'
            ? tree.map((n) => this._renderNode(n, 0))
            : [...this.files]
                .sort((a, b) => a.path.localeCompare(b.path))
                .map((file) => this._renderListFile(file))}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'branch-changed-files': BranchChangedFiles;
  }
}
