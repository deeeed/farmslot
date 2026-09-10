import { html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { DEFAULT_PR_REVIEW_OPTIONS, type PRReviewOptions } from '@farmslot/protocol';

import { prAutomationStyles } from './pr-automation-styles.js';

@customElement('pr-review-options-picker')
export class PRReviewOptionsPicker extends LitElement {
  @property({ attribute: false }) value: PRReviewOptions = { ...DEFAULT_PR_REVIEW_OPTIONS };
  @property({ type: Boolean }) disabled = false;
  @property() testIdPrefix = 'pr-review';
  static styles = prAutomationStyles;
  private change(patch: Partial<PRReviewOptions>) {
    this.dispatchEvent(
      new CustomEvent('review-options-change', {
        detail: { ...this.value, ...patch },
        bubbles: true,
        composed: true,
      }),
    );
  }
  render() {
    return html`<fieldset ?disabled=${this.disabled}>
      <div class="grid">
        <fieldset>
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
        <fieldset>
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
        <fieldset>
          <legend>Validation</legend>
          <div class="row">
            <button
              type="button"
              aria-pressed=${String(this.value.validationDepth === 'static-code')}
              @click=${() => this.change({ validationDepth: 'static-code' })}
            >
              Static code
            </button>
            <button
              type="button"
              data-testid="pr-review-depth-full-live"
              aria-pressed=${String(this.value.validationDepth === 'full-live')}
              @click=${() => this.change({ validationDepth: 'full-live' })}
            >
              Review and live QA
            </button>
          </div>
        </fieldset>
        <fieldset>
          <legend>When the saved reviewer's slot is busy</legend>
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
              Allow fresh slot
            </button>
          </div>
        </fieldset>
      </div>
      <p class="muted">
        Initial rounds start fresh. Full independent reviews reset reviewer reasoning. Between
        rounds, slots can review other PRs.
      </p>
    </fieldset>`;
  }
}
