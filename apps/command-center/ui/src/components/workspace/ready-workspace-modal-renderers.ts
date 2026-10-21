import { html, nothing } from 'lit';

import type { ArtifactRef, ReviewStatus } from '@farmslot/protocol';
import type { ReviewDispatchViewModel } from '@farmslot/review-dispatch';

import '../shared/review-dispatch-picker.js';

import { colors, runnerColor } from '../../styles/theme-tokens.js';
import { reviewHasPendingContinuationPhases } from '../../utils/review-gate-display.js';
import type { ReviewLoopArtifactOpenDetail } from '../reviews/review-loop-timeline.js';
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

export interface ReadyReviewFlowContext {
  reviews: ReviewStatus[];
  passingReviews: number;
  unresolvedFindings: number;
  staleIgnoredReviews: number;
  continuationActive: boolean;
  reviewProgress?: string;
  activeReviewIds: ReadonlySet<string>;
  view: 'chronological' | 'reviewer';
  selected: 'overall' | string;
  reviewSummary?: string;
  artifactUrl: (artifact: ArtifactRef) => string;
  setView: (view: 'chronological' | 'reviewer') => void;
  select: (selection: 'overall' | string) => void;
  openReviewArtifact: (detail: ReviewLoopArtifactOpenDetail) => void;
  openReviewDiff: (detail: ReviewLoopArtifactOpenDetail) => void;
}

export function renderReadyReviewFlow(ctx: ReadyReviewFlowContext) {
  if (ctx.reviews.length === 0 && !ctx.reviewProgress) return nothing;
  const roundCount = ctx.reviews.reduce(
    (total, review) => total + Math.max(1, review.attempts?.length ?? 0),
    0,
  );
  const pendingReview = ctx.reviews.find((review) =>
    reviewHasPendingContinuationPhases(review, review.attempts?.at(-1)),
  );
  const reviewerGroups = Array.from(
    ctx.reviews
      .reduce((groups, review) => {
        const key = `${review.runner ?? 'Unknown runner'}\u0000${review.model ?? 'default'}`;
        const group = groups.get(key) ?? {
          key,
          runner: review.runner ?? 'Unknown runner',
          model: review.model ?? 'default',
          reviews: [] as ReviewStatus[],
        };
        group.reviews.push(review);
        groups.set(key, group);
        return groups;
      }, new Map<string, { key: string; runner: string; model: string; reviews: ReviewStatus[] }>())
      .values(),
  );
  const selectedReviews =
    ctx.view === 'chronological' || ctx.selected === 'overall'
      ? [...ctx.reviews].sort((left, right) =>
          (left.startedAt ?? '').localeCompare(right.startedAt ?? ''),
        )
      : (reviewerGroups.find((group) => group.key === ctx.selected)?.reviews ?? ctx.reviews);
  return html`
    <section class="rdy-review-flow" aria-label="Review history">
      <header class="rdy-review-flow-head">
        <h3 title="Each check can repeat as review, worker fix, re-review until it passes or stops">
          Review history
        </h3>
        <div class="rdy-review-flow-view-picker" role="group" aria-label="Review history layout">
          <button
            class=${ctx.view === 'chronological' ? 'active' : ''}
            aria-pressed=${ctx.view === 'chronological' ? 'true' : 'false'}
            @click=${() => ctx.setView('chronological')}
          >
            Chronological
          </button>
          <button
            class=${ctx.view === 'reviewer' ? 'active' : ''}
            aria-pressed=${ctx.view === 'reviewer' ? 'true' : 'false'}
            @click=${() => ctx.setView('reviewer')}
          >
            By reviewer
          </button>
        </div>
      </header>
      ${ctx.reviewProgress
        ? html`<p role="status" data-testid="rdy-review-progress">${ctx.reviewProgress}</p>`
        : nothing}
      <div class="rdy-review-flow-summary">
        <span><strong>${ctx.reviews.length}</strong> review checks</span>
        <span><strong>${roundCount}</strong> rounds</span>
        <span><strong>${ctx.passingReviews}</strong> trusted passing</span>
        <span class=${ctx.unresolvedFindings ? 'attention' : ''}
          ><strong>${ctx.unresolvedFindings}</strong> unresolved</span
        >
        ${ctx.staleIgnoredReviews
          ? html`<span><strong>${ctx.staleIgnoredReviews}</strong> stale ignored</span>`
          : nothing}
        ${pendingReview
          ? html`<span class="attention"
              ><strong>${pendingReview.unresolvedCount}</strong> ${ctx.activeReviewIds.has(
                pendingReview.id,
              )
                ? 'prior findings fixed · next round running'
                : ctx.continuationActive
                  ? 'findings being fixed'
                  : 'latest findings not delivered'}</span
            >`
          : nothing}
      </div>
      <div class="rdy-review-flow-layout ${ctx.view}">
        ${ctx.view === 'reviewer'
          ? html`<nav class="rdy-review-flow-nav" aria-label="Review selection">
              <button
                class=${ctx.selected === 'overall' ? 'active' : ''}
                aria-pressed=${ctx.selected === 'overall' ? 'true' : 'false'}
                @click=${() => ctx.select('overall')}
              >
                <strong>Overall flow</strong>
                <span>All checks, rounds, and worker fixes</span>
              </button>
              ${reviewerGroups.map((group) => {
                const groupRounds = group.reviews.reduce(
                  (total, review) => total + Math.max(1, review.attempts?.length ?? 0),
                  0,
                );
                const groupUnresolved = group.reviews.reduce(
                  (total, review) => total + review.unresolvedCount,
                  0,
                );
                return html`
                  <button
                    style=${`--runner:${runnerColor(group.runner) ?? colors.accent}`}
                    class=${ctx.selected === group.key ? 'active' : ''}
                    aria-pressed=${ctx.selected === group.key ? 'true' : 'false'}
                    @click=${() => ctx.select(group.key)}
                  >
                    <strong>${group.runner} / ${group.model}</strong>
                    <span>
                      ${group.reviews.length} check${group.reviews.length === 1 ? '' : 's'} ·
                      ${groupRounds} review round${groupRounds === 1 ? '' : 's'} ·
                      ${groupUnresolved} unresolved
                    </span>
                  </button>
                `;
              })}
            </nav>`
          : nothing}
        <div class="rdy-review-flow-detail">
          <review-loop-timeline
            .reviews=${selectedReviews}
            .artifactUrl=${ctx.artifactUrl}
            @review-artifact-open=${(event: CustomEvent<ReviewLoopArtifactOpenDetail>) =>
              ctx.openReviewArtifact(event.detail)}
            @review-diff-open=${(event: CustomEvent<ReviewLoopArtifactOpenDetail>) =>
              ctx.openReviewDiff(event.detail)}
          ></review-loop-timeline>
          ${ctx.view === 'chronological' && ctx.reviewSummary
            ? html`<section class="rdy-review-flow-fix-summary">
                <strong>Worker fix summary</strong>
                <p>${ctx.reviewSummary}</p>
              </section>`
            : nothing}
        </div>
      </div>
    </section>
  `;
}
