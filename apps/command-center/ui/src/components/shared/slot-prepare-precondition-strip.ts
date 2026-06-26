import { html, nothing } from 'lit';

import type { SlotHealth, SlotStatus } from '@farmslot/protocol';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

function healthTone(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!value || value === '-') return colors.textMuted;
  if (normalized === 'OK' || normalized === 'LOCAL' || /WALLET/i.test(value))
    return colors.statusOk;
  if (normalized === 'OFF' || normalized === 'FAIL') return colors.statusWarn;
  return colors.textSecondary;
}

export function renderSlotPreparePreconditionStrip(args: {
  slot: SlotStatus | null;
  slotBranch?: string | null;
  activePrepareLabel?: string;
}) {
  const slot = args.slot;
  if (!slot) return nothing;
  const branch = args.slotBranch?.trim() || slot.branch || 'unknown';
  const health: SlotHealth = slot.health;
  const chips = [
    ['branch', branch, colors.accent],
    ['ssh', health.ssh, healthTone(health.ssh)],
    ['dev', health.devserver, healthTone(health.devserver)],
    ['cdp', health.cdp, healthTone(health.cdp)],
    ['fixtures', health.fixtures, healthTone(health.fixtures)],
  ] as const;
  return html`
    <div
      style="padding:${spacing.xs} ${spacing.md}; border-bottom:1px solid #2a2a44; background:${colors.bgCard}; display:flex; flex-wrap:wrap; gap:8px; align-items:center; font-family:${fonts.mono}; font-size:10px; color:${colors.textMuted}"
    >
      <span style="font-weight:700; color:${colors.textSecondary}">${slot.slot}</span>
      ${chips.map(
        ([label, value, color]) => html`
          <span title=${label}
            >${label}
            <span style="color:${color}; font-weight:700; margin-left:4px"
              >${value || '-'}</span
            ></span
          >
        `,
      )}
      ${args.activePrepareLabel
        ? html`<span style="margin-left:auto; color:${colors.accent}"
            >${args.activePrepareLabel}</span
          >`
        : nothing}
    </div>
  `;
}
