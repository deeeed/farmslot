import { html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import '../diff-viewer/diff-review.js';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { formatDiffFileCount, visibleDiffSelection } from '../../utils/diff-test-filter.js';
import { gatewayHttpFetch } from '../../utils/gateway-origin.js';
import { type DiffFileEntry, parseUnifiedDiff } from '../../utils/unified-diff.js';

import { DiffTestFilterController } from './diff-test-filter-controller.js';

interface DiffTreeFolder {
  kind: 'folder';
  name: string;
  path: string;
  files: number;
  additions: number;
  deletions: number;
  children: DiffTreeNode[];
}

interface DiffTreeFile {
  kind: 'file';
  name: string;
  path: string;
  file: DiffFileEntry;
}

type DiffTreeNode = DiffTreeFolder | DiffTreeFile;

function groupSegments(pathValue: string): string[] {
  return pathValue.split('/').filter(Boolean);
}

function buildDiffTree(files: DiffFileEntry[]): DiffTreeFolder {
  const root: DiffTreeFolder = {
    kind: 'folder',
    name: '',
    path: '',
    files: 0,
    additions: 0,
    deletions: 0,
    children: [],
  };
  const folderByPath = new Map<string, DiffTreeFolder>([['', root]]);

  for (const file of files) {
    const segments = groupSegments(file.path);
    const fileName = segments.pop() ?? file.path;
    let current = root;
    current.files += 1;
    current.additions += file.additions;
    current.deletions += file.deletions;

    for (const segment of segments) {
      const folderPath = current.path ? `${current.path}/${segment}` : segment;
      let folder = folderByPath.get(folderPath);
      if (!folder) {
        folder = {
          kind: 'folder',
          name: segment,
          path: folderPath,
          files: 0,
          additions: 0,
          deletions: 0,
          children: [],
        };
        folderByPath.set(folderPath, folder);
        current.children.push(folder);
      }
      folder.files += 1;
      folder.additions += file.additions;
      folder.deletions += file.deletions;
      current = folder;
    }

    current.children.push({ kind: 'file', name: fileName, path: file.path, file });
  }

  const sortTree = (folder: DiffTreeFolder) => {
    folder.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const child of folder.children) {
      if (child.kind === 'folder') sortTree(child);
    }
  };
  sortTree(root);
  return root;
}

@customElement('diff-viewer-modal')
export class DiffViewerModal extends LitElement {
  protected override createRenderRoot() {
    return this;
  }

  @property({ type: Boolean }) open = false;
  @property() title = 'Diff';
  @property() diffText = '';
  @property() artifactUrl = '';
  /**
   * Effective test-file globs from the host's `git.branchDiff` result, so the
   * modal agrees with the changed-files list on what counts as a test. Null
   * falls back to the built-in defaults.
   */
  @property({ attribute: false }) testPatterns: readonly string[] | null = null;

  @state() private _loadedText = '';
  @state() private _loading = false;
  @state() private _error = '';
  @state() private _selectedPath = '';
  private readonly _testFilter = new DiffTestFilterController(this, {
    patterns: () => this.testPatterns,
  });

  override updated(changed: Map<string, unknown>): void {
    if (!this.open && (changed.has('artifactUrl') || changed.has('diffText'))) {
      this._loadedText = this.diffText || '';
      this._selectedPath = '';
      this._error = '';
      this._loading = false;
    }
    if (
      (changed.has('open') || changed.has('artifactUrl') || changed.has('diffText')) &&
      this.open
    ) {
      void this._load();
    }
  }

  private async _load(): Promise<void> {
    this._error = '';
    if (this.diffText) {
      this._loadedText = this.diffText;
      this._selectDefault();
      return;
    }
    if (!this.artifactUrl) {
      this._loadedText = '';
      this._selectedPath = '';
      return;
    }
    this._loading = true;
    try {
      const response = await gatewayHttpFetch(this.artifactUrl);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      this._loadedText = await response.text();
      this._selectDefault();
    } catch (err) {
      this._loadedText = '';
      this._error = err instanceof Error ? err.message : String(err);
    } finally {
      this._loading = false;
    }
  }

  private _selectDefault(): void {
    const files = parseUnifiedDiff(this._loadedText);
    if (!this._selectedPath || !files.some((file) => file.path === this._selectedPath)) {
      this._selectedPath = files[0]?.path ?? '';
    }
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent('diff-modal-close', { bubbles: true, composed: true }));
  }

  private _onBackdropClick(event: Event): void {
    if (event.target === event.currentTarget) this._close();
  }

  private _renderDiffTree(
    nodes: DiffTreeNode[],
    selectedPath: string | undefined,
    depth = 0,
  ): TemplateResult[] {
    return nodes.map((node): TemplateResult => {
      if (node.kind === 'folder') {
        return html`
          <div class="dvm-folder" style="--depth: ${depth}" title=${node.path}>
            <span class="dvm-folder-name">${node.name}</span>
            <span class="dvm-file-stat">${node.files} files</span>
          </div>
          ${this._renderDiffTree(node.children, selectedPath, depth + 1)}
        `;
      }
      const selected = selectedPath === node.file.path;
      return html`
        <button
          class="dvm-file ${selected ? 'active' : ''}"
          style="--depth: ${depth}"
          @click=${() => {
            this._selectedPath = node.file.path;
          }}
          title=${node.file.path}
        >
          <span class="dvm-file-name">${node.name}</span>
          <span class="dvm-file-stat"
            ><span class="dvm-add">+${node.file.additions}</span>
            <span class="dvm-del">-${node.file.deletions}</span></span
          >
        </button>
      `;
    });
  }

  override render() {
    if (!this.open) return nothing;
    const parsed = parseUnifiedDiff(this._loadedText);
    // No keepPath here: the modal auto-selects its first file, so pinning it
    // would make a test-only diff impossible to hide. The pane simply follows
    // the first visible file.
    const split = this._testFilter.split(parsed);
    const files = split.visible;
    const selectedPath = visibleDiffSelection(files, this._selectedPath);
    const selected = files.find((file) => file.path === selectedPath);
    const tree = buildDiffTree(files);
    const total = files.reduce(
      (acc, file) => {
        acc.additions += file.additions;
        acc.deletions += file.deletions;
        return acc;
      },
      { additions: 0, deletions: 0 },
    );
    return html`
      <style>
        diff-viewer-modal .dvm-backdrop {
          position: fixed;
          inset: 0;
          z-index: 1000;
          background: rgba(0, 0, 0, 0.72);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 28px;
        }
        diff-viewer-modal .dvm-modal {
          width: min(1280px, calc(100vw - 56px));
          height: min(860px, calc(100vh - 56px));
          background: ${colors.bgBase};
          border: 1px solid #2a2a44;
          border-radius: ${radii.lg};
          box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          font-family: ${fonts.mono};
          color: ${colors.textPrimary};
        }
        diff-viewer-modal .dvm-header {
          display: flex;
          align-items: center;
          gap: ${spacing.md};
          padding: ${spacing.md} ${spacing.lg};
          background: ${colors.bgCard};
          border-bottom: 1px solid #2a2a44;
        }
        diff-viewer-modal .dvm-title {
          font-weight: 700;
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        diff-viewer-modal .dvm-stat {
          font-size: 11px;
          color: ${colors.textMuted};
          display: flex;
          gap: 6px;
        }
        diff-viewer-modal .dvm-add {
          color: ${colors.statusOk};
        }
        diff-viewer-modal .dvm-del {
          color: ${colors.statusFail};
        }
        diff-viewer-modal .dvm-close {
          background: transparent;
          color: ${colors.textMuted};
          border: 1px solid #2a2a44;
          border-radius: ${radii.sm};
          padding: 4px 9px;
          cursor: pointer;
          font-family: ${fonts.mono};
        }
        diff-viewer-modal .dvm-body {
          flex: 1;
          min-height: 0;
          display: grid;
          grid-template-columns: 340px minmax(0, 1fr);
        }
        diff-viewer-modal .dvm-sidebar {
          border-right: 1px solid #2a2a44;
          overflow: auto;
          background: ${colors.bgSurface};
          padding: ${spacing.sm};
        }
        diff-viewer-modal .dvm-tree-summary {
          color: ${colors.textMuted};
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          padding: 2px 6px 8px;
        }
        diff-viewer-modal .dvm-folder,
        diff-viewer-modal .dvm-file {
          padding-left: calc(6px + var(--depth, 0) * 14px);
        }
        diff-viewer-modal .dvm-folder {
          color: ${colors.textSecondary};
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 8px;
          align-items: center;
          margin-top: 4px;
        }
        diff-viewer-modal .dvm-folder-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        diff-viewer-modal .dvm-folder-name::before {
          content: '▾ ';
          color: ${colors.accent};
        }
        diff-viewer-modal .dvm-file {
          width: 100%;
          border: 0;
          background: transparent;
          color: ${colors.textMuted};
          padding-top: 5px;
          padding-bottom: 5px;
          padding-right: 6px;
          border-radius: ${radii.sm};
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 8px;
          cursor: pointer;
          text-align: left;
          font-family: ${fonts.mono};
          font-size: 11px;
        }
        diff-viewer-modal .dvm-file:hover {
          background: ${colors.bgCard};
          color: ${colors.textSecondary};
        }
        diff-viewer-modal .dvm-file.active {
          background: ${colors.accent}18;
          color: ${colors.textPrimary};
          box-shadow: inset 2px 0 0 ${colors.accent};
        }
        diff-viewer-modal .dvm-file-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        diff-viewer-modal .dvm-file-stat {
          white-space: nowrap;
          font-size: 10px;
        }
        diff-viewer-modal .dvm-main {
          min-width: 0;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        diff-viewer-modal .dvm-empty {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          color: ${colors.textMuted};
          font-size: 12px;
          padding: ${spacing.xl};
          text-align: center;
        }
        diff-viewer-modal diff-review {
          flex: 1;
          min-height: 0;
        }
      </style>
      <div class="dvm-backdrop" @click=${this._onBackdropClick}>
        <div class="dvm-modal" role="dialog" aria-modal="true" aria-label=${this.title}>
          <div class="dvm-header">
            <div class="dvm-title">${this.title}</div>
            <div class="dvm-stat">
              ${this._testFilter.renderControls(split.summary)}
              <span>${formatDiffFileCount(split)} files</span
              ><span class="dvm-add">+${total.additions}</span
              ><span class="dvm-del">-${total.deletions}</span>
            </div>
            <button class="dvm-close" @click=${this._close}>Close</button>
          </div>
          <div class="dvm-body">
            <div class="dvm-sidebar">
              <div class="dvm-tree-summary">Changed files</div>
              ${this._renderDiffTree(tree.children, selected?.path)}
            </div>
            <div class="dvm-main">
              ${this._loading
                ? html`<div class="dvm-empty">Loading diff…</div>`
                : this._error
                  ? html`<div class="dvm-empty">Failed to load diff: ${this._error}</div>`
                  : selected
                    ? html`<diff-review
                        .diff=${selected.diff}
                        .filename=${selected.path}
                      ></diff-review>`
                    : parsed.length > 0
                      ? html`<div class="dvm-empty">Only test files changed (hidden)</div>`
                      : html`<div class="dvm-empty">No diff content available.</div>`}
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'diff-viewer-modal': DiffViewerModal;
  }
}
