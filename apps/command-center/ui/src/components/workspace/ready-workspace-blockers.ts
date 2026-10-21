import { html, nothing } from 'lit';

import type { ReviewRoundBudget } from '@farmslot/protocol';
import {
  anotherReviewRoundView,
  type PublicationBlocker,
  untestableOverrideView,
} from '@farmslot/review-dispatch';

import { fonts, spacing } from '../../styles/theme-tokens.js';
import { renderReasonSheet } from '../shared/reason-sheet.js';

/** The reason sheet open under one blocker: skipping a criterion, or one more review round. */
export type ReadyBlockerSheet =
  | { kind: 'skip-criterion'; claimId: string; text: string }
  | { kind: 'another-round'; text: string };

export interface ReadyBlockersInput {
  blockers: readonly PublicationBlocker[];
  sheet: ReadyBlockerSheet | null;
  budget?: Pick<ReviewRoundBudget, 'used' | 'limit'>;
  busy: boolean;
  /** Opens the blocker's sheet, or the gate's accept-findings flow. */
  choose: (blocker: PublicationBlocker) => void;
  changeSheet: (text: string) => void;
  cancelSheet: () => void;
  skip: (claimId: string, reason: string) => void;
  anotherRound: (brief: string) => void;
}

function renderBlockerSheet(input: ReadyBlockersInput, blocker: PublicationBlocker) {
  const { sheet, action } = { sheet: input.sheet, action: blocker.action };
  if (!sheet || !action || sheet.kind !== action.kind) return nothing;
  if (sheet.kind === 'skip-criterion' && action.kind === 'skip-criterion') {
    if (sheet.claimId !== action.claimId) return nothing;
    const view = untestableOverrideView(sheet.claimId, sheet.text);
    return renderReasonSheet({
      title: view.title,
      hint: view.hint,
      label: view.reasonLabel,
      placeholder: view.placeholder,
      value: sheet.text,
      confirmLabel: view.confirm,
      cancelLabel: view.cancel,
      canConfirm: view.canConfirm,
      busy: input.busy,
      testId: 'blocker-skip',
      change: input.changeSheet,
      confirm: () => input.skip(sheet.claimId, sheet.text),
      cancel: input.cancelSheet,
    });
  }
  if (sheet.kind !== 'another-round' || !input.budget) return nothing;
  const view = anotherReviewRoundView(input.budget, sheet.text);
  return renderReasonSheet({
    title: view.title,
    hint: view.hint,
    label: view.reasonLabel,
    placeholder: view.placeholder,
    value: sheet.text,
    confirmLabel: view.confirm,
    cancelLabel: view.cancel,
    canConfirm: view.canConfirm,
    busy: input.busy,
    testId: 'blocker-round',
    change: input.changeSheet,
    confirm: () => input.anotherRound(sheet.text),
    cancel: input.cancelSheet,
  });
}

/** What blocks publish, at the top of the gate: each blocker with its one plain action. */
export function renderReadyBlockers(input: ReadyBlockersInput) {
  if (!input.blockers.length) return nothing;
  return html`<section
    class="rdy-blockers"
    aria-label="What's blocking publish"
    data-testid="rdy-blockers"
  >
    <h3>What's blocking publish</h3>
    <ul>
      ${input.blockers.map(
        (blocker) =>
          html`<li data-blocker=${blocker.key}>
            <div class="rdy-blocker-row">
              <span>${blocker.message}</span>
              ${blocker.action
                ? html`<button
                    type="button"
                    class="gate-secondary"
                    data-testid=${`blocker-${blocker.action.kind}`}
                    ?disabled=${input.busy}
                    @click=${() => input.choose(blocker)}
                  >
                    ${blocker.action.label}
                  </button>`
                : nothing}
            </div>
            ${renderBlockerSheet(input, blocker)}
          </li>`,
      )}
    </ul>
  </section>`;
}

export function readyBlockersStyles(): string {
  return `
    ready-workspace .rdy-blockers { flex-shrink: 0; display: grid; gap: ${spacing.sm}; padding: ${spacing.md} ${spacing.lg}; color: var(--gate-text); background: var(--gate-background); border-bottom: 1px solid var(--gate-border); font-size: ${fonts.sizeMd}; }
    ready-workspace .rdy-blockers h3 { margin: 0; font-size: ${fonts.sizeSm}; color: var(--gate-warning); }
    ready-workspace .rdy-blockers ul { list-style: none; margin: 0; padding: 0; display: grid; gap: ${spacing.sm}; }
    ready-workspace .rdy-blocker-row { display: flex; flex-wrap: wrap; align-items: center; gap: ${spacing.md}; }
    ready-workspace .rdy-blocker-row > span { flex: 0 1 auto; min-width: 0; max-width: 72ch; overflow-wrap: anywhere; }
  `;
}
