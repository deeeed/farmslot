import { html, nothing } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type {
  ArtifactRef,
  IndependentReviewStatus,
  ReviewLoopRequest,
  ReviewSessionIntent,
  ReviewValidationDepth,
} from '@farmslot/protocol';
import { reviewValidationDepthForLoop } from '@farmslot/protocol';

import { reviewSourceLabel } from '../../utils/review-gate-display.js';
import type { ReviewLoopArtifactOpenDetail } from '../reviews/review-loop-timeline.js';

import type { ReadyInputArtifact } from './ready-workspace-inputs.js';
import { renderReadyWorkspaceMarkdown } from './ready-workspace-markdown.js';

export type ReviewRunnerChoice = ReviewLoopRequest['runner'];

export interface ReviewLoopDraft {
  id: number;
  runner: ReviewRunnerChoice | '';
  validationDepth?: ReviewValidationDepth;
  sessionIntent: ReviewSessionIntent;
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
  setSessionIntent: (id: number, sessionIntent: ReviewSessionIntent) => void;
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
              diversity, and choose whether that runner continues its same-run context or starts
              clean.
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
                <div class="rdy-review-session-picker" aria-label="Reviewer session">
                  ${(['resume', 'reset'] as ReviewSessionIntent[]).map(
                    (candidate) => html`
                      <button
                        class="rdy-runner-chip ${loop.sessionIntent === candidate ? 'active' : ''}"
                        title=${candidate === 'resume'
                          ? "Continue this runner's same-run review context; start fresh if it cannot be resumed."
                          : 'Reset reviewer reasoning and start clean in the same runner window.'}
                        @click=${() => ctx.setSessionIntent(loop.id, candidate)}
                        aria-pressed=${loop.sessionIntent === candidate ? 'true' : 'false'}
                      >
                        ${candidate === 'resume' ? 'Continue' : 'Fresh'}
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

export interface ReadyReviewFlowModalContext {
  open: boolean;
  reviews: IndependentReviewStatus[];
  selected: 'overall' | number;
  selfReviewSummary?: string;
  artifactUrl: (artifact: ArtifactRef) => string;
  close: () => void;
  select: (selection: 'overall' | number) => void;
  openReviewArtifact: (detail: ReviewLoopArtifactOpenDetail) => void;
  openReviewDiff: (detail: ReviewLoopArtifactOpenDetail) => void;
}

export function renderReadyReviewFlowModal(ctx: ReadyReviewFlowModalContext) {
  if (!ctx.open) return nothing;
  const selectedReviews =
    ctx.selected === 'overall' ? ctx.reviews : ctx.reviews.slice(ctx.selected, ctx.selected + 1);
  const passing = ctx.reviews.filter(
    (review) => review.verdict === 'pass' && review.unresolvedCount === 0,
  ).length;
  const unresolved = ctx.reviews.reduce((sum, review) => sum + review.unresolvedCount, 0);
  return html`
    <div
      class="rdy-modal-backdrop"
      @click=${(event: Event) => {
        if (event.target === event.currentTarget) ctx.close();
      }}
    >
      <div class="rdy-review-flow-modal" role="dialog" aria-modal="true" aria-label="Review flow">
        <header class="rdy-review-modal-head">
          <div>
            <div class="rdy-review-modal-eyebrow">Pre-publication review</div>
            <h3>Review flow</h3>
            <p>Inspect the complete audit trail or focus on one requested review.</p>
          </div>
          <button class="rdy-modal-close" @click=${ctx.close}>Close</button>
        </header>
        <div class="rdy-review-flow-summary">
          <span><strong>${ctx.reviews.length}</strong> reviews</span>
          <span><strong>${passing}</strong> passing</span>
          <span class=${unresolved ? 'attention' : ''}
            ><strong>${unresolved}</strong> findings recorded</span
          >
        </div>
        <div class="rdy-review-flow-layout">
          <nav class="rdy-review-flow-nav" aria-label="Review selection">
            <button
              class=${ctx.selected === 'overall' ? 'active' : ''}
              aria-pressed=${ctx.selected === 'overall' ? 'true' : 'false'}
              @click=${() => ctx.select('overall')}
            >
              <strong>Overall flow</strong>
              <span>All reviews and fixes</span>
            </button>
            ${ctx.reviews.map(
              (review, index) => html`
                <button
                  class=${ctx.selected === index ? 'active' : ''}
                  aria-pressed=${ctx.selected === index ? 'true' : 'false'}
                  @click=${() => ctx.select(index)}
                >
                  <strong>Review ${index + 1} · ${reviewSourceLabel(review)}</strong>
                  <span
                    >${review.verdict} · ${review.unresolvedCount} unresolved ·
                    ${review.attempts?.length ?? 1}
                    attempt${(review.attempts?.length ?? 1) === 1 ? '' : 's'}</span
                  >
                </button>
              `,
            )}
          </nav>
          <main class="rdy-review-flow-detail">
            <review-loop-timeline
              .reviews=${selectedReviews}
              .artifactUrl=${ctx.artifactUrl}
              @review-artifact-open=${(event: CustomEvent<ReviewLoopArtifactOpenDetail>) =>
                ctx.openReviewArtifact(event.detail)}
              @review-diff-open=${(event: CustomEvent<ReviewLoopArtifactOpenDetail>) =>
                ctx.openReviewDiff(event.detail)}
            ></review-loop-timeline>
            ${ctx.selected === 'overall' && ctx.selfReviewSummary
              ? html`<section class="rdy-review-flow-fix-summary">
                  <strong>Worker fix summary</strong>
                  <p>${ctx.selfReviewSummary}</p>
                </section>`
              : nothing}
          </main>
        </div>
      </div>
    </div>
  `;
}
