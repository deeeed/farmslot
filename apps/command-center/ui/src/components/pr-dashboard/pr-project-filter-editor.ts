import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  assertPRRulePredicate,
  type PRImportedProjectView,
  type PRProjectCatalog,
  type PRRulePredicate,
} from '@farmslot/protocol';

import { prAutomationStyles } from './pr-automation-styles.js';
import { defaultPRPredicate } from './pr-predicate-editor.js';

@customElement('pr-project-filter-editor')
export class PRProjectFilterEditor extends LitElement {
  @property({ attribute: false }) value?: PRImportedProjectView;
  @property({ attribute: false }) catalogs: PRProjectCatalog[] = [];
  @property({ type: Boolean }) disabled = false;
  @state() private editing?: number;
  @state() private predicate: PRRulePredicate = defaultPRPredicate();
  @state() private error = '';
  static styles = prAutomationStyles;
  protected willUpdate(changes: PropertyValues<this>) {
    if (changes.has('value')) {
      this.editing = undefined;
      this.error = '';
    }
  }
  render() {
    const view = this.value;
    if (!view) return nothing;
    return html`<fieldset ?disabled=${this.disabled}>
      <h3>Imported view: ${view.name}</h3>
      <p><code>${view.filter || 'No view filters'}</code></p>
      <p class="muted">
        These filters restrict this Project source. They are a snapshot; re-import to use later
        changes to the saved view.
      </p>
      ${view.terms.map(
        (term, index) =>
          html`<section>
            <p>
              <code>${term.text}</code> ·
              ${term.kind === 'unmapped'
                ? 'Needs mapping'
                : term.kind === 'constant'
                  ? term.value
                    ? 'Includes PR items'
                    : 'Excludes PR items'
                  : term.manuallyMapped
                    ? 'Explicit mapping'
                    : 'Mapped'}
            </p>
            ${term.kind === 'unmapped'
              ? html`<p class="attention">
                  ${term.reason}. This source cannot be enabled until the term is mapped.
                </p>`
              : term.kind === 'predicate'
                ? html`<pr-predicate-editor
                    .value=${term.predicate}
                    .catalogs=${this.catalogs}
                    .disabled=${true}
                  ></pr-predicate-editor>`
                : nothing}
            <button
              type="button"
              data-map-term=${index}
              @click=${() => {
                this.editing = index;
                this.predicate =
                  term.kind === 'predicate'
                    ? structuredClone(term.predicate)
                    : defaultPRPredicate();
                this.error = '';
              }}
            >
              Map term
            </button>
            ${this.editing === index
              ? html`<pr-predicate-editor
                    .value=${this.predicate}
                    .catalogs=${this.catalogs}
                    .disabled=${this.disabled}
                    @predicate-change=${(event: CustomEvent<PRRulePredicate>) => {
                      event.stopPropagation();
                      this.predicate = event.detail;
                    }}
                  ></pr-predicate-editor>
                  <button
                    type="button"
                    data-testid="pr-project-mapping-apply"
                    @click=${() => {
                      try {
                        assertPRRulePredicate(this.predicate);
                      } catch (error) {
                        this.error = error instanceof Error ? error.message : String(error);
                        return;
                      }
                      this.dispatchEvent(
                        new CustomEvent('view-filter-change', {
                          detail: {
                            ...view,
                            terms: view.terms.map((entry, i) =>
                              i === index
                                ? {
                                    text: entry.text,
                                    kind: 'predicate',
                                    predicate: this.predicate,
                                    manuallyMapped: true,
                                  }
                                : entry,
                            ),
                          },
                          bubbles: true,
                          composed: true,
                        }),
                      );
                      this.editing = undefined;
                    }}
                  >
                    Apply explicit mapping</button
                  ><button
                    type="button"
                    @click=${() => {
                      this.editing = undefined;
                    }}
                  >
                    Cancel mapping
                  </button>`
              : nothing}
          </section>`,
      )}
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
    </fieldset>`;
  }
}
