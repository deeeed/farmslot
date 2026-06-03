import type { SlotCheckResult } from '@farmslot/protocol';

import { bold, boldGreen, boldRed, green, red } from '../colors.js';

export function formatSlotCheck(result: SlotCheckResult): string {
  const { slot, checks } = result;
  const lines: string[] = [];

  lines.push(bold(`=== Check: ${slot.slot} on ${slot.machine} (${slot.platform}) ===`));
  lines.push(`  host:     ${slot.machine}`);
  lines.push(`  project:  ${slot.project}`);
  if (slot.health.devserver !== '-') {
    lines.push(`  devserver: ${slot.health.devserver}`);
  }
  lines.push('');

  for (const c of checks) {
    if (c.status === 'pass') {
      lines.push(`  ${green('[OK]')} ${c.detail}`);
    } else {
      lines.push(`  ${red('[FAIL]')} ${c.detail}`);
    }
  }

  const failures = checks.filter((c) => c.status === 'fail');
  lines.push('');
  if (!failures.length) {
    lines.push(boldGreen(`=== SLOT ${slot.slot} READY ===`));
  } else {
    lines.push(boldRed(`=== SLOT ${slot.slot} NOT READY (${failures.length} failures) ===`));
    for (const f of failures) {
      lines.push(`  ${red('x')} ${f.detail}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
