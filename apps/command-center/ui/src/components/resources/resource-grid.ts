// <resource-grid> — CSS grid of 1-4 stream-feed instances

import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { SlotResource } from '@farmslot/protocol';

import '../stream-feed/stream-feed.js';

import { colors, fonts } from '../../styles/theme-tokens.js';

export interface ActiveStream {
  resourceId: string;
  resource: SlotResource;
  resourceIndex: number;
}

@customElement('resource-grid')
export class ResourceGrid extends LitElement {
  @property({ type: String }) slotId = '';
  @property({ type: Array }) streams: ActiveStream[] = [];

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      background: #000;
    }

    .grid {
      display: flex;
      flex-direction: row;
      flex: 1;
      min-height: 0;
      min-width: 0;
      gap: 2px;
    }

    .stream-slot {
      flex: 1;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }

    .stream-slot stream-feed {
      flex: 1;
      min-height: 0;
    }

    .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
  `;

  render() {
    if (this.streams.length === 0) {
      return html`<div class="empty">Click a resource chip to stream</div>`;
    }

    return html`
      <div class="grid">
        ${this.streams.map(
          (s) => html`
            <div class="stream-slot">
              <stream-feed
                .slotId=${this.slotId}
                .platform=${s.resource.definition.platform ?? ''}
                .resourceId=${s.resourceId}
                .resourceIndex=${s.resourceIndex}
              ></stream-feed>
            </div>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'resource-grid': ResourceGrid;
  }
}
