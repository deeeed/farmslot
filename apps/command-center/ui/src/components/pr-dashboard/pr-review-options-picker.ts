import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import {
  DEFAULT_PR_REVIEW_OPTIONS,
  type ProjectQaConfig,
  type PRReviewOptions,
  prReviewWorkflow,
} from '@farmslot/protocol';

import { prAutomationStyles } from './pr-automation-styles.js';

@customElement('pr-review-options-picker')
export class PRReviewOptionsPicker extends LitElement {
  @property({ attribute: false }) value: PRReviewOptions = { ...DEFAULT_PR_REVIEW_OPTIONS };
  @property({ type: Boolean }) disabled = false;
  @property({ attribute: false }) qa?: ProjectQaConfig;
  @property() testIdPrefix = 'pr-review';
  @property() presentation: 'all' | 'workflow' | 'reviewer' = 'all';
  static styles = [
    prAutomationStyles,
    css`
      [hidden] {
        display: none;
      }
    `,
  ];
  private change(patch: Partial<PRReviewOptions>) {
    const { validationDepth: _legacyDepth, ...current } = this.value;
    const next = { ...current, workflow: prReviewWorkflow(this.value), ...patch };
    if (next.workflow === 'qa') delete next.publishReview;
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
    if (qa && this.presentation === 'reviewer') return html``;
    return html`<fieldset ?disabled=${this.disabled}>
      <div class="grid">
        <fieldset ?hidden=${this.presentation === 'workflow' || qa}>
          <legend>Reviewer session</legend>
          <div class="row">
            <button
              type="button"
              aria-pressed=${String(this.value.sessionIntent === 'resume')}
              @click=${() => this.change({ sessionIntent: 'resume' })}
            >
              Continue
            </button>
            <button
              type="button"
              aria-pressed=${String(this.value.sessionIntent === 'reset')}
              @click=${() => this.change({ sessionIntent: 'reset' })}
              data-testid=${`${this.testIdPrefix}-fresh`}
            >
              Fresh
            </button>
          </div>
        </fieldset>
        <fieldset ?hidden=${this.presentation === 'workflow' || qa}>
          <legend>Review scope</legend>
          <div class="row">
            <button
              type="button"
              aria-pressed=${String(this.value.scope === 'incremental')}
              @click=${() => this.change({ scope: 'incremental' })}
            >
              Changes since last review
            </button>
            <button
              type="button"
              aria-pressed=${String(this.value.scope === 'full')}
              @click=${() => this.change({ scope: 'full' })}
            >
              Full independent review
            </button>
          </div>
        </fieldset>
        <fieldset ?hidden=${this.presentation === 'reviewer'}>
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
                <label
                  >Farm QA profile
                  <select
                    data-testid="pr-review-qa-profile"
                    .value=${this.value.qaProfileId ?? ''}
                    @change=${(event: Event) =>
                      this.change({
                        qaProfileId: (event.target as HTMLSelectElement).value || undefined,
                        qaInputs: undefined,
                      })}
                  >
                    <option value="">
                      Farm default${this.qa ? ` · ${this.qa.default_profile}` : ''}
                    </option>
                    ${(this.qa?.profiles ?? []).map(
                      (profile) => html`<option value=${profile.id}>${profile.title}</option>`,
                    )}
                  </select>
                </label>
                <p class="muted">QA runs the farm's validation skill and requires runtime proof.</p>
              `
            : html`<p class="muted">
                Static review uses an isolated workspace without a device slot.
              </p>`}
        </fieldset>
        <label ?hidden=${qa || this.presentation === 'reviewer'}>
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
        <fieldset ?hidden=${this.presentation === 'workflow' || qa}>
          <legend>When the saved reviewer is unavailable</legend>
          <div class="row">
            <button
              type="button"
              aria-pressed=${String(this.value.busySession !== 'fresh')}
              @click=${() => this.change({ busySession: 'wait' })}
            >
              Wait for reviewer
            </button>
            <button
              type="button"
              aria-pressed=${String(this.value.busySession === 'fresh')}
              @click=${() => this.change({ busySession: 'fresh' })}
            >
              Allow fresh reviewer
            </button>
          </div>
        </fieldset>
      </div>
      <p class="muted" ?hidden=${this.presentation === 'workflow' || qa}>
        Initial rounds start fresh. Full independent reviews reset reviewer reasoning. Between
        rounds, compatible saved sessions can be reused. Unsupported continuation starts a fresh
        review and keeps the previous findings.
      </p>
    </fieldset>`;
  }
}
