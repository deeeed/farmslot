import { css, LitElement, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { ResultDecisionActionView, ResultDecisionView } from '@farmslot/review-dispatch';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

import { renderResultDecisionPanel } from './result-decision-panel-template.js';

export interface ResultDecisionActionDetail {
  actionId: ResultDecisionActionView['id'];
  reason: string;
}

/**
 * A run held `needs-decision` (ADR-065 Amendment 7): why it stopped, its findings or
 * refused prerequisite, what it delivered, and the three actions from the shared view.
 * Unavailable actions stay visible with their reason; Accept takes a written reason.
 */
@customElement('result-decision-panel')
export class ResultDecisionPanel extends LitElement {
  static styles = css`
    :host {
      display: block;
      font-size: 13px;
      line-height: 1.5;
    }
    .rd-reason {
      margin: 0 0 ${unsafeCSS(spacing.sm)};
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .rd-delivered {
      margin: 0 0 ${unsafeCSS(spacing.sm)};
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .rd-delivered code,
    .rd-item code {
      font-family: ${unsafeCSS(fonts.mono)};
      color: ${unsafeCSS(colors.textSecondary)};
    }
    details > summary {
      min-height: 44px;
      box-sizing: border-box;
      padding-block: 12px;
      cursor: pointer;
      font-weight: 700;
    }
    ul {
      margin: 0;
      padding: 0 0 ${unsafeCSS(spacing.sm)};
      list-style: none;
    }
    .rd-item {
      padding: 4px 0;
      border-top: 1px solid ${unsafeCSS(colors.textMuted)}44;
      overflow-wrap: anywhere;
    }
    .rd-actions {
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSS(spacing.sm)};
      margin-top: ${unsafeCSS(spacing.sm)};
    }
    .rd-action {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: ${unsafeCSS(spacing.sm)};
    }
    button {
      min-height: 44px;
      padding: 0 ${unsafeCSS(spacing.md)};
      border: 1px solid ${unsafeCSS(colors.textMuted)};
      border-radius: ${unsafeCSS(radii.sm)};
      background: transparent;
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button.primary {
      background: ${unsafeCSS(colors.accent)};
      border-color: ${unsafeCSS(colors.accent)};
      color: #fff;
    }
    button.danger {
      border-color: ${unsafeCSS(colors.statusFail)};
      color: ${unsafeCSS(colors.statusFail)};
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .rd-note,
    .rd-unavailable {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    textarea {
      width: 100%;
      min-height: 44px;
      box-sizing: border-box;
      padding: ${unsafeCSS(spacing.sm)};
      border: 1px solid ${unsafeCSS(colors.textMuted)}44;
      border-radius: ${unsafeCSS(radii.sm)};
      background: transparent;
      color: ${unsafeCSS(colors.textPrimary)};
      font: inherit;
    }
  `;

  @property({ attribute: false }) view!: ResultDecisionView;
  /** Actions wait while another request runs or the run is not loaded. */
  @property({ type: Boolean }) blocked = false;
  /** Why the resource-posture choice blocks resolving, or null. */
  @property({ attribute: false }) blockedReason: string | null = null;
  /** The action awaiting its second click. */
  @property({ attribute: false }) confirming: string | null = null;
  @state() private reason = '';

  protected override willUpdate(changed: Map<string, unknown>): void {
    const previous = changed.get('view') as ResultDecisionView | undefined;
    if (previous && previous.decisionId !== this.view.decisionId) this.reason = '';
  }

  private send(action: ResultDecisionActionView) {
    this.dispatchEvent(
      new CustomEvent<ResultDecisionActionDetail>('result-decision-action', {
        detail: { actionId: action.id, reason: this.reason },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    return renderResultDecisionPanel({
      view: this.view,
      reason: this.reason,
      blocked: this.blocked,
      blockedReason: this.blockedReason,
      confirming: this.confirming,
      onReason: (reason) => {
        this.reason = reason;
      },
      onAction: (action) => this.send(action),
    });
  }
}
