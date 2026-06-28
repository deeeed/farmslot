import { DEFAULT_BRANCH, isSlotRefreshStaleBranch, type SlotStatus } from '@farmslot/protocol';

import type { FleetRefreshProjectConfig } from '../slot-actions/fleet-refresh-modal-model.js';

export type SlotBranchDisplayTone = 'baseline' | 'tracking' | 'stale';

export interface SlotBranchDisplay {
  label: string;
  tone: SlotBranchDisplayTone;
}

export function slotBranchDisplay(
  slot: Pick<SlotStatus, 'branch' | 'project' | 'session' | 'slot' | 'linkedWorktree'>,
  projectConfigs: Readonly<Record<string, FleetRefreshProjectConfig>> = {},
): SlotBranchDisplay {
  const cfg = projectConfigs[slot.project];
  const defaultBranch = cfg?.defaultBranch ?? DEFAULT_BRANCH;
  const branch = slot.branch?.trim() ?? '';
  if (!branch) return { label: defaultBranch, tone: 'baseline' };
  const stale = isSlotRefreshStaleBranch(branch, cfg ?? { defaultBranch }, {
    session: slot.session,
    slotId: slot.slot,
    linkedWorktree: slot.linkedWorktree,
  });
  if (stale) return { label: branch, tone: 'stale' };
  if (branch === defaultBranch) return { label: defaultBranch, tone: 'baseline' };
  return { label: branch, tone: 'tracking' };
}
