import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  normalizeRunLinkedTicketRefs,
  normalizeRunTags,
  parseRunLinkedTicketRefs,
  type Run,
  runLinkedTicketsView,
} from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

@customElement('run-tag-editor')
export class RunTagEditor extends LitElement {
  static styles = css`
    :host {
      display: block;
    }
    .tag-row,
    .tag-editor {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 5px;
      min-width: 0;
    }
    .tag-label {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .tag-pill {
      border: 1px solid ${unsafeCSS(colors.accent)}66;
      background: ${unsafeCSS(colors.accent)}12;
      color: ${unsafeCSS(colors.accent)};
      border-radius: 999px;
      padding: 2px 7px;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
    }
    .tag-pill:hover {
      background: ${unsafeCSS(colors.accent)}22;
    }
    .tag-empty {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 10px;
    }
    .tag-manage,
    .tag-save,
    .tag-cancel {
      border: 1px solid ${unsafeCSS(colors.textMuted)}44;
      background: transparent;
      color: ${unsafeCSS(colors.textSecondary)};
      border-radius: ${unsafeCSS(radii.sm)};
      padding: 2px 7px;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
    }
    .tag-manage:hover,
    .tag-cancel:hover {
      border-color: ${unsafeCSS(colors.textSecondary)}66;
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .tag-save {
      border-color: ${unsafeCSS(colors.accent)}66;
      color: ${unsafeCSS(colors.accent)};
    }
    .tag-save:hover {
      background: ${unsafeCSS(colors.accent)}14;
    }
    .tag-manage:disabled,
    .tag-save:disabled,
    .tag-cancel:disabled,
    .tag-input:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .tag-input {
      min-width: 170px;
      flex: 1 1 220px;
      border: 1px solid ${unsafeCSS(colors.textMuted)}44;
      border-radius: ${unsafeCSS(radii.sm)};
      background: ${unsafeCSS(colors.bgSurface)};
      color: ${unsafeCSS(colors.textPrimary)};
      padding: 4px 8px;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 11px;
    }
    .tag-input:focus {
      outline: none;
      border-color: ${unsafeCSS(colors.accent)}99;
    }
    :host([kind='tickets']) .tag-pill,
    :host([kind='tickets']) .tag-manage,
    :host([kind='tickets']) .tag-save,
    :host([kind='tickets']) .tag-cancel,
    :host([kind='tickets']) .tag-input {
      min-height: 44px;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      text-decoration: none;
    }
    .tag-error {
      flex-basis: 100%;
      color: ${unsafeCSS(colors.statusFail)};
      font-size: 10px;
      padding-left: calc(${unsafeCSS(spacing.sm)} + 26px);
    }
    .ticket-line {
      white-space: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
      font: inherit;
      color: ${unsafeCSS(colors.textSecondary)};
    }
    .ticket-line a {
      color: ${unsafeCSS(colors.accent)};
      text-decoration: none;
    }
    .ticket-line a:hover {
      text-decoration: underline;
    }
  `;

  @property({ reflect: true }) kind: 'tags' | 'tickets' = 'tags';
  @property({ type: Boolean }) compact = false;
  @property({ attribute: false }) run?: Run;
  @property({ attribute: false }) tags: readonly string[] = [];
  @property({ type: Boolean }) disabled = false;
  @property({ attribute: false }) saveTags?: (tags: string[]) => void | Promise<void>;
  @property({ attribute: false }) filterTag?: (tag: string) => void;

  @state() private editing = false;
  @state() private draft = '';
  @state() private saving = false;
  @state() private error = '';

  private normalizedTags(): string[] {
    return this.kind === 'tickets'
      ? normalizeRunLinkedTicketRefs(this.run?.linkedTicketRefs ?? [])
      : normalizeRunTags(this.tags);
  }

  private beginEdit() {
    if (this.disabled || !this.saveTags) return;
    this.draft = this.normalizedTags().join(', ');
    this.error = '';
    this.editing = true;
  }

  private cancelEdit() {
    if (this.saving) return;
    this.editing = false;
    this.draft = '';
    this.error = '';
  }

  private async saveEdit() {
    if (this.disabled || this.saving || !this.saveTags) return;
    this.saving = true;
    this.error = '';
    try {
      const tags =
        this.kind === 'tickets'
          ? parseRunLinkedTicketRefs(this.draft)
          : normalizeRunTags(this.draft.split(','));
      await this.saveTags(tags);
      this.editing = false;
      this.draft = '';
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.saving = false;
    }
  }

  render() {
    const tags = this.normalizedTags();
    const tickets = this.kind === 'tickets' && this.run ? runLinkedTicketsView(this.run) : null;
    if (this.compact && tickets)
      return html`<div
        class="ticket-line"
        aria-label="Run source and covered tickets"
        @click=${(e: Event) => e.stopPropagation()}
      >
        ${tickets.references.map(
          (reference, index) =>
            html`${index ? ', ' : ''}${reference.url
              ? html`<a href=${reference.url} target="_blank" rel="noopener noreferrer"
                  >${reference.ref}</a
                >`
              : reference.ref}`,
        )}
      </div>`;
    if (tickets && !tickets.tickets.length && !this.saveTags) return nothing;
    if (this.editing) {
      return html`
        <form
          class="tag-editor"
          @click=${(e: Event) => e.stopPropagation()}
          @submit=${(e: Event) => {
            e.preventDefault();
            void this.saveEdit();
          }}
        >
          <label class="tag-label" for="tag-editor-input"
            >${tickets ? 'Additional tickets' : 'Tags'}</label
          >
          <input
            id="tag-editor-input"
            class="tag-input"
            placeholder=${tickets ? 'TEAM-123, TEAM-456' : 'demo, onboarding'}
            .value=${this.draft}
            ?disabled=${this.saving}
            @input=${(e: Event) => {
              this.draft = (e.target as HTMLInputElement).value;
              this.error = '';
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                this.cancelEdit();
              }
            }}
          />
          <button class="tag-save" type="submit" ?disabled=${this.saving}>
            ${this.saving ? 'Saving…' : 'Save'}
          </button>
          <button
            class="tag-cancel"
            type="button"
            ?disabled=${this.saving}
            @click=${this.cancelEdit}
          >
            Cancel
          </button>
          ${this.error ? html`<span class="tag-error">${this.error}</span>` : nothing}
        </form>
      `;
    }

    return html`
      <div class="tag-row" @click=${(e: Event) => e.stopPropagation()}>
        <span class="tag-label">${tickets ? 'Tickets' : 'Tags'}</span>
        ${tickets
          ? html`${tickets.tickets.map((ticket) =>
              ticket.url
                ? html`<a
                    class="tag-pill"
                    href=${ticket.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    >${ticket.ref}</a
                  >`
                : html`<span class="tag-pill">${ticket.ref}</span>`,
            )}
            }`
          : tags.length
            ? tags.map(
                (tag) => html`
                  <button
                    class="tag-pill"
                    title="Filter by tag ${tag}"
                    @click=${() => this.filterTag?.(tag)}
                  >
                    #${tag}
                  </button>
                `,
              )
            : html`<span class="tag-empty">none</span>`}
        ${this.saveTags
          ? html`<button class="tag-manage" ?disabled=${this.disabled} @click=${this.beginEdit}>
              ${tags.length ? 'Manage' : '+ Add'}
            </button>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'run-tag-editor': RunTagEditor;
  }
}
