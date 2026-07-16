import { html, nothing } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type { ReviewLoopRequest, ReviewValidationDepth } from '@farmslot/protocol';
import { reviewValidationDepthForLoop } from '@farmslot/protocol';

import type { ReadyInputArtifact } from './ready-workspace-inputs.js';
import { renderReadyWorkspaceMarkdown } from './ready-workspace-markdown.js';

export type ReviewRunnerChoice = ReviewLoopRequest['runner'];

export interface ReviewLoopDraft {
  id: number;
  runner: ReviewRunnerChoice | '';
  validationDepth?: ReviewValidationDepth;
}

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
                ${unsafeHTML(renderReadyWorkspaceMarkdown(artifact.body))}
              </div>`
            : html`<pre class="rdy-input-pre">${artifact.body}</pre>`}
        </div>
      </div>
    </div>
  `;
}

export interface ReadyReviewRequestModalContext {
  open: boolean;
  loops: ReviewLoopDraft[];
  currentRunner: ReviewRunnerChoice;
  acting: boolean;
  runnerLabel: (runner: string) => string;
  close: () => void;
  addLoop: () => void;
  removeLoop: (id: number) => void;
  setRunner: (id: number, runner: ReviewRunnerChoice) => void;
  setDepth: (id: number, validationDepth: ReviewValidationDepth) => void;
  submit: () => void | Promise<void>;
}

export function renderReadyReviewRequestModal(ctx: ReadyReviewRequestModalContext) {
  if (!ctx.open) return nothing;
  return html`
    <div
      class="rdy-modal-backdrop"
      @click=${(event: Event) => {
        if (event.target === event.currentTarget) ctx.close();
      }}
    >
      <div
        class="rdy-review-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Request independent review"
      >
        <div class="rdy-review-modal-head">
          <div>
            <div class="rdy-review-modal-eyebrow">Independent review</div>
            <h3>Build review sequence</h3>
            <p>
              Each row runs after the previous row passes. Choose another runner to require runner
              diversity.
            </p>
          </div>
          <button class="rdy-modal-close" @click=${ctx.close}>Close</button>
        </div>
        <div class="rdy-review-sequence">
          ${ctx.loops.map((loop, index) => {
            const selectedRunner = loop.runner || ctx.currentRunner;
            const validationDepth =
              loop.validationDepth ?? reviewValidationDepthForLoop(index, ctx.loops.length);
            return html`
              <div class="rdy-review-loop-row">
                <span class="rdy-review-loop-index">${index + 1}</span>
                <div class="rdy-review-runner-picker" aria-label="Review runner">
                  ${(
                    [ctx.currentRunner, 'claude', 'codex', 'cursor', 'grok'].filter(
                      (runner, runnerIndex, runners) =>
                        runner && runners.indexOf(runner) === runnerIndex,
                    ) as ReviewRunnerChoice[]
                  ).map(
                    (runner) => html`
                      <button
                        class="rdy-runner-chip ${selectedRunner === runner ? 'active' : ''}"
                        @click=${() => ctx.setRunner(loop.id, runner)}
                        aria-pressed=${selectedRunner === runner ? 'true' : 'false'}
                      >
                        ${ctx.runnerLabel(runner)}
                      </button>
                    `,
                  )}
                </div>
                <div class="rdy-review-depth-picker" aria-label="Validation depth">
                  ${(['static-code', 'full-live'] as ReviewValidationDepth[]).map(
                    (candidate) => html`
                      <button
                        class="rdy-runner-chip ${validationDepth === candidate ? 'active' : ''}"
                        title=${candidate === 'static-code'
                          ? 'Static analysis only: no build, no tests, no recipe.'
                          : 'Final live validation: recipe/evidence checks may run.'}
                        @click=${() => ctx.setDepth(loop.id, candidate)}
                        aria-pressed=${validationDepth === candidate ? 'true' : 'false'}
                      >
                        ${candidate === 'static-code' ? 'Static' : 'Full live'}
                      </button>
                    `,
                  )}
                </div>
                <span class="rdy-review-loop-kind"
                  >${selectedRunner === ctx.currentRunner
                    ? 'worker runner'
                    : 'runner diversity'}</span
                >
                <button
                  class="rdy-modal-close"
                  ?disabled=${ctx.loops.length <= 1}
                  @click=${() => ctx.removeLoop(loop.id)}
                >
                  Remove
                </button>
              </div>
            `;
          })}
          <button
            class="rdy-add-review-loop"
            ?disabled=${ctx.loops.length >= 5}
            @click=${ctx.addLoop}
          >
            + Add next review loop
          </button>
        </div>
        <div class="rdy-review-modal-actions">
          <button class="rdy-btn rdy-btn-secondary" @click=${ctx.close}>Cancel</button>
          <button class="rdy-btn rdy-btn-primary" ?disabled=${ctx.acting} @click=${ctx.submit}>
            Request ${ctx.loops.length} Review${ctx.loops.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  `;
}
