// "Spent so far" and the per-step cost column, from task.progress `liveSpend`.
import { css, html, nothing, unsafeCSS } from 'lit';

import type { TaskLiveSpend } from '@farmslot/protocol';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';
import { formatCompactNumber } from '../runs/family-observability-compare-model.js';

/** Small DeepSeek steps cost fractions of a cent; keep them readable instead of "$0.00". */
export function formatSpendUsd(value: number | null | undefined): string {
  if (value == null) return '—';
  return `$${value < 0.1 ? value.toFixed(4) : value.toFixed(2)}`;
}

export interface LiveSpendSummaryView {
  cost: string;
  tokens: string;
  compactions: string;
  toolCalls: string;
  /** Partial numbers (catching up) or why there are none. */
  note?: string;
  title: string;
}

export function liveSpendSummary(spend: TaskLiveSpend | undefined): LiveSpendSummaryView | null {
  if (!spend) return null;
  const note = spend.unavailable
    ? spend.unavailable
    : spend.behindBytes
      ? `reading the transcript, ${formatCompactNumber(spend.behindBytes)} bytes to go`
      : undefined;
  return {
    cost: formatSpendUsd(spend.costUsd),
    tokens: formatCompactNumber(spend.totalTokens),
    compactions: spend.compactions == null ? '—' : `${spend.compactions}`,
    toolCalls: `${spend.toolCalls}`,
    ...(note ? { note } : {}),
    title: `${spend.runner} session, read ${new Date(spend.readAt).toLocaleTimeString()}${
      spend.costUsd == null ? '; cost unknown: no recorded or listed price for a token record' : ''
    }`,
  };
}

/** The cost of checklist step `stepIndex` (the mark's step number); null before it has any. */
export function stepSpend(
  spend: TaskLiveSpend | undefined,
  stepIndex: number,
): { cost: string; title: string } | null {
  const step = spend?.steps.find(
    (segment) => segment.segment !== 'after-last-mark' && segment.stepNumber === stepIndex,
  );
  if (!step) return null;
  return {
    cost: formatSpendUsd(step.costUsd),
    title: `${formatCompactNumber(step.totalTokens)} tokens · ${step.toolCalls} tool calls${
      step.compactions ? ` · ${step.compactions} compactions` : ''
    }`,
  };
}

/** What the open step (after the last mark) has spent so far; before any mark, the whole session. */
export function openStepSpend(
  spend: TaskLiveSpend | undefined,
): { cost: string; title: string } | null {
  if (spend && !spend.steps.length && !spend.unavailable)
    return {
      cost: formatSpendUsd(spend.costUsd),
      title: `${formatCompactNumber(spend.totalTokens)} tokens · ${spend.toolCalls} tool calls`,
    };
  const step = spend?.steps.find((segment) => segment.segment === 'after-last-mark');
  if (!step) return null;
  return {
    cost: formatSpendUsd(step.costUsd),
    title: `${formatCompactNumber(step.totalTokens)} tokens · ${step.toolCalls} tool calls`,
  };
}

/** "Spent so far": the progress tracker and the run page's step progress panel. */
export function renderSpentSoFar(spend: TaskLiveSpend | undefined) {
  const view = liveSpendSummary(spend);
  if (!view) return nothing;
  return html`<div class="spent-so-far" data-testid="spent-so-far" title=${view.title}>
    <span class="spent-label">Spent so far</span>
    <span class="spent-cost">${view.cost}</span>
    <span>${view.tokens} tokens</span>
    <span>${view.toolCalls} tool calls</span>
    <span>${view.compactions} compactions</span>
    ${view.note ? html`<span class="spent-note">${view.note}</span>` : nothing}
  </div>`;
}

export const spentSoFarStyles = css`
  .spent-so-far {
    display: flex;
    flex-wrap: wrap;
    gap: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
    align-items: baseline;
    font-size: ${unsafeCSS(fonts.sizeSm)};
    color: ${unsafeCSS(colors.textSecondary)};
    margin-bottom: ${unsafeCSS(spacing.sm)};
  }
  .spent-label {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }
  .spent-cost {
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .spent-note {
    color: ${unsafeCSS(colors.textMuted)};
  }
`;
