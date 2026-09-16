import { html, nothing } from 'lit';

import type {
  FamilyObservabilityRunSummary,
  FeedbackCandidate,
  FeedbackCandidateSummary,
  RunDecision,
} from '@farmslot/protocol';

import '../reviews/gate-summary-panel.js';

import {
  retrospectiveCiWatchLabel,
  retrospectiveCommentsSummary,
  retrospectivePayload,
} from './family-observability-retrospective-model.js';

interface PendingRetrospectiveRenderOptions {
  run: FamilyObservabilityRunSummary;
  decision: RunDecision | null;
  onResolve: (run: FamilyObservabilityRunSummary, decision: RunDecision, actionId: string) => void;
}

export function feedbackSummaryLabel(summary: FeedbackCandidateSummary): string {
  return `${summary.total} total · ${summary.human} human · ${summary.bot} bot · ${summary.unknown} unknown · ${summary.consumed} consumed · ${summary.open} open`;
}

function feedbackStateLabel(candidate: FeedbackCandidate): string {
  if (candidate.consumedBy?.length) {
    return candidate.revisedSinceConsumed
      ? `revised since consumed by "${candidate.consumedBy[0]!.rule}"`
      : `consumed by "${candidate.consumedBy[0]!.rule}"`;
  }
  return candidate.resolution.state;
}

export function renderFeedbackCandidates(
  candidates: FeedbackCandidate[] | undefined,
  summary: FeedbackCandidateSummary | undefined,
) {
  if (!candidates?.length) return nothing;
  return html`
    <details class="retro-details feedback-candidates" data-testid="feedback-candidates">
      <summary>
        PR feedback candidates${summary ? ` (${feedbackSummaryLabel(summary)})` : ''}
      </summary>
      <div class="feedback-list">
        ${candidates.map(
          (candidate) => html`
            <div
              class="feedback-candidate"
              data-testid="feedback-candidate"
              data-author-kind=${candidate.authorKind}
              data-state=${feedbackStateLabel(candidate)}
            >
              <div class="feedback-head">
                <span class="feedback-kind">${candidate.authorKind}</span>
                <strong>${candidate.authorLogin ?? 'unknown author'}</strong>
                <span class="muted">${candidate.kind}</span>
                <span class="muted">${feedbackStateLabel(candidate)}</span>
                ${candidate.url
                  ? html`<a
                      class="retro-open"
                      href=${candidate.url}
                      target="_blank"
                      rel="noreferrer"
                      >open</a
                    >`
                  : nothing}
              </div>
              ${candidate.excerpt
                ? html`<div class="retro-copy">${candidate.excerpt}</div>`
                : nothing}
              <div class="feedback-meta muted">
                ${candidate.path ? html`<span>${candidate.path}</span>` : nothing}
                <span
                  >reviewed
                  ${candidate.reviewedCommit
                    ? candidate.reviewedCommit.slice(0, 8)
                    : 'unknown'}</span
                >
                ${candidate.observedHead
                  ? html`<span>head ${candidate.observedHead.slice(0, 8)}</span>`
                  : nothing}
                <span>rev ${candidate.revision.slice(0, 8)}</span>
                <span
                  >runs ${candidate.runIds.map((id) => id.slice(0, 8)).join(', ') || 'none'}</span
                >
                <span
                  >attribution: ${candidate.attribution.kind} — ${candidate.attribution.note}</span
                >
                <span>sources: ${candidate.sources.join(', ')}</span>
              </div>
            </div>
          `,
        )}
      </div>
    </details>
  `;
}

export function renderPendingRetrospectiveDecision(options: PendingRetrospectiveRenderOptions) {
  const { decision } = options;
  if (!decision) return nothing;
  const payload = retrospectivePayload(decision);
  const ciWatchLabel = payload ? retrospectiveCiWatchLabel(payload) : null;
  const commentsSummary = payload ? retrospectiveCommentsSummary(payload) : null;

  return html`
    <div class="detail-section retrospective-rail">
      <div class="detail-title">Pending retrospective decision</div>
      <div class="retro-what">
        ${payload?.whatThisIs ??
        'Review this completed run and decide whether it should feed the self-improvement loop.'}
      </div>
      ${payload?.gateSummary
        ? html`<gate-summary-panel .summary=${payload.gateSummary}></gate-summary-panel>`
        : nothing}
      <div class="retro-grid">
        <div>
          <span class="muted">Outcome</span><strong>${payload?.outcome ?? 'unknown'}</strong>
        </div>
        ${ciWatchLabel
          ? html`<div><span class="muted">CI Watch</span><strong>${ciWatchLabel}</strong></div>`
          : nothing}
        ${payload?.selfReviewVerdict
          ? html`<div>
              <span class="muted">Self Review</span><strong>${payload.selfReviewVerdict}</strong>
            </div>`
          : nothing}
      </div>
      ${payload?.selfReviewSummary
        ? html`<div class="retro-copy">${payload.selfReviewSummary}</div>`
        : nothing}
      ${commentsSummary
        ? html`
            <div class="retro-copy">
              <span class="muted">Reviewer comments</span>
              <strong>${commentsSummary}</strong>
            </div>
          `
        : nothing}
      ${payload?.rootLearnings || payload?.deltaLearnings
        ? html`
            ${payload.rootLearnings
              ? html`
                  <details class="retro-details">
                    <summary>
                      Original fix-bug
                      learnings${payload.rootRunId ? ` (run ${payload.rootRunId.slice(0, 8)})` : ''}
                    </summary>
                    <div class="retro-copy">${payload.rootLearnings}</div>
                  </details>
                `
              : nothing}
            ${payload.deltaLearnings
              ? html`
                  <details class="retro-details" open>
                    <summary>Reviewer-driven delta</summary>
                    <div class="retro-copy">${payload.deltaLearnings}</div>
                  </details>
                `
              : nothing}
          `
        : payload?.workerLearnings
          ? html`
              <details class="retro-details">
                <summary>Worker Learnings</summary>
                <div class="retro-copy">${payload.workerLearnings}</div>
              </details>
            `
          : nothing}
      ${payload?.reportExcerpt
        ? html`
            <details class="retro-details">
              <summary>Worker Report</summary>
              <div class="retro-copy">${payload.reportExcerpt}</div>
            </details>
          `
        : nothing}
      ${renderFeedbackCandidates(payload?.feedbackCandidates, payload?.feedbackSummary)}
      ${payload?.actionEffects?.length
        ? html`
            <div class="retro-effects">
              ${payload.actionEffects.map(
                (effect) => html`
                  <div class="retro-effect">
                    <strong
                      >${decision.actions.find((action) => action.id === effect.actionId)?.label ??
                      effect.actionId}</strong
                    ><span>${effect.summary}</span>
                  </div>
                `,
              )}
            </div>
          `
        : nothing}
      <div class="retro-action-row">
        ${decision.actions.map(
          (action) => html`
            <button
              class="action-btn ${action.id === 'accept' ? 'primary' : ''}"
              @click=${() => options.onResolve(options.run, decision, action.id)}
            >
              ${action.label}
            </button>
          `,
        )}
      </div>
    </div>
  `;
}
