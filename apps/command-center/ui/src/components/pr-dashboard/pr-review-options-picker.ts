import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { DEFAULT_PR_REVIEW_OPTIONS, type PRReviewOptions } from '@farmslot/protocol';

import { prAutomationStyles } from './pr-automation-styles.js';

@customElement('pr-review-options-picker')
export class PRReviewOptionsPicker extends LitElement {
  @property({ attribute: false }) value: PRReviewOptions = { ...DEFAULT_PR_REVIEW_OPTIONS };
  @property({ type: Boolean }) disabled = false;
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
    const next = { ...this.value, ...patch };
    this.dispatchEvent(
      new CustomEvent('review-options-change', {
        detail: next,
        bubbles: true,
        composed: true,
      }),
    );
  }
  render() {
    return html`<fieldset ?disabled=${this.disabled}>
      <div class="grid">
        <fieldset ?hidden=${this.presentation === 'workflow'}>
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
        <fieldset ?hidden=${this.presentation === 'workflow'}>
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
              aria-pressed=${String(this.value.validationDepth === 'static-code')}
              @click=${() => this.change({ validationDepth: 'static-code' })}
            >
              Static review
            </button>
            <button
              type="button"
              data-testid="pr-review-depth-full-live"
              aria-pressed=${String(this.value.validationDepth === 'full-live')}
              @click=${() => this.change({ validationDepth: 'full-live' })}
            >
              On-device review
            </button>
          </div>
          <p class="muted">
            ${this.value.validationDepth === 'full-live'
              ? 'On-device review uses a runtime slot.'
              : 'Static review uses an isolated workspace without a device slot.'}
          </p>
        </fieldset>
        <fieldset ?hidden=${this.presentation === 'workflow'}>
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
      <p class="muted" ?hidden=${this.presentation === 'workflow'}>
        Initial rounds start fresh. Full independent reviews reset reviewer reasoning. Between
        rounds, compatible saved sessions can be reused. Unsupported continuation starts a fresh
        review and keeps the previous findings.
      </p>
    </fieldset>`;
  }
}
