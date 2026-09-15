import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  assertPRReviewRequest,
  DEFAULT_PR_REVIEW_OPTIONS,
  isPRWorkspaceExecutionProfile,
  parseGitHubPullUrl,
  type PoolConfig,
  type PRExecutionProfile,
  type ProjectConfig,
  type PRReviewOptions,
  type PRReviewRequest,
  type PRTeamProfile,
  resolvePRWorkflowDefaults,
  type SlotStatus,
} from '@farmslot/protocol';

import '../shared/choice-picker.js';
import './pr-execution-picker.js';
import './pr-review-options-picker.js';

import type { ChoicePicker } from '../shared/choice-picker.js';

import { prAutomationStyles } from './pr-automation-styles.js';
import { newPRExecution, newPRWorkspaceExecution } from './pr-execution-picker.js';

@customElement('pr-review-request-form')
export class PRReviewRequestForm extends LitElement {
  @property() prUrl = '';
  @property({ attribute: false }) teams: PRTeamProfile[] = [];
  @property({ attribute: false }) slots: SlotStatus[] = [];
  @property({ attribute: false }) pools: PoolConfig[] = [];
  @property({ attribute: false }) farms: ProjectConfig[] = [];
  @property({ type: Boolean }) disabled = false;
  @state() private url = '';
  @state() private teamId = '';
  @state() private autoStart = false;
  @state() private overrideExecution = false;
  @state() private overrideReview = false;
  @state() private execution: PRExecutionProfile = newPRWorkspaceExecution();
  @state() private review: PRReviewOptions = { ...DEFAULT_PR_REVIEW_OPTIONS };
  @state() private error = '';
  private requestKey?: string;
  static styles = prAutomationStyles;
  protected willUpdate(changed: Map<string, unknown>) {
    if (changed.has('prUrl')) this.url = this.prUrl;
  }
  private edited() {
    this.requestKey = undefined;
  }
  private selectedTeamId() {
    if (this.teamId) return this.teamId;
    const repo = parseGitHubPullUrl(this.url)?.repo.toLowerCase();
    const matches = this.teams.filter((team) =>
      team.config.repositories.some((policy) => policy.repo.toLowerCase() === repo),
    );
    return matches.length === 1 ? matches[0].id : '';
  }
  private save(event: SubmitEvent) {
    event.preventDefault();
    this.error = '';
    try {
      const pr = parseGitHubPullUrl(this.url);
      if (!pr) throw new Error('Enter a GitHub pull request URL');
      const request: PRReviewRequest = {
        teamId: this.selectedTeamId(),
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
    const teamId = this.selectedTeamId();
    const team = this.teams.find((item) => item.id === teamId);
    const repo = parseGitHubPullUrl(this.url)?.repo;
    const policy = team?.config.repositories.find(
      (item) => item.repo.toLowerCase() === repo?.toLowerCase(),
    );
    const farm = this.farms.find((item) => item.name === policy?.project);
    const resolved = resolvePRWorkflowDefaults({
      request: { review: this.overrideReview ? this.review : undefined },
      repository: policy,
      team: team?.config,
      farm: farm?.workflowDefaults,
    });
    const { review } = resolved;
    const execution = this.overrideExecution ? this.execution : resolved.execution;
    const target = execution
      ? isPRWorkspaceExecutionProfile(execution)
        ? execution.workspacePolicy.kind === 'exact'
          ? execution.workspacePolicy.machine
          : execution.workspacePolicy.allowedMachines.join(', ')
        : execution.slotPolicy.kind === 'exact'
          ? execution.slotPolicy.slotId
          : execution.slotPolicy.allowedSlots.join(', ')
      : 'Needs configuration';
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
            >Team policy<choice-picker
              data-testid="pr-review-request-team"
              required
              .value=${teamId}
              @change=${(event: Event) => {
                this.teamId = (event.target as ChoicePicker).value;
              }}
            >
              <option value="">Choose a team</option>
              ${this.teams.map(
                (item) =>
                  html`<option data-team-name=${item.config.name} .value=${item.id}>
                    ${item.config.name}
                  </option>`,
              )}
            </choice-picker></label
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
        <pr-review-options-picker
          .presentation=${'workflow'}
          .value=${review}
          .disabled=${this.disabled}
          @review-options-change=${(event: CustomEvent<PRReviewOptions>) => {
            this.overrideReview = true;
            this.review = event.detail;
            this.edited();
          }}
        ></pr-review-options-picker>
        <p>
          ${target}${execution?.models[0]
            ? ` · ${execution.models[0].runner} / ${execution.models[0].model}`
            : ''}
        </p>
        <label class="check"
          ><input
            type="checkbox"
            .checked=${this.autoStart}
            @change=${(event: Event) => {
              this.autoStart = (event.target as HTMLInputElement).checked;
            }}
          />Start when the configured resources are available</label
        >
        <p class="muted">Otherwise this request waits for acceptance in the review queue.</p>
        <p class="muted">
          Review options: ${resolved.sources.review}. Execution:
          ${this.overrideExecution ? 'request' : (resolved.sources.execution ?? 'not configured')}.
        </p>
        <details>
          <summary data-testid="pr-review-advanced">Advanced options</summary>
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
            .presentation=${'reviewer'}
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
                this.execution = execution
                  ? structuredClone(execution)
                  : review.validationDepth === 'full-live'
                    ? newPRExecution()
                    : newPRWorkspaceExecution();
              }}
            />Override inherited execution and models</label
          >
          ${execution
            ? html`<pr-execution-picker
                .pools=${this.pools}
                .resource=${review.validationDepth === 'full-live' ? 'slot' : 'workspace'}
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
        </details>
        ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
        <button data-testid="pr-review-request-submit" class="primary" type="submit">
          ${this.disabled
            ? 'Submitting…'
            : review.validationDepth === 'full-live'
              ? 'Request on-device review'
              : 'Request review'}
        </button>
      </fieldset>
    </form>`;
  }
}
