import { html, nothing } from 'lit';

import type { EvidenceReviewJudgmentRow } from '@farmslot/adapter-sdk/evidence';
import { validVisualJudgmentReason } from '@farmslot/protocol';
import { type VisualJudgmentFeedback } from '@farmslot/review-dispatch';
import { publicationGateCssVariables } from '@farmslot/theme';

export interface VisualClaimJudgmentInput {
  row: EvidenceReviewJudgmentRow;
  busy?: boolean;
  feedback?: VisualJudgmentFeedback;
  reason: string;
  changeReason: (reason: string) => void;
  record: (verdict: 'confirmed' | 'rejected') => void;
}

/** Both the gate and Compare by AC use the same judgment controls. */
export function renderVisualClaimJudgment(input: VisualClaimJudgmentInput) {
  const { row } = input;
  const feedback = input.feedback?.claimId === row.claim.id ? input.feedback : undefined;
  const pending = feedback && feedback.phase !== 'error';
  const checked = row.claim.proofKinds.includes('person-reviewed') && !row.pending;
  const delegated = row.reviewKind === 'lead-agent-reviewed';
  const rationale = html`<label
    >Reason
    <textarea
      aria-label=${`Issue reason for ${row.claim.id}`}
      .value=${input.reason}
      ?disabled=${input.busy}
      @input=${(event: Event) =>
        input.changeReason((event.currentTarget as HTMLTextAreaElement).value)}
    ></textarea>
  </label>`;
  const controls = html`
    ${row.reviewKind || row.pending
      ? html`<div class="gate-judgment-actions">
          ${delegated ? rationale : nothing}
          <button
            class="gate-secondary"
            type="button"
            data-review-verdict="confirmed"
            ?disabled=${input.busy ||
            !row.reviewKind ||
            !validVisualJudgmentReason(row.reviewKind ?? undefined, 'confirmed', input.reason)}
            @click=${() => input.record('confirmed')}
          >
            ${pending ? html`<span class="gate-spinner" aria-hidden="true"></span>` : nothing}
            ${pending
              ? feedback.phase === 'refreshing'
                ? 'Refreshing…'
                : 'Checking…'
              : 'Looks right'}
          </button>
          ${!row.reviewKind
            ? html`<button class="gate-secondary" disabled type="button">Issue</button>`
            : html`<details class="gate-issue" ?inert=${input.busy}>
                <summary aria-disabled=${Boolean(input.busy)}>Issue</summary>
                ${delegated ? nothing : rationale}
                <button
                  class="gate-secondary"
                  type="button"
                  data-review-verdict="rejected"
                  ?disabled=${input.busy ||
                  !validVisualJudgmentReason(row.reviewKind ?? undefined, 'rejected', input.reason)}
                  @click=${() => input.record('rejected')}
                >
                  Record issue
                </button>
              </details>`}
        </div>`
      : nothing}
  `;
  return html`<div
    class="visual-claim-judgment"
    data-visual-review=${row.claim.id}
    aria-busy=${Boolean(pending)}
  >
    ${checked && !pending
      ? html`<details class="gate-change">
          <summary>Change</summary>
          ${controls}
        </details>`
      : controls}
    ${feedback?.phase === 'error'
      ? html`<span class="gate-row-error" role="alert">${feedback.message}</span>`
      : nothing}
  </div>`;
}

export function visualClaimJudgmentStyles() {
  return `
    .visual-claim-judgment { ${publicationGateCssVariables('dark', 'judgment')} display: flex; flex-wrap: wrap; gap: 8px; align-items: center; color: var(--judgment-text); }
    @media (prefers-color-scheme: light) { .visual-claim-judgment { ${publicationGateCssVariables('light', 'judgment')} } }
    .gate-judgment-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: start; }
    .gate-issue summary, .gate-change > summary, .visual-claim-judgment button { box-sizing: border-box; min-height: 44px; min-width: 44px; padding: 12px 16px; cursor: pointer; font: inherit; }
    .gate-change > summary { color: var(--judgment-text); }
    .gate-row-error { flex-basis: 100%; color: var(--judgment-issue); }
    .gate-spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: gate-spin 0.8s linear infinite; margin-right: 6px; }
    @keyframes gate-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .gate-spinner { animation: none; border-style: dotted; } }
    .visual-claim-judgment button { color: var(--judgment-text); background: var(--judgment-surface); border: 1px solid var(--judgment-border); border-radius: 8px; }
    .visual-claim-judgment button:disabled { opacity: 0.65; cursor: not-allowed; }
    .visual-claim-judgment textarea { display: block; min-height: 60px; font: inherit; color: var(--judgment-text); background: var(--judgment-background); border: 1px solid var(--judgment-border); padding: 8px; }
    .visual-claim-judgment :focus-visible { outline: 2px solid var(--judgment-accent); outline-offset: 2px; }
  `;
}
