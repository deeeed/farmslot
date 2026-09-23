import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { type DecisionAdviceResult, Methods, type RunDecision } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

import { supportsDecisionAdvice } from './decision-advice-model.js';

const unavailableReasons: Record<NonNullable<DecisionAdviceResult['reason']>, string> = {
  disabled: 'Optional decision advice is disabled.',
  'not-run-backed': 'This decision has no run context to assess.',
  'not-pending': 'This decision has already been resolved.',
  'insufficient-options': 'This decision has too few choices to compare.',
  'not-admitted': 'Decision evidence has not been admitted for assessment.',
  stale: 'The decision changed. Refresh its status.',
  'provider-unavailable': 'The configured assessment provider is unavailable.',
  'price-unavailable': 'The provider price is unavailable.',
  'budget-exhausted': 'The assessment budget is exhausted.',
  'assessment-unavailable': 'The assessment could not be completed.',
};

@customElement('decision-advice-panel')
export class DecisionAdvicePanel extends LitElement {
  @property() runId = '';
  @property({ attribute: false }) decision?: RunDecision;
  @property() snapshotKey = '';
  @state() private view?: DecisionAdviceResult;
  @state() private loading = false;
  @state() private error = '';
  private generation = 0;

  static styles = css`
    :host {
      display: block;
      margin: 12px 0 14px;
    }
    details {
      border: 1px solid var(--border-color, #374151);
      border-radius: 6px;
      padding: 10px 12px;
    }
    summary {
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    p {
      font-size: 12px;
      line-height: 1.5;
      margin: 7px 0;
    }
    small {
      color: var(--text-muted, #a6a6ba);
      display: block;
      line-height: 1.5;
    }
    button {
      color: inherit;
      background: #171727;
      border: 1px solid #555570;
      border-radius: 4px;
      font: inherit;
      font-size: 12px;
      margin: 8px 8px 4px 0;
      padding: 6px 10px;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .warning {
      color: var(--warning-color, #eab308);
    }
  `;

  protected override updated(changed: Map<string, unknown>) {
    if (changed.has('runId') || changed.has('snapshotKey')) {
      this.view = undefined;
      this.error = '';
      this.generation++;
      if (this.runId && this.decision && supportsDecisionAdvice(this.decision)) void this.load();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.generation++;
    this.loading = false;
  }

  private async load() {
    const decisionId = this.decision?.id;
    const runId = this.runId;
    const snapshotKey = this.snapshotKey;
    if (!decisionId || !this.decision || !supportsDecisionAdvice(this.decision)) return;
    const generation = ++this.generation;
    this.loading = true;
    this.error = '';
    try {
      const view = await gateway.request<DecisionAdviceResult>(Methods.DECISION_ADVICE_GET, {
        runId,
        decisionId,
      });
      if (
        generation === this.generation &&
        this.runId === runId &&
        this.snapshotKey === snapshotKey &&
        this.decision?.id === decisionId
      )
        this.view = view;
    } catch {
      if (generation === this.generation) this.error = 'Recommendation status could not be loaded.';
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }

  private async analyze() {
    const view = this.view;
    const runId = this.runId;
    const decisionId = this.decision?.id;
    const snapshotKey = this.snapshotKey;
    if (
      !view?.snapshotHash ||
      !view.eligible ||
      !decisionId ||
      !this.decision ||
      !supportsDecisionAdvice(this.decision)
    )
      return;
    const generation = ++this.generation;
    this.loading = true;
    this.error = '';
    try {
      const result = await gateway.request<DecisionAdviceResult>(
        Methods.DECISION_ADVICE_ANALYZE,
        {
          runId,
          decisionId,
          expectedSnapshotHash: view.snapshotHash,
        },
        60_000,
      );
      if (
        generation === this.generation &&
        this.runId === runId &&
        this.snapshotKey === snapshotKey &&
        this.decision?.id === decisionId
      ) {
        if (result.snapshotHash === view.snapshotHash && result.reason !== 'stale')
          this.view = result;
        else this.error = 'Decision changed while advice was running. Refresh its status.';
      }
    } catch {
      if (generation === this.generation)
        this.error = 'Advice could not be returned. Refresh its saved status before retrying.';
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }

  protected override render() {
    const decision = this.decision;
    if (!decision || !supportsDecisionAdvice(decision)) return nothing;
    const view = this.view;
    const selected = decision.actions.find((action) => action.id === view?.recommendedActionId);
    const answer = view?.assessment?.answers?.action;
    const confidence =
      answer?.type === 'choice'
        ? (answer.confidence ?? answer.probabilities?.[view?.recommendedActionId ?? 'abstain'])
        : undefined;
    const usage = view?.assessment?.usage;
    return html`<details open data-decision-advice>
      <summary>Optional decision recommendation</summary>
      ${this.error ? html`<p role="alert" class="warning">${this.error}</p>` : nothing}
      <p>
        ${this.loading
          ? 'Checking recommendation status…'
          : view?.reason
            ? unavailableReasons[view.reason]
            : view
              ? 'Review the existing decision actions below.'
              : 'Recommendation status has not loaded.'}
      </p>
      ${view?.assessment
        ? html`
            <p data-advice-result>
              ${selected
                ? `Suggested: ${selected.label}`
                : view.abstained
                  ? 'No recommendation. Review the available actions yourself.'
                  : `Assessment: ${view.assessment.status}`}
            </p>
            ${selected?.description ? html`<p>${selected.description}</p>` : nothing}
            ${selected || view.abstained
              ? html`<p>
                  Confidence:
                  ${confidence === undefined ? 'not reported' : `${Math.round(confidence * 100)}%`}.
                  This is advice, not a decision.
                </p>`
              : nothing}
            <small
              >${view.assessment.provider ?? 'Provider not reported'} /
              ${view.assessment.returnedModel ??
              view.assessment.requestedModel ??
              'model not reported'}</small
            >
            <small
              >${usage?.inputTokens ?? 'Unknown'} input tokens · ${usage?.outputTokens ?? 'unknown'}
              output tokens · ${usage?.durationMs ?? 'unknown'} ms</small
            >
            <small
              >Cost: ${usage?.costUsd === undefined ? 'unknown' : `$${usage.costUsd.toFixed(6)}`}
              ${usage?.costKind ?? ''}</small
            >
          `
        : nothing}
      <button ?disabled=${this.loading} @click=${() => this.load()}>Refresh status</button>
      <button
        data-advice-action="analyze"
        ?disabled=${this.loading || !view?.eligible || !view.snapshotHash}
        @click=${this.analyze}
      >
        Get recommendation
      </button>
      <small>Requires an explicit request. No action is selected or resolved for you.</small>
    </details>`;
  }
}
