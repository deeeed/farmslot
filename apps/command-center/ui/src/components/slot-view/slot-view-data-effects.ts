import type {
  ConfigPoolResult,
  ResourceListResult,
  SlotActionListResult,
  TaskProgressResult,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';
import { type ChecklistProgressStep, checklistProgressView } from '@farmslot/review-dispatch';

import { readConfiguration } from '../../configuration-resources.js';
import { gateway } from '../../gateway-client.js';
import { getState } from '../../state.js';

import type { SlotView } from './slot-view.js';
import { isSlotViewContextPinUnresolved } from './slot-view-linked-run-model.js';
import { getSlotViewHashParam, requestedRunFromHash } from './slot-view-url-state.js';

export function loadSlotViewSlot(view: SlotView): void {
  const fleet = getState().fleet;
  if (fleet) {
    const stored = fleet.slots.find((slot) => slot.slot === view.slotId);
    if (stored) {
      view._slot = stored;
      void view._fetchResources();
      void view._fetchSlotActions();
      if (view._shouldShowTaskUI()) {
        bindSlotViewTaskProgress(view);
        // Auto-open task panel when slot has active work (overrides stale localStorage)
        view._taskPanelOpen = true;
      } else {
        view._structuredProgress = undefined;
      }
      void view._fetchRepoPath(stored.machine);
    }
  }
  view._loading = false;
}

export async function fetchSlotViewRepoPath(view: SlotView, machine: string): Promise<void> {
  try {
    const res = await readConfiguration<ConfigPoolResult>(Methods.CONFIG_POOL, { machine });
    const slotCfg = res.pool.slots.find((slot) => slot.id === view.slotId);
    if (slotCfg) view._repoPath = slotCfg.repo;
  } catch (err) {
    console.warn(
      '[slot-view] pool config unavailable:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function fetchSlotViewResources(view: SlotView): Promise<void> {
  if (!view.slotId) return;
  try {
    const res = await gateway.request<ResourceListResult>(Methods.RESOURCE_LIST, {
      slotId: view.slotId,
    });
    view._resources = res.resources;
    // Auto-open resource panel when slot is working and has resources
    if (view._shouldShowTaskUI() && res.resources.length > 0) {
      view._resourcePanelOpen = true;
    }
  } catch (err) {
    console.warn(
      '[slot-view] resource list failed:',
      err instanceof Error ? err.message : String(err),
    );
    view._resources = [];
  }
}

export async function fetchSlotViewActions(view: SlotView): Promise<void> {
  if (!view.slotId) return;
  try {
    const res = await gateway.request<SlotActionListResult>(Methods.SLOT_ACTION_LIST, {
      slotId: view.slotId,
    });
    view._slotActions = res.actions;
  } catch (err) {
    console.warn(
      '[slot-view] slot action list failed:',
      err instanceof Error ? err.message : String(err),
    );
    view._slotActions = [];
  }
}

/** Bind one read for the active checklist; terminal/history tab choices do not retarget it. */
export function bindSlotViewTaskProgress(view: SlotView): void {
  const run = view._linkedRun;
  const slot = view._slot?.slot === view.slotId ? view._slot : null;
  const selected = view._taskAgentContext();
  const requestedRunId = requestedRunFromHash();
  const unresolved = isSlotViewContextPinUnresolved({
    run,
    requestedRunId,
    requestedContextId: getSlotViewHashParam('contextId'),
    slotId: view.slotId,
  });
  const manualSlot = slot && !slot.currentRunId && !requestedRunId;
  view._progressQuery.setQuery(
    view._isLive &&
      slot &&
      (run || manualSlot) &&
      !unresolved &&
      (selected?.taskFile || run?.activeTaskFile || run?.taskFile || slot.taskFile)
      ? resourceQuery<TaskProgressResult>(Methods.TASK_PROGRESS, {
          slotId: view.slotId,
          ...(run ? { runId: run.id } : {}),
          ...(selected?.taskFile ? { taskFile: selected.taskFile } : {}),
        })
      : undefined,
  );
  // Link/owner transitions can clear copied fields while the same query stays bound.
  applySlotViewTaskProgress(view);
}

export function applySlotViewTaskProgress(view: SlotView): void {
  const result = view._progressQuery.belongsToWorkspace
    ? view._progressQuery.state.data
    : undefined;
  const previous = view._structuredProgress;
  view._structuredProgress = result?.structured;
  const steps: ChecklistProgressStep[] = [];
  for (const line of (result?.markdown ?? '').split('\n')) {
    const match = line.match(/^- \[([ x])\] (.+)/);
    if (match) steps.push({ text: match[2], checked: match[1] === 'x' });
  }
  view._taskSteps = steps;
  view._taskProgress = (checklistProgressView(result?.structured, { steps })?.percent ?? 0) / 100;
  // A new shared observation replaces the former progress-event trigger.
  if (
    result?.structured &&
    result.structured !== previous &&
    view._pinnedFolder &&
    view._progressQuery.ready
  )
    void view._loadPinnedEntries();
}
