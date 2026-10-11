import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { DispatchPreviewParams, RecipeProjectCompatibility } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors } from '../../styles/theme-tokens.js';

import { requestDispatchPreview } from './dispatch-wizard-loaders.js';

@customElement('recipe-compatibility-panel')
export class RecipeCompatibilityPanel extends LitElement {
  @property({ attribute: false }) request: DispatchPreviewParams | null = null;
  @property({ type: Boolean }) disabled = false;
  @property({ type: String }) unavailable = '';
  @state() private result: RecipeProjectCompatibility | null = null;
  @state() private error = '';
  @state() private loading = false;
  private selectionKey = '';
  private generation = 0;
  private unsubscribe?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribe = gateway.onConnectionChange(() => {
      this.clear();
      this.requestUpdate();
    });
  }

  disconnectedCallback(): void {
    this.unsubscribe?.();
    this.clear();
    super.disconnectedCallback();
  }

  private currentKey(): string {
    return JSON.stringify([
      gateway.gatewayUrl,
      gateway.authenticatedPrincipalId,
      gateway.connectionEpoch,
      this.request,
      this.disabled,
      this.unavailable,
    ]);
  }

  protected willUpdate(): void {
    const key = this.currentKey();
    if (key !== this.selectionKey) this.clear();
    this.selectionKey = key;
  }

  private clear(): void {
    this.generation++;
    this.result = null;
    this.error = '';
    this.loading = false;
  }

  private async check(): Promise<void> {
    if (!this.request || this.disabled || this.loading || gateway.connectionState !== 'connected')
      return;
    const key = this.currentKey();
    this.selectionKey = key;
    const generation = ++this.generation;
    const current = () =>
      this.isConnected && generation === this.generation && key === this.currentKey();
    this.loading = true;
    this.result = null;
    this.error = '';
    try {
      const response = await requestDispatchPreview(this.request);
      if (!current()) return;
      const result = response.preview.recipeCompatibility;
      if (!result)
        throw new Error('This gateway has no recipe compatibility result for the selected flow.');
      this.result = result;
    } catch (error) {
      if (current()) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (current()) this.loading = false;
    }
  }

  protected render() {
    const result = this.result;
    return html`
      <section aria-label="Recipe compatibility">
        <div class="heading">
          <span>Recipe compatibility</span>
          <button
            ?disabled=${this.disabled ||
            !this.request ||
            this.loading ||
            Boolean(this.unavailable) ||
            gateway.connectionState !== 'connected'}
            @click=${this.check}
          >
            ${this.loading ? 'Checking…' : 'Check selected flow'}
          </button>
        </div>
        ${this.unavailable ? html`<p>${this.unavailable}</p>` : nothing}
        ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
        ${result
          ? html`
              <p class="badges">
                <span>${result.registered ? 'registered' : 'not registered'}</span>
                <span>${result.recipeVerified ? 'recipe-verified' : 'recipe unverified'}</span>
              </p>
              <p>
                ${result.scope.project} · ${result.scope.app ?? 'root app'} ·
                ${result.scope.domain ?? 'default domain'} · ${result.scope.adapter}
              </p>
              <code>${result.scope.target}</code>
              ${result.checked
                ? html`<p>
                    Checked revision
                    <code>${result.checked.revision ?? 'uncommitted'}</code>${result.checked
                      .dirtyDigest
                      ? html` · dirty <code>${result.checked.dirtyDigest}</code>`
                      : nothing}<br />
                    <time>${result.checked.checkedAt}</time> · ${result.checked.scope.adapter}<br /><code
                      >${result.checked.scope.target}</code
                    >
                  </p>`
                : html`<p>No recipe check recorded for this selection.</p>`}
              ${result.missingRequirements.length
                ? html`<p role="alert">Missing: ${result.missingRequirements.join(', ')}</p>`
                : html`<p>Selected requirements satisfied.</p>`}
              ${result.requirements.length
                ? html`<ul>
                    ${result.requirements.map(
                      (check) => html`<li>${check.name}: ${check.status}</li>`,
                    )}
                  </ul>`
                : nothing}
              ${(result.diagnostics ?? []).map((message) => html`<p>${message}</p>`)}
            `
          : html`<p>
              Check the selected template, target and recipe requirements before dispatch.
            </p>`}
      </section>
    `;
  }

  static styles = css`
    :host {
      display: block;
      margin: 12px 0;
      color: inherit;
      font: inherit;
    }
    section {
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 6px;
      padding: 12px;
    }
    .heading {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    button {
      font: inherit;
      color: inherit;
      background: transparent;
      border: 1px solid ${unsafeCSS(colors.textMuted)};
      border-radius: 4px;
      padding: 5px 9px;
      cursor: pointer;
    }
    button:disabled {
      cursor: default;
      opacity: 0.5;
    }
    p {
      margin: 8px 0;
    }
    code {
      overflow-wrap: anywhere;
    }
    .badges {
      display: flex;
      gap: 8px;
    }
    .badges span {
      border: 1px solid ${unsafeCSS(colors.textMuted)};
      border-radius: 4px;
      padding: 2px 6px;
    }
    [role='alert'] {
      color: ${unsafeCSS(colors.statusFail)};
    }
  `;
}
