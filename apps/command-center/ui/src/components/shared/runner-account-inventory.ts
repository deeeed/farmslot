import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { ProviderRunnerAccountStatus } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

@customElement('runner-account-command')
export class RunnerAccountCommand extends LitElement {
  @property({ attribute: false }) runner!: ProviderRunnerAccountStatus;
  @state() private copied = false;
  @state() private error = '';

  static styles = css`
    :host {
      display: inline-block;
      margin: 0 0 6px;
    }
    button {
      font: inherit;
      font-size: 11px;
      cursor: pointer;
      padding: 3px 7px;
      border-radius: 4px;
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
      background: transparent;
    }
    button:hover {
      color: ${unsafeCSS(colors.accent)};
      border-color: ${unsafeCSS(colors.accent)};
    }
    button:focus-visible {
      outline: 2px solid ${unsafeCSS(colors.accent)};
    }
    [role='alert'] {
      color: ${unsafeCSS(colors.statusFail)};
      font-size: 11px;
    }
  `;

  protected updated(changed: Map<string, unknown>) {
    if (changed.has('runner')) {
      this.copied = false;
      this.error = '';
    }
  }

  private async copy() {
    const inspection = this.runner.inventory?.inspection;
    if (!inspection) return;
    try {
      await navigator.clipboard.writeText(inspection.command);
      this.copied = true;
      this.error = '';
    } catch {
      this.error = 'Clipboard unavailable. Allow clipboard access and retry.';
    }
  }

  render() {
    const inspection = this.runner?.inventory?.inspection;
    if (!inspection) return nothing;
    return html`<button
        type="button"
        title=${inspection.description}
        aria-label=${`Copy status command for ${this.runner.runner}`}
        @click=${this.copy}
      >
        ${this.copied ? 'Copied' : 'Copy status command'}
      </button>
      <span role="status" aria-live="polite"
        >${this.copied ? 'Ready to paste in your terminal' : ''}</span
      >
      ${this.error ? html`<div role="alert">${this.error}</div>` : nothing}`;
  }
}

/** Shared Config/Fleet projection; runner adapters own provider-specific facts. */
export function renderRunnerAccountInventory(runner: ProviderRunnerAccountStatus) {
  return html`<runner-account-command .runner=${runner}></runner-account-command>
    <div>${renderAccounts(runner)}</div>`;
}

function renderAccounts(runner: ProviderRunnerAccountStatus) {
  const inventory = runner.inventory;
  if (!inventory) return html`${runner.usage?.accountEmail ?? runner.activeLabel ?? runner.status}`;
  if (inventory.status !== 'available')
    return html`<span
      >${inventory.error ??
      (inventory.status === 'unsupported'
        ? 'Account status unsupported'
        : 'Account status unavailable')}</span
    >`;
  if (!inventory.accounts.length) return html`<span>No saved provider logins</span>`;
  return html`${inventory.accounts.map(
    (account) => html`
      <div data-provider=${account.provider} data-account-id=${account.id}>
        <span>${account.provider}</span>
        ${account.email
          ? html` · ${account.email}`
          : account.label && account.label !== 'ambient'
            ? html` · ${account.label}`
            : ''}
        ${account.authType !== 'unknown'
          ? html` · ${account.authType === 'oauth' ? 'OAuth' : 'API key'}`
          : ''}
        · ${account.status === 'not_ready' ? 'not ready' : account.status}
      </div>
    `,
  )}${inventory.accounts.every((a) => !a.email)
    ? html`<div style="color:${colors.textMuted};font-size:11px">
        Email${!runner.usage ? ' and quota' : ''} not reported
      </div>`
    : nothing}`;
}
