import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { colors, fonts } from '../../styles/theme-tokens.js';

/** Shared searchable choice control. Light-DOM option nodes are data, never native select UI. */
@customElement('choice-picker')
export class ChoicePicker extends LitElement {
  static formAssociated = true;
  private readonly internals = this.attachInternals();
  @property() value = '';
  @property({ type: Boolean, reflect: true }) disabled = false;
  @property({ type: Boolean }) required = false;
  @property() placeholder = 'Choose…';
  @state() private opened = false;
  @state() private query = '';
  @state() private fieldsetDisabled = false;
  private observer = new MutationObserver(() => this.requestUpdate());
  private outside = (event: Event) => {
    if (!event.composedPath().includes(this)) this.opened = false;
  };
  private escape = (event: KeyboardEvent) => {
    if (this.opened && event.key === 'Escape') {
      event.stopPropagation();
      this.close();
    }
  };
  get options(): HTMLOptionElement[] {
    return [...this.querySelectorAll('option')];
  }
  static styles = css`
    :host {
      display: block;
      min-width: 0;
      font-family: ${unsafeCSS(fonts.mono)};
      color: ${unsafeCSS(colors.textSecondary)};
    }
    button,
    input {
      font: inherit;
      font-size: 12px;
      color: inherit;
      box-sizing: border-box;
    }
    button {
      cursor: pointer;
    }
    .trigger {
      width: 100%;
      display: flex;
      gap: 10px;
      justify-content: space-between;
      text-align: left;
      border: 1px solid #2a2a44;
      border-radius: 5px;
      background: ${unsafeCSS(colors.bgSurface)};
      padding: 8px 10px;
    }
    .trigger:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .panel {
      border: 1px solid ${unsafeCSS(colors.accentDim)};
      border-radius: 6px;
      padding: 8px;
      margin-top: 5px;
      background: ${unsafeCSS(colors.bgSurface)};
    }
    input {
      width: 100%;
      min-width: 0;
      padding: 8px;
      border: 1px solid #2a2a44;
      border-radius: 4px;
      background: ${unsafeCSS(colors.bgInput)};
    }
    .options {
      max-height: 240px;
      overflow: auto;
      overscroll-behavior: contain;
      margin-top: 6px;
      display: grid;
      gap: 3px;
    }
    .option {
      text-align: left;
      width: 100%;
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 8px;
      background: transparent;
      overflow-wrap: anywhere;
    }
    .option:hover,
    .option[aria-selected='true'] {
      background: ${unsafeCSS(colors.accent)}22;
      border-color: ${unsafeCSS(colors.accent)}66;
    }
    .option:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .empty {
      padding: 8px;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 12px;
    }
    .label {
      overflow-wrap: anywhere;
      min-width: 0;
    }
  `;
  connectedCallback() {
    super.connectedCallback();
    this.observer.observe(this, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    document.addEventListener('click', this.outside);
    this.addEventListener('keydown', this.escape);
  }
  disconnectedCallback() {
    this.observer.disconnect();
    document.removeEventListener('click', this.outside);
    this.removeEventListener('keydown', this.escape);
    super.disconnectedCallback();
  }
  formDisabledCallback(disabled: boolean) {
    this.fieldsetDisabled = disabled;
  }
  protected updated() {
    this.internals.setFormValue(this.value);
    const button = this.renderRoot.querySelector<HTMLButtonElement>('.trigger')!;
    this.internals.setValidity(
      this.required && !this.value ? { valueMissing: true } : {},
      this.required && !this.value ? 'Choose an option.' : '',
      button,
    );
    for (const option of this.options) option.selected = option.value === this.value;
    if (this.disabled || this.fieldsetDisabled) this.opened = false;
  }
  private close() {
    this.opened = false;
    this.renderRoot.querySelector<HTMLButtonElement>('.trigger')?.focus();
  }
  private choose(option: HTMLOptionElement) {
    if (option.disabled || this.disabled || this.fieldsetDisabled) return;
    const changed = this.value !== option.value;
    this.value = option.value;
    this.close();
    if (!changed) return;
    this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }
  private async toggle() {
    this.opened = !this.opened;
    this.query = '';
    await this.updateComplete;
    if (this.opened) this.renderRoot.querySelector<HTMLInputElement>('input')?.focus();
  }
  render() {
    const options = this.options;
    const selected = options.find((o) => o.value === this.value);
    const label = (option: HTMLOptionElement) => option.label.trim().replace(/\s+/g, ' ');
    const matches = options.filter((o) =>
      label(o).toLowerCase().includes(this.query.toLowerCase()),
    );
    return html`<button
        type="button"
        class="trigger"
        aria-haspopup="listbox"
        aria-expanded=${String(this.opened)}
        ?disabled=${this.disabled || this.fieldsetDisabled}
        @click=${this.toggle}
      >
        <span class="label">${selected ? label(selected) : this.value || this.placeholder}</span
        ><span aria-hidden="true">${this.opened ? '▴' : '▾'}</span>
      </button>
      ${this.opened
        ? html`<div class="panel">
            <input
              aria-label="Search choices"
              placeholder="Search…"
              .value=${this.query}
              @input=${(event: Event) => {
                event.stopPropagation();
                this.query = (event.target as HTMLInputElement).value;
              }}
              @change=${(event: Event) => event.stopPropagation()}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  this.renderRoot
                    .querySelector<HTMLButtonElement>('.option:not(:disabled)')
                    ?.focus();
                }
              }}
            />
            <div
              class="options"
              role="listbox"
              @keydown=${(event: KeyboardEvent) => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const buttons = [
                  ...this.renderRoot.querySelectorAll<HTMLButtonElement>('.option:not(:disabled)'),
                ];
                const index = buttons.indexOf(event.target as HTMLButtonElement);
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? buttons.length - 1
                      : Math.max(
                          0,
                          Math.min(
                            buttons.length - 1,
                            index + (event.key === 'ArrowDown' ? 1 : -1),
                          ),
                        );
                buttons[next]?.focus();
              }}
            >
              ${matches.map(
                (o) =>
                  html`<button
                    type="button"
                    class="option"
                    role="option"
                    data-choice-value=${o.value}
                    data-choice-label=${label(o)}
                    aria-selected=${String(o.value === this.value)}
                    ?disabled=${o.disabled}
                    @click=${() => this.choose(o)}
                  >
                    ${label(o)}
                  </button>`,
              )}${matches.length ? nothing : html`<span class="empty">No matching choices</span>`}
            </div>
          </div>`
        : nothing}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'choice-picker': ChoicePicker;
  }
}
