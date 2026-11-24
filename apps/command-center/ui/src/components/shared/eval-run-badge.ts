import { css, html, nothing, unsafeCSS } from 'lit';

import type { Run } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';
import { evalRunBadge } from '../runs/run-utils.js';

/** Outlined so it never reads as a flow badge; shared by the run list rows and run detail header. */
export const evalRunBadgeStyles = css`
  .eval-run-badge {
    display: inline-block;
    padding: 1px 6px;
    border: 1px solid ${unsafeCSS(colors.accent)};
    border-radius: 4px;
    color: ${unsafeCSS(colors.accent)};
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    white-space: nowrap;
    vertical-align: middle;
  }
`;

export function renderEvalRunBadge(run: Partial<Pick<Run, 'lane'>> & { variant?: string | null }) {
  const badge = evalRunBadge(run);
  if (!badge) return nothing;
  return html`<span class="badge eval-run-badge" data-testid="eval-run-badge" title=${badge.title}
    >${badge.label}</span
  >`;
}
