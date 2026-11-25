import { html } from 'lit';

import type { RunListRow, SlotHealth } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

/** The slot run detail offers to load with the run. */
export interface RunPrepareSlot {
  id: string;
  branch: string;
  health: SlotHealth | null;
}

/** Run detail's "Load <slot> with this run" popover; it passes the run's flow type and domain. */
export function renderRunSlotPreparePopover(
  r: Pick<RunListRow, 'id' | 'project' | 'branch' | 'flowType' | 'domain'>,
  slot: RunPrepareSlot,
  actionsBlocked: boolean,
) {
  const boundSlotId = slot.id;
  return html`
    <slot-prepare-popover
      slot-id=${boundSlotId}
      slot-branch=${slot.branch}
      project=${r.project}
      run-id=${r.id}
      run-branch=${r.branch}
      run-flow-type=${r.flowType}
      run-domain=${r.domain ?? ''}
      button-label="Load ${boundSlotId} with this run →"
      button-style="border:1px solid ${colors.textMuted}; color:${colors.textMuted}; padding:4px 12px; font-size:11px; border-radius:3px"
      .slotHealth=${slot.health}
      ?disabled=${actionsBlocked}
    ></slot-prepare-popover>
  `;
}
