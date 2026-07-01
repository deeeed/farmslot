import { html, nothing } from 'lit';

import { colors, fonts } from '../../styles/theme-tokens.js';
import { gatewayResourceUrl } from '../../utils/gateway-origin.js';

import type { SlotView } from './slot-view.js';
import { basename, extToLanguage, isImageFile, isMediaFile, realPath } from './slot-view-model.js';

export function renderSearchPanel(view: SlotView) {
  return html`
    <div class="sv-search-panel">
      <div class="sv-search-mode-toggle">
        <button
          class="sv-search-mode-btn ${view._searchMode === 'files' ? 'active' : ''}"
          @click=${() => {
            view._searchMode = 'files';
            view._onSearchInput();
          }}
        >
          Files
        </button>
        <button
          class="sv-search-mode-btn ${view._searchMode === 'content' ? 'active' : ''}"
          @click=${() => {
            view._searchMode = 'content';
          }}
        >
          Content
        </button>
      </div>
      <input
        class="sv-search-input"
        type="text"
        placeholder="${view._searchMode === 'files'
          ? 'Search file names...'
          : 'Search in files...'}"
        .value=${view._searchQuery}
        @input=${(e: InputEvent) => {
          view._searchQuery = (e.target as HTMLInputElement).value;
          if (view._searchMode === 'files') view._onSearchInput();
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === 'Enter' && view._searchMode === 'content') view._executeSearch();
        }}
      />
      ${view._searchMode === 'files'
        ? view._renderFileSearchResults()
        : view._renderContentSearchResults()}
    </div>
  `;
}

export function renderFileSearchResults(view: SlotView) {
  if (!view._searchQuery) {
    return html`<div class="sv-search-status">
      ${view._fileIndex.length > 0
        ? `${view._fileIndex.length} files indexed`
        : 'Loading file index...'}
    </div>`;
  }
  if (view._fileSearchResults.length === 0) {
    return html`<div class="sv-search-status">No files found</div>`;
  }
  return html`
    <div class="sv-search-results">
      ${view._fileSearchResults.slice(0, 100).map(
        (filePath: string) => html`
          <div class="sv-search-match" @click=${() => view._handleFileSelect(filePath)}>
            <span class="sv-file-result-name">${basename(filePath)}</span>
            <span class="sv-file-result-dir"
              >${filePath.substring(0, filePath.length - basename(filePath).length)}</span
            >
          </div>
        `,
      )}
      ${view._fileSearchResults.length > 100
        ? html`
            <div class="sv-search-status">${view._fileSearchResults.length - 100} more...</div>
          `
        : ''}
    </div>
  `;
}

export function renderContentSearchResults(view: SlotView) {
  const groups = new Map<string, Array<{ line: number; column: number; text: string }>>();
  for (const m of view._searchResults) {
    if (!groups.has(m.file)) groups.set(m.file, []);
    groups.get(m.file)!.push({ line: m.line, column: m.column, text: m.text });
  }

  return html`
    ${view._searchLoading ? html`<div class="sv-search-status">Searching...</div>` : ''}
    ${!view._searchLoading && view._searchResults.length === 0 && view._searchQuery
      ? html` <div class="sv-search-status">No results (press Enter to search)</div> `
      : ''}
    <div class="sv-search-results">
      ${[...groups.entries()].map(
        ([file, matches]) => html`
          <div class="sv-search-file-group">
            <div class="sv-search-file-header">${file}</div>
            ${matches.map(
              (m) => html`
                <div class="sv-search-match" @click=${() => view._openSearchResult(file, m.line)}>
                  <span class="sv-search-line-num">${m.line}</span>
                  <span class="sv-search-line-text">${m.text}</span>
                </div>
              `,
            )}
          </div>
        `,
      )}
    </div>
    ${view._searchTruncated
      ? html`<div class="sv-search-status">Results truncated (max 200)</div>`
      : ''}
  `;
}

export function renderSourcePanel(view: SlotView) {
  const hasPinned = !!view._pinnedFolder;
  const pinnedOpen = hasPinned && view._sections.pinned !== false;
  const sourceOpen = view._sections.source;

  return html`
    ${hasPinned
      ? html`
          <div class="sv-section-header" @click=${() => view._toggleSection('pinned')}>
            <span class="sv-section-arrow">${pinnedOpen ? '\u25BE' : '\u25B8'}</span>
            <span class="sv-section-title">${view._pinnedFolder}</span>
            <button
              class="sv-unpin-btn"
              title="Unpin folder"
              @click=${(e: Event) => {
                e.stopPropagation();
                view._unpinFolder();
              }}
            >
              ×
            </button>
          </div>
          ${pinnedOpen
            ? html`
                <div class="sv-section-body sv-pinned-body" style="height:${view._pinnedHeight}px">
                  <file-tree
                    .entries=${view._pinnedEntries}
                    .gitStatus=${view._gitStatusMap}
                    .selectedPath=${realPath(view._activeFile)}
                    @file-select=${(e: CustomEvent) => view._handleFileSelect(e.detail.path)}
                    @file-pin=${(e: CustomEvent) => {
                      view._handleFileSelect(e.detail.path);
                      view._pinFile(e.detail.path);
                    }}
                    @dir-expand=${(e: CustomEvent) => view._handlePinnedDirExpand(e.detail.path)}
                    @tree-action=${(e: CustomEvent) => view._handleTreeAction(e.detail)}
                  ></file-tree>
                </div>
                <div
                  class="sv-resize-v ${view._resizing === 'pinned' ? 'active' : ''}"
                  @mousedown=${(e: MouseEvent) => view._onResizeStart('pinned', e)}
                ></div>
              `
            : nothing}
        `
      : ''}

    <div class="sv-section-header" @click=${() => view._toggleSection('source')}>
      <span class="sv-section-arrow">${sourceOpen ? '\u25BE' : '\u25B8'}</span>
      <span class="sv-section-title">Source Control</span>
      ${(() => {
        const uncommitted = view._git?.changes.length ?? 0;
        const committed = view._branchDiffFiles.length;
        const total = uncommitted + committed;
        return total > 0 ? html` <span class="sv-section-badge">${total}</span> ` : '';
      })()}
    </div>
    ${sourceOpen
      ? html` <div class="sv-section-body sv-source-body">${view._renderSidebarSource()}</div> `
      : nothing}
  `;
}

export function renderEditorHeader(view: SlotView) {
  const tab = view._openFiles.find((f: { path: string }) => f.path === view._activeFile);
  if (!tab) return nothing;

  const filePath = realPath(tab.path);
  const isBranchDiff = tab.path.startsWith('branch:');
  const hasChanges = view._isChangedFile(filePath) || isBranchDiff;
  const fileCommentCount = view._getCommentThreadsForFile(filePath).length;
  return html`
    <div class="sv-editor-header">
      <span class="sv-editor-filepath"
        >${filePath}${isBranchDiff
          ? html` <span style="color:${colors.textMuted}; font-size:${fonts.sizeXs}"
              >(vs ${view._branchDiffBase})</span
            >`
          : ''}</span
      >
      <div class="sv-editor-header-actions">
        ${view._prNumber && tab.type === 'file'
          ? html`
              <button
                class="sv-mode-toggle ${view._showInlineComments ? 'active' : ''}"
                @click=${() => {
                  view._showInlineComments = !view._showInlineComments;
                }}
                title="Toggle inline review comments"
              >
                ${fileCommentCount > 0 ? `Comments (${fileCommentCount})` : 'Comments'}
              </button>
            `
          : ''}
        ${hasChanges
          ? html`
              <button
                class="sv-mode-toggle ${tab.type === 'file' ? '' : 'active'}"
                @click=${view._toggleEditorMode}
                title="Toggle between code and diff view"
              >
                ${tab.type === 'diff' ? 'Code' : 'Diff'}
              </button>
            `
          : ''}
        ${tab.type === 'file' && !isImageFile(filePath) && !isMediaFile(filePath)
          ? html`
              <button
                class="sv-save-btn ${view._saveFeedback}"
                ?disabled=${view._saveFeedback === 'saving'}
                @click=${view._saveFile}
                title="Save (writes to disk)"
              >
                ${view._saveFeedback === 'saving'
                  ? 'Saving...'
                  : view._saveFeedback === 'saved'
                    ? 'Saved'
                    : 'Save'}
              </button>
            `
          : ''}
      </div>
    </div>
  `;
}

export function renderEditor(view: SlotView) {
  if (!view._activeFile) {
    return html`<div class="sv-empty-editor">Select a file to view</div>`;
  }

  const tab = view._openFiles.find((f: { path: string }) => f.path === view._activeFile);
  if (!tab) {
    return html`<div class="sv-empty-editor">Select a file to view</div>`;
  }

  if (tab.type === 'diff') {
    const diff = view._diffs.get(view._activeFile) ?? '';
    if (!diff) return html`<div class="sv-empty-editor">No diff available</div>`;
    return html`<diff-review
      .diff=${diff}
      .filename=${basename(realPath(view._activeFile))}
    ></diff-review>`;
  }

  // Image files — render via gateway HTTP endpoint (proxied through Vite)
  if (isImageFile(view._activeFile)) {
    const src = gatewayResourceUrl(
      `/api/file?slotId=${encodeURIComponent(view.slotId)}&path=${encodeURIComponent(view._activeFile)}`,
    );
    return html`<div class="sv-image-viewer">
      <img src=${src} alt=${basename(view._activeFile)} />
    </div>`;
  }

  // Video files
  if (isMediaFile(view._activeFile)) {
    const src = gatewayResourceUrl(
      `/api/file?slotId=${encodeURIComponent(view.slotId)}&path=${encodeURIComponent(view._activeFile)}`,
    );
    return html`<div class="sv-image-viewer">
      <video controls src=${src}></video>
    </div>`;
  }

  const content = view._files.get(view._activeFile) ?? '';
  const lang = extToLanguage(view._activeFile);
  const commentThreads = view._getCommentThreadsForFile(view._activeFile);
  return html`<code-viewer
    .content=${content || ''}
    .language=${lang}
    .filename=${basename(view._activeFile)}
    .filePath=${view._activeFile}
    .commentThreads=${commentThreads}
    .showComments=${view._showInlineComments}
    .revealLine=${view._revealLine}
    .diagnostics=${view._diagnostics}
    @glyph-click=${(e: CustomEvent) => view._handleGlyphClick(e.detail.line)}
    @open-file=${(e: CustomEvent) => view._handleOpenFile(e.detail.path, e.detail.line)}
  ></code-viewer>`;
}
