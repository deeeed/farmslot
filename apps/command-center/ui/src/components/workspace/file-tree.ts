import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { gitStatusColor as sharedGitStatusColor } from '../../styles/git-status.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size?: number;
  ignored?: boolean;
  children?: FileEntry[];
}

type GitChangeStatus = 'M' | 'A' | 'D' | '?' | 'R';

const gitStatusColor = sharedGitStatusColor;

@customElement('file-tree')
export class FileTree extends LitElement {
  @property({ attribute: false }) entries: FileEntry[] = [];
  /** Map of file path → git status character for coloring */
  @property({ attribute: false }) gitStatus: Map<string, GitChangeStatus> = new Map();
  @state() private expandedPaths = new Set<string>();
  @property() selectedPath = '';
  @state() private _ctxMenu: { x: number; y: number; entry: FileEntry } | null = null;

  static styles = css`
    :host {
      display: block;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textPrimary)};
      user-select: none;
      overflow-y: auto;
    }

    :host::-webkit-scrollbar {
      width: 6px;
    }
    :host::-webkit-scrollbar-thumb {
      background: ${unsafeCSS(colors.textMuted)};
      border-radius: 3px;
    }

    .row {
      display: flex;
      align-items: center;
      height: 24px;
      padding-right: ${unsafeCSS(spacing.md)};
      cursor: pointer;
      white-space: nowrap;
      border-radius: ${unsafeCSS(radii.sm)};
      transition: background 0.1s;
    }
    .row:hover {
      background: rgba(99, 102, 241, 0.1);
    }
    .row.selected {
      background: rgba(99, 102, 241, 0.2);
    }

    .indicator {
      width: 16px;
      flex-shrink: 0;
      text-align: center;
      font-size: 10px;
      color: ${unsafeCSS(colors.textMuted)};
    }

    .name {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .name.dir {
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .name.file {
      color: ${unsafeCSS(colors.textSecondary)};
    }
    .row.ignored .name {
      opacity: 0.4;
    }
    .row.ignored .indicator {
      opacity: 0.4;
    }

    .git-badge {
      margin-left: auto;
      padding-left: ${unsafeCSS(spacing.md)};
      font-size: 10px;
      font-weight: 700;
      flex-shrink: 0;
    }

    .size {
      padding-left: ${unsafeCSS(spacing.md)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      flex-shrink: 0;
    }

    .ctx-menu {
      position: fixed;
      z-index: 1000;
      min-width: 160px;
      background: ${unsafeCSS(colors.bgCard)};
      border: 1px solid #2a2a44;
      border-radius: 6px;
      padding: 4px 0;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }

    .ctx-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 12px;
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textSecondary)};
      cursor: pointer;
      white-space: nowrap;
    }

    .ctx-item:hover {
      background: rgba(99, 102, 241, 0.15);
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .ctx-item.danger:hover {
      background: rgba(255, 68, 68, 0.15);
      color: ${unsafeCSS(colors.statusFail)};
    }

    .ctx-sep {
      height: 1px;
      background: #2a2a44;
      margin: 4px 0;
    }

    .ctx-hint {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      margin-left: auto;
      padding-left: 16px;
    }
  `;

  updated(changed: Map<string, unknown>) {
    if (changed.has('selectedPath') && this.selectedPath) {
      this._revealPath(this.selectedPath);
    }
  }

  /** Expand all ancestor directories so the given path is visible in the tree */
  private _revealPath(filePath: string) {
    const parts = filePath.split('/');
    if (parts.length <= 1) return;
    let changed = false;
    const next = new Set(this.expandedPaths);
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/');
      if (!next.has(ancestor)) {
        next.add(ancestor);
        changed = true;
      }
    }
    if (changed) {
      this.expandedPaths = next;
    }
  }

  private _toggleDir(path: string) {
    const next = new Set(this.expandedPaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      this.dispatchEvent(
        new CustomEvent('dir-expand', {
          detail: { path },
          bubbles: true,
          composed: true,
        }),
      );
    }
    this.expandedPaths = next;
  }

  private _selectFile(path: string) {
    this.selectedPath = path;
    this.dispatchEvent(
      new CustomEvent('file-select', {
        detail: { path },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _pinFile(path: string) {
    this.selectedPath = path;
    this.dispatchEvent(
      new CustomEvent('file-pin', {
        detail: { path },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _showCtxMenu(e: MouseEvent, entry: FileEntry) {
    e.preventDefault();
    this._ctxMenu = { x: e.clientX, y: e.clientY, entry };
    // Close on next click anywhere
    const close = () => {
      this._ctxMenu = null;
      document.removeEventListener('click', close);
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  private _ctxAction(action: string) {
    if (!this._ctxMenu) return;
    const entry = this._ctxMenu.entry;
    this._ctxMenu = null;
    this.dispatchEvent(
      new CustomEvent('tree-action', {
        detail: { action, path: entry.path, type: entry.type },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Get the git status for a file, or the "highest priority" status for a directory */
  private _getStatus(entry: FileEntry): GitChangeStatus | null {
    // Direct file match
    const direct = this.gitStatus.get(entry.path);
    if (direct) return direct;

    // For directories, check if any child path starts with this dir
    if (entry.type === 'directory') {
      const prefix = entry.path + '/';
      for (const [path, status] of this.gitStatus) {
        if (path.startsWith(prefix)) return status;
      }
    }
    return null;
  }

  private _gitColor(entry: FileEntry): string {
    const status = this._getStatus(entry);
    if (!status) return '';
    return `color: ${gitStatusColor(status)}`;
  }

  private _gitBadge(entry: FileEntry) {
    if (entry.type === 'directory') return nothing;
    const status = this.gitStatus.get(entry.path);
    if (!status) return nothing;
    const color = gitStatusColor(status);
    return html`<span class="git-badge" style="color:${color}">${status}</span>`;
  }

  private _formatSize(bytes?: number): string {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  }

  private _renderEntries(entries: FileEntry[], depth: number): unknown[] {
    const sorted = [...entries].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return sorted.map((entry) => {
      const indent = depth * 16 + 4;
      const isDir = entry.type === 'directory';
      const expanded = this.expandedPaths.has(entry.path);

      return html`
        <div
          class="row ${!isDir && this.selectedPath === entry.path ? 'selected' : ''} ${entry.ignored
            ? 'ignored'
            : ''}"
          style="padding-left: ${indent}px"
          @click=${() => (isDir ? this._toggleDir(entry.path) : this._selectFile(entry.path))}
          @dblclick=${() => {
            if (!isDir) this._pinFile(entry.path);
          }}
          @contextmenu=${(e: MouseEvent) => this._showCtxMenu(e, entry)}
        >
          <span class="indicator">${isDir ? (expanded ? '\u25BE' : '\u25B8') : ''}</span>
          <span class="name ${isDir ? 'dir' : 'file'}" style="${this._gitColor(entry)}"
            >${entry.name}</span
          >
          ${this._gitBadge(entry)}
          ${entry.size != null
            ? html`<span class="size">${this._formatSize(entry.size)}</span>`
            : nothing}
        </div>
        ${isDir && expanded && entry.children
          ? this._renderEntries(entry.children, depth + 1)
          : nothing}
      `;
    });
  }

  private _renderCtxMenu() {
    if (!this._ctxMenu) return nothing;
    const { x, y, entry } = this._ctxMenu;
    const isDir = entry.type === 'directory';

    return html`
      <div class="ctx-menu" style="left:${x}px; top:${y}px">
        ${isDir
          ? html`
              <div class="ctx-item" @click=${() => this._ctxAction('new-file')}>New File Here</div>
              <div class="ctx-item" @click=${() => this._ctxAction('new-folder')}>New Folder</div>
              <div class="ctx-item" @click=${() => this._ctxAction('pin-folder')}>Pin Folder</div>
              <div class="ctx-sep"></div>
            `
          : ''}
        <div class="ctx-item" @click=${() => this._ctxAction('rename')}>Rename</div>
        <div class="ctx-item" @click=${() => this._ctxAction('copy-path')}>Copy Path</div>
        <div class="ctx-item" @click=${() => this._ctxAction('reveal')}>Reveal in Finder</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item danger" @click=${() => this._ctxAction('delete')}>Delete</div>
      </div>
    `;
  }

  render() {
    if (!this.entries.length) {
      return html`<div
        style="padding: ${spacing.lg}; color: ${colors.textMuted}; font-size: ${fonts.sizeSm}"
      >
        No files
      </div>`;
    }
    return html`${this._renderEntries(this.entries, 0)}${this._renderCtxMenu()}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'file-tree': FileTree;
  }
}
