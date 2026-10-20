import { html, nothing, type TemplateResult } from 'lit';

import type { ReadyGatePayload } from '@farmslot/protocol';

import { acceptancePanelStyles } from '../progress-tracker/acceptance-panel.js';
import { gatewayMediaHtml } from '../shared/gateway-media-src.js';
import type {
  LightboxItem,
  LightboxPair,
  LightboxSelection,
} from '../shared/media-lightbox-types.js';

import { renderReadyWorkspaceMarkdown } from './ready-workspace-markdown.js';
import { readyWorkspaceLightStyles } from './ready-workspace-renderers.js';

/** Package-gate runs expose evidence in the Evidence tab and recipe context in Recipe. */
export function readyWorkspaceShowsReportEvidencePreview(
  payload: Pick<ReadyGatePayload, 'prPackage'>,
): boolean {
  return !payload.prPackage;
}

export interface ReadyWorkspaceFrameInput {
  payload: ReadyGatePayload;
  packagePending?: boolean;
  splitPct: number;
  recovering: boolean;
  recoveryPhase: string;
  recoveryMessage: string;
  gatewayConnected: boolean;
  renderTopBar: () => TemplateResult;
  renderResolvedBanner: () => unknown;
  renderPackagePanel: () => unknown;
  renderReportEvidence?: () => unknown;
  renderTabBar: () => unknown;
  renderTabContent: () => unknown;
  renderInputArtifactViewer: () => unknown;
  renderReviewRequestModal: () => unknown;
  renderReviewFlowModal: () => unknown;
  /** The criterion evidence review, over the gate while open. */
  renderReview: () => unknown;
  beginRecovery: () => void;
  onResizeStart: (event: MouseEvent) => void;
  lightbox: {
    items: LightboxItem[];
    pairs: LightboxPair[];
    open: boolean;
    selectedIndex: number;
    mode: 'single' | 'compare';
    pairIndex: number;
    scopeLabel: string;
    totalItems: number;
    close: () => void;
    navigate: (index: number) => void;
    replace: (selection: LightboxSelection) => void;
    changeMode: (mode: 'single' | 'compare') => void;
    navigatePair: (index: number) => void;
    clearScope: (path?: string | null) => void;
  };
  diffModal: {
    open: boolean;
    title: string;
    diffText: string;
    artifactUrl: string;
    testPatterns: readonly string[] | null;
    close: () => void;
  };
}

export function renderReadyWorkspaceFrame(input: ReadyWorkspaceFrameInput) {
  const packageGate = Boolean(input.payload.prPackage || input.packagePending);
  const reportEvidence = readyWorkspaceShowsReportEvidencePreview(input.payload)
    ? (input.renderReportEvidence?.() ?? nothing)
    : nothing;

  const reviewContent = html`${input.renderTabBar()}
    <div
      class="rdy-tab-pane-host"
      style=${packageGate ? 'flex:1 1 min(65vh,640px);min-height:0' : nothing}
    >
      ${input.renderTabContent()}
    </div>`;

  return html`
    <style>
      ${readyWorkspaceLightStyles()}
      ${acceptancePanelStyles.cssText}
    </style>
    ${input.renderResolvedBanner()}
    <div class="rdy-split">
      ${renderReadyRecoveryOverlay(input)}
      ${packageGate
        ? nothing
        : html`
            <div class="rdy-report" style="flex: ${input.splitPct} 1 0%">
              ${input.payload.workerReport
                ? html`<div class="rdy-md-section">
                    ${gatewayMediaHtml(renderReadyWorkspaceMarkdown(input.payload.workerReport))}
                    ${reportEvidence}
                  </div>`
                : html`<div class="rdy-md-section">
                    <div class="rdy-md-empty">No worker report</div>
                    ${reportEvidence}
                  </div>`}
            </div>
            <div class="rdy-resize" @mousedown=${input.onResizeStart}></div>
          `}
      <div class="rdy-bottom" style="flex: ${packageGate ? 1 : 100 - input.splitPct} 1 0%">
        ${reviewContent}
      </div>
    </div>
    ${input.renderTopBar()} ${input.renderReview()}
    <media-lightbox
      .items=${input.lightbox.items}
      .pairs=${input.lightbox.pairs}
      .open=${input.lightbox.open}
      .selectedIndex=${input.lightbox.selectedIndex}
      .mode=${input.lightbox.mode}
      .pairIndex=${input.lightbox.pairIndex}
      .scopeLabel=${input.lightbox.scopeLabel}
      .totalItems=${input.lightbox.totalItems}
      @lightbox-close=${input.lightbox.close}
      @lightbox-navigate=${(event: CustomEvent<{ index: number }>) =>
        input.lightbox.navigate(event.detail.index)}
      @lightbox-items-change=${(event: CustomEvent<LightboxSelection>) =>
        input.lightbox.replace(event.detail)}
      @lightbox-mode-change=${(event: CustomEvent<{ mode: 'single' | 'compare' }>) =>
        input.lightbox.changeMode(event.detail.mode)}
      @lightbox-pair-navigate=${(event: CustomEvent<{ index: number }>) =>
        input.lightbox.navigatePair(event.detail.index)}
      @lightbox-clear-scope=${(event: CustomEvent<{ path?: string | null }>) =>
        input.lightbox.clearScope(event.detail.path)}
    ></media-lightbox>
    <diff-viewer-modal
      .open=${input.diffModal.open}
      .title=${input.diffModal.title}
      .diffText=${input.diffModal.diffText}
      .artifactUrl=${input.diffModal.artifactUrl}
      .testPatterns=${input.diffModal.testPatterns}
      @diff-modal-close=${input.diffModal.close}
    ></diff-viewer-modal>
    ${input.renderInputArtifactViewer()} ${input.renderReviewRequestModal()}
    ${input.renderReviewFlowModal()}
  `;
}

export function renderReadyWorkspaceEmpty() {
  return html`<div class="rdy-empty">No ready decision</div>`;
}

function renderReadyRecoveryOverlay(input: ReadyWorkspaceFrameInput) {
  if (!input.recovering) return nothing;
  const blocked = input.recoveryPhase === 'error';

  return html`
    <div class="rdy-recovery-overlay" role="status" aria-live="polite">
      <div class="rdy-recovery-card">
        <div class="rdy-recovery-eyebrow">
          ${blocked ? 'Recovery blocked' : 'Recovering ready workspace'}
        </div>
        <div class="rdy-recovery-title">
          ${blocked ? 'Retry ready-state recovery' : 'Refreshing ready-state data from gateway'}
        </div>
        <div class="rdy-recovery-copy">${input.recoveryMessage}</div>
        ${blocked && input.gatewayConnected
          ? html`
              <div class="rdy-recovery-actions">
                <button class="rdy-recovery-btn" @click=${input.beginRecovery}>Retry now</button>
              </div>
            `
          : nothing}
      </div>
    </div>
  `;
}
