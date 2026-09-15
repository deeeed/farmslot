import { html, LitElement, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import {
  DEFAULT_PR_REVIEW_OPTIONS,
  type PoolConfig,
  type PRExecutionProfile,
  type ProjectConfig,
  type PRReviewOptions,
  type SlotStatus,
} from '@farmslot/protocol';

import './pr-review-options-picker.js';

import { prAutomationStyles } from './pr-automation-styles.js';
import { newPRExecution, newPRWorkspaceExecution } from './pr-execution-picker.js';

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
  @property({ attribute: false }) pools: PoolConfig[] = [];
  @property({ attribute: false }) farms: ProjectConfig[] = [];
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
    const farm = this.farms.find((item) => item.name === this.project);
    const selectedReview = this.review ?? this.inheritedReview;
    const runtime = selectedReview?.validationDepth === 'full-live';
    const defaults = runtime ? undefined : farm?.workflowDefaults?.['review-pr'];
    const review = selectedReview ?? defaults?.review ?? DEFAULT_PR_REVIEW_OPTIONS;
    const execution = this.execution ?? this.inheritedExecution ?? defaults?.execution;
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
                ? structuredClone(
                    execution ?? (runtime ? newPRExecution() : newPRWorkspaceExecution()),
                  )
                : undefined,
            })}
        />Set execution and models here</label
      >
      ${execution
        ? html`<p class="muted">
              ${this.execution ? 'Explicit execution and models' : 'Inherited execution and models'}
            </p>
            <pr-execution-picker
              .pools=${this.pools}
              .resource=${runtime ? 'slot' : 'workspace'}
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
            Configure execution here, in the repository policy, or in the farm defaults.
          </p>`}
      ${this.allProjects
        ? html`<p class="muted">
            Each repository uses only resources compatible with its mapped project.
          </p>`
        : nothing}
    </fieldset>`;
  }
}
