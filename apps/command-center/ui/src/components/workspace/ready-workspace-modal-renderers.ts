import { html, nothing } from 'lit';

import type { ReviewDispatchViewModel } from '@farmslot/review-dispatch';

import '../shared/review-dispatch-picker.js';

import { gatewayMediaHtml } from '../shared/gateway-media-src.js';

import type { ReadyInputArtifact } from './ready-workspace-inputs.js';
import { renderReadyWorkspaceMarkdown } from './ready-workspace-markdown.js';

export interface ReadyInputArtifactViewerContext {
  open: boolean;
  artifact: ReadyInputArtifact | null;
  close: () => void;
}

export function renderReadyInputArtifactViewer(ctx: ReadyInputArtifactViewerContext) {
  if (!ctx.open || !ctx.artifact) return nothing;
  const artifact = ctx.artifact;
  return html`
    <div
      class="rdy-modal-backdrop"
      @click=${(event: Event) => {
        if (event.target === event.currentTarget) ctx.close();
      }}
    >
      <div class="rdy-input-viewer" role="dialog" aria-modal="true" aria-label=${artifact.label}>
        <div class="rdy-input-viewer-head">
          <div>
            <div class="rdy-input-eyebrow">Input artifact viewer · ${artifact.kind}</div>
            <h3>${artifact.label}</h3>
            <p>${artifact.summary}</p>
          </div>
          <button class="rdy-modal-close" @click=${ctx.close}>Close</button>
        </div>
        <div class="rdy-input-viewer-body">
          ${artifact.format === 'markdown'
            ? html`<div class="rdy-md-section rdy-input-md">
                ${gatewayMediaHtml(renderReadyWorkspaceMarkdown(artifact.body))}
              </div>`
            : html`<pre class="rdy-input-pre">${artifact.body}</pre>`}
        </div>
      </div>
    </div>
  `;
}

export interface ReadyReviewRequestModalContext {
  open: boolean;
  viewModel: ReviewDispatchViewModel;
  acting: boolean;
  message?: string;
  close: () => void;
  changed: () => void;
  submit: () => void | Promise<void>;
}

export function renderReadyReviewRequestModal(ctx: ReadyReviewRequestModalContext) {
  if (!ctx.open) return nothing;
  return html`<div
    class="rdy-modal-backdrop"
    @click=${(event: Event) => {
      if (!ctx.acting && event.target === event.currentTarget) ctx.close();
    }}
  >
    <div class="rdy-review-modal" role="dialog" aria-modal="true" aria-label="Request review">
      <div class="rdy-review-modal-head">
        <div>
          <div class="rdy-review-modal-eyebrow">Review</div>
          <h3>Build review sequence</h3>
          <p>
            Each review runs in a separate session. WARM reuses this PR's retained reviewer; COLD
            starts a fresh whole-PR review.
          </p>
        </div>
        <button class="rdy-modal-close" ?disabled=${ctx.acting} @click=${ctx.close}>Close</button>
      </div>
      <review-dispatch-picker
        .viewModel=${ctx.viewModel}
        .review=${true}
        .disabled=${ctx.acting}
        @review-dispatch-change=${ctx.changed}
        @review-dispatch-status-change=${ctx.changed}
      ></review-dispatch-picker>
      ${ctx.message ? html`<div role="status">${ctx.message}</div>` : nothing}
      <div class="rdy-review-modal-actions">
        <button class="rdy-btn rdy-btn-secondary" ?disabled=${ctx.acting} @click=${ctx.close}>
          Cancel
        </button>
        <button
          class="rdy-btn rdy-btn-primary"
          ?disabled=${ctx.acting || !ctx.viewModel.canInvoke('request-review')}
          @click=${ctx.submit}
        >
          Request ${ctx.viewModel.rows.length} Review${ctx.viewModel.rows.length === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  </div>`;
}
