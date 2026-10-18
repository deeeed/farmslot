import { html, nothing } from 'lit';

import {
  resultDecisionActionReady,
  type ResultDecisionActionView,
  type ResultDecisionView,
} from '@farmslot/review-dispatch';

export interface ResultDecisionPanelInput {
  view: ResultDecisionView;
  /** The written reason typed so far. */
  reason: string;
  /** Actions wait while another request runs or the run is not loaded. */
  blocked: boolean;
  /** Why the resource-posture choice blocks resolving, or null. */
  blockedReason: string | null;
  /** The action awaiting its second click. */
  confirming: string | null;
  onReason: (reason: string) => void;
  onAction: (action: ResultDecisionActionView) => void;
}

function renderAction(action: ResultDecisionActionView, input: ResultDecisionPanelInput) {
  const ready =
    !input.blocked && !input.blockedReason && resultDecisionActionReady(action, input.reason);
  return html`<div class="rd-action" data-testid=${`result-action-${action.id}`}>
    ${action.available && action.requiresReason
      ? html`<textarea
          data-testid="result-accept-reason"
          aria-label="Why accept this result"
          placeholder="Why accept this result"
          .value=${input.reason}
          @input=${(event: Event) => input.onReason((event.target as HTMLTextAreaElement).value)}
        ></textarea>`
      : nothing}
    <button
      class=${action.style}
      ?disabled=${!ready}
      title=${input.blockedReason ?? ''}
      @click=${() => input.onAction(action)}
    >
      ${input.confirming === action.id ? `Confirm ${action.label}?` : action.label}
    </button>
    ${action.available
      ? action.note
        ? html`<span class="rd-note">${action.note}</span>`
        : nothing
      : html`<span class="rd-unavailable">${action.unavailableReason}</span>`}
  </div>`;
}

/** The result decision panel's markup, kept apart from the element so tests render it in node. */
export function renderResultDecisionPanel(input: ResultDecisionPanelInput) {
  const { reason, detail, delivered, actions } = input.view;
  return html`
    <p class="rd-reason" data-testid="result-reason">${reason}</p>
    <p class="rd-delivered" data-testid="result-delivered">
      ${delivered.label} <code>${delivered.value}</code>
    </p>
    ${detail
      ? html`<details open data-testid="result-detail">
          <summary>${detail.title}</summary>
          <ul>
            ${detail.items.map(
              (item) =>
                html`<li class="rd-item">
                  ${item.location
                    ? html`<code>${item.location}</code> `
                    : nothing}${item.description}
                </li>`,
            )}
          </ul>
        </details>`
      : nothing}
    <div class="rd-actions">${actions.map((action) => renderAction(action, input))}</div>
  `;
}
