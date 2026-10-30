import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { Run, TaskProgressStructured } from '@farmslot/protocol';
import { runChecklistProgressView } from '@farmslot/review-dispatch';
import { publicationGateCssVariables } from '@farmslot/theme';

/** The same checklist strip beneath the list pipeline and the detail canvas. */
@customElement('run-checklist-progress')
export class RunChecklistProgress extends LitElement {
  @property({ attribute: false }) run?: Run;
  @property({ attribute: false }) progress?: TaskProgressStructured | null;
  @property() error?: string;
  @property({ type: Boolean }) stale = false;
  @property() age = '';

  static styles = css`
    :host {
      ${unsafeCSS(publicationGateCssVariables('dark', 'checklist'))}
      display: block;
      min-width: 0;
      height: 28px;
      width: 100%;
    }
    @media (prefers-color-scheme: light) {
      :host {
        ${unsafeCSS(publicationGateCssVariables('light', 'checklist'))}
      }
    }
    :host-context([data-theme='light']) {
      ${unsafeCSS(publicationGateCssVariables('light', 'checklist'))}
    }
    :host-context([data-theme='dark']) {
      ${unsafeCSS(publicationGateCssVariables('dark', 'checklist'))}
    }
    .strip {
      background: var(--checklist-background);
      border-radius: 2px;
      padding: 0 2px;
    }
    .label {
      display: flex;
      gap: 6px;
      font-size: 11px;
      line-height: 18px;
      color: var(--checklist-secondary);
    }
    .counts {
      flex: none;
      font-variant-numeric: tabular-nums;
    }
    .item {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .track {
      height: 2px;
      border-radius: 2px;
      overflow: hidden;
      background: var(--checklist-border);
    }
    .fill {
      height: 100%;
      background: var(--checklist-accent);
    }
  `;

  render() {
    const view = this.run && runChecklistProgressView(this.run, this.progress);
    if (!view)
      return this.error
        ? html`<div class="label" role="status" title=${this.error}>
            Checklist unavailable: ${this.error}
          </div>`
        : nothing;
    return html`
      <div class="strip" title=${this.error || view.accessibleLabel}>
        <div class="label">
          <span class="counts">${view.counts}</span>
          <span class="item" role=${this.error && !this.stale ? 'status' : nothing}>
            ${this.stale ? `Saved checklist, ${this.age}` : this.error || view.label}
          </span>
        </div>
        <div
          class="track"
          role="progressbar"
          aria-label=${view.accessibleLabel}
          aria-valuemin="0"
          aria-valuemax=${view.total}
          aria-valuenow=${view.completed}
        >
          <div class="fill" style=${`width: ${view.percent}%`}></div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'run-checklist-progress': RunChecklistProgress;
  }
}
