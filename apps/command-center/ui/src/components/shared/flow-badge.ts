import { css, html, unsafeCSS } from 'lit';

import { flowColor, flowLabel } from '@farmslot/theme';

import { colors } from '../../styles/theme-tokens.js';

export interface FlowBadgePresentation {
  color: string;
  label: string;
  title: string;
}

export function flowBadgePresentation(
  flow: string,
  overrides: Partial<FlowBadgePresentation> = {},
): FlowBadgePresentation {
  return {
    color: overrides.color ?? flowColor(flow),
    label: overrides.label ?? flowLabel(flow),
    title: overrides.title ?? `Flow: ${flow}`,
  };
}

export const flowBadgeStyles = css`
  .flow-badge {
    display: inline-block;
    padding: 2px 6px;
    border: 0;
    border-radius: 4px;
    background: var(--flow-color, ${unsafeCSS(colors.textMuted)});
    color: #000;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
  }
`;

export function renderFlowBadge(flow: string, overrides: Partial<FlowBadgePresentation> = {}) {
  const badge = flowBadgePresentation(flow, overrides);
  return html`<span
    class="badge flow-badge"
    style=${`--flow-color:${badge.color}; background:${badge.color}`}
    title=${badge.title}
    >${badge.label}</span
  >`;
}
