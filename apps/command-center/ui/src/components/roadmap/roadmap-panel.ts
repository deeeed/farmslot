import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type {
  RoadmapItem,
  RoadmapItemStage,
  RoadmapListResult,
  RoadmapPromoteResult,
  RoadmapRefineResult,
  RoadmapSaveResult,
  SlotStatus,
} from '@farmslot/protocol';
import { Methods, ROADMAP_ITEM_STAGES } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, type GlobalFilters, subscribe } from '../../state.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import {
  planningBadgeStyles,
  renderPlanningBadge,
  renderTagChips,
  tagsFromInput,
  tagsToInput,
} from '../shared/planning-badges.js';

const STAGES: Array<RoadmapItemStage | 'all'> = ['all', ...ROADMAP_ITEM_STAGES];
const CUSTOM_PROJECT = '__custom__';
const DEFAULT_REFINED_BODY = [
  '## Problem',
  '',
  '',
  '## Proposed Solution',
  '',
  '',
  '## Non-goals',
  '',
  '',
  '## Risks',
  '',
  '',
  '## Dispatch Notes',
  '',
  '',
  '## Acceptance Criteria',
  '',
  '- ',
].join('\n');

interface PromotionDraft {
  title: string;
  body: string;
}

function defaultSpecBody(item: RoadmapItem | null): string {
  return [
    '## Context',
    '',
    item?.body?.trim() || 'Promoted from roadmap item.',
    '',
    '## Acceptance Criteria',
    '',
    '- ',
    '',
    '## Dispatch Notes',
    '',
    'Dispatch through the existing backlog queue.',
  ].join('\n');
}

@customElement('roadmap-panel')
export class RoadmapPanel extends LitElement {
  @state() private _allItems: RoadmapItem[] = [];
  @state() private _slots: SlotStatus[] = [];
  @state() private _globalFilters: GlobalFilters = { projects: [], machines: [] };
  @state() private _selectedId = '';
  @state() private _filterProject = 'all';
  @state() private _filterStage: RoadmapItemStage | 'all' = 'all';
  @state() private _filterTags = '';
  @state() private _filterSearch = '';
  @state() private _includeArchived = false;
  @state() private _busy = '';
  @state() private _error = '';
  @state() private _message = '';

  @state() private _newTitle = '';
  @state() private _newProject = 'unassigned';
  @state() private _newTags = '';
  @state() private _newBody = '';

  @state() private _editTitle = '';
  @state() private _editProject = '';
  @state() private _editStage: RoadmapItemStage = 'rough';
  @state() private _editTags = '';
  @state() private _editBody = '';
  @state() private _editHash = '';
  @state() private _refineRunner = '';
  @state() private _refineModel = '';
  @state() private _refineCommand = '';

  @state() private _promotionDrafts: PromotionDraft[] = [];
  private _unsubscribeConnection?: () => void;
  private _unsubscribeState?: () => void;

  static styles = [
    planningBadgeStyles,
    css`
      :host {
        display: block;
        color: ${unsafeCSS(colors.textPrimary)};
        font-family: ${unsafeCSS(fonts.mono)};
        padding: ${unsafeCSS(spacing.lg)};
      }
      .shell {
        display: grid;
        gap: ${unsafeCSS(spacing.md)};
      }
      .header,
      .card,
      .filters,
      form,
      .editor {
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.md)};
        background: ${unsafeCSS(colors.bgCard)};
        padding: ${unsafeCSS(spacing.md)};
      }
      .header,
      .row-head,
      .editor-head {
        display: flex;
        justify-content: space-between;
        gap: ${unsafeCSS(spacing.sm)};
        align-items: flex-start;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(280px, 0.8fr) minmax(420px, 1.2fr);
        gap: ${unsafeCSS(spacing.md)};
        align-items: start;
      }
      @media (max-width: 1050px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }
      h1,
      h2,
      h3,
      p {
        margin: 0;
      }
      h1 {
        font-size: ${unsafeCSS(fonts.sizeLg)};
      }
      h2,
      h3 {
        font-size: ${unsafeCSS(fonts.sizeMd)};
        margin-bottom: ${unsafeCSS(spacing.sm)};
      }
      .muted,
      label,
      .meta {
        color: ${unsafeCSS(colors.textMuted)};
        font-size: ${unsafeCSS(fonts.sizeXs)};
      }
      .filters,
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: ${unsafeCSS(spacing.sm)};
        align-items: end;
      }
      .project-picker {
        display: grid;
        grid-template-columns: minmax(150px, 0.8fr) minmax(160px, 1fr);
        gap: 6px;
      }
      label {
        display: grid;
        gap: 4px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      input,
      select,
      textarea {
        border: 1px solid ${unsafeCSS(colors.textMuted)}33;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.bgSurface)};
        color: ${unsafeCSS(colors.textPrimary)};
        font: inherit;
        padding: 8px;
      }
      textarea {
        min-height: 120px;
        resize: vertical;
        line-height: 1.35;
      }
      textarea.body {
        min-height: 360px;
      }
      button {
        border: 1px solid ${unsafeCSS(colors.accent)}66;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.accent)}22;
        color: ${unsafeCSS(colors.textPrimary)};
        font: inherit;
        padding: 8px 10px;
        cursor: pointer;
      }
      button.secondary {
        border-color: ${unsafeCSS(colors.textMuted)}33;
        background: ${unsafeCSS(colors.bgSurface)};
      }
      button.danger {
        border-color: ${unsafeCSS(colors.statusFail)}66;
        background: ${unsafeCSS(colors.statusFail)}22;
      }
      button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .rows {
        display: grid;
        gap: ${unsafeCSS(spacing.sm)};
      }
      .row {
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.md)};
        background: ${unsafeCSS(colors.bgSurface)};
        padding: ${unsafeCSS(spacing.md)};
        display: grid;
        gap: ${unsafeCSS(spacing.sm)};
        cursor: pointer;
      }
      .row.selected {
        border-color: ${unsafeCSS(colors.accent)}99;
      }
      .title {
        font-weight: 700;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .message {
        color: ${unsafeCSS(colors.statusOk)};
      }
      .error {
        color: ${unsafeCSS(colors.statusFail)};
      }
      .empty {
        color: ${unsafeCSS(colors.textMuted)};
        padding: ${unsafeCSS(spacing.md)};
      }
      .promotion-spec {
        display: grid;
        gap: ${unsafeCSS(spacing.sm)};
        border-top: 1px solid ${unsafeCSS(colors.textMuted)}22;
        padding-top: ${unsafeCSS(spacing.sm)};
        margin-top: ${unsafeCSS(spacing.sm)};
      }
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    this._syncState(getState());
    this._unsubscribeState = subscribe((s) => this._syncState(s));
    this._unsubscribeConnection = gateway.onConnectionChange((state) => {
      if (state === 'connected') void this._refresh();
    });
    if (gateway.connectionState === 'connected') void this._refresh();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribeConnection?.();
    this._unsubscribeState?.();
    this._unsubscribeConnection = undefined;
    this._unsubscribeState = undefined;
  }

  private _syncState(state: AppState) {
    const previousProjects = this._globalFilters.projects.join('\0');
    this._slots = state.fleet?.slots ?? [];
    this._globalFilters = state.globalFilters;
    if (previousProjects !== this._globalFilters.projects.join('\0')) {
      const visibleItems = this._items;
      if (!visibleItems.some((item) => item.id === this._selectedId)) {
        this._syncEditor(visibleItems[0] ?? null);
      }
    }
  }

  private get _projects(): string[] {
    return [
      ...new Set([
        'unassigned',
        'global',
        ...this._slots.map((slot) => slot.project).filter(Boolean),
        ...this._allItems.map((item) => item.project).filter(Boolean),
      ]),
    ].sort();
  }

  private _renderProjectPicker(
    label: string,
    testId: string,
    value: string,
    onChange: (project: string) => void,
  ) {
    const selectValue = this._projects.includes(value) ? value : CUSTOM_PROJECT;
    return html`<label>
      ${label}
      <div class="project-picker">
        <select
          data-testid=${`${testId}-select`}
          .value=${selectValue}
          @change=${(e: Event) => {
            const next = (e.target as HTMLSelectElement).value;
            onChange(next === CUSTOM_PROJECT ? '' : next);
          }}
        >
          ${this._projects.map((project) => html`<option value=${project}>${project}</option>`)}
          <option value=${CUSTOM_PROJECT}>Custom project…</option>
        </select>
        ${selectValue === CUSTOM_PROJECT
          ? html`<input
              data-testid=${testId}
              placeholder="custom project name"
              .value=${value}
              @input=${(e: Event) => onChange((e.target as HTMLInputElement).value)}
            />`
          : nothing}
      </div>
    </label>`;
  }

  private get _items(): RoadmapItem[] {
    const globalProjects = new Set(this._globalFilters.projects);
    if (this._filterProject === 'all' && globalProjects.size > 0) {
      return this._allItems.filter((item) => globalProjects.has(item.project));
    }
    return this._allItems;
  }

  private get _selected(): RoadmapItem | null {
    return this._items.find((item) => item.id === this._selectedId) ?? this._items[0] ?? null;
  }

  private get _runnerOptions(): string[] {
    return [
      ...new Set(
        this._slots
          .map((slot) => slot.runner)
          .filter((runner): runner is string => Boolean(runner)),
      ),
    ].sort();
  }

  private get _modelOptions(): string[] {
    return [
      ...new Set(
        this._slots.map((slot) => slot.model).filter((model): model is string => Boolean(model)),
      ),
    ].sort();
  }

  private _syncEditor(item: RoadmapItem | null) {
    if (!item) {
      this._selectedId = '';
      this._editTitle = '';
      this._editProject = '';
      this._editStage = 'rough';
      this._editTags = '';
      this._editBody = '';
      this._editHash = '';
      this._refineRunner = '';
      this._refineModel = '';
      this._refineCommand = '';
      this._promotionDrafts = [];
      return;
    }
    this._selectedId = item.id;
    this._editTitle = item.title;
    this._editProject = item.project;
    this._editStage = item.stage;
    this._editTags = tagsToInput(item.tags);
    this._editBody = item.body;
    this._editHash = item.fileHash;
    this._refineRunner = '';
    this._refineModel = '';
    this._refineCommand = '';
    this._promotionDrafts = [
      {
        title: item.title,
        body: defaultSpecBody(item),
      },
    ];
  }

  private async _refresh(selectId = this._selectedId) {
    this._busy = 'refresh';
    this._error = '';
    try {
      const result = await gateway.request<RoadmapListResult>(Methods.ROADMAP_LIST, {
        ...(this._filterProject !== 'all' ? { project: this._filterProject } : {}),
        ...(this._filterStage !== 'all' ? { stage: this._filterStage } : {}),
        ...(this._filterTags.trim() ? { tags: tagsFromInput(this._filterTags) } : {}),
        ...(this._filterSearch.trim() ? { search: this._filterSearch.trim() } : {}),
        includeArchived: this._includeArchived,
      });
      this._allItems = result.items;
      const visibleItems = this._items;
      const selected = visibleItems.find((item) => item.id === selectId) ?? visibleItems[0] ?? null;
      this._syncEditor(selected);
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._busy = '';
    }
  }

  private async _create(event: Event) {
    event.preventDefault();
    this._busy = 'create';
    this._error = '';
    this._message = '';
    try {
      const result = await gateway.request<RoadmapSaveResult>(Methods.ROADMAP_SAVE, {
        item: {
          project: this._newProject || 'unassigned',
          title: this._newTitle,
          stage: 'rough',
          tags: tagsFromInput(this._newTags),
          source: { kind: 'manual' },
          body: this._newBody || 'Raw idea.\n',
        },
      });
      this._newTitle = '';
      this._newBody = '';
      this._newTags = '';
      this._message = 'Roadmap item captured';
      await this._refresh(result.item.id);
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._busy = '';
    }
  }

  private async _saveSelected() {
    if (!this._selected) return;
    this._busy = 'save';
    this._error = '';
    this._message = '';
    try {
      const result = await gateway.request<RoadmapSaveResult>(Methods.ROADMAP_SAVE, {
        expectedHash: this._editHash,
        item: {
          id: this._selected.id,
          project: this._editProject,
          title: this._editTitle,
          stage: this._editStage,
          tags: tagsFromInput(this._editTags),
          source: this._selected.source,
          body: this._editBody,
          promotion: this._selected.promotion,
        },
      });
      this._message = 'Roadmap item saved';
      await this._refresh(result.item.id);
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._busy = '';
    }
  }

  private async _refineSelected(launch: boolean) {
    if (!this._selected) return;
    this._busy = launch ? 'refine-launch' : 'refine';
    this._error = '';
    this._message = '';
    try {
      const result = await gateway.request<RoadmapRefineResult>(Methods.ROADMAP_REFINE, {
        itemId: this._selected.id,
        expectedHash: this._editHash,
        launch,
        ...(this._refineRunner.trim() ? { runner: this._refineRunner.trim() } : {}),
        ...(this._refineModel.trim() ? { model: this._refineModel.trim() } : {}),
        ...(this._refineCommand.trim() ? { runnerCommand: this._refineCommand.trim() } : {}),
      });
      const selectedRunner = [result.runner, result.model].filter(Boolean).join(' ');
      const runnerSuffix = selectedRunner ? ` (${selectedRunner})` : '';
      this._message = launch
        ? `Refinement terminal ${result.launched ? 'launched' : 'attached'}${runnerSuffix}: ${result.attachCommand}`
        : `Refinement prompt ready${runnerSuffix}: ${result.promptPath}`;
      await this._refresh(result.item.id);
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._busy = '';
    }
  }

  private async _setSelectedStage(stage: RoadmapItemStage) {
    if (!this._selected) return;
    this._editStage = stage;
    await this._saveSelected();
  }

  private async _deleteSelected() {
    if (!this._selected) return;
    const ok = window.confirm(
      `Delete roadmap item "${this._selected.title}"? This removes its markdown file.`,
    );
    if (!ok) return;
    this._busy = 'delete';
    this._error = '';
    this._message = '';
    try {
      await gateway.request(Methods.ROADMAP_DELETE, {
        itemId: this._selected.id,
        expectedHash: this._editHash,
      });
      this._message = 'Roadmap item deleted';
      await this._refresh('');
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._busy = '';
    }
  }

  private _addPromotionSpec() {
    this._promotionDrafts = [
      ...this._promotionDrafts,
      { title: this._selected?.title ?? '', body: defaultSpecBody(this._selected) },
    ];
  }

  private _updatePromotionSpec(index: number, patch: Partial<PromotionDraft>) {
    this._promotionDrafts = this._promotionDrafts.map((spec, i) =>
      i === index ? { ...spec, ...patch } : spec,
    );
  }

  private _removePromotionSpec(index: number) {
    this._promotionDrafts = this._promotionDrafts.filter((_, i) => i !== index);
  }

  private async _promoteSelected() {
    if (!this._selected) return;
    this._busy = 'promote';
    this._error = '';
    this._message = '';
    try {
      const result = await gateway.request<RoadmapPromoteResult>(Methods.ROADMAP_PROMOTE, {
        itemId: this._selected.id,
        expectedHash: this._editHash,
        specs: this._promotionDrafts.map((spec) => ({
          title: spec.title,
          body: spec.body,
          tags: tagsFromInput(this._editTags),
        })),
      });
      this._message = `Promoted ${result.backlogItems.length} backlog spec${result.backlogItems.length === 1 ? '' : 's'}`;
      await this._refresh(result.roadmapItem.id);
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._busy = '';
    }
  }

  private _selectItem(item: RoadmapItem) {
    this._syncEditor(item);
  }

  private _renderCreateForm() {
    return html`<form @submit=${this._create}>
      <h2>Capture raw idea</h2>
      <div class="grid">
        <label
          >Title
          <input
            data-testid="roadmap-new-title"
            required
            .value=${this._newTitle}
            @input=${(e: Event) => (this._newTitle = (e.target as HTMLInputElement).value)}
          />
        </label>
        ${this._renderProjectPicker(
          'Project',
          'roadmap-new-project',
          this._newProject,
          (project) => {
            this._newProject = project;
          },
        )}
        <label
          >Tags
          <input
            data-testid="roadmap-new-tags"
            placeholder="roadmap, command-center"
            .value=${this._newTags}
            @input=${(e: Event) => (this._newTags = (e.target as HTMLInputElement).value)}
          />
        </label>
      </div>
      <label style="margin-top: 10px;"
        >Raw idea markdown
        <textarea
          data-testid="roadmap-new-body"
          .value=${this._newBody}
          placeholder="Paste the raw idea here."
          @input=${(e: Event) => (this._newBody = (e.target as HTMLTextAreaElement).value)}
        ></textarea>
      </label>
      <div class="actions" style="margin-top: 10px;">
        <button data-testid="roadmap-create" ?disabled=${this._busy === 'create'}>
          Save rough roadmap item
        </button>
        <button
          class="secondary"
          type="button"
          @click=${() => {
            this._newBody = DEFAULT_REFINED_BODY;
          }}
        >
          Use refined template
        </button>
      </div>
    </form>`;
  }

  private _renderFilters() {
    return html`<div class="filters">
      <label
        >Project
        <select
          data-testid="roadmap-filter-project"
          .value=${this._filterProject}
          @change=${(e: Event) => {
            this._filterProject = (e.target as HTMLSelectElement).value;
            void this._refresh();
          }}
        >
          <option value="all">All projects</option>
          ${this._projects.map((project) => html`<option value=${project}>${project}</option>`)}
        </select>
      </label>
      <label
        >Stage
        <select
          data-testid="roadmap-filter-stage"
          .value=${this._filterStage}
          @change=${(e: Event) => {
            this._filterStage = (e.target as HTMLSelectElement).value as RoadmapItemStage | 'all';
            void this._refresh();
          }}
        >
          ${STAGES.map((stage) => html`<option value=${stage}>${stage}</option>`)}
        </select>
      </label>
      <label
        >Tags
        <input
          data-testid="roadmap-filter-tags"
          placeholder="comma-separated"
          .value=${this._filterTags}
          @change=${(e: Event) => {
            this._filterTags = (e.target as HTMLInputElement).value;
            void this._refresh();
          }}
        />
      </label>
      <label
        >Search
        <input
          data-testid="roadmap-filter-search"
          .value=${this._filterSearch}
          @change=${(e: Event) => {
            this._filterSearch = (e.target as HTMLInputElement).value;
            void this._refresh();
          }}
        />
      </label>
      <label>
        Archived
        <input
          data-testid="roadmap-filter-archived"
          type="checkbox"
          .checked=${this._includeArchived}
          @change=${(e: Event) => {
            this._includeArchived = (e.target as HTMLInputElement).checked;
            void this._refresh();
          }}
        />
      </label>
      <button class="secondary" @click=${() => this._refresh()}>Refresh</button>
    </div>`;
  }

  private _renderRow(item: RoadmapItem) {
    return html`<div
      class="row ${this._selectedId === item.id ? 'selected' : ''}"
      @click=${() => this._selectItem(item)}
    >
      <div class="row-head">
        <div>
          <div class="title">${item.title}</div>
          <div class="meta">${item.project} · ${item.filePath}</div>
        </div>
        ${renderPlanningBadge(
          item.stage,
          item.stage === 'refined' || item.stage === 'promoted' ? 'positive' : 'default',
        )}
      </div>
      <div class="badges">
        ${renderTagChips(item.tags)}
        ${item.promotion?.length
          ? renderPlanningBadge(
              `${item.promotion.length} backlog link${item.promotion.length === 1 ? '' : 's'}`,
              'positive',
            )
          : nothing}
      </div>
    </div>`;
  }

  private _renderPromotionEditor(item: RoadmapItem) {
    return html`<div class="card">
      <div class="editor-head">
        <div>
          <h3>Promote to backlog markdown specs</h3>
          <p class="muted">Requires stage=refined and each spec needs ## Acceptance Criteria.</p>
        </div>
        <button class="secondary" @click=${this._addPromotionSpec}>Add spec</button>
      </div>
      ${item.promotion?.length
        ? html`<div class="badges" style="margin-bottom: 10px;">
            ${item.promotion.map((entry) =>
              renderPlanningBadge(
                entry.specPath ?? entry.backlogItemId ?? 'backlog link',
                'positive',
              ),
            )}
          </div>`
        : nothing}
      ${this._promotionDrafts.map(
        (spec, index) =>
          html`<div class="promotion-spec">
            <label
              >Spec title
              <input
                data-testid=${`roadmap-promote-title-${index}`}
                .value=${spec.title}
                @input=${(e: Event) =>
                  this._updatePromotionSpec(index, {
                    title: (e.target as HTMLInputElement).value,
                  })}
              />
            </label>
            <label
              >Spec markdown
              <textarea
                data-testid=${`roadmap-promote-body-${index}`}
                .value=${spec.body}
                @input=${(e: Event) =>
                  this._updatePromotionSpec(index, {
                    body: (e.target as HTMLTextAreaElement).value,
                  })}
              ></textarea>
            </label>
            <div class="actions">
              <button
                class="danger"
                type="button"
                ?disabled=${this._promotionDrafts.length <= 1}
                @click=${() => this._removePromotionSpec(index)}
              >
                Remove spec
              </button>
            </div>
          </div>`,
      )}
      <div class="actions" style="margin-top: 10px;">
        <button
          data-testid="roadmap-promote"
          ?disabled=${item.stage !== 'refined' || this._busy === 'promote'}
          @click=${this._promoteSelected}
        >
          Promote ${this._promotionDrafts.length}
          spec${this._promotionDrafts.length === 1 ? '' : 's'}
        </button>
      </div>
    </div>`;
  }

  private _renderEditor() {
    const item = this._selected;
    if (!item) return html`<div class="card empty">Select or create a roadmap item.</div>`;
    return html`<div class="editor">
        <div class="editor-head">
          <div>
            <h2>Edit roadmap item</h2>
            <p class="muted">${item.id} · ${item.filePath} · hash ${item.fileHash.slice(0, 8)}</p>
          </div>
          <div class="actions">
            ${item.stage === 'archived'
              ? html`<button
                  class="secondary"
                  data-testid="roadmap-restore"
                  @click=${() =>
                    this._setSelectedStage(item.promotion?.length ? 'promoted' : 'rough')}
                >
                  Restore
                </button>`
              : html`<button
                  class="secondary"
                  data-testid="roadmap-archive"
                  @click=${() => this._setSelectedStage('archived')}
                >
                  Archive
                </button>`}
            ${item.stage !== 'promoted' && !item.promotion?.length
              ? html`<button
                  class="danger"
                  data-testid="roadmap-delete"
                  @click=${this._deleteSelected}
                >
                  Delete
                </button>`
              : nothing}
            <button
              class="secondary"
              data-testid="roadmap-prepare-prompt"
              @click=${() => this._refineSelected(false)}
            >
              Prepare prompt
            </button>
            <button data-testid="roadmap-refine-tmux" @click=${() => this._refineSelected(true)}>
              Refine in tmux
            </button>
            <button
              data-testid="roadmap-save"
              ?disabled=${this._busy === 'save'}
              @click=${this._saveSelected}
            >
              Save
            </button>
          </div>
        </div>
        <div class="grid">
          <label
            >Title
            <input
              data-testid="roadmap-edit-title"
              .value=${this._editTitle}
              @input=${(e: Event) => (this._editTitle = (e.target as HTMLInputElement).value)}
            />
          </label>
          ${this._renderProjectPicker(
            'Project',
            'roadmap-edit-project',
            this._editProject,
            (project) => {
              this._editProject = project;
            },
          )}
          <label
            >Stage
            <select
              data-testid="roadmap-edit-stage"
              .value=${this._editStage}
              @change=${(e: Event) =>
                (this._editStage = (e.target as HTMLSelectElement).value as RoadmapItemStage)}
            >
              ${ROADMAP_ITEM_STAGES.map((stage) => html`<option value=${stage}>${stage}</option>`)}
            </select>
          </label>
          <label
            >Tags
            <input
              data-testid="roadmap-edit-tags"
              .value=${this._editTags}
              @input=${(e: Event) => (this._editTags = (e.target as HTMLInputElement).value)}
            />
          </label>
          <label
            >Refine runner
            <input
              data-testid="roadmap-refine-runner"
              list="roadmap-runner-options"
              placeholder="project default"
              .value=${this._refineRunner}
              @input=${(e: Event) => (this._refineRunner = (e.target as HTMLInputElement).value)}
            />
            <datalist id="roadmap-runner-options">
              ${this._runnerOptions.map((runner) => html`<option value=${runner}></option>`)}
            </datalist>
          </label>
          <label
            >Refine model
            <input
              data-testid="roadmap-refine-model"
              list="roadmap-model-options"
              placeholder="project default"
              .value=${this._refineModel}
              @input=${(e: Event) => (this._refineModel = (e.target as HTMLInputElement).value)}
            />
            <datalist id="roadmap-model-options">
              ${this._modelOptions.map((model) => html`<option value=${model}></option>`)}
            </datalist>
          </label>
        </div>
        <label style="margin-top: 10px;"
          >Refinement command template override
          <input
            data-testid="roadmap-refine-command"
            placeholder="project default; supports {{runner}}, {{model}}, {{prompt_path}}, {{item_file}}"
            .value=${this._refineCommand}
            @input=${(e: Event) => (this._refineCommand = (e.target as HTMLInputElement).value)}
          />
        </label>
        <label style="margin-top: 10px;"
          >Markdown body
          <textarea
            data-testid="roadmap-edit-body"
            class="body"
            .value=${this._editBody}
            @input=${(e: Event) => (this._editBody = (e.target as HTMLTextAreaElement).value)}
          ></textarea>
        </label>
      </div>
      ${this._renderPromotionEditor(item)}`;
  }

  render() {
    return html`<section class="shell">
      <div class="header">
        <div>
          <h1>Roadmap</h1>
          <p class="muted">
            Capture rough ideas, refine them in markdown/tmux, then promote dispatchable backlog
            specs.
          </p>
        </div>
        <button
          class="secondary"
          ?disabled=${this._busy === 'refresh'}
          @click=${() => this._refresh()}
        >
          Refresh
        </button>
      </div>
      ${this._error ? html`<div class="error">${this._error}</div>` : nothing}
      ${this._message ? html`<div class="message">${this._message}</div>` : nothing}
      ${this._renderCreateForm()} ${this._renderFilters()}
      <div class="layout">
        <div class="card">
          <h2>Items (${this._items.length})</h2>
          <div class="rows">
            ${this._items.length === 0
              ? html`<div class="empty">No roadmap items match this view.</div>`
              : this._items.map((item) => this._renderRow(item))}
          </div>
        </div>
        <div class="shell">${this._renderEditor()}</div>
      </div>
    </section>`;
  }
}
