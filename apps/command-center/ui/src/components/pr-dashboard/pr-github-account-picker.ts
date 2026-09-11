import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { ConfigGitHubAccountsResult, PRSourceAccount } from '@farmslot/protocol';

import '../shared/choice-picker.js';

import type { ChoicePicker } from '../shared/choice-picker.js';

import { prAutomationStyles } from './pr-automation-styles.js';

@customElement('pr-github-account-picker')
export class PRGitHubAccountPicker extends LitElement {
  @property({ attribute: false }) accounts: ConfigGitHubAccountsResult['accounts'] = [];
  @property({ attribute: false }) value: PRSourceAccount = { host: 'github.com', login: '' };
  @property({ type: Boolean }) disabled = false;
  @property() error = '';
  @property() testId = 'pr-github-account';
  static styles = prAutomationStyles;
  protected updated(changes: PropertyValues<this>) {
    if (
      (changes.has('accounts') || changes.has('value')) &&
      !this.value.login &&
      this.accounts.length === 1
    )
      this.select(this.accounts[0]);
  }
  private select(account: PRSourceAccount) {
    this.dispatchEvent(
      new CustomEvent('account-change', {
        detail: { host: account.host, login: account.login },
        bubbles: true,
        composed: true,
      }),
    );
  }
  render() {
    const selected = this.accounts.find(
      (a) =>
        a.host.toLowerCase() === this.value.host.toLowerCase() &&
        a.login.toLowerCase() === this.value.login.toLowerCase(),
    );
    return html`<div>
      <label
        >GitHub account on the gateway
        ${this.accounts.length === 1 && (!this.value.login || selected)
          ? html`<input
              data-account-login=${this.accounts[0].login}
              data-choice-value=${`${this.accounts[0].host}/${this.accounts[0].login}`}
              data-testid=${this.testId}
              readonly
              .value=${`${this.accounts[0].login} · ${this.accounts[0].host}`}
            />`
          : html`<choice-picker
              data-testid=${this.testId}
              ?disabled=${this.disabled || !this.accounts.length}
              .value=${selected ? `${selected.host}/${selected.login}` : ''}
              @change=${(event: Event) => {
                const account = this.accounts.find(
                  (a) => `${a.host}/${a.login}` === (event.target as ChoicePicker).value,
                );
                if (account) this.select(account);
              }}
            >
              <option value="" disabled .selected=${!selected}>
                ${this.value.login
                  ? `${this.value.login} · not connected on gateway`
                  : 'Choose a configured account'}
              </option>
              ${this.accounts.map(
                (a) =>
                  html`<option
                    .value=${`${a.host}/${a.login}`}
                    data-account-login=${a.login}
                    .selected=${a === selected}
                  >
                    ${a.login} · ${a.host}${a.active ? ' · CLI default' : ''}
                  </option>`,
              )}
            </choice-picker>`}
      </label>
      <p class="muted">
        Credentials stay on the gateway.
        ${this.accounts.length > 1
          ? 'Choose which configured identity this policy uses.'
          : 'This identity comes from the gateway configuration.'}
      </p>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      ${!this.accounts.length
        ? html`<p class="attention">
            Sign in with <code>gh auth login</code> on the gateway machine, then refresh accounts.
            Typing a username here cannot grant access.
          </p>`
        : nothing}
      <button
        type="button"
        ?disabled=${this.disabled}
        data-testid="pr-github-accounts-refresh"
        @click=${() =>
          this.dispatchEvent(
            new CustomEvent('refresh-accounts', { bubbles: true, composed: true }),
          )}
      >
        Refresh gateway accounts
      </button>
    </div>`;
  }
}
