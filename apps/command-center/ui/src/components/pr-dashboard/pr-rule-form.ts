import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  assertPRTriggerRuleConfig,
  type PRExecutionProfile,
  type PRMonitorPolicy,
  type PRRuleAction,
  type PRRulePredicate,
  type PRTeamProfile,
  type PRTriggerRuleConfig,
  type SlotStatus,
} from '@farmslot/protocol';

import './pr-review-policy-editor.js';

import { prAutomationStyles } from './pr-automation-styles.js';
import { newPRExecution } from './pr-execution-picker.js';
import { defaultPRPredicate } from './pr-predicate-editor.js';
import type { PRReviewPolicyChange } from './pr-review-policy-editor.js';

function newRule(): PRTriggerRuleConfig {
  return {
    name: '',
    teamId: '',
    predicate: defaultPRPredicate(),
    actions: [{ kind: 'review', autoStart: false }],
    pollIntervalMs: 300_000,
    maxAdmissionsPerScan: 10,
    rereviewOnHeadChange: true,
  };
}

@customElement('pr-rule-form')
export class PRRuleForm extends LitElement {
  @property({ attribute: false }) initial?: PRTriggerRuleConfig;
  @property({ attribute: false }) teams: PRTeamProfile[] = [];
  @property({ attribute: false }) slots: SlotStatus[] = [];
  @property({ type: Boolean }) disabled = false;
  @state() private draft = newRule();
  @state() private repository = '';
  @state() private error = '';
  static styles = prAutomationStyles;

  protected willUpdate(changes: PropertyValues<this>) {
    if (changes.has('initial')) {
      this.draft = this.initial ? structuredClone(this.initial) : newRule();
      this.repository = '';
      this.error = '';
    }
  }
  private edit(patch: Partial<PRTriggerRuleConfig>) {
    this.draft = { ...this.draft, ...patch };
  }
  private review(patch: PRReviewPolicyChange & { autoStart?: boolean }) {
    this.edit({
      actions: this.draft.actions.map((action) =>
        action.kind === 'review' ? { ...action, ...patch } : action,
      ),
    });
  }
  private toggleAction(kind: PRRuleAction['kind'], enabled: boolean) {
    const actions = this.draft.actions.filter((action) => action.kind !== kind);
    if (enabled)
      actions.push(
        kind === 'review'
          ? { kind, autoStart: false }
          : kind === 'monitor'
            ? { kind, policy: { mode: 'notify-only' } }
            : { kind },
      );
    this.edit({ actions });
  }
  private monitorPolicy(policy: PRMonitorPolicy) {
    this.edit({
      actions: this.draft.actions.map((action) =>
        action.kind === 'monitor' ? { ...action, policy } : action,
      ),
    });
  }
  private save(event: SubmitEvent) {
    event.preventDefault();
    if (this.disabled) return;
    this.error = '';
    try {
      assertPRTriggerRuleConfig(this.draft);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return;
    }
    this.dispatchEvent(
      new CustomEvent('rule-save', { detail: this.draft, bubbles: true, composed: true }),
    );
  }
  render() {
    const draft = this.draft;
    const team = this.teams.find((item) => item.id === draft.teamId);
    const policy = team?.config.repositories.find((item) => item.repo === this.repository);
    const review = draft.actions.find((action) => action.kind === 'review');
    const monitor = draft.actions.find((action) => action.kind === 'monitor');
    return html`<form @submit=${this.save}>
      <fieldset ?disabled=${this.disabled}>
        <div class="grid">
          <label
            >Rule name<input
              data-testid="pr-rule-name"
              required
              .value=${draft.name}
              @change=${(event: Event) =>
                this.edit({ name: (event.target as HTMLInputElement).value.trim() })}
          /></label>
          <label
            >Team policy<select
              data-testid="pr-rule-team"
              ?disabled=${!!this.initial}
              .size=${Math.min(6, Math.max(2, this.teams.length + 1))}
              required
              .value=${draft.teamId}
              @change=${(event: Event) => {
                this.repository = '';
                this.edit({ teamId: (event.target as HTMLSelectElement).value });
              }}
            >
              <option value="" .selected=${!draft.teamId}>Choose a team</option>
              ${this.teams.map(
                (item) =>
                  html`<option
                    data-rule-team-name=${item.config.name}
                    .value=${item.id}
                    .selected=${item.id === draft.teamId}
                  >
                    ${item.config.name}
                  </option>`,
              )}
            </select></label
          >
          <label
            >Poll interval in seconds<input
              data-testid="pr-rule-interval"
              type="number"
              required
              min="60"
              max="86400"
              .value=${String(draft.pollIntervalMs / 1000)}
              @change=${(event: Event) =>
                this.edit({
                  pollIntervalMs: Number((event.target as HTMLInputElement).value) * 1000,
                })}
          /></label>
          <label
            >Maximum admissions per scan<input
              data-testid="pr-rule-limit"
              type="number"
              required
              min="1"
              max="100"
              .value=${String(draft.maxAdmissionsPerScan)}
              @change=${(event: Event) =>
                this.edit({
                  maxAdmissionsPerScan: Number((event.target as HTMLInputElement).value),
                })}
          /></label>
        </div>
        ${team
          ? html`<p class="muted">
              Sources:
              ${team.config.sources
                .map((source) => (source.kind === 'repository' ? source.repo : source.label))
                .join(', ')}.
              The team predicate also applies.
            </p>`
          : nothing}
        <section>
          <h3>Match conditions</h3>
          <pr-predicate-editor
            .value=${draft.predicate}
            .disabled=${this.disabled}
            @predicate-change=${(event: CustomEvent<PRRulePredicate>) => {
              event.stopPropagation();
              this.edit({ predicate: event.detail });
            }}
          ></pr-predicate-editor>
        </section>
        <fieldset>
          <legend>Actions for matching PRs</legend>
          <div class="row">
            ${(['notify', 'monitor', 'review'] as const).map(
              (kind) =>
                html`<label class="check"
                  ><input
                    type="checkbox"
                    data-testid=${`pr-rule-action-${kind}`}
                    .checked=${draft.actions.some((action) => action.kind === kind)}
                    @change=${(event: Event) =>
                      this.toggleAction(kind, (event.target as HTMLInputElement).checked)}
                  />${{
                    notify: 'Notify team',
                    monitor: 'Add PR monitor',
                    review: 'Enqueue review',
                  }[kind]}</label
                >`,
            )}
          </div>
        </fieldset>
        ${monitor
          ? html`<section>
              <h3>Monitor policy</h3>
              <label class="check"
                ><input
                  type="checkbox"
                  data-testid="pr-rule-monitor-repair"
                  .checked=${monitor.policy.mode === 'automatic-repair'}
                  @change=${(event: Event) =>
                    this.monitorPolicy(
                      (event.target as HTMLInputElement).checked
                        ? { mode: 'automatic-repair', execution: newPRExecution() }
                        : { mode: 'notify-only' },
                    )}
                />Allow automatic PR repair for new subscriptions</label
              >
              <p class="muted">
                Existing subscriptions keep their policy and lifecycle. Repair slots and models are
                separate from review settings.
              </p>
              ${monitor.policy.mode === 'automatic-repair'
                ? html`<pr-execution-picker
                    .value=${monitor.policy.execution}
                    .slots=${this.slots}
                    .allProjects=${true}
                    .disabled=${this.disabled}
                    @execution-change=${(event: CustomEvent<PRExecutionProfile>) => {
                      event.stopPropagation();
                      this.monitorPolicy({ mode: 'automatic-repair', execution: event.detail });
                    }}
                  ></pr-execution-picker>`
                : nothing}
            </section>`
          : nothing}
        <label class="check"
          ><input
            type="checkbox"
            .checked=${draft.rereviewOnHeadChange}
            @change=${(event: Event) =>
              this.edit({ rereviewOnHeadChange: (event.target as HTMLInputElement).checked })}
          />Request another review when the head changes</label
        >
        ${review
          ? html`<section>
              <h3>Enqueue review</h3>
              <label class="check"
                ><input
                  type="checkbox"
                  data-testid="pr-rule-auto-start"
                  .checked=${review.autoStart}
                  @change=${(event: Event) =>
                    this.review({ autoStart: (event.target as HTMLInputElement).checked })}
                />Start automatically when an allowed slot is available</label
              >
              <p class="muted">Otherwise matches wait for acceptance and occupy no slot.</p>
              <label
                >Show inherited settings for<select
                  data-testid="pr-rule-inheritance-repository"
                  .value=${this.repository}
                  @change=${(event: Event) => {
                    this.repository = (event.target as HTMLSelectElement).value;
                  }}
                >
                  <option value="" .selected=${!this.repository}>Team defaults</option>
                  ${team?.config.repositories.map(
                    (item) =>
                      html`<option .value=${item.repo} .selected=${item.repo === this.repository}>
                        ${item.repo}
                      </option>`,
                  )}
                </select></label
              >
              ${policy
                ? html`<p class="muted">
                    ${policy.project ?? 'No project mapping'} · ${policy.reviewProfile}. Repository
                    selection changes only this preview.
                  </p>`
                : nothing}
              <pr-review-policy-editor
                .execution=${review.execution}
                .review=${review.review}
                .inheritedExecution=${policy?.execution ?? team?.config.execution}
                .inheritedReview=${policy?.review ?? team?.config.review}
                .slots=${this.slots}
                .allProjects=${true}
                .disabled=${this.disabled}
                @policy-change=${(event: CustomEvent<PRReviewPolicyChange>) => {
                  event.stopPropagation();
                  this.review(event.detail);
                }}
              ></pr-review-policy-editor>
            </section>`
          : nothing}
        <p class="muted">
          New rules start disabled. Saving an edit applies to future changes. Preview matches before
          enabling or importing existing matches.
        </p>
        ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
        <button type="submit" class="primary" data-testid="pr-rule-save">Save rule</button>
      </fieldset>
    </form>`;
  }
}
