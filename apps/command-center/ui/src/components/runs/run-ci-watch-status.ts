import { css, html, LitElement, nothing, type PropertyValues, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { Run } from '@farmslot/protocol';
import { ciWatchStatusView } from '@farmslot/review-dispatch';

import { colors, fonts } from '../../styles/theme-tokens.js';

/** One compact renderer for run cards and detail pipelines. */
@customElement('run-ci-watch-status')
export class RunCIWatchStatus extends LitElement {
  @property({ attribute: false }) run?: Run;
  @state() private nowMs = Date.now();
  private timer?: ReturnType<typeof setInterval>;

  override connectedCallback(): void {
    super.connectedCallback();
    this.updateClock();
  }

  override disconnectedCallback(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues): void {
    if (changed.has('run')) this.nowMs = Date.now();
    this.updateClock();
  }

  private updateClock(): void {
    const live = ciWatchStatusView(this.run, this.nowMs)?.live;
    if (live && this.isConnected && !this.timer)
      this.timer = setInterval(() => {
        this.nowMs = Date.now();
      }, 1000);
    if (!live && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  static styles = css`
    :host {
      display: contents;
    }
    span {
      display: block;
      flex: 1 0 100%;
      min-width: 0;
      max-width: 100%;
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
  `;

  render() {
    const view = ciWatchStatusView(this.run, this.nowMs);
    return view
      ? html`<span data-testid="ci-watch-status" title=${view.description}>${view.label}</span>`
      : nothing;
  }
}
