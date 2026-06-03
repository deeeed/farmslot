import type { SlotActionSummary } from '@farmslot/protocol';

export type SlotViewActionPlacement = 'slot-header' | 'resource-panel';

export function slotViewActionsForPlacement(
  actions: SlotActionSummary[],
  placement: SlotViewActionPlacement,
): SlotActionSummary[] {
  return actions.filter((action) => action.placement.includes(placement));
}

export function canRunSlotViewAction(params: {
  action?: SlotActionSummary | null;
  runningActionIds: readonly string[];
  recoveryBlocked: boolean;
}): boolean {
  return Boolean(
    params.action && !params.runningActionIds.includes(params.action.id) && !params.recoveryBlocked,
  );
}
