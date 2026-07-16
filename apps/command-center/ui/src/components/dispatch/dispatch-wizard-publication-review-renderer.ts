import { html, nothing } from 'lit';

import type { FlowType, ReviewRunnerId, ReviewValidationDepth } from '@farmslot/protocol';

import type { PublicationReviewLoopDraft } from './dispatch-wizard-draft.js';

export interface PublicationReviewPlanItem {
  runner: ReviewRunnerId | 'same';
  validationDepth?: ReviewValidationDepth;
}

export interface PublicationReviewConfigRenderContext {
  enabled: boolean;
  flowType: FlowType | null;
  runner: string;
  mode: 'interactive' | 'autonomous';
  loops: readonly PublicationReviewLoopDraft[];
  plan: readonly PublicationReviewPlanItem[];
  runnerOptions: readonly string[];
  setRunner: (id: number, runner: ReviewRunnerId) => void;
  setDepth: (id: number, validationDepth: ReviewValidationDepth) => void;
  removeLoop: (id: number) => void;
  addWorkerReviewLoop: () => void;
  addExternalReviewLoop: () => void;
}

export function renderPublicationReviewConfig(ctx: PublicationReviewConfigRenderContext) {
  if (!ctx.enabled) return nothing;
  const hasExternalReview = ctx.plan.some((loop) => loop.runner !== ctx.runner);
  const baseLabel = ctx.flowType === 'dev' ? 'autonomous dev review' : 'self-review';
  return html`
    <div class="publication-review-panel">
      <div class="publication-review-head">
        <div>
          <div class="section-label">Publication reviews</div>
          <div class="section-help">
            Base ${runnerLabel(ctx.runner)} ${baseLabel} always runs before the ready gate. Add
            ordered independent review loops now; you can still add more from the ready gate.
          </div>
        </div>
        <span class="publication-review-summary">
          ${1 + ctx.plan.length} total${hasExternalReview ? ' · external' : ''}
        </span>
      </div>
      <div class="publication-review-sequence">
        <div class="publication-review-row base">
          <span class="publication-review-index">base</span>
          <span class="publication-review-base">${runnerLabel(ctx.runner)} ${baseLabel}</span>
          <span class="publication-review-kind">worker runner</span>
        </div>
        ${ctx.loops.map((loop, index) => renderReviewLoopRow(ctx, loop, index))}
      </div>
      <div class="publication-review-actions">
        <button
          class="pill"
          ?disabled=${ctx.loops.length >= 5}
          @click=${() => ctx.addWorkerReviewLoop()}
        >
          + Independent review
        </button>
        <button
          class="pill"
          ?disabled=${ctx.loops.length >= 5}
          @click=${() => ctx.addExternalReviewLoop()}
        >
          + Independent review (runner diversity)
        </button>
      </div>
    </div>
  `;
}

function renderReviewLoopRow(
  ctx: PublicationReviewConfigRenderContext,
  loop: PublicationReviewLoopDraft,
  index: number,
) {
  const depth = ctx.plan[index]?.validationDepth ?? loop.validationDepth ?? 'static-code';
  return html`
    <div class="publication-review-row">
      <span class="publication-review-index">${index + 1}</span>
      <div class="publication-review-runners">
        ${ctx.runnerOptions.map((runner) => renderRunnerChoice(ctx, loop, runner))}
      </div>
      <div class="publication-review-depth" aria-label="Validation depth">
        ${(['static-code', 'full-live'] as ReviewValidationDepth[]).map((candidate) =>
          renderDepthChoice(ctx, loop, depth, candidate),
        )}
      </div>
      <span class="publication-review-kind"
        >${loop.runner === ctx.runner ? 'worker runner' : 'external'}</span
      >
      <button class="review-remove" @click=${() => ctx.removeLoop(loop.id)}>Remove</button>
    </div>
  `;
}

function renderRunnerChoice(
  ctx: PublicationReviewConfigRenderContext,
  loop: PublicationReviewLoopDraft,
  runner: string,
) {
  return html`
    <button
      class="review-runner-chip ${loop.runner === runner ? 'selected' : ''}"
      aria-pressed=${loop.runner === runner ? 'true' : 'false'}
      @click=${() => ctx.setRunner(loop.id, runner as ReviewRunnerId)}
    >
      ${runnerLabel(runner)}
    </button>
  `;
}

function renderDepthChoice(
  ctx: PublicationReviewConfigRenderContext,
  loop: PublicationReviewLoopDraft,
  depth: ReviewValidationDepth,
  candidate: ReviewValidationDepth,
) {
  return html`
    <button
      class="review-runner-chip ${depth === candidate ? 'selected' : ''}"
      aria-pressed=${depth === candidate ? 'true' : 'false'}
      title=${candidate === 'static-code'
        ? 'Static analysis only: no build, no tests, no recipe.'
        : 'Final live validation: recipe/evidence checks may run.'}
      @click=${() => ctx.setDepth(loop.id, candidate)}
    >
      ${candidate === 'static-code' ? 'Static' : 'Full live'}
    </button>
  `;
}

function runnerLabel(runner: string): string {
  return runner.charAt(0).toUpperCase() + runner.slice(1);
}
