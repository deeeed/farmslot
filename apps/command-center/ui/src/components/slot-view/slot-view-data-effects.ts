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
      bindSlotViewResources(view);
      view._slotActionsQuery.setQuery(
        resourceQuery<SlotActionListResult>(Methods.SLOT_ACTION_LIST, { slotId: view.slotId }),
      );
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

/** Binds the slot's resources; the next list may open the resource panel, as a slot load did. */
function bindSlotViewResources(view: SlotView): void {
  view._resourcesMayOpenPanel = true;
  view._resourcesQuery.setQuery(
    resourceQuery<ResourceListResult>(Methods.RESOURCE_LIST, { slotId: view.slotId }),
  );
  applySlotViewResources(view);
}

/** An action that changed the slot's resources rereads them once. */
export async function refreshSlotViewResources(view: SlotView): Promise<void> {
  view._resourcesMayOpenPanel = true;
  await view._resourcesQuery.retry();
  applySlotViewResources(view);
}

/** Shows the stored resource list; status events patch `_resources` until the list changes. */
export function applySlotViewResources(view: SlotView): void {
  const result = view._resourcesQuery.state.data;
  if (result !== view._resourcesSource) {
    view._resourcesSource = result;
    view._resources = result?.resources ?? [];
  }
  if (!result || !view._resourcesMayOpenPanel) return;
  view._resourcesMayOpenPanel = false;
  // Auto-open resource panel when slot is working and has resources
  if (view._shouldShowTaskUI() && result.resources.length > 0) view._resourcePanelOpen = true;
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
