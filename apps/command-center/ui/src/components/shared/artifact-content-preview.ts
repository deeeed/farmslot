import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { readVerifiedArtifactPreview } from '../../artifact-response.js';
import { getResourceWorkspaceKey, subscribeResourceCache } from '../../resource-cache.js';
import { colors } from '../../styles/theme-tokens.js';

import { artifactContentPreviewWindow } from './artifact-content-search-model.js';

@customElement('artifact-content-preview')
export class ArtifactContentPreview extends LitElement {
  @property() url = '';
  @property() path = '';
  @property() sha256 = '';
  @property({ type: Number }) line = 1;
  @state() private text?: string;
  @state() private error = '';
  private abort?: AbortController;
  private stop?: () => void;
  private owner?: string;
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      min-width: 0;
      height: 100%;
      color: inherit;
      font: inherit;
    }
    header {
      padding: 8px;
      overflow-wrap: anywhere;
      border-bottom: 1px solid ${unsafeCSS(colors.bgCardHover)};
    }
    pre {
      margin: 0;
      overflow: auto;
      flex: 1;
      font: inherit;
      font-size: 12px;
    }
    .line {
      display: block;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      padding: 1px 8px;
    }
    .line.active {
      background: ${unsafeCSS(colors.statusWarn)}22;
      outline: 1px solid ${unsafeCSS(colors.statusWarn)};
    }
    .number {
      display: inline-block;
      min-width: 4em;
      color: ${unsafeCSS(colors.textMuted)};
      user-select: none;
    }
    p {
      padding: 8px;
      color: ${unsafeCSS(colors.textMuted)};
    }
  `;
  connectedCallback() {
    super.connectedCallback();
    this.owner = getResourceWorkspaceKey();
    this.stop = subscribeResourceCache(() => {
      const owner = getResourceWorkspaceKey();
      if (owner !== this.owner) {
        this.owner = owner;
        void this.load();
      }
    });
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.abort?.abort();
    this.stop?.();
  }
  protected updated(changed: Map<string, unknown>) {
    if (changed.has('url') || changed.has('sha256')) void this.load();
    if (changed.has('line') || changed.has('text'))
      this.renderRoot.querySelector('.active')?.scrollIntoView({ block: 'center' });
  }
  private async load() {
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    const owner = this.owner;
    const url = this.url;
    const sha256 = this.sha256;
    this.text = undefined;
    this.error = '';
    if (!this.url || !owner) return;
    if (!/^[a-f0-9]{64}$/.test(this.sha256)) {
      this.error = 'File identity unavailable; search again.';
      return;
    }
    try {
      const bytes = await readVerifiedArtifactPreview(url, sha256, abort.signal);
      if (
        abort.signal.aborted ||
        owner !== getResourceWorkspaceKey() ||
        url !== this.url ||
        sha256 !== this.sha256
      )
        return;
      this.text = new TextDecoder().decode(bytes);
    } catch (error) {
      if (!abort.signal.aborted && owner === getResourceWorkspaceKey())
        this.error = error instanceof Error ? error.message : 'File unavailable.';
    }
  }
  render() {
    const window =
      this.text === undefined ? undefined : artifactContentPreviewWindow(this.text, this.line);
    return html`<header>
        ${this.path} · line
        ${this.line}${window && window.totalLines > window.lines.length
          ? ` · showing ${window.firstLine}–${window.firstLine + window.lines.length - 1} of ${window.totalLines}`
          : ''}
      </header>
      ${this.error
        ? html`<p role="status">${this.error}</p>`
        : this.text === undefined
          ? html`<p>Loading file…</p>`
          : html`<pre aria-label="File contents">
${window!.lines.map(
                (line, index) =>
                  html`<span class="line ${window!.firstLine + index === this.line ? 'active' : ''}"
                    ><span class="number">${window!.firstLine + index}</span>${line || ' '}</span
                  >`,
              )}</pre
            >`}${nothing}`;
  }
}
