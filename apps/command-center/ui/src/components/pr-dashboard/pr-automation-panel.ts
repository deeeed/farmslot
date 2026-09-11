import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import { repeat } from 'lit/directives/repeat.js';

import {
  Methods,
  type MonitoredPRIdentity,
  monitoredPRKey,
  monitoredPRUrl,
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

import '../shared/choice-picker.js';
import './pr-monitor-form.js';
import './pr-review-request-form.js';
import './pr-team-form.js';
import './pr-rule-form.js';

import { gateway } from '../../gateway-client.js';
import { getState } from '../../state.js';
import type { ChoicePicker } from '../shared/choice-picker.js';

import {
  monitorCard,
  reviewCard,
  ruleActionCard,
  ruleNotificationCard,
} from './pr-automation-cards.js';
import { PRAutomationController } from './pr-automation-controller.js';
import {
  createPRDraftId,
  prDraftScope,
  type PRFormDraft,
  readPRDraft,
  removePRDraft,
  writePRDraft,
} from './pr-automation-draft-store.js';
import { prAutomationStyles } from './pr-automation-styles.js';
import {
  buildPRAutomationUrl,
  parsePRAutomationUrl,
  type PRAutomationUrlState,
} from './pr-automation-url-state.js';
import { type PRKey, prKeyEqual, prReviewDispatchHash } from './pr-board-url-state.js';
import { newPRExecution } from './pr-execution-picker.js';
import type { PRMonitorFormSave } from './pr-monitor-form.js';
import { prPushPanel } from './pr-push-panel.js';
import { sourceProgress } from './pr-source-progress.js';
import type { PRProjectImportRequest, PRTeamForm } from './pr-team-form.js';
import type { PRPane } from './pr-workspace.js';

export type PRAutomationInventory = Pick<
  PRAutomationController,
  'monitors' | 'reviews' | 'projectConfigs' | 'error' | 'loading'
>;

@customElement('pr-automation-panel')
export class PRAutomationPanel extends LitElement {
  private readonly controller = new PRAutomationController(this);
  @property() mode: 'context' | 'management' = 'management';
  @property() pane: PRPane = 'monitoring';
  @property({ attribute: false }) selectedPr: PRKey | null = null;
  @property() selectedProject = '';
  @property() reviewBlockedReason = '';
  @property({ type: Boolean }) reviewStatusLoading = false;
  private emittedInventory?: PRAutomationInventory;
  @state() private tab: 'monitors' | 'reviews' | 'rules' | 'policies' | 'attention' = 'monitors';
  @property({ type: Boolean }) showHistory = false;
  @state() private editor?: 'monitor' | 'request' | 'repair' | 'policy' | 'team' | 'rule';
  @state() private selectedTeam?: PRTeamProfile;
  @state() private selectedRule?: PRTriggerRule;
  @state() private selectedMonitor?: PRMonitor;
  @state() private selectedPolicy?: PRProjectMonitorPolicy;
  @state() private initialConfig?: PRMonitorConfig;
  @state() private repairProject = '';
  @state() private repairExecution = newPRExecution();
  @state() private preview?: PRRulePreview;
  @state() private draftId?: string;
  @state() private restoredDraft?: PRFormDraft;
  @state() private navigationError = '';
  @state() private draftNotice = '';
  private pendingRoute?: PRAutomationUrlState;
  private restoringRoute = false;
  private editorVersion = 0;
  private lastDraft = '';
  private editorScope: string | null | undefined;
  private onHashChange = () => {
    this.pendingRoute = parsePRAutomationUrl(location.hash) ?? undefined;
    this.requestUpdate();
  };
  static styles = prAutomationStyles;

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('hashchange', this.onHashChange);
    window.addEventListener('popstate', this.onHashChange);
    this.onHashChange();
  }
  disconnectedCallback() {
    window.removeEventListener('hashchange', this.onHashChange);
    window.removeEventListener('popstate', this.onHashChange);
    super.disconnectedCallback();
  }
  protected willUpdate() {
    const scope = prDraftScope(gateway.gatewayUrl, gateway.authenticatedPrincipalId);
    if (
      this.editor &&
      this.controller.connected &&
      this.editorScope !== undefined &&
      this.editorScope !== scope
    ) {
      const pending = this.pendingRoute;
      this.closeEditor();
      this.pendingRoute = pending;
      this.navigationError =
        'Gateway or signed-in account changed. Reopen the configuration to continue.';
    }
    if (
      this.pendingRoute &&
      this.controller.connected &&
      !this.controller.loading &&
      !this.controller.error
    )
      this.restoreRoute();
    if (this.mode === 'management' && (this.tab === 'monitors' || this.tab === 'reviews'))
      this.tab = 'rules';
  }
  protected updated(changes: Map<string, unknown>) {
    const inventory = {
      monitors: this.controller.monitors,
      reviews: this.controller.reviews,
      projectConfigs: this.controller.projectConfigs,
      error: this.controller.error,
      loading: this.controller.loading,
    };
    if (
      !this.emittedInventory ||
      Object.keys(inventory).some(
        (key) =>
          inventory[key as keyof PRAutomationInventory] !==
          this.emittedInventory?.[key as keyof PRAutomationInventory],
      )
    ) {
      this.emittedInventory = inventory;
      this.dispatchEvent(
        new CustomEvent('pr-automation-inventory', {
          detail: inventory,
          bubbles: true,
          composed: true,
        }),
      );
    }
    if (changes.has('editor'))
      this.dispatchEvent(
        new CustomEvent('pr-automation-editing', {
          detail: !!this.editor,
          bubbles: true,
          composed: true,
        }),
      );
    if (this.restoringRoute) {
      this.restoringRoute = false;
      return;
    }
    if (this.pendingRoute) return;
    if (['tab', 'editor', 'showHistory', 'draftId'].some((key) => changes.has(key))) this.syncUrl();
    if (changes.has('editor') && (this.editor === 'team' || this.editor === 'rule')) {
      const form = this.renderRoot.querySelector<
        { snapshotDraft(): PRFormDraft; updateComplete: Promise<boolean> } & Element
      >(this.editor === 'team' ? 'pr-team-form' : 'pr-rule-form');
      const draftId = this.draftId;
      if (form)
        void form.updateComplete.then(() => {
          if (form.isConnected && this.draftId === draftId) this.persistDraft(form.snapshotDraft());
        });
    }
  }
  private target() {
    if (this.editor === 'team') return this.selectedTeam?.id;
    if (this.editor === 'rule') return this.selectedRule?.id;
    if (this.editor === 'policy') return this.selectedPolicy?.project;
    if (this.editor === 'monitor' || this.editor === 'repair') return this.selectedMonitor?.id;
    return undefined;
  }
  private syncUrl(replace = false) {
    const next = buildPRAutomationUrl(
      {
        tab: this.tab,
        editor: this.editor,
        target: this.target(),
        draft: this.draftId,
        history: this.showHistory,
      },
      location.hash,
    );
    if (next && next !== location.hash) {
      if (replace) history.replaceState(null, '', next);
      else history.pushState(null, '', next);
      this.dispatchEvent(
        new CustomEvent('pr-automation-navigation', { bubbles: true, composed: true }),
      );
    }
  }
  private openEditor(editor: NonNullable<PRAutomationUrlState['editor']>) {
    this.editorVersion++;
    this.pendingRoute = undefined;
    this.navigationError = '';
    this.draftNotice = '';
    this.restoredDraft = undefined;
    this.lastDraft = '';
    this.editorScope = prDraftScope(gateway.gatewayUrl, gateway.authenticatedPrincipalId);
    this.draftId = editor === 'team' || editor === 'rule' ? createPRDraftId() : undefined;
    this.editor = editor;
  }
  closeEditor() {
    this.editorVersion++;
    this.editorScope = undefined;
    this.pendingRoute = undefined;
    this.editor = undefined;
    this.draftId = undefined;
    this.restoredDraft = undefined;
    this.lastDraft = '';
    this.draftNotice = '';
  }
  private finishEditor() {
    const scope = this.editorScope;
    if (scope && this.draftId)
      try {
        removePRDraft(localStorage, scope, this.draftId);
      } catch {
        this.navigationError = 'Saved, but this browser could not remove the local draft.';
      }
    this.closeEditor();
  }
  private async mutateEditor<T>(method: string, params: unknown): Promise<T | undefined> {
    const version = this.editorVersion;
    const result = await this.controller.mutate<T>(method, params);
    return this.isConnected && version === this.editorVersion ? result : undefined;
  }
  private persistDraft(payload: PRFormDraft) {
    if (this.pendingRoute || payload.kind !== this.editor) return;
    const scope = prDraftScope(gateway.gatewayUrl, gateway.authenticatedPrincipalId);
    if (scope !== this.editorScope) return;
    if (!scope) {
      this.draftNotice = 'Connect with a gateway identity to restore drafts after reload.';
      return;
    }
    this.draftId ??= createPRDraftId();
    const text = JSON.stringify(payload);
    if (text === this.lastDraft) return;
    try {
      writePRDraft(localStorage, scope, this.draftId, {
        version: 1,
        payload,
        target: this.target(),
        revision:
          this.editor === 'team' ? this.selectedTeam?.revision : this.selectedRule?.revision,
      });
      this.lastDraft = text;
      this.draftNotice = 'Draft saved in this browser. Save to apply it to the gateway.';
      this.syncUrl(true);
    } catch {
      this.draftNotice =
        'This browser could not save the draft. Save to the gateway before leaving.';
    }
  }
  private restoreRoute() {
    const route = this.pendingRoute!;
    this.pendingRoute = undefined;
    this.restoringRoute = true;
    this.editorScope = prDraftScope(gateway.gatewayUrl, gateway.authenticatedPrincipalId);
    this.tab = route.tab;
    this.showHistory = route.history;
    this.editor = route.editor;
    this.draftId = route.draft;
    this.restoredDraft = undefined;
    this.selectedTeam = undefined;
    this.selectedRule = undefined;
    this.selectedMonitor = undefined;
    this.selectedPolicy = undefined;
    this.initialConfig = undefined;
    this.navigationError = '';
    this.lastDraft = '';
    if (!route.editor) return;
    const target = route.target;
    if (target) {
      if (route.editor === 'team')
        this.selectedTeam = this.controller.reviews.teams.find((item) => item.id === target);
      else if (route.editor === 'rule')
        this.selectedRule = this.controller.reviews.rules.find((item) => item.id === target);
      else if (route.editor === 'policy') {
        const policy = this.controller.monitors.projectPolicies?.find(
          (item) => item.project === target,
        );
        if (policy) this.openPolicy(policy);
      } else if (route.editor === 'monitor' || route.editor === 'repair') {
        this.selectedMonitor = this.controller.monitors.monitors.find((item) => item.id === target);
        this.initialConfig = this.selectedMonitor?.config;
        this.repairProject = this.selectedMonitor?.config.project ?? '';
        this.repairExecution =
          this.selectedMonitor?.config.policy.mode === 'automatic-repair'
            ? structuredClone(this.selectedMonitor.config.policy.execution)
            : newPRExecution();
      }
      if (!this.target()) {
        this.editor = undefined;
        this.navigationError = 'This configuration is not available on the connected gateway.';
        this.syncUrl(true);
        return;
      }
    } else if (route.editor === 'repair') {
      this.editor = undefined;
      this.navigationError = 'Open a monitored PR to request repair.';
      this.syncUrl(true);
      return;
    }
    this.draftId =
      route.draft ??
      (route.editor === 'team' || route.editor === 'rule' ? createPRDraftId() : undefined);
    if (route.draft && (route.editor === 'team' || route.editor === 'rule')) {
      const scope = prDraftScope(gateway.gatewayUrl, gateway.authenticatedPrincipalId);
      try {
        const saved = scope ? readPRDraft(localStorage, scope, route.draft) : null;
        if (!saved || saved.payload.kind !== route.editor || saved.target !== target)
          throw new Error('Draft unavailable');
        this.restoredDraft = saved.payload;
        this.lastDraft = JSON.stringify(saved.payload);
        if (this.selectedTeam && saved.revision !== undefined)
          this.selectedTeam = { ...this.selectedTeam, revision: saved.revision };
        if (this.selectedRule && saved.revision !== undefined)
          this.selectedRule = { ...this.selectedRule, revision: saved.revision };
        this.draftNotice = 'Restored draft from this browser. Save to apply it to the gateway.';
      } catch {
        this.editor = undefined;
        this.navigationError =
          'This private draft is not available for this browser, gateway, and account.';
        this.syncUrl(true);
      }
    }
  }
  openMonitor(monitor?: PRMonitor) {
    this.selectedMonitor = monitor;
    this.initialConfig = monitor?.config;
    this.openEditor('monitor');
  }
  openRequest() {
    this.openEditor('request');
  }
  private matchesSelected(pr: MonitoredPRIdentity) {
    return prKeyEqual(this.selectedPr, { repo: pr.repo, pr: pr.number, host: pr.host });
  }
  private get selectedUrl() {
    return this.selectedPr
      ? monitoredPRUrl({
          host: this.selectedPr.host ?? 'github.com',
          repo: this.selectedPr.repo,
          number: this.selectedPr.pr,
        })
      : '';
  }
  private selectPR(pr: MonitoredPRIdentity, pane: 'monitoring' | 'review') {
    this.dispatchEvent(
      new CustomEvent('pr-automation-select', {
        detail: { key: { host: pr.host, repo: pr.repo, pr: pr.number }, pane },
        bubbles: true,
        composed: true,
      }),
    );
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
    this.openEditor('policy');
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
      result = await this.mutateEditor(Methods.PR_WATCH_PROJECT_POLICY_SET, {
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
      result = await this.mutateEditor(
        this.selectedMonitor ? Methods.PR_WATCH_CONFIGURE : Methods.PR_WATCH_SUBSCRIBE,
        {
          ...(this.selectedMonitor
            ? { id: this.selectedMonitor.id, revision: this.selectedMonitor.revision }
            : {}),
          config,
        },
      );
    if (result) {
      const isPolicy = this.editor === 'policy';
      this.finishEditor();
      if (!isPolicy) this.selectPR(config.pr, 'monitoring');
    }
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
      this.openEditor('repair');
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
            this.closeEditor();
          }}
        >
          Close editor
        </button>
      </div>
      ${this.draftNotice
        ? html`<p class="muted" data-testid="pr-draft-notice">${this.draftNotice}</p>
            <button
              type="button"
              data-testid="pr-draft-discard"
              ?disabled=${controller.busy}
              @click=${() => this.finishEditor()}
            >
              Discard local draft
            </button>`
        : nothing}
      ${this.editor === 'team'
        ? html`<pr-team-form
            .initial=${this.selectedTeam?.config}
            .restoredDraft=${this.restoredDraft?.kind === 'team'
              ? this.restoredDraft.value
              : undefined}
            @pr-draft-change=${(event: CustomEvent<PRFormDraft>) => {
              event.stopPropagation();
              this.persistDraft(event.detail);
            }}
            .farms=${controller.projectConfigs}
            .accounts=${controller.githubAccounts}
            .accountError=${controller.accountsError}
            @refresh-accounts=${() => void controller.refreshAccounts(true)}
            .projects=${controller.projects}
            .slots=${controller.slots}
            .disabled=${disabled}
            @project-import=${async (event: CustomEvent<PRProjectImportRequest>) => {
              const form = event.currentTarget as PRTeamForm;
              const result = await controller.mutate<PRProjectImportResult>(
                Methods.PR_RULE_PROJECT_IMPORT,
                { account: event.detail.account, url: event.detail.url },
              );
              if (
                result &&
                form.isConnected &&
                this.editor === 'team' &&
                this.editorScope ===
                  prDraftScope(gateway.gatewayUrl, gateway.authenticatedPrincipalId)
              )
                form.applyProjectImport(result, event.detail.catalogOnly);
            }}
            @team-save=${async (event: CustomEvent<PRTeamConfig>) => {
              if (
                await this.mutateEditor(Methods.PR_TEAM_SAVE, {
                  config: event.detail,
                  ...(this.selectedTeam
                    ? { id: this.selectedTeam.id, revision: this.selectedTeam.revision }
                    : {}),
                })
              ) {
                this.finishEditor();
                this.preview = undefined;
              }
            }}
          ></pr-team-form>`
        : this.editor === 'rule'
          ? html`<pr-rule-form
              .initial=${this.selectedRule?.config}
              .restoredDraft=${this.restoredDraft?.kind === 'rule'
                ? this.restoredDraft.value
                : undefined}
              @pr-draft-change=${(event: CustomEvent<PRFormDraft>) => {
                event.stopPropagation();
                this.persistDraft(event.detail);
              }}
              .teams=${controller.reviews.teams}
              .slots=${controller.slots}
              .disabled=${disabled}
              @rule-save=${async (event: CustomEvent<PRTriggerRuleConfig>) => {
                if (
                  await this.mutateEditor(Methods.PR_RULE_SAVE, {
                    config: event.detail,
                    ...(this.selectedRule
                      ? { id: this.selectedRule.id, revision: this.selectedRule.revision }
                      : {}),
                  })
                ) {
                  this.finishEditor();
                  this.preview = undefined;
                }
              }}
            ></pr-rule-form>`
          : this.editor === 'monitor' || this.editor === 'policy'
            ? html` <pr-monitor-form
                .prUrl=${this.editor === 'monitor' && !this.selectedMonitor ? this.selectedUrl : ''}
                .accounts=${controller.githubAccounts}
                .accountError=${controller.accountsError}
                @refresh-accounts=${() => void controller.refreshAccounts(true)}
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
                  .prUrl=${this.selectedUrl}
                  .teams=${controller.reviews.teams}
                  .slots=${controller.slots}
                  .disabled=${disabled}
                  @review-request=${async (event: CustomEvent<PRReviewRequest>) => {
                    if (
                      await this.mutateEditor(Methods.PR_REVIEW_REQUEST, { request: event.detail })
                    ) {
                      this.closeEditor();
                      this.selectPR(event.detail.pr, 'review');
                    }
                  }}
                ></pr-review-request-form>`
              : html` <form
                  data-testid="pr-agent-repair-form"
                  @submit=${async (event: SubmitEvent) => {
                    event.preventDefault();
                    if (
                      await this.mutateEditor(Methods.PR_WATCH_REPAIR, {
                        id: this.selectedMonitor?.id,
                        revision: this.selectedMonitor?.revision,
                        project: this.repairProject,
                        execution: this.repairExecution,
                      })
                    )
                      this.closeEditor();
                  }}
                >
                  <p class="attention">
                    Queue an agent to investigate and fix unresolved PR issues. It may change code
                    and push commits. This does not simply rerun CI.
                  </p>
                  <label
                    >Project<choice-picker
                      required
                      .value=${this.repairProject}
                      ?disabled=${disabled}
                      @change=${(event: Event) => {
                        this.repairProject = (event.target as ChoicePicker).value;
                      }}
                    >
                      <option value="">Choose a project</option>
                      ${controller.projects.map(
                        (project) => html`<option .value=${project}>${project}</option>`,
                      )}
                    </choice-picker></label
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
                  <button class="primary" ?disabled=${disabled} type="submit">
                    Queue agent repair
                  </button>
                </form>`}
    </section>`;
  }
  private renderReviews(disabled: boolean, selectedOnly = false) {
    const { reviews } = this.controller;
    const intents = reviews.intents.filter(
      (intent) =>
        (this.showHistory || !['completed', 'failed', 'withdrawn'].includes(intent.status)) &&
        (!selectedOnly || this.matchesSelected(intent.pr)),
    );
    const requests = (reviews.submissions ?? []).filter(
      (request) =>
        (this.showHistory || !request.cancelledAt) &&
        (!selectedOnly || this.matchesSelected(request.request.pr)),
    );
    return html`
      <button
        data-testid="pr-review-request-open"
        ?disabled=${disabled ||
        (selectedOnly && (!!this.reviewBlockedReason || this.reviewStatusLoading))}
        @click=${() => {
          this.openEditor('request');
        }}
      >
        Request review / QA
      </button>
      ${selectedOnly && this.reviewBlockedReason
        ? html`<p class="muted" data-testid="pr-review-start-blocked">
            ${this.reviewBlockedReason}
          </p>`
        : nothing}
      ${selectedOnly &&
      this.selectedPr &&
      (this.selectedPr.host ?? 'github.com').toLowerCase() === 'github.com'
        ? html`<a
              class="review-dispatch-link"
              data-testid=${this.reviewBlockedReason || this.reviewStatusLoading
                ? 'pr-review-force'
                : 'pr-review-dispatch'}
              href=${prReviewDispatchHash({
                repo: this.selectedPr.repo,
                pr: this.selectedPr.pr,
                project: this.selectedProject || undefined,
              })}
              >${this.reviewBlockedReason || this.reviewStatusLoading
                ? 'Review anyway'
                : 'Open review dispatch'}</a
            >
            <p class="muted">
              ${this.reviewBlockedReason || this.reviewStatusLoading
                ? 'Set up a full manual review of this PR, even if no review is required. Nothing starts until you submit it.'
                : 'Use review dispatch to continue older manual reviews. Incremental scope requires a recorded reviewed commit; opening setup does not start a run.'}
            </p>`
        : nothing}
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
          disabled || (selectedOnly && this.reviewStatusLoading),
          (id, action) =>
            void this.controller.mutate(
              action === 'accept' ? Methods.PR_REVIEW_ACCEPT : Methods.PR_REVIEW_DEFER,
              { id },
            ),
          selectedOnly,
          selectedOnly ? this.reviewBlockedReason : undefined,
        ),
      )}
    `;
  }
  private renderRules(disabled: boolean) {
    return html`
      <div class="setup-help" data-testid="pr-team-rule-help">
        <p>
          <strong>Teams define which PRs.</strong> Choose repositories or Projects, filter by label
          or author, and set shared review settings.
        </p>
        <p>
          <strong>Rules define what happens.</strong> Use a team's filters, optionally narrow them,
          then monitor PRs, request reviews, or send notifications. One team can have multiple
          rules.
        </p>
        <p class="muted">
          Create a team first, then add a rule. Preview matches before enabling it. Saving a team
          alone does not start automation.
        </p>
      </div>
      <div class="row">
        <button
          data-testid="pr-team-create"
          ?disabled=${disabled}
          @click=${() => {
            this.selectedTeam = undefined;
            this.openEditor('team');
          }}
        >
          Create team
        </button>
        <button
          data-testid="pr-rule-create"
          ?disabled=${disabled || !this.controller.reviews.teams.length}
          @click=${() => {
            this.selectedRule = undefined;
            this.openEditor('rule');
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
      <h3 class="config-group-title">Teams</h3>
      ${this.controller.reviews.teams.map(
        (team) =>
          html`<div class="card team-config-card" data-team-name=${team.config.name}>
            <div class="row">
              <span class="config-kind team-kind">Team</span>
              <h3>${team.config.name}</h3>
            </div>
            <p>
              ${team.config.account.login} ·
              ${team.config.repositories.map((policy) => policy.repo).join(', ')}
            </p>
            ${team.config.sources.some((source) => source.kind !== 'repository')
              ? html`<p class="muted">
                  ${team.config.sources
                    .flatMap((source) => (source.kind === 'repository' ? [] : [source.label]))
                    .join(', ')}
                </p>`
              : nothing}
            <button
              data-testid="pr-team-edit"
              ?disabled=${disabled}
              @click=${() => {
                this.selectedTeam = team;
                this.openEditor('team');
              }}
            >
              Edit team
            </button>
          </div>`,
      )}
      <h3 class="config-group-title">Rules</h3>
      ${this.controller.reviews.rules.map(
        (rule) =>
          html`<div
            class="card rule-config-card"
            data-rule-name=${rule.config.name}
            data-rule-id=${rule.id}
          >
            <div class="row">
              <span class="config-kind rule-kind">Rule</span>
              <h3>${rule.config.name}</h3>
              <span class="config-state" data-enabled=${String(rule.enabled)}
                >${rule.enabled ? 'Enabled' : 'Disabled'}</span
              >
            </div>
            <p>
              Team:
              <strong
                >${this.controller.reviews.teams.find((team) => team.id === rule.config.teamId)
                  ?.config.name ?? 'Unavailable team'}</strong
              >
            </p>
            <p class="muted">
              ${rule.config.actions
                .map((action) =>
                  action.kind === 'review'
                    ? action.autoStart
                      ? 'Start reviews automatically'
                      : 'Queue reviews for approval'
                    : action.kind === 'monitor'
                      ? 'Monitor matching PRs'
                      : 'Notify team',
                )
                .join(' · ')}
            </p>
            <p class="muted">
              ${rule.scan.checkedAt
                ? `Last scan ${new Date(rule.scan.checkedAt).toLocaleString()}`
                : 'Not scanned yet'}
            </p>
            <details>
              <summary>Discovery details</summary>
              ${sourceProgress(rule.scan.sourceProgress)}
            </details>
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
                  this.openEditor('rule');
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
    const matchingMonitors = controller.monitors.monitors.filter((monitor) =>
      this.matchesSelected(monitor.config.pr),
    );
    const feedback = html`
      ${!controller.connected
        ? html`<p class="attention">Reconnect to the gateway to load current PR work.</p>`
        : nothing}
      ${[
        this.navigationError,
        controller.error,
        controller.actionError,
        controller.monitors.schedulerError,
        controller.reviews.schedulerError,
        controller.push.schedulerError,
      ]
        .filter(Boolean)
        .map((error) => html`<p role="alert" class="error">${error}</p>`)}
      ${keyed(
        `${this.editor ?? ''}:${this.target() ?? ''}:${this.draftId ?? ''}`,
        this.renderEditor(disabled),
      )}
    `;
    if (this.mode === 'context')
      return html`<div class="context-automation">
        ${feedback}
        ${!this.selectedPr || this.editor
          ? nothing
          : this.pane === 'monitoring'
            ? html`
                ${matchingMonitors.length
                  ? nothing
                  : html`<button
                      data-testid="pr-monitor-add-selected"
                      ?disabled=${disabled}
                      @click=${() => this.openMonitor()}
                    >
                      Add monitoring for this PR
                    </button>`}
                ${repeat(
                  monitors.filter((monitor) => this.matchesSelected(monitor.config.pr)),
                  (monitor) => monitor.id,
                  (monitor) =>
                    monitorCard(
                      monitor,
                      disabled,
                      (action, item, incident) => void this.actOnMonitor(action, item, incident),
                      true,
                      true,
                    ),
                )}
                ${monitors.some((monitor) => this.matchesSelected(monitor.config.pr))
                  ? nothing
                  : matchingMonitors.length
                    ? html`<button
                        @click=${() => {
                          this.showHistory = true;
                        }}
                      >
                        Show previous monitoring
                      </button>`
                    : html`<p class="muted">This PR is not currently monitored.</p>`}
              `
            : this.pane === 'review'
              ? this.renderReviews(disabled, true)
              : nothing}
      </div>`;
    return html`<section class="automation-management" aria-label="PR automation">
      <div class="row">
        <h2>Automation</h2>
        <span class="spacer"></span
        ><button
          ?disabled=${disabled || controller.loading}
          @click=${() => void controller.refresh()}
        >
          ${controller.loading ? 'Refreshing…' : 'Refresh configuration'}
        </button>
      </div>
      <div class="row" role="tablist" aria-label="PR automation views">
        ${(['rules', 'policies', 'attention'] as const).map(
          (tab) =>
            html`<button
              data-testid=${`pr-automation-tab-${tab}`}
              role="tab"
              aria-selected=${String(this.tab === tab)}
              @click=${() => {
                this.tab = tab;
                this.closeEditor();
                this.navigationError = '';
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
      ${feedback}
      <div role="tabpanel">
        ${this.tab === 'rules'
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
