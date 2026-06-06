import { html, nothing, type TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type { ReadyGatePayload } from '@farmslot/protocol';

import type { LightboxItem, LightboxPair } from '../shared/media-lightbox-types.js';

import { renderReadyWorkspaceMarkdown } from './ready-workspace-markdown.js';
import { readyWorkspaceLightStyles } from './ready-workspace-renderers.js';

export interface ReadyWorkspaceFrameInput {
  payload: ReadyGatePayload;
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
    changeMode: (mode: 'single' | 'compare') => void;
    navigatePair: (index: number) => void;
    clearScope: (path?: string | null) => void;
  };
  diffModal: {
    open: boolean;
    title: string;
    diffText: string;
    artifactUrl: string;
    close: () => void;
  };
}

export function renderReadyWorkspaceFrame(input: ReadyWorkspaceFrameInput) {
  const packageGate = !!input.payload.prPackage;
  const reportEvidence = input.renderReportEvidence?.() ?? nothing;

  return html`
    <style>
      ${readyWorkspaceLightStyles()}
    </style>
    ${input.renderTopBar()} ${input.renderResolvedBanner()}
    <div class="rdy-split">
      ${renderReadyRecoveryOverlay(input)}
      ${packageGate
        ? nothing
        : html`
            <div class="rdy-report" style="flex: ${input.splitPct} 1 0%">
              ${input.payload.workerReport
                ? html`<div class="rdy-md-section">
                    ${unsafeHTML(renderReadyWorkspaceMarkdown(input.payload.workerReport))}
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
        ${input.payload.prPackage ? html`${input.renderPackagePanel()} ${reportEvidence}` : nothing}
        ${input.renderTabBar()} ${input.renderTabContent()}
      </div>
    </div>
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
      @diff-modal-close=${input.diffModal.close}
    ></diff-viewer-modal>
    ${input.renderInputArtifactViewer()} ${input.renderReviewRequestModal()}
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
