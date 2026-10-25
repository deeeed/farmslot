import { html, nothing, type TemplateResult } from 'lit';

import { type AcceptanceClaimRow, type VisualJudgmentFeedback } from '@farmslot/review-dispatch';
import { publicationGateCssVariables } from '@farmslot/theme';

import { fonts, radii, spacing } from '../../styles/theme-tokens.js';
import {
  renderVisualClaimJudgment,
  visualClaimJudgmentStyles,
} from '../workspace/visual-claim-judgment.js';

export interface AcceptanceClaimListActions {
  busy?: boolean;
  feedback?: VisualJudgmentFeedback;
  reviewReason?: (id: string) => string;
  changeReviewReason?: (id: string, reason: string) => void;
  recordReview?: (id: string, verdict: 'confirmed' | 'rejected') => void;
  focusClaim?: (id: string) => void | Promise<void>;
  /** False hides a row's Review evidence: there is nothing for it to open. */
  canFocus?: (id: string) => boolean;
  details?: (id: string) => TemplateResult | typeof nothing;
}

/** The same AC rows appear at the gate, in its preview and beside evidence. */
export function renderAcceptanceClaimList(
  rows: readonly AcceptanceClaimRow[],
  actions: AcceptanceClaimListActions,
) {
  return html`<ul
    class="acceptance-claim-list gate-claims"
    tabindex="0"
    aria-label="Acceptance criteria"
  >
    ${rows.map((claim) => {
      const verdict =
        claim.source?.status?.verdict ??
        (claim.source?.evidenceLinked ? 'evidence-linked' : 'none');
      const visual = claim.judgment?.claim.status?.proofMode !== 'state';
      return html`<li
        class="ac-row ac-${verdict}"
        data-testid="acceptance-row"
        data-gate-ac=${claim.id}
        data-ac-id=${claim.id}
        data-ac-verdict=${verdict}
      >
        <strong class="ac-id">${claim.id}</strong>
        <details class="gate-claim-text">
          <summary class="ac-text" title=${claim.text}>${claim.text}</summary>
          ${claim.detail ? html`<p>${claim.detail}</p>` : nothing}
          ${claim.origin
            ? html`<p data-testid="acceptance-origin" data-source-id=${claim.origin.reference}>
                ${claim.origin.url
                  ? html`<a href=${claim.origin.url} target="_blank" rel="noopener noreferrer"
                      >${claim.origin.label}</a
                    >`
                  : claim.origin.label}
                ${claim.origin.body
                  ? html`<span>${claim.origin.body}</span>`
                  : html`<span>${claim.origin.reference}</span>`}
              </p>`
            : nothing}
        </details>
        ${html`<span
          class="gate-state ac-verdict"
          data-state=${claim.tone}
          title=${claim.detail}
          role="status"
          >${claim.state}</span
        >`}
        ${actions.canFocus?.(claim.id) === false
          ? nothing
          : html`<button
              class="gate-secondary"
              type="button"
              ?disabled=${!actions.focusClaim}
              @click=${() => void actions.focusClaim?.(claim.id)}
            >
              Review
              evidence${claim.judgment?.media.clip
                ? ` · ${Math.floor(claim.judgment.media.clip.startMs / 1000)}s`
                : ''}<span class="gate-sr-only"> for ${claim.id}</span>
            </button>`}
        ${claim.judgment && visual
          ? renderVisualClaimJudgment({
              row: claim.judgment,
              busy: actions.busy || !actions.recordReview,
              feedback: actions.feedback,
              reason: actions.reviewReason?.(claim.id) ?? '',
              changeReason: (reason) => actions.changeReviewReason?.(claim.id, reason),
              record: (verdict) => actions.recordReview?.(claim.id, verdict),
            })
          : nothing}
        ${actions.details
          ? html`<div class="acceptance-claim-details">${actions.details(claim.id)}</div>`
          : nothing}
      </li>`;
    })}
  </ul>`;
}

export function acceptanceClaimListStyles() {
  return `
    .acceptance-claim-list { ${publicationGateCssVariables('dark')} color: var(--gate-text); font-size: ${fonts.sizeMd}; line-height: 1.4; scroll-padding-block: 12px; list-style: none; margin: 0; padding: 0; }
    @media (prefers-color-scheme: light) { .acceptance-claim-list { ${publicationGateCssVariables('light')} } }
    .acceptance-claim-list li { display: grid; grid-template-columns: 50px minmax(160px, 1fr) auto auto auto; gap: ${spacing.md}; align-items: center; padding: ${spacing.sm} 0; border-top: 1px solid var(--gate-border); }
    .acceptance-claim-list .ac-id { width: auto; color: var(--gate-secondary); font-family: ${fonts.mono}; }
    .acceptance-claim-list .gate-claim-text { overflow-wrap: anywhere; color: var(--gate-text); min-width: 0; }
    .gate-claim-text summary { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; cursor: pointer; min-height: 44px; align-content: center; }
    .gate-claim-text[open] summary { display: block; -webkit-line-clamp: unset; }
    .gate-claim-text p { margin: 0; padding: 4px 0; }
    .acceptance-claim-list .gate-state { display: inline-flex; align-items: center; gap: 6px; justify-self: start; color: var(--gate-text); font-size: ${fonts.sizeSm}; font-weight: 600; border: 0; border-radius: 999px; padding: 2px 10px; white-space: nowrap; background: var(--gate-surface); text-transform: none; cursor: default; }
    .acceptance-claim-list .gate-state::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    ${['proven', 'verified', 'checked', 'issue', 'pending', 'untestable'].map((tone) => `.acceptance-claim-list .gate-state[data-state="${tone}"] { color: var(--gate-${tone}); background: var(--gate-${tone}Surface); }`).join('')}
    .acceptance-claim-list .gate-state[data-state="checked"] { animation: gate-checked 0.25s ease-out; }
    @keyframes gate-checked { from { opacity: 0.5; transform: translateY(3px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .acceptance-claim-list .gate-state { animation: none !important; } }
    .acceptance-claim-list .gate-secondary { min-height: 44px; min-width: 44px; font: inherit; font-weight: 600; border: 1px solid var(--gate-border); border-radius: ${radii.md}; padding: ${spacing.md} ${spacing.lg}; background: var(--gate-surface); color: var(--gate-text); cursor: pointer; }
    .acceptance-claim-list button:disabled { opacity: 0.65; cursor: not-allowed; }
    .acceptance-claim-list :focus-visible { outline: 2px solid var(--gate-accent); outline-offset: 2px; }
    .acceptance-claim-list .gate-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
    .acceptance-claim-details { grid-column: 1 / -1; min-width: 0; }
    .acceptance-claim-details summary, .acceptance-claim-details button { min-height: 44px; min-width: 44px; cursor: pointer; }
    @media (max-width: 1000px) { .acceptance-claim-list li { grid-template-columns: 44px minmax(0,1fr) auto; gap: ${spacing.sm}; } .acceptance-claim-list li > button { grid-column: 2; justify-self: start; } }
    @media (max-width: 520px) { .acceptance-claim-list li { grid-template-columns: 40px minmax(0,1fr); } .acceptance-claim-list .gate-state { grid-column: 2; justify-self: start; } .acceptance-claim-list .visual-claim-judgment { grid-column: 2; } }
    ${visualClaimJudgmentStyles()}
  `;
}
