import type {
  ConfigPoolResult,
  ResourceListResult,
  SlotActionListResult,
  TaskProgressResult,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { getState } from '../../state.js';

import type { SlotView } from './slot-view.js';
import type { TaskStep } from './slot-view-model.js';

export function loadSlotViewSlot(view: SlotView): void {
  const fleet = getState().fleet;
  if (fleet) {
    const stored = fleet.slots.find((slot) => slot.slot === view.slotId);
    if (stored) {
      view._slot = stored;
      void view._fetchResources();
      void view._fetchSlotActions();
      if (view._shouldShowTaskUI()) {
        void view._parseTaskSteps();
        void view._fetchStructuredProgress();
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
    const res = await gateway.request<ConfigPoolResult>(Methods.CONFIG_POOL, { machine });
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

export async function parseSlotViewTaskSteps(view: SlotView): Promise<void> {
  try {
    const selectedContext = view._taskAgentContext();
    const requestedRunId = view._linkedRun?.id ?? null;
    const requestedTaskFile = selectedContext?.taskFile ?? null;
    const snap = await gateway.request<TaskProgressResult>(Methods.TASK_PROGRESS, {
      slotId: view.slotId,
      ...(view._linkedRun ? { runId: view._linkedRun.id } : {}),
      ...(selectedContext?.taskFile ? { taskFile: selectedContext.taskFile } : {}),
    });
    if (
      (view._linkedRun?.id ?? null) !== requestedRunId ||
      (view._taskAgentContext()?.taskFile ?? null) !== requestedTaskFile
    ) {
      return;
    }
    const steps: TaskStep[] = [];
    for (const line of snap.markdown.split('\n')) {
      const match = line.match(/^- \[([ x])\] (.+)/);
      if (match) {
        steps.push({ text: match[2], checked: match[1] === 'x' });
      }
    }
    view._taskSteps = steps;
    const checked = steps.filter((step) => step.checked).length;
    view._taskProgress = steps.length > 0 ? checked / steps.length : 0;
  } catch (err) {
    console.warn(
      '[slot-view] parse task steps failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function fetchSlotViewStructuredProgress(view: SlotView): Promise<void> {
  try {
    const selectedContext = view._taskAgentContext();
    const requestedRunId = view._linkedRun?.id ?? null;
    const requestedTaskFile = selectedContext?.taskFile ?? null;
    const result = await gateway.request<TaskProgressResult>(Methods.TASK_PROGRESS, {
      slotId: view.slotId,
      ...(view._linkedRun ? { runId: view._linkedRun.id } : {}),
      ...(selectedContext?.taskFile ? { taskFile: selectedContext.taskFile } : {}),
    });
    if (
      (view._linkedRun?.id ?? null) !== requestedRunId ||
      (view._taskAgentContext()?.taskFile ?? null) !== requestedTaskFile
    ) {
      return;
    }
    if (result.structured) {
      view._structuredProgress = result.structured;
    }
  } catch (err) {
    console.warn(
      '[slot-view] structured progress fetch failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
