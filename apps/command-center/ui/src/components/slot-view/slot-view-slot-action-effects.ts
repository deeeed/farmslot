import type { SlotActionRunResult, SlotActionSummary } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

import type { SlotView } from './slot-view.js';
import {
  canRunSlotViewAction,
  slotViewActionsForPlacement,
} from './slot-view-slot-action-model.js';

export function slotViewHeaderActions(view: SlotView): SlotActionSummary[] {
  return slotViewActionsForPlacement(view._slotActions, 'slot-header');
}

export function slotViewResourcePanelActions(view: SlotView): SlotActionSummary[] {
  return slotViewActionsForPlacement(view._slotActions, 'resource-panel');
}

export function runConfiguredSlotViewAction(view: SlotView, actionId: string): void {
  const action = view._slotActions.find((entry) => entry.id === actionId);
  if (
    !canRunSlotViewAction({
      action,
      runningActionIds: view._runningSlotActionIds,
      recoveryBlocked: view._isRecoveryBlocked,
    }) ||
    !action
  ) {
    return;
  }
  const execute = () => {
    void executeConfiguredSlotViewAction(view, action);
  };
  if (action.confirm) {
    view._confirmAction(`slot-action:${actionId}`, execute);
  } else {
    execute();
  }
}

export async function executeConfiguredSlotViewAction(
  view: SlotView,
  action: SlotActionSummary,
): Promise<void> {
  view._runningSlotActionIds = [...view._runningSlotActionIds, action.id];
  const flashError = (msg: string) => {
    view._failedSlotActionId = action.id;
    view._failedSlotActionMsg = msg;
    setTimeout(() => {
      if (view._failedSlotActionId === action.id) {
        view._failedSlotActionId = '';
        view._failedSlotActionMsg = '';
      }
    }, 4000);
  };
  try {
    const result = await gateway.request<SlotActionRunResult>(
      Methods.SLOT_ACTION_RUN,
      { slotId: view.slotId, actionId: action.id },
      5 * 60_000,
    );
    if (action.mode === 'copy' && result.command) {
      await copySlotViewText(result.command);
      view._copyFeedback.show(action.id);
    }
    if (!result.ok) {
      flashError(result.detail ?? `${action.label} failed`);
      console.error(`[slot-view] slot action ${action.label} failed:`, result.detail);
    }
    const refresh = result.refresh ?? action.refresh;
    if (refresh.includes('resources')) {
      await view._fetchResources();
    }
    if (refresh.includes('fleet')) {
      await gateway.request(Methods.FLEET_REFRESH, {});
    }
    if (refresh.includes('fleet') || refresh.includes('slot')) {
      view._loadSlot();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : `${action.label} failed`;
    flashError(msg);
    console.error(`[slot-view] slot action ${action.label} threw:`, err);
  } finally {
    view._runningSlotActionIds = view._runningSlotActionIds.filter((id) => id !== action.id);
  }
}

export async function copySlotViewText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}
