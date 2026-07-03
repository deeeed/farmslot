import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { Run } from '@farmslot/protocol';

import '../runs/run-pipeline-mini.js';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { routeForRun, runStatusColor } from '../runs/run-utils.js';

@customElement('linked-run-summary')
export class LinkedRunSummary extends LitElement {
  @property({ attribute: false }) run?: Run;
  @property() label = 'Linked run';
  @property({ type: Boolean }) compact = false;

  static styles = css`
    :host {
      display: block;
      min-width: 0;
    }

    .summary {
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: ${unsafeCSS(radii.md)};
      background: ${unsafeCSS(colors.bgInput)};
      display: grid;
      gap: ${unsafeCSS(spacing.sm)};
      min-width: 0;
      padding: ${unsafeCSS(spacing.sm)};
    }

    .summary.compact {
      gap: 6px;
      padding: 8px;
    }

    .head,
    .meta {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }

    .label {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 10px;
      text-transform: uppercase;
    }

    .status {
      border: 1px solid currentColor;
      border-radius: 999px;
      font-size: 10px;
      line-height: 1.2;
      padding: 2px 6px;
    }

    .run-id,
    .meta {
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }

    .run-id {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .spacer {
      flex: 1 1 auto;
      min-width: 12px;
    }

    a {
      border: 1px solid ${unsafeCSS(colors.accent)}55;
      border-radius: ${unsafeCSS(radii.sm)};
      color: ${unsafeCSS(colors.accent)};
      font-size: 11px;
      padding: 4px 7px;
      text-decoration: none;
    }

    a:hover {
      background: ${unsafeCSS(colors.accent)}14;
      border-color: ${unsafeCSS(colors.accent)};
    }

    run-pipeline-mini {
      max-width: 100%;
      min-width: 0;
    }
  `;

  render() {
    const run = this.run;
    if (!run) return nothing;
    const engine = [run.metrics?.runner, run.metrics?.model].filter(Boolean).join('/');
    const meta = [run.project, run.slotId, engine].filter(Boolean).join(' · ');
    return html`<div class="summary ${this.compact ? 'compact' : ''}">
      <div class="head">
        <span class="label">${this.label}</span>
        <span class="status" style="color:${runStatusColor(run.status)}">${run.status}</span>
        <span class="run-id" title=${run.id}>${run.id.slice(0, 8)}</span>
        <span class="spacer"></span>
        <a href=${`#${routeForRun(run)}`}>Open run</a>
      </div>
      <run-pipeline-mini .run=${run} .steps=${run.steps ?? []} .flowType=${run.flowType}>
      </run-pipeline-mini>
      ${this.compact || !meta ? nothing : html`<div class="meta">${meta}</div>`}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'linked-run-summary': LinkedRunSummary;
  }
}
