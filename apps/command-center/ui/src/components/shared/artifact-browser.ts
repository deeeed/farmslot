import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import './media-lightbox.js';

import { colors, fonts } from '../../styles/theme-tokens.js';
import { formatBytes } from '../../utils/format.js';
import {
  ARTIFACT_TYPES,
  type ArtifactType,
  workspaceArtifactTypeCounts,
  workspaceArtifactTypeLabel,
} from '../workspace/workspace-artifacts.js';

import {
  type ArtifactBrowserItem,
  artifactBrowserKeyAction,
  type ArtifactBrowserKeyFile,
  artifactBrowserKeyFiles,
  artifactBrowserNodeKey,
  artifactBrowserQueryTerms,
  type ArtifactBrowserRow,
  artifactBrowserRows,
  artifactBrowserTree,
} from './artifact-browser-model.js';
import { gatewayMediaSrc } from './gateway-media-src.js';
import type { LightboxItem } from './media-lightbox-types.js';

/** Below this many files the list needs no search or type filters. */
const TOOLBAR_MIN_FILES = 9;
/** From this width the selected file previews beside the tree instead of in the host viewer. */
const SPLIT_MIN_WIDTH = 720;

/**
 * Folder tree over a run's artifacts with search and type filters. Opening a
 * file emits `artifact-open` with its index in `artifacts`; the host decides
 * how to show it.
 */
@customElement('artifact-browser')
export class ArtifactBrowser extends LitElement {
  @property({ attribute: false }) artifacts: readonly ArtifactBrowserItem[] = [];
  /** URL of the artifact at this index in `artifacts`. */
  @property({ attribute: false }) artifactHref?: (index: number) => string;
  @state() private query = '';
  @state() private types = new Set<ArtifactType>();
  /** Folders and attempt groups the user opened or closed, by node key. */
  @state() private toggled = new Map<string, boolean>();
  @state() private wide = false;
  /** Too narrow for a side pane: the chosen file previews in a panel over the list. */
  @state() private overlay = false;
  /** Index of the file shown in the side preview; defaults to the first key file. */
  @state() private selected: number | null = null;
  /** Node key of the tree row that holds keyboard focus. */
  @state() private focusedKey: string | null = null;
  private readonly resizeObserver = new ResizeObserver(([entry]) => {
    if (entry) this.wide = entry.contentRect.width >= SPLIT_MIN_WIDTH;
  });
  private previewItems: { source: readonly ArtifactBrowserItem[]; items: LightboxItem[] } | null =
    null;

  static styles = css`
    :host {
      display: block;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 12px;
    }
    .frame {
      container-type: inline-size;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
    }
    .search {
      flex: 1 1 220px;
      min-height: 32px;
      padding: 4px 8px;
      font: inherit;
      color: ${unsafeCSS(colors.textPrimary)};
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 4px;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .chip {
      min-height: 32px;
      padding: 4px 10px;
      font: inherit;
      color: ${unsafeCSS(colors.textMuted)};
      background: transparent;
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 999px;
      cursor: pointer;
    }
    .chip[aria-pressed='true'] {
      color: ${unsafeCSS(colors.textPrimary)};
      border-color: ${unsafeCSS(colors.accent)};
      background: ${unsafeCSS(colors.accent)}22;
    }
    .chip span {
      color: ${unsafeCSS(colors.textMuted)};
      margin-left: 4px;
    }
    .match-count {
      color: ${unsafeCSS(colors.textMuted)};
    }
    .tree {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 28px;
      padding-right: 4px;
      border-radius: 3px;
    }
    .row:hover {
      background: ${unsafeCSS(colors.bgCardHover)};
    }
    .row:focus-visible {
      outline: 1px solid ${unsafeCSS(colors.accent)};
      outline-offset: -1px;
    }
    .toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
      min-width: 0;
      min-height: inherit;
      padding: 0;
      font: inherit;
      color: ${unsafeCSS(colors.textSecondary)};
      text-align: left;
      background: transparent;
      border: 0;
      cursor: pointer;
    }
    .chevron {
      width: 10px;
      flex: none;
      color: ${unsafeCSS(colors.textMuted)};
    }
    .file {
      flex: 1;
      align-self: stretch;
      display: flex;
      align-items: center;
      min-width: 0;
      color: ${unsafeCSS(colors.accent)};
      text-decoration: none;
    }
    .file-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file:hover {
      text-decoration: underline;
    }
    .meta {
      flex: none;
      color: ${unsafeCSS(colors.textMuted)};
    }
    mark {
      color: inherit;
      background: ${unsafeCSS(colors.accent)}44;
      border-radius: 2px;
    }
    .empty {
      color: ${unsafeCSS(colors.textMuted)};
      padding: 8px 0;
    }
    .key-files {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 8px;
    }
    .row.selected {
      background: ${unsafeCSS(colors.accent)}22;
    }
    .split {
      display: grid;
      grid-template-columns: minmax(240px, 34%) minmax(0, 1fr);
      gap: 12px;
      height: min(78vh, 960px);
    }
    .browse {
      min-height: 0;
      overflow: auto;
    }
    .preview {
      display: block;
      min-height: 0;
    }
    .overlay-scrim {
      position: fixed;
      inset: 0;
      z-index: 54;
      background: rgba(0, 0, 0, 0.45);
    }
    .overlay {
      position: fixed;
      top: env(safe-area-inset-top, 0px);
      right: 0;
      bottom: 0;
      z-index: 55;
      display: flex;
      flex-direction: column;
      width: min(760px, 100vw);
      background: ${unsafeCSS(colors.bgBase)};
      border-left: 1px solid ${unsafeCSS(colors.bgCardHover)};
      outline: none;
    }
    .overlay-bar {
      display: flex;
      justify-content: flex-end;
      padding: 6px 8px;
    }
    .overlay .preview {
      flex: 1;
    }
    @container (max-width: 480px) {
      .search {
        flex-basis: 100%;
      }
      .row {
        min-height: 44px;
      }
      .file + .meta {
        display: none;
      }
    }
    @media (pointer: coarse) {
      .row,
      .chip,
      .search {
        min-height: 44px;
      }
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.resizeObserver.observe(this);
    this.addEventListener('keydown', this.onHostKey);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObserver.disconnect();
    this.removeEventListener('keydown', this.onHostKey);
  }

  private get filtering(): boolean {
    return Boolean(this.query.trim()) || this.types.size > 0;
  }

  private isOpen = (key: string, soleChild: boolean): boolean =>
    this.toggled.get(key) ?? (this.filtering || soleChild);

  private toggle(key: string, open: boolean) {
    this.toggled = new Map(this.toggled).set(key, !open);
  }

  private toggleType(type: ArtifactType) {
    const types = new Set(this.types);
    if (!types.delete(type)) types.add(type);
    this.types = types;
  }

  private open(index: number, event?: Event) {
    event?.preventDefault();
    this.selected = index;
    if (!this.wide) this.overlay = true;
  }

  private async showOverlay() {
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLElement>('.overlay')?.focus();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has('overlay') && this.overlay) void this.showOverlay();
    // Widening past the side-pane threshold hands the open file to the side pane.
    if (changed.has('wide') && this.wide) this.overlay = false;
  }

  private renderPreview(selected: number) {
    return html`<media-lightbox
      class="preview"
      embedded
      open
      .items=${this.lightboxItems()}
      .selectedIndex=${selected}
      @lightbox-expand=${() => this.openInHost(selected)}
      @lightbox-navigate=${(event: CustomEvent<{ index: number }>) =>
        (this.selected = event.detail.index)}
    ></media-lightbox>`;
  }

  private openInHost(index: number) {
    this.dispatchEvent(
      new CustomEvent('artifact-open', {
        detail: { index },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** One viewer item per artifact, so a tree index is also the viewer index. */
  private lightboxItems(): LightboxItem[] {
    if (this.previewItems?.source !== this.artifacts)
      this.previewItems = {
        source: this.artifacts,
        items: this.artifacts.map((artifact, index) => ({
          url: this.artifactHref?.(index) ?? '',
          path: artifact.path,
          purpose: artifact.purpose,
        })),
      };
    return this.previewItems.items;
  }

  private renderKeyFiles() {
    const keyFiles = this.keyFiles();
    if (!keyFiles.length) return nothing;
    return html`<div class="key-files" role="group" aria-label="Key files">
      ${keyFiles.map(
        (file) =>
          html`<button
            class="chip"
            aria-pressed=${this.wide && this.currentSelection() === file.index}
            title=${this.artifacts[file.index]?.path ?? ''}
            @click=${() => this.open(file.index)}
          >
            ${file.label}
          </button>`,
      )}
    </div>`;
  }

  private keyFileCache?: {
    source: readonly ArtifactBrowserItem[];
    files: ArtifactBrowserKeyFile[];
  };

  /** Computed once per artifact list: every row asks for the selection. */
  private keyFiles(): ArtifactBrowserKeyFile[] {
    if (this.keyFileCache?.source !== this.artifacts)
      this.keyFileCache = {
        source: this.artifacts,
        files: artifactBrowserKeyFiles(this.artifacts),
      };
    return this.keyFileCache.files;
  }

  private currentSelection(): number {
    return this.selected ?? this.keyFiles()[0]?.index ?? 0;
  }

  private highlight(name: string) {
    const lower = name.toLowerCase();
    const term = artifactBrowserQueryTerms(this.query).find((candidate) =>
      lower.includes(candidate),
    );
    if (!term) return name;
    const start = lower.indexOf(term);
    return html`${name.slice(0, start)}<mark>${name.slice(
      start,
      start + term.length,
    )}</mark>${name.slice(start + term.length)}`;
  }

  private renderToolbar(shown: number) {
    const counts = workspaceArtifactTypeCounts(this.artifacts);
    return html`<div class="toolbar">
      <input
        class="search"
        type="search"
        placeholder="Filter files"
        aria-label="Filter files"
        .value=${this.query}
        @input=${(event: Event) => (this.query = (event.target as HTMLInputElement).value)}
        @keydown=${(event: KeyboardEvent) => this.onSearchKey(event)}
      />
      <div class="chips" role="group" aria-label="File types">
        ${ARTIFACT_TYPES.filter((type) => counts[type] > 0).map(
          (type) =>
            html`<button
              class="chip"
              aria-pressed=${this.types.has(type)}
              @click=${() => this.toggleType(type)}
            >
              ${workspaceArtifactTypeLabel(type)}<span>${counts[type]}</span>
            </button>`,
        )}
      </div>
      ${this.filtering
        ? html`<span class="match-count">${shown} of ${this.artifacts.length}</span>`
        : nothing}
    </div>`;
  }

  private onTreeKey(event: KeyboardEvent, rows: ArtifactBrowserRow<ArtifactBrowserItem>[]) {
    const action = artifactBrowserKeyAction(rows, this.focusedRow(rows), event.key);
    const row = action && rows[action.row];
    if (!action || !row) return;
    event.preventDefault();
    const { node } = row;
    if (action.kind === 'toggle') {
      this.toggle(artifactBrowserNodeKey(node), row.open);
    } else if (action.kind === 'open' && node.kind === 'file') {
      if (this.wide) this.openInHost(node.index);
      else this.open(node.index);
    } else if (action.kind === 'focus') {
      void this.focusRow(node);
      if (this.wide && node.kind === 'file') this.selected = node.index;
    }
  }

  private focusedRow(rows: ArtifactBrowserRow<ArtifactBrowserItem>[]): number {
    const byKey = rows.findIndex(({ node }) => artifactBrowserNodeKey(node) === this.focusedKey);
    if (byKey >= 0) return byKey;
    const selected = this.currentSelection();
    return Math.max(
      0,
      rows.findIndex(({ node }) => node.kind === 'file' && node.index === selected),
    );
  }

  private async focusRow(node: ArtifactBrowserRow<ArtifactBrowserItem>['node']) {
    const key = artifactBrowserNodeKey(node);
    this.focusedKey = key;
    await this.updateComplete;
    const row = [...this.renderRoot.querySelectorAll<HTMLElement>('.row')].find(
      (element) => element.dataset.key === key,
    );
    row?.focus();
    row?.scrollIntoView({ block: 'nearest' });
  }

  private onSearchKey(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    this.query = '';
    this.renderRoot.querySelector<HTMLElement>('.row[tabindex="0"]')?.focus();
  }

  private onHostKey = (event: KeyboardEvent) => {
    const path = event.composedPath();
    const typing = path.some(
      (target) =>
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable),
    );
    if (event.key !== '/' || typing) return;
    const search = this.renderRoot.querySelector<HTMLInputElement>('.search');
    if (!search) return;
    event.preventDefault();
    search.focus();
  };

  private renderRow(
    { node, depth, open }: ArtifactBrowserRow<ArtifactBrowserItem>,
    focused: boolean,
  ) {
    const indent = `padding-left:${depth * 16}px`;
    const key = artifactBrowserNodeKey(node);
    if (node.kind === 'file') {
      const { artifact } = node;
      const url = this.artifactHref?.(node.index) ?? '#';
      const selected = this.wide && node.index === this.currentSelection();
      return html`<li
        class="row ${selected ? 'selected' : ''}"
        role="treeitem"
        aria-selected=${selected}
        tabindex=${focused ? 0 : -1}
        data-key=${key}
        style=${indent}
        @click=${() => (this.focusedKey = key)}
      >
        <span class="chevron"></span>
        <a
          class="file"
          tabindex="-1"
          href=${gatewayMediaSrc(url)}
          title=${artifact.path}
          @click=${(event: Event) => this.open(node.index, event)}
          ><span class="file-name">${this.highlight(node.name)}</span></a
        >
        <span class="meta"
          >${artifact.purpose && artifact.purpose !== 'other'
            ? `${artifact.purpose} · `
            : ''}${artifact.sizeBytes != null ? formatBytes(artifact.sizeBytes) : ''}</span
        >
      </li>`;
    }
    const count = node.kind === 'folder' ? node.fileCount : node.files.length;
    return html`<li
      class="row"
      role="treeitem"
      aria-expanded=${open}
      tabindex=${focused ? 0 : -1}
      data-key=${key}
      style=${indent}
      @click=${() => (this.focusedKey = key)}
    >
      <button class="toggle" tabindex="-1" @click=${() => this.toggle(key, open)}>
        <span class="chevron">${open ? '▾' : '▸'}</span>
        <span>${node.kind === 'folder' ? `${node.name}/` : node.name}</span>
        <span class="meta">${node.kind === 'folder' ? count : `${count} attempts`}</span>
      </button>
    </li>`;
  }

  render() {
    const tree = artifactBrowserTree(this.artifacts, { query: this.query, types: this.types });
    const rows = artifactBrowserRows(tree, this.isOpen);
    const focusedRow = this.focusedRow(rows);
    const browse = html`
      ${this.renderKeyFiles()}
      ${this.artifacts.length >= TOOLBAR_MIN_FILES ? this.renderToolbar(tree.fileCount) : nothing}
      ${rows.length
        ? html`<ul
            class="tree"
            role="tree"
            aria-label="Files"
            @keydown=${(event: KeyboardEvent) => this.onTreeKey(event, rows)}
          >
            ${rows.map((row, index) => this.renderRow(row, index === focusedRow))}
          </ul>`
        : html`<div class="empty">No files match.</div>`}
    `;
    const selected = this.currentSelection();
    if (this.wide)
      return html`<div class="frame">
        <div class="split">
          <div class="browse">${browse}</div>
          ${this.renderPreview(selected)}
        </div>
      </div>`;
    return html`<div class="frame">${browse}</div>
      ${this.overlay
        ? html`<div class="overlay-scrim" @click=${() => (this.overlay = false)}></div>
            <aside
              class="overlay"
              role="dialog"
              aria-label="File preview"
              tabindex="-1"
              @keydown=${(event: KeyboardEvent) => {
                if (event.key !== 'Escape') return;
                event.stopPropagation();
                this.overlay = false;
              }}
            >
              <div class="overlay-bar">
                <button class="chip" @click=${() => (this.overlay = false)}>Close</button>
              </div>
              ${this.renderPreview(selected)}
            </aside>`
        : nothing}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'artifact-browser': ArtifactBrowser;
  }
}
