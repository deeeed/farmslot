import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  assertPRMonitorConfig,
  monitoredPRUrl,
  parseGitHubPullUrl,
  type PRExecutionProfile,
  type PRMonitorConfig,
  type SlotStatus,
} from '@farmslot/protocol';

import './pr-execution-picker.js';

import { prAutomationStyles } from './pr-automation-styles.js';
import { newPRExecution } from './pr-execution-picker.js';

export interface PRMonitorFormSave {
  config: PRMonitorConfig;
  enabled: boolean;
}

@customElement('pr-monitor-form')
export class PRMonitorForm extends LitElement {
  @property({ attribute: false }) initial?: PRMonitorConfig;
  @property({ attribute: false }) projects: string[] = [];
  @property({ attribute: false }) slots: SlotStatus[] = [];
  @property({ type: Boolean }) publication = false;
  @property({ type: Boolean }) enabled = false;
  @property({ type: Boolean }) disabled = false;
  @state() private url = '';
  @state() private login = '';
  @state() private project = '';
  @state() private automatic = false;
  @state() private execution = newPRExecution();
  @state() private pollMinutes = 5;
  @state() private cooldownMinutes = 30;
  @state() private attempts = 2;
  @state() private checks = '';
  @state() private error = '';
  static styles = prAutomationStyles;

  protected willUpdate(changed: Map<string, unknown>) {
    if (changed.has('initial') && this.initial) {
      const config = this.initial;
      this.url = monitoredPRUrl(config.pr);
      this.login = config.account.login;
      this.project = config.project ?? '';
      this.automatic = config.policy.mode === 'automatic-repair';
      this.execution =
        config.policy.mode === 'automatic-repair' ? config.policy.execution : newPRExecution();
      this.pollMinutes = config.pollIntervalMs / 60_000;
      this.cooldownMinutes = config.cooldownMs / 60_000;
      this.attempts = config.automaticAttemptLimit;
      this.checks = config.watchedChecks.join('\n');
    }
  }
  private save(event: SubmitEvent) {
    event.preventDefault();
    this.error = '';
    try {
      const parsed = this.publication
        ? { repo: 'validation/validation', number: 1 }
        : (this.initial?.pr ?? parseGitHubPullUrl(this.url));
      if (!parsed) throw new Error('Enter a GitHub pull request URL');
      if (this.publication && !this.project) throw new Error('Choose a project');
      const config: PRMonitorConfig = {
        pr: {
          host: this.initial?.pr.host ?? 'github.com',
          repo: parsed.repo,
          number: parsed.number,
        },
        account: { host: this.initial?.account.host ?? 'github.com', login: this.login.trim() },
        ...(this.project ? { project: this.project } : {}),
        ...(this.initial?.teamId ? { teamId: this.initial.teamId } : {}),
        policy: this.automatic
          ? { mode: 'automatic-repair', execution: this.execution }
          : { mode: 'notify-only' },
        pollIntervalMs: this.pollMinutes * 60_000,
        cooldownMs: this.cooldownMinutes * 60_000,
        automaticAttemptLimit: this.attempts,
        watchedChecks: this.checks
          .split('\n')
          .map((name) => name.trim())
          .filter(Boolean),
      };
      assertPRMonitorConfig(config);
      this.dispatchEvent(
        new CustomEvent<PRMonitorFormSave>('monitor-save', {
          detail: { config, enabled: this.enabled },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
  render() {
    return html`<form @submit=${this.save}>
      <fieldset ?disabled=${this.disabled}>
        <div class="grid">
          ${this.publication
            ? nothing
            : html`<label
                >PR URL<input
                  type="url"
                  required
                  .value=${this.url}
                  ?disabled=${Boolean(this.initial)}
                  placeholder="https://github.com/owner/repo/pull/42"
                  @input=${(event: Event) => {
                    this.url = (event.target as HTMLInputElement).value;
                  }}
              /></label>`}
          <label
            >GitHub account login<input
              required
              .value=${this.login}
              ?disabled=${Boolean(this.initial) && !this.publication}
              placeholder="Account configured on the gateway"
              @input=${(event: Event) => {
                this.login = (event.target as HTMLInputElement).value;
              }}
          /></label>
          <label
            >Project<select
              .value=${this.project}
              ?disabled=${this.publication && Boolean(this.initial?.project)}
              ?required=${this.publication || this.automatic}
              @change=${(event: Event) => {
                this.project = (event.target as HTMLSelectElement).value;
              }}
            >
              <option value="">Monitoring only, no project</option>
              ${[...new Set([...this.projects, this.project].filter(Boolean))].map(
                (name) => html`<option .value=${name}>${name}</option>`,
              )}
            </select></label
          >
          <label
            >Response<select
              .value=${this.automatic ? 'automatic' : 'notify'}
              @change=${(event: Event) => {
                this.automatic = (event.target as HTMLSelectElement).value === 'automatic';
              }}
            >
              <option value="notify">Notify only</option>
              <option value="automatic">Automatically run PR completion</option>
            </select></label
          >
        </div>
        ${this.publication
          ? html`<label class="check"
                ><input
                  type="checkbox"
                  .checked=${this.enabled}
                  @change=${(event: Event) => {
                    this.enabled = (event.target as HTMLInputElement).checked;
                  }}
                />Monitor newly published PRs from this project</label
              >
              <p class="muted">
                Opt-in applies to new publications. Existing PRs are not imported.
              </p>`
          : nothing}
        ${this.automatic
          ? html`<pr-execution-picker
              .project=${this.project}
              .slots=${this.slots}
              .value=${this.execution}
              .disabled=${this.disabled}
              @execution-change=${(event: CustomEvent<PRExecutionProfile>) => {
                this.execution = event.detail;
              }}
            ></pr-execution-picker>`
          : nothing}
        <details>
          <summary data-testid="pr-monitor-limits">Monitoring limits and checks</summary>
          <div class="grid">
            <label
              >Poll interval, minutes<input
                data-testid="pr-monitor-interval"
                type="number"
                min="1"
                max="1440"
                required
                .value=${String(this.pollMinutes)}
                @input=${(event: Event) => {
                  this.pollMinutes = Number((event.target as HTMLInputElement).value);
                }}
            /></label>
            <label
              >Automatic attempts per incident<input
                type="number"
                min="1"
                max="20"
                required
                .value=${String(this.attempts)}
                @input=${(event: Event) => {
                  this.attempts = Number((event.target as HTMLInputElement).value);
                }}
            /></label>
            <label
              >Retry cooldown, minutes<input
                type="number"
                min="1"
                max="10080"
                required
                .value=${String(this.cooldownMinutes)}
                @input=${(event: Event) => {
                  this.cooldownMinutes = Number((event.target as HTMLInputElement).value);
                }}
            /></label>
            <label
              >Watched check names, one per line<textarea
                rows="3"
                .value=${this.checks}
                placeholder="Empty watches all checks"
                @input=${(event: Event) => {
                  this.checks = (event.target as HTMLTextAreaElement).value;
                }}
              ></textarea>
            </label>
          </div>
        </details>
        ${this.error ? html`<p role="alert" class="error">${this.error}</p>` : nothing}
        <button data-testid="pr-monitor-save" class="primary" type="submit">
          ${this.disabled ? 'Saving…' : 'Save monitoring'}
        </button>
      </fieldset>
    </form>`;
  }
}
