import { html, nothing } from 'lit';

import type { EvalTaskProfile } from '@farmslot/protocol';

import {
  type EvalCaseCatalogItem,
  type EvalCaseFilterKind,
  type EvalCaseFilterTaskProfile,
  type EvalCaseSortDirection,
  type EvalCaseSortKey,
  type EvalSelectedCase,
  formatCaseDate,
} from './eval-suite-helpers.js';

export interface EvalCockpitCaseBrowserRenderOptions {
  items: readonly EvalCaseCatalogItem[];
  preview: EvalCaseCatalogItem | null;
  projects: readonly string[];
  statuses: readonly string[];
  selectedCases: readonly EvalSelectedCase[];
  enabledCandidateCount: number;
  referencePickerOpen: boolean;
  caseQuery: string;
  caseProjectFilter: string;
  caseTaskProfileFilter: EvalCaseFilterTaskProfile;
  caseStatusFilter: string;
  caseKindFilter: EvalCaseFilterKind;
  caseSortKey: EvalCaseSortKey;
  caseSortDirection: EvalCaseSortDirection;
  previewCaseId: string;
  manualEntryOpen: boolean;
  openReferencePicker: () => void;
  closeReferencePicker: () => void;
  catalogItemForSelectedCase: (selected: EvalSelectedCase) => EvalCaseCatalogItem | null;
  renderPreviewLinks: (preview: EvalCaseCatalogItem) => unknown;
  renderPreviewStats: (preview: EvalCaseCatalogItem) => unknown;
  updateBasketCase: (
    selectionId: string,
    patch: Partial<Pick<EvalSelectedCase, 'label' | 'objective' | 'taskProfile'>>,
  ) => void;
  removeBasketCase: (selectionId: string) => void;
  setCaseQuery: (value: string) => void;
  setCaseProjectFilter: (value: string) => void;
  setCaseTaskProfileFilter: (value: EvalCaseFilterTaskProfile) => void;
  setCaseStatusFilter: (value: string) => void;
  setCaseKindFilter: (value: EvalCaseFilterKind) => void;
  setCaseSort: (sortKey: EvalCaseSortKey) => void;
  setPreviewCaseId: (id: string) => void;
  addCaseToBasket: (item: EvalCaseCatalogItem) => void;
  setManualEntryOpen: (open: boolean) => void;
  renderManualEntry: () => unknown;
}

export function renderEvalCockpitCaseBrowser(options: EvalCockpitCaseBrowserRenderOptions) {
  const trialCount = options.selectedCases.length * options.enabledCandidateCount;
  const preview = options.preview;
  return html`
    <section class="eval-panel reference-replay-panel">
      <div class="eval-panel-head">
        <div>
          <div class="eval-panel-title">Reference to replay</div>
          <div class="eval-muted">
            ${options.selectedCases.length
              ? `${options.selectedCases.length} Reference${options.selectedCases.length === 1 ? '' : 's'} × ${options.enabledCandidateCount} enabled Candidate${options.enabledCandidateCount === 1 ? '' : 's'} = ${trialCount} artifact-only replay trial${trialCount === 1 ? '' : 's'}.`
              : 'Choose an old merged PR or completed BUG/DEV run. Farmslot prefers matching run evidence before falling back to GitHub PR diff.'}
          </div>
        </div>
        <button
          class="eval-button primary choose-references"
          @click=${() => {
            options.openReferencePicker();
          }}
        >
          ${options.selectedCases.length ? 'Change / add Reference' : 'Choose Reference'}
        </button>
      </div>
      ${options.selectedCases.length
        ? html`
            <div class="reference-summary-list">
              ${options.selectedCases.map((item) => {
                const source = options.catalogItemForSelectedCase(item);
                return html`
                  <div class="reference-summary-card selected-reference-card">
                    <div class="selected-reference-main">
                      <div><strong>${item.label}</strong></div>
                      <small
                        >${item.project} · ${item.taskProfile} ·
                        ${item.kind}${item.runId ? ` · run ${item.runId.slice(0, 8)}` : ''}</small
                      >
                      <div class="selected-reference-meta">
                        <span class=${`run-type-chip ${item.taskProfile}`}
                          >${item.taskProfile === 'fix-bug' ? 'BUG' : 'DEV'}</span
                        >
                        <span class="status-pill">${item.suitabilityLabel}</span>
                        ${item.runStatusLabel
                          ? html`<span class="status-pill">${item.runStatusLabel}</span>`
                          : nothing}
                      </div>
                      ${source
                        ? html`${options.renderPreviewLinks(source)}${options.renderPreviewStats(
                            source,
                          )}`
                        : nothing}
                      <details class="reference-options">
                        <summary>Reference options</summary>
                        <div class="reference-options-grid">
                          <label
                            >Display label
                            <input
                              .value=${item.label}
                              @input=${(e: InputEvent) =>
                                options.updateBasketCase(item.selectionId, {
                                  label: (e.target as HTMLInputElement).value,
                                })}
                          /></label>
                          <label
                            >Task profile
                            <select
                              .value=${item.taskProfile}
                              @change=${(e: Event) =>
                                options.updateBasketCase(item.selectionId, {
                                  taskProfile: (e.target as HTMLSelectElement)
                                    .value as EvalTaskProfile,
                                })}
                            >
                              <option value="fix-bug">fix-bug</option>
                              <option value="dev">dev</option>
                            </select>
                          </label>
                          <label
                            >Objective
                            <input
                              .value=${item.objective}
                              placeholder="optional objective"
                              @input=${(e: InputEvent) =>
                                options.updateBasketCase(item.selectionId, {
                                  objective: (e.target as HTMLInputElement).value,
                                })}
                          /></label>
                        </div>
                      </details>
                    </div>
                    <div class="selected-reference-actions">
                      <button
                        class="eval-button"
                        @click=${() => {
                          options.openReferencePicker();
                        }}
                      >
                        Change
                      </button>
                      <button
                        class="link-button"
                        @click=${() => options.removeBasketCase(item.selectionId)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                `;
              })}
            </div>
          `
        : html`<div class="empty-state">
            No Reference selected yet. Click Choose Reference, or paste an exact PR URL in the
            picker if it is not listed.
          </div>`}
    </section>
    ${options.referencePickerOpen
      ? html`
          <div
            class="modal-backdrop"
            @click=${() => {
              options.closeReferencePicker();
            }}
          >
            <section
              class="reference-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Choose eval References"
              @click=${(e: Event) => e.stopPropagation()}
            >
              <div class="modal-head">
                <div>
                  <div class="eval-panel-title">Choose References</div>
                  <div class="eval-muted">
                    Search selectable References. Sort by date to find recent merged PRs/runs;
                    review and PR-complete follow-ups are hidden.
                  </div>
                </div>
                <button
                  class="eval-button"
                  @click=${() => {
                    options.closeReferencePicker();
                  }}
                >
                  Close
                </button>
              </div>
              <div class="filter-grid">
                <label class="wide"
                  >Search
                  <input
                    placeholder="PR, title, run, package, git ref…"
                    .value=${options.caseQuery}
                    @input=${(e: InputEvent) => {
                      options.setCaseQuery((e.target as HTMLInputElement).value);
                    }}
                /></label>
                <label
                  >Project
                  <select
                    .value=${options.caseProjectFilter}
                    @change=${(e: Event) => {
                      options.setCaseProjectFilter((e.target as HTMLSelectElement).value);
                    }}
                  >
                    <option value="all">all projects</option>
                    ${options.projects.map(
                      (project) => html`<option value=${project}>${project}</option>`,
                    )}
                  </select>
                </label>
                <label
                  >Task profile
                  <select
                    .value=${options.caseTaskProfileFilter}
                    @change=${(e: Event) => {
                      options.setCaseTaskProfileFilter(
                        (e.target as HTMLSelectElement).value as EvalCaseFilterTaskProfile,
                      );
                    }}
                  >
                    <option value="all">all profiles</option>
                    <option value="fix-bug">fix-bug</option>
                    <option value="dev">dev</option>
                  </select>
                </label>
                <label
                  >Status
                  <select
                    .value=${options.caseStatusFilter}
                    @change=${(e: Event) => {
                      options.setCaseStatusFilter((e.target as HTMLSelectElement).value);
                    }}
                  >
                    <option value="all">all statuses</option>
                    ${options.statuses.map(
                      (status) => html`<option value=${status}>${status}</option>`,
                    )}
                  </select>
                </label>
              </div>
              <div class="chip-row" aria-label="Case source filters">
                ${(
                  ['all', 'merged-pr', 'prior-run', 'package', 'git-ref'] as EvalCaseFilterKind[]
                ).map(
                  (kind) => html`
                    <button
                      class=${`chip ${options.caseKindFilter === kind ? 'active' : ''}`}
                      @click=${() => {
                        options.setCaseKindFilter(kind);
                      }}
                    >
                      ${kind === 'all' ? 'all sources' : kind}
                    </button>
                  `,
                )}
              </div>
              <div class="reference-picker-layout">
                <div class="reference-table-wrap">
                  <div class="reference-table reference-head">
                    ${[
                      ['title', 'Title'],
                      ['kind', 'Kind'],
                      ['profile', 'Profile'],
                      ['project', 'Project'],
                      ['status', 'Status'],
                      ['date', 'Date'],
                    ].map(
                      ([key, label]) => html`
                        <button
                          class="sort-head"
                          @click=${() => options.setCaseSort(key as EvalCaseSortKey)}
                        >
                          ${label}${options.caseSortKey === key
                            ? ` ${options.caseSortDirection === 'asc' ? '↑' : '↓'}`
                            : ''}
                        </button>
                      `,
                    )}
                    <span>Action</span>
                  </div>
                  <div class="reference-table-body">
                    ${options.items.length
                      ? options.items.map(
                          (item) => html`
                            <div
                              class=${`reference-table case-row ${options.previewCaseId === item.id ? 'previewing' : ''}`}
                              @click=${() => {
                                options.setPreviewCaseId(item.id);
                              }}
                            >
                              <div>
                                <div><strong>${item.primary}</strong></div>
                                <small>${item.secondary}</small>
                              </div>
                              <span class="badge muted-badge"
                                >${item.kind === 'merged-pr' ? 'merged PR' : item.kind}</span
                              >
                              <span class=${`run-type-chip ${item.carrierType ?? item.taskProfile}`}
                                >${item.carrierLabel ??
                                (item.taskProfile === 'fix-bug' ? 'BUG' : 'DEV')}</span
                              >
                              <span><small>${item.project}</small></span>
                              <span class="status-stack">
                                <small>${item.sourceStatusLabel}</small>
                                ${item.runStatusLabel
                                  ? html`<small>${item.runStatusLabel}</small>`
                                  : nothing}
                              </span>
                              <span><small>${formatCaseDate(item)}</small></span>
                              <button
                                class="eval-button primary add-reference"
                                ?disabled=${!item.selectable}
                                @click=${(e: Event) => {
                                  e.stopPropagation();
                                  options.addCaseToBasket(item);
                                }}
                              >
                                Add Reference
                              </button>
                            </div>
                          `,
                        )
                      : html`<div class="empty-state">No cases match the current filters.</div>`}
                  </div>
                </div>
                <div class="case-preview">
                  ${preview
                    ? html`
                        <div class="eval-panel-title">Preview</div>
                        <div class="preview-title">${preview.primary}</div>
                        <div class="eval-muted">${preview.secondary}</div>
                        ${options.renderPreviewLinks(preview)}
                        ${options.renderPreviewStats(preview)}
                        <dl>
                          <dt>Source</dt>
                          <dd>${preview.kind}</dd>
                          <dt>Project</dt>
                          <dd>${preview.project}</dd>
                          <dt>Run type</dt>
                          <dd>${preview.carrierLabel ?? preview.taskProfile}</dd>
                          <dt>Source status</dt>
                          <dd>${preview.sourceStatusLabel}</dd>
                          ${preview.runStatusLabel
                            ? html`<dt>Run status</dt>
                                <dd>${preview.runStatusLabel}</dd>`
                            : nothing}
                          <dt>Selectable</dt>
                          <dd>${preview.suitabilityLabel}</dd>
                          <dt>Date</dt>
                          <dd>${formatCaseDate(preview)}</dd>
                          <dt>Task profile</dt>
                          <dd>${preview.taskProfile}</dd>
                          ${preview.runId
                            ? html`<dt>Run</dt>
                                <dd>${preview.runId}</dd>`
                            : nothing}
                          ${preview.familyId
                            ? html`<dt>Family</dt>
                                <dd>${preview.familyId}</dd>`
                            : nothing}
                          <dt>Source key</dt>
                          <dd>${preview.sourceKey}</dd>
                        </dl>
                        ${preview.warnings.length
                          ? html`<div class="eval-error slim">${preview.warnings.join(' ')}</div>`
                          : nothing}
                        <button
                          class="eval-button primary"
                          ?disabled=${!preview.selectable}
                          @click=${() => options.addCaseToBasket(preview)}
                        >
                          Add Reference
                        </button>
                      `
                    : html`<div class="empty-state">
                        Select a case to preview source metadata.
                      </div>`}
                </div>
              </div>
              <div class="manual-toggle-row">
                <button
                  class="link-button"
                  @click=${() => {
                    options.setManualEntryOpen(!options.manualEntryOpen);
                  }}
                >
                  ${options.manualEntryOpen
                    ? 'Hide exact reference entry'
                    : 'Exact reference not listed'}
                </button>
                <span
                  >Manual entry is for exact PR/package/git refs when no matching Farmslot
                  run/package is listed.</span
                >
              </div>
              ${options.manualEntryOpen ? options.renderManualEntry() : nothing}
            </section>
          </div>
        `
      : nothing}
  `;
}
