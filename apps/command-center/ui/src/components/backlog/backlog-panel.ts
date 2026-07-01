import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  BacklogAutoDispatchTickResult,
  BacklogCreateResult,
  BacklogDequeueResult,
  BacklogEnqueueResult,
  BacklogItem,
  BacklogLaunchCandidate,
  BacklogLaunchPlan,
  BacklogLaunchSlotPolicy,
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
import { DEFAULT_MODEL, MODELS_BY_RUNNER, RUNNER_OPTIONS } from '../../utils/runner-options.js';
import { buildHash, parseHashRoute } from '../../utils/url-state.js';
import {
  planningBadgeStyles,
  renderPlanningBadge,
  renderTagChips,
  tagsFromInput,
} from '../shared/planning-badges.js';
import type { SlotSelectorChangeDetail } from '../shared/slot-selector-modal.js';

import { canDequeueBacklogItemForUi } from './backlog-panel-model.js';

const STATUSES: Array<BacklogStatus | 'all'> = ['all', ...BACKLOG_STATUSES];
const FLOWS: FlowType[] = ['fix-bug', 'dev', 'review-pr', 'pr-complete', 'merge-main'];
const SOURCES: BacklogSourceKind[] = [...BACKLOG_SOURCE_KINDS];
const BACKLOG_PROJECT_PARAM = 'backlogProject';
const BACKLOG_STATUS_PARAM = 'backlogStatus';
const BACKLOG_SLOT_SELECTOR_PARAM = 'slotSelector';
const CUSTOM_PROJECT = '__custom__';
const NEW_PLAN_KEY = '__new__';

type DraftSlotPolicyKind = BacklogLaunchSlotPolicy['kind'];

interface DraftLaunchCandidate {
  id: string;
  role: 'baseline' | 'comparison';
  runner: string;
  model: string;
  effort: string;
  variant: string;
  slotPolicyKind: DraftSlotPolicyKind;
  slotsText: string;
}

interface DraftLaunchPlan {
  enabled: boolean;
  planId: string;
  candidates: DraftLaunchCandidate[];
}

interface LaunchSlotSelectorState {
  key: string;
  index: number;
}

function slotsText(item: BacklogItem): string {
  const slots = item.allowedSlots ?? [];
  if (slots.length === 0) return 'Any eligible slot';
  if (slots.length === 1) return slots[0];
  return `${slots.length} slots`;
}

function defaultCandidate(role: DraftLaunchCandidate['role'], index: number): DraftLaunchCandidate {
  const runner = role === 'baseline' ? 'claude' : index % 2 === 0 ? 'claude' : 'codex';
  const model = role === 'baseline' ? 'opus' : DEFAULT_MODEL[runner];
  return {
    id: role === 'baseline' ? 'baseline' : `comparison-${index}`,
    role,
    runner,
    model,
    effort: '',
    variant: role === 'comparison' ? `${runner}-${model.replace(/[^a-z0-9]+/gi, '-')}` : '',
    slotPolicyKind: role === 'baseline' ? 'exact' : 'spread',
    slotsText: '',
  };
}

function defaultLaunchPlanDraft(): DraftLaunchPlan {
  return {
    enabled: false,
    planId: `lp_${crypto.randomUUID()}`,
    candidates: [defaultCandidate('baseline', 0), defaultCandidate('comparison', 1)],
  };
}

function splitSlots(value: string): string[] {
  return value
    .split(',')
    .map((slot) => slot.trim())
    .filter(Boolean);
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
  @state() private _draftTags = '';
  @state() private _draftPriority = '10';
  @state() private _draftAllowedSlots: string[] = [];
  @state() private _draftAutoDispatch = false;
  @state() private _slotSelectorOpen = false;
  @state() private _launchSlotSelector: LaunchSlotSelectorState | null = null;
  @state() private _notesDrafts: Record<string, string> = {};
  @state() private _launchDrafts: Record<string, DraftLaunchPlan> = {
    [NEW_PLAN_KEY]: defaultLaunchPlanDraft(),
  };

  private _unsub?: () => void;
  private _onHashChange = () => this._applyUrlStateFromHash();

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
      .project-picker {
        display: grid;
        grid-template-columns: minmax(150px, 0.8fr) minmax(160px, 1fr);
        gap: 6px;
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
      .launch-plan {
        border: 1px solid ${unsafeCSS(colors.accent)}33;
        border-radius: ${unsafeCSS(radii.md)};
        background: ${unsafeCSS(colors.bgSurface)};
        padding: ${unsafeCSS(spacing.sm)};
        display: grid;
        gap: ${unsafeCSS(spacing.sm)};
        margin-top: ${unsafeCSS(spacing.sm)};
      }
      .launch-row {
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.sm)};
        padding: ${unsafeCSS(spacing.sm)};
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 6px;
        align-items: end;
      }
      .launch-row .wide {
        grid-column: span 2;
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
    `,
  ];

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

  private _renderProjectPicker() {
    const options = this._projects;
    const selectValue = options.includes(this._draftProject) ? this._draftProject : CUSTOM_PROJECT;
    return html`<label>
      Project
      <div class="project-picker">
        <select
          data-testid="backlog-new-project-select"
          .value=${selectValue}
          @change=${(e: Event) => {
            const next = (e.target as HTMLSelectElement).value;
            this._setDraftProject(next === CUSTOM_PROJECT ? '' : next);
          }}
        >
          ${options.map((project) => html`<option value=${project}>${project}</option>`)}
          <option value=${CUSTOM_PROJECT}>Custom project…</option>
        </select>
        ${selectValue === CUSTOM_PROJECT
          ? html`<input
              data-testid="backlog-new-project"
              placeholder="custom project name"
              .value=${this._draftProject}
              @input=${(e: Event) => this._setDraftProject((e.target as HTMLInputElement).value)}
            />`
          : nothing}
      </div>
    </label>`;
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
    const globalProjects = new Set(this._globalFilters.projects);
    return this._items.filter((item) => {
      if (this._project === 'all' && globalProjects.size > 0 && !globalProjects.has(item.project)) {
        return false;
      }
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
      ? renderPlanningBadge('Any eligible slot')
      : selected.map((slot) => renderPlanningBadge(slot, 'positive'));
  }

  private _draftFromPlan(plan: BacklogLaunchPlan | undefined): DraftLaunchPlan {
    if (!plan) return defaultLaunchPlanDraft();
    return {
      enabled: true,
      planId: plan.id,
      candidates: plan.candidates.map((candidate) => {
        const slotPolicy = candidate.slotPolicy;
        return {
          id: candidate.id,
          role: candidate.role,
          runner: candidate.runner ?? 'claude',
          model: candidate.model ?? DEFAULT_MODEL[candidate.runner ?? 'claude'],
          effort: candidate.effort ?? '',
          variant: candidate.variant ?? '',
          slotPolicyKind: slotPolicy.kind,
          slotsText:
            slotPolicy.kind === 'exact'
              ? slotPolicy.slotId
              : (slotPolicy.allowedSlots ?? []).join(', '),
        } satisfies DraftLaunchCandidate;
      }),
    };
  }

  private _launchDraft(key: string, item?: BacklogItem): DraftLaunchPlan {
    const draft = this._launchDrafts[key];
    if (draft) return draft;
    return this._draftFromPlan(item?.launchPlan);
  }

  private _setLaunchDraft(key: string, draft: DraftLaunchPlan) {
    this._launchDrafts = { ...this._launchDrafts, [key]: draft };
  }

  private _launchPlanFromDraft(key: string, item?: BacklogItem): BacklogLaunchPlan | undefined {
    const draft = this._launchDraft(key, item);
    if (!draft.enabled) return undefined;
    return {
      id: draft.planId,
      version: 1,
      candidates: draft.candidates.map((candidate): BacklogLaunchCandidate => {
        const slots = splitSlots(candidate.slotsText);
        const slotPolicy: BacklogLaunchSlotPolicy =
          candidate.slotPolicyKind === 'exact'
            ? { kind: 'exact', slotId: slots[0] ?? '' }
            : candidate.slotPolicyKind === 'pool'
              ? { kind: 'pool', allowedSlots: slots }
              : slots.length > 0
                ? { kind: 'spread', allowedSlots: slots }
                : { kind: 'spread' };
        return {
          id: candidate.id,
          role: candidate.role,
          runner: candidate.runner || undefined,
          model: candidate.model || undefined,
          effort: candidate.effort || undefined,
          variant: candidate.role === 'comparison' ? candidate.variant : undefined,
          slotPolicy,
        };
      }),
    };
  }

  private _updateLaunchCandidate(
    key: string,
    index: number,
    patch: Partial<DraftLaunchCandidate>,
    item?: BacklogItem,
  ) {
    const draft = this._launchDraft(key, item);
    const candidates = draft.candidates.map((candidate, i) =>
      i === index ? { ...candidate, ...patch } : candidate,
    );
    this._setLaunchDraft(key, { ...draft, candidates });
  }

  private _itemForLaunchSelector(key: string): BacklogItem | undefined {
    return key === NEW_PLAN_KEY ? undefined : this._items.find((item) => item.id === key);
  }

  private _launchSelectorProject(key: string): string {
    return key === NEW_PLAN_KEY
      ? this._draftProject
      : (this._itemForLaunchSelector(key)?.project ?? '');
  }

  private _setLaunchCandidateSlots(event: CustomEvent<SlotSelectorChangeDetail>) {
    const selector = this._launchSlotSelector;
    if (!selector) return;
    const item = this._itemForLaunchSelector(selector.key);
    const draft = this._launchDraft(selector.key, item);
    const candidate = draft.candidates[selector.index];
    const selected =
      candidate?.slotPolicyKind === 'exact'
        ? event.detail.selected.slice(0, 1)
        : event.detail.selected;
    this._updateLaunchCandidate(
      selector.key,
      selector.index,
      { slotsText: selected.join(', ') },
      item,
    );
  }

  private _renderLaunchSlotSelectorModal() {
    const selector = this._launchSlotSelector;
    if (!selector) return nothing;
    const item = this._itemForLaunchSelector(selector.key);
    const draft = this._launchDraft(selector.key, item);
    const candidate = draft.candidates[selector.index];
    const selected = splitSlots(candidate?.slotsText ?? '');
    return html`<slot-selector-modal
      .open=${true}
      .slots=${this._slots}
      .selected=${selected}
      .filters=${this._globalFilters}
      .project=${this._launchSelectorProject(selector.key)}
      heading=${`Choose ${candidate?.role ?? 'launch'} candidate slots`}
      @slot-selector-change=${this._setLaunchCandidateSlots}
      @slot-selector-close=${() => (this._launchSlotSelector = null)}
    ></slot-selector-modal>`;
  }

  private _renderLaunchPlanEditor(key: string, item?: BacklogItem) {
    const draft = this._launchDraft(key, item);
    return html`<div class="launch-plan" data-testid="backlog-launch-plan-editor">
      <label>
        <span>Launch plan</span>
        <input
          type="checkbox"
          .checked=${draft.enabled}
          @change=${(e: Event) =>
            this._setLaunchDraft(key, {
              ...draft,
              enabled: (e.target as HTMLInputElement).checked,
            })}
        />
      </label>
      ${draft.enabled
        ? html`
            <div class="meta">
              One baseline plus comparison candidates. Slot policy uses existing dispatch queue
              constraints.
            </div>
            ${draft.candidates.map((candidate, index) =>
              this._renderLaunchCandidateRow(key, draft, candidate, index, item),
            )}
            <div class="actions">
              <button
                class="secondary"
                type="button"
                @click=${() =>
                  this._setLaunchDraft(key, {
                    ...draft,
                    candidates: [
                      ...draft.candidates,
                      defaultCandidate('comparison', draft.candidates.length),
                    ],
                  })}
              >
                Add comparison
              </button>
            </div>
          `
        : nothing}
    </div>`;
  }

  private _renderLaunchCandidateRow(
    key: string,
    draft: DraftLaunchPlan,
    candidate: DraftLaunchCandidate,
    index: number,
    item?: BacklogItem,
  ) {
    const models = MODELS_BY_RUNNER[candidate.runner] ?? [];
    return html`<div class="launch-row" data-testid="backlog-launch-candidate">
      <div>
        <div class="field-label">${candidate.role}</div>
        ${renderPlanningBadge(candidate.id, candidate.role === 'baseline' ? 'positive' : 'default')}
      </div>
      <label
        >Runner
        <select
          .value=${candidate.runner}
          @change=${(e: Event) => {
            const runner = (e.target as HTMLSelectElement).value;
            this._updateLaunchCandidate(
              key,
              index,
              {
                runner,
                model: DEFAULT_MODEL[runner],
                variant:
                  candidate.role === 'comparison'
                    ? `${runner}-${DEFAULT_MODEL[runner].replace(/[^a-z0-9]+/gi, '-')}`
                    : '',
              },
              item,
            );
          }}
        >
          ${RUNNER_OPTIONS.map((runner) => html`<option value=${runner}>${runner}</option>`)}
        </select>
      </label>
      <label
        >Model
        <select
          .value=${candidate.model}
          @change=${(e: Event) =>
            this._updateLaunchCandidate(
              key,
              index,
              { model: (e.target as HTMLSelectElement).value },
              item,
            )}
        >
          ${models.map((model) => html`<option value=${model}>${model}</option>`)}
        </select>
      </label>
      ${candidate.role === 'comparison'
        ? html`<label
            >Variant
            <input
              .value=${candidate.variant}
              @input=${(e: Event) =>
                this._updateLaunchCandidate(
                  key,
                  index,
                  { variant: (e.target as HTMLInputElement).value },
                  item,
                )}
            />
          </label>`
        : nothing}
      <label
        >Effort
        <input
          placeholder="default"
          .value=${candidate.effort}
          @input=${(e: Event) =>
            this._updateLaunchCandidate(
              key,
              index,
              { effort: (e.target as HTMLInputElement).value },
              item,
            )}
        />
      </label>
      <label
        >Slot policy
        <select
          .value=${candidate.slotPolicyKind}
          @change=${(e: Event) =>
            this._updateLaunchCandidate(
              key,
              index,
              { slotPolicyKind: (e.target as HTMLSelectElement).value as DraftSlotPolicyKind },
              item,
            )}
        >
          <option value="exact">exact</option>
          <option value="pool">pool</option>
          <option value="spread">spread</option>
        </select>
      </label>
      <label class="wide"
        >Slot ids
        <input
          placeholder=${candidate.slotPolicyKind === 'exact'
            ? 'slot-a'
            : 'slot-a, slot-b (blank = all eligible for spread)'}
          .value=${candidate.slotsText}
          @input=${(e: Event) =>
            this._updateLaunchCandidate(
              key,
              index,
              { slotsText: (e.target as HTMLInputElement).value },
              item,
            )}
        />
      </label>
      <button
        class="secondary"
        type="button"
        ?disabled=${!this._launchSelectorProject(key)}
        @click=${() => (this._launchSlotSelector = { key, index })}
      >
        Choose visually
      </button>
      ${candidate.role === 'comparison'
        ? html`<button
            class="secondary"
            type="button"
            ?disabled=${draft.candidates.filter((row) => row.role === 'comparison').length <= 1}
            @click=${() =>
              this._setLaunchDraft(key, {
                ...draft,
                candidates: draft.candidates.filter((_, i) => i !== index),
              })}
          >
            Remove
          </button>`
        : nothing}
    </div>`;
  }

  private _renderLaunchPlanSummary(item: BacklogItem) {
    if (!item.launchPlan) return nothing;
    const state = item.launchPlanState;
    return html`<div class="launch-plan" data-testid="backlog-launch-plan-summary">
      <div class="field-label">Launch plan</div>
      ${item.launchPlan.candidates.map((candidate) => {
        const projection = state?.candidates.find((row) => row.candidateId === candidate.id);
        return html`<div class="meta">
          ${renderPlanningBadge(
            candidate.role,
            candidate.role === 'baseline' ? 'positive' : 'default',
          )}
          ${renderPlanningBadge(candidate.variant ?? candidate.id)}
          ${candidate.runner ?? item.runner ?? 'runner?'} /
          ${candidate.model ?? item.model ?? 'model?'} · ${candidate.slotPolicy.kind}
          ${projection
            ? html` · ${renderPlanningBadge(projection.status)}
              ${projection.slotId ? renderPlanningBadge(projection.slotId, 'positive') : nothing}`
            : nothing}
        </div>`;
      })}
    </div>`;
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
        tags: tagsFromInput(this._draftTags),
        priority: Number(this._draftPriority) || 10,
        allowedSlots: this._allowedSlotsFromDraft(),
        autoDispatch: this._draftAutoDispatch,
        launchPlan: this._launchPlanFromDraft(NEW_PLAN_KEY),
      });
      this._draftTitle = '';
      this._draftSourceRef = '';
      this._draftNotes = '';
      this._draftTags = '';
      this._draftAllowedSlots = [];
      this._setLaunchDraft(NEW_PLAN_KEY, defaultLaunchPlanDraft());
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

  private async _dequeue(item: BacklogItem) {
    await this._runItemAction(item.id, 'dequeue', () =>
      gateway.request<BacklogDequeueResult>(Methods.BACKLOG_DEQUEUE, { itemId: item.id }),
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

  private async _saveLaunchPlan(item: BacklogItem) {
    await this._runItemAction(item.id, 'launch plan', () =>
      gateway.request<BacklogUpdateResult>(Methods.BACKLOG_UPDATE, {
        itemId: item.id,
        launchPlan: this._launchPlanFromDraft(item.id, item) ?? null,
      }),
    );
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
        ${this._renderProjectPicker()}
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
          >Tags
          <input
            placeholder="roadmap, command-center"
            .value=${this._draftTags}
            @input=${(e: Event) => (this._draftTags = (e.target as HTMLInputElement).value)}
          />
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
      ${this._renderLaunchPlanEditor(NEW_PLAN_KEY)}
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
          ${renderPlanningBadge(
            item.status,
            item.status === 'ready'
              ? 'positive'
              : item.status === 'failed' || item.status === 'needs-attention'
                ? 'danger'
                : 'default',
          )}
          ${renderPlanningBadge(`p${item.priority}`)} ${renderPlanningBadge(slotsText(item))}
          ${renderTagChips(item.tags)}
          ${item.roadmapItemId
            ? renderPlanningBadge(`roadmap ${item.roadmapItemId}`, 'positive')
            : nothing}
          ${item.specPath ? renderPlanningBadge(`spec ${item.specPath}`) : nothing}
          ${item.autoDispatch ? renderPlanningBadge('auto', 'positive') : nothing}
        </div>
      </div>
      ${item.lastDispatchError ? html`<div class="error">${item.lastDispatchError}</div>` : nothing}
      ${this._renderLaunchPlanSummary(item)} ${this._renderLaunchPlanEditor(item.id, item)}
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
          class="secondary"
          ?disabled=${this._busy.endsWith(item.id)}
          @click=${() => this._saveLaunchPlan(item)}
        >
          Save launch plan
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
        <button
          class="secondary"
          ?disabled=${!canDequeueBacklogItemForUi(item) || this._busy.endsWith(item.id)}
          @click=${() => this._dequeue(item)}
        >
          Dequeue
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
      ${this._renderLaunchSlotSelectorModal()}
    </section>`;
  }
}
