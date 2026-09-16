import { css, unsafeCSS } from 'lit';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

/** Shared look for the PR feedback candidate list (retrospective rail + inbox cards). */
export const feedbackCandidateStyles = css`
  .feedback-list {
    display: grid;
    gap: ${unsafeCSS(spacing.sm)};
    margin-top: ${unsafeCSS(spacing.sm)};
  }
  .feedback-candidate {
    border-left: 2px solid ${unsafeCSS(colors.textMuted)};
    padding-left: ${unsafeCSS(spacing.sm)};
    font-size: 11px;
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .feedback-candidate[data-author-kind='human'] {
    border-left-color: ${unsafeCSS(colors.accent)};
  }
  .feedback-head,
  .feedback-meta {
    display: flex;
    flex-wrap: wrap;
    gap: ${unsafeCSS(spacing.xs)};
    align-items: baseline;
  }
  .feedback-kind,
  .feedback-meta {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
  }
  .feedback-kind {
    text-transform: uppercase;
  }
  .feedback-candidate .muted {
    color: ${unsafeCSS(colors.textMuted)};
  }
`;
