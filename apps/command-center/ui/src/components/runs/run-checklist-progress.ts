import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { RunListRow, TaskProgressStructured } from '@farmslot/protocol';
import { runChecklistProgressSummary, runChecklistProgressView } from '@farmslot/review-dispatch';
import { publicationGateCssVariables } from '@farmslot/theme';

import '../shared/progress-read-status.js';

import { subtaskPresentation } from '../progress-tracker/subtask-block.js';

/** The same checklist strip beneath the list pipeline and the detail canvas. */
@customElement('run-checklist-progress')
export class RunChecklistProgress extends LitElement {
  @property({ attribute: false }) run?: RunListRow;
  @property({ attribute: false }) progress?: TaskProgressStructured | null;
  @property() error?: string;
  @property({ attribute: false }) acknowledgedAt?: string;
  @property({ attribute: false }) retry?: () => void;
  @property({ type: Boolean }) stale = false;
  /** Detail only; list strips keep their single parent row. */
  @property({ type: Boolean }) showSubtasks = false;

  static styles = css`
    :host {
      ${unsafeCSS(publicationGateCssVariables('dark', 'checklist'))}
      display: block;
      min-width: 0;
      min-height: 28px;
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
    .acknowledgement {
      color: var(--checklist-secondary);
      font-size: 11px;
      line-height: 18px;
      padding: 0 2px;
      font-variant-numeric: tabular-nums;
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
    .child {
      margin: 4px 0 0 16px;
      padding-left: 8px;
      border-left: 2px solid var(--checklist-accent);
      min-width: 0;
    }
    .child-title {
      color: var(--checklist-secondary);
      font-size: 11px;
      display: flex;
      gap: 6px;
      min-width: 0;
      line-height: 18px;
    }
    .child-status {
      flex: none;
    }
    .fill {
      height: 100%;
      background: var(--checklist-accent);
    }
  `;

  render() {
    const view = this.run && runChecklistProgressView(this.run, this.progress);
    const subtask = this.showSubtasks ? view?.subtask : undefined;
    const child = subtask && runChecklistProgressSummary(subtask.progress);
    const presentation = subtask && subtaskPresentation(subtask);
    const childTitle = subtask?.progress.schema.title || presentation?.title;
    if (!view && !this.error && !this.acknowledgedAt) return nothing;
    return html`
      ${this.acknowledgedAt
        ? html`<div class="acknowledgement" data-testid="worker-acknowledged">
            Worker acknowledged
            <time datetime=${this.acknowledgedAt} title=${this.acknowledgedAt}>
              ${new Date(this.acknowledgedAt).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
              })}
            </time>
          </div>`
        : nothing}
      ${this.error
        ? html`<progress-read-status
            .notice=${{ kind: 'error', text: this.error }}
            .retry=${this.retry}
          ></progress-read-status>`
        : view
          ? html`<div class="strip" title=${view.accessibleLabel}>
                <div class="label">
                  <span class="counts">${view.counts}</span>
                  <span class="item"> ${this.stale ? 'Saved progress' : view.label} </span>
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
              ${child && presentation
                ? html`<div class="child" data-testid="checklist-child-progress">
                    <div class="child-title" title=${presentation.titleTooltip}>
                      <span aria-hidden="true">↳</span>
                      <span class="item">${childTitle}</span>
                      <span class="child-status" title=${presentation.statusTooltip}
                        >${presentation.statusLabel}</span
                      >
                    </div>
                    <div class="label">
                      <span class="counts">${child.counts}</span>
                      <span class="item" title=${child.label}
                        >${this.stale ? 'Saved child progress' : child.label}</span
                      >
                    </div>
                    <div
                      class="track"
                      role="progressbar"
                      aria-label=${`Child ${childTitle}: ${child.accessibleLabel}`}
                      aria-valuemin="0"
                      aria-valuemax=${child.total}
                      aria-valuenow=${child.completed}
                    >
                      <div class="fill" style=${`width: ${child.percent}%`}></div>
                    </div>
                  </div>`
                : nothing}`
          : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'run-checklist-progress': RunChecklistProgress;
  }
}
