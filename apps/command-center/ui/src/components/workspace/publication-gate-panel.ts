import { html, nothing } from 'lit';

import {
  type PublicationGateInput,
  publicationGateView,
  visualPrevalidationLabel,
} from '@farmslot/review-dispatch';
import { publicationGateColors, skeletonTokens } from '@farmslot/theme';

import '../shared/skeleton.js';

import { fonts, radii, spacing } from '../../styles/theme-tokens.js';

import { renderVisualClaimJudgment, visualClaimJudgmentStyles } from './visual-claim-judgment.js';

export interface PublicationGatePanelInput extends PublicationGateInput {
  busy: boolean;
  pausedReason?: string;
  pausedRetry?: () => void;
  loading?: boolean;
  loadError?: string;
  retry?: () => void;
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
  const disabled = input.busy || Boolean(input.pausedReason);
  return html`<section
    class="publication-gate"
    aria-label="Publication decision"
    aria-busy=${String(Boolean(input.loading))}
    style=${`--gate-row-count:${view.claims.length}`}
  >
    <div class="gate-status" role=${input.loadError ? 'alert' : 'status'}>
      ${input.pausedReason
        ? html`<span class="gate-status-message">${input.pausedReason}</span>${input.pausedRetry
              ? html`<button class="gate-secondary" @click=${input.pausedRetry}>Retry</button>`
              : nothing}`
        : input.loadError
          ? html`<span class="gate-read-error" title=${input.loadError}>Evidence unavailable</span
              ><button class="gate-secondary" @click=${input.retry}>Retry</button>`
          : input.loading
            ? html`<farm-skeleton width="42%"></farm-skeleton>`
            : html`<span class="gate-status-message" title=${view.status}>${view.status}</span>`}
    </div>
    ${view.claims.length
      ? html`<section aria-label="Acceptance judgments">
          <h3>Acceptance judgments</h3>
          <ul class="gate-claims" tabindex="0" aria-label="Acceptance criteria">
            ${view.claims.map(
              (claim) =>
                html`<li data-gate-ac=${claim.id}>
                  <strong>${claim.id}</strong><span class="gate-claim-text">${claim.text}</span>
                  <span class="gate-state" data-pending=${claim.pending}>${claim.state}</span>
                  <button
                    class="gate-secondary"
                    type="button"
                    @click=${() => void input.focusClaim?.(claim.id)}
                  >
                    Review
                    evidence${claim.judgment?.media.clip
                      ? ` · ${Math.floor(claim.judgment.media.clip.startMs / 1000)}s`
                      : ''}<span class="gate-sr-only"> for ${claim.id}</span>
                  </button>
                  ${input.loading
                    ? renderGateJudgmentSkeleton()
                    : claim.judgment
                      ? renderVisualClaimJudgment({
                          row: claim.judgment,
                          busy: disabled || !input.recordReview,
                          reason: input.reviewReason?.(claim.id) ?? '',
                          changeReason: (reason) => input.changeReviewReason?.(claim.id, reason),
                          record: (verdict) => input.recordReview?.(claim.id, verdict),
                        })
                      : html`<span class="gate-prevalidation">${visualPrevalidationLabel()}</span>`}
                </li>`,
            )}
          </ul>
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
              ?disabled=${disabled}
              @input=${(event: Event) =>
                input.changeReason((event.target as HTMLTextAreaElement).value)}
            ></textarea>
          </label>
        </section>`
      : nothing}
    ${input.resolved
      ? nothing
      : html`<section class="gate-actions" aria-label="Publication actions">
          ${view.refreshRequired && input.refreshPackage
            ? html`<button
                class="gate-primary"
                type="button"
                ?disabled=${disabled}
                @click=${input.refreshPackage}
              >
                Refresh package
              </button>`
            : nothing}
          ${view.approval
            ? html`<button
                class="gate-primary"
                data-testid="gate-approve"
                type="button"
                ?disabled=${disabled || Boolean(view.blockedReason) || !view.approval}
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
              </button>`
            : nothing}
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
                      ?disabled=${disabled ||
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

export function publicationGatePanelStyles(scope = 'ready-workspace') {
  const variables = (mode: 'dark' | 'light') =>
    Object.entries(publicationGateColors[mode])
      .map(([name, value]) => `--gate-${name}: ${value};`)
      .join('') + `--skeleton-color:${skeletonTokens.colors[mode]};`;
  return `
    ready-workspace .publication-gate { ${variables('dark')}
      color: var(--gate-text); background: var(--gate-background);
      padding: ${spacing.lg}; border-bottom: 1px solid var(--gate-border);
      display: grid; gap: ${spacing.lg}; flex-shrink: 0; font-size: ${fonts.sizeMd}; line-height: 1.4;
    }
    @media (prefers-color-scheme: light) { ready-workspace .publication-gate { ${variables('light')} } }
    ready-workspace .publication-gate h3, ready-workspace .publication-gate p { margin: 0; }
    ready-workspace .publication-gate h3 { font-size: ${fonts.sizeSm}; margin-bottom: ${spacing.sm}; }
    ready-workspace .gate-status { font-size: ${fonts.sizeMd}; font-weight: 600; min-height: 44px; height: 44px; display: flex; align-items: center; gap: 12px; }
    ready-workspace .gate-status-message { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    ready-workspace .gate-read-error { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    ready-workspace .gate-status farm-skeleton { width: 100%; }
    ready-workspace .gate-claims { scroll-padding-block: 12px; list-style: none; margin: 0; padding: 0 0 12px; box-sizing: border-box; height: min(${skeletonTokens.gateViewport * 100}vh, calc(var(--gate-row-count) * ${skeletonTokens.gateRow}px)); overflow-y: auto; }
    ready-workspace .gate-claims li { display: grid; grid-template-columns: 56px minmax(160px, 1fr) auto auto; gap: ${spacing.lg}; align-items: center; padding: ${spacing.md} 0; border-top: 1px solid var(--gate-border); }
    ${visualClaimJudgmentStyles()}
    ready-workspace .gate-claim-text { overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    ready-workspace .gate-state { font-size: ${fonts.sizeSm}; border: 1px solid var(--gate-border); border-radius: ${radii.sm}; padding: ${spacing.sm} ${spacing.md}; white-space: nowrap; background: var(--gate-surface); }
    ready-workspace .gate-state[data-pending="true"] { color: var(--gate-warning); }
    ready-workspace .gate-attestation { display: grid; grid-template-columns: 1fr; gap: ${spacing.lg}; align-items: center; }
    ready-workspace .gate-attestation label { display: grid; gap: ${spacing.sm}; font-weight: 600; }
    ready-workspace .gate-more-actions summary { box-sizing: border-box; min-height: 44px; display: flex; align-items: center; cursor: pointer; color: var(--gate-secondary); padding: ${spacing.md}; }
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
    ready-workspace .gate-loading-row { min-height: 152px; box-sizing: border-box; }
    ready-workspace .gate-loading-judgment { grid-column: 1 / -1; display: grid; gap: 12px; }
    @media (max-width: 720px) { ready-workspace .gate-claims li { grid-template-columns: 56px minmax(0, 1fr); } ready-workspace .gate-state, ready-workspace .gate-claims li > button { grid-column: 2; justify-self: start; } ready-workspace .gate-attestation { grid-template-columns: 1fr; } }
  `.replaceAll('ready-workspace', scope);
}

function renderGateJudgmentSkeleton() {
  return html`<div class="gate-loading-judgment" aria-hidden="true">
    <farm-skeleton width="38%"></farm-skeleton><farm-skeleton width="24%"></farm-skeleton
    ><farm-skeleton kind="button" width="112px"></farm-skeleton>
  </div>`;
}
