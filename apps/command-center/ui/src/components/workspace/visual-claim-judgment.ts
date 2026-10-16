import { html, nothing } from 'lit';

import type { EvidenceReviewJudgmentRow } from '@farmslot/adapter-sdk/evidence';
import { publicationGateColors } from '@farmslot/theme';

export interface VisualClaimJudgmentInput {
  row: EvidenceReviewJudgmentRow;
  busy?: boolean;
  reason: string;
  changeReason: (reason: string) => void;
  record: (verdict: 'confirmed' | 'rejected') => void;
}

/** Both the gate and Compare by AC use the same judgment controls. */
export function renderVisualClaimJudgment(input: VisualClaimJudgmentInput) {
  const { row } = input;
  const delegated = row.reviewKind === 'lead-agent-reviewed';
  const pending =
    row.claim.status?.verdict === 'awaiting-review' &&
    ['visual', 'mixed'].includes(row.claim.status.proofMode ?? '');
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
  return html`<div class="visual-claim-judgment" data-visual-review=${row.claim.id}>
    <p class="gate-prevalidation">
      ${row.prevalidation
        ? html`<strong
              >Agent review ·
              ${row.prevalidation.verdict === 'confirmed' ? 'Looks right' : 'Issue'}</strong
            >
            <span>${row.prevalidation.reason}</span><span>${row.prevalidation.reviewer}</span>`
        : html`<span>Agent review · Not recorded</span>`}
    </p>
    ${row.claim.reviewLabels.length
      ? html`<span>${row.claim.reviewLabels.join(' · ')}</span>`
      : nothing}
    ${row.claim.proofKinds.includes('assertion')
      ? html`<span class="gate-check">Recorded checks</span>`
      : nothing}
    ${row.reviewKind || pending
      ? html`<div class="gate-judgment-actions">
          ${delegated ? rationale : nothing}
          <button
            class="gate-secondary"
            type="button"
            data-review-verdict="confirmed"
            ?disabled=${input.busy || !row.reviewKind || (delegated && !input.reason.trim())}
            @click=${() => input.record('confirmed')}
          >
            Looks right
          </button>
          ${!row.reviewKind
            ? html`<button class="gate-secondary" disabled type="button">Issue</button>`
            : html`<details class="gate-issue">
                <summary>Issue</summary>
                ${delegated ? nothing : rationale}
                <button
                  class="gate-secondary"
                  type="button"
                  data-review-verdict="rejected"
                  ?disabled=${input.busy || !input.reason.trim()}
                  @click=${() => input.record('rejected')}
                >
                  Record issue
                </button>
              </details>`}
        </div>`
      : nothing}
  </div>`;
}

export function visualClaimJudgmentStyles() {
  const vars = (mode: 'light' | 'dark') =>
    Object.entries(publicationGateColors[mode])
      .map(([key, value]) => `--judgment-${key}:${value};`)
      .join('');
  return `
    .visual-claim-judgment { ${vars('dark')} grid-column: 1 / -1; display: grid; gap: 8px; color: var(--judgment-text); }
    @media (prefers-color-scheme: light) { .visual-claim-judgment { ${vars('light')} } }
    .visual-claim-judgment .gate-prevalidation { display: grid; gap: 4px; margin: 0; }
    .visual-claim-judgment .gate-check { color: var(--judgment-secondary); }
    .gate-judgment-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: start; }
    .gate-issue summary, .visual-claim-judgment button { box-sizing: border-box; min-height: 44px; min-width: 44px; padding: 12px 16px; cursor: pointer; font: inherit; }
    .visual-claim-judgment button { color: var(--judgment-text); background: var(--judgment-surface); border: 1px solid var(--judgment-border); border-radius: 8px; }
    .visual-claim-judgment button:disabled { opacity: 0.65; cursor: not-allowed; }
    .visual-claim-judgment textarea { display: block; min-height: 60px; font: inherit; color: var(--judgment-text); background: var(--judgment-background); border: 1px solid var(--judgment-border); padding: 8px; }
    .visual-claim-judgment :focus-visible { outline: 2px solid var(--judgment-accent); outline-offset: 2px; }
  `;
}
