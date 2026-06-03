import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  BacklogAutoDispatchTickResult,
  BacklogCreateResult,
  BacklogEnqueueResult,
  BacklogItem,
  BacklogMarkReadyResult,
  BacklogSourceKind,
  BacklogStatus,
  BacklogUpdateResult,
  FlowType,
  SlotStatus,
} from '@farmslot/protocol';
import { BACKLOG_SOURCE_KINDS, BACKLOG_STATUSES, Methods } from '@farmslot/protocol';

import '../shared/slot-selector-modal.js';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, type GlobalFilters, subscribe } from '../../state.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { buildHash, parseHashRoute } from '../../utils/url-state.js';
import type { SlotSelectorChangeDetail } from '../shared/slot-selector-modal.js';

const STATUSES: Array<BacklogStatus | 'all'> = ['all', ...BACKLOG_STATUSES];
const FLOWS: FlowType[] = ['fix-bug', 'dev', 'review-pr', 'pr-complete', 'merge-main'];
const SOURCES: BacklogSourceKind[] = [...BACKLOG_SOURCE_KINDS];
const BACKLOG_PROJECT_PARAM = 'backlogProject';
const BACKLOG_STATUS_PARAM = 'backlogStatus';
const BACKLOG_SLOT_SELECTOR_PARAM = 'slotSelector';

function slotsText(item: BacklogItem): string {
  const slots = item.allowedSlots ?? [];
  if (slots.length === 0) return 'Any eligible slot';
  if (slots.length === 1) return slots[0];
  return `${slots.length} slots`;
}

@customElement('backlog-panel')
export class BacklogPanel extends LitElement {
  @property({ attribute: false }) items: BacklogItem[] | null = null;
  @property({ attribute: false }) slots: SlotStatus[] | null = null;
  @state() private _items: BacklogItem[] = [];
  @state() private _slots: SlotStatus[] = [];
  @state() private _globalFilters: GlobalFilters = { projects: [], machines: [] };
  @state() private _project = 'all';
  @state() private _status: BacklogStatus | 'all' = 'all';
  @state() private _busy = '';
  @state() private _error = '';
  @state() private _message = '';
  @state() private _draftProject = '';
  @state() private _draftTitle = '';
  @state() private _draftSourceKind: BacklogSourceKind = 'jira';
  @state() private _draftSourceRef = '';
  @state() private _draftFlow: FlowType = 'fix-bug';
  @state() private _draftNotes = '';
  @state() private _draftPriority = '10';
  @state() private _draftAllowedSlots: string[] = [];
  @state() private _draftAutoDispatch = false;
  @state() private _slotSelectorOpen = false;
  @state() private _notesDrafts: Record<string, string> = {};

  private _unsub?: () => void;
  private _onHashChange = () => this._applyUrlStateFromHash();

  static styles = css`
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
    form {
      border: 1px solid ${unsafeCSS(colors.textMuted)}22;
      border-radius: ${unsafeCSS(radii.md)};
      background: ${unsafeCSS(colors.bgCard)};
      padding: ${unsafeCSS(spacing.md)};
    }
    .header {
      display: flex;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.sm)};
      align-items: center;
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
    h2 {
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
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: ${unsafeCSS(spacing.sm)};
      align-items: end;
    }
    label {
      display: grid;
      gap: 4px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .field-label {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .slot-picker-field {
      display: grid;
      gap: 4px;
    }
    .slot-picker-summary {
      border: 1px solid ${unsafeCSS(colors.textMuted)}33;
      border-radius: ${unsafeCSS(radii.sm)};
      background: ${unsafeCSS(colors.bgSurface)};
      padding: 8px;
      display: flex;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.sm)};
      align-items: center;
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
      min-height: 70px;
      resize: vertical;
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
    }
    .row-head {
      display: flex;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.sm)};
      align-items: flex-start;
    }
    .title {
      font-weight: 700;
    }
    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .badge {
      border: 1px solid ${unsafeCSS(colors.textMuted)}33;
      border-radius: 999px;
      padding: 2px 7px;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    .badge.ready {
      color: ${unsafeCSS(colors.statusOk)};
      border-color: ${unsafeCSS(colors.statusOk)}66;
    }
    .badge.failed,
    .error {
      color: ${unsafeCSS(colors.statusFail)};
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .message {
      color: ${unsafeCSS(colors.statusOk)};
    }
    .empty {
      color: ${unsafeCSS(colors.textMuted)};
      padding: ${unsafeCSS(spacing.md)};
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._sync(getState());
    this._applyUrlStateFromHash();
    window.addEventListener('hashchange', this._onHashChange);
    this._unsub = subscribe((s) => this._sync(s));
  }

  disconnectedCallback() {
    this._unsub?.();
    window.removeEventListener('hashchange', this._onHashChange);
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string, unknown>) {
    if (changed.has('items') || changed.has('slots')) this._sync(getState());
  }

  private _sync(s: AppState) {
    this._items = this.items ?? s.backlogItems;
    this._slots = this.slots ?? s.fleet?.slots ?? [];
    this._globalFilters = s.globalFilters;
    if (!this._draftProject) {
      this._draftProject =
        [...new Set(this._slots.map((slot) => slot.project).filter(Boolean))][0] ?? '';
    }
  }

  private _applyUrlStateFromHash() {
    if (typeof location === 'undefined') return;
    const { route, params } = parseHashRoute();
    if (route !== 'backlog') return;
    const project = params.get(BACKLOG_PROJECT_PARAM);
    this._project = project?.trim() || 'all';
    const status = params.get(BACKLOG_STATUS_PARAM);
    this._status = STATUSES.includes(status as BacklogStatus | 'all')
      ? (status as BacklogStatus | 'all')
      : 'all';
    this._slotSelectorOpen = params.get(BACKLOG_SLOT_SELECTOR_PARAM) === '1';
  }

  private _writeUrlState() {
    if (typeof location === 'undefined') return;
    const { route, params } = parseHashRoute();
    if (route !== 'backlog') return;
    if (this._project === 'all') params.delete(BACKLOG_PROJECT_PARAM);
    else params.set(BACKLOG_PROJECT_PARAM, this._project);
    if (this._status === 'all') params.delete(BACKLOG_STATUS_PARAM);
    else params.set(BACKLOG_STATUS_PARAM, this._status);
    if (this._slotSelectorOpen) params.set(BACKLOG_SLOT_SELECTOR_PARAM, '1');
    else params.delete(BACKLOG_SLOT_SELECTOR_PARAM);
    const next = buildHash(route, params);
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  private _setProjectFilter(project: string) {
    this._project = project;
    this._writeUrlState();
  }

  private _setDraftProject(project: string) {
    this._draftProject = project;
    const projectSlotIds = new Set(this._slotOptions(project).map((slot) => slot.slot));
    this._draftAllowedSlots = this._draftAllowedSlots.filter((slotId) =>
      projectSlotIds.has(slotId),
    );
  }

  private _setStatusFilter(status: BacklogStatus | 'all') {
    this._status = status;
    this._writeUrlState();
  }

  private _setSlotSelectorOpen(open: boolean) {
    this._slotSelectorOpen = open;
    this._writeUrlState();
  }

  private get _projects(): string[] {
    return [
      ...new Set([
        ...this._items.map((item) => item.project),
        ...this._slots.map((slot) => slot.project).filter(Boolean),
      ]),
    ].sort();
  }

  private get _filtered(): BacklogItem[] {
    return this._items.filter((item) => {
      if (this._project !== 'all' && item.project !== this._project) return false;
      if (this._status !== 'all' && item.status !== this._status) return false;
      return true;
    });
  }

  private _slotOptions(project: string): SlotStatus[] {
    return this._slots
      .filter((slot) => slot.project === project)
      .sort((a, b) => a.slot.localeCompare(b.slot));
  }

  private _allowedSlotsFromDraft(): string[] | undefined {
    return this._draftAllowedSlots.length > 0 ? [...this._draftAllowedSlots] : undefined;
  }

  private _setAllowedSlots(event: CustomEvent<SlotSelectorChangeDetail>) {
    this._draftAllowedSlots = [...event.detail.selected];
  }

  private _renderAllowedSlotChips(selected: string[]) {
    return selected.length === 0
      ? html`<span class="badge">Any eligible slot</span>`
      : selected.map((slot) => html`<span class="badge ready">${slot}</span>`);
  }

  private async _createItem(event: Event) {
    event.preventDefault();
    this._error = '';
    this._message = '';
    if (!this._draftProject) {
      this._error = 'Select a project before creating a backlog item.';
      return;
    }
    this._busy = 'create';
    try {
      await gateway.request<BacklogCreateResult>(Methods.BACKLOG_CREATE, {
        project: this._draftProject,
        title: this._draftTitle,
        sourceKind: this._draftSourceKind,
        sourceRef: this._draftSourceRef || undefined,
        flowType: this._draftFlow,
        notes: this._draftNotes || undefined,
        priority: Number(this._draftPriority) || 10,
        allowedSlots: this._allowedSlotsFromDraft(),
        autoDispatch: this._draftAutoDispatch,
      });
      this._draftTitle = '';
      this._draftSourceRef = '';
      this._draftNotes = '';
      this._draftAllowedSlots = [];
      this._message = 'Backlog item created';
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._busy = '';
    }
  }

  private async _markReady(item: BacklogItem) {
    await this._runItemAction(item.id, 'ready', () =>
      gateway.request<BacklogMarkReadyResult>(Methods.BACKLOG_MARK_READY, { itemId: item.id }),
    );
  }

  private async _enqueue(item: BacklogItem) {
    await this._runItemAction(item.id, 'enqueue', () =>
      gateway.request<BacklogEnqueueResult>(Methods.BACKLOG_ENQUEUE, { itemId: item.id }),
    );
  }

  private async _saveNotes(item: BacklogItem) {
    await this._runItemAction(item.id, 'notes', () =>
      gateway.request<BacklogUpdateResult>(Methods.BACKLOG_UPDATE, {
        itemId: item.id,
        notes: this._notesDrafts[item.id] ?? item.notes ?? '',
      }),
    );
    const { [item.id]: _saved, ...remainingDrafts } = this._notesDrafts;
    this._notesDrafts = remainingDrafts;
  }

  private async _autoDispatch() {
    this._busy = 'auto';
    this._error = '';
    this._message = '';
    try {
      const result = await gateway.request<BacklogAutoDispatchTickResult>(
        Methods.BACKLOG_AUTO_DISPATCH_TICK,
        this._project === 'all' ? {} : { project: this._project },
      );
      this._message = `Auto-dispatch enqueued ${result.enqueued.length}; blocked ${result.blocked.length}`;
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._busy = '';
    }
  }

  private async _runItemAction(itemId: string, label: string, action: () => Promise<unknown>) {
    this._busy = `${label}:${itemId}`;
    this._error = '';
    this._message = '';
    try {
      await action();
      this._message = `${label} complete`;
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._busy = '';
    }
  }

  private _renderCreateForm() {
    const slotOptions = this._slotOptions(this._draftProject);
    const selectedSlots = this._allowedSlotsFromDraft() ?? [];
    return html`<form @submit=${this._createItem}>
      <h2>Add backlog item</h2>
      <div class="grid">
        <label
          >Project
          <select
            .value=${this._draftProject}
            @change=${(e: Event) => this._setDraftProject((e.target as HTMLSelectElement).value)}
          >
            ${this._projects.map((project) => html`<option value=${project}>${project}</option>`)}
          </select>
        </label>
        <label
          >Title
          <input
            required
            .value=${this._draftTitle}
            @input=${(e: Event) => (this._draftTitle = (e.target as HTMLInputElement).value)}
          />
        </label>
        <label
          >Source
          <select
            .value=${this._draftSourceKind}
            @change=${(e: Event) =>
              (this._draftSourceKind = (e.target as HTMLSelectElement).value as BacklogSourceKind)}
          >
            ${SOURCES.map((source) => html`<option value=${source}>${source}</option>`)}
          </select>
        </label>
        <label
          >Ref
          <input
            placeholder="PROJ-123, owner/repo#1, or blank for manual"
            .value=${this._draftSourceRef}
            @input=${(e: Event) => (this._draftSourceRef = (e.target as HTMLInputElement).value)}
          />
        </label>
        <label
          >Flow
          <select
            .value=${this._draftFlow}
            @change=${(e: Event) =>
              (this._draftFlow = (e.target as HTMLSelectElement).value as FlowType)}
          >
            ${FLOWS.map((flow) => html`<option value=${flow}>${flow}</option>`)}
          </select>
        </label>
        <label
          >Priority
          <input
            type="number"
            .value=${this._draftPriority}
            @input=${(e: Event) => (this._draftPriority = (e.target as HTMLInputElement).value)}
          />
        </label>
        <div class="slot-picker-field">
          <span class="field-label">Allowed slots</span>
          <div class="slot-picker-summary">
            <div class="badges">${this._renderAllowedSlotChips(selectedSlots)}</div>
            <button class="secondary" type="button" @click=${() => this._setSlotSelectorOpen(true)}>
              Choose visually
            </button>
          </div>
          <span class="meta">
            ${slotOptions.length} project slot${slotOptions.length === 1 ? '' : 's'} match the
            selected project.
          </span>
        </div>
        <label>
          Auto-dispatch
          <input
            type="checkbox"
            .checked=${this._draftAutoDispatch}
            @change=${(e: Event) =>
              (this._draftAutoDispatch = (e.target as HTMLInputElement).checked)}
          />
        </label>
      </div>
      <label style="margin-top: 10px;"
        >Notes
        <textarea
          .value=${this._draftNotes}
          @input=${(e: Event) => (this._draftNotes = (e.target as HTMLTextAreaElement).value)}
        ></textarea>
      </label>
      <div class="actions" style="margin-top: 10px;">
        <button ?disabled=${this._busy === 'create' || !this._draftProject}>Create</button>
      </div>
      <slot-selector-modal
        .open=${this._slotSelectorOpen}
        .slots=${this._slots}
        .selected=${selectedSlots}
        .filters=${this._globalFilters}
        .project=${this._draftProject}
        heading="Choose backlog dispatch slots"
        @slot-selector-change=${this._setAllowedSlots}
        @slot-selector-close=${() => this._setSlotSelectorOpen(false)}
      ></slot-selector-modal>
    </form>`;
  }

  private _renderRow(item: BacklogItem) {
    const notesValue = this._notesDrafts[item.id] ?? item.notes ?? '';
    return html`<div class="row">
      <div class="row-head">
        <div>
          <div class="title">${item.title}</div>
          <div class="meta">
            ${item.project} · ${item.flowType} · ${item.sourceKind}:${item.sourceRef}
          </div>
        </div>
        <div class="badges">
          <span class="badge ${item.status}">${item.status}</span>
          <span class="badge">p${item.priority}</span>
          <span class="badge">${slotsText(item)}</span>
          ${item.autoDispatch ? html`<span class="badge ready">auto</span>` : nothing}
        </div>
      </div>
      ${item.lastDispatchError ? html`<div class="error">${item.lastDispatchError}</div>` : nothing}
      <label
        >Agent notes
        <textarea
          .value=${notesValue}
          @input=${(e: Event) => {
            this._notesDrafts = {
              ...this._notesDrafts,
              [item.id]: (e.target as HTMLTextAreaElement).value,
            };
          }}
        ></textarea>
      </label>
      <div class="actions">
        <button
          class="secondary"
          ?disabled=${this._busy.endsWith(item.id)}
          @click=${() => this._saveNotes(item)}
        >
          Save notes
        </button>
        <button
          ?disabled=${item.status !== 'candidate' || this._busy.endsWith(item.id)}
          @click=${() => this._markReady(item)}
        >
          Mark ready
        </button>
        <button
          ?disabled=${item.status !== 'ready' || this._busy.endsWith(item.id)}
          @click=${() => this._enqueue(item)}
        >
          Enqueue
        </button>
      </div>
    </div>`;
  }

  render() {
    return html`<section class="shell">
      <div class="header">
        <div>
          <h1>Backlog</h1>
          <p class="muted">Durable Jira/GitHub/manual work intake before the dispatch queue.</p>
        </div>
        <button ?disabled=${this._busy === 'auto'} @click=${this._autoDispatch}>
          Auto-dispatch ready
        </button>
      </div>
      ${this._error ? html`<div class="error">${this._error}</div>` : nothing}
      ${this._message ? html`<div class="message">${this._message}</div>` : nothing}
      <div class="filters">
        <label
          >Project
          <select
            .value=${this._project}
            @change=${(e: Event) => this._setProjectFilter((e.target as HTMLSelectElement).value)}
          >
            <option value="all">All projects</option>
            ${this._projects.map((project) => html`<option value=${project}>${project}</option>`)}
          </select>
        </label>
        <label
          >Status
          <select
            .value=${this._status}
            @change=${(e: Event) =>
              this._setStatusFilter((e.target as HTMLSelectElement).value as BacklogStatus | 'all')}
          >
            ${STATUSES.map((status) => html`<option value=${status}>${status}</option>`)}
          </select>
        </label>
        <div class="muted">${this._filtered.length} / ${this._items.length} items</div>
      </div>
      ${this._renderCreateForm()}
      <div class="card">
        <h2>Items</h2>
        <div class="rows">
          ${this._filtered.length === 0
            ? html`<div class="empty">No backlog items match this view.</div>`
            : this._filtered.map((item) => this._renderRow(item))}
        </div>
      </div>
    </section>`;
  }
}
