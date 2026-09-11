import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { PRRulePredicate } from '@farmslot/protocol';
import {
  assertPRTeamConfig,
  type ConfigGitHubAccountsResult,
  type PRImportedProjectView,
  type ProjectConfig,
  type PRProjectCatalog,
  type PRProjectImportParams,
  type PRProjectImportResult,
  type PRRepositoryReviewPolicy,
  type PRRuleSource,
  type PRSourceAccount,
  type PRTeamConfig,
  type SlotStatus,
} from '@farmslot/protocol';

import '../shared/choice-picker.js';
import './pr-review-policy-editor.js';
import './pr-github-account-picker.js';
import './pr-repository-policies.js';
import './pr-project-filter-editor.js';

import type { ChoicePicker } from '../shared/choice-picker.js';

import type { PRFormDraft, PRTeamEditorDraft } from './pr-automation-draft-store.js';
import { prAutomationStyles } from './pr-automation-styles.js';
import { defaultPRPredicate } from './pr-predicate-editor.js';
import type { PRReviewPolicyChange } from './pr-review-policy-editor.js';

export interface PRProjectImportRequest extends PRProjectImportParams {
  catalogOnly?: boolean;
}

function newTeam(): PRTeamConfig {
  return {
    name: '',
    account: { host: 'github.com', login: '' },
    sources: [],
    predicate: defaultPRPredicate(),
    repositories: [],
    githubTeams: [],
    notificationPrincipalIds: [],
  };
}

@customElement('pr-team-form')
export class PRTeamForm extends LitElement {
  @property({ attribute: false }) initial?: PRTeamConfig;
  @property({ attribute: false }) projects: string[] = [];
  @property({ attribute: false }) farms: ProjectConfig[] = [];
  @property({ attribute: false }) accounts: ConfigGitHubAccountsResult['accounts'] = [];
  @property({ attribute: false }) restoredDraft?: PRTeamEditorDraft;
  @state() private openSections: string[] = [];
  @property() accountError = '';
  @state() private sourceMode: 'farm' | 'project' = 'farm';
  @state() private selectedFarm = '';
  @property({ attribute: false }) slots: SlotStatus[] = [];
  @property({ type: Boolean }) disabled = false;
  @state() private draft = newTeam();
  @state() private error = '';
  @state() private importURL = '';
  @state() private catalogs: PRProjectCatalog[] = [];
  static styles = prAutomationStyles;

  protected willUpdate(changes: PropertyValues<this>) {
    if (changes.has('initial')) {
      this.draft = this.initial ? structuredClone(this.initial) : newTeam();
      this.error = '';
      this.catalogs = [];
      this.importURL = '';
      this.selectedFarm = '';
      this.sourceMode = this.initial?.sources.some((source) => source.kind === 'github-project')
        ? 'project'
        : 'farm';
    }
    if (changes.has('restoredDraft') && this.restoredDraft) {
      const saved = structuredClone(this.restoredDraft);
      this.draft = saved.config;
      this.openSections = saved.sections;
      this.catalogs = saved.catalogs;
      this.importURL = saved.importURL;
      this.sourceMode = saved.sourceMode;
      this.selectedFarm = saved.selectedFarm;
    }
  }
  snapshotDraft(): PRFormDraft {
    return {
      kind: 'team',
      value: {
        config: structuredClone(this.draft),
        sections: [...this.openSections],
        catalogs: structuredClone(this.catalogs),
        importURL: this.importURL,
        sourceMode: this.sourceMode,
        selectedFarm: this.selectedFarm,
      },
    };
  }
  private draftChanged() {
    this.dispatchEvent(
      new CustomEvent<PRFormDraft>('pr-draft-change', {
        detail: this.snapshotDraft(),
        bubbles: true,
        composed: true,
      }),
    );
  }
  private sectionChanged(event: Event) {
    const element = event.currentTarget as HTMLDetailsElement;
    const id = element.dataset.testid!;
    const next = element.open
      ? [...new Set([...this.openSections, id])]
      : this.openSections.filter((key) => key !== id);
    if (JSON.stringify(next) === JSON.stringify(this.openSections)) return;
    this.openSections = next;
    this.draftChanged();
  }
  private edit(patch: Partial<PRTeamConfig>) {
    if (
      patch.account &&
      (patch.account.host !== this.draft.account.host ||
        patch.account.login !== this.draft.account.login)
    )
      this.catalogs = [];
    this.draft = { ...this.draft, ...patch };
    this.draftChanged();
  }
  applyProjectImport(result: PRProjectImportResult, catalogOnly = false) {
    this.catalogs = this.catalogs
      .filter((project) => project.id !== result.project.id)
      .concat(result.project);
    if (catalogOnly) {
      this.draftChanged();
      return;
    }
    const sources = this.draft.sources.filter(
      (source) => source.kind !== 'repository' || source.repo !== '',
    );
    const index = sources.findIndex(
      (source) =>
        source.kind === 'github-project' &&
        source.projectId === result.source.projectId &&
        source.importedView?.number === result.source.importedView?.number,
    );
    if (index < 0) sources.push(result.source);
    else sources[index] = result.source;
    this.edit({ sources });
    this.importURL = '';
    this.draftChanged();
  }
  private importProject(url: string, catalogOnly = false) {
    this.dispatchEvent(
      new CustomEvent<PRProjectImportRequest>('project-import', {
        detail: { account: { ...this.draft.account }, url, catalogOnly },
        bubbles: true,
        composed: true,
      }),
    );
  }
  private addFarm() {
    const farm = this.farms.find((item) => item.name === this.selectedFarm);
    const repo = farm?.ci.repo?.trim();
    if (!farm || !repo) return;
    const sources = this.draft.sources.filter(
      (source) => source.kind !== 'repository' || source.repo,
    );
    if (
      !sources.some(
        (source) =>
          source.kind === 'repository' && source.repo.toLowerCase() === repo.toLowerCase(),
      )
    )
      sources.push({ kind: 'repository', repo });
    const repositories = [...this.draft.repositories];
    if (!repositories.some((policy) => policy.repo.toLowerCase() === repo.toLowerCase()))
      repositories.push({
        repo,
        project: farm.name,
        reviewProfile: 'standard',
        excludedLabels: [],
      });
    this.edit({ name: this.draft.name || farm.name, sources, repositories });
    this.selectedFarm = '';
    this.draftChanged();
  }
  private renderSourcePicker() {
    return html`
      <div class="source-picker" role="group" aria-label="Choose PR source">
        <button
          type="button"
          data-testid="pr-source-mode-farm"
          aria-pressed=${String(this.sourceMode === 'farm')}
          @click=${() => {
            this.sourceMode = 'farm';
            this.draftChanged();
          }}
        >
          Existing farm
        </button>
        <button
          type="button"
          data-testid="pr-source-mode-project"
          aria-pressed=${String(this.sourceMode === 'project')}
          @click=${() => {
            this.sourceMode = 'project';
            this.draftChanged();
          }}
        >
          GitHub Project URL
        </button>
      </div>
      ${this.sourceMode === 'farm'
        ? html`
            <div class="row">
              <label class="farm-choice"
                >Farmslot project
                <choice-picker
                  data-testid="pr-team-farm"
                  .value=${this.selectedFarm}
                  @input=${(event: Event) => {
                    this.selectedFarm = (event.target as ChoicePicker).value;
                  }}
                >
                  <option value="">Choose an existing farm</option>
                  ${this.farms
                    .filter((farm) => farm.ci.repo)
                    .map(
                      (farm) =>
                        html`<option .value=${farm.name}>${farm.name} · ${farm.ci.repo}</option>`,
                    )}
                </choice-picker>
              </label>
              <button
                type="button"
                data-testid="pr-team-add-farm"
                ?disabled=${!this.farms.some(
                  (farm) => farm.name === this.selectedFarm && farm.ci.repo,
                )}
                @click=${this.addFarm}
              >
                Add farm
              </button>
            </div>
            <p class="muted">
              Uses the farm's configured repository and maps it for reviews. You can add more than
              one farm. No GitHub scan runs here.
            </p>
            ${!this.farms.some((farm) => farm.ci.repo)
              ? html`<p class="attention">
                  No configured farms are available. Use a GitHub Project URL or add a repository
                  under advanced source settings.
                </p>`
              : nothing}
          `
        : html`
            <div class="row">
              <label class="farm-choice"
                >Project or saved-view URL<input
                  data-testid="pr-project-import-url"
                  type="url"
                  .value=${this.importURL}
                  placeholder="https://github.com/orgs/owner/projects/1/views/1"
                  @input=${(event: Event) => {
                    this.importURL = (event.target as HTMLInputElement).value;
                  }}
              /></label>
              <button
                type="button"
                data-testid="pr-project-import"
                ?disabled=${!this.importURL || !this.draft.account.login}
                @click=${() => this.importProject(this.importURL)}
              >
                Import Project/view
              </button>
            </div>
            <p class="muted">
              Select a configured gateway account, then import. This reads the Project and its
              fields; PR discovery happens when you preview a rule.
            </p>
          `}
      ${this.draft.sources.map(
        (source, index) =>
          html`<div class="card source-summary">
            <div class="row">
              <span class="spacer"
                >${source.kind === 'repository' ? source.repo : source.label}
                ${source.kind === 'github-project' && source.importedView
                  ? ` · ${source.importedView.name}`
                  : ''}</span
              >
              <button
                type="button"
                aria-label=${`Remove ${source.kind === 'repository' ? source.repo : source.label}`}
                @click=${() =>
                  this.edit({ sources: this.draft.sources.filter((_, i) => i !== index) })}
              >
                Remove
              </button>
            </div>
            ${source.kind === 'repository'
              ? html`<small
                  >Review farm:
                  ${this.draft.repositories.find(
                    (policy) => policy.repo.toLowerCase() === source.repo.toLowerCase(),
                  )?.project ?? 'Not mapped yet'}</small
                >`
              : html`<small>Only PRs in this Project/view are included by this source.</small>`}
          </div>`,
      )}
    `;
  }
  private source(index: number, source: PRRuleSource) {
    this.edit({ sources: this.draft.sources.map((entry, i) => (i === index ? source : entry)) });
  }
  private save(event: SubmitEvent) {
    event.preventDefault();
    if (this.disabled) return;
    this.error = '';
    try {
      const unchangedAccount =
        this.initial?.account.host.toLowerCase() === this.draft.account.host.toLowerCase() &&
        this.initial?.account.login.toLowerCase() === this.draft.account.login.toLowerCase();
      if (
        !unchangedAccount &&
        !this.accounts.some(
          (account) =>
            account.host.toLowerCase() === this.draft.account.host.toLowerCase() &&
            account.login.toLowerCase() === this.draft.account.login.toLowerCase(),
        )
      )
        throw new Error('Choose an authenticated gateway account.');
      assertPRTeamConfig(this.draft);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return;
    }
    this.dispatchEvent(
      new CustomEvent('team-save', { detail: this.draft, bubbles: true, composed: true }),
    );
  }
  render() {
    const draft = this.draft;
    return html`<form class="setup-form" @submit=${this.save} @input=${this.draftChanged}>
      <p class="muted">
        A team groups PR sources and shared review settings. Start with a farm or a GitHub Project
        URL; review rules come after saving.
      </p>
      <fieldset ?disabled=${this.disabled}>
        <div class="grid">
          <label
            >Team name<input
              data-testid="pr-team-name"
              required
              .value=${draft.name}
              @input=${(event: Event) =>
                this.edit({ name: (event.target as HTMLInputElement).value.trim() })}
          /></label>
          <pr-github-account-picker
            .accounts=${this.accounts}
            .value=${draft.account}
            .disabled=${this.disabled}
            .error=${this.accountError}
            testId="pr-team-account"
            @account-change=${(event: CustomEvent<PRSourceAccount>) => {
              event.stopPropagation();
              this.edit({ account: event.detail });
            }}
          ></pr-github-account-picker>
        </div>
        <section>
          <h3>PR sources</h3>
          ${this.renderSourcePicker()}
          <details
            data-testid="pr-team-advanced-sources"
            .open=${this.openSections.includes('pr-team-advanced-sources')}
            @toggle=${this.sectionChanged}
          >
            <summary>Advanced source settings</summary>
            <p class="muted">GitHub host: ${draft.account.host}</p>
            ${draft.sources.map(
              (source, index) =>
                html`<div class="card" data-source-index=${index}>
                  <label
                    >Source type<choice-picker
                      .value=${source.kind}
                      @input=${(event: Event) =>
                        this.source(
                          index,
                          (event.target as ChoicePicker).value === 'repository'
                            ? { kind: 'repository', repo: '' }
                            : { kind: 'github-project', projectId: '', label: '' },
                        )}
                    >
                      <option value="repository" .selected=${source.kind === 'repository'}>
                        Repository
                      </option>
                      <option value="github-project" .selected=${source.kind === 'github-project'}>
                        GitHub Project
                      </option>
                    </choice-picker></label
                  >
                  ${source.kind === 'repository'
                    ? html`<label
                        >Repository<input
                          data-testid="pr-team-source-repository"
                          required
                          placeholder="owner/repo"
                          .value=${source.repo}
                          @input=${(event: Event) =>
                            this.source(index, {
                              ...source,
                              repo: (event.target as HTMLInputElement).value.trim(),
                            })}
                      /></label>`
                    : html`<div class="grid">
                        <label
                          >Project ID<input
                            ?disabled=${!!source.url}
                            required
                            placeholder="PVT_…"
                            .value=${source.projectId}
                            @input=${(event: Event) =>
                              this.source(index, {
                                ...source,
                                projectId: (event.target as HTMLInputElement).value.trim(),
                              })}
                        /></label>
                        <label
                          >Project display name<input
                            required
                            .value=${source.label}
                            @input=${(event: Event) =>
                              this.source(index, {
                                ...source,
                                label: (event.target as HTMLInputElement).value.trim(),
                              })}
                        /></label>
                      </div>`}
                  ${source.kind === 'github-project'
                    ? html`
                        ${source.url
                          ? html`<div class="row">
                              <a
                                href=${`${source.url.replace(/\/$/, '')}${source.importedView ? `/views/${source.importedView.number}` : ''}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                >Open Project/view</a
                              >
                              <button
                                type="button"
                                @click=${() => this.importProject(source.url!, true)}
                              >
                                Refresh field names
                              </button>
                            </div>`
                          : nothing}
                        <pr-project-filter-editor
                          .value=${source.importedView}
                          .catalogs=${this.catalogs}
                          .disabled=${this.disabled}
                          @view-filter-change=${(event: CustomEvent<PRImportedProjectView>) => {
                            event.stopPropagation();
                            this.source(index, { ...source, importedView: event.detail });
                          }}
                        ></pr-project-filter-editor>
                      `
                    : nothing}
                  <button
                    type="button"
                    ?disabled=${draft.sources.length === 1}
                    @click=${() =>
                      this.edit({ sources: draft.sources.filter((_, i) => i !== index) })}
                  >
                    Remove source
                  </button>
                </div>`,
            )}
            <button
              type="button"
              data-testid="pr-team-manual-source-add"
              @click=${() =>
                this.edit({ sources: [...draft.sources, { kind: 'repository', repo: '' }] })}
            >
              Add repository manually
            </button>
          </details>
        </section>
        <details
          data-testid="pr-team-filters"
          .open=${this.openSections.includes('pr-team-filters')}
          @toggle=${this.sectionChanged}
        >
          <summary>PR filters</summary>
          <p class="muted">
            Defaults to open PRs. Add labels, paths or Project fields to narrow the team.
          </p>
          <pr-predicate-editor
            .value=${draft.predicate}
            .catalogs=${this.catalogs}
            .disabled=${this.disabled}
            @predicate-change=${(event: CustomEvent<PRRulePredicate>) => {
              event.stopPropagation();
              this.edit({ predicate: event.detail });
            }}
          ></pr-predicate-editor>
          <label
            >GitHub teams to check, one org/team-slug per line<textarea
              rows="2"
              .value=${draft.githubTeams.join('\n')}
              @input=${(event: Event) =>
                this.edit({
                  githubTeams: (event.target as HTMLTextAreaElement).value
                    .split('\n')
                    .map((value) => value.trim())
                    .filter(Boolean),
                })}
            ></textarea>
          </label>
        </details>
        <details
          data-testid="pr-team-review-settings"
          .open=${this.openSections.includes('pr-team-review-settings')}
          @toggle=${this.sectionChanged}
        >
          <summary>Review settings</summary>
          <p class="muted">
            Choose slots and models before running reviews. These settings are optional for
            notification-only rules.
          </p>
          <pr-review-policy-editor
            .execution=${draft.execution}
            .review=${draft.review}
            .slots=${draft.repositories.some((policy) => policy.project)
              ? this.slots.filter((slot) =>
                  draft.repositories.some((policy) => policy.project === slot.project),
                )
              : this.slots}
            .allProjects=${true}
            .disabled=${this.disabled}
            @policy-change=${(event: CustomEvent<PRReviewPolicyChange>) => {
              event.stopPropagation();
              this.edit(event.detail);
            }}
          ></pr-review-policy-editor>
        </details>
        <details
          data-testid="pr-team-farm-mappings"
          .open=${this.openSections.includes('pr-team-farm-mappings')}
          @toggle=${this.sectionChanged}
        >
          <summary>Farm mappings and review overrides · ${draft.repositories.length}</summary>
          <pr-repository-policies
            .value=${draft.repositories}
            .projects=${this.projects}
            .slots=${this.slots}
            .execution=${draft.execution}
            .review=${draft.review}
            .disabled=${this.disabled}
            @repositories-change=${(event: CustomEvent<PRRepositoryReviewPolicy[]>) =>
              this.edit({ repositories: event.detail })}
          ></pr-repository-policies>
        </details>
        <details
          data-testid="pr-team-recipients"
          .open=${this.openSections.includes('pr-team-recipients')}
          @toggle=${this.sectionChanged}
        >
          <summary>Additional notification recipients</summary>
          <label
            >Notification recipients, one principal ID per line<textarea
              rows="2"
              .value=${draft.notificationPrincipalIds.join('\n')}
              @input=${(event: Event) =>
                this.edit({
                  notificationPrincipalIds: (event.target as HTMLTextAreaElement).value
                    .split('\n')
                    .map((value) => value.trim())
                    .filter(Boolean),
                })}
            ></textarea>
          </label>
        </details>
        <p class="muted">
          Recipients still need access. Saving a team does not enable a rule or publication
          monitoring.
        </p>
        ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
        <button type="submit" class="primary" data-testid="pr-team-save">Save team</button>
      </fieldset>
    </form>`;
  }
}
