import { html, nothing } from 'lit';

import { type PublicationGateInput, publicationGateView } from '@farmslot/review-dispatch';
import { publicationGateCssVariables } from '@farmslot/theme';

import { fonts, radii, spacing } from '../../styles/theme-tokens.js';
import {
  acceptanceClaimListStyles,
  renderAcceptanceClaimList,
} from '../progress-tracker/acceptance-claim-list.js';

export interface PublicationGatePanelInput extends PublicationGateInput {
  busy: boolean;
  showClaims?: boolean;
  feedback?: import('@farmslot/review-dispatch').VisualJudgmentFeedback;
  reviewReason?: (id: string) => string;
  changeReviewReason?: (id: string, reason: string) => void;
  recordReview?: (id: string, verdict: 'confirmed' | 'rejected') => void;
  refreshPackage?: () => void;
  pendingConfirm: string | null;
  reviewDisabled: boolean;
  changeReason: (reason: string) => void;
  chooseAttestation: () => void;
  focusClaim?: (id: string) => void | Promise<void>;
  invoke: (id: string) => void;
  requestReview: () => void;
}

export function renderPublicationGatePanel(input: PublicationGatePanelInput) {
  const view = publicationGateView(input);
  return html`<section class="publication-gate" aria-label="Publication decision">
    ${input.showClaims !== false && view.claims.length
      ? html`<section aria-label="Acceptance judgments">
          <h3>Acceptance judgments</h3>
          ${renderAcceptanceClaimList(view.claims, input)}
        </section>`
      : nothing}
    ${view.attestation && input.attesting
      ? html`<section class="gate-attestation" aria-label="Evidence attestation">
          <label
            >Reason for evidence policy attestation
            <textarea
              data-testid="evidence-attestation-reason"
              aria-label="Reason for evidence policy attestation"
              .value=${input.attestationReason ?? ''}
              ?disabled=${input.busy}
              @input=${(event: Event) =>
                input.changeReason((event.target as HTMLTextAreaElement).value)}
            ></textarea>
          </label>
        </section>`
      : nothing}
    ${input.resolved
      ? nothing
      : html`<section class="gate-actions" aria-label="Publication actions">
          <p class="gate-status" role="status">
            ${input.busy
              ? input.feedback
                ? 'Saving judgment and refreshing…'
                : 'Submitting…'
              : view.status}
          </p>
          ${view.refreshRequired && input.refreshPackage
            ? html`<button
                class="gate-primary"
                type="button"
                ?disabled=${input.busy}
                @click=${input.refreshPackage}
              >
                Refresh package
              </button>`
            : nothing}
          <button
            class="gate-primary"
            data-testid="gate-approve"
            type="button"
            ?disabled=${input.busy || Boolean(view.blockedReason) || !view.approval}
            title=${view.blockedReason}
            @click=${() => view.approval && input.invoke(view.approval.id)}
          >
            ${input.busy
              ? 'Submitting…'
              : input.pendingConfirm === view.approval?.id
                ? view.attestation
                  ? 'Confirm attestation and publish?'
                  : 'Confirm Publish?'
                : (view.approval?.label ?? 'Approve publish')}
          </button>
          ${view.attestation || view.secondaryActions.length
            ? html`<details class="gate-more-actions">
                <summary>More actions</summary>
                ${view.attestation && !input.attesting
                  ? html`<button
                      class="gate-secondary"
                      title=${view.attestation.description ?? ''}
                      @click=${input.chooseAttestation}
                    >
                      Attest evidence
                    </button>`
                  : nothing}
                ${view.secondaryActions.map(
                  (action) =>
                    html`<button
                      class="gate-secondary"
                      type="button"
                      data-action=${action.id}
                      data-testid=${action.id === 'request-review' ? 'rdy-request-review' : nothing}
                      title=${action.description ?? ''}
                      ?disabled=${input.busy ||
                      Boolean(action.disabledReason) ||
                      (action.id === 'request-review' && input.reviewDisabled)}
                      @click=${() =>
                        action.id === 'request-review'
                          ? input.requestReview()
                          : input.invoke(action.id)}
                    >
                      ${input.pendingConfirm === action.id
                        ? `Confirm ${action.label}?`
                        : action.label}
                    </button>`,
                )}
              </details>`
            : nothing}
        </section>`}
  </section>`;
}

export function publicationGatePanelStyles() {
  return `
    ready-workspace { ${publicationGateCssVariables('dark')} }
    @media (prefers-color-scheme: light) { ready-workspace { ${publicationGateCssVariables('light')} } }
    ready-workspace .publication-gate { ${publicationGateCssVariables('dark')}
      color: var(--gate-text); background: var(--gate-background);
      padding: ${spacing.md} ${spacing.lg}; border-top: 1px solid var(--gate-border);
      position: sticky; bottom: 0; z-index: 2; display: grid; gap: ${spacing.lg}; flex-shrink: 0; font-size: ${fonts.sizeMd}; line-height: 1.4;
    }
    @media (prefers-color-scheme: light) { ready-workspace .publication-gate { ${publicationGateCssVariables('light')} } }
    ready-workspace .publication-gate h3, ready-workspace .publication-gate p { margin: 0; }
    ready-workspace .publication-gate h3 { font-size: ${fonts.sizeSm}; margin-bottom: ${spacing.sm}; }
    ready-workspace .gate-status { flex: 1; min-width: 120px; font-size: ${fonts.sizeMd}; font-weight: 600; }
    ${acceptanceClaimListStyles()}
    ready-workspace .gate-attestation { display: grid; grid-template-columns: 1fr; gap: ${spacing.lg}; align-items: center; }
    ready-workspace .gate-attestation label { display: grid; gap: ${spacing.sm}; font-weight: 600; }
    ready-workspace .gate-more-actions summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; color: var(--gate-secondary); padding: ${spacing.md}; }
    ready-workspace .gate-attestation textarea { font: inherit; min-height: 64px; padding: ${spacing.md}; color: var(--gate-text); background: var(--gate-surface); border: 1px solid var(--gate-border); border-radius: ${radii.md}; resize: vertical; }
    ready-workspace .gate-actions { display: flex; align-items: center; flex-wrap: wrap; gap: ${spacing.md}; }
    ready-workspace .gate-primary, ready-workspace .gate-secondary { min-height: 44px; min-width: 44px; font: inherit; font-weight: 600; border-radius: ${radii.md}; padding: ${spacing.md} ${spacing.lg}; cursor: pointer; }
    ready-workspace .gate-primary { border: 1px solid var(--gate-accent); background: var(--gate-accent); color: var(--gate-onAccent); }
    ready-workspace .gate-secondary { border: 1px solid var(--gate-border); background: var(--gate-surface); color: var(--gate-text); }
    ready-workspace .publication-gate button:disabled { opacity: 0.65; cursor: not-allowed; }
    ready-workspace .publication-gate :focus-visible { outline: 2px solid var(--gate-accent); outline-offset: 2px; }
    ready-workspace .rdy-review-content { flex: 1; min-height: 0; overflow: auto; }
    ready-workspace .rdy-gate-details, ready-workspace .rdy-review-content { padding: ${spacing.md} ${spacing.lg}; }
    ready-workspace .rdy-gate-details > summary, ready-workspace .rdy-review-content > summary, ready-workspace .rdy-package-details > summary { cursor: pointer; padding: ${spacing.md}; min-height: 44px; display: flex; align-items: center; }
    ready-workspace .gate-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    ready-workspace .rdy-tab-bar[role="tablist"] { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) auto; gap: 4px; background: var(--gate-background); }
    ready-workspace .rdy-tab-bar[role="tablist"] .rdy-tab { min-height: 44px; min-width: 44px; padding: 8px; font-size: ${fonts.sizeSm}; color: var(--gate-text); }
    ready-workspace .gate-extra-tabs > summary { min-height: 44px; padding: 8px; display: flex; align-items: center; cursor: pointer; }
    @media (max-width: 720px) { ready-workspace .rdy-tab-bar[role="tablist"] { grid-template-columns: repeat(4, minmax(0, 1fr)); } ready-workspace .gate-extra-tabs { grid-column: 1 / -1; } }
    @media (max-width: 720px) { ready-workspace .gate-attestation { grid-template-columns: 1fr; } }
  `;
}
