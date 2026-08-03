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
import {
  type BranchDiffRequestTicket,
  isBranchDiffTicketCurrent,
  slotViewBranchList,
} from './slot-view-branch-model.js';
import { loadSlotViewDiffContent, loadSlotViewFileContent } from './slot-view-live-effects.js';

function isCurrentReviewResult(view: SlotView, epoch: number) {
  return epoch === view._recoveryEpoch && isRecoveryEpochCurrent(epoch);
}

function branchDiffTicket(view: SlotView): BranchDiffRequestTicket {
  return { generation: view._branchDiffGeneration, epoch: view._recoveryEpoch };
}

function isTicketCurrent(view: SlotView, ticket: BranchDiffRequestTicket): boolean {
  return isBranchDiffTicketCurrent(ticket, {
    generation: view._branchDiffGeneration,
    epoch: view._recoveryEpoch,
    epochCurrent: isRecoveryEpochCurrent(ticket.epoch),
  });
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
  // The recovery epoch is a global reconnect counter — it does NOT change on
  // slot switch, and slot identity alone is not A→B→A safe. The generation
  // ticket stales any completion from an earlier visit.
  const ticket = branchDiffTicket(view);
  const isCurrent = () => isTicketCurrent(view, ticket);
  view._branchDiffLoading = true;
  try {
    const result = await gateway.request<GitBranchDiffResult>(Methods.GIT_BRANCH_DIFF, {
      slotId: view.slotId,
      base: view._branchDiffBase,
      // Every change on the branch vs base — committed or not — deduped per
      // file. Publish flows (ready/review workspaces) keep the committed-only
      // default.
      target: 'worktree',
    });
    if (!isCurrent()) return;
    view._branchDiffFiles = result.files;
    view._branchDiffHead = result.head;
    view._branchDiffTotalAdd = result.totalAdditions;
    view._branchDiffTotalDel = result.totalDeletions;
    view._branchDiffError = null;
  } catch (err) {
    // Expected transient failures (node reconnecting, gateway restart). The
    // error is surfaced in the panel and the git-status poll retries the load
    // — see branchDiffPollAction.
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[slot-view] branch diff files load failed:', message);
    if (!isCurrent()) return;
    view._branchDiffFiles = [];
    view._branchDiffHead = '';
    view._branchDiffTotalAdd = 0;
    view._branchDiffTotalDel = 0;
    view._branchDiffError = message;
  } finally {
    // A stale completion (slot switched away) must not clear the loading
    // flag the new slot's own load now owns.
    if (isCurrent()) view._branchDiffLoading = false;
  }

  // Load branch list for the dropdown (only once per slot)
  if (isCurrent() && view._branchDiffBranches.length === 0) {
    view._loadBranchList();
  }
}

export async function loadSlotViewBranchList(view: SlotView) {
  if (!view._isLive) return;
  const ticket = branchDiffTicket(view);
  try {
    // Use git log to list branches via gateway
    await gateway.request<{
      entries: Array<{ hash: string; message: string; author: string; date: string }>;
    }>(Methods.GIT_LOG, { slotId: view.slotId, limit: 1 });
    if (!isTicketCurrent(view, ticket)) return;
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
    // A stale rejection (slot switched, reconnect) must not clobber the
    // current slot's branch list with the fallback.
    if (!isTicketCurrent(view, ticket)) return;
    view._branchDiffBranches = ['main'];
  }
}

export function handleSlotViewBranchDiffBaseChange(view: SlotView, base: string) {
  view._branchDiffBase = base;
  view._saveLayout();
  view._loadBranchDiff();
}

export async function handleSlotViewBranchDiffSelect(
  view: SlotView,
  path: string,
  status: string,
  oldPath?: string,
) {
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

  // M/D/R: fetch branch diff and open as diff tab. Worktree-target content
  // can change without any status transition, so drop the cached entry and
  // fetch fresh on every click.
  const cacheKey = `branch:${view._branchDiffBase}:${path}`;
  if (view._liveDiffContents.has(cacheKey)) {
    const next = new Map(view._liveDiffContents);
    next.delete(cacheKey);
    view._liveDiffContents = next;
  }
  const loaded = await loadSlotViewDiffContent(view, cacheKey, {
    diffBase: view._branchDiffBase,
    diffTarget: 'worktree',
    errorFallback: 'Failed to load diff',
    requestPath: path,
    requestOldPath: oldPath,
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
