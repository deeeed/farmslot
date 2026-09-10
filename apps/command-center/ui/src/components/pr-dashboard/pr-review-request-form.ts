import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  assertPRReviewRequest,
  DEFAULT_PR_REVIEW_OPTIONS,
  parseGitHubPullUrl,
  type PRExecutionProfile,
  type PRReviewOptions,
  type PRReviewRequest,
  type PRTeamProfile,
  type SlotStatus,
} from '@farmslot/protocol';

import './pr-execution-picker.js';
import './pr-review-options-picker.js';

import { prAutomationStyles } from './pr-automation-styles.js';
import { newPRExecution } from './pr-execution-picker.js';

@customElement('pr-review-request-form')
export class PRReviewRequestForm extends LitElement {
  @property({ attribute: false }) teams: PRTeamProfile[] = [];
  @property({ attribute: false }) slots: SlotStatus[] = [];
  @property({ type: Boolean }) disabled = false;
  @state() private url = '';
  @state() private teamId = '';
  @state() private autoStart = false;
  @state() private overrideExecution = false;
  @state() private overrideReview = false;
  @state() private execution = newPRExecution();
  @state() private review: PRReviewOptions = { ...DEFAULT_PR_REVIEW_OPTIONS };
  @state() private error = '';
  private requestKey?: string;
  static styles = prAutomationStyles;
  private edited() {
    this.requestKey = undefined;
  }
  private save(event: SubmitEvent) {
    event.preventDefault();
    this.error = '';
    try {
      const pr = parseGitHubPullUrl(this.url);
      if (!pr) throw new Error('Enter a GitHub pull request URL');
      const request: PRReviewRequest = {
        teamId: this.teamId,
        pr: { host: 'github.com', repo: pr.repo, number: pr.number },
        idempotencyKey: (this.requestKey ??= crypto.randomUUID()),
        autoStart: this.autoStart,
        ...(this.overrideExecution ? { execution: this.execution } : {}),
        ...(this.overrideReview ? { review: this.review } : {}),
        source: { client: 'command-center' },
      };
      assertPRReviewRequest(request);
      this.dispatchEvent(
        new CustomEvent('review-request', { detail: request, bubbles: true, composed: true }),
      );
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
  render() {
    const team = this.teams.find((item) => item.id === this.teamId);
    const repo = parseGitHubPullUrl(this.url)?.repo;
    const policy = team?.config.repositories.find(
      (item) => item.repo.toLowerCase() === repo?.toLowerCase(),
    );
    const review = this.overrideReview
      ? this.review
      : (policy?.review ?? team?.config.review ?? DEFAULT_PR_REVIEW_OPTIONS);
    const execution = this.overrideExecution
      ? this.execution
      : (policy?.execution ?? team?.config.execution);
    return html`<form @submit=${this.save} @input=${this.edited} @change=${this.edited}>
      <fieldset ?disabled=${this.disabled}>
        <div class="grid">
          <label
            >PR URL<input
              data-testid="pr-review-request-url"
              type="url"
              required
              .value=${this.url}
              placeholder="https://github.com/owner/repo/pull/42"
              @input=${(event: Event) => {
                this.url = (event.target as HTMLInputElement).value;
              }}
          /></label>
          <label
            >Team policy<select
              data-testid="pr-review-request-team"
              .size=${Math.min(6, Math.max(2, this.teams.length + 1))}
              required
              .value=${this.teamId}
              @change=${(event: Event) => {
                this.teamId = (event.target as HTMLSelectElement).value;
              }}
            >
              <option value="">Choose a team</option>
              ${this.teams.map(
                (item) =>
                  html`<option data-team-name=${item.config.name} .value=${item.id}>
                    ${item.config.name}
                  </option>`,
              )}
            </select></label
          >
        </div>
        ${!this.teams.length
          ? html`<p class="attention">
              Create a team profile under Rules before requesting a review.
            </p>`
          : nothing}
        ${team
          ? html`<p class="muted">
              ${policy?.project ?? 'No project mapping yet'} ·
              ${policy?.reviewProfile ?? 'standard'} · ${team.config.account.login}
            </p>`
          : nothing}
        <label class="check"
          ><input
            type="checkbox"
            .checked=${this.autoStart}
            @change=${(event: Event) => {
              this.autoStart = (event.target as HTMLInputElement).checked;
            }}
          />Start automatically when an allowed slot is available</label
        >
        <p class="muted">Otherwise this request waits for acceptance in the review queue.</p>
        <label class="check"
          ><input
            data-testid="pr-review-request-override"
            type="checkbox"
            .checked=${this.overrideReview}
            @change=${(event: Event) => {
              this.overrideReview = (event.target as HTMLInputElement).checked;
              this.review = { ...review };
            }}
          />Override inherited review options</label
        >
        <pr-review-options-picker
          .value=${review}
          .disabled=${this.disabled || !this.overrideReview}
          @review-options-change=${(event: CustomEvent<PRReviewOptions>) => {
            this.review = event.detail;
            this.edited();
          }}
        ></pr-review-options-picker>
        <label class="check"
          ><input
            type="checkbox"
            .checked=${this.overrideExecution}
            @change=${(event: Event) => {
              this.overrideExecution = (event.target as HTMLInputElement).checked;
              this.execution = execution ? structuredClone(execution) : newPRExecution();
            }}
          />Override inherited slots and models</label
        >
        ${execution
          ? html`<pr-execution-picker
              .value=${execution}
              .project=${policy?.project ?? ''}
              .slots=${this.slots}
              .disabled=${this.disabled || !this.overrideExecution}
              @execution-change=${(event: CustomEvent<PRExecutionProfile>) => {
                this.execution = event.detail;
                this.edited();
              }}
            ></pr-execution-picker>`
          : html`<p class="attention">
              No execution profile configured. This request will need configuration before it can
              start.
            </p>`}
        ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
        <button data-testid="pr-review-request-submit" class="primary" type="submit">
          ${this.disabled ? 'Submitting…' : 'Request review'}
        </button>
      </fieldset>
    </form>`;
  }
}
