import type { FsListResult } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { isRecoveryEpochCurrent } from '../../utils/reconnect.js';

import type { SlotView } from './slot-view.js';
import {
  slotViewPinnedFolderCandidates,
  slotViewPinnedFolderFromTaskFile,
  slotViewTaskRelativePath,
} from './slot-view-pinned-model.js';
import { updateSlotViewTreeChildren } from './slot-view-tree-model.js';

function isCurrentPinnedResult(view: SlotView, epoch: number) {
  return epoch === view._recoveryEpoch && isRecoveryEpochCurrent(epoch);
}

export async function autoPinSlotViewTaskFolder(view: SlotView) {
  const slotAgentTaskFile = view._agentContexts().find((ctx) => ctx.taskFile)?.taskFile;
  const taskRelPath = slotViewTaskRelativePath({
    runTaskFile: view._linkedRun?.taskFile,
    slotTaskFile: view._slot?.taskFile,
    slotAgentTaskFile,
    showTaskUi: view._shouldShowTaskUI(),
  });
  if (!taskRelPath) return;

  // Try candidate task_dir prefixes — projects override DEFAULT_TASK_DIR.
  // Order matches what extension/mobile actually use on slot first; legacy
  // `.task` paths last. Cache misses by taskRelPath so a slot with no
  // pinned-folder match doesn't re-probe (and re-SSH) on every render.
  if (view._autoPinProbedFor === taskRelPath && view._pinnedFolder) return;
  const directPinned = slotAgentTaskFile
    ? slotViewPinnedFolderFromTaskFile(slotAgentTaskFile)
    : null;
  const candidates = [
    ...(directPinned ? [directPinned] : []),
    ...slotViewPinnedFolderCandidates(taskRelPath),
  ];
  for (const candidate of candidates) {
    if (view._pinnedFolder === candidate) {
      view._autoPinProbedFor = taskRelPath;
      return;
    }
    try {
      const result = await gateway.request<{ entries: unknown[] }>(Methods.FS_LIST, {
        slotId: view.slotId,
        path: candidate,
        includeIgnored: true,
      });
      if (result.entries.length > 0) {
        view._pinnedFolder = candidate;
        view._autoPinProbedFor = taskRelPath;
        view._saveLayout();
        view._loadPinnedEntries();
        return;
      }
    } catch {
      // ENOENT for unused candidate — silent; cached below to avoid re-probing.
    }
  }

  // None found — use first candidate as fallback and stop probing for this taskRelPath.
  if (!view._pinnedFolder || !candidates.includes(view._pinnedFolder)) {
    view._pinnedFolder = candidates[0];
    view._saveLayout();
    // Skip _loadPinnedEntries — fallback path doesn't exist either.
  }
  view._autoPinProbedFor = taskRelPath;
}

export function pinSlotViewFolder(view: SlotView, path: string) {
  view._pinnedFolder = path;
  view._saveLayout();
  view._loadPinnedEntries();
  // Switch to source panel to show the pinned folder
  view._activity = 'source';
  view._sidebarOpen = true;
  view._saveLayout();
}

export function unpinSlotViewFolder(view: SlotView) {
  view._pinnedFolder = '';
  view._pinnedEntries = [];
  view._saveLayout();
}

export async function loadSlotViewPinnedEntries(view: SlotView) {
  if (!view._pinnedFolder || !view._isLive) return;
  const epoch = view._recoveryEpoch;
  try {
    const result = await gateway.request<FsListResult>(Methods.FS_LIST, {
      slotId: view.slotId,
      path: view._pinnedFolder,
      includeIgnored: true,
    });
    if (!isCurrentPinnedResult(view, epoch)) return;
    view._pinnedEntries = result.entries;
  } catch (err) {
    console.warn(
      '[slot-view] pinned entries load failed:',
      err instanceof Error ? err.message : String(err),
    );
    if (!isCurrentPinnedResult(view, epoch)) return;
    view._pinnedEntries = [];
  }
}

export function handleSlotViewPinnedDirExpand(view: SlotView, path: string) {
  if (!view._isLive) return;
  view._loadPinnedSubdir(path);
}

export async function loadSlotViewPinnedSubdir(view: SlotView, dirPath: string) {
  const epoch = view._recoveryEpoch;
  try {
    // Pinned folders may be inside .task/ (gitignored) — always include ignored
    const result = await gateway.request<FsListResult>(Methods.FS_LIST, {
      slotId: view.slotId,
      path: dirPath,
      includeIgnored: true,
    });
    if (!isCurrentPinnedResult(view, epoch)) return;
    view._pinnedEntries = updateSlotViewTreeChildren(view._pinnedEntries, dirPath, result.entries);
  } catch (err) {
    console.warn(
      '[slot-view] load pinned subdir failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
