import { html, LitElement, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import {
  Methods,
  monitoredPRKey,
  type PRExecutionProfile,
  type PRMonitor,
  type PRMonitorConfig,
  type PRProjectImportResult,
  type PRProjectMonitorPolicy,
  type PRReviewRequest,
  type PRRulePreview,
  type PRRulePreviewResult,
  type PRTeamConfig,
  type PRTeamProfile,
  type PRTriggerRule,
  type PRTriggerRuleConfig,
} from '@farmslot/protocol';

import './pr-monitor-form.js';
import './pr-review-request-form.js';
import './pr-team-form.js';
import './pr-rule-form.js';

import { getState } from '../../state.js';

import {
  monitorCard,
  reviewCard,
  ruleActionCard,
  ruleNotificationCard,
} from './pr-automation-cards.js';
import { PRAutomationController } from './pr-automation-controller.js';
import { prAutomationStyles } from './pr-automation-styles.js';
import { newPRExecution } from './pr-execution-picker.js';
import type { PRMonitorFormSave } from './pr-monitor-form.js';
import { prPushPanel } from './pr-push-panel.js';
import { sourceProgress } from './pr-source-progress.js';
import type { PRProjectImportRequest, PRTeamForm } from './pr-team-form.js';

@customElement('pr-automation-panel')
export class PRAutomationPanel extends LitElement {
  private readonly controller = new PRAutomationController(this);
  @state() private tab: 'monitors' | 'reviews' | 'rules' | 'policies' | 'attention' = 'monitors';
  @state() private showHistory = false;
  @state() private editor?: 'monitor' | 'request' | 'repair' | 'policy' | 'team' | 'rule';
  @state() private selectedTeam?: PRTeamProfile;
  @state() private selectedRule?: PRTriggerRule;
  @state() private selectedMonitor?: PRMonitor;
  @state() private selectedPolicy?: PRProjectMonitorPolicy;
  @state() private initialConfig?: PRMonitorConfig;
  @state() private repairProject = '';
  @state() private repairExecution = newPRExecution();
  @state() private preview?: PRRulePreview;
  static styles = prAutomationStyles;

  private openMonitor(monitor?: PRMonitor) {
    this.selectedMonitor = monitor;
    this.initialConfig = monitor?.config;
    this.editor = 'monitor';
  }
  private openPolicy(policy?: PRProjectMonitorPolicy) {
    this.selectedPolicy = policy;
    this.initialConfig = policy
      ? {
          ...policy.config,
          project: policy.project,
          pr: { host: policy.config.account.host, repo: 'validation/validation', number: 1 },
        }
      : undefined;
    this.editor = 'policy';
  }
  private async saveMonitor(event: CustomEvent<PRMonitorFormSave>) {
    const config = event.detail.config;
    let result: unknown;
    if (this.editor === 'policy') {
      if (
        !this.selectedPolicy &&
        this.controller.monitors.projectPolicies?.some(
          (policy) => policy.project === config.project,
        )
      ) {
        this.controller.actionError =
          'This project already has a policy. Reopen its configuration before editing.';
        this.requestUpdate();
        return;
      }
      result = await this.controller.mutate(Methods.PR_WATCH_PROJECT_POLICY_SET, {
        project: config.project,
        enabled: event.detail.enabled,
        revision: this.selectedPolicy?.revision,
        config: {
          account: config.account,
          policy: config.policy,
          pollIntervalMs: config.pollIntervalMs,
          watchedChecks: config.watchedChecks,
          automaticAttemptLimit: config.automaticAttemptLimit,
          cooldownMs: config.cooldownMs,
        },
      });
    } else
      result = await this.controller.mutate(
        this.selectedMonitor ? Methods.PR_WATCH_CONFIGURE : Methods.PR_WATCH_SUBSCRIBE,
        {
          ...(this.selectedMonitor
            ? { id: this.selectedMonitor.id, revision: this.selectedMonitor.revision }
            : {}),
          config,
        },
      );
    if (result) this.editor = undefined;
  }
  private async actOnMonitor(action: string, monitor: PRMonitor, incidentId?: string) {
    if (action === 'edit') {
      this.openMonitor(monitor);
      return;
    }
    if (action === 'repair') {
      this.selectedMonitor = monitor;
      this.repairProject = monitor.config.project ?? '';
      this.repairExecution =
        monitor.config.policy.mode === 'automatic-repair'
          ? structuredClone(monitor.config.policy.execution)
          : newPRExecution();
      this.editor = 'repair';
      return;
    }
    const params = { id: monitor.id, revision: monitor.revision };
    if (action === 'refresh')
      await this.controller.mutate(Methods.PR_WATCH_REFRESH, { id: monitor.id });
    else if (action === 'acknowledge' || action === 'snooze')
      await this.controller.mutate(Methods.PR_WATCH_ACKNOWLEDGE, {
        ...params,
        incidentId,
        ...(action === 'snooze'
          ? { snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() }
          : {}),
      });
    else
      await this.controller.mutate(Methods.PR_WATCH_LIFECYCLE, {
        ...params,
        lifecycle: action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'stopped',
      });
  }
  private renderEditor(disabled: boolean) {
    if (!this.editor) return nothing;
    const controller = this.controller;
    return html`<section aria-label="PR automation editor">
      <div class="row">
        <h3>
          ${this.editor === 'team'
            ? 'Team policy'
            : this.editor === 'rule'
              ? 'Trigger rule'
              : this.editor === 'request'
                ? 'Request PR review / QA'
                : this.editor === 'policy'
                  ? 'Project publication monitoring'
                  : this.editor === 'repair'
                    ? 'Request PR repair'
                    : 'PR monitoring'}
        </h3>
        <span class="spacer"></span
        ><button
          data-testid="pr-automation-editor-close"
          ?disabled=${controller.busy}
          @click=${() => {
            this.editor = undefined;
          }}
        >
          Close editor
        </button>
      </div>
      ${this.editor === 'team'
        ? html`<pr-team-form
            .initial=${this.selectedTeam?.config}
            .projects=${controller.projects}
            .slots=${controller.slots}
            .disabled=${disabled}
            @project-import=${async (event: CustomEvent<PRProjectImportRequest>) => {
              const form = event.currentTarget as PRTeamForm;
              const result = await controller.mutate<PRProjectImportResult>(
                Methods.PR_RULE_PROJECT_IMPORT,
                { account: event.detail.account, url: event.detail.url },
              );
              if (result && form.isConnected && this.editor === 'team')
                form.applyProjectImport(result, event.detail.catalogOnly);
            }}
            @team-save=${async (event: CustomEvent<PRTeamConfig>) => {
              if (
                await controller.mutate(Methods.PR_TEAM_SAVE, {
                  config: event.detail,
                  ...(this.selectedTeam
                    ? { id: this.selectedTeam.id, revision: this.selectedTeam.revision }
                    : {}),
                })
              ) {
                this.editor = undefined;
                this.preview = undefined;
              }
            }}
          ></pr-team-form>`
        : this.editor === 'rule'
          ? html`<pr-rule-form
              .initial=${this.selectedRule?.config}
              .teams=${controller.reviews.teams}
              .slots=${controller.slots}
              .disabled=${disabled}
              @rule-save=${async (event: CustomEvent<PRTriggerRuleConfig>) => {
                if (
                  await controller.mutate(Methods.PR_RULE_SAVE, {
                    config: event.detail,
                    ...(this.selectedRule
                      ? { id: this.selectedRule.id, revision: this.selectedRule.revision }
                      : {}),
                  })
                ) {
                  this.editor = undefined;
                  this.preview = undefined;
                }
              }}
            ></pr-rule-form>`
          : this.editor === 'monitor' || this.editor === 'policy'
            ? html` <pr-monitor-form
                .initial=${this.initialConfig}
                .publication=${this.editor === 'policy'}
                .enabled=${this.selectedPolicy?.enabled ?? false}
                .projects=${this.editor === 'policy' && !this.selectedPolicy
                  ? controller.projects.filter(
                      (project) =>
                        !controller.monitors.projectPolicies?.some(
                          (policy) => policy.project === project,
                        ),
                    )
                  : controller.projects}
                .slots=${controller.slots}
                .disabled=${disabled}
                @monitor-save=${this.saveMonitor}
              ></pr-monitor-form>`
            : this.editor === 'request'
              ? html` <pr-review-request-form
                  .teams=${controller.reviews.teams}
                  .slots=${controller.slots}
                  .disabled=${disabled}
                  @review-request=${async (event: CustomEvent<PRReviewRequest>) => {
                    if (
                      await controller.mutate(Methods.PR_REVIEW_REQUEST, { request: event.detail })
                    )
                      this.editor = undefined;
                  }}
                ></pr-review-request-form>`
              : html` <form
                  @submit=${async (event: SubmitEvent) => {
                    event.preventDefault();
                    if (
                      await controller.mutate(Methods.PR_WATCH_REPAIR, {
                        id: this.selectedMonitor?.id,
                        revision: this.selectedMonitor?.revision,
                        project: this.repairProject,
                        execution: this.repairExecution,
                      })
                    )
                      this.editor = undefined;
                  }}
                >
                  <label
                    >Project<select
                      required
                      .value=${this.repairProject}
                      ?disabled=${disabled}
                      @change=${(event: Event) => {
                        this.repairProject = (event.target as HTMLSelectElement).value;
                      }}
                    >
                      <option value="">Choose a project</option>
                      ${controller.projects.map(
                        (project) => html`<option .value=${project}>${project}</option>`,
                      )}
                    </select></label
                  >
                  <pr-execution-picker
                    .project=${this.repairProject}
                    .slots=${controller.slots}
                    .value=${this.repairExecution}
                    .disabled=${disabled}
                    @execution-change=${(event: CustomEvent<PRExecutionProfile>) => {
                      this.repairExecution = event.detail;
                    }}
                  ></pr-execution-picker>
                  <button class="primary" ?disabled=${disabled} type="submit">Queue repair</button>
                </form>`}
    </section>`;
  }
  private renderReviews(disabled: boolean) {
    const { reviews } = this.controller;
    const intents = reviews.intents.filter(
      (intent) => this.showHistory || !['completed', 'failed', 'withdrawn'].includes(intent.status),
    );
    const requests = (reviews.submissions ?? []).filter(
      (request) => this.showHistory || !request.cancelledAt,
    );
    return html`
      <button
        data-testid="pr-review-request-open"
        ?disabled=${disabled}
        @click=${() => {
          this.editor = 'request';
        }}
      >
        Request review / QA
      </button>
      ${!intents.length && !requests.length
        ? html`<p class="muted">
            No review requests yet. Add a PR directly or enable a review rule.
          </p>`
        : nothing}
      ${requests.map(
        (request) =>
          html`<div
            class="card"
            data-request-id=${request.id}
            data-request-pr=${monitoredPRKey(request.request.pr)}
          >
            <p>
              ${request.request.pr.repo}#${request.request.pr.number} ·
              ${request.request.source.client}${request.request.source.requester
                ? ` · ${request.request.source.requester}`
                : ''}
            </p>
            <p class=${request.error ? 'error' : 'muted'}>
              ${request.cancelledAt
                ? 'Request cancelled'
                : (request.error ??
                  (request.intentId
                    ? 'Linked to the review queue below'
                    : 'Waiting for source observation'))}
            </p>
            <button
              data-testid="pr-review-request-cancel"
              ?disabled=${disabled ||
              Boolean(request.cancelledAt) ||
              Boolean(reviews.intents.find((intent) => intent.id === request.intentId)?.runId)}
              @click=${() =>
                void this.controller.mutate(Methods.PR_REVIEW_REQUEST_CANCEL, {
                  id: request.id,
                  revision: request.revision,
                })}
            >
              Cancel request
            </button>
          </div>`,
      )}
      ${intents.map((intent) =>
        reviewCard(
          intent,
          reviews.teams,
          getState().runs,
          getState().queueItems,
          disabled,
          (id, action) =>
            void this.controller.mutate(
              action === 'accept' ? Methods.PR_REVIEW_ACCEPT : Methods.PR_REVIEW_DEFER,
              { id },
            ),
        ),
      )}
    `;
  }
  private renderRules(disabled: boolean) {
    return html`
      <p class="muted">Team policies apply to direct requests and automatic discovery.</p>
      <div class="row">
        <button
          data-testid="pr-team-create"
          ?disabled=${disabled}
          @click=${() => {
            this.selectedTeam = undefined;
            this.editor = 'team';
          }}
        >
          Create team
        </button>
        <button
          data-testid="pr-rule-create"
          ?disabled=${disabled || !this.controller.reviews.teams.length}
          @click=${() => {
            this.selectedRule = undefined;
            this.editor = 'rule';
          }}
        >
          Create rule
        </button>
      </div>
      ${(this.controller.reviews.notifications ?? [])
        .filter((note) => this.showHistory || (note.current && !note.acknowledgedAt))
        .map((note) =>
          ruleNotificationCard(
            note,
            disabled,
            () => void this.controller.mutate(Methods.PR_RULE_ACTION_ACKNOWLEDGE, { id: note.id }),
          ),
        )}
      ${(this.controller.reviews.actions ?? [])
        .filter(
          (action) =>
            (action.kind === 'monitor' || action.status !== 'applied') &&
            (this.showHistory || action.current),
        )
        .map((action) =>
          ruleActionCard(
            action,
            disabled ||
              !this.controller.monitors.monitors.some((monitor) => monitor.id === action.monitorId),
            () => {
              const monitor = this.controller.monitors.monitors.find(
                (item) => item.id === action.monitorId,
              );
              if (monitor) this.openMonitor(monitor);
            },
          ),
        )}
      ${this.controller.reviews.teams.map(
        (team) =>
          html`<div class="card" data-team-name=${team.config.name}>
            <h3>${team.config.name}</h3>
            <p>
              ${team.config.account.login} ·
              ${team.config.repositories.map((policy) => policy.repo).join(', ')}
            </p>
            <p class="muted">
              ${team.config.sources
                .map((source) => (source.kind === 'repository' ? source.repo : source.label))
                .join(', ')}
            </p>
            <button
              data-testid="pr-team-edit"
              ?disabled=${disabled}
              @click=${() => {
                this.selectedTeam = team;
                this.editor = 'team';
              }}
            >
              Edit team
            </button>
          </div>`,
      )}
      ${this.controller.reviews.rules.map(
        (rule) =>
          html`<div class="card" data-rule-name=${rule.config.name} data-rule-id=${rule.id}>
            <h3>${rule.config.name} · ${rule.enabled ? 'Enabled' : 'Disabled'}</h3>
            <p class="muted">
              ${rule.scan.checkedAt
                ? `Last scan ${new Date(rule.scan.checkedAt).toLocaleString()}`
                : 'Not scanned yet'}
            </p>
            ${sourceProgress(rule.scan.sourceProgress)}
            ${rule.scan.error ? html`<p class="error">${rule.scan.error}</p>` : nothing}${rule.scan
              .admissionWarning
              ? html`<p class="attention">${rule.scan.admissionWarning}</p>`
              : nothing}
            <div class="row">
              <button
                data-testid="pr-rule-edit"
                ?disabled=${disabled}
                @click=${() => {
                  this.selectedRule = rule;
                  this.editor = 'rule';
                }}
              >
                Edit rule
              </button>
              <button
                data-testid="pr-rule-preview"
                ?disabled=${disabled}
                @click=${async () => {
                  const result = await this.controller.mutate<PRRulePreviewResult>(
                    Methods.PR_RULE_PREVIEW,
                    { id: rule.id },
                  );
                  if (result) this.preview = result.preview;
                }}
              >
                Preview matches
              </button>
              <button
                data-testid="pr-rule-toggle"
                ?disabled=${disabled || (!rule.enabled && !this.previewIsCurrent(rule))}
                @click=${() =>
                  void this.controller.mutate(Methods.PR_RULE_SET_ENABLED, {
                    id: rule.id,
                    revision: rule.revision,
                    enabled: !rule.enabled,
                    backfill: false,
                  })}
              >
                ${rule.enabled ? 'Disable' : 'Enable future matches'}
              </button>
              <button
                ?disabled=${disabled || !rule.enabled}
                @click=${() => void this.controller.mutate(Methods.PR_RULE_SCAN, { id: rule.id })}
              >
                Scan now
              </button>
              <button
                ?disabled=${disabled || !this.previewIsCurrent(rule)}
                @click=${() =>
                  void this.controller.mutate(Methods.PR_RULE_SET_ENABLED, {
                    id: rule.id,
                    revision: rule.revision,
                    enabled: true,
                    backfill: true,
                  })}
              >
                Import previewed matches
              </button>
            </div>
          </div>`,
      )}
      ${this.preview
        ? html`<section aria-label="Rule preview">
            <h3>Preview · ${this.preview.complete ? 'Complete' : 'Incomplete coverage'}</h3>
            ${sourceProgress(this.preview.sourceProgress)}
            ${this.preview.ignoredItems
              ? html`<p class="muted">
                  ${this.preview.ignoredItems} archived or non-PR Project items excluded.
                </p>`
              : nothing}
            ${this.preview.sourceErrors.map(
              (error) => html`<p class="error">${error}</p>`,
            )}${this.preview.items.map(
              (item) =>
                html`<p>
                  ${item.subject.pr.repo}#${item.subject.pr.number}: ${item.match.state} ·
                  ${item.match.reasons.join('; ')}${item.configurationErrors.length
                    ? ` · ${item.configurationErrors.join('; ')}`
                    : ''}${Object.entries(item.actionErrors ?? {}).map(
                    ([kind, errors]) =>
                      html`<span class="error"> · ${kind}: ${errors.join('; ')}</span>`,
                  )}
                  ${(item.policySummary ?? []).map(
                    (summary) => html`<span class="muted"> · ${summary}</span>`,
                  )}
                </p>`,
            )}
          </section>`
        : nothing}
    `;
  }
  private previewIsCurrent(rule: PRTriggerRule): boolean {
    const team = this.controller.reviews.teams.find((item) => item.id === rule.config.teamId);
    return (
      !!this.preview?.complete &&
      this.preview.ruleId === rule.id &&
      this.preview.ruleRevision === rule.revision &&
      this.preview.teamId === team?.id &&
      this.preview.teamRevision === team?.revision
    );
  }
  render() {
    const controller = this.controller;
    const disabled = controller.busy || !controller.connected;
    const monitors = controller.monitors.monitors.filter(
      (monitor) => this.showHistory || !['stopped', 'finished'].includes(monitor.lifecycle),
    );
    return html`<section aria-label="PR automation">
      <div class="row">
        <h2>PR monitoring and reviews</h2>
        <span class="spacer"></span
        ><button
          ?disabled=${disabled || controller.loading}
          @click=${() => void controller.refresh()}
        >
          ${controller.loading ? 'Refreshing…' : 'Refresh queue'}
        </button>
      </div>
      <div class="row" role="tablist" aria-label="PR automation views">
        ${(['monitors', 'reviews', 'rules', 'policies', 'attention'] as const).map(
          (tab) =>
            html`<button
              data-testid=${`pr-automation-tab-${tab}`}
              role="tab"
              aria-selected=${String(this.tab === tab)}
              @click=${() => {
                this.tab = tab;
                this.editor = undefined;
              }}
            >
              ${{
                monitors: 'Monitored PRs',
                reviews: 'Review queue',
                rules: 'Rules',
                policies: 'Project defaults',
                attention: 'Notifications',
              }[tab]}
            </button>`,
        )}<label class="check"
          ><input
            type="checkbox"
            .checked=${this.showHistory}
            @change=${(event: Event) => {
              this.showHistory = (event.target as HTMLInputElement).checked;
            }}
          />Show history</label
        >
      </div>
      ${!controller.connected
        ? html`<p class="attention">Reconnect to the gateway to load current PR work.</p>`
        : nothing}
      ${[
        controller.error,
        controller.actionError,
        controller.monitors.schedulerError,
        controller.reviews.schedulerError,
        controller.push.schedulerError,
      ]
        .filter(Boolean)
        .map((error) => html`<p role="alert" class="error">${error}</p>`)}
      ${this.renderEditor(disabled)}
      <div role="tabpanel">
        ${this.tab === 'monitors'
          ? html`<button ?disabled=${disabled} @click=${() => this.openMonitor()}>
                Add PR monitoring</button
              >${!monitors.length
                ? html`<p class="muted">
                    No active subscriptions. Add any accessible PR to keep watching it after its run
                    ends.
                  </p>`
                : nothing}${monitors.map((monitor) =>
                monitorCard(
                  monitor,
                  disabled,
                  (action, item, incident) => void this.actOnMonitor(action, item, incident),
                ),
              )}`
          : this.tab === 'reviews'
            ? this.renderReviews(disabled)
            : this.tab === 'rules'
              ? this.renderRules(disabled)
              : this.tab === 'attention'
                ? prPushPanel(
                    controller.push,
                    this.showHistory,
                    disabled,
                    (sourceId) => void controller.mutate(Methods.PR_PUSH_ACKNOWLEDGE, { sourceId }),
                  )
                : html` <p class="muted">
                      Publication monitoring is off until explicitly enabled for a project.
                    </p>
                    <button ?disabled=${disabled} @click=${() => this.openPolicy()}>
                      Configure a project
                    </button>
                    ${(controller.monitors.projectPolicies ?? []).map(
                      (policy) =>
                        html`<div class="card">
                          <h3>${policy.project}</h3>
                          <p>
                            ${policy.enabled ? 'Enabled for new publications' : 'Disabled'} ·
                            ${policy.config.policy.mode}
                          </p>
                          ${controller.monitors.publicationErrors?.[policy.project]
                            ? html`<p class="error">
                                ${controller.monitors.publicationErrors[policy.project]}
                              </p>`
                            : nothing}<button
                            ?disabled=${disabled}
                            @click=${() => this.openPolicy(policy)}
                          >
                            Configure
                          </button>
                        </div>`,
                    )}`}
      </div>
    </section>`;
  }
}
