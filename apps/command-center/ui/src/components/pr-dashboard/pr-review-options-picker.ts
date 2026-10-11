import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import {
  DEFAULT_PR_REVIEW_OPTIONS,
  type ProjectQaConfig,
  type PRReviewOptions,
  prReviewWorkflow,
} from '@farmslot/protocol';

import { qaInputFieldStyles } from '../shared/qa-input-fields.js';
import { renderQaProfileControl } from '../shared/qa-profile-control.js';

import { prAutomationStyles } from './pr-automation-styles.js';

@customElement('pr-review-options-picker')
export class PRReviewOptionsPicker extends LitElement {
  @property({ attribute: false }) value: PRReviewOptions = { ...DEFAULT_PR_REVIEW_OPTIONS };
  @property({ type: Boolean }) disabled = false;
  @property({ attribute: false }) qa?: ProjectQaConfig;
  @property() testIdPrefix = 'pr-review';
  static styles = [
    prAutomationStyles,
    qaInputFieldStyles,
    css`
      [hidden] {
        display: none;
      }
    `,
  ];
  private change(patch: Partial<PRReviewOptions>) {
    const next = { ...this.value, workflow: prReviewWorkflow(this.value), ...patch };
    if (next.workflow === 'qa') {
      delete next.publishReview;
      delete next.autoFinish;
    }
    if (next.workflow === 'review') {
      delete next.qaProfileId;
      delete next.qaInputs;
    }
    this.dispatchEvent(
      new CustomEvent('review-options-change', {
        detail: next,
        bubbles: true,
        composed: true,
      }),
    );
  }
  render() {
    const qa = prReviewWorkflow(this.value) === 'qa';
    return html`<fieldset ?disabled=${this.disabled}>
      <div class="grid">
        <fieldset>
          <legend>Workflow</legend>
          <div class="row">
            <button
              type="button"
              data-testid="pr-review-workflow-review"
              aria-pressed=${String(prReviewWorkflow(this.value) === 'review')}
              @click=${() => this.change({ workflow: 'review' })}
            >
              Review
            </button>
            <button
              type="button"
              data-testid="pr-review-workflow-qa"
              aria-pressed=${String(prReviewWorkflow(this.value) === 'qa')}
              @click=${() => this.change({ workflow: 'qa' })}
            >
              QA
            </button>
          </div>
          ${prReviewWorkflow(this.value) === 'qa'
            ? html`
                ${renderQaProfileControl({
                  config: this.qa,
                  value: this.value.qaProfileId,
                  disabled: this.disabled,
                  testId: 'pr-review-qa-profile',
                  change: (id) =>
                    this.change({ qaProfileId: id || undefined, qaInputs: undefined }),
                  inputs: this.value.qaInputs,
                  changeInputs: (qaInputs) => this.change({ qaInputs }),
                })}
                <p class="muted">QA runs the farm's validation skill and requires runtime proof.</p>
              `
            : html`<p class="muted">
                Static review uses an isolated workspace without a device slot.
              </p>`}
        </fieldset>
        <label ?hidden=${qa}>
          <input
            type="checkbox"
            data-testid="pr-review-auto-finish"
            .checked=${this.value.autoFinish === true}
            @change=${(event: Event) =>
              this.change({
                autoFinish: (event.target as HTMLInputElement).checked,
                ...((event.target as HTMLInputElement).checked ? { publishReview: true } : {}),
              })}
          />
          Publish and finish automatically
        </label>
        <label ?hidden=${qa}>
          Publication
          <select
            data-testid=${`${this.testIdPrefix}-publication`}
            .value=${this.value.publishReview === undefined
              ? 'inherit'
              : this.value.publishReview
                ? 'publish'
                : 'results-only'}
            @change=${(event: Event) => {
              const choice = (event.target as HTMLSelectElement).value;
              this.change({
                publishReview: choice === 'inherit' ? undefined : choice === 'publish',
              });
            }}
          >
            <option value="inherit">Inherit policy</option>
            <option value="publish">Publish review to PR</option>
            <option value="results-only">Farmslot results only</option>
          </select>
        </label>
      </div>
    </fieldset>`;
  }
}
