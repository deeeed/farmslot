import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { type SkeletonKind, skeletonTokens } from '@farmslot/theme';

/** Each panel composes these shapes into its own loading layout. */
@customElement('farm-skeleton')
export class FarmSkeleton extends LitElement {
  @property({ reflect: true }) kind: SkeletonKind = 'line';
  @property() width = '100%';
  @property({ type: Number }) height?: number;

  static styles = css`
    :host {
      display: block;
      flex-shrink: 0;
      max-width: 100%;
    }
    span {
      display: block;
      max-width: 100%;
      border-radius: ${unsafeCSS(skeletonTokens.radius)}px;
      background: ${unsafeCSS(skeletonTokens.colors.dark)};
    }
    :host([kind='avatar']) span {
      border-radius: 50%;
    }
    @media (prefers-color-scheme: light) {
      span {
        background: ${unsafeCSS(skeletonTokens.colors.light)};
      }
    }
  `;

  render() {
    return html`<span
      aria-hidden="true"
      style=${`width:${this.kind === 'avatar' && this.width === '100%' ? '40px' : this.width};height:${this.height ?? skeletonTokens.heights[this.kind]}px`}
    ></span>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'farm-skeleton': FarmSkeleton;
  }
}
