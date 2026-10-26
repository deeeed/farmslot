import type {
  GitBranchDiffResult,
  PRForSlotResult,
  PRReviewCommentsResult,
  PRReviewThread,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';
import { resourceQuery, type ResourceQueryState } from '@farmslot/protocol/client-cache';

import { isRecoveryEpochCurrent } from '../../utils/reconnect.js';
import { ResourceQueryController } from '../shared/resource-query-controller.js';

import type { SlotView } from './slot-view.js';
import {
  type BranchDiffRequestTicket,
  committedReviewBranchDiffRequest,
  isBranchDiffTicketCurrent,
  slotViewBranchList,
} from './slot-view-branch-model.js';
import { loadSlotViewDiffContent, loadSlotViewGitFileContent } from './slot-view-live-effects.js';
import { branchDiffKey, slotViewPendingReviewSnapshot } from './slot-view-model.js';

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

/** The slot's PR and its review threads, observed through the shared cache. */
class SlotPRReads {
  slotId = '';
  private commentsBound = false;
  /** Pending recoveries; each returns true once it has taken a current answer. */
  private answered: Array<() => boolean> = [];
  readonly comments: ResourceQueryController<PRReviewCommentsResult>;
  readonly forSlot: ResourceQueryController<PRForSlotResult>;

  constructor(private readonly view: SlotView) {
    this.comments = new ResourceQueryController(view, (state) => this.applyComments(state));
    this.forSlot = new ResourceQueryController(view, (state) => this.applyPR(state));
  }

  /**
   * The first answer read on this connection since `since`. A saved row hydrated before the
   * network read is not one, so recovery never fixes the diff base from an older PR.
   */
  answer(since: number): Promise<ResourceQueryState<PRForSlotResult>> {
    return new Promise((resolve) => {
      const settle = () => {
        const state = this.forSlot.state;
        const current =
          !this.forSlot.belongsToWorkspace ||
          state.status === 'ready' ||
          state.status === 'error' ||
          state.status === 'unsupported' ||
          (state.status === 'stale' && (state.observedAt ?? 0) >= since);
        if (current) resolve(state);
        return current;
      };
      if (!settle()) this.answered.push(settle);
    });
  }

  bindComments(): void {
    const pr = this.view._prNumber;
    const repo = this.view._prRepo;
    this.commentsBound = Boolean(pr && repo);
    if (!this.commentsBound) {
      this.view._prThreads = [];
      this.view._prCommentsLoading = false;
    }
    this.comments.setQuery(
      pr && repo
        ? resourceQuery<PRReviewCommentsResult>(Methods.PR_REVIEW_COMMENTS, { pr, repo })
        : undefined,
    );
  }

  private applyPR(state: ResourceQueryState<PRForSlotResult>): void {
    if (state.status === 'loading' || this.slotId !== this.view.slotId) return;
    if (state.data) {
      this.view._prNumber = state.data.pr;
      this.view._prRepo = state.data.repo;
    } else {
      console.warn('[slot-view] PR detection failed:', state.error?.message);
      this.view._prNumber = null;
      this.view._prRepo = null;
    }
    this.bindComments();
    this.answered = this.answered.filter((settle) => !settle());
  }

  private applyComments(state: ResourceQueryState<PRReviewCommentsResult>): void {
    this.view._prCommentsLoading = this.commentsBound && state.status === 'loading';
    if (!this.commentsBound || state.status === 'loading') return;
    if (state.data) {
      this.view._prThreads = state.data.threads;
      this.view._prCurrentUser = state.data.currentUser;
    } else {
      console.warn('[slot-view] PR comments load failed:', state.error?.message);
      this.view._prThreads = [];
    }
  }
}

const slotPRReads = new WeakMap<SlotView, SlotPRReads>();

function prReads(view: SlotView): SlotPRReads {
  let reads = slotPRReads.get(view);
  if (!reads) {
    reads = new SlotPRReads(view);
    slotPRReads.set(view, reads);
  }
  return reads;
}

export async function detectSlotViewPR(view: SlotView) {
  if (!view._isLive) return;
  const epoch = view._recoveryEpoch;
  const since = Date.now();
  const reads = prReads(view);
  reads.slotId = view.slotId;
  reads.forSlot.setQuery(
    resourceQuery<PRForSlotResult>(Methods.PR_FOR_SLOT, { slotId: view.slotId }),
  );
  const state = await reads.answer(since);
  if (!isCurrentReviewResult(view, epoch) || reads.slotId !== view.slotId) return;
  // Resolve the diff base once per recovery; later PR updates keep the viewer's chosen base.
  if (state.data) view._branchDiffBase = state.data.baseRef;
}

/** Thread mutations re-collect on the gateway; their notification refreshes these threads. */
export async function loadSlotViewPRComments(view: SlotView) {
  prReads(view).bindComments();
}

export async function loadSlotViewBranchDiff(view: SlotView) {
  if (!view._isLive) return;
  // The recovery epoch is a global reconnect counter — it does NOT change on
  // slot switch, and slot identity alone is not A→B→A safe. The generation
  // ticket stales any completion from an earlier visit.
  const ticket = branchDiffTicket(view);
  const isCurrent = () => isTicketCurrent(view, ticket);
  const reviewSnapshot = slotViewPendingReviewSnapshot(view._linkedRun);
  view._branchDiffLoading = true;
  try {
    await view._workspaceReads.read<GitBranchDiffResult>(
      Methods.GIT_BRANCH_DIFF,
      committedReviewBranchDiffRequest(view.slotId, view._branchDiffBase, reviewSnapshot),
      (result) => {
        if (!isCurrent()) return;
        view._branchDiffBase = result.base;
        view._branchDiffFiles = result.files;
        view._branchDiffTestPatterns = result.testFilePatterns ?? null;
        view._branchDiffHead = result.head;
        view._branchDiffTotalAdd = result.totalAdditions;
        view._branchDiffTotalDel = result.totalDeletions;
        view._branchDiffError = null;
      },
    );
  } catch (err) {
    // Expected transient failures (node reconnecting, gateway restart). The
    // error is surfaced in the panel; the shared query exposes Retry.
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[slot-view] branch diff files load failed:', message);
    if (!isCurrent()) return;
    view._branchDiffFiles = [];
    view._branchDiffTestPatterns = null;
    view._branchDiffHead = '';
    view._branchDiffTotalAdd = 0;
    view._branchDiffTotalDel = 0;
    view._branchDiffError = message;
  } finally {
    // A stale completion (slot switched away) must not clear the loading
    // flag the new slot's own load now owns.
    if (isCurrent()) {
      view._branchDiffLoading = false;
    }
  }

  // Load branch list for the dropdown (only once per slot)
  if (isCurrent() && view._branchDiffBranches.length === 0) {
    view._loadBranchList();
  }
}

export async function loadSlotViewBranchList(view: SlotView) {
  // This dropdown is derived from the observed status/range, never from git.log.
  view._branchDiffBranches = slotViewBranchList({
    branchDiffBase: view._branchDiffBase,
    branchDiffHead: view._branchDiffHead,
    gitBranch: view._git?.branch,
  });
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
  const useCodeView = status === 'A';
  const snapshot = slotViewPendingReviewSnapshot(view._linkedRun);
  const base = snapshot?.baseSha ?? view._branchDiffBase;
  const head = snapshot?.headSha ?? 'HEAD';
  const cacheKey = branchDiffKey(base, head, path);

  if (useCodeView) {
    const loaded = await loadSlotViewGitFileContent(view, cacheKey, path, head);
    if (!loaded) return;
    view._openFile(cacheKey, 'file');
    return;
  }

  // M/D/R: fetch the committed branch/PR diff and open it as a diff tab.
  if (view._liveDiffContents.has(cacheKey)) {
    const next = new Map(view._liveDiffContents);
    next.delete(cacheKey);
    view._liveDiffContents = next;
  }
  const loaded = await loadSlotViewDiffContent(view, cacheKey, {
    diffBase: base,
    diffHead: head,
    diffTarget: 'head',
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
