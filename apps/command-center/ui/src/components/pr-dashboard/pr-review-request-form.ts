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
  prReviewWorkflow,
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
  @property() initialWorkflow: 'review' | 'qa' = 'review';
  @property() sourceReviewRunId?: string;
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
  @state() private qaInputsText?: string;
  private requestKey?: string;
  static styles = prAutomationStyles;
  protected willUpdate(changed: Map<string, unknown>) {
    if (changed.has('prUrl')) this.url = this.prUrl;
    if (changed.has('initialWorkflow') && this.initialWorkflow === 'qa') {
      this.review = { sessionIntent: 'reset', scope: 'full', workflow: 'qa' };
      this.overrideReview = true;
    }
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
      let requestedReview = this.overrideReview ? this.review : undefined;
      const { resolved } = this.selection();
      if (prReviewWorkflow(resolved.review) === 'qa' && this.qaInputsText !== undefined) {
        const inputs = JSON.parse(this.qaInputsText);
        if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs))
          throw new Error('QA inputs must be a JSON object');
        requestedReview = { ...resolved.review, qaInputs: inputs };
      }
      const request: PRReviewRequest = {
        teamId: this.selectedTeamId(),
        pr: { host: 'github.com', repo: pr.repo, number: pr.number },
        idempotencyKey: (this.requestKey ??= crypto.randomUUID()),
        autoStart: this.autoStart,
        ...(this.overrideExecution ? { execution: this.execution } : {}),
        ...(requestedReview ? { review: requestedReview } : {}),
        ...(this.sourceReviewRunId && prReviewWorkflow(this.review) === 'qa'
          ? { sourceReviewRunId: this.sourceReviewRunId }
          : {}),
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
  private selection() {
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
    return { teamId, team, policy, farm, resolved };
  }
  render() {
    const { teamId, team, policy, farm, resolved } = this.selection();
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
                this.sourceReviewRunId = undefined;
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
          .qa=${farm?.qa}
          .value=${{
            ...review,
            publishReview: this.overrideReview ? this.review.publishReview : undefined,
          }}
          .disabled=${this.disabled}
          @review-options-change=${(event: CustomEvent<PRReviewOptions>) => {
            this.overrideReview = true;
            this.review = event.detail;
            this.qaInputsText = undefined;
            this.edited();
          }}
        ></pr-review-options-picker>
        ${prReviewWorkflow(review) === 'review'
          ? html`<p class="muted" data-testid="pr-review-publication-resolved">
              Publication:
              ${review.publishReview === true ? 'Publish review to PR' : 'Farmslot results only'} ·
              ${resolved.sources.publication ?? 'built-in'}
            </p>`
          : nothing}
        ${prReviewWorkflow(review) === 'qa'
          ? html`<details>
              <summary>Advanced inputs</summary>
              <label
                >Profile input overrides
                <textarea
                  data-testid="pr-qa-inputs"
                  rows="6"
                  .value=${this.qaInputsText ??
                  JSON.stringify(
                    {
                      ...farm?.qa?.profiles.find(
                        (profile) =>
                          profile.id === (review.qaProfileId ?? farm?.qa?.default_profile),
                      )?.inputs,
                      ...review.qaInputs,
                    },
                    null,
                    2,
                  )}
                  @input=${(event: Event) => {
                    this.qaInputsText = (event.target as HTMLTextAreaElement).value;
                  }}
                ></textarea>
              </label>
              <p class="muted">
                Set the scope, refs or dates accepted by this farm's skill. Invalid JSON prevents
                submission.
              </p>
            </details>`
          : nothing}
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
          <label class="check" ?hidden=${prReviewWorkflow(review) === 'qa'}
            ><input
              data-testid="pr-review-request-override"
              type="checkbox"
              .checked=${this.overrideReview}
              @change=${(event: Event) => {
                this.overrideReview = (event.target as HTMLInputElement).checked;
                this.review = { ...review, publishReview: this.review.publishReview };
              }}
            />Override inherited review options</label
          >
          <pr-review-options-picker
            .presentation=${'reviewer'}
            .qa=${farm?.qa}
            .value=${{
              ...review,
              publishReview: this.overrideReview ? this.review.publishReview : undefined,
            }}
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
                  : prReviewWorkflow(review) === 'qa'
                    ? newPRExecution()
                    : newPRWorkspaceExecution();
              }}
            />Override inherited execution and models</label
          >
          ${execution
            ? html`<pr-execution-picker
                .pools=${this.pools}
                .resource=${prReviewWorkflow(review) === 'qa' ? 'slot' : 'workspace'}
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
            : prReviewWorkflow(review) === 'qa'
              ? 'Request QA'
              : 'Request review'}
        </button>
      </fieldset>
    </form>`;
  }
}
