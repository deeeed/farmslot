import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { Methods, type RunArtifactSearchResult } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { colors } from '../../styles/theme-tokens.js';
import { gatewayHttpOrigin } from '../../utils/gateway-origin.js';

import { artifactContentSearchParams } from './artifact-content-search-model.js';
import { ResourceQueryController } from './resource-query-controller.js';

@customElement('artifact-content-search')
export class ArtifactContentSearch extends LitElement {
  @property({ attribute: false }) links: string[] = [];
  @property() query = '';
  @state() private draft = '';
  private readonly search = new ResourceQueryController<RunArtifactSearchResult>(this);
  static styles = css`
    :host {
      display: block;
      padding: 8px;
      font: inherit;
      color: inherit;
    }
    form {
      display: flex;
      gap: 6px;
      margin-bottom: 10px;
    }
    input {
      min-width: 0;
      flex: 1;
    }
    input,
    button {
      font: inherit;
      color: inherit;
      background: ${unsafeCSS(colors.bgCard)};
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 4px;
      padding: 6px;
    }
    .hit {
      display: block;
      width: 100%;
      text-align: left;
      margin: 4px 0;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    p {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 12px;
    }
    h4 {
      overflow-wrap: anywhere;
      margin: 12px 0 4px;
    }
  `;
  protected willUpdate(changed: Map<string, unknown>) {
    if (changed.has('query')) this.draft = this.query;
    const params = this.query.trim()
      ? artifactContentSearchParams(this.query, this.links, gatewayHttpOrigin())
      : undefined;
    this.search.setQuery(
      params
        ? resourceQuery<RunArtifactSearchResult>(Methods.RUN_SEARCH_ARTIFACTS, params)
        : undefined,
    );
  }
  private submit(event: Event) {
    event.preventDefault();
    this.dispatchEvent(
      new CustomEvent('content-search-query', {
        detail: { query: this.draft.trim() },
        bubbles: true,
        composed: true,
      }),
    );
    if (this.draft.trim() === this.query) void this.search.retry();
  }
  render() {
    const params = artifactContentSearchParams(this.query, this.links, gatewayHttpOrigin());
    const state = this.search.state;
    const result = state.data;
    return html`<form @submit=${(event: Event) => this.submit(event)}>
        <input
          type="search"
          aria-label="Search file contents"
          placeholder="Search inside text files"
          maxlength="200"
          .value=${this.draft}
          @input=${(e: Event) => {
            this.draft = (e.target as HTMLInputElement).value;
          }}
        />
        <button type="submit" ?disabled=${!this.draft.trim()}>Search</button>
      </form>
      ${!params
        ? html`<p>
            ${this.links.length
              ? 'Search text files from one saved artifact group.'
              : 'No files match the path/type filters.'}
          </p>`
        : !this.query.trim()
          ? html`<p>Search logs, Markdown and JSON.</p>`
          : !result
            ? html`<p role="status">
                ${state.error ? `Search unavailable: ${state.error.message}` : 'Searching…'}
              </p>`
            : html`
                <p role="status">
                  ${result.searchedFiles} text files
                  searched${result.partial
                    ? ` · Incomplete search${result.skippedFiles ? `, ${result.skippedFiles} files skipped` : ', results limited'}`
                    : ''}${state.status !== 'ready' ? ' · Saved results' : ''}
                </p>
                ${result.files.length
                  ? result.files.map(
                      (file) =>
                        html`<section>
                          <h4>${file.path}</h4>
                          ${file.hits.map(
                            (hit) => html`
                              <button
                                class="hit"
                                @click=${() =>
                                  this.dispatchEvent(
                                    new CustomEvent('content-search-open', {
                                      detail: {
                                        path: file.path,
                                        line: hit.line,
                                        sha256: file.sha256,
                                        bundleDigest: result.bundleDigest,
                                      },
                                      bubbles: true,
                                      composed: true,
                                    }),
                                  )}
                              >
                                ${hit.line}: ${hit.text}
                              </button>
                            `,
                          )}
                        </section>`,
                    )
                  : html`<p>No content matches.</p>`}
              `} `;
  }
}
