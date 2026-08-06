import type {
  EvidenceManifestStandalone,
  FsListResult,
  FsReadResult,
  GitDiffResult,
  GitStatusResult,
  SlotHealth,
  SlotStatus,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { isRecoveryEpochCurrent } from '../../utils/reconnect.js';

import type { SlotView } from './slot-view.js';
import { branchDiffPollAction } from './slot-view-branch-model.js';
import {
  isDirectoryReadErrorMessage,
  isImageFile,
  isMediaFile,
  realPath,
} from './slot-view-model.js';
import { updateSlotViewTreeChildren } from './slot-view-tree-model.js';

type LoadContentOptions = {
  diffBase?: string;
  /** With diffBase: 'worktree' diffs merge-base→working tree (default committed only). */
  diffTarget?: 'head' | 'worktree';
  /** Rename old side — keeps renamed files diffing as renames, not adds. */
  requestOldPath?: string;
  errorFallback?: string | null;
  requestPath?: string;
  skipMedia?: boolean;
  warnLabel?: string;
};

function isCurrentLiveResult(view: SlotView, epoch: number) {
  return epoch === view._recoveryEpoch && isRecoveryEpochCurrent(epoch);
}

export async function initSlotViewLive(view: SlotView, epoch: number) {
  view._teardownLive();
  view._wsLoading = true;
  view._wsError = '';
  view._recoveryPhase = 'rehydrating';
  view._liveEntries = [];
  view._liveGitData = null;
  view._liveFileContents = new Map();
  view._liveDiffContents = new Map();

  try {
    const [fsResult, gitResult] = await Promise.all([
      gateway.request<FsListResult>(Methods.FS_LIST, {
        slotId: view.slotId,
        path: '.',
        includeIgnored: view._showIgnored,
      }),
      gateway.request<GitStatusResult>(Methods.GIT_STATUS, { slotId: view.slotId }),
    ]);
    if (!isCurrentLiveResult(view, epoch)) return;
    view._liveEntries = fsResult.entries;
    view._liveGitData = {
      branch: gitResult.branch,
      headSha: gitResult.headSha,
      ahead: gitResult.ahead,
      behind: gitResult.behind,
      changes: gitResult.changes,
    };
  } catch (err) {
    if (!isCurrentLiveResult(view, epoch)) return;
    view._wsError = err instanceof Error ? err.message : 'Failed to load workspace';
    view._recoveryPhase = 'error';
    view._recoveryMessage = 'Workspace recovery failed — retry to continue';
  } finally {
    if (isCurrentLiveResult(view, epoch) && view._recoveryPhase !== 'error') {
      view._recoveryPhase = 'live';
      view._recoveryMessage = '';
    }
    if (view._recoveryEpoch === epoch) view._wsLoading = false;
  }

  view._gitPollTimer = setInterval(() => view._refreshGitStatus(), 30_000);

  // Load file index for quick file search
  view._loadFileIndex();

  // Restore file from URL (if ?file= present)
  await view._restoreFileFromUrl();
  // Restore history modal state from URL (if ?history=1[&historyRun=<id>])
  view._restoreHistoryFromUrl();

  // Auto-pin task folder if slot is working and has a taskFile
  view._autoPinTaskFolder();

  // Resolve the PR base before loading changed files. Falling back to a stale
  // local `main` can inflate the source tree far beyond GitHub's PR diff.
  await view._detectPR();
  view._loadBranchDiff();

  // Load pinned folder entries if set
  if (view._pinnedFolder) view._loadPinnedEntries();
}

export function teardownSlotViewLive(view: SlotView) {
  if (view._gitPollTimer) {
    clearInterval(view._gitPollTimer);
    view._gitPollTimer = null;
  }
}

export async function refreshSlotViewGitStatus(view: SlotView) {
  if (!view._isLive) return;
  const epoch = view._recoveryEpoch;
  try {
    const result = await gateway.request<GitStatusResult>(Methods.GIT_STATUS, {
      slotId: view.slotId,
    });
    if (!isCurrentLiveResult(view, epoch)) return;
    const prevBranch = view._liveGitData?.branch;
    const prevAhead = view._liveGitData?.ahead;
    const prevHeadSha = view._liveGitData?.headSha;
    view._liveGitData = {
      branch: result.branch,
      headSha: result.headSha,
      ahead: result.ahead,
      behind: result.behind,
      changes: result.changes,
    };
    const pollAction = branchDiffPollAction({
      prevBranch,
      nextBranch: result.branch,
      prevAhead,
      nextAhead: result.ahead,
      prevHeadSha,
      nextHeadSha: result.headSha,
      lastLoadFailed: view._branchDiffError !== null,
      loading: view._branchDiffLoading,
    });
    if (pollAction !== 'none') {
      if (pollAction === 'reload-and-clear-cache') view._liveDiffContents.clear();
      view._loadBranchDiff();
    }
  } catch (err) {
    console.warn(
      '[slot-view] git status poll failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function loadSlotViewDirectory(view: SlotView, dirPath: string) {
  const epoch = view._recoveryEpoch;
  try {
    const result = await gateway.request<FsListResult>(Methods.FS_LIST, {
      slotId: view.slotId,
      path: dirPath,
      includeIgnored: view._showIgnored,
    });
    if (!isCurrentLiveResult(view, epoch)) return;
    view._liveEntries = updateSlotViewTreeChildren(view._liveEntries, dirPath, result.entries);
  } catch (err) {
    if (!isCurrentLiveResult(view, epoch)) return;
    view._wsError = err instanceof Error ? err.message : 'Failed to load directory';
    view._recoveryPhase = 'error';
    view._recoveryMessage = 'Directory recovery failed — retry to continue';
  }
}

export async function reloadSlotViewTree(view: SlotView) {
  if (!view._isLive) return;
  try {
    const result = await gateway.request<FsListResult>(Methods.FS_LIST, {
      slotId: view.slotId,
      path: '.',
      includeIgnored: view._showIgnored,
    });
    view._liveEntries = result.entries;
  } catch (err) {
    console.warn(
      '[slot-view] reload tree failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function loadSlotViewFileContent(
  view: SlotView,
  path: string,
  options: LoadContentOptions = {},
) {
  if (options.skipMedia && (isImageFile(path) || isMediaFile(path))) return true;
  if (!view._isLive || view._liveFileContents.has(path)) return true;

  const epoch = view._recoveryEpoch;
  try {
    const result = await gateway.request<FsReadResult>(Methods.FS_READ, {
      slotId: view.slotId,
      path,
    });
    if (!isCurrentLiveResult(view, epoch)) return false;
    const next = new Map(view._liveFileContents);
    next.set(path, result.content);
    view._liveFileContents = next;
    return true;
  } catch (err) {
    if (!isCurrentLiveResult(view, epoch)) return false;
    const message = err instanceof Error ? err.message : String(err);
    if (isDirectoryReadErrorMessage(message)) {
      // A direct file URL/search hit can point at a symlinked directory such as
      // `.observability`. Treat it as a folder, not as a failed plaintext file.
      await loadSlotViewDirectory(view, path);
      return false;
    }
    if (options.warnLabel) {
      console.warn(`[slot-view] ${options.warnLabel}:`, message);
    }
    if (options.errorFallback !== null) {
      const next = new Map(view._liveFileContents);
      next.set(path, `Error: ${message || (options.errorFallback ?? 'Failed to read file')}`);
      view._liveFileContents = next;
    }
    return true;
  }
}

export async function loadSlotViewDiffContent(
  view: SlotView,
  path: string,
  options: LoadContentOptions = {},
) {
  if (!view._isLive || view._liveDiffContents.has(path)) return true;

  const epoch = view._recoveryEpoch;
  try {
    const result = await gateway.request<GitDiffResult>(Methods.GIT_DIFF, {
      slotId: view.slotId,
      path: options.requestPath ?? path,
      ...(options.diffBase ? { base: options.diffBase } : {}),
      ...(options.diffBase && options.diffTarget ? { target: options.diffTarget } : {}),
      ...(options.requestOldPath ? { oldPath: options.requestOldPath } : {}),
    });
    if (!isCurrentLiveResult(view, epoch)) return false;
    const next = new Map(view._liveDiffContents);
    next.set(path, result.diff);
    view._liveDiffContents = next;
    return true;
  } catch (err) {
    if (!isCurrentLiveResult(view, epoch)) return false;
    if (options.warnLabel) {
      console.warn(
        `[slot-view] ${options.warnLabel}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    if (options.errorFallback !== null) {
      const next = new Map(view._liveDiffContents);
      next.set(
        path,
        `Error: ${err instanceof Error ? err.message : (options.errorFallback ?? 'Failed to load diff')}`,
      );
      view._liveDiffContents = next;
    }
    return true;
  }
}

export async function toggleSlotViewEditorMode(view: SlotView) {
  const tab = view._openFiles.find((f) => f.path === view._activeFile);
  if (!tab) return;

  const newType = tab.type === 'diff' ? 'file' : 'diff';
  const isBranchDiff = tab.path.startsWith('branch:');
  const filePath = realPath(tab.path);

  // Fetch data if not cached
  if (newType === 'file' && view._isLive) {
    // For branch diffs, switch to a normal file tab with the real path
    if (isBranchDiff) {
      await loadSlotViewFileContent(view, filePath, {
        errorFallback: null,
        warnLabel: 'failed to load branch diff file',
      });
      // Replace the branch diff tab with a normal file tab
      view._openFiles = view._openFiles.map((f) =>
        f.path === tab.path ? { ...f, path: filePath, type: 'file', diffBase: undefined } : f,
      );
      view._activeFile = filePath;
      return;
    }
    await loadSlotViewFileContent(view, tab.path, {
      errorFallback: null,
      warnLabel: 'failed to load file tab',
    });
  }
  if (newType === 'diff' && view._isLive && !view._liveDiffContents.has(tab.path)) {
    await loadSlotViewDiffContent(view, tab.path, {
      errorFallback: null,
      warnLabel: 'failed to load diff tab',
    });
  }

  // Update tab type
  view._openFiles = view._openFiles.map((f) => (f.path === tab.path ? { ...f, type: newType } : f));
}

export async function handleSlotViewFileSelect(view: SlotView, path: string) {
  view._cancelFileRestoreRetry();
  const loaded = await loadSlotViewFileContent(view, path, {
    errorFallback: 'Failed to read file',
    skipMedia: true,
  });
  if (!loaded) return;
  openSlotViewFile(view, path, 'file');
}

export async function handleSlotViewChangeSelect(view: SlotView, path: string, status?: string) {
  // Smart default: A/? (added/untracked) have no useful diff → open as code
  const useCodeView = status === 'A' || status === '?';

  if (useCodeView) {
    const loaded = await loadSlotViewFileContent(view, path, {
      errorFallback: 'Failed to read file',
    });
    if (!loaded) return;
    openSlotViewFile(view, path, 'file');
    return;
  }

  const loaded = await loadSlotViewDiffContent(view, path, {
    errorFallback: 'Failed to load diff',
  });
  if (!loaded) return;
  openSlotViewFile(view, path, 'diff');
}

export function openSlotViewFile(
  view: SlotView,
  path: string,
  type: 'file' | 'diff' = 'file',
  pin = false,
) {
  const exists = view._openFiles.find((f) => f.path === path);
  if (exists) {
    // If already open, just activate (and pin if requested)
    if (pin && !exists.pinned) {
      view._openFiles = view._openFiles.map((f) => (f.path === path ? { ...f, pinned: true } : f));
    }
    view._activeFile = path;
    return;
  }

  if (pin) {
    // Pinned tab: just add it
    view._openFiles = [...view._openFiles, { path, type, pinned: true }];
  } else {
    // Preview tab: replace any existing preview tab
    const hasPreview = view._openFiles.some((f) => !f.pinned);
    if (hasPreview) {
      view._openFiles = [...view._openFiles.filter((f) => f.pinned), { path, type, pinned: false }];
    } else {
      view._openFiles = [...view._openFiles, { path, type, pinned: false }];
    }
  }
  view._activeFile = path;
}

export function pinSlotViewFile(view: SlotView, path: string) {
  view._openFiles = view._openFiles.map((f) => (f.path === path ? { ...f, pinned: true } : f));
}

export async function handleSlotViewTreeAction(
  view: SlotView,
  detail: { action: string; path: string; type: string },
) {
  if (!view._isLive || view._isRecoveryBlocked) return;
  const { action, path: filePath } = detail;

  switch (action) {
    case 'pin-folder': {
      view._pinFolder(filePath);
      return;
    }
    case 'new-file': {
      // Pre-fill the new file prompt with the folder path
      view._newFilePrompt = true;
      view._newFilePath = filePath + '/';
      return;
    }
    case 'new-folder': {
      const name = prompt('Folder name:');
      if (!name) return;
      const folderPath = filePath + '/' + name;
      try {
        await gateway.request(Methods.FS_MKDIR, { slotId: view.slotId, path: folderPath });
        view._reloadTree();
      } catch (err) {
        console.error('[slot-view] mkdir failed:', err);
      }
      return;
    }
    case 'rename': {
      const oldName = filePath.split('/').pop() || filePath;
      const newName = prompt('Rename to:', oldName);
      if (!newName || newName === oldName) return;
      const dir = filePath.includes('/')
        ? filePath.substring(0, filePath.lastIndexOf('/') + 1)
        : '';
      try {
        await gateway.request(Methods.FS_RENAME, {
          slotId: view.slotId,
          oldPath: filePath,
          newPath: dir + newName,
        });
        view._reloadTree();
      } catch (err) {
        console.error('[slot-view] rename failed:', err);
      }
      return;
    }
    case 'copy-path': {
      navigator.clipboard.writeText(filePath).catch((err) => {
        // Clipboard write can fail when the page is not focused or in insecure contexts.
        console.warn('[slot-view] clipboard write failed:', (err as Error).message);
      });
      return;
    }
    case 'reveal': {
      try {
        await gateway.request(Methods.FS_REVEAL, { slotId: view.slotId, path: filePath });
      } catch (err) {
        console.error('[slot-view] reveal failed:', err);
      }
      return;
    }
    case 'delete': {
      if (!confirm(`Delete ${filePath}?`)) return;
      try {
        await gateway.request(Methods.FS_DELETE, { slotId: view.slotId, path: filePath });
        view._openFiles = view._openFiles.filter((f) => f.path !== filePath);
        if (view._activeFile === filePath) {
          view._activeFile =
            view._openFiles.length > 0 ? view._openFiles[view._openFiles.length - 1].path : '';
        }
        view._reloadTree();
      } catch (err) {
        console.error('[slot-view] delete failed:', err);
      }
      return;
    }
  }
}

export async function createSlotViewFile(view: SlotView) {
  const filePath = view._newFilePath.trim();
  if (!filePath || !view._isLive || view._isRecoveryBlocked) return;
  try {
    await gateway.request(Methods.FS_WRITE, {
      slotId: view.slotId,
      path: filePath,
      content: '',
    });
    // Cache empty content and open in edit mode
    const next = new Map(view._liveFileContents);
    next.set(filePath, '');
    view._liveFileContents = next;
    view._openFile(filePath, 'file', true);
    view._newFilePrompt = false;
    view._newFilePath = '';
  } catch (err) {
    console.error('[slot-view] create file failed:', err);
  }
}

export function traceEntriesToEvidenceManifest(json: unknown) {
  const entries = Array.isArray(json)
    ? json
    : json && typeof json === 'object' && Array.isArray((json as { entries?: unknown }).entries)
      ? (json as { entries: unknown[] }).entries
      : [];
  const manifest: EvidenceManifestStandalone[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as {
      nodeId?: unknown;
      id?: unknown;
      evidence?: unknown;
      file?: unknown;
      note?: unknown;
    };
    const label =
      typeof row.nodeId === 'string' ? row.nodeId : typeof row.id === 'string' ? row.id : '';
    const file =
      typeof row.evidence === 'string'
        ? row.evidence
        : typeof row.file === 'string'
          ? row.file
          : '';
    if (!label || !file) continue;
    manifest.push({
      label,
      file,
      ...(typeof row.note === 'string' ? { note: row.note } : {}),
    });
  }
  return manifest;
}

export function slotViewResourceHealthItems(slot: SlotStatus) {
  const RESOURCE_HEALTH: Record<string, { label: string; field: keyof SlotHealth }> = {
    'ios-sim': { label: 'iOS Sim', field: 'device' },
    'ios-device': { label: 'iOS Dev', field: 'device' },
    'android-emu': { label: 'Android', field: 'device' },
    'android-device': { label: 'Android', field: 'device' },
    'dev-server': { label: 'DevSrv', field: 'devserver' },
    browser: { label: 'Browser', field: 'cdp' },
  };
  if (slot.resources && Object.keys(slot.resources).length > 0) {
    const items: Array<[string, string]> = [];
    for (const key of Object.keys(slot.resources)) {
      const mapping = RESOURCE_HEALTH[key];
      if (mapping) {
        const val = slot.health[mapping.field];
        if (val && val !== '-') items.push([mapping.label, val]);
      }
    }
    // Include CDP if not already covered by a browser resource but health exists
    if (!slot.resources['browser'] && slot.health.cdp && slot.health.cdp !== '-') {
      items.push(['CDP', slot.health.cdp]);
    }
    return items;
  }
  // Fallback: show all non-dash health items
  return (['device', 'devserver', 'cdp'] as const)
    .filter((k) => slot.health[k] && slot.health[k] !== '-')
    .map((k) => [k === 'device' ? 'Device' : k === 'devserver' ? 'DevSrv' : 'CDP', slot.health[k]]);
}
