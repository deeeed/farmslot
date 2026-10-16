import { html, LitElement } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type { PublicationGateClaim } from '@farmslot/review-dispatch';

import { renderFleetSkeleton } from '../components/fleet-map/fleet-skeleton.js';
import { renderPrBoardSkeleton } from '../components/pr-dashboard/pr-board-skeleton.js';
import { renderRunDetailSkeleton } from '../components/runs/run-detail-renderers.js';
import { renderRunListSkeleton } from '../components/runs/run-list-skeleton.js';
import { renderSlotFilesSkeleton } from '../components/slot-view/slot-view-panel-renderers.js';
import {
  publicationGatePanelStyles,
  renderPublicationGatePanel,
  renderPublicationGateSkeleton,
} from '../components/workspace/publication-gate-panel.js';

const claims: PublicationGateClaim[] = [
  { id: 'AC-1', text: 'The chart shows the order control at the selected price.', status: null },
  { id: 'AC-2', text: 'Selecting the control opens the order form at that price.', status: null },
  { id: 'AC-3', text: 'The order retains its price when switching display options.', status: null },
  { id: 'AC-4', text: 'Open orders appear on the chart at their retained price.', status: null },
];

/** Manual state story. Transitions use buttons; no application-store injection. */
@customElement('async-section-fixtures')
export class AsyncSectionFixtures extends LitElement {
  @state() private phase: 'loading' | 'loaded' | 'error' = 'loading';

  protected override createRenderRoot() {
    return this;
  }

  render() {
    const error = this.phase === 'error' ? 'Evidence read failed' : '';
    const retry = () => {
      this.phase = 'loading';
    };
    return html`<style>
        ${publicationGatePanelStyles('.async-gate')} .async-story {
          max-width: 1200px;
          margin: 0 auto;
          padding: 16px;
          color: var(--color-text-primary, #e0e0e8);
        }
        .async-story-controls {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          min-height: 44px;
          margin-bottom: 16px;
        }
        .async-story-controls button {
          min-height: 44px;
          min-width: 44px;
          padding: 8px 16px;
          font: inherit;
          background: var(--color-bg-surface, #12121a);
          color: inherit;
          border: 1px solid #8888a0;
          border-radius: 6px;
          cursor: pointer;
        }
        .async-story h2 {
          margin: 20px 0 12px;
          font-size: 16px;
        }
      </style>
      <main class="async-story" data-phase=${this.phase}>
        <nav class="async-story-controls" aria-label="Loading story states">
          ${(['loading', 'loaded', 'error'] as const).map(
            (phase) =>
              html`<button
                data-phase-choice=${phase}
                aria-pressed=${String(this.phase === phase)}
                @click=${() => {
                  this.phase = phase;
                }}
              >
                ${phase}
              </button>`,
          )}
        </nav>
        <div class="async-gate" data-testid="gate-layout-frame">
          ${this.phase !== 'loaded'
            ? renderPublicationGateSkeleton(claims.length, error, retry)
            : renderPublicationGatePanel({
                actions: [
                  { id: 'approve-publish', label: 'Approve publish', style: 'primary' },
                  { id: 'hold', label: 'Hold', style: 'secondary' },
                ],
                claims,
                busy: false,
                pendingConfirm: null,
                reviewDisabled: false,
                changeReason: () => undefined,
                chooseAttestation: () => undefined,
                invoke: () => undefined,
                requestReview: () => undefined,
              })}
        </div>
        <h2 data-testid="gate-layout-anchor">Package and evidence</h2>
        <h2>Run details</h2>
        ${renderRunDetailSkeleton(error)}
        <h2>Run inventory</h2>
        ${renderRunListSkeleton(error, retry)}
        <h2>Fleet</h2>
        ${renderFleetSkeleton(error, retry)}
        <h2>Workspace files</h2>
        ${renderSlotFilesSkeleton(error, retry)}
        <h2>Pull requests</h2>
        ${renderPrBoardSkeleton(false, error, retry)}
      </main>`;
  }
}
