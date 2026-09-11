import { html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type {
  PRExecutionProfile,
  PRRepositoryReviewPolicy,
  PRReviewOptions,
  SlotStatus,
} from '@farmslot/protocol';

import '../shared/choice-picker.js';
import './pr-review-policy-editor.js';

import type { ChoicePicker } from '../shared/choice-picker.js';

import { prAutomationStyles } from './pr-automation-styles.js';
import type { PRReviewPolicyChange } from './pr-review-policy-editor.js';

@customElement('pr-repository-policies')
export class PRRepositoryPolicies extends LitElement {
  @property({ attribute: false }) value: PRRepositoryReviewPolicy[] = [];
  @property({ attribute: false }) projects: string[] = [];
  @property({ attribute: false }) slots: SlotStatus[] = [];
  @property({ attribute: false }) execution?: PRExecutionProfile;
  @property({ attribute: false }) review?: PRReviewOptions;
  @property({ type: Boolean }) disabled = false;
  static styles = prAutomationStyles;

  private change(value: PRRepositoryReviewPolicy[]) {
    this.dispatchEvent(
      new CustomEvent('repositories-change', { detail: value, bubbles: true, composed: true }),
    );
  }
  private edit(index: number, patch: Partial<PRRepositoryReviewPolicy>) {
    this.change(this.value.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  }
  render() {
    return html`<fieldset ?disabled=${this.disabled}>
      <legend>Repository policies</legend>
      <p class="muted">
        Map each repository to a Farmslot project for execution. Unmapped PRs can be discovered but
        need configuration before a review starts.
      </p>
      ${this.value.map(
        (policy, index) =>
          html`<section data-policy-index=${index}>
            <div class="grid">
              <label
                >Repository<input
                  data-testid="pr-repository-name"
                  required
                  .value=${policy.repo}
                  placeholder="owner/repo"
                  @change=${(event: Event) =>
                    this.edit(index, { repo: (event.target as HTMLInputElement).value.trim() })}
              /></label>
              <label
                >Farmslot project<choice-picker
                  data-testid="pr-repository-project"
                  .value=${policy.project ?? ''}
                  @change=${(event: Event) =>
                    this.edit(index, {
                      project: (event.target as ChoicePicker).value || undefined,
                    })}
                >
                  <option value="">No review farm selected</option>
                  ${this.projects.map(
                    (project) => html`<option .value=${project}>${project}</option>`,
                  )}
                </choice-picker></label
              >
              <label
                >Review profile<input
                  data-testid="pr-repository-profile"
                  required
                  .value=${policy.reviewProfile}
                  @change=${(event: Event) =>
                    this.edit(index, {
                      reviewProfile: (event.target as HTMLInputElement).value.trim(),
                    })}
              /></label>
              <label
                >Excluded labels, comma-separated<input
                  data-testid="pr-repository-exclusions"
                  .value=${policy.excludedLabels.join(', ')}
                  @change=${(event: Event) =>
                    this.edit(index, {
                      excludedLabels: (event.target as HTMLInputElement).value
                        .split(',')
                        .map((label) => label.trim())
                        .filter(Boolean),
                    })}
              /></label>
              <label
                >Supplemental approval target<input
                  type="number"
                  min="0"
                  max="100"
                  .value=${policy.approvalTarget?.toString() ?? ''}
                  @change=${(event: Event) =>
                    this.edit(index, {
                      approvalTarget:
                        (event.target as HTMLInputElement).value === ''
                          ? undefined
                          : Number((event.target as HTMLInputElement).value),
                    })}
              /></label>
              <label
                >Stale after days<input
                  type="number"
                  min="1"
                  max="365"
                  .value=${policy.staleAfterDays?.toString() ?? ''}
                  @change=${(event: Event) =>
                    this.edit(index, {
                      staleAfterDays:
                        (event.target as HTMLInputElement).value === ''
                          ? undefined
                          : Number((event.target as HTMLInputElement).value),
                    })}
              /></label>
            </div>
            <p class="muted">
              Supplemental approvals do not replace GitHub requirements. Inactivity uses the PR’s
              last update.
            </p>
            <pr-review-policy-editor
              .testIdPrefix=${`pr-repository-${index}`}
              .execution=${policy.execution}
              .review=${policy.review}
              .inheritedExecution=${this.execution}
              .inheritedReview=${this.review}
              .slots=${this.slots}
              .project=${policy.project ?? ''}
              .disabled=${this.disabled}
              @policy-change=${(event: CustomEvent<PRReviewPolicyChange>) => {
                event.stopPropagation();
                this.edit(index, event.detail);
              }}
            ></pr-review-policy-editor>
            <button
              type="button"
              @click=${() => this.change(this.value.filter((_, i) => i !== index))}
            >
              Remove repository policy
            </button>
          </section>`,
      )}

      <button
        type="button"
        data-testid="pr-repository-add"
        @click=${() =>
          this.change([...this.value, { repo: '', reviewProfile: 'standard', excludedLabels: [] }])}
      >
        Add repository policy
      </button>
    </fieldset>`;
  }
}
