import { css, html, nothing, unsafeCSS } from 'lit';

import { colors, fonts, radii } from '../../styles/theme-tokens.js';

export const planningChoiceStyles = css`
  .choice-grid {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
  }
  .choice-button {
    padding: 2px 8px;
    border-radius: ${unsafeCSS(radii.lg)};
    border-color: ${unsafeCSS(colors.bgCard)};
    background: transparent;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    line-height: 1.4;
  }
  .choice-button:hover {
    border-color: ${unsafeCSS(colors.accent)}66;
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .choice-button.active {
    background: ${unsafeCSS(colors.accent)}22;
    color: ${unsafeCSS(colors.accent)};
    border-color: ${unsafeCSS(colors.accent)};
  }
  .choice-group {
    flex-basis: 100%;
    margin-top: 2px;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }
  .choice-hint {
    opacity: 0.7;
  }
`;

export function renderChoiceButtons<T extends string>(input: {
  options: readonly T[];
  value: T;
  onSelect: (value: T) => void;
  labels?: Partial<Record<T, string>>;
  /** A heading starts each run of options that share a group. */
  groups?: Partial<Record<T, string>>;
  /** Small secondary text inside an option. */
  hints?: Partial<Record<T, string>>;
  testId?: string;
  disabled?: boolean;
}) {
  const labels: Partial<Record<T, string>> = input.labels ?? {};
  const groups: Partial<Record<T, string>> = input.groups ?? {};
  const hints: Partial<Record<T, string>> = input.hints ?? {};
  return html`<div
    class="choice-grid"
    role="group"
    data-value=${input.value}
    data-testid=${input.testId ?? ''}
  >
    ${input.options.map(
      (option, index) =>
        html`${groups[option] &&
          (index === 0 || groups[input.options[index - 1]] !== groups[option])
            ? html`<span class="choice-group">${groups[option]}</span>`
            : nothing}<button
            class="choice-button ${option === input.value ? 'active' : ''}"
            aria-pressed=${String(option === input.value)}
            data-choice-value=${option}
            type="button"
            data-testid=${input.testId ? `${input.testId}-${option}` : ''}
            ?disabled=${input.disabled}
            @click=${() => input.onSelect(option)}
          >
            ${labels[option] ?? option}${hints[option]
              ? html` <small class="choice-hint">${hints[option]}</small>`
              : nothing}
          </button>`,
    )}
  </div>`;
}

export function renderToggleChips<T extends string>(input: {
  options: readonly T[];
  selected: readonly T[];
  onToggle: (value: T) => void;
  labels?: Partial<Record<T, string>>;
  testId?: string;
}) {
  const labels: Partial<Record<T, string>> = input.labels ?? {};
  return html`<div class="choice-grid" data-testid=${input.testId ?? ''}>
    ${input.options.map(
      (option) =>
        html`<button
          class="choice-button ${input.selected.includes(option) ? 'active' : ''}"
          type="button"
          data-testid=${input.testId ? `${input.testId}-${option}` : ''}
          @click=${() => input.onToggle(option)}
        >
          ${labels[option] ?? option}
        </button>`,
    )}
  </div>`;
}
