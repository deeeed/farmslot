import type {
  EvidenceManifestStandalone,
  FsListResult,
  FsReadResult,
  FsWriteResult,
  GitDiffResult,
  GitStatusResult,
  SlotHealth,
  SlotStatus,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { getResourceCache } from '../../resource-cache.js';
import { retainOpenedChildren } from '../workspace/workspace-reads.js';

import type { SlotView } from './slot-view.js';
import {
  noteSlotViewFileRead,
  noteSlotViewReadAccess,
  refuseSlotViewConditionalWrites,
  slotViewFileQuery,
  slotViewWritable,
} from './slot-view-edit-effects.js';
import { slotViewSaveRefusal } from './slot-view-edit-model.js';
import {
  isDirectoryReadErrorMessage,
  isImageFile,
  isMediaFile,
  parseBranchDiffKey,
  realPath,
} from './slot-view-model.js';
import { updateSlotViewTreeChildren } from './slot-view-tree-model.js';

type LoadContentOptions = {
  diffBase?: string;
  /** Exact reviewed head SHA for frozen committed diffs. */
  diffHead?: string;
  /** With diffBase: 'worktree' diffs merge-base→working tree (default committed only). */
  diffTarget?: 'head' | 'worktree';
  /** Rename old side — keeps renamed files diffing as renames, not adds. */
  requestOldPath?: string;
  errorFallback?: string | null;
  requestPath?: string;
  skipMedia?: boolean;
  warnLabel?: string;
};

/** A file's text: an fs.read answer, or a held new side, which has no hash. */
type LoadedFile = Pick<FsReadResult, 'content' | 'hash'> & { held?: boolean };

function isCurrentLiveResult(view: SlotView, epoch: number, version: number) {
  return (
    epoch === view._recoveryEpoch &&
    gateway.connectionEpoch === epoch &&
    view._workspaceReads.version === version
  );
}

export async function initSlotViewLive(view: SlotView, epoch: number) {
  view._teardownLive();
  const version = view._workspaceReads.version;
  view._wsLoading = true;
  view._wsError = '';
  view._recoveryPhase = 'rehydrating';
  view._liveEntries = [];
  view._liveGitData = null;
  view._liveFileContents = new Map();
  view._liveFileHashes = new Map();
  view._liveDiffContents = new Map();

  try {
    const [fsResult, gitResult] = await Promise.all([
      view._workspaceReads.read<FsListResult>(
        Methods.FS_LIST,
        { slotId: view.slotId, path: '.', includeIgnored: view._showIgnored },
        (result) => {
          if (isCurrentLiveResult(view, epoch, version))
            view._liveEntries = retainOpenedChildren(view._liveEntries, result.entries);
        },
      ),
      view._workspaceReads.read<GitStatusResult>(
        Methods.GIT_STATUS,
        { slotId: view.slotId },
        (result) => {
          if (isCurrentLiveResult(view, epoch, version)) view._liveGitData = result;
        },
      ),
      // File hydration must not wait for another opened snapshot that was evicted.
      view._restoreFileFromUrl(),
    ]);
    if (
      !isCurrentLiveResult(view, epoch, version) ||
      !view._workspaceReads.owns(fsResult) ||
      !view._workspaceReads.owns(gitResult)
    )
      return;
    view._liveEntries = retainOpenedChildren(view._liveEntries, fsResult.entries);
    view._liveGitData = {
      branch: gitResult.branch,
      headSha: gitResult.headSha,
      ahead: gitResult.ahead,
      behind: gitResult.behind,
      changes: gitResult.changes,
    };
  } catch (err) {
    if (!isCurrentLiveResult(view, epoch, version)) return;
    view._wsError = err instanceof Error ? err.message : 'Failed to load workspace';
    view._recoveryPhase = 'error';
    view._recoveryMessage = 'Workspace recovery failed — retry to continue';
  } finally {
    if (isCurrentLiveResult(view, epoch, version) && view._recoveryPhase !== 'error') {
      view._recoveryPhase = view._workspaceReads.ready ? 'live' : 'stale';
      view._recoveryMessage = '';
    }
    if (view._recoveryEpoch === epoch) view._wsLoading = false;
  }

  if (gateway.connectionState !== 'connected') return;
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
  view._workspaceReads.clear();
}

export async function refreshSlotViewGitStatus(view: SlotView) {
  if (!view._isLive) return;
  const epoch = view._recoveryEpoch;
  const version = view._workspaceReads.version;
  try {
    await view._workspaceReads.read<GitStatusResult>(
      Methods.GIT_STATUS,
      { slotId: view.slotId },
      (result) => {
        if (isCurrentLiveResult(view, epoch, version)) view._liveGitData = result;
      },
    );
  } catch (error) {
    if (isCurrentLiveResult(view, epoch, version))
      view._wsError = error instanceof Error ? error.message : String(error);
  }
}

export async function loadSlotViewDirectory(view: SlotView, dirPath: string) {
  const epoch = view._recoveryEpoch;
  const version = view._workspaceReads.version;
  try {
    const result = await view._workspaceReads.read<FsListResult>(
      Methods.FS_LIST,
      {
        slotId: view.slotId,
        path: dirPath,
        includeIgnored: view._showIgnored,
      },
      (result) => {
        if (!isCurrentLiveResult(view, epoch, version)) return;
        view._liveEntries = updateSlotViewTreeChildren(
          view._liveEntries,
          typeof dirPath === 'undefined' ? '.' : dirPath,
          result.entries,
        );
      },
    );
    if (!isCurrentLiveResult(view, epoch, version) || !view._workspaceReads.owns(result)) return;
    view._liveEntries = updateSlotViewTreeChildren(view._liveEntries, dirPath, result.entries);
  } catch (err) {
    if (!isCurrentLiveResult(view, epoch, version)) return;
    view._wsError = err instanceof Error ? err.message : 'Failed to load directory';
    view._recoveryPhase = 'error';
    view._recoveryMessage = 'Directory recovery failed — retry to continue';
  }
}

export async function reloadSlotViewTree(view: SlotView) {
  if (!view._isLive) return;
  const epoch = view._recoveryEpoch;
  const version = view._workspaceReads.version;
  try {
    const result = await view._workspaceReads.read<FsListResult>(
      Methods.FS_LIST,
      {
        slotId: view.slotId,
        path: '.',
        includeIgnored: view._showIgnored,
      },
      (result) => {
        if (!isCurrentLiveResult(view, epoch, version)) return;
        view._liveEntries = updateSlotViewTreeChildren(view._liveEntries, '.', result.entries);
      },
    );
    view._liveEntries = retainOpenedChildren(view._liveEntries, result.entries);
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
  const version = view._workspaceReads.version;
  // Offline, a file the held run diff touches, such as an untracked one, opens from its held new
  // side. It carries no fs.read hash, so it stays read-only; the first answer wins.
  const held = gateway.connectionState === 'connected' ? undefined : new AbortController();
  try {
    const live = view._workspaceReads.read<FsReadResult>(
      Methods.FS_READ,
      {
        slotId: view.slotId,
        path,
      },
      (result) => {
        if (!isCurrentLiveResult(view, epoch, version)) return;
        // The hash travels with its content: the editor checks one against the other.
        view._liveFileContents = new Map(view._liveFileContents).set(path, result.content);
        view._liveFileHashes = new Map(view._liveFileHashes).set(path, result.hash);
        void noteSlotViewFileRead(view, path, result.content, result.hash);
      },
    );
    const fromHeld = held
      ? import('../../held-run-diff.js')
          .then(({ heldRunFileContent }) =>
            heldRunFileContent(getResourceCache(), view._linkedRun, path, { signal: held.signal }),
          )
          .then((content): Promise<LoadedFile> | LoadedFile =>
            content === undefined ? live : { content, held: true },
          )
      : undefined;
    const result: LoadedFile = await (fromHeld ? Promise.race<LoadedFile>([live, fromHeld]) : live);
    if (
      !isCurrentLiveResult(view, epoch, version) ||
      (!result.held && !view._workspaceReads.owns(result))
    )
      return false;
    view._liveFileContents = new Map(view._liveFileContents).set(path, result.content);
    view._liveFileHashes = new Map(view._liveFileHashes).set(path, result.hash);
    if (!result.held) noteSlotViewReadAccess(view, path, true);
    return true;
  } catch (err) {
    if (!isCurrentLiveResult(view, epoch, version)) return false;
    noteSlotViewReadAccess(view, path, false);
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
  } finally {
    held?.abort();
  }
}

export async function loadSlotViewDiffContent(
  view: SlotView,
  path: string,
  options: LoadContentOptions = {},
) {
  if (!view._isLive || view._liveDiffContents.has(path)) return true;

  const epoch = view._recoveryEpoch;
  const version = view._workspaceReads.version;
  // Offline, a per-file read with nothing stored waits for the gateway. The section of the run
  // diff prefetch holds stands in for it; the first answer wins and the other is dropped.
  const held =
    gateway.connectionState === 'connected' || options.diffBase ? undefined : new AbortController();
  try {
    const live = view._workspaceReads.read<GitDiffResult>(
      Methods.GIT_DIFF,
      {
        slotId: view.slotId,
        path: options.requestPath ?? path,
        ...(options.diffBase ? { base: options.diffBase } : {}),
        ...(options.diffHead ? { head: options.diffHead } : {}),
        ...(options.diffBase && options.diffTarget ? { target: options.diffTarget } : {}),
        ...(options.requestOldPath ? { oldPath: options.requestOldPath } : {}),
      },
      (result) => {
        if (!isCurrentLiveResult(view, epoch, version)) return;
        view._liveDiffContents = new Map(view._liveDiffContents).set(path, result.diff);
      },
    );
    const fromHeld = held
      ? import('../../held-run-diff.js')
          .then(({ heldRunFileDiff }) =>
            heldRunFileDiff(getResourceCache(), view._linkedRun, options.requestPath ?? path, {
              signal: held.signal,
            }),
          )
          .then((diff) => (diff === undefined ? live : { diff, held: true }))
      : undefined;
    const result: GitDiffResult & { held?: boolean } = await (fromHeld
      ? Promise.race([live, fromHeld])
      : live);
    if (
      !isCurrentLiveResult(view, epoch, version) ||
      (!result.held && !view._workspaceReads.owns(result))
    )
      return false;
    const next = new Map(view._liveDiffContents);
    next.set(path, result.diff);
    view._liveDiffContents = next;
    return true;
  } catch (err) {
    if (!isCurrentLiveResult(view, epoch, version)) return false;
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
  } finally {
    held?.abort();
  }
}

export async function loadSlotViewGitFileContent(
  view: SlotView,
  cacheKey: string,
  path: string,
  ref: string,
) {
  if (!view._isLive || view._liveFileContents.has(cacheKey)) return true;
  const epoch = view._recoveryEpoch;
  const version = view._workspaceReads.version;
  try {
    const result = await view._workspaceReads.read<{ content: string }>(
      Methods.GIT_SHOW,
      {
        slotId: view.slotId,
        ref,
        path,
      },
      (result) => {
        if (isCurrentLiveResult(view, epoch, version))
          view._liveFileContents = new Map(view._liveFileContents).set(cacheKey, result.content);
      },
    );
    if (!isCurrentLiveResult(view, epoch, version) || !view._workspaceReads.owns(result))
      return false;
    const next = new Map(view._liveFileContents);
    next.set(cacheKey, result.content);
    view._liveFileContents = next;
    return true;
  } catch (err) {
    if (!isCurrentLiveResult(view, epoch, version)) return false;
    const next = new Map(view._liveFileContents);
    next.set(cacheKey, `Error: ${err instanceof Error ? err.message : 'Failed to read file'}`);
    view._liveFileContents = next;
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
    // A committed-review tab stays keyed to its frozen snapshot. Reading the
    // live worktree here would silently change the code under review.
    if (isBranchDiff) {
      const parsed = parseBranchDiffKey(tab.path);
      if (!parsed) return;
      const loaded = await loadSlotViewGitFileContent(
        view,
        tab.path,
        filePath,
        parsed.head ?? 'HEAD',
      );
      if (!loaded) return;
      view._openFiles = view._openFiles.map((f) =>
        f.path === tab.path ? { ...f, type: 'file' } : f,
      );
      return;
    }
    await loadSlotViewFileContent(view, tab.path, {
      errorFallback: null,
      warnLabel: 'failed to load file tab',
    });
  }
  if (newType === 'diff' && view._isLive && !view._liveDiffContents.has(tab.path)) {
    const parsed = parseBranchDiffKey(tab.path);
    await loadSlotViewDiffContent(view, tab.path, {
      ...(parsed
        ? {
            diffBase: parsed.base,
            diffHead: parsed.head ?? 'HEAD',
            diffTarget: 'head' as const,
            requestPath: parsed.path,
          }
        : {}),
      errorFallback: null,
      warnLabel: 'failed to load diff tab',
    });
  }

  // Update tab type
  view._openFiles = view._openFiles.map((f) => (f.path === tab.path ? { ...f, type: newType } : f));
}

export async function handleSlotViewFileSelect(view: SlotView, path: string) {
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

/** The slot's current run, or null: every workspace write names the run it was made for. */
function slotViewWriteRun(view: SlotView): string | null {
  return view._slot?.currentRunId ?? null;
}

/**
 * The slot and run a file operation was asked for. Its requests go there even if the view moves
 * on, and its outcome is shown only while the view still shows both.
 */
function slotViewWriteTarget(view: SlotView) {
  const slotId = view.slotId;
  const runId = slotViewWriteRun(view);
  return { slotId, runId, shown: () => view.slotId === slotId && slotViewWriteRun(view) === runId };
}

/**
 * A file operation carries the file's hash from a current read: read-only slots, and files the
 * host reports no hash for, refuse it (ADR-009 Amendment 1).
 */
async function slotViewFileHash(view: SlotView, path: string): Promise<string | undefined> {
  if (!slotViewWritable(view)) return undefined;
  const current = await getResourceCache()?.retry(slotViewFileQuery(view, path));
  return current?.status === 'ready' ? current.data?.hash : undefined;
}

/** Whether the operation was refused; the notice goes only to the slot and run it was asked for. */
function refusedFileOperation(view: SlotView, error: unknown, shown: () => boolean): boolean {
  const refusal = slotViewSaveRefusal(error);
  if (!refusal) return false;
  if (!shown()) return true;
  if (refusal.kind === 'unsupported') refuseSlotViewConditionalWrites(view);
  view._editNotice =
    refusal.kind === 'hash'
      ? 'The file changed since it was read. Reload it and try again.'
      : refusal.kind === 'run'
        ? 'The slot now serves another run, so the change was refused.'
        : refusal.kind === 'destination-exists'
          ? 'A file already exists at that name, so the rename was refused.'
          : "This slot's node cannot check edits, so the workspace is read-only.";
  return true;
}

export async function handleSlotViewTreeAction(
  view: SlotView,
  detail: { action: string; path: string; type: string },
) {
  if (!view._isLive || view._isRecoveryBlocked || !view._workspaceReads.ready) return;
  const { action, path: filePath } = detail;
  const directory = detail.type === 'directory';
  const writes = ['new-file', 'new-folder', 'rename', 'delete'];
  if (writes.includes(action) && !slotViewWritable(view)) {
    view._editNotice = 'This slot is read-only here, so its files cannot be changed.';
    return;
  }
  const target = slotViewWriteTarget(view);

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
      // Directory operations carry no hash, so the user confirms them.
      if (!confirm(`Create folder ${folderPath}?`)) return;
      try {
        await gateway.request(Methods.FS_MKDIR, {
          slotId: target.slotId,
          path: folderPath,
          runId: target.runId,
        });
        if (target.shown()) view._reloadTree();
      } catch (err) {
        if (!refusedFileOperation(view, err, target.shown))
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
      if (directory && !confirm(`Rename folder ${filePath} to ${dir + newName}?`)) return;
      try {
        const expectedHash = directory ? undefined : await slotViewFileHash(view, filePath);
        if (!directory && !expectedHash) {
          if (target.shown())
            view._editNotice = `${filePath} has no current hash to rename it with.`;
          return;
        }
        await gateway.request(Methods.FS_RENAME, {
          slotId: target.slotId,
          oldPath: filePath,
          newPath: dir + newName,
          runId: target.runId,
          ...(expectedHash ? { expectedHash } : {}),
        });
        if (target.shown()) view._reloadTree();
      } catch (err) {
        if (!refusedFileOperation(view, err, target.shown))
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
        const expectedHash = directory ? undefined : await slotViewFileHash(view, filePath);
        if (!directory && !expectedHash) {
          if (target.shown())
            view._editNotice = `${filePath} has no current hash to delete it with.`;
          return;
        }
        await gateway.request(Methods.FS_DELETE, {
          slotId: target.slotId,
          path: filePath,
          runId: target.runId,
          ...(expectedHash ? { expectedHash } : {}),
        });
        if (!target.shown()) return;
        view._openFiles = view._openFiles.filter((f) => f.path !== filePath);
        if (view._activeFile === filePath) {
          view._activeFile =
            view._openFiles.length > 0 ? view._openFiles[view._openFiles.length - 1].path : '';
        }
        view._reloadTree();
      } catch (err) {
        if (!refusedFileOperation(view, err, target.shown))
          console.error('[slot-view] delete failed:', err);
      }
      return;
    }
  }
}

export async function createSlotViewFile(view: SlotView) {
  const filePath = view._newFilePath.trim();
  if (!filePath || !view._isLive || view._isRecoveryBlocked || !view._workspaceReads.ready) return;
  if (!slotViewWritable(view)) {
    view._editNotice = 'This slot is read-only here, so files cannot be created.';
    return;
  }
  const target = slotViewWriteTarget(view);
  try {
    // `expectedHash: null`: the file must not exist yet.
    const result = await gateway.request<FsWriteResult>(Methods.FS_WRITE, {
      slotId: target.slotId,
      path: filePath,
      content: '',
      expectedHash: null,
      runId: target.runId,
    });
    if (!target.shown()) return;
    // Cache empty content and open in edit mode
    view._liveFileContents = new Map(view._liveFileContents).set(filePath, '');
    view._liveFileHashes = new Map(view._liveFileHashes).set(filePath, result.hash);
    view._openFile(filePath, 'file', true);
    view._newFilePrompt = false;
    view._newFilePath = '';
  } catch (err) {
    if (!refusedFileOperation(view, err, target.shown))
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
