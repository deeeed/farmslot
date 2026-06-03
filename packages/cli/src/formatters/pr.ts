import type { PRStatus } from '@farmslot/protocol';

import { boldRed, green, red, yellow } from '../colors.js';

export function formatPRStatus(pr: PRStatus): string {
  return formatPREntry(pr);
}

export function formatPRList(prs: PRStatus[]): string {
  if (!prs.length) return 'No active PRs found.\n';

  const sorted = [...prs].sort((a, b) => a.pr - b.pr);
  return sorted.map(formatPREntry).join('') + '\n';
}

function formatPREntry(r: PRStatus): string {
  const lines: string[] = [];
  const slot = r.slot || '-';
  const cs = r.checkSummary;

  // Check summary parts
  const parts: string[] = [];
  if (cs.passed) parts.push(green(`${cs.passed} pass`));
  if (cs.failed) parts.push(red(`${cs.failed} fail`));
  if (cs.pending) parts.push(yellow(`${cs.pending} pending`));
  const status = parts.join(', ') || 'no checks';

  // Overall status
  let overall: string;
  if (r.allPassed) {
    overall = green('ALL PASS');
  } else if (r.anyFailed) {
    overall = red('FAILED');
  } else {
    overall = yellow('PENDING');
  }

  lines.push(`PR #${r.pr}  [${slot}]  ${overall}  (${status})`);

  if (r.mergeConflict) {
    lines.push(`  ${boldRed('MERGE CONFLICT')}`);
  }

  if (r.failedNames.length) {
    lines.push(`  Failed: ${r.failedNames.join(', ')}`);
  }

  if (r.actionableBotComments.length) {
    lines.push(`  Bot comments (${r.actionableBotComments.length} actionable):`);
    for (const bc of r.actionableBotComments) {
      const preview =
        bc.bodyPreview.length > 80 ? bc.bodyPreview.slice(0, 80) + '...' : bc.bodyPreview;
      lines.push(`    - [${bc.label}] ${bc.author}: ${preview}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
