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
  /* Work in flight outranks work merely available. Ready was green and the
     loudest badge on the board, while running fell through to the muted default
     — an idle item read as more urgent than one actively being worked. Amber
     matches the fleet map's busy lifecycle colour, keeping one colour language.
     The pulse marks it as live rather than just another coloured chip. */
  .badge.active {
    color: ${unsafeCSS(colors.lifecycleBusy)};
    border-color: ${unsafeCSS(colors.lifecycleBusy)}88;
    background: ${unsafeCSS(colors.lifecycleBusy)}14;
    animation: badge-pulse 2s ease-in-out infinite;
  }
  @keyframes badge-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.55;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .badge.active {
      animation: none;
    }
  }
  .badge.tag {
    color: ${unsafeCSS(colors.accent)};
    border-color: ${unsafeCSS(colors.accent)}55;
  }
`;

/**
 * Badge tone for a backlog/roadmap item status, in attention order.
 *
 * Shared so the backlog list, the roadmap list and any future surface agree:
 * failure first, then work actually in flight, then merely available. Anything
 * unlisted (done, archived, candidate) stays muted on purpose.
 */
export function statusTone(status: string): 'default' | 'positive' | 'danger' | 'active' {
  if (status === 'failed' || status === 'needs-attention') return 'danger';
  if (status === 'running' || status === 'dispatching' || status === 'queued') return 'active';
  if (status === 'ready' || status === 'refined' || status === 'promoted') return 'positive';
  return 'default';
}

export function tagsFromInput(value: string): string[] {
  return normalizeRunTags(value.split(',').map((tag) => tag.trim()));
}

export function tagsToInput(tags: readonly string[] | undefined): string {
  return (tags ?? []).join(', ');
}

export function renderPlanningBadge(
  label: string,
  tone: 'default' | 'positive' | 'danger' | 'active' = 'default',
) {
  return html`<span class="badge ${tone === 'default' ? '' : tone}">${label}</span>`;
}

export function renderTagChips(tags: readonly string[] | undefined) {
  const normalized = normalizeRunTags(tags);
  return normalized.length === 0
    ? nothing
    : normalized.map((tag) => html`<span class="badge tag">#${tag}</span>`);
}
