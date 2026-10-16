import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { ReadyGatePayload, RunDecision } from '@farmslot/protocol';
import type { PublicationGateClaim } from '@farmslot/review-dispatch';

import '../components/workspace/ready-workspace.js';

import { renderFleetSkeleton } from '../components/fleet-map/fleet-skeleton.js';
import { renderPrBoardSkeleton } from '../components/pr-dashboard/pr-board-skeleton.js';
import { renderRunDetailSkeleton } from '../components/runs/run-detail-renderers.js';
import { renderRunListSkeleton } from '../components/runs/run-list-skeleton.js';
import { renderSlotFilesSkeleton } from '../components/slot-view/slot-view-panel-renderers.js';
import {
  publicationGatePanelStyles,
  renderPublicationGatePanel,
} from '../components/workspace/publication-gate-panel.js';

const claims: PublicationGateClaim[] = [
  { id: 'AC-1', text: 'The chart shows the order control at the selected price.', status: null },
  { id: 'AC-2', text: 'Selecting the control opens the order form at that price.', status: null },
  { id: 'AC-3', text: 'The order retains its price when switching display options.', status: null },
  { id: 'AC-4', text: 'Open orders appear on the chart at their retained price.', status: null },
];

const fullPayload: ReadyGatePayload = {
  kind: 'ready',
  branch: 'fixture',
  prNumber: null,
  repo: null,
  workerReport: '',
  diffStat: { files: 1, additions: 1, deletions: 0 },
  acceptanceCriteria: claims.map((claim) => claim.text),
  prPackage: {
    id: 'layout-package',
    artifactPath: 'artifacts/pr-package.json',
    packageHash: 'a'.repeat(64),
    branch: 'fixture',
    headSha: 'b'.repeat(40),
    draftTitle: 'Layout fixture',
    draftBody: 'Captured description. '.repeat(200),
    diffStat: { files: 1, additions: 1, deletions: 0 },
    reviewArtifactIds: [],
    createdAt: '2026-10-16T00:00:00Z',
    publicationTarget: 'draft',
    publicationStatus: 'not_published',
    gatePolicy: { owner: 'human', publishAuthority: 'human', reason: 'Fixture only' },
  },
};

/** Manual state story. Transitions use buttons; no application-store injection. */
@customElement('async-section-fixtures')
export class AsyncSectionFixtures extends LitElement {
  @property({ type: Boolean }) workspace = false;
  @state() private snapshot = 0;

  @state() private phase: 'loading' | 'loaded' | 'refreshing' | 'paused' | 'error' = 'loading';

  protected override createRenderRoot() {
    return this;
  }

  render() {
    if (this.workspace) return this.renderWorkspace();
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
          ${(['loading', 'loaded', 'refreshing', 'paused', 'error'] as const).map(
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
          ${renderPublicationGatePanel({
            actions: [
              { id: 'approve-publish', label: 'Approve publish', style: 'primary' },
              { id: 'hold', label: 'Hold', style: 'secondary' },
            ],
            claims,
            reviewSummary: {
              noCodeReview: true,
              reviews: [],
              passingReviews: 0,
              totalUnresolved: 0,
              didAnyReviewTriggerReWork: false,
            },
            loading: this.phase === 'loading',
            loadError: error,
            retry,
            pausedReason: this.phase === 'paused' ? 'Refreshing run; actions paused' : undefined,
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
        <h2>Run detail skeleton</h2>
        ${renderRunDetailSkeleton(error)}
        <h2>Run inventory skeleton</h2>
        ${renderRunListSkeleton(error, retry)}
        <h2>Fleet skeleton</h2>
        ${renderFleetSkeleton(error, retry)}
        <h2>Workspace file skeleton</h2>
        ${renderSlotFilesSkeleton(error, retry)}
        <h2>PR skeleton</h2>
        ${renderPrBoardSkeleton(false, error, retry)}
      </main>`;
  }
  private renderWorkspace() {
    const compact = this.phase === 'loading';
    const { prPackage: _omitted, ...partial } = fullPayload;
    const decision: RunDecision = {
      id: 'layout-gate',
      type: 'engine_human_gate',
      title: 'Layout fixture',
      description: `Snapshot ${this.snapshot}`,
      createdAt: '2026-10-16T00:00:00Z',
      actions: [{ id: 'hold', label: 'Hold', style: 'secondary' }],
      payload: compact ? partial : fullPayload,
      ...(compact ? { payloadTrimmed: ['prPackage'] } : {}),
    };
    return html`<main
      style="padding:16px;overflow:auto;height:100%;box-sizing:border-box"
      data-workspace-story
    >
      <nav style="display:flex;gap:12px;margin-bottom:16px">
        ${(['loading', 'loaded', 'refreshing', 'paused'] as const).map(
          (phase) =>
            html`<button
              style="min-height:44px;min-width:44px"
              data-workspace-phase=${phase}
              @click=${() => {
                this.phase = phase;
                this.snapshot++;
              }}
            >
              ${phase}
            </button>`,
        )}
      </nav>
      <div style="min-height:400px;overflow:hidden" data-testid="workspace-layout-frame">
        <ready-workspace
          .runId=${'layout-fixture'}
          .decision=${decision}
          .actionsBlocked=${compact || this.phase === 'paused'}
          .loadError=${this.phase === 'paused' ? 'Run unavailable' : ''}
        ></ready-workspace>
      </div>
      <p data-testid="workspace-layout-anchor">Content below workspace</p>
    </main>`;
  }
}
