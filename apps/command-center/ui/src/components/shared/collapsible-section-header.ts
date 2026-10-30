import { html, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

interface CollapsibleSectionHeaderOptions {
  testId?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
}

export function renderCollapsibleSectionHeader(
  label: string,
  collapsed: boolean,
  onToggle?: () => void,
  options: CollapsibleSectionHeaderOptions = {},
): TemplateResult {
  return html`
    <button
      data-testid=${ifDefined(options.testId)}
      class=${ifDefined(options.className)}
      ?disabled=${options.disabled ?? false}
      title=${ifDefined(options.title)}
      aria-expanded=${String(!collapsed)}
      style="display:flex; width:100%; align-items:center; justify-content:space-between; border:1px solid ${collapsed
        ? `${colors.bgCardHover}`
        : `${colors.accent}55`}; background:${collapsed
        ? colors.bgSurface
        : `${colors.accent}12`}; color:${colors.textPrimary}; padding:${spacing.sm}; border-radius:${radii.md}; cursor:pointer; font:inherit; margin-bottom:${spacing.xs}; box-shadow:${collapsed
        ? 'none'
        : `inset 0 0 0 1px ${colors.accent}22`};"
      @click=${onToggle ?? (() => {})}
    >
      <span style="display:flex; align-items:center; gap:${spacing.sm}; min-width:0;">
        <span
          style="display:inline-flex; width:18px; height:18px; align-items:center; justify-content:center; border-radius:999px; background:${collapsed
            ? colors.bgCard
            : `${colors.accent}22`}; color:${collapsed
            ? colors.textSecondary
            : colors.accent}; font-size:${fonts.sizeXs}; font-weight:700;"
          >${collapsed ? '+' : '−'}</span
        >
        <span
          style="font-size:${fonts.sizeXs}; color:${collapsed
            ? colors.textSecondary
            : colors.textPrimary}; text-transform:uppercase; letter-spacing:0.08em; font-weight:700;"
          >${label}</span
        >
      </span>
      <span
        style="font-size:${fonts.sizeXs}; color:${collapsed
          ? colors.textMuted
          : colors.accent}; font-weight:600;"
        >${collapsed ? 'Expand' : 'Collapse'}</span
      >
    </button>
  `;
}
