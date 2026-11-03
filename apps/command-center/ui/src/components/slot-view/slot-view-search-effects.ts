import type { DiagnosticsRunResult, GitFilesResult, SearchQueryResult } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { gateway } from '../../gateway-client.js';

import type { SlotView } from './slot-view.js';
import { fuzzyFilterSlotViewFiles } from './slot-view-search-model.js';

export async function runSlotViewDiagnostics(view: SlotView) {
  if (!view._isLive || view._diagnosticsLoading) return;
  view._diagnosticsLoading = true;
  try {
    const result = await gateway.request<DiagnosticsRunResult>(Methods.DIAGNOSTICS_RUN, {
      slotId: view.slotId,
    });
    view._diagnostics = result.diagnostics;
    view._diagnosticsTruncated = result.truncated;
  } catch (err) {
    console.warn(
      '[slot-view] diagnostics run failed:',
      err instanceof Error ? err.message : String(err),
    );
    view._diagnostics = [];
  } finally {
    view._diagnosticsLoading = false;
  }
}

export async function handleSlotViewDiagnosticNavigate(
  view: SlotView,
  detail: { path: string; line: number },
) {
  view._revealLine = 0;
  await view._handleFileSelect(detail.path);
  if (detail.line) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        view._revealLine = detail.line;
      }),
    );
  }
}

export async function executeSlotViewSearch(view: SlotView) {
  if (!view._searchQuery.trim() || !view._isLive) return;
  view._searchLoading = true;
  view._searchResults = [];
  view._searchTruncated = false;
  try {
    const result = await gateway.request<SearchQueryResult>(Methods.SEARCH_QUERY, {
      slotId: view.slotId,
      pattern: view._searchQuery,
      maxResults: 200,
    });
    view._searchResults = result.matches;
    view._searchTruncated = result.truncated;
  } catch (err) {
    console.warn('[slot-view] search failed:', err instanceof Error ? err.message : String(err));
    view._searchResults = [];
  } finally {
    view._searchLoading = false;
  }
}

export function openSlotViewSearchResult(view: SlotView, file: string, _line: number) {
  view._handleFileSelect(file);
}

/** Binds the slot's stored file list; it is read again each time the view opens it. */
export function loadSlotViewFileIndex(view: SlotView) {
  view._fileIndexQuery.setQuery(
    view._isLive
      ? resourceQuery<GitFilesResult>(Methods.GIT_FILES, { slotId: view.slotId })
      : undefined,
  );
}

/** A file command that added, removed or renamed files rereads the file list once. */
export function refreshSlotViewFileIndex(view: SlotView) {
  void view._fileIndexQuery.retry();
}

export function handleSlotViewSearchInput(view: SlotView) {
  if (view._searchMode !== 'files') return;
  if (!view._searchQuery) {
    view._fileSearchResults = [];
    return;
  }
  view._fileSearchResults = fuzzyFilterSlotViewFiles(view._fileIndex, view._searchQuery);
}
