import { html, LitElement, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import {
  DEFAULT_PR_REVIEW_OPTIONS,
  type PRExecutionProfile,
  type PRReviewOptions,
  type SlotStatus,
} from '@farmslot/protocol';

import './pr-review-options-picker.js';

import { prAutomationStyles } from './pr-automation-styles.js';
import { newPRExecution } from './pr-execution-picker.js';

export interface PRReviewPolicyChange {
  execution?: PRExecutionProfile;
  review?: PRReviewOptions;
}

@customElement('pr-review-policy-editor')
export class PRReviewPolicyEditor extends LitElement {
  @property({ attribute: false }) execution?: PRExecutionProfile;
  @property({ attribute: false }) review?: PRReviewOptions;
  @property({ attribute: false }) inheritedExecution?: PRExecutionProfile;
  @property({ attribute: false }) inheritedReview?: PRReviewOptions;
  @property({ attribute: false }) slots: SlotStatus[] = [];
  @property() project = '';
  @property({ type: Boolean }) allProjects = false;
  @property({ type: Boolean }) disabled = false;
  @property() testIdPrefix = 'pr-policy';
  static styles = prAutomationStyles;

  private change(patch: PRReviewPolicyChange) {
    this.dispatchEvent(
      new CustomEvent<PRReviewPolicyChange>('policy-change', {
        detail: { execution: this.execution, review: this.review, ...patch },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    const review = this.review ?? this.inheritedReview ?? DEFAULT_PR_REVIEW_OPTIONS;
    const execution = this.execution ?? this.inheritedExecution;
    return html`<fieldset ?disabled=${this.disabled}>
      <label class="check"
        ><input
          type="checkbox"
          data-testid=${`${this.testIdPrefix}-review-override`}
          .checked=${!!this.review}
          @change=${(event: Event) =>
            this.change({
              review: (event.target as HTMLInputElement).checked ? { ...review } : undefined,
            })}
        />Set review options here</label
      >
      <p class="muted">${this.review ? 'Explicit review options' : 'Inherited review options'}</p>
      <pr-review-options-picker
        .testIdPrefix=${this.testIdPrefix}
        .value=${review}
        .disabled=${this.disabled || !this.review}
        @review-options-change=${(event: CustomEvent<PRReviewOptions>) => {
          event.stopPropagation();
          this.change({ review: event.detail });
        }}
      ></pr-review-options-picker>
      <label class="check"
        ><input
          type="checkbox"
          data-testid=${`${this.testIdPrefix}-execution-override`}
          .checked=${!!this.execution}
          @change=${(event: Event) =>
            this.change({
              execution: (event.target as HTMLInputElement).checked
                ? structuredClone(execution ?? newPRExecution())
                : undefined,
            })}
        />Set slots and models here</label
      >
      ${execution
        ? html`<p class="muted">
              ${this.execution ? 'Explicit slots and models' : 'Inherited slots and models'}
            </p>
            <pr-execution-picker
              .value=${execution}
              .slots=${this.slots}
              .project=${this.project}
              .allProjects=${this.allProjects}
              .disabled=${this.disabled || !this.execution}
              @execution-change=${(event: CustomEvent<PRExecutionProfile>) => {
                event.stopPropagation();
                this.change({ execution: event.detail });
              }}
            ></pr-execution-picker>`
        : html`<p class="attention">
            Choose slots and models here or in a repository policy before starting reviews.
          </p>`}
      ${this.allProjects
        ? html`<p class="muted">
            Each repository uses only slots compatible with its mapped project.
          </p>`
        : nothing}
    </fieldset>`;
  }
}
