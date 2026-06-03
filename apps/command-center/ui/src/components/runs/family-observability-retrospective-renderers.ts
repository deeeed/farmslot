import { html, nothing } from 'lit';

import type { FamilyObservabilityRunSummary, RunDecision } from '@farmslot/protocol';

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
