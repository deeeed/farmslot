import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import { type Clip, type ClipListResult, clipTextParts, Methods } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { getResourceNativeOwnerId, subscribeResourceCache } from '../../resource-cache.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { ResourceQueryController } from '../shared/resource-query-controller.js';

/** Clips that agents pushed with `farmslot clip`, newest first, each with a Copy button. */
@customElement('clipboard-panel')
export class ClipboardPanel extends LitElement {
  @state() private copiedId = '';
  @state() private copyError = '';

  private readonly query = new ResourceQueryController<ClipListResult>(this);
  private stopOwner?: () => void;
  private copiedTimer?: ReturnType<typeof setTimeout>;

  connectedCallback(): void {
    super.connectedCallback();
    this.stopOwner = subscribeResourceCache(() => this.bindQuery());
    this.bindQuery();
  }

  disconnectedCallback(): void {
    this.stopOwner?.();
    clearTimeout(this.copiedTimer);
    super.disconnectedCallback();
  }

  private bindQuery(): void {
    const owner = getResourceNativeOwnerId();
    this.query.setQuery(
      owner ? resourceQuery<ClipListResult>(Methods.CLIP_LIST, {}, owner) : undefined,
    );
  }

  private async copy(clip: Clip): Promise<void> {
    try {
      await navigator.clipboard.writeText(clip.text);
    } catch (error) {
      // Shown beside the list: the browser refused clipboard access (permission or focus).
      this.copyError = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    this.copyError = '';
    this.copiedId = clip.id;
    clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => (this.copiedId = ''), 1500);
  }

  private renderText(text: string) {
    return clipTextParts(text).map((part) =>
      part.url
        ? html`<a href=${part.url} target="_blank" rel="noopener noreferrer">${part.text}</a>`
        : part.text,
    );
  }

  private renderClip(clip: Clip) {
    const host = clip.kind === 'link' ? new URL(clip.text).host : '';
    return html`<li class="clip" data-clip-id=${clip.id}>
      <div class="clip-head">
        <span class="label">${clip.label ?? (clip.kind === 'link' ? host : 'Clip')}</span>
        <span class="meta"
          >${clip.kind === 'link' && clip.label ? `${host} · ` : ''}${clip.source
            ? `${clip.source} · `
            : ''}${new Date(clip.createdAt).toLocaleString()}</span
        >
        <button class="copy" data-testid="clip-copy" @click=${() => void this.copy(clip)}>
          ${this.copiedId === clip.id ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre class="text">${this.renderText(clip.text)}</pre>
    </li>`;
  }

  render() {
    const { state } = this.query;
    const clips = state.data?.clips ?? [];
    return html`<section>
      <h2>Clipboard</h2>
      <p class="hint">Text and links agents sent with <code>farmslot clip</code>. Last 20.</p>
      ${state.error ? html`<p class="error">${state.error.message}</p>` : nothing}
      ${this.copyError ? html`<p class="error">${this.copyError}</p>` : nothing}
      ${state.status === 'loading' && !state.data
        ? html`<p class="hint">Loading clips…</p>`
        : clips.length === 0
          ? html`<p class="hint">No clips yet.</p>`
          : html`<ul>
              ${clips.map((clip) => this.renderClip(clip))}
            </ul>`}
    </section>`;
  }

  static styles = css`
    :host {
      display: block;
      padding: ${unsafeCSS(spacing.xl)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: ${unsafeCSS(fonts.mono)};
      overflow: auto;
    }
    h2 {
      margin: 0 0 ${unsafeCSS(spacing.sm)};
      font-size: ${unsafeCSS(fonts.sizeXl)};
    }
    .hint {
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .error {
      color: ${unsafeCSS(colors.statusFail)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: ${unsafeCSS(spacing.lg)};
      max-width: 960px;
    }
    .clip {
      background: ${unsafeCSS(colors.bgCard)};
      border-radius: ${unsafeCSS(radii.md)};
      padding: ${unsafeCSS(spacing.lg)};
    }
    .clip-head {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
    }
    .label {
      font-weight: 600;
    }
    .meta {
      flex: 1;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    .copy {
      background: ${unsafeCSS(colors.accent)};
      color: ${unsafeCSS(colors.textPrimary)};
      border: none;
      border-radius: ${unsafeCSS(radii.sm)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.lg)};
      font-family: inherit;
      cursor: pointer;
    }
    .text {
      margin: ${unsafeCSS(spacing.md)} 0 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: ${unsafeCSS(fonts.sizeSm)};
      max-height: 240px;
      overflow: auto;
    }
    a {
      color: ${unsafeCSS(colors.accentHover)};
    }
  `;
}
