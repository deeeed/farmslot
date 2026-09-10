import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { PRRulePredicate } from '@farmslot/protocol';
import {
  assertPRTeamConfig,
  type PRImportedProjectView,
  type PRProjectCatalog,
  type PRProjectImportParams,
  type PRProjectImportResult,
  type PRRepositoryReviewPolicy,
  type PRRuleSource,
  type PRTeamConfig,
  type SlotStatus,
} from '@farmslot/protocol';

import './pr-review-policy-editor.js';
import './pr-repository-policies.js';
import './pr-project-filter-editor.js';

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
    sources: [{ kind: 'repository', repo: '' }],
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
    }
  }
  private edit(patch: Partial<PRTeamConfig>) {
    if (
      patch.account &&
      (patch.account.host !== this.draft.account.host ||
        patch.account.login !== this.draft.account.login)
    )
      this.catalogs = [];
    this.draft = { ...this.draft, ...patch };
  }
  applyProjectImport(result: PRProjectImportResult, catalogOnly = false) {
    this.catalogs = this.catalogs
      .filter((project) => project.id !== result.project.id)
      .concat(result.project);
    if (catalogOnly) return;
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
  private source(index: number, source: PRRuleSource) {
    this.edit({ sources: this.draft.sources.map((entry, i) => (i === index ? source : entry)) });
  }
  private save(event: SubmitEvent) {
    event.preventDefault();
    if (this.disabled) return;
    this.error = '';
    try {
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
    return html`<form @submit=${this.save}>
      <fieldset ?disabled=${this.disabled}>
        <div class="grid">
          <label
            >Team name<input
              data-testid="pr-team-name"
              required
              .value=${draft.name}
              @change=${(event: Event) =>
                this.edit({ name: (event.target as HTMLInputElement).value.trim() })}
          /></label>
          <label
            >GitHub host<input
              required
              .value=${draft.account.host}
              @change=${(event: Event) =>
                this.edit({
                  account: {
                    ...draft.account,
                    host: (event.target as HTMLInputElement).value.trim(),
                  },
                })}
          /></label>
          <label
            >GitHub account login<input
              data-testid="pr-team-account"
              required
              .value=${draft.account.login}
              @change=${(event: Event) =>
                this.edit({
                  account: {
                    ...draft.account,
                    login: (event.target as HTMLInputElement).value.trim(),
                  },
                })}
          /></label>
        </div>
        <section>
          <h3>PR sources</h3>
          <div class="row">
            <label
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
              ?disabled=${!this.importURL || !draft.account.login}
              @click=${() => this.importProject(this.importURL)}
            >
              Import Project/view
            </button>
          </div>
          <p class="muted">
            Repository sources scan that repository. Project sources include only the Project's PR
            items.
          </p>
          ${draft.sources.map(
            (source, index) =>
              html`<div class="card" data-source-index=${index}>
                <label
                  >Source type<select
                    .value=${source.kind}
                    @change=${(event: Event) =>
                      this.source(
                        index,
                        (event.target as HTMLSelectElement).value === 'repository'
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
                  </select></label
                >
                ${source.kind === 'repository'
                  ? html`<label
                      >Repository<input
                        data-testid="pr-team-source-repository"
                        required
                        placeholder="owner/repo"
                        .value=${source.repo}
                        @change=${(event: Event) =>
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
                          @change=${(event: Event) =>
                            this.source(index, {
                              ...source,
                              projectId: (event.target as HTMLInputElement).value.trim(),
                            })}
                      /></label>
                      <label
                        >Project display name<input
                          required
                          .value=${source.label}
                          @change=${(event: Event) =>
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
            @click=${() =>
              this.edit({ sources: [...draft.sources, { kind: 'repository', repo: '' }] })}
          >
            Add source
          </button>
        </section>
        <section>
          <h3>Team eligibility</h3>
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
              @change=${(event: Event) =>
                this.edit({
                  githubTeams: (event.target as HTMLTextAreaElement).value
                    .split('\n')
                    .map((value) => value.trim())
                    .filter(Boolean),
                })}
            ></textarea>
          </label>
        </section>
        <section>
          <h3>Team review defaults</h3>
          <pr-review-policy-editor
            .execution=${draft.execution}
            .review=${draft.review}
            .slots=${this.slots}
            .allProjects=${true}
            .disabled=${this.disabled}
            @policy-change=${(event: CustomEvent<PRReviewPolicyChange>) => {
              event.stopPropagation();
              this.edit(event.detail);
            }}
          ></pr-review-policy-editor>
        </section>
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
        <label
          >Notification recipients, one principal ID per line<textarea
            rows="2"
            .value=${draft.notificationPrincipalIds.join('\n')}
            @change=${(event: Event) =>
              this.edit({
                notificationPrincipalIds: (event.target as HTMLTextAreaElement).value
                  .split('\n')
                  .map((value) => value.trim())
                  .filter(Boolean),
              })}
          ></textarea>
        </label>
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
