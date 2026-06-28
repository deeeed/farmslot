import { css, html, nothing, unsafeCSS } from 'lit';

import { normalizeRunTags } from '@farmslot/protocol';

import { colors, fonts, radii } from '../../styles/theme-tokens.js';

export const planningBadgeStyles = css`
  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .badge {
    border: 1px solid ${unsafeCSS(colors.textMuted)}33;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 2px 7px;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }
  .badge.ready,
  .badge.refined,
  .badge.promoted,
  .badge.positive {
    color: ${unsafeCSS(colors.statusOk)};
    border-color: ${unsafeCSS(colors.statusOk)}66;
  }
  .badge.failed,
  .badge.needs-attention,
  .badge.danger {
    color: ${unsafeCSS(colors.statusFail)};
    border-color: ${unsafeCSS(colors.statusFail)}66;
  }
  .badge.tag {
    color: ${unsafeCSS(colors.accent)};
    border-color: ${unsafeCSS(colors.accent)}55;
  }
`;

export function tagsFromInput(value: string): string[] {
  return normalizeRunTags(value.split(',').map((tag) => tag.trim()));
}

export function tagsToInput(tags: readonly string[] | undefined): string {
  return (tags ?? []).join(', ');
}

export function renderPlanningBadge(
  label: string,
  tone: 'default' | 'positive' | 'danger' = 'default',
) {
  return html`<span class="badge ${tone === 'default' ? '' : tone}">${label}</span>`;
}

export function renderTagChips(tags: readonly string[] | undefined) {
  const normalized = normalizeRunTags(tags);
  return normalized.length === 0
    ? nothing
    : normalized.map((tag) => html`<span class="badge tag">#${tag}</span>`);
}
