import type {
  GitBranchDiffResult,
  PRForSlotResult,
  PRReviewCommentsResult,
  PRReviewThread,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { isRecoveryEpochCurrent } from '../../utils/reconnect.js';

import type { SlotView } from './slot-view.js';
import { slotViewBranchList } from './slot-view-branch-model.js';
import { loadSlotViewDiffContent, loadSlotViewFileContent } from './slot-view-live-effects.js';

function isCurrentReviewResult(view: SlotView, epoch: number) {
  return epoch === view._recoveryEpoch && isRecoveryEpochCurrent(epoch);
}

export async function detectSlotViewPR(view: SlotView) {
  if (!view._isLive) return;
  const epoch = view._recoveryEpoch;
  try {
    const result = await gateway.request<PRForSlotResult>(Methods.PR_FOR_SLOT, {
      slotId: view.slotId,
    });
    if (!isCurrentReviewResult(view, epoch)) return;
    view._prNumber = result.pr;
    view._prRepo = result.repo;
    if (result.pr && result.repo) {
      view._loadPRComments();
    }
  } catch (err) {
    console.warn(
      '[slot-view] PR detection failed:',
      err instanceof Error ? err.message : String(err),
    );
    if (!isCurrentReviewResult(view, epoch)) return;
    view._prNumber = null;
    view._prRepo = null;
  }
}

export async function loadSlotViewPRComments(view: SlotView) {
  if (!view._prNumber || !view._prRepo) return;
  const epoch = view._recoveryEpoch;
  view._prCommentsLoading = true;
  try {
    const result = await gateway.request<PRReviewCommentsResult>(Methods.PR_REVIEW_COMMENTS, {
      pr: view._prNumber,
      repo: view._prRepo,
    });
    if (!isCurrentReviewResult(view, epoch)) return;
    view._prThreads = result.threads;
    view._prCurrentUser = result.currentUser;
  } catch (err) {
    console.warn(
      '[slot-view] PR comments load failed:',
      err instanceof Error ? err.message : String(err),
    );
    if (!isCurrentReviewResult(view, epoch)) return;
    view._prThreads = [];
  } finally {
    view._prCommentsLoading = false;
  }
}

export async function loadSlotViewBranchDiff(view: SlotView) {
  if (!view._isLive) return;
  const epoch = view._recoveryEpoch;
  view._branchDiffLoading = true;
  try {
    const result = await gateway.request<GitBranchDiffResult>(Methods.GIT_BRANCH_DIFF, {
      slotId: view.slotId,
      base: view._branchDiffBase,
    });
    if (!isCurrentReviewResult(view, epoch)) return;
    view._branchDiffFiles = result.files;
    view._branchDiffHead = result.head;
    view._branchDiffTotalAdd = result.totalAdditions;
    view._branchDiffTotalDel = result.totalDeletions;
    view._branchDiffError = null;
  } catch (err) {
    // Expected transient failures (node reconnecting, gateway restart). The
    // error is surfaced in the panel and the git-status poll retries the load
    // — see shouldReloadBranchDiff.
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[slot-view] branch diff files load failed:', message);
    if (!isCurrentReviewResult(view, epoch)) return;
    view._branchDiffFiles = [];
    view._branchDiffHead = '';
    view._branchDiffTotalAdd = 0;
    view._branchDiffTotalDel = 0;
    view._branchDiffError = message;
  } finally {
    view._branchDiffLoading = false;
  }

  // Load branch list for the dropdown (only once)
  if (view._branchDiffBranches.length === 0) {
    view._loadBranchList();
  }
}

export async function loadSlotViewBranchList(view: SlotView) {
  if (!view._isLive) return;
  try {
    // Use git log to list branches via gateway
    await gateway.request<{
      entries: Array<{ hash: string; message: string; author: string; date: string }>;
    }>(Methods.GIT_LOG, { slotId: view.slotId, limit: 1 });
    // We need branch names — use a git command via the status branch name + common branches.
    // For now, provide the known base + current branch.
    view._branchDiffBranches = slotViewBranchList({
      branchDiffBase: view._branchDiffBase,
      branchDiffHead: view._branchDiffHead,
      gitBranch: view._git?.branch,
    });
  } catch (err) {
    console.warn(
      '[slot-view] branch list load failed:',
      err instanceof Error ? err.message : String(err),
    );
    view._branchDiffBranches = ['main'];
  }
}

export function handleSlotViewBranchDiffBaseChange(view: SlotView, base: string) {
  view._branchDiffBase = base;
  view._saveLayout();
  view._loadBranchDiff();
}

export async function handleSlotViewBranchDiffSelect(view: SlotView, path: string, status: string) {
  view._cancelFileRestoreRetry();
  const useCodeView = status === 'A';

  if (useCodeView) {
    const loaded = await loadSlotViewFileContent(view, path, {
      errorFallback: 'Failed to read file',
    });
    if (!loaded) return;
    view._openFile(path, 'file');
    return;
  }

  // M/D/R: fetch branch diff and open as diff tab
  const cacheKey = `branch:${view._branchDiffBase}:${path}`;
  const loaded = await loadSlotViewDiffContent(view, cacheKey, {
    diffBase: view._branchDiffBase,
    errorFallback: 'Failed to load diff',
    requestPath: path,
  });
  if (!loaded) return;
  view._openBranchDiffFile(path, cacheKey);
}

export function openSlotViewBranchDiffFile(view: SlotView, _path: string, cacheKey: string) {
  // Open diff tab using cacheKey so branch diffs don't collide with working tree diffs
  const exists = view._openFiles.find((file) => file.path === cacheKey);
  if (exists) {
    view._activeFile = cacheKey;
    return;
  }
  const hasPreview = view._openFiles.some((file) => !file.pinned);
  if (hasPreview) {
    view._openFiles = [
      ...view._openFiles.filter((file) => file.pinned),
      { path: cacheKey, type: 'diff', pinned: false, diffBase: view._branchDiffBase },
    ];
  } else {
    view._openFiles = [
      ...view._openFiles,
      { path: cacheKey, type: 'diff', pinned: false, diffBase: view._branchDiffBase },
    ];
  }
  view._activeFile = cacheKey;
}

export function slotViewCommentThreadsForFile(view: SlotView, path: string): PRReviewThread[] {
  return view._prThreads.filter((thread) => thread.path === path && thread.line !== null);
}
