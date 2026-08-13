import type { Run, RunForSlotResult, RunGetResult } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { getRunForSlot, getState } from '../../state.js';
import { isRecoveryEpochCurrent } from '../../utils/reconnect.js';

import type { SlotView } from './slot-view.js';
import {
  selectSlotViewLinkedRun,
  shouldPreserveSlotViewCachedNullRun,
  type SlotViewLinkedRunSource,
  slotViewLinkedRunTransition,
} from './slot-view-linked-run-model.js';
import { loadSlotViewGitFileContent } from './slot-view-live-effects.js';
import {
  branchDiffKey,
  parseBranchDiffKey,
  slotBoundRunIdForSlot,
  slotViewPendingReviewSnapshot,
} from './slot-view-model.js';
import { requestedRunFromHash } from './slot-view-url-state.js';

export function applySlotViewLinkedRun(
  view: SlotView,
  run: Run | null,
  prevRunStatus: string | null,
  source: SlotViewLinkedRunSource = 'rpc',
): string | null {
  const previousRunId = view._lastLinkedRunId;
  const previousSnapshot = slotViewPendingReviewSnapshot(view._linkedRun);
  if (!run) {
    // Only the RPC source confirms a run is actually gone. A cached null can
    // be a transient hydration miss during mount or reconnect — overwriting
    // _linkedRun and dropping _lastLinkedRunId here would erase the prior run
    // identity, so the next RPC arrival could not detect run transitions.
    if (shouldPreserveSlotViewCachedNullRun({ source, previousRunId })) {
      return prevRunStatus;
    }
    view._linkedRun = null;
    if (source === 'rpc' && previousRunId !== null && isRecoveryEpochCurrent(view._recoveryEpoch)) {
      clearSelectedSlotViewAgentContextForSlot(view);
    }
    view._lastLinkedRunId = null;
    return null;
  }

  const nextSnapshot = slotViewPendingReviewSnapshot(run);
  const nextSnapshotBase = nextSnapshot?.baseSha || '';
  const nextSnapshotHead = nextSnapshot?.headSha || '';
  const previousSnapshotKey = previousSnapshot
    ? `${previousSnapshot.baseSha}:${previousSnapshot.headSha}`
    : '';
  const nextSnapshotKey =
    nextSnapshotBase && nextSnapshotHead ? `${nextSnapshotBase}:${nextSnapshotHead}` : '';

  view._linkedRun = run;
  view._lastLinkedRunId = run.id;
  if (previousSnapshotKey !== nextSnapshotKey) {
    view._branchDiffGeneration += 1;
    view._liveDiffContents = new Map();
    view._branchDiffFiles = [];
    view._branchDiffBase = nextSnapshotBase || 'main';
    view._branchDiffHead = nextSnapshotHead;
    view._branchDiffTotalAdd = 0;
    view._branchDiffTotalDel = 0;
    view._branchDiffError = null;
    const activeBranchDiff = parseBranchDiffKey(view._activeFile);
    const nonBranchFiles = view._openFiles.filter((file) => !file.path.startsWith('branch:'));
    if (activeBranchDiff && nextSnapshotBase && nextSnapshotHead) {
      const canonicalPath = branchDiffKey(
        nextSnapshotBase,
        nextSnapshotHead,
        activeBranchDiff.path,
      );
      const activeTab = view._openFiles.find((file) => file.path === view._activeFile);
      view._openFiles = [
        ...nonBranchFiles,
        {
          path: canonicalPath,
          type: activeTab?.type ?? 'diff',
          pinned: activeTab?.pinned ?? false,
          diffBase: nextSnapshotBase,
        },
      ];
      view._activeFile = canonicalPath;
      if (activeTab?.type === 'file') {
        void loadSlotViewGitFileContent(
          view,
          canonicalPath,
          activeBranchDiff.path,
          nextSnapshotHead,
        );
      } else {
        void view._openFileFromUrl(canonicalPath);
      }
    } else {
      view._openFiles = nonBranchFiles;
      if (activeBranchDiff) view._activeFile = nonBranchFiles.at(-1)?.path ?? '';
    }
    if (view._isLive) void view._loadBranchDiff();
  }
  const transition = slotViewLinkedRunTransition({
    previousRunId,
    nextRunId: run.id,
    prevRunStatus,
    nextRunStatus: run.status,
  });
  // Agent-context selections are run-scoped. Clear the persisted per-slot tab
  // when the run changes or completes so the next dispatch starts on its
  // primary worker instead of a stale self-review/ci-fix tab. Only clear when
  // the live recovery epoch is current; cached/RPC disagreement during
  // reconnect must not wipe pinned tabs.
  if (transition.shouldClearAgentContext && isRecoveryEpochCurrent(view._recoveryEpoch)) {
    clearSelectedSlotViewAgentContextForSlot(view);
  }
  if (transition.shouldResetUnavailableContexts && view._unavailableContextKeys.size > 0) {
    view._unavailableContextKeys = new Set();
  }

  view._autoPinTaskFolder();
  if (transition.shouldRefreshMonitoringProgress) {
    if (view._pinnedFolder) view._loadPinnedEntries();
    view._fetchStructuredProgress();
  }
  return run.status;
}

/**
 * Clear the per-slot persisted contextId pin and fall back to primary.
 * Called on detected runChanged / reachedTerminal within the same session.
 *
 * Cross-page-load limitation: on a fresh mount, `_lastLinkedRunId` is null,
 * so the first RPC run cannot detect runChanged. Persisted pins are therefore
 * treated as role-following-the-slot and degrade through normal selection.
 */
export function clearSelectedSlotViewAgentContextForSlot(view: SlotView): void {
  if (!view.slotId) {
    view._selectedAgentContextId = 'primary';
    return;
  }
  if (!view._selectedAgentContextIds[view.slotId] && view._selectedAgentContextId === 'primary') {
    return;
  }
  const { [view.slotId]: _, ...rest } = view._selectedAgentContextIds;
  view._selectedAgentContextIds = rest;
  view._selectedAgentContextId = 'primary';
  view._saveLayout();
}

export function requestedSlotViewRunFromUrl(): string | null {
  return requestedRunFromHash();
}

export async function refreshSlotViewLinkedRun(
  view: SlotView,
  prevRunStatus: string | null,
): Promise<string | null> {
  const requestedRunId = requestedSlotViewRunFromUrl();
  const slotBoundRunId = slotBoundRunIdForSlot(
    view.slotId,
    view._slot?.currentRunId,
    getState().fleet?.slots,
  );
  let cachedRun = getRunForSlot(view.slotId, requestedRunId);
  let nextPrevRunStatus = applySlotViewLinkedRun(view, cachedRun, prevRunStatus, 'cache');
  void view._refreshRecipeRuns(cachedRun);
  if (!view._isLive || gateway.connectionState !== 'connected') return nextPrevRunStatus;

  const refreshToken = Symbol('linked-run-refresh');
  view._linkedRunRefreshToken = refreshToken;
  try {
    if (requestedRunId && !cachedRun) {
      try {
        const direct = await gateway.request<RunGetResult>(Methods.RUN_GET, {
          runId: requestedRunId,
        });
        if (refreshToken !== view._linkedRunRefreshToken) return nextPrevRunStatus;
        const directRun = direct.run;
        if (directRun && (directRun.slotId === view.slotId || directRun.id === slotBoundRunId)) {
          cachedRun = directRun;
          nextPrevRunStatus = applySlotViewLinkedRun(view, cachedRun, nextPrevRunStatus, 'rpc');
          void view._refreshRecipeRuns(cachedRun);
        }
      } catch (err) {
        // The URL hint can outlive a run snapshot or be pasted into another
        // session; continue with the authoritative slot selector below.
        console.warn(
          '[slot-view] requested run refresh failed; falling back to slot selector:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const result = await gateway.request<RunForSlotResult>(Methods.RUN_FOR_SLOT, {
      slotId: view.slotId,
    });
    if (refreshToken !== view._linkedRunRefreshToken) return nextPrevRunStatus;
    const nextRun = selectSlotViewLinkedRun({
      requestedRunId,
      slotBoundRunId,
      cachedRun,
      rpcRun: result.run,
    });
    nextPrevRunStatus = applySlotViewLinkedRun(view, nextRun, nextPrevRunStatus, 'rpc');
    void view._refreshRecipeRuns(nextRun);
  } catch (err) {
    console.warn(
      '[slot-view] linked run refresh failed; using state cache:',
      err instanceof Error ? err.message : String(err),
    );
  }
  return nextPrevRunStatus;
}
