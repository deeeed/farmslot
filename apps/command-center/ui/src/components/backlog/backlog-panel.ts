import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type {
  BacklogArchiveResult,
  BacklogAutoDispatchTickResult,
  BacklogCreateResult,
  BacklogDeleteResult,
  BacklogDequeueResult,
  BacklogEnqueueResult,
  BacklogItem,
  BacklogLaunchCandidate,
  BacklogLaunchPlan,
  BacklogLaunchSlotPolicy,
  BacklogMarkReadyResult,
  BacklogSourceKind,
  BacklogSpecGetResult,
  BacklogStatus,
  BacklogUpdateInput,
  BacklogUpdateResult,
  ConfigProjectsResult,
  ConfigTemplateOptionsResult,
  FlowType,
  ProjectConfig,
  Run,
  SlotStatus,
  WorkerTemplateOption,
  WorkGraphActivateResult,
  WorkGraphProjection,
  WorkGraphSchedulerTickResult,
} from '@farmslot/protocol';
import {
  BACKLOG_SOURCE_KINDS,
  BACKLOG_STATUSES,
  isTerminalRunStatus,
  Methods,
} from '@farmslot/protocol';

import '../shared/dispatch-config-editor.js';
import '../shared/linked-run-summary.js';
import '../shared/slot-choice-list.js';
import '../shared/slot-selector-modal.js';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, type GlobalFilters, subscribe } from '../../state.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { renderMarkdown } from '../../utils/markdown.js';
import { DEFAULT_MODEL, MODELS_BY_RUNNER, RUNNER_OPTIONS } from '../../utils/runner-options.js';
import { buildHash, parseHashRoute } from '../../utils/url-state.js';
import { projectPrepareProfiles } from '../dispatch/dispatch-wizard-draft.js';
import { templateOptionsRequestKey } from '../dispatch/dispatch-wizard-template-options.js';
import { ConfirmActionTimer } from '../shared/confirm-action-model.js';
import type {
  DispatchConfigChangeDetail,
  DispatchConfigEditorControls,
} from '../shared/dispatch-config-editor.js';
import { summarizeBacklogDispatchConfig } from '../shared/dispatch-config-summary.js';
import { flowBadgeStyles, renderFlowBadge } from '../shared/flow-badge.js';
import { linkedRunForBacklogItem, linkedRunsForBacklogItems } from '../shared/linked-run-model.js';
import {
  planningBadgeStyles,
  renderPlanningBadge,
  renderTagChips,
  statusTone,
  tagsFromInput,
} from '../shared/planning-badges.js';
import {
  planningChoiceStyles,
  renderChoiceButtons,
  renderToggleChips,
} from '../shared/planning-controls.js';
import type { SlotChoiceChangeDetail } from '../shared/slot-choice-list.js';
import type { SlotSelectorChangeDetail } from '../shared/slot-selector-modal.js';
import {
  applyWorkInventorySort,
  inventoryShowsBackAffordance,
  inventoryShowsDetail,
  inventoryShowsList,
  nextSortState,
  parseWorkInventorySort,
  renderWorkInventoryBackButton,
  renderWorkInventoryLayout,
  renderWorkInventoryRow,
  renderWorkInventoryTable,
  renderWorkInventoryTableHead,
  type WorkInventoryColumnDef,
  workInventoryTableStyles,
} from '../shared/work-inventory-table.js';
import { filterSlotsByGlobalFilters } from '../terminal/split-view-model.js';

import {
  BACKLOG_SORT_KEYS,
  backlogItemMatchesStatusFilter,
  type BacklogSortDirection,
  type BacklogSortKey,
  backlogStatusCounts,
  canArchiveBacklogItemForUi,
  canDeleteBacklogItemForUi,
  canDequeueBacklogItemForUi,
  canMarkReadyBacklogItemForUi,
  canRestoreBacklogItemForUi,
  DEFAULT_BACKLOG_STATUS_FILTER,
  displayedBacklogFlow,
  displayedBacklogStatus,
  parseBacklogStatusFilter,
  serializeBacklogStatusFilter,
  showsBacklogCleanupActionsForUi,
  sortBacklogItems,
  syncedBacklogDraftProject,
} from './backlog-panel-model.js';

const FLOWS: FlowType[] = ['fix-bug', 'dev', 'review-pr', 'pr-complete', 'update-branch'];
const SOURCES: BacklogSourceKind[] = [...BACKLOG_SOURCE_KINDS];
const BACKLOG_PROJECT_PARAM = 'backlogProject';
const BACKLOG_STATUS_PARAM = 'backlogStatus';
const BACKLOG_SLOT_SELECTOR_PARAM = 'slotSelector';
const BACKLOG_ITEM_PARAM = 'item';
const BACKLOG_MODE_PARAM = 'mode';
const BACKLOG_CREATE_PARAM = 'create';
const BACKLOG_DISPATCH_CONFIG_PARAM = 'dispatchConfig';
const BACKLOG_SPEC_PARAM = 'spec';
const BACKLOG_SORT_PARAM = 'sort';
const BACKLOG_SORT_DIRECTION_PARAM = 'direction';

const BACKLOG_INVENTORY_COLUMNS: WorkInventoryColumnDef<BacklogSortKey>[] = [
  { key: 'status', label: 'Status', width: '92px', testId: 'backlog-sort-status' },
  { key: 'flow', label: 'Flow', width: '58px', testId: 'backlog-sort-flow' },
  {
    key: 'project',
    label: 'Project',
    width: 'minmax(130px, 180px)',
    testId: 'backlog-sort-project',
  },
  { key: 'ref', label: 'Ref', width: '112px', testId: 'backlog-sort-ref' },
  { key: 'title', label: 'Title', width: 'minmax(220px, 1fr)', testId: 'backlog-sort-title' },
  {
    key: 'activity',
    label: 'Active run / slot',
    width: '210px',
    testId: 'backlog-sort-activity',
  },
  { key: 'updated', label: 'Updated', width: '86px', testId: 'backlog-sort-updated' },
];

const BACKLOG_SORT_URL = {
  sortParam: BACKLOG_SORT_PARAM,
  directionParam: BACKLOG_SORT_DIRECTION_PARAM,
  validKeys: BACKLOG_SORT_KEYS,
  defaultKey: 'activity' as const,
  defaultDirection: 'desc' as const,
};
const NEW_PLAN_KEY = '__new__';
const AUTO_DISPATCH_TOOLTIP =
  'Auto-dispatch enqueues ready backlog items only when the item has auto-dispatch enabled, the project allows it, and explicit allowed slots are set.';
const BACKLOG_DISPATCH_CONFIG_CONTROLS: DispatchConfigEditorControls = {
  template: true,
  runnerModelEffort: true,
  prepareProfile: true,
  interactiveProfile: true,
  publicationReviews: true,
  explicitModeFallback: true,
};

type DraftSlotPolicyKind = BacklogLaunchSlotPolicy['kind'];
type BacklogDetailMode = 'view' | 'edit';
type BacklogSpecViewerMode = 'markdown' | 'raw';

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
  @property({ attribute: false }) demoRuns: Run[] | null = null;
  @state() private _items: BacklogItem[] = [];
  @state() private _slots: SlotStatus[] = [];
  @state() private _runs: Run[] = [];
  @state() private _workGraphs: WorkGraphProjection[] = [];
  @state() private _globalFilters: GlobalFilters = { projects: [], machines: [] };
  @state() private _project = 'all';
  @state() private _statuses: ReadonlySet<BacklogStatus> = DEFAULT_BACKLOG_STATUS_FILTER;
  @state() private _sortKey: BacklogSortKey = 'activity';
  @state() private _sortDirection: BacklogSortDirection = 'desc';
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
  @state() private _createPanelOpen = false;
  @state() private _selectedItemId = '';
  @state() private _selectedItemMode: BacklogDetailMode = 'view';
  @state() private _narrowViewport = false;
  @state() private _forceInventoryList = false;
  private _narrowMedia?: MediaQueryList;
  private readonly _onNarrowChange = () => {
    this._narrowViewport = this._narrowMedia?.matches ?? false;
    if (!this._narrowViewport) this._forceInventoryList = false;
  };
  @state() private _slotSelectorOpen = false;
  @state() private _dispatchConfigOpen = false;
  @state() private _specViewerOpen = false;
  @state() private _specViewerMode: BacklogSpecViewerMode = 'markdown';
  @state() private _specLoadingItemId = '';
  @state() private _specContents: Record<string, BacklogSpecGetResult> = {};
  @state() private _specErrors: Record<string, string> = {};
  @state() private _dispatchConfigBusy = '';
  @state() private _dispatchConfigError = '';
  @state() private _configProjectConfigs: ProjectConfig[] = [];
  @state() private _configTemplateOptions: Record<string, WorkerTemplateOption[]> = {};
  @state() private _configTemplateOptionsError: Record<string, string> = {};
  @state() private _configTemplateOptionsLoading: Record<string, boolean> = {};
  @state() private _launchSlotSelector: LaunchSlotSelectorState | null = null;
  @state() private _notesDrafts: Record<string, string> = {};
  @state() private _launchDrafts: Record<string, DraftLaunchPlan> = {
    [NEW_PLAN_KEY]: defaultLaunchPlanDraft(),
  };
  @state() private _pendingConfirm: string | null = null;

  private _unsub?: () => void;
  private _activityCacheItems: BacklogItem[] | null = null;
  private _activityCacheRuns: Run[] | null = null;
  private _activityCache = new Map<string, Run | undefined>();
  private readonly _confirmTimer = new ConfirmActionTimer({
    pendingConfirm: () => this._pendingConfirm,
    setPendingConfirm: (pending) => {
      this._pendingConfirm = pending;
    },
  });
  private _onHashChange = () => this._applyUrlStateFromHash();
  private _onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (this._specViewerOpen) {
      event.preventDefault();
      this._setSpecViewerOpen(false);
      return;
    }
    if (this._dispatchConfigOpen) {
      event.preventDefault();
      this._setDispatchConfigOpen(false);
      return;
    }
    if (this._slotSelectorOpen || this._launchSlotSelector) return;
    if (this._selectedItemMode === 'edit') {
      event.preventDefault();
      this._selectedItemMode = 'view';
      this._writeUrlState();
      return;
    }
    if (this._createPanelOpen) {
      event.preventDefault();
      this._setCreatePanelOpen(false);
    }
  };

  static styles = [
    planningBadgeStyles,
    flowBadgeStyles,
    planningChoiceStyles,
    workInventoryTableStyles,
    css`
      :host {
        box-sizing: border-box;
        display: block;
        height: 100%;
        min-height: 0;
        overflow: hidden;
        color: ${unsafeCSS(colors.textPrimary)};
        font-family: ${unsafeCSS(fonts.mono)};
        padding: ${unsafeCSS(spacing.md)};
      }
      .shell {
        display: flex;
        flex-direction: column;
        gap: ${unsafeCSS(spacing.sm)};
        height: 100%;
        min-height: 0;
        overflow: hidden;
      }
      .scroll-column {
        min-height: 0;
        overflow-y: auto;
        padding-right: 4px;
      }
      .scroll-column::-webkit-scrollbar {
        width: 6px;
      }
      .scroll-column::-webkit-scrollbar-thumb {
        background: ${unsafeCSS(colors.textMuted)}66;
        border-radius: 3px;
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
        padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      }
      .header-compact {
        align-items: baseline;
        display: flex;
        flex-shrink: 0;
        flex-wrap: wrap;
        gap: ${unsafeCSS(spacing.sm)};
      }
      .header-compact h1 {
        font-size: ${unsafeCSS(fonts.sizeMd)};
      }
      .header-compact .muted {
        font-size: ${unsafeCSS(fonts.sizeXs)};
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
      .filter-toolbar {
        background: ${unsafeCSS(colors.bgCard)};
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.md)};
        display: grid;
        flex-shrink: 0;
        gap: ${unsafeCSS(spacing.sm)};
        padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
        position: sticky;
        top: 0;
        z-index: 2;
      }
      .filter-toolbar-top {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: ${unsafeCSS(spacing.sm)};
        justify-content: space-between;
      }
      .filter-toolbar-actions {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: ${unsafeCSS(spacing.sm)};
      }
      .filter-groups {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.lg)};
        min-width: 0;
      }
      .filter-group {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        min-width: 0;
      }
      .filter-group .field-label {
        flex-shrink: 0;
      }
      .filter-count {
        color: ${unsafeCSS(colors.textMuted)};
        flex-shrink: 0;
        font-size: ${unsafeCSS(fonts.sizeXs)};
        margin-left: auto;
        white-space: nowrap;
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
      button.primary-action {
        border-color: ${unsafeCSS(colors.accent)};
        background: ${unsafeCSS(colors.accent)};
        color: ${unsafeCSS(colors.bgBase)};
        font-weight: 800;
        box-shadow: 0 0 0 1px ${unsafeCSS(colors.accent)}33;
      }
      button.primary-action:hover:not(:disabled) {
        filter: brightness(1.08);
      }
      button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .rows {
        display: grid;
        gap: 2px;
        padding: 4px;
      }
      .launch-plan {
        border: 1px solid ${unsafeCSS(colors.accent)}33;
        border-radius: ${unsafeCSS(radii.md)};
        background: ${unsafeCSS(colors.bgSurface)};
        padding: ${unsafeCSS(spacing.sm)};
        display: grid;
        gap: ${unsafeCSS(spacing.sm)};
        margin-top: 0;
      }
      .dispatch-config-summary {
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.md)};
        background: ${unsafeCSS(colors.bgSurface)};
        display: grid;
        gap: ${unsafeCSS(spacing.sm)};
        margin-top: 0;
        padding: ${unsafeCSS(spacing.sm)};
      }
      .dispatch-config-head {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: ${unsafeCSS(spacing.sm)};
        justify-content: space-between;
      }
      .dispatch-chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .dispatch-chip {
        align-items: center;
        background: transparent;
        border: 1px solid ${unsafeCSS(colors.textMuted)}44;
        border-radius: ${unsafeCSS(radii.sm)};
        color: ${unsafeCSS(colors.textSecondary)};
        display: inline-flex;
        font-size: ${unsafeCSS(fonts.sizeXs)};
        gap: 5px;
        line-height: 1.25;
        min-height: 20px;
        padding: 2px 7px;
        white-space: nowrap;
      }
      .dispatch-chip::before {
        background: currentColor;
        border-radius: 50%;
        content: '';
        flex: 0 0 6px;
        height: 6px;
        width: 6px;
      }
      .dispatch-chip.positive {
        background: ${unsafeCSS(colors.statusOk)}11;
        border-color: ${unsafeCSS(colors.statusOk)}66;
        color: ${unsafeCSS(colors.statusOk)};
      }
      .dispatch-chip.warn {
        background: ${unsafeCSS(colors.statusWarn)}11;
        border-color: ${unsafeCSS(colors.statusWarn)}66;
        color: ${unsafeCSS(colors.statusWarn)};
      }
      .dispatch-chip.accent {
        background: ${unsafeCSS(colors.accent)}11;
        border-color: ${unsafeCSS(colors.accent)}66;
        color: ${unsafeCSS(colors.accent)};
      }
      .dispatch-meta-grid {
        display: grid;
        gap: 6px;
        grid-template-columns: repeat(auto-fit, minmax(135px, 1fr));
      }
      .dispatch-meta-cell {
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.sm)};
        display: grid;
        gap: 2px;
        min-width: 0;
        padding: 7px 8px;
      }
      .dispatch-meta-label {
        color: ${unsafeCSS(colors.textMuted)};
        font-size: 10px;
        text-transform: uppercase;
      }
      .dispatch-meta-value {
        color: ${unsafeCSS(colors.textSecondary)};
        font-size: ${unsafeCSS(fonts.sizeXs)};
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      .dispatch-review-pipeline {
        align-items: center;
        display: flex;
        gap: 4px;
        min-width: 0;
        overflow: hidden;
      }
      .dispatch-review-segment {
        background: ${unsafeCSS(colors.statusUnknown)};
        border-radius: 2px;
        flex: 1 1 18px;
        height: 4px;
        max-width: 32px;
        min-width: 10px;
        opacity: 0.55;
      }
      .dispatch-review-label {
        color: ${unsafeCSS(colors.textMuted)};
        font-size: 10px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .spec-attachment {
        border: 1px solid ${unsafeCSS(colors.accent)}44;
        border-radius: ${unsafeCSS(radii.md)};
        background: ${unsafeCSS(colors.accent)}0d;
        color: inherit;
        cursor: pointer;
        display: flex;
        gap: ${unsafeCSS(spacing.sm)};
        justify-content: space-between;
        align-items: center;
        padding: ${unsafeCSS(spacing.sm)};
        text-align: left;
        width: 100%;
      }
      .spec-attachment:hover {
        border-color: ${unsafeCSS(colors.accent)};
        background: ${unsafeCSS(colors.accent)}11;
      }
      .spec-path {
        color: ${unsafeCSS(colors.accent)};
        font-size: ${unsafeCSS(fonts.sizeXs)};
        margin-top: 4px;
        overflow-wrap: anywhere;
      }
      .spec-attachment-main {
        min-width: 0;
      }
      .spec-raw {
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.bgBase)};
        color: ${unsafeCSS(colors.textPrimary)};
        font: inherit;
        line-height: 1.5;
        margin: 0;
        overflow: auto;
        padding: ${unsafeCSS(spacing.md)};
        white-space: pre-wrap;
      }
      .spec-raw {
        max-height: min(68vh, 720px);
      }
      .spec-markdown {
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.bgBase)};
        color: ${unsafeCSS(colors.textPrimary)};
        line-height: 1.55;
        max-height: min(68vh, 720px);
        overflow: auto;
        padding: ${unsafeCSS(spacing.lg)};
      }
      .spec-markdown h1,
      .spec-markdown h2,
      .spec-markdown h3 {
        margin: 0 0 ${unsafeCSS(spacing.sm)};
      }
      .spec-markdown p,
      .spec-markdown ul,
      .spec-markdown ol,
      .spec-markdown pre {
        margin-top: 0;
      }
      .modal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 30;
        display: grid;
        place-items: center;
        padding: ${unsafeCSS(spacing.lg)};
        background: rgb(0 0 0 / 0.58);
      }
      .dispatch-config-modal {
        width: min(920px, calc(100vw - 32px));
        max-height: min(760px, calc(100vh - 32px));
        overflow: auto;
        border: 1px solid ${unsafeCSS(colors.accent)}55;
        border-radius: ${unsafeCSS(radii.md)};
        background: ${unsafeCSS(colors.bgCard)};
        box-shadow: 0 20px 60px rgb(0 0 0 / 0.35);
        color: ${unsafeCSS(colors.textPrimary)};
        display: grid;
        gap: ${unsafeCSS(spacing.md)};
        padding: ${unsafeCSS(spacing.lg)};
      }
      .dispatch-config-modal header,
      .config-grid {
        display: flex;
        flex-wrap: wrap;
        gap: ${unsafeCSS(spacing.md)};
        justify-content: space-between;
        align-items: flex-start;
      }
      .dispatch-config-modal h3,
      .dispatch-config-modal p {
        margin: 0;
      }
      .config-field,
      .config-check,
      .slot-picker {
        display: grid;
        gap: 5px;
        color: ${unsafeCSS(colors.textSecondary)};
        font-size: ${unsafeCSS(fonts.sizeXs)};
      }
      .config-field {
        flex: 1 1 110px;
      }
      .config-check {
        align-items: center;
        flex: 2 1 260px;
      }
      .config-check span {
        display: grid;
        gap: 3px;
      }
      .config-check small {
        color: ${unsafeCSS(colors.textMuted)};
        line-height: 1.4;
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
      /* Column tracks come from --work-inventory-columns on the shared shell.
         Do not hardcode a second grid here or the TS column widths go dead. */
      .compact-row,
      .table-head,
      .work-inventory-head,
      .work-inventory-row {
        align-items: center;
        display: grid;
        gap: 8px;
        grid-template-columns: var(--work-inventory-columns);
      }
      .compact-row {
        background: ${unsafeCSS(colors.bgSurface)};
        border: 1px solid transparent;
        border-radius: ${unsafeCSS(radii.sm)};
        cursor: pointer;
        min-height: 28px;
        padding: 4px 8px;
      }
      .compact-row:hover {
        background: ${unsafeCSS(colors.bgCard)};
        border-color: ${unsafeCSS(colors.textMuted)}33;
      }
      .compact-row.selected {
        background: ${unsafeCSS(colors.accent)}11;
        border-color: ${unsafeCSS(colors.accent)}77;
      }
      .compact-row.has-error {
        border-left: 2px solid ${unsafeCSS(colors.statusFail)};
        padding-left: 6px;
      }
      .compact-row .title {
        font-size: ${unsafeCSS(fonts.sizeSm)};
        font-weight: 500;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .activity-link {
        align-items: center;
        color: ${unsafeCSS(colors.textSecondary)};
        display: flex;
        gap: 6px;
        min-width: 0;
        text-decoration: none;
      }
      .activity-link:hover {
        color: ${unsafeCSS(colors.accent)};
      }
      .activity-slot {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .no-activity {
        color: ${unsafeCSS(colors.textMuted)};
      }
      .updated-cell {
        color: ${unsafeCSS(colors.textMuted)};
        font-size: ${unsafeCSS(fonts.sizeXs)};
        white-space: nowrap;
      }
      .title {
        font-weight: 700;
      }
      /* The id people actually say out loud (MANUAL-000055, TAT-1234). Monospace
         and dimmed so it reads as an identifier without competing with the title. */
      .item-ref {
        color: ${unsafeCSS(colors.textSecondary)};
        font-family: ${unsafeCSS(fonts.mono)};
        font-size: ${unsafeCSS(fonts.sizeXs)};
        white-space: nowrap;
      }
      .badge.failed,
      .error {
        color: ${unsafeCSS(colors.statusFail)};
      }
      .badge-link {
        border: 1px solid ${unsafeCSS(colors.accent)}66;
        border-radius: 999px;
        color: ${unsafeCSS(colors.textPrimary)};
        display: inline-flex;
        font-size: ${unsafeCSS(fonts.sizeXs)};
        line-height: 1;
        padding: 4px 8px;
        text-decoration: none;
        width: fit-content;
      }
      .badge-link:hover {
        background: ${unsafeCSS(colors.accent)}22;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .action-state {
        border: 1px solid ${unsafeCSS(colors.textMuted)}33;
        border-radius: ${unsafeCSS(radii.sm)};
        color: ${unsafeCSS(colors.textSecondary)};
        display: inline-flex;
        font-size: ${unsafeCSS(fonts.sizeXs)};
        line-height: 1;
        padding: 8px 10px;
      }
      .action-state.ready {
        border-color: ${unsafeCSS(colors.statusOk)}66;
        color: ${unsafeCSS(colors.statusOk)};
      }
      .message {
        color: ${unsafeCSS(colors.statusOk)};
      }
      .empty {
        color: ${unsafeCSS(colors.textMuted)};
        padding: ${unsafeCSS(spacing.md)};
      }
      .list-panel {
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.md)};
        background: ${unsafeCSS(colors.bgCard)};
        display: flex;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
      }
      .backlog-browser {
        display: contents;
      }
      .detail-panel {
        border: 1px solid ${unsafeCSS(colors.accent)}55;
        border-radius: ${unsafeCSS(radii.md)};
        background: ${unsafeCSS(colors.bgCard)};
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 8px;
        min-height: 0;
        min-width: 0;
        overflow: auto;
        padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      }
      .detail-panel > * {
        flex: 0 0 auto;
        min-height: 0;
      }
      .detail-panel.empty-detail {
        border-color: ${unsafeCSS(colors.textMuted)}22;
        color: ${unsafeCSS(colors.textMuted)};
      }
      .detail-top {
        display: block;
      }
      .detail-title-row {
        align-items: flex-start;
        display: flex;
        gap: 8px;
        justify-content: space-between;
      }
      .detail-top h2 {
        flex: 1 1 auto;
        font-size: ${unsafeCSS(fonts.sizeSm)};
        line-height: 1.35;
        margin: 0;
        min-width: 0;
      }
      .detail-meta {
        line-height: 1.35;
        margin: 4px 0 0;
      }
      .detail-badges {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 6px;
      }
      .detail-badges .badge {
        display: inline-flex;
        align-items: center;
        flex: 0 0 auto;
        line-height: 1.2;
        white-space: nowrap;
      }
      .detail-badges .badge-link {
        font-size: ${unsafeCSS(fonts.sizeXs)};
        padding: 2px 7px;
      }
      .detail-cleanup {
        align-items: center;
        background: ${unsafeCSS(colors.bgSurface)};
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.sm)};
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: space-between;
        padding: 6px 8px;
      }
      .detail-cleanup .actions {
        margin-left: auto;
      }
      .detail-panel button {
        font-size: ${unsafeCSS(fonts.sizeXs)};
        padding: 4px 8px;
      }
      .detail-panel button.primary-action {
        padding: 4px 10px;
      }
      .detail-panel button.confirming {
        background: ${unsafeCSS(colors.statusWarn)}22;
        border-color: ${unsafeCSS(colors.statusWarn)};
        color: ${unsafeCSS(colors.statusWarn)};
      }
      .detail-panel button.danger.confirming {
        background: ${unsafeCSS(colors.statusFail)}22;
        border-color: ${unsafeCSS(colors.statusFail)};
        color: ${unsafeCSS(colors.statusFail)};
      }
      .detail-panel .actions {
        gap: 4px;
      }
      .detail-panel .spec-attachment {
        padding: 6px 8px;
      }
      .detail-panel .dispatch-config-summary {
        gap: 6px;
        padding: 6px 8px;
      }
      .detail-panel .notes-view {
        min-height: 48px;
        padding: 8px;
      }
      .detail-panel header,
      .detail-toolbar {
        display: flex;
        justify-content: space-between;
        gap: ${unsafeCSS(spacing.sm)};
        align-items: flex-start;
      }
      .notes-view {
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.bgSurface)};
        color: ${unsafeCSS(colors.textPrimary)};
        font: inherit;
        line-height: 1.4;
        margin: 0;
        min-height: 70px;
        padding: ${unsafeCSS(spacing.md)};
        white-space: pre-wrap;
      }
      .create-panel {
        border: 1px solid ${unsafeCSS(colors.accent)}55;
        border-radius: ${unsafeCSS(radii.md)};
        background: ${unsafeCSS(colors.bgCard)};
        display: grid;
        gap: ${unsafeCSS(spacing.md)};
        padding: ${unsafeCSS(spacing.md)};
      }
      .create-panel header {
        display: flex;
        justify-content: space-between;
        gap: ${unsafeCSS(spacing.md)};
        align-items: flex-start;
      }
      .create-panel form {
        padding: 0;
      }
      .create-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: ${unsafeCSS(spacing.md)};
        align-items: start;
      }
      .wide {
        grid-column: 1 / -1;
      }
      .span-2 {
        grid-column: span 2;
      }
      .notes-field textarea {
        min-height: 180px;
      }
@media (max-width: 860px) {
        .filter-toolbar {
          position: static;
        }
        .create-grid {
          grid-template-columns: 1fr;
        }
        .span-2 {
          grid-column: 1 / -1;
        }
      }
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    this._sync(getState());
    this._applyUrlStateFromHash();
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this._narrowMedia = window.matchMedia('(max-width: 860px)');
      this._narrowViewport = this._narrowMedia.matches;
      this._narrowMedia.addEventListener('change', this._onNarrowChange);
    }
    window.addEventListener('hashchange', this._onHashChange);
    window.addEventListener('keydown', this._onKeydown);
    this._unsub = subscribe((s) => this._sync(s));
  }

  disconnectedCallback() {
    this._unsub?.();
    this._confirmTimer.clear();
    this._narrowMedia?.removeEventListener('change', this._onNarrowChange);
    window.removeEventListener('hashchange', this._onHashChange);
    window.removeEventListener('keydown', this._onKeydown);
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string, unknown>) {
    if (changed.has('items') || changed.has('slots') || changed.has('demoRuns')) {
      this._sync(getState());
    }
  }

  private _sync(s: AppState) {
    this._items = this.items ?? s.backlogItems;
    this._slots = this.slots ?? s.fleet?.slots ?? [];
    this._runs = this.demoRuns ?? s.runs;
    this._workGraphs = s.workGraphs;
    this._globalFilters = s.globalFilters;
    const nextDraftProject = syncedBacklogDraftProject({
      currentProject: this._draftProject,
      availableProjects: this._projects,
      globalProjects: s.globalFilters.projects,
    });
    if (nextDraftProject && nextDraftProject !== this._draftProject) {
      this._setDraftProject(nextDraftProject);
    }
    if (this._selectedItemId && !this._filtered.some((item) => item.id === this._selectedItemId)) {
      this._selectedItemId = '';
      this._selectedItemMode = 'view';
      this._dispatchConfigOpen = false;
      this._specViewerOpen = false;
      this._writeUrlState();
    }
    const selected = this._selectedItem;
    if (this._dispatchConfigOpen && selected) {
      void this._ensureDispatchConfigData(selected).catch((error) => {
        this._dispatchConfigError = error instanceof Error ? error.message : String(error);
      });
    }
    if (selected?.specPath) void this._loadSpec(selected);
    if (this._specViewerOpen && selected) void this._loadSpec(selected);
  }

  private _applyUrlStateFromHash() {
    if (typeof location === 'undefined') return;
    const { route, params } = parseHashRoute();
    if (route !== 'backlog') return;
    const project = params.get(BACKLOG_PROJECT_PARAM);
    this._project = project?.trim() || 'all';
    this._statuses = parseBacklogStatusFilter(params.get(BACKLOG_STATUS_PARAM));
    this._selectedItemId = params.get(BACKLOG_ITEM_PARAM)?.trim() ?? '';
    this._selectedItemMode =
      this._selectedItemId && params.get(BACKLOG_MODE_PARAM) === 'edit' ? 'edit' : 'view';
    this._createPanelOpen = params.get(BACKLOG_CREATE_PARAM) === '1';
    this._slotSelectorOpen = params.get(BACKLOG_SLOT_SELECTOR_PARAM) === '1';
    this._dispatchConfigOpen =
      Boolean(this._selectedItemId) && params.get(BACKLOG_DISPATCH_CONFIG_PARAM) === '1';
    this._specViewerOpen = Boolean(this._selectedItemId) && params.get(BACKLOG_SPEC_PARAM) === '1';
    const sort = parseWorkInventorySort(params, BACKLOG_SORT_URL);
    this._sortKey = sort.key;
    this._sortDirection = sort.direction;
    if (this._slotSelectorOpen) this._createPanelOpen = true;
  }

  private _writeUrlState() {
    if (typeof location === 'undefined') return;
    const { route, params } = parseHashRoute();
    if (route !== 'backlog') return;
    if (this._project === 'all') params.delete(BACKLOG_PROJECT_PARAM);
    else params.set(BACKLOG_PROJECT_PARAM, this._project);
    const statusParam = serializeBacklogStatusFilter(this._statuses);
    if (statusParam === null) params.delete(BACKLOG_STATUS_PARAM);
    else params.set(BACKLOG_STATUS_PARAM, statusParam);
    if (this._selectedItemId) params.set(BACKLOG_ITEM_PARAM, this._selectedItemId);
    else params.delete(BACKLOG_ITEM_PARAM);
    if (this._selectedItemId && this._selectedItemMode === 'edit') {
      params.set(BACKLOG_MODE_PARAM, 'edit');
    } else {
      params.delete(BACKLOG_MODE_PARAM);
    }
    if (this._createPanelOpen) params.set(BACKLOG_CREATE_PARAM, '1');
    else params.delete(BACKLOG_CREATE_PARAM);
    if (this._slotSelectorOpen) params.set(BACKLOG_SLOT_SELECTOR_PARAM, '1');
    else params.delete(BACKLOG_SLOT_SELECTOR_PARAM);
    if (this._dispatchConfigOpen && this._selectedItemId) {
      params.set(BACKLOG_DISPATCH_CONFIG_PARAM, '1');
    } else {
      params.delete(BACKLOG_DISPATCH_CONFIG_PARAM);
    }
    if (this._specViewerOpen && this._selectedItemId) params.set(BACKLOG_SPEC_PARAM, '1');
    else params.delete(BACKLOG_SPEC_PARAM);
    applyWorkInventorySort(
      params,
      { key: this._sortKey, direction: this._sortDirection },
      BACKLOG_SORT_URL,
    );
    const next = buildHash(route, params);
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  private _setProjectFilter(project: string) {
    this._project = project;
    this._writeUrlState();
  }

  private _setCreatePanelOpen(open: boolean) {
    this._createPanelOpen = open;
    if (!open) {
      this._launchSlotSelector = null;
      if (this._slotSelectorOpen) this._setSlotSelectorOpen(false);
    }
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
    const customProjectActive =
      Boolean(this._draftProject) && !options.includes(this._draftProject);
    return html`<label>
      Project
      ${renderChoiceButtons({
        options: [...options, ''],
        value: customProjectActive ? '' : this._draftProject,
        onSelect: (project) => this._setDraftProject(project),
        labels: { '': 'Custom' },
        testId: 'backlog-new-project-options',
      })}
      ${customProjectActive || !this._draftProject
        ? html`<input
            data-testid="backlog-new-project"
            placeholder="custom project name"
            .value=${this._draftProject}
            @input=${(e: Event) => this._setDraftProject((e.target as HTMLInputElement).value)}
          />`
        : nothing}
    </label>`;
  }

  private _toggleStatusFilter(status: BacklogStatus) {
    const next = new Set(this._statuses);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    this._statuses = next;
    this._writeUrlState();
  }

  private _setSlotSelectorOpen(open: boolean) {
    this._slotSelectorOpen = open;
    this._writeUrlState();
  }

  private _setDispatchConfigOpen(open: boolean) {
    this._dispatchConfigOpen = open;
    this._dispatchConfigError = '';
    this._writeUrlState();
    const item = this._selectedItem;
    if (open && item) {
      void this._ensureDispatchConfigData(item).catch((error) => {
        this._dispatchConfigError = error instanceof Error ? error.message : String(error);
      });
    }
  }

  private _setSpecViewerOpen(open: boolean) {
    this._specViewerOpen = open;
    this._writeUrlState();
    const item = this._selectedItem;
    if (open && item) void this._loadSpec(item);
  }

  private async _loadSpec(item: BacklogItem) {
    if (!item.specPath || this._specContents[item.id] || this._specLoadingItemId === item.id)
      return;
    this._specLoadingItemId = item.id;
    this._specErrors = { ...this._specErrors, [item.id]: '' };
    try {
      const result = await gateway.request<BacklogSpecGetResult>(Methods.BACKLOG_SPEC_GET, {
        itemId: item.id,
      });
      this._specContents = { ...this._specContents, [item.id]: result };
    } catch (error) {
      this._specErrors = {
        ...this._specErrors,
        [item.id]: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this._specLoadingItemId = '';
    }
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
    return this._sortFilteredCandidates(this._filteredCandidates, this._linkedActivityRuns());
  }

  private get _filteredCandidates(): BacklogItem[] {
    const linkedRuns = this._linkedActivityRuns();
    return this._projectFiltered.filter((item) =>
      backlogItemMatchesStatusFilter(
        displayedBacklogStatus(item, linkedRuns.get(item.id)),
        this._statuses,
      ),
    );
  }

  private _sortFilteredCandidates(
    items: BacklogItem[],
    linkedRuns: ReadonlyMap<string, Run | undefined>,
  ): BacklogItem[] {
    return sortBacklogItems(items, this._runs, this._sortKey, this._sortDirection, linkedRuns);
  }

  private _linkedActivityRuns(): ReadonlyMap<string, Run | undefined> {
    if (this._activityCacheItems === this._items && this._activityCacheRuns === this._runs) {
      return this._activityCache;
    }
    this._activityCacheItems = this._items;
    this._activityCacheRuns = this._runs;
    this._activityCache = linkedRunsForBacklogItems(this._runs, this._items, {
      allowSourceRefInference: true,
    });
    return this._activityCache;
  }

  private get _projectFiltered(): BacklogItem[] {
    const globalProjects = new Set(this._globalFilters.projects);
    return this._items.filter((item) => {
      if (this._project === 'all' && globalProjects.size > 0 && !globalProjects.has(item.project)) {
        return false;
      }
      return this._project === 'all' || item.project === this._project;
    });
  }

  private get _statusLabels(): Partial<Record<BacklogStatus, string>> {
    const counts = backlogStatusCounts(this._projectFiltered, this._linkedActivityRuns());
    return Object.fromEntries(
      BACKLOG_STATUSES.map((status) => [status, `${status} (${counts[status]})`]),
    );
  }

  private _setSort(key: BacklogSortKey): void {
    const next = nextSortState({ key: this._sortKey, direction: this._sortDirection }, key, (k) =>
      k === 'activity' || k === 'updated' ? 'desc' : 'asc',
    );
    this._sortKey = next.key;
    this._sortDirection = next.direction;
    this._writeUrlState();
  }

  private get _selectedItem(): BacklogItem | null {
    return this._items.find((item) => item.id === this._selectedItemId) ?? null;
  }

  private _cleanupConfirmId(kind: 'archive' | 'delete', itemId: string): string {
    return `backlog-${kind}:${itemId}`;
  }

  private _isCleanupConfirming(kind: 'archive' | 'delete', itemId: string): boolean {
    return this._pendingConfirm === this._cleanupConfirmId(kind, itemId);
  }

  private _confirmCleanupLabel(
    kind: 'archive' | 'delete',
    itemId: string,
    normal: string,
    pending: string,
  ): string {
    return this._isCleanupConfirming(kind, itemId) ? pending : normal;
  }

  private _confirmCleanupClass(kind: 'archive' | 'delete', itemId: string, base: string): string {
    return `${base} ${this._isCleanupConfirming(kind, itemId) ? 'confirming' : ''}`.trim();
  }

  private _requestArchive(item: BacklogItem): void {
    this._confirmTimer.confirm(
      this._cleanupConfirmId('archive', item.id),
      () => void this._archiveItem(item),
    );
  }

  private _requestDelete(item: BacklogItem): void {
    this._confirmTimer.confirm(
      this._cleanupConfirmId('delete', item.id),
      () => void this._deleteItem(item),
    );
  }

  private _selectItem(item: BacklogItem, mode: BacklogDetailMode = 'view') {
    if (this._selectedItemId !== item.id) {
      this._confirmTimer.clear();
      this._dispatchConfigOpen = false;
      this._specViewerOpen = false;
    }
    this._selectedItemId = item.id;
    this._selectedItemMode = mode;
    this._forceInventoryList = false;
    this._writeUrlState();
  }

  private _backToInventoryList() {
    this._forceInventoryList = true;
    this.requestUpdate();
  }

  private _setSelectedItemMode(mode: BacklogDetailMode) {
    this._selectedItemMode = mode;
    this._writeUrlState();
  }

  private _slotOptions(project: string): SlotStatus[] {
    return this._slots
      .filter((slot) => slot.project === project)
      .sort((a, b) => a.slot.localeCompare(b.slot));
  }

  private _dispatchSlotOptions(item: BacklogItem): SlotStatus[] {
    return filterSlotsByGlobalFilters(this._slots, this._globalFilters)
      .filter((slot) => slot.project === item.project)
      .sort((a, b) => a.machine.localeCompare(b.machine) || a.slot.localeCompare(b.slot));
  }

  private _templateOptionsForItem(item: BacklogItem): WorkerTemplateOption[] {
    return (
      this._configTemplateOptions[templateOptionsRequestKey(item.project, item.flowType)] ?? []
    );
  }

  private _templateOptionsStateForItem(item: BacklogItem): { loading: boolean; error: string } {
    const key = templateOptionsRequestKey(item.project, item.flowType);
    return {
      loading: this._configTemplateOptionsLoading[key] ?? false,
      error: this._configTemplateOptionsError[key] ?? '',
    };
  }

  private async _ensureDispatchConfigData(item: BacklogItem): Promise<void> {
    if (this._configProjectConfigs.length === 0) {
      const result = await gateway.request<ConfigProjectsResult>(Methods.CONFIG_PROJECTS, {});
      this._configProjectConfigs = result.projects;
    }

    const key = templateOptionsRequestKey(item.project, item.flowType);
    if (this._configTemplateOptions[key] || this._configTemplateOptionsLoading[key]) return;
    this._configTemplateOptionsLoading = { ...this._configTemplateOptionsLoading, [key]: true };
    this._configTemplateOptionsError = { ...this._configTemplateOptionsError, [key]: '' };
    try {
      const result = await gateway.request<ConfigTemplateOptionsResult>(
        Methods.CONFIG_TEMPLATE_OPTIONS,
        {
          project: item.project,
          flowType: item.flowType,
        },
      );
      this._configTemplateOptions = { ...this._configTemplateOptions, [key]: result.options };
    } catch (error) {
      this._configTemplateOptionsError = {
        ...this._configTemplateOptionsError,
        [key]: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this._configTemplateOptionsLoading = { ...this._configTemplateOptionsLoading, [key]: false };
    }
  }

  private async _updateDispatchConfig(item: BacklogItem, patch: BacklogUpdateInput): Promise<void> {
    this._dispatchConfigBusy = item.id;
    this._dispatchConfigError = '';
    try {
      await gateway.request<BacklogUpdateResult>(Methods.BACKLOG_UPDATE, {
        itemId: item.id,
        ...patch,
      });
    } catch (error) {
      this._dispatchConfigError = error instanceof Error ? error.message : String(error);
    } finally {
      this._dispatchConfigBusy = '';
    }
  }

  private _updateDispatchConfigFromEditor(
    item: BacklogItem,
    detail: DispatchConfigChangeDetail,
  ): Promise<void> {
    const {
      taskTemplateFileName: _taskTemplateFileName,
      skipPrepare: _skipPrepare,
      ...backlogPatch
    } = detail;
    return this._updateDispatchConfig(item, backlogPatch);
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
        Choose
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

  private _renderDispatchConfigSummary(item: BacklogItem, compact = false, force = false) {
    const summary = summarizeBacklogDispatchConfig(item);
    if (!summary.visible && !force) return nothing;
    const chips = compact
      ? summary.chips.filter((chip) => chip.label !== 'default effort').slice(0, 4)
      : summary.chips;
    const meta = compact ? summary.meta.filter((entry) => entry.label === 'Slots') : summary.meta;
    return html`<div class="dispatch-config-summary" data-testid="backlog-dispatch-config-summary">
      <div class="dispatch-config-head">
        <div class="field-label">Dispatch config</div>
        ${compact
          ? nothing
          : html`<button
              class="secondary"
              type="button"
              ?disabled=${this._dispatchConfigBusy === item.id}
              @click=${() => this._setDispatchConfigOpen(true)}
            >
              Edit dispatch config
            </button>`}
      </div>
      <div class="dispatch-chip-row">
        ${chips.map(
          (chip) =>
            html`<span
              class="dispatch-chip ${chip.tone === 'default' ? '' : chip.tone}"
              title=${chip.title ?? chip.label}
              >${chip.label}</span
            >`,
        )}
      </div>
      ${meta.length
        ? html`<div class="dispatch-meta-grid">
            ${meta.map(
              (entry) =>
                html`<div class="dispatch-meta-cell">
                  <div class="dispatch-meta-label">${entry.label}</div>
                  <div class="dispatch-meta-value">${entry.value}</div>
                </div>`,
            )}
          </div>`
        : nothing}
      ${!compact && summary.reviewSteps.length
        ? html`<div class="dispatch-meta-cell">
            <div class="dispatch-meta-label">Review pipeline</div>
            <div class="dispatch-review-pipeline">
              ${summary.reviewSteps.map(
                (step) =>
                  html`<span
                    class="dispatch-review-segment"
                    title=${`${step.label}: ${step.runner}${step.detail ? ` / ${step.detail}` : ''}`}
                  ></span>`,
              )}
              <span class="dispatch-review-label">
                ${summary.reviewSteps
                  .map((step) => `${step.runner}${step.detail ? ` / ${step.detail}` : ''}`)
                  .join(' -> ')}
              </span>
            </div>
          </div>`
        : nothing}
    </div>`;
  }

  private _renderDispatchConfigModal(item: BacklogItem) {
    if (!this._dispatchConfigOpen) return nothing;
    const disabled = this._dispatchConfigBusy === item.id;
    const templateState = this._templateOptionsStateForItem(item);
    return html`
      <div
        class="modal-backdrop"
        @click=${(event: MouseEvent) => {
          if (event.target === event.currentTarget) this._setDispatchConfigOpen(false);
        }}
      >
        <section
          class="dispatch-config-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Edit backlog dispatch config"
        >
          <header>
            <div>
              <h3>Dispatch config</h3>
              <p class="muted">
                Edits save to this backlog item and are used from Work Graphs too.
              </p>
            </div>
            <button
              class="secondary"
              type="button"
              @click=${() => this._setDispatchConfigOpen(false)}
            >
              Close
            </button>
          </header>
          ${this._dispatchConfigError
            ? html`<div class="error">${this._dispatchConfigError}</div>`
            : nothing}
          <dispatch-config-editor
            .project=${item.project}
            .flowType=${item.flowType}
            .runner=${item.runner ?? ''}
            .model=${item.model ?? ''}
            .effort=${item.effort ?? ''}
            .mode=${item.mode ?? ''}
            .devInteractiveProfile=${item.devInteractiveProfile ?? ''}
            .taskTemplate=${item.taskTemplate ?? null}
            .templateOptions=${this._templateOptionsForItem(item)}
            .prepareProfile=${item.prepareProfile ?? ''}
            .prepareProfiles=${projectPrepareProfiles(this._configProjectConfigs, item.project)}
            .pendingReviewPlan=${item.pendingReviewPlan ?? []}
            .controls=${BACKLOG_DISPATCH_CONFIG_CONTROLS}
            .disabled=${disabled}
            @dispatch-config-change=${(event: CustomEvent<DispatchConfigChangeDetail>) =>
              this._updateDispatchConfigFromEditor(item, event.detail)}
          ></dispatch-config-editor>
          ${templateState.loading
            ? html`<div class="muted">Loading task templates...</div>`
            : nothing}
          ${templateState.error ? html`<div class="error">${templateState.error}</div>` : nothing}
          <div class="config-grid">
            <label class="config-field">
              <span>Priority</span>
              <input
                type="number"
                min="1"
                .value=${String(item.priority)}
                ?disabled=${disabled}
                @change=${(event: Event) =>
                  this._updateDispatchConfig(item, {
                    priority: Number((event.target as HTMLInputElement).value),
                  })}
              />
            </label>
            <label class="config-check">
              <input
                type="checkbox"
                .checked=${item.autoDispatch !== false}
                ?disabled=${disabled}
                @change=${(event: Event) =>
                  this._updateDispatchConfig(item, {
                    autoDispatch: (event.target as HTMLInputElement).checked,
                  })}
              />
              <span>
                Dispatch when ready
                <small>
                  Graph-linked items use this when dependencies are satisfied. Standalone backlog
                  items still enter the dispatch queue from the Dispatch button.
                </small>
              </span>
            </label>
          </div>
          <div class="slot-picker">
            <div>
              <div class="field-label">Allowed slots</div>
              <div class="muted">Filtered by the global project and machine selectors.</div>
            </div>
            <slot-choice-list
              .project=${item.project}
              .slots=${this._dispatchSlotOptions(item)}
              .selectedSlots=${item.allowedSlots ?? []}
              .disabled=${disabled}
              @slot-choice-change=${(event: CustomEvent<SlotChoiceChangeDetail>) =>
                this._updateDispatchConfig(item, { allowedSlots: event.detail.allowedSlots })}
            ></slot-choice-list>
          </div>
        </section>
      </div>
    `;
  }

  private _renderSpecAttachment(item: BacklogItem) {
    if (!item.specPath) return nothing;
    const spec = this._specContents[item.id];
    const error = this._specErrors[item.id];
    const loading = this._specLoadingItemId === item.id;
    return html`
      <button class="spec-attachment" type="button" @click=${() => this._setSpecViewerOpen(true)}>
        <div class="spec-attachment-main">
          <div class="field-label">Task spec</div>
          <div class="spec-path">${item.specPath}</div>
          ${error ? html`<div class="error">${error}</div>` : nothing}
        </div>
        <div class="badges">
          ${renderPlanningBadge('View', 'positive')}
          ${renderPlanningBadge(
            spec ? `hash ${spec.hash.slice(0, 8)}` : loading ? 'loading' : 'attached',
          )}
        </div>
      </button>
    `;
  }

  private _renderSpecViewerModal(item: BacklogItem) {
    if (!this._specViewerOpen || !item.specPath) return nothing;
    const spec = this._specContents[item.id];
    const error = this._specErrors[item.id];
    const loading = this._specLoadingItemId === item.id;
    return html`
      <div
        class="modal-backdrop"
        @click=${(event: MouseEvent) => {
          if (event.target === event.currentTarget) this._setSpecViewerOpen(false);
        }}
      >
        <section
          class="dispatch-config-modal"
          role="dialog"
          aria-modal="true"
          aria-label="View backlog task spec"
        >
          <header>
            <div>
              <h3>Task spec</h3>
              <p class="muted">${item.title}</p>
              <p class="spec-path">${item.specPath}</p>
            </div>
            <button class="secondary" type="button" @click=${() => this._setSpecViewerOpen(false)}>
              Close
            </button>
          </header>
          ${renderChoiceButtons({
            options: ['markdown', 'raw'] satisfies BacklogSpecViewerMode[],
            value: this._specViewerMode,
            onSelect: (mode) => {
              this._specViewerMode = mode;
            },
            labels: { markdown: 'Markdown', raw: 'Raw' },
            testId: 'backlog-spec-view-mode',
          })}
          ${loading ? html`<div class="muted">Loading spec...</div>` : nothing}
          ${error ? html`<div class="error">${error}</div>` : nothing}
          ${spec
            ? this._specViewerMode === 'markdown'
              ? html`<div class="spec-markdown">
                  ${unsafeHTML(renderMarkdown(this._specMarkdownBody(spec.content)))}
                </div>`
              : html`<pre class="spec-raw">${spec.content}</pre>`
            : nothing}
        </section>
      </div>
    `;
  }

  private _specMarkdownBody(content: string): string {
    return content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  }

  private _draftTitleForSubmit(): string {
    const explicitTitle = this._draftTitle.trim();
    if (explicitTitle) return explicitTitle;
    const sourceRef = this._draftSourceRef.trim();
    if (sourceRef) return sourceRef;
    return (
      this._draftNotes
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean)
        ?.slice(0, 120) ?? ''
    );
  }

  private async _createItem(event: Event) {
    event.preventDefault();
    this._error = '';
    this._message = '';
    if (!this._draftProject) {
      this._error = 'Select a project before creating a backlog item.';
      return;
    }
    const title = this._draftTitleForSubmit();
    if (!title) {
      this._error = 'Add a Jira/GitHub ref, a title, or notes before creating a backlog item.';
      return;
    }
    this._busy = 'create';
    try {
      await gateway.request<BacklogCreateResult>(Methods.BACKLOG_CREATE, {
        project: this._draftProject,
        title,
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
      this._setCreatePanelOpen(false);
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
    if (item.workGraphId) {
      await this._runItemAction(item.id, 'dispatch via graph', async () => {
        const linkedGraph = this._workGraphs.find(
          (candidate) => candidate.graph.id === item.workGraphId,
        );
        if (linkedGraph?.graph.status === 'paused') {
          return 'Graph is paused. Resume it in WorkGraph before dispatching this item.';
        }
        if (linkedGraph?.graph.status === 'planning') {
          await gateway.request<WorkGraphActivateResult>(Methods.WORK_GRAPH_ACTIVATE, {
            graphId: item.workGraphId,
          });
          return this._graphSchedulerMessage(
            item,
            await gateway.request<WorkGraphSchedulerTickResult>(Methods.WORK_GRAPH_SCHEDULER_TICK, {
              graphId: item.workGraphId,
              forceEnqueue: true,
            }),
            'Graph activated. ',
          );
        }
        return this._graphSchedulerMessage(
          item,
          await gateway.request<WorkGraphSchedulerTickResult>(Methods.WORK_GRAPH_SCHEDULER_TICK, {
            graphId: item.workGraphId,
            forceEnqueue: true,
          }),
        );
      });
      return;
    }
    await this._runItemAction(item.id, 'enqueue', () =>
      gateway.request<BacklogEnqueueResult>(Methods.BACKLOG_ENQUEUE, { itemId: item.id }),
    );
  }

  private async _dequeue(item: BacklogItem) {
    await this._runItemAction(item.id, 'dequeue', () =>
      gateway.request<BacklogDequeueResult>(Methods.BACKLOG_DEQUEUE, { itemId: item.id }),
    );
  }

  private async _archiveItem(item: BacklogItem) {
    await this._runItemAction(item.id, 'archive', () =>
      gateway.request<BacklogArchiveResult>(Methods.BACKLOG_ARCHIVE, { itemId: item.id }),
    );
    this._confirmTimer.clear();
  }

  private async _deleteItem(item: BacklogItem) {
    await this._runItemAction(item.id, 'delete', () =>
      gateway.request<BacklogDeleteResult>(Methods.BACKLOG_DELETE, { itemId: item.id }),
    );
    this._confirmTimer.clear();
    if (this._selectedItemId === item.id) {
      this._selectedItemId = '';
      this._selectedItemMode = 'view';
      this._writeUrlState();
    }
    const { [item.id]: _notes, ...remainingNotes } = this._notesDrafts;
    const { [item.id]: _launchPlan, ...remainingLaunchPlans } = this._launchDrafts;
    this._notesDrafts = remainingNotes;
    this._launchDrafts = remainingLaunchPlans;
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

  private _notesDirty(item: BacklogItem): boolean {
    return (
      this._notesDrafts[item.id] !== undefined && this._notesDrafts[item.id] !== (item.notes ?? '')
    );
  }

  private _launchPlanDirty(item: BacklogItem): boolean {
    if (!this._launchDrafts[item.id]) return false;
    const draftPlan = this._launchPlanFromDraft(item.id, item) ?? null;
    return JSON.stringify(draftPlan) !== JSON.stringify(item.launchPlan ?? null);
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
      const result = await action();
      this._message = typeof result === 'string' && result.trim() ? result : `${label} complete`;
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._busy = '';
    }
  }

  private _graphSchedulerMessage(
    item: BacklogItem,
    result: WorkGraphSchedulerTickResult,
    prefix = '',
  ): string {
    const graph =
      result.graphs.find((candidate) => candidate.graph.id === item.workGraphId) ??
      this._workGraphs.find((candidate) => candidate.graph.id === item.workGraphId);
    if (!graph) {
      return 'Graph scheduler did not run this item. Open the linked WorkGraph and activate it if it is still planning or paused.';
    }
    if (result.graphs.every((candidate) => candidate.graph.id !== item.workGraphId)) {
      if (graph.graph.status === 'planning') {
        return 'Graph is still planning. Activate it in WorkGraph, then dispatch this item.';
      }
      if (graph.graph.status === 'paused') {
        return 'Graph is paused. Resume it in WorkGraph before dispatching this item.';
      }
    }
    const node = graph.nodes.find((candidate) => candidate.id === item.workNodeId);
    if (!node) return 'Graph scheduler ran, but the linked node was not found in the WorkGraph.';
    if (node.status === 'planned') {
      return `${prefix}Graph is still planning. Activate it in WorkGraph, then dispatch this item.`;
    }
    if (node.status === 'queued') {
      return `${prefix}Queued for launch. The dispatch queue will start it on an eligible slot.`;
    }
    if (node.status === 'running')
      return `${prefix}Dispatch active: the graph node is already running.`;
    if (node.status === 'waiting') {
      const reason = node.waitingOn[0]?.detail;
      return reason
        ? `${prefix}Not queued yet: waiting on ${reason}.`
        : `${prefix}Not queued yet: the graph node is still waiting on upstream work.`;
    }
    if (node.status === 'needs-attention') {
      const reason = node.waitingOn[0]?.detail;
      return reason
        ? `${prefix}Graph needs attention: ${reason}.`
        : `${prefix}Graph needs attention before this item can be queued.`;
    }
    if (node.status === 'ready') {
      if (item.lastDispatchError) {
        return `${prefix}Ready, but enqueue failed: ${item.lastDispatchError}`;
      }
      if (item.autoDispatch === false) {
        return `${prefix}Ready with auto start off. Manual Dispatch should still enqueue — if it did not, check allowed slots and retry.`;
      }
      return `${prefix}Ready, but not queued. Review slots and dispatch config.`;
    }
    if (node.status === 'succeeded') {
      // Not a dispatch confirmation: nothing was started. The node keeps this
      // status after its run finishes — or after that run is deleted — so a
      // redispatch silently does nothing until the node is reset.
      return `${prefix}No run started: the graph node already succeeded. Reset it in the WorkGraph to run this item again.`;
    }
    if (node.status === 'failed') {
      return `${prefix}No run started: the graph node is failed. Reset or retry it in the WorkGraph.`;
    }
    return `${prefix}No run started: the graph node is ${node.status}. Open the WorkGraph for details.`;
  }

  private _workGraphHash(item: BacklogItem): string {
    const { params: current } = parseHashRoute();
    const params = new URLSearchParams();
    for (const key of ['projects', 'machines']) {
      const value = current.get(key);
      if (value) params.set(key, value);
    }
    if (item.workGraphId) params.set('graph', item.workGraphId);
    if (item.workNodeId) params.set('node', item.workNodeId);
    return buildHash('work-graphs', params);
  }

  private _dispatchHash(item?: BacklogItem): string {
    const { params: current } = parseHashRoute();
    const params = new URLSearchParams();
    for (const key of ['projects', 'machines']) {
      const value = current.get(key);
      if (value) params.set(key, value);
    }
    if (item?.project && !params.get('projects')) params.set('projects', item.project);
    return buildHash('dispatch', params);
  }

  private _renderCreateForm() {
    const slotOptions = this._slotOptions(this._draftProject);
    const selectedSlots = this._allowedSlotsFromDraft() ?? [];
    const canCreate = Boolean(this._draftProject && this._draftTitleForSubmit());
    return html`<form @submit=${this._createItem}>
      <div class="create-grid">
        <div class="wide">${this._renderProjectPicker()}</div>
        <label class="span-2">
          Source
          ${renderChoiceButtons({
            options: SOURCES,
            value: this._draftSourceKind,
            onSelect: (source) => {
              this._draftSourceKind = source;
            },
          })}
        </label>
        <label class="span-2">
          Flow
          ${renderChoiceButtons({
            options: FLOWS,
            value: this._draftFlow,
            onSelect: (flow) => {
              this._draftFlow = flow;
            },
          })}
        </label>
        <label class="wide">
          Jira / GitHub ref
          <input
            placeholder="TAT-3463, owner/repo#1, or a URL"
            .value=${this._draftSourceRef}
            @input=${(e: Event) => (this._draftSourceRef = (e.target as HTMLInputElement).value)}
          />
          <span class="meta">Used as the title when title is blank.</span>
        </label>
        <label class="wide">
          Title
          <input
            placeholder="Optional when ref or notes describe the task"
            .value=${this._draftTitle}
            @input=${(e: Event) => (this._draftTitle = (e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="wide notes-field">
          Task context markdown
          <textarea
            placeholder="Add the actual wrapping context, implementation details, acceptance criteria, links, caveats, and dispatch instructions."
            .value=${this._draftNotes}
            @input=${(e: Event) => (this._draftNotes = (e.target as HTMLTextAreaElement).value)}
          ></textarea>
          <span class="meta">Used as the title fallback when both title and ref are blank.</span>
        </label>
        <label class="span-2">
          Tags
          <input
            placeholder="roadmap, command-center"
            .value=${this._draftTags}
            @input=${(e: Event) => (this._draftTags = (e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Priority
          <input
            type="number"
            .value=${this._draftPriority}
            @input=${(e: Event) => (this._draftPriority = (e.target as HTMLInputElement).value)}
          />
        </label>
        <label title=${AUTO_DISPATCH_TOOLTIP}>
          Auto-dispatch
          <input
            type="checkbox"
            title=${AUTO_DISPATCH_TOOLTIP}
            .checked=${this._draftAutoDispatch}
            @change=${(e: Event) =>
              (this._draftAutoDispatch = (e.target as HTMLInputElement).checked)}
          />
        </label>
        <div class="slot-picker-field wide">
          <span class="field-label">Allowed slots</span>
          <div class="slot-picker-summary">
            <div class="badges">${this._renderAllowedSlotChips(selectedSlots)}</div>
            <button class="secondary" type="button" @click=${() => this._setSlotSelectorOpen(true)}>
              Choose
            </button>
          </div>
          <span class="meta">
            ${slotOptions.length} project slot${slotOptions.length === 1 ? '' : 's'} match the
            selected project.
          </span>
        </div>
      </div>
      ${this._renderLaunchPlanEditor(NEW_PLAN_KEY)}
      <div class="actions" style="margin-top: 10px;">
        <button ?disabled=${this._busy === 'create' || !canCreate}>Create</button>
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

  private _renderCreatePanel() {
    if (!this._createPanelOpen) return nothing;
    return html`<section class="create-panel" aria-label="Add backlog item">
      <header>
        <div>
          <h2>Add backlog item</h2>
          <p class="muted">Direct backlog dispatch item.</p>
        </div>
        <button class="secondary" type="button" @click=${() => this._setCreatePanelOpen(false)}>
          Close
        </button>
      </header>
      ${this._renderCreateForm()}
    </section>`;
  }

  private _renderCompactRow(item: BacklogItem, linkedRun?: Run) {
    const selected = this._selectedItemId === item.id;
    const displayedStatus = displayedBacklogStatus(item, linkedRun);
    const tone = statusTone(displayedStatus);
    const activeRun = linkedRun && !isTerminalRunStatus(linkedRun.status) ? linkedRun : undefined;
    const displayedFlow = displayedBacklogFlow(item, activeRun);
    const flowTitle =
      activeRun && displayedFlow !== item.flowType
        ? `Active run flow: ${displayedFlow}; backlog flow: ${item.flowType}`
        : undefined;
    return renderWorkInventoryRow({
      row: {
        id: item.id,
        selected,
        className: item.lastDispatchError ? 'has-error' : '',
        testId: `backlog-row-${item.sourceRef || item.id}`,
        onActivate: () => this._selectItem(item),
      },
      cells: html`
        ${renderPlanningBadge(displayedStatus, tone)}
        <span data-testid="backlog-flow"
          >${renderFlowBadge(displayedFlow, flowTitle ? { title: flowTitle } : {})}</span
        >
        <span data-testid="backlog-project">${renderPlanningBadge(item.project)}</span>
        <span class="item-ref" title=${item.sourceRef}>${item.sourceRef}</span>
        <div class="title" title=${item.title}>${item.title}</div>
        ${activeRun
          ? html`<a
              class="activity-link"
              data-testid="backlog-active-run"
              href=${`#run/${encodeURIComponent(activeRun.id)}`}
              title=${`${activeRun.status} on ${activeRun.slotId ?? 'unassigned slot'}`}
              @click=${(event: Event) => event.stopPropagation()}
            >
              ${renderPlanningBadge(activeRun.status, 'active')}
              <span class="activity-slot">${activeRun.slotId ?? activeRun.id.slice(0, 8)}</span>
            </a>`
          : html`<span class="no-activity">—</span>`}
        <span class="updated-cell" title=${item.updatedAt}>${item.updatedAt.slice(0, 10)}</span>
      `,
    });
  }

  private _renderTableHead() {
    return renderWorkInventoryTableHead({
      columns: BACKLOG_INVENTORY_COLUMNS,
      sort: { key: this._sortKey, direction: this._sortDirection },
      onSort: (key) => this._setSort(key),
      testIdPrefix: 'backlog',
    });
  }

  private _renderCleanupActions(item: BacklogItem) {
    if (!showsBacklogCleanupActionsForUi(item)) return nothing;
    const busy = this._busy.endsWith(item.id);
    return html`<div class="detail-cleanup" data-testid="backlog-cleanup-actions">
      <span class="field-label">Cleanup</span>
      <div class="actions">
        ${canArchiveBacklogItemForUi(item)
          ? html`<button
              class=${this._confirmCleanupClass('archive', item.id, 'secondary')}
              type="button"
              ?disabled=${busy}
              title="Hide from the default backlog list without deleting history"
              @click=${() => this._requestArchive(item)}
            >
              ${this._confirmCleanupLabel('archive', item.id, 'Archive', 'Archive?')}
            </button>`
          : nothing}
        ${canRestoreBacklogItemForUi(item)
          ? html`<button
              class="secondary"
              type="button"
              ?disabled=${busy}
              title="Return this item to ready for another dispatch"
              @click=${() => this._markReady(item)}
            >
              Restore to ready
            </button>`
          : nothing}
        ${canDeleteBacklogItemForUi(item)
          ? html`<button
              class=${this._confirmCleanupClass('delete', item.id, 'danger')}
              type="button"
              ?disabled=${busy}
              title=${item.workGraphId
                ? 'Detach from the work graph before deleting'
                : 'Permanently remove this backlog item'}
              @click=${() => this._requestDelete(item)}
            >
              ${this._confirmCleanupLabel('delete', item.id, 'Delete', 'Delete?')}
            </button>`
          : nothing}
      </div>
    </div>`;
  }

  private _renderItemActionButtons(item: BacklogItem, mode: BacklogDetailMode) {
    const showEditDelete =
      mode === 'edit' && !showsBacklogCleanupActionsForUi(item) && canDeleteBacklogItemForUi(item);
    const hideDispatchActions = item.status === 'done' || item.status === 'archived';
    const editActions =
      mode === 'edit'
        ? html`<button
              class="secondary"
              ?disabled=${this._busy.endsWith(item.id) || !this._notesDirty(item)}
              @click=${() => this._saveNotes(item)}
            >
              Save notes
            </button>
            <button
              class="secondary"
              ?disabled=${this._busy.endsWith(item.id) || !this._launchPlanDirty(item)}
              @click=${() => this._saveLaunchPlan(item)}
            >
              Save launch plan
            </button>
            ${showEditDelete
              ? html`<button
                  class=${this._confirmCleanupClass('delete', item.id, 'danger')}
                  ?disabled=${this._busy.endsWith(item.id)}
                  @click=${() => this._requestDelete(item)}
                >
                  ${this._confirmCleanupLabel('delete', item.id, 'Delete', 'Delete?')}
                </button>`
              : nothing}`
        : nothing;
    if (hideDispatchActions) {
      return editActions === nothing ? nothing : html`<div class="actions">${editActions}</div>`;
    }
    return html`<div class="actions">
      ${editActions}
      ${canMarkReadyBacklogItemForUi(item)
        ? html`<button
            ?disabled=${this._busy.endsWith(item.id)}
            @click=${() => this._markReady(item)}
          >
            Mark ready
          </button>`
        : html`<span class=${`action-state ${item.status === 'ready' ? 'ready' : ''}`}
            >${item.status === 'ready' ? 'Ready' : item.status}</span
          >`}
      <button
        class="primary-action"
        ?disabled=${item.status !== 'ready' || this._busy.endsWith(item.id)}
        @click=${() => this._enqueue(item)}
        title=${item.workGraphId
          ? 'Dispatch this linked backlog item through its WorkGraph so dependency state and graph run metadata stay intact.'
          : 'Enqueue this ready backlog item directly.'}
      >
        ${item.workGraphId ? 'Dispatch' : 'Enqueue'}
      </button>
      <button
        class="secondary"
        ?disabled=${!canDequeueBacklogItemForUi(item) || this._busy.endsWith(item.id)}
        @click=${() => this._dequeue(item)}
      >
        Dequeue
      </button>
      ${canDequeueBacklogItemForUi(item)
        ? html`<a class="badge-link" href=${this._dispatchHash(item)}>Open dispatch queue</a>`
        : nothing}
    </div>`;
  }

  private _renderSelectedItemPanel() {
    const item = this._selectedItem;
    if (!item) {
      return html`<section class="detail-panel empty-detail" aria-label="Selected backlog item">
        <header>
          <div>
            <h2>No item selected</h2>
            <p class="muted">
              Select a backlog item to review its spec, dispatch config, notes, and actions.
            </p>
          </div>
        </header>
      </section>`;
    }
    const notesValue = this._notesDrafts[item.id] ?? item.notes ?? '';
    const mode = this._selectedItemMode;
    return html`<section class="detail-panel" aria-label="Selected backlog item">
      <header class="detail-top">
        <div class="detail-title-row">
          <h2>${item.title}</h2>
          <button
            class="secondary detail-edit"
            type="button"
            @click=${() => this._setSelectedItemMode(mode === 'edit' ? 'view' : 'edit')}
          >
            ${mode === 'edit' ? 'Done' : 'Edit'}
          </button>
        </div>
        <p class="muted detail-meta">
          <strong class="item-ref">${item.sourceRef}</strong> · ${item.project} · ${item.flowType} ·
          ${item.sourceKind}
        </p>
        <div class="detail-badges">
          ${renderPlanningBadge(
            item.status,
            item.status === 'ready'
              ? 'positive'
              : item.status === 'failed' || item.status === 'needs-attention'
                ? 'danger'
                : 'default',
          )}${renderPlanningBadge(`p${item.priority}`)}${renderPlanningBadge(
            slotsText(item),
          )}${renderTagChips(item.tags)}${item.workGraphId
            ? html`<a class="badge-link" href=${this._workGraphHash(item)}
                >graph ${item.workGraphId}</a
              >`
            : nothing}
        </div>
      </header>
      ${this._renderCleanupActions(item)}
      ${item.lastDispatchError ? html`<div class="error">${item.lastDispatchError}</div>` : nothing}
      <linked-run-summary
        .run=${linkedRunForBacklogItem(this._runs, item)}
        label="Linked run"
      ></linked-run-summary>
      ${this._renderSpecAttachment(item)} ${this._renderLaunchPlanSummary(item)}
      ${this._renderDispatchConfigSummary(item, false, true)}
      ${mode === 'edit' ? this._renderLaunchPlanEditor(item.id, item) : nothing}
      ${mode === 'edit'
        ? html`<label
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
          </label>`
        : html`<div>
            <div class="field-label">Agent notes</div>
            <pre class="notes-view">${notesValue || 'No notes.'}</pre>
          </div>`}
      ${this._renderItemActionButtons(item, mode)} ${this._renderSpecViewerModal(item)}
    </section>`;
  }

  private _renderFilterToolbar(filteredCount: number) {
    const globalProjectScope =
      this._globalFilters.projects.length === 0
        ? 'All projects'
        : this._globalFilters.projects.join(', ');
    const globalMachineScope =
      this._globalFilters.machines.length === 0
        ? 'All nodes'
        : this._globalFilters.machines.join(', ');
    return html`<div class="filter-toolbar" data-testid="backlog-filter-toolbar">
      <div class="filter-toolbar-top">
        <div class="filter-toolbar-actions">
          <button type="button" @click=${() => this._setCreatePanelOpen(!this._createPanelOpen)}>
            ${this._createPanelOpen ? 'Hide form' : 'New item'}
          </button>
          <button
            class="secondary"
            type="button"
            title=${AUTO_DISPATCH_TOOLTIP}
            ?disabled=${this._busy === 'auto'}
            @click=${this._autoDispatch}
          >
            Auto-dispatch
          </button>
        </div>
        <div class="filter-count" title=${`${globalProjectScope} · ${globalMachineScope}`}>
          ${filteredCount} / ${this._items.length} items
        </div>
      </div>
      <div class="filter-groups">
        <div class="filter-group">
          <span class="field-label">Project</span>
          ${renderChoiceButtons({
            options: ['all', ...this._projects],
            value: this._project,
            onSelect: (project) => this._setProjectFilter(project),
            labels: { all: 'All' },
            testId: 'backlog-project-filter',
          })}
        </div>
        <div class="filter-group">
          <span class="field-label">Status</span>
          ${renderToggleChips({
            options: BACKLOG_STATUSES,
            selected: [...this._statuses],
            onToggle: (status) => this._toggleStatusFilter(status),
            labels: this._statusLabels,
            testId: 'backlog-status-filter',
          })}
        </div>
      </div>
    </div>`;
  }

  render() {
    const hasDetail = Boolean(this._selectedItem);
    const candidates = this._filteredCandidates;
    const activityRuns = this._linkedActivityRuns();
    const filtered = this._sortFilteredCandidates(candidates, activityRuns);
    const layout = {
      hasSelection: hasDetail,
      narrowViewport: this._narrowViewport,
      forceList: this._forceInventoryList,
    };
    const showList = inventoryShowsList(layout);
    const showDetail = inventoryShowsDetail(layout);
    const list = html`<section class="list-panel">
      <div class="scroll-column rows">
        ${renderWorkInventoryTable({
          columns: BACKLOG_INVENTORY_COLUMNS,
          head: this._renderTableHead(),
          rows: filtered.map((item) => this._renderCompactRow(item, activityRuns.get(item.id))),
          isEmpty: filtered.length === 0,
          empty: html`<div class="empty">No backlog items match this view.</div>`,
          testId: 'work-inventory-table',
          minWidth: '1040px',
        })}
      </div>
    </section>`;
    const detail = html`${inventoryShowsBackAffordance(layout)
      ? renderWorkInventoryBackButton({
          testId: 'work-inventory-back',
          onBack: () => this._backToInventoryList(),
        })
      : nothing}${this._renderSelectedItemPanel()}`;
    return html`<section class="shell">
      <div class="header header-compact">
        <h1>Backlog</h1>
        <span class="muted">Jira/GitHub/manual intake before dispatch</span>
      </div>
      ${this._error ? html`<div class="error">${this._error}</div>` : nothing}
      ${this._message ? html`<div class="message">${this._message}</div>` : nothing}
      ${this._renderFilterToolbar(filtered.length)} ${this._renderCreatePanel()}
      ${renderWorkInventoryLayout({
        list,
        detail,
        showList,
        showDetail,
        testId: 'work-inventory-layout',
      })}
      ${this._renderLaunchSlotSelectorModal()}
      ${this._selectedItem ? this._renderDispatchConfigModal(this._selectedItem) : nothing}
    </section>`;
  }
}
