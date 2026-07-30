import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type {
  BacklogItem,
  RoadmapItem,
  RoadmapItemStage,
  RoadmapListResult,
  RoadmapPromoteResult,
  RoadmapPromotionDraftGetResult,
  RoadmapPromotionDraftListResult,
  RoadmapPromotionDraftSaveResult,
  RoadmapPromptGetResult,
  RoadmapRefinementSessionGetResult,
  RoadmapRefineResult,
  RoadmapSaveResult,
  Run,
  SafetyTier,
  SlotStatus,
  WorkGraphProjection,
} from '@farmslot/protocol';
import {
  DEFAULT_ROADMAP_REFINEMENT_MODEL,
  DEFAULT_ROADMAP_REFINEMENT_RUNNER,
  isConcreteRoadmapProject,
  Methods,
  ROADMAP_GLOBAL_PROJECT,
  ROADMAP_ITEM_STAGES,
  ROADMAP_UNASSIGNED_PROJECT,
} from '@farmslot/protocol';

import './roadmap-graph-composer.js';
import '../shared/linked-run-summary.js';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, type GlobalFilters, subscribe } from '../../state.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { renderMarkdown } from '../../utils/markdown.js';
import {
  DEFAULT_MODEL,
  modelForRunnerChange,
  modelsForRunner,
  RUNNER_OPTIONS,
} from '../../utils/runner-options.js';
import { buildHash, parseHashRoute } from '../../utils/url-state.js';
import { linkedRunForBacklogItem } from '../shared/linked-run-model.js';
import {
  planningBadgeStyles,
  renderPlanningBadge,
  renderTagChips,
  statusTone,
  tagsFromInput,
  tagsToInput,
} from '../shared/planning-badges.js';
import {
  planningChoiceStyles,
  renderChoiceButtons,
  renderToggleChips,
} from '../shared/planning-controls.js';
import {
  concretePlanningProjects,
  syncedDraftProject,
  syncedDraftTargetProjects,
} from '../shared/planning-projects.js';
import { encodeWorkerRouteParam } from '../terminal/split-view-model.js';

import {
  defaultSpecBody,
  filterRoadmapItemsByGlobalProjects,
  parsePromotionDraftAttachment,
  parsePromotionDraftsFromRoadmapBody,
  type PromotionDraft,
  type PromotionDraftAttachment,
  promotionDraftAttachment,
  promotionDraftsFromRoadmapItem,
  type RoadmapSortDirection,
  type RoadmapSortKey,
  sortRoadmapItems,
} from './roadmap-panel-model.js';

const STAGES: Array<RoadmapItemStage | 'all'> = ['all', ...ROADMAP_ITEM_STAGES];
const CUSTOM_PROJECT = '__custom__';
const DEFAULT_REFINEMENT_CHOICE = '__default__';
const CUSTOM_REFINEMENT_CHOICE = '__custom__';
const SAFETY_TIERS: SafetyTier[] = ['sandboxed', 'full-auto', 'dangerous'];
const ROADMAP_ITEM_PARAM = 'item';
const ROADMAP_MODE_PARAM = 'mode';
const ROADMAP_RUNNER_PICKER_PARAM = 'runnerPicker';
const ROADMAP_PROMOTE_PARAM = 'promote';
const ROADMAP_DRAFT_PARAM = 'draft';
const ROADMAP_DRAFT_MODE_PARAM = 'draftMode';
const ROADMAP_SORT_PARAM = 'sort';
const ROADMAP_SORT_DIRECTION_PARAM = 'direction';
const ROADMAP_SORT_KEYS: RoadmapSortKey[] = [
  'stage',
  'project',
  'id',
  'title',
  'promotion',
  'updated',
];
type RoadmapEditorMode = 'view' | 'edit';
type PromptViewerMode = 'raw' | 'markdown';
type PromotionDraftModalMode = 'view' | 'edit';
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

interface PromptPreview {
  absolutePath: string;
  content: string;
}

interface PromotionDraftAttachmentState extends PromotionDraftAttachment {
  contentHash?: string;
}

function isRoadmapRoute(route: string): boolean {
  return route === 'roadmap' || route === 'dev/roadmap';
}

@customElement('roadmap-panel')
export class RoadmapPanel extends LitElement {
  @property({ attribute: false }) items: RoadmapItem[] | null = null;
  @property({ attribute: false }) slots: SlotStatus[] | null = null;
  @property({ attribute: false }) demoRuns: Run[] | null = null;
  @state() private _allItems: RoadmapItem[] = [];
  @state() private _slots: SlotStatus[] = [];
  @state() private _backlogItems: BacklogItem[] = [];
  @state() private _runs: Run[] = [];
  @state() private _workGraphs: WorkGraphProjection[] = [];
  @state() private _globalFilters: GlobalFilters = { projects: [], machines: [] };
  @state() private _selectedId = '';
  /** The capture form used to sit permanently above the list, pushing the items
      most visits are here to read below the fold. Opened on demand instead. */
  @state() private _createPanelOpen = false;
  @state() private _filterProject = 'all';
  @state() private _filterStage: RoadmapItemStage | 'all' = 'all';
  @state() private _filterTags = '';
  @state() private _filterSearch = '';
  @state() private _includeArchived = false;
  @state() private _sortKey: RoadmapSortKey = 'updated';
  @state() private _sortDirection: RoadmapSortDirection = 'desc';
  @state() private _busy = '';
  @state() private _error = '';
  @state() private _message = '';
  @state() private _editorMode: RoadmapEditorMode = 'view';

  @state() private _newTitle = '';
  @state() private _newProject = ROADMAP_UNASSIGNED_PROJECT;
  @state() private _newTargetProjects: string[] = [];
  private _newTargetProjectsTouched = false;
  @state() private _newTags = '';
  @state() private _newBody = '';

  @state() private _editTitle = '';
  @state() private _editProject = '';
  @state() private _editTargetProjects: string[] = [];
  @state() private _editStage: RoadmapItemStage = 'rough';
  @state() private _editTags = '';
  @state() private _editBody = '';
  @state() private _editHash = '';
  @state() private _refineRunner = '';
  @state() private _refineModel = '';
  @state() private _refineCommand = '';
  @state() private _refineSafetyTier = '';
  @state() private _runnerPickerOpen = false;
  @state() private _refinementSessionLoading = '';
  @state() private _existingRefinementSession: RoadmapRefinementSessionGetResult | null = null;
  @state() private _promotionOpen = false;
  @state() private _promptPreviews: Record<string, PromptPreview> = {};
  @state() private _promptPreviewLoading = '';
  @state() private _promptViewerPath = '';
  @state() private _promptViewerMode: PromptViewerMode = 'raw';
  @state() private _promotionAttachmentViewer: PromotionDraftAttachment | null = null;
  @state() private _promotionDraftModalIndex = -1;
  @state() private _promotionDraftModalMode: PromotionDraftModalMode = 'view';
  @state() private _promotionDraftAttachments: PromotionDraftAttachmentState[] = [];
  @state() private _promotionDraftAttachmentLoading = '';

  @state() private _promotionDrafts: PromotionDraft[] = [];

  private _unsubscribeConnection?: () => void;
  private _unsubscribeState?: () => void;
  private _onHashChange = () => this._applyUrlStateFromHash();
  private _onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (this._promptViewerPath) {
      event.preventDefault();
      this._promptViewerPath = '';
      return;
    }
    if (this._promotionAttachmentViewer) {
      event.preventDefault();
      this._promotionAttachmentViewer = null;
      return;
    }
    if (this._promotionDraftModalIndex >= 0) {
      event.preventDefault();
      this._closePromotionDraftModal();
      return;
    }
    if (this._runnerPickerOpen) {
      event.preventDefault();
      this._runnerPickerOpen = false;
      this._writeUrlState();
      return;
    }
    if (this._editorMode === 'edit') {
      event.preventDefault();
      this._editorMode = 'view';
      this._writeUrlState();
    }
  };

  static styles = [
    planningBadgeStyles,
    planningChoiceStyles,
    css`
      :host {
        box-sizing: border-box;
        display: block;
        height: 100%;
        min-height: 0;
        overflow: hidden;
        color: ${unsafeCSS(colors.textPrimary)};
        font-family: ${unsafeCSS(fonts.mono)};
        padding: ${unsafeCSS(spacing.lg)};
      }
      .shell {
        display: grid;
        gap: ${unsafeCSS(spacing.md)};
        max-height: 100%;
        min-height: 0;
        overflow-y: auto;
        padding-right: 4px;
      }
      .shell::-webkit-scrollbar {
        width: 6px;
      }
      .shell::-webkit-scrollbar-thumb {
        background: ${unsafeCSS(colors.textMuted)}66;
        border-radius: 3px;
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
        grid-template-columns: minmax(640px, 1.5fr) minmax(360px, 1fr);
        gap: ${unsafeCSS(spacing.md)};
        align-items: start;
        min-height: 0;
      }
      @media (max-width: 1350px) {
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
      .filters {
        align-items: start;
      }
      .field {
        display: grid;
        gap: 4px;
        color: ${unsafeCSS(colors.textMuted)};
        font-size: ${unsafeCSS(fonts.sizeXs)};
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .full {
        grid-column: 1 / -1;
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
      textarea.idea {
        min-height: 220px;
      }
      textarea.body {
        min-height: 360px;
      }
      .body-view {
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.bgSurface)};
        color: ${unsafeCSS(colors.textPrimary)};
        font: inherit;
        line-height: 1.4;
        margin: 0;
        min-height: 240px;
        padding: ${unsafeCSS(spacing.md)};
        white-space: pre-wrap;
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
        gap: 4px;
        overflow-x: auto;
      }
      .roadmap-table {
        min-width: 820px;
      }
      .row,
      .table-head {
        align-items: center;
        display: grid;
        gap: 8px;
        grid-template-columns: 84px minmax(110px, 160px) 118px minmax(260px, 1fr) 112px 86px;
      }
      .table-head {
        background: ${unsafeCSS(colors.bgCard)};
        border-bottom: 1px solid ${unsafeCSS(colors.textMuted)}33;
        padding: 3px 8px 6px;
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .table-head button {
        background: transparent;
        border: 0;
        color: ${unsafeCSS(colors.textMuted)};
        font: inherit;
        font-size: ${unsafeCSS(fonts.sizeXs)};
        padding: 2px 0;
        text-align: left;
      }
      .table-head button.active {
        color: ${unsafeCSS(colors.textPrimary)};
      }
      .row {
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.bgSurface)};
        padding: 4px 8px;
        min-height: 28px;
        cursor: pointer;
      }
      .row .title {
        font-size: ${unsafeCSS(fonts.sizeSm)};
        font-weight: 500;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .row .item-ref {
        color: ${unsafeCSS(colors.textSecondary)};
        font-family: ${unsafeCSS(fonts.mono)};
        font-size: ${unsafeCSS(fonts.sizeXs)};
        white-space: nowrap;
      }
      .updated-cell {
        color: ${unsafeCSS(colors.textMuted)};
        font-size: ${unsafeCSS(fonts.sizeXs)};
        white-space: nowrap;
      }
      .list-toolbar {
        display: flex;
        gap: 8px;
        margin-bottom: ${unsafeCSS(spacing.sm)};
      }
      .row.selected {
        border-color: ${unsafeCSS(colors.accent)}99;
        background: ${unsafeCSS(colors.accent)}11;
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
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.bgSurface)};
        padding: ${unsafeCSS(spacing.md)};
        margin-top: ${unsafeCSS(spacing.sm)};
      }
      .promotion-review {
        border-color: ${unsafeCSS(colors.accent)}55;
        background: ${unsafeCSS(colors.accent)}0f;
      }
      .promotion-summary {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: ${unsafeCSS(spacing.sm)};
        color: ${unsafeCSS(colors.textSecondary)};
        font-size: ${unsafeCSS(fonts.sizeXs)};
        margin-top: ${unsafeCSS(spacing.sm)};
      }
      .promotion-draft-head {
        display: flex;
        justify-content: space-between;
        gap: ${unsafeCSS(spacing.sm)};
        align-items: flex-start;
      }
      .path-panel {
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.bgSurface)};
        display: grid;
        gap: ${unsafeCSS(spacing.sm)};
        padding: ${unsafeCSS(spacing.sm)};
      }
      .attachment-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: ${unsafeCSS(spacing.sm)};
        margin-top: ${unsafeCSS(spacing.md)};
      }
      .attachment-card {
        border: 1px solid ${unsafeCSS(colors.textMuted)}33;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.bgSurface)};
        display: grid;
        gap: ${unsafeCSS(spacing.sm)};
        padding: ${unsafeCSS(spacing.sm)};
        text-align: left;
      }
      .attachment-card:hover {
        border-color: ${unsafeCSS(colors.accent)}66;
        background: ${unsafeCSS(colors.accent)}0d;
      }
      .attachment-card h3 {
        margin: 0;
        overflow-wrap: anywhere;
      }
      .attachment-card p {
        color: ${unsafeCSS(colors.textMuted)};
        font-size: ${unsafeCSS(fonts.sizeXs)};
        overflow-wrap: anywhere;
      }
      .artifact-link {
        border: 1px solid ${unsafeCSS(colors.textMuted)}33;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.bgSurface)};
        color: ${unsafeCSS(colors.accent)};
        cursor: pointer;
        font-family: ${unsafeCSS(fonts.mono)};
        font-size: ${unsafeCSS(fonts.sizeXs)};
        overflow-wrap: anywhere;
        padding: 6px 8px;
        text-align: left;
      }
      .artifact-link:hover {
        border-color: ${unsafeCSS(colors.accent)}66;
        background: ${unsafeCSS(colors.accent)}11;
      }
      .prompt-preview {
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.bgSurface)};
        color: ${unsafeCSS(colors.textPrimary)};
        font: inherit;
        line-height: 1.4;
        margin: 0;
        max-height: min(66vh, 760px);
        overflow: auto;
        padding: ${unsafeCSS(spacing.md)};
        white-space: pre-wrap;
      }
      .prompt-markdown {
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.bgSurface)};
        color: ${unsafeCSS(colors.textPrimary)};
        font-size: ${unsafeCSS(fonts.sizeSm)};
        line-height: 1.55;
        max-height: min(66vh, 760px);
        overflow: auto;
        padding: ${unsafeCSS(spacing.lg)};
      }
      .prompt-markdown h1,
      .prompt-markdown h2,
      .prompt-markdown h3 {
        color: ${unsafeCSS(colors.textPrimary)};
        margin: 0 0 ${unsafeCSS(spacing.sm)};
      }
      .prompt-markdown p,
      .prompt-markdown ul,
      .prompt-markdown ol,
      .prompt-markdown pre {
        margin: 0 0 ${unsafeCSS(spacing.md)};
      }
      .prompt-markdown code,
      .prompt-markdown pre {
        font-family: ${unsafeCSS(fonts.mono)};
      }
      .prompt-markdown pre {
        background: ${unsafeCSS(colors.bgCard)};
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.sm)};
        overflow: auto;
        padding: ${unsafeCSS(spacing.md)};
      }
      .artifact-header {
        min-width: 0;
      }
      .artifact-header h3,
      .artifact-header p {
        overflow-wrap: anywhere;
      }
      .artifact-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: ${unsafeCSS(spacing.sm)};
        justify-content: flex-end;
        align-items: flex-start;
      }
      .artifact-mode {
        min-width: 210px;
      }
      .session-card {
        border: 1px solid ${unsafeCSS(colors.accent)}66;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.accent)}10;
        display: grid;
        gap: ${unsafeCSS(spacing.sm)};
        padding: ${unsafeCSS(spacing.md)};
      }
      .session-card header {
        display: flex;
        justify-content: space-between;
        gap: ${unsafeCSS(spacing.sm)};
        align-items: flex-start;
      }
      .session-card code {
        color: ${unsafeCSS(colors.textPrimary)};
        font-size: ${unsafeCSS(fonts.sizeXs)};
        overflow-wrap: anywhere;
      }
      .draft-card-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: ${unsafeCSS(spacing.sm)};
        margin-top: ${unsafeCSS(spacing.md)};
      }
      .draft-card {
        border: 1px solid ${unsafeCSS(colors.textMuted)}33;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.bgSurface)};
        display: grid;
        gap: ${unsafeCSS(spacing.sm)};
        min-width: 0;
        padding: ${unsafeCSS(spacing.md)};
      }
      .draft-card h3,
      .draft-card p {
        overflow-wrap: anywhere;
      }
      .draft-editor {
        display: grid;
        gap: ${unsafeCSS(spacing.md)};
      }
      .modal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: rgba(0, 0, 0, 0.72);
        display: grid;
        place-items: center;
        padding: ${unsafeCSS(spacing.xxl)};
      }
      .runner-modal {
        width: min(720px, 96vw);
        max-height: 88vh;
        overflow: auto;
        border: 1px solid ${unsafeCSS(colors.accent)}55;
        border-radius: ${unsafeCSS(radii.md)};
        background: ${unsafeCSS(colors.bgSurface)};
        display: grid;
        gap: ${unsafeCSS(spacing.md)};
        padding: ${unsafeCSS(spacing.lg)};
      }
      .runner-modal header,
      .runner-modal footer {
        display: flex;
        justify-content: space-between;
        gap: ${unsafeCSS(spacing.md)};
        align-items: flex-start;
      }
      .runner-modal footer {
        align-items: center;
      }
      .artifact-modal {
        width: min(1280px, 98vw);
        max-height: 92vh;
      }
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    this._applyUrlStateFromHash();
    this._syncState(getState());
    this._unsubscribeState = subscribe((s) => this._syncState(s));
    window.addEventListener('keydown', this._onKeydown);
    window.addEventListener('hashchange', this._onHashChange);
    this._unsubscribeConnection = gateway.onConnectionChange((state) => {
      if (state === 'connected' && !this.items) void this._refresh();
    });
    if (gateway.connectionState === 'connected' && !this.items) void this._refresh();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribeConnection?.();
    this._unsubscribeState?.();
    window.removeEventListener('keydown', this._onKeydown);
    window.removeEventListener('hashchange', this._onHashChange);
    this._unsubscribeConnection = undefined;
    this._unsubscribeState = undefined;
  }

  protected updated(changed: Map<string, unknown>) {
    if (changed.has('items') || changed.has('slots') || changed.has('demoRuns')) {
      this._syncState(getState());
    }
  }

  private _applyUrlStateFromHash() {
    if (typeof location === 'undefined') return;
    const { route, params } = parseHashRoute();
    if (!isRoadmapRoute(route)) return;
    const selectedParam = params.get(ROADMAP_ITEM_PARAM)?.trim() ?? '';
    this._selectedId = selectedParam || this._selectedId || this.items?.[0]?.id || '';
    this._editorMode =
      this._selectedId && params.get(ROADMAP_MODE_PARAM) === 'edit' ? 'edit' : 'view';
    this._runnerPickerOpen = params.get(ROADMAP_RUNNER_PICKER_PARAM) === '1';
    const draft = Number.parseInt(params.get(ROADMAP_DRAFT_PARAM) ?? '', 10);
    this._promotionDraftModalIndex = Number.isFinite(draft) && draft >= 0 ? draft : -1;
    this._promotionOpen =
      params.get(ROADMAP_PROMOTE_PARAM) === '1' || this._promotionDraftModalIndex >= 0;
    this._promotionDraftModalMode =
      params.get(ROADMAP_DRAFT_MODE_PARAM) === 'edit' ? 'edit' : 'view';
    const sortKey = params.get(ROADMAP_SORT_PARAM);
    this._sortKey = ROADMAP_SORT_KEYS.includes(sortKey as RoadmapSortKey)
      ? (sortKey as RoadmapSortKey)
      : 'updated';
    this._sortDirection = params.get(ROADMAP_SORT_DIRECTION_PARAM) === 'asc' ? 'asc' : 'desc';
    if (!selectedParam && this._selectedId) queueMicrotask(() => this._writeUrlState());
  }

  private _writeUrlState() {
    if (typeof location === 'undefined') return;
    const { route, params } = parseHashRoute();
    if (!isRoadmapRoute(route)) return;
    if (this._selectedId) params.set(ROADMAP_ITEM_PARAM, this._selectedId);
    else params.delete(ROADMAP_ITEM_PARAM);
    if (this._selectedId && this._editorMode === 'edit') params.set(ROADMAP_MODE_PARAM, 'edit');
    else params.delete(ROADMAP_MODE_PARAM);
    if (this._runnerPickerOpen) params.set(ROADMAP_RUNNER_PICKER_PARAM, '1');
    else params.delete(ROADMAP_RUNNER_PICKER_PARAM);
    if (this._promotionOpen) params.set(ROADMAP_PROMOTE_PARAM, '1');
    else params.delete(ROADMAP_PROMOTE_PARAM);
    if (this._promotionDraftModalIndex >= 0) {
      params.set(ROADMAP_PROMOTE_PARAM, '1');
      params.set(ROADMAP_DRAFT_PARAM, String(this._promotionDraftModalIndex));
      if (this._promotionDraftModalMode === 'edit') {
        params.set(ROADMAP_DRAFT_MODE_PARAM, 'edit');
      } else {
        params.delete(ROADMAP_DRAFT_MODE_PARAM);
      }
    } else {
      params.delete(ROADMAP_DRAFT_PARAM);
      params.delete(ROADMAP_DRAFT_MODE_PARAM);
    }
    if (this._sortKey === 'updated') params.delete(ROADMAP_SORT_PARAM);
    else params.set(ROADMAP_SORT_PARAM, this._sortKey);
    if (this._sortDirection === 'desc') params.delete(ROADMAP_SORT_DIRECTION_PARAM);
    else params.set(ROADMAP_SORT_DIRECTION_PARAM, this._sortDirection);
    const next = buildHash(route, params);
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  private _syncState(state: AppState) {
    const previousProjects = this._globalFilters.projects.join('\0');
    this._slots = this.slots ?? state.fleet?.slots ?? [];
    this._backlogItems = state.backlogItems;
    this._runs = this.demoRuns ?? state.runs;
    this._workGraphs = state.workGraphs;
    this._globalFilters = state.globalFilters;
    if (this.items) {
      this._allItems = this.items;
      const visibleItems = this._items;
      const selected =
        visibleItems.find((item) => item.id === this._selectedId) ?? visibleItems[0] ?? null;
      if (!selected || this._editHash !== selected.fileHash) {
        this._syncEditor(selected);
        this._writeUrlState();
      }
    }
    if (previousProjects !== this._globalFilters.projects.join('\0')) {
      const globalProjects = concretePlanningProjects(state.globalFilters.projects);
      // Multi-project filters set owner to `global` for coordination but do NOT
      // pre-fill every filtered farm as targetProjects — silent multi-target
      // inheritance forced N backlog drafts for framework-only ideas. Fan-out
      // is operator-explicit (or a single concrete filter).
      this._newTargetProjects = syncedDraftTargetProjects({
        currentTargets: this._newTargetProjects,
        concreteGlobalProjects: globalProjects,
        preserveCurrentTargets: this._newTargetProjectsTouched,
      });
      if (globalProjects.length > 1) {
        this._newProject = ROADMAP_GLOBAL_PROJECT;
      } else if (globalProjects.length === 1) {
        this._newProject = globalProjects[0]!;
      } else {
        this._newProject = syncedDraftProject({
          currentProject: this._newProject,
          availableProjects: this._projects,
          globalProjects,
          fallbackProjects: [ROADMAP_UNASSIGNED_PROJECT],
        });
      }
      if (this._allItems.length > 0) {
        const visibleItems = this._items;
        if (!visibleItems.some((item) => item.id === this._selectedId)) {
          this._syncEditor(visibleItems[0] ?? null);
          this._writeUrlState();
        }
      }
    }
  }

  private get _projects(): string[] {
    return [
      ...new Set([
        ROADMAP_UNASSIGNED_PROJECT,
        ROADMAP_GLOBAL_PROJECT,
        ...this._slots.map((slot) => slot.project).filter(Boolean),
        ...this._allItems.map((item) => item.project).filter(Boolean),
        ...this._allItems.flatMap((item) => item.targetProjects ?? []),
      ]),
    ].sort();
  }

  private get _targetProjectOptions(): string[] {
    return this._projects.filter(isConcreteRoadmapProject);
  }

  private _newTitleForSubmit(): string {
    const title = this._newTitle.trim();
    if (title) return title;
    const firstBodyLine = this._newBody
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return firstBodyLine?.slice(0, 120) ?? '';
  }

  private _renderProjectPicker(
    label: string,
    testId: string,
    value: string,
    onChange: (project: string) => void,
  ) {
    const selectedValue = this._projects.includes(value) ? value : CUSTOM_PROJECT;
    return html`<div class="field">
      ${label}
      ${renderChoiceButtons({
        options: [...this._projects, CUSTOM_PROJECT],
        value: selectedValue,
        onSelect: (project) => onChange(project === CUSTOM_PROJECT ? '' : project),
        labels: { [CUSTOM_PROJECT]: 'Custom' },
        testId: `${testId}-choices`,
      })}
      ${selectedValue === CUSTOM_PROJECT
        ? html`<input
            data-testid=${testId}
            placeholder="custom project name"
            .value=${value}
            @input=${(e: Event) => onChange((e.target as HTMLInputElement).value)}
          />`
        : nothing}
    </div>`;
  }

  private _toggleProjectSelection(selected: string[], project: string): string[] {
    return selected.includes(project)
      ? selected.filter((candidate) => candidate !== project)
      : [...selected, project].sort();
  }

  private _renderTargetProjectPicker(
    label: string,
    testId: string,
    selected: string[],
    onChange: (projects: string[]) => void,
  ) {
    return html`<div class="field">
      ${label}
      ${renderToggleChips({
        options: this._targetProjectOptions,
        selected,
        onToggle: (project) => onChange(this._toggleProjectSelection(selected, project)),
        testId,
      })}
    </div>`;
  }

  private get _items(): RoadmapItem[] {
    const visible =
      this._filterProject === 'all'
        ? filterRoadmapItemsByGlobalProjects(
            this._allItems,
            concretePlanningProjects(this._globalFilters.projects),
          )
        : this._allItems;
    return sortRoadmapItems(visible, this._sortKey, this._sortDirection);
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

  private get _refinementRunnerOptions(): string[] {
    return [...new Set([...RUNNER_OPTIONS, ...this._runnerOptions])].sort();
  }

  /** Models for the selected (or default) runner only — never fleet-wide cross-runner models. */
  private get _refinementModelOptions(): string[] {
    const runner = this._refineRunner || DEFAULT_ROADMAP_REFINEMENT_RUNNER;
    return modelsForRunner(runner);
  }

  private get _refinementDefaultModelLabel(): string {
    const runner = this._refineRunner || DEFAULT_ROADMAP_REFINEMENT_RUNNER;
    return DEFAULT_MODEL[runner] ?? DEFAULT_ROADMAP_REFINEMENT_MODEL;
  }

  private _refinementChoiceValue(value: string, options: string[]): string {
    if (!value) return DEFAULT_REFINEMENT_CHOICE;
    return options.includes(value) ? value : CUSTOM_REFINEMENT_CHOICE;
  }

  private _openRunnerPicker() {
    this._runnerPickerOpen = true;
    if (this._selected) void this._loadRefinementSessionStatus(this._selected);
    this._writeUrlState();
  }

  private async _loadRefinementSessionStatus(item: RoadmapItem) {
    if (this._refinementSessionLoading === item.id) return;
    this._refinementSessionLoading = item.id;
    try {
      const result = await gateway.request<RoadmapRefinementSessionGetResult>(
        Methods.ROADMAP_REFINEMENT_SESSION_GET,
        { itemId: item.id },
      );
      if (this._selected?.id !== item.id) return;
      this._existingRefinementSession = result;
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      if (this._refinementSessionLoading === item.id) this._refinementSessionLoading = '';
    }
  }

  private _syncEditor(item: RoadmapItem | null) {
    if (!item) {
      this._selectedId = '';
      this._editorMode = 'view';
      this._editTitle = '';
      this._editProject = '';
      this._editTargetProjects = [];
      this._editStage = 'rough';
      this._editTags = '';
      this._editBody = '';
      this._editHash = '';
      this._refineRunner = '';
      this._refineModel = '';
      this._refineCommand = '';
      this._refineSafetyTier = '';
      this._refinementSessionLoading = '';
      this._existingRefinementSession = null;
      this._promotionDrafts = [];
      this._promotionDraftAttachments = [];
      this._promotionDraftModalIndex = -1;
      this._promotionDraftModalMode = 'view';
      this._promotionOpen = false;
      this._promptViewerPath = '';
      return;
    }
    this._selectedId = item.id;
    this._editTitle = item.title;
    this._editProject = item.project;
    this._editTargetProjects = item.targetProjects ?? [];
    this._editStage = item.stage;
    this._editTags = tagsToInput(item.tags);
    this._editBody = item.body;
    this._editHash = item.fileHash;
    this._refineRunner = '';
    this._refineModel = '';
    this._refineCommand = '';
    this._refineSafetyTier = '';
    this._refinementSessionLoading = '';
    this._existingRefinementSession = null;
    this._promotionDrafts = promotionDraftsFromRoadmapItem(item);
    if (this._promotionDraftModalIndex >= this._promotionDrafts.length) {
      this._promotionDraftModalIndex = -1;
      this._promotionDraftModalMode = 'view';
    }
    this._promotionDraftAttachments = [];
    if (this._runnerPickerOpen && !this.items) void this._loadRefinementSessionStatus(item);
    if (!this.items && (this._promotionOpen || item.stage === 'refined')) {
      void this._loadPromotionDraftAttachments(item);
    }
    if (
      !this.items &&
      item.refinementPromptPath &&
      !this._promptPreviews[item.refinementPromptPath]
    ) {
      void this._loadPromptPreview(item.refinementPromptPath);
    }
  }

  private async _loadPromotionDraftAttachments(item: RoadmapItem) {
    if (this._promotionDraftAttachmentLoading === item.id) return;
    this._promotionDraftAttachmentLoading = item.id;
    try {
      const listed = await gateway.request<RoadmapPromotionDraftListResult>(
        Methods.ROADMAP_PROMOTION_DRAFT_LIST,
        { itemId: item.id },
      );
      if (!listed.drafts.length) return;
      const loaded = await Promise.all(
        listed.drafts.map((draft) =>
          gateway.request<RoadmapPromotionDraftGetResult>(Methods.ROADMAP_PROMOTION_DRAFT_GET, {
            path: draft.path,
          }),
        ),
      );
      if (this._selected?.id !== item.id) return;
      this._promotionDraftAttachments = loaded.map((draft) => ({
        filename: draft.filename,
        virtualPath: draft.path,
        content: draft.content,
        contentHash: draft.contentHash,
      }));
      this._promotionDrafts = loaded.map((draft) =>
        parsePromotionDraftAttachment(draft.path, draft.content),
      );
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      if (this._promotionDraftAttachmentLoading === item.id) {
        this._promotionDraftAttachmentLoading = '';
      }
    }
  }

  private async _loadPromptPreview(promptPath: string) {
    if (this._promptPreviewLoading === promptPath || this._promptPreviews[promptPath]) return;
    this._promptPreviewLoading = promptPath;
    try {
      const result = await gateway.request<RoadmapPromptGetResult>(Methods.ROADMAP_PROMPT_GET, {
        path: promptPath,
      });
      this._promptPreviews = {
        ...this._promptPreviews,
        [result.path]: {
          absolutePath: result.absolutePath,
          content: result.content,
        },
      };
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      if (this._promptPreviewLoading === promptPath) this._promptPreviewLoading = '';
    }
  }

  private _openPromptViewer(promptPath: string) {
    this._promptViewerPath = promptPath;
    this._promptViewerMode = 'raw';
    if (!this._promptPreviews[promptPath]) void this._loadPromptPreview(promptPath);
  }

  private async _refresh(selectId = this._selectedId) {
    if (this.items) {
      this._syncState(getState());
      return;
    }
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
      this._writeUrlState();
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
          project: this._newProject || ROADMAP_UNASSIGNED_PROJECT,
          targetProjects: this._newTargetProjects,
          title: this._newTitleForSubmit(),
          stage: 'rough',
          tags: tagsFromInput(this._newTags),
          source: { kind: 'manual' },
          body: this._newBody || 'Raw idea.\n',
        },
      });
      this._newTitle = '';
      this._newBody = '';
      this._newTags = '';
      this._newTargetProjects = syncedDraftTargetProjects({
        currentTargets: [],
        concreteGlobalProjects: concretePlanningProjects(this._globalFilters.projects),
        preserveCurrentTargets: false,
      });
      this._newTargetProjectsTouched = false;
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
          targetProjects: this._editTargetProjects,
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
        ...(this._refineSafetyTier ? { safetyTier: this._refineSafetyTier as SafetyTier } : {}),
      });
      const selectedRunner = [result.runner, result.model, result.safetyTier]
        .filter(Boolean)
        .join(' ');
      const runnerSuffix = selectedRunner ? ` (${selectedRunner})` : '';
      this._message = launch
        ? result.launched
          ? `Refinement terminal launched${runnerSuffix}: ${result.attachCommand}`
          : `Refinement terminal reopened${runnerSuffix}: ${result.attachCommand}`
        : `Refinement prompt ready${runnerSuffix}: ${result.promptPath}`;
      if (launch) this._setRunnerPickerOpen(false);
      await this._refresh(result.item.id);
      if (launch && result.tmuxWorker) this._navigateToWorkerTerminal(result.tmuxWorker);
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._busy = '';
    }
  }

  private async _continueExistingRefinementSession() {
    const session = this._existingRefinementSession;
    if (!session?.exists) return;
    if (session.tmuxWorker) {
      this._setRunnerPickerOpen(false);
      this._message = `Refinement terminal reopened: ${session.attachCommand}`;
      this._navigateToWorkerTerminal(session.tmuxWorker);
      return;
    }
    await this._refineSelected(true);
  }

  private _navigateToWorkerTerminal(worker: RoadmapRefineResult['tmuxWorker']) {
    if (!worker) return;
    const { params } = parseHashRoute();
    params.delete(ROADMAP_ITEM_PARAM);
    params.delete(ROADMAP_MODE_PARAM);
    params.delete(ROADMAP_RUNNER_PICKER_PARAM);
    params.delete(ROADMAP_PROMOTE_PARAM);
    params.delete(ROADMAP_DRAFT_PARAM);
    params.delete(ROADMAP_DRAFT_MODE_PARAM);
    params.set('worker', encodeWorkerRouteParam(worker));
    location.hash = buildHash('terminal', params);
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
    const next = [
      ...this._promotionDrafts,
      {
        project:
          this._editTargetProjects[0] ??
          (this._selected && isConcreteRoadmapProject(this._selected.project)
            ? this._selected.project
            : ''),
        title: this._selected?.title ?? '',
        body: defaultSpecBody(this._selected),
      },
    ];
    this._promotionDrafts = next;
    this._promotionOpen = true;
    this._openPromotionDraftModal(next.length - 1, 'edit');
  }

  private _updatePromotionSpec(index: number, patch: Partial<PromotionDraft>) {
    this._promotionDrafts = this._promotionDrafts.map((spec, i) =>
      i === index ? { ...spec, ...patch } : spec,
    );
  }

  private _removePromotionSpec(index: number) {
    this._promotionDrafts = this._promotionDrafts.filter((_, i) => i !== index);
    if (this._promotionDraftModalIndex === index) {
      this._closePromotionDraftModal();
    } else {
      if (this._promotionDraftModalIndex > index) this._promotionDraftModalIndex -= 1;
      this._writeUrlState();
    }
  }

  private _openPromotionDraftModal(index: number, mode: PromotionDraftModalMode = 'view') {
    this._promotionDraftModalIndex = index;
    this._promotionDraftModalMode = mode;
    this._promotionOpen = true;
    this._writeUrlState();
  }

  private _closePromotionDraftModal() {
    this._promotionDraftModalIndex = -1;
    this._promotionDraftModalMode = 'view';
    this._writeUrlState();
  }

  private _setPromotionDraftModalMode(mode: PromotionDraftModalMode) {
    this._promotionDraftModalMode = mode;
    this._writeUrlState();
  }

  private _promotionDraftMarkdown(spec: PromotionDraft, index: number): string {
    return [
      `# ${spec.title || `Draft ${index + 1}`}`,
      '',
      `Project: ${spec.project || '(unassigned)'}`,
      '',
      spec.body || '(empty draft)',
    ].join('\n');
  }

  private _promotionDraftContent(item: RoadmapItem, spec: PromotionDraft, index: number): string {
    return promotionDraftAttachment(item, spec, index, tagsFromInput(this._editTags)).content;
  }

  private _promotionDraftAttachmentChanged(
    item: RoadmapItem,
    spec: PromotionDraft,
    index: number,
  ): boolean {
    const attachment = this._promotionDraftAttachments[index];
    if (!attachment) return false;
    return this._promotionDraftContent(item, spec, index) !== attachment.content;
  }

  private async _savePromotionDraftAttachment(item: RoadmapItem, index: number) {
    const spec = this._promotionDrafts[index];
    const attachment = this._promotionDraftAttachments[index];
    if (!spec || !attachment) return;
    this._busy = `promotion-draft-save-${index}`;
    this._error = '';
    this._message = '';
    try {
      const result = await gateway.request<RoadmapPromotionDraftSaveResult>(
        Methods.ROADMAP_PROMOTION_DRAFT_SAVE,
        {
          path: attachment.virtualPath,
          content: this._promotionDraftContent(item, spec, index),
          ...(attachment.contentHash ? { expectedHash: attachment.contentHash } : {}),
        },
      );
      this._promotionDraftAttachments = this._promotionDraftAttachments.map((candidate, i) =>
        i === index
          ? {
              filename: result.filename,
              virtualPath: result.path,
              content: result.content,
              contentHash: result.contentHash,
            }
          : candidate,
      );
      this._promotionDrafts = this._promotionDrafts.map((candidate, i) =>
        i === index ? parsePromotionDraftAttachment(result.path, result.content) : candidate,
      );
      this._message = `Saved draft attachment: ${result.filename}`;
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._busy = '';
    }
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
          project: spec.project || undefined,
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

  private _selectItem(item: RoadmapItem, mode: RoadmapEditorMode = 'view') {
    this._syncEditor(item);
    this._editorMode = mode;
    this._writeUrlState();
  }

  private _setEditorMode(mode: RoadmapEditorMode) {
    this._editorMode = mode;
    this._writeUrlState();
  }

  private _setRunnerPickerOpen(open: boolean) {
    this._runnerPickerOpen = open;
    this._writeUrlState();
  }

  private _setPromotionOpen(open: boolean) {
    this._promotionOpen = open;
    if (!open) {
      this._promotionDraftModalIndex = -1;
      this._promotionDraftModalMode = 'view';
    }
    if (open && this._selected) void this._loadPromotionDraftAttachments(this._selected);
    this._writeUrlState();
  }

  private _renderRefinementPromptPath(item: RoadmapItem) {
    if (!item.refinementPromptPath) return nothing;
    const preview = this._promptPreviews[item.refinementPromptPath];
    const promptPath = preview?.absolutePath ?? item.refinementPromptPath;
    const promptFile = promptPath.split('/').filter(Boolean).at(-1) ?? promptPath;
    return html`<div class="path-panel">
      <div class="editor-head">
        <div>
          <h3>Runner prompt</h3>
        </div>
        <button
          class="artifact-link"
          type="button"
          title=${promptPath}
          @click=${() => this._openPromptViewer(item.refinementPromptPath!)}
        >
          ${promptFile}
        </button>
      </div>
    </div>`;
  }

  private _renderArtifactModal(args: {
    ariaLabel: string;
    title: string;
    subtitle?: string;
    toolbar: unknown;
    content: unknown;
    onClose: () => void;
  }) {
    return html`<div class="modal-backdrop" @click=${args.onClose}>
      <section
        class="runner-modal artifact-modal"
        role="dialog"
        aria-modal="true"
        aria-label=${args.ariaLabel}
        @click=${(event: Event) => event.stopPropagation()}
      >
        <header>
          <div class="artifact-header">
            <h3>${args.title}</h3>
            ${args.subtitle ? html`<p class="muted">${args.subtitle}</p>` : nothing}
          </div>
          <div class="artifact-toolbar">
            ${args.toolbar}
            <button class="secondary" type="button" @click=${args.onClose}>Close</button>
          </div>
        </header>
        ${args.content}
      </section>
    </div>`;
  }

  private _renderPromptViewer() {
    if (!this._promptViewerPath) return nothing;
    const preview = this._promptPreviews[this._promptViewerPath];
    const promptPath = preview?.absolutePath ?? this._promptViewerPath;
    const promptFile = promptPath.split('/').filter(Boolean).at(-1) ?? promptPath;
    return this._renderArtifactModal({
      ariaLabel: 'Generated refinement prompt',
      title: promptFile,
      subtitle: promptPath,
      onClose: () => {
        this._promptViewerPath = '';
      },
      toolbar: html`<div class="field artifact-mode">
        View
        ${renderChoiceButtons({
          options: ['raw', 'markdown'] satisfies PromptViewerMode[],
          value: this._promptViewerMode,
          labels: {
            raw: 'Raw',
            markdown: 'Markdown',
          },
          onSelect: (mode) => {
            this._promptViewerMode = mode;
          },
          testId: 'roadmap-prompt-view-mode',
        })}
      </div>`,
      content: preview
        ? this._promptViewerMode === 'markdown'
          ? html`<div class="prompt-markdown">${unsafeHTML(renderMarkdown(preview.content))}</div>`
          : html`<pre class="prompt-preview">${preview.content}</pre>`
        : html`<div class="muted">
            ${this._promptPreviewLoading === this._promptViewerPath
              ? 'Loading prompt...'
              : 'Prompt unavailable.'}
          </div>`,
    });
  }

  private _openPromotionAttachmentViewer(attachment: PromotionDraftAttachment) {
    this._promotionAttachmentViewer = attachment;
    this._promptViewerMode = 'markdown';
  }

  private _promotionAttachmentsForItem(item: RoadmapItem): PromotionDraftAttachment[] {
    return this._promotionDraftAttachments.length
      ? this._promotionDraftAttachments
      : this._promotionDrafts.map((draft, index) =>
          promotionDraftAttachment(item, draft, index, tagsFromInput(this._editTags)),
        );
  }

  private _renderPromotionAttachmentCards(item: RoadmapItem) {
    const attachments = this._promotionAttachmentsForItem(item);
    return html`<div class="attachment-grid" data-testid="roadmap-promotion-attachments">
      ${this._promotionDraftAttachmentLoading === item.id
        ? html`<div class="muted">Loading draft attachments...</div>`
        : nothing}
      ${attachments.map(
        (attachment, index) =>
          html`<div class="attachment-card">
            <div>
              <h3>${attachment.filename}</h3>
              <p>${attachment.virtualPath}</p>
            </div>
            <div class="badges">
              ${renderPlanningBadge(
                this._promotionDrafts[index]?.project || ROADMAP_UNASSIGNED_PROJECT,
              )}
              ${renderPlanningBadge(this._promotionDrafts[index]?.title || 'Untitled draft')}
            </div>
            <button
              class="artifact-link"
              type="button"
              title=${attachment.virtualPath}
              @click=${() => this._openPromotionAttachmentViewer(attachment)}
            >
              Review
            </button>
          </div>`,
      )}
    </div>`;
  }

  private _renderDraftAttachmentSummary(item: RoadmapItem) {
    if (
      item.stage !== 'refined' &&
      !this._promotionDraftAttachments.length &&
      this._promotionDraftAttachmentLoading !== item.id
    ) {
      return nothing;
    }
    return html`<div class="path-panel">
      <div class="editor-head">
        <div>
          <h3>Backlog draft attachments</h3>
          <p class="muted">
            Review these draft spec files before promoting them into backlog items.
          </p>
        </div>
        ${this._promotionDraftAttachments.length
          ? renderPlanningBadge(
              `${this._promotionDraftAttachments.length} attached draft${this._promotionDraftAttachments.length === 1 ? '' : 's'}`,
              'positive',
            )
          : nothing}
      </div>
      ${this._renderPromotionAttachmentCards(item)}
    </div>`;
  }

  private _renderPromotionAttachmentViewer() {
    const attachment = this._promotionAttachmentViewer;
    if (!attachment) return nothing;
    return this._renderArtifactModal({
      ariaLabel: 'Review backlog draft attachment',
      title: attachment.filename,
      subtitle: attachment.virtualPath,
      onClose: () => {
        this._promotionAttachmentViewer = null;
      },
      toolbar: html`<div class="field artifact-mode">
        View
        ${renderChoiceButtons({
          options: ['raw', 'markdown'] satisfies PromptViewerMode[],
          value: this._promptViewerMode,
          labels: {
            raw: 'Raw',
            markdown: 'Markdown',
          },
          onSelect: (mode) => {
            this._promptViewerMode = mode;
          },
          testId: 'roadmap-promotion-attachment-view-mode',
        })}
      </div>`,
      content:
        this._promptViewerMode === 'markdown'
          ? html`<div class="prompt-markdown">
              ${unsafeHTML(renderMarkdown(attachment.content))}
            </div>`
          : html`<pre class="prompt-preview">${attachment.content}</pre>`,
    });
  }

  private _renderPromotionDraftModal(item: RoadmapItem) {
    const index = this._promotionDraftModalIndex;
    const spec = this._promotionDrafts[index];
    if (index < 0 || !spec) return nothing;
    const attachment = this._promotionAttachmentsForItem(item)[index];
    const persistedAttachment = this._promotionDraftAttachments[index];
    const attachmentChanged = this._promotionDraftAttachmentChanged(item, spec, index);
    const title = spec.title || `Draft ${index + 1}`;
    const subtitle = attachment?.virtualPath ?? `Draft ${index + 1}`;
    return this._renderArtifactModal({
      ariaLabel: 'Review backlog draft',
      title,
      subtitle,
      onClose: () => this._closePromotionDraftModal(),
      toolbar: html`<div class="field artifact-mode">
          Mode
          ${renderChoiceButtons({
            options: ['view', 'edit'] satisfies PromotionDraftModalMode[],
            value: this._promotionDraftModalMode,
            labels: {
              view: 'View',
              edit: 'Edit',
            },
            onSelect: (mode) => {
              this._setPromotionDraftModalMode(mode);
            },
            testId: 'roadmap-promotion-draft-mode',
          })}
        </div>
        <button
          type="button"
          data-testid=${`roadmap-promote-save-${index}`}
          ?disabled=${!persistedAttachment ||
          !attachmentChanged ||
          this._busy === `promotion-draft-save-${index}`}
          title=${persistedAttachment
            ? 'Save this draft back to its attached markdown file.'
            : 'This draft is not backed by an attached file yet.'}
          @click=${() => this._savePromotionDraftAttachment(item, index)}
        >
          Save
        </button>
        <button
          class="danger"
          type="button"
          ?disabled=${this._promotionDrafts.length <= 1}
          @click=${() => this._removePromotionSpec(index)}
        >
          Remove
        </button>`,
      content:
        this._promotionDraftModalMode === 'view'
          ? html`<div class="prompt-markdown">
              ${unsafeHTML(renderMarkdown(this._promotionDraftMarkdown(spec, index)))}
            </div>`
          : html`<div class="draft-editor">
              <div class="field">
                Target project
                ${renderChoiceButtons({
                  options: this._targetProjectOptions,
                  value: spec.project,
                  onSelect: (project) =>
                    this._updatePromotionSpec(index, {
                      project,
                    }),
                  testId: `roadmap-promote-project-${index}`,
                })}
              </div>
              <label
                >Backlog title
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
                >Backlog markdown
                <textarea
                  data-testid=${`roadmap-promote-body-${index}`}
                  class="body"
                  .value=${spec.body}
                  @input=${(e: Event) =>
                    this._updatePromotionSpec(index, {
                      body: (e.target as HTMLTextAreaElement).value,
                    })}
                ></textarea>
              </label>
            </div>`,
    });
  }

  private _renderRefinementChoice(args: {
    label: string;
    defaultLabel: string;
    testId: string;
    value: string;
    options: string[];
    onChange: (value: string) => void;
  }) {
    const choiceValue = this._refinementChoiceValue(args.value, args.options);
    return html`<div class="field">
      ${args.label}
      ${renderChoiceButtons({
        options: [DEFAULT_REFINEMENT_CHOICE, ...args.options, CUSTOM_REFINEMENT_CHOICE],
        value: choiceValue,
        labels: {
          [DEFAULT_REFINEMENT_CHOICE]: args.defaultLabel,
          [CUSTOM_REFINEMENT_CHOICE]: 'Custom',
        },
        onSelect: (choice) => {
          if (choice === DEFAULT_REFINEMENT_CHOICE) args.onChange('');
          else if (choice !== CUSTOM_REFINEMENT_CHOICE) args.onChange(choice);
        },
        testId: `${args.testId}-choices`,
      })}
      ${choiceValue === CUSTOM_REFINEMENT_CHOICE
        ? html`<input
            data-testid=${args.testId}
            placeholder=${args.label.toLowerCase()}
            .value=${args.value}
            @input=${(event: Event) => args.onChange((event.target as HTMLInputElement).value)}
          />`
        : nothing}
    </div>`;
  }

  private _renderRunnerPicker() {
    if (!this._runnerPickerOpen || !this._selected) return nothing;
    const loadingSession = this._refinementSessionLoading === this._selected.id;
    const existingSession = this._existingRefinementSession?.exists
      ? this._existingRefinementSession
      : null;
    return html`<div class="modal-backdrop" @click=${() => this._setRunnerPickerOpen(false)}>
      <section
        class="runner-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Refine with runner"
        @click=${(event: Event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2>Refine with runner</h2>
            <p class="muted">Launch a tmux refinement session for ${this._selected.title}.</p>
            <p class="muted">
              Default: ${DEFAULT_ROADMAP_REFINEMENT_RUNNER} / ${DEFAULT_ROADMAP_REFINEMENT_MODEL}
            </p>
          </div>
          <button class="secondary" type="button" @click=${() => this._setRunnerPickerOpen(false)}>
            Close
          </button>
        </header>
        ${existingSession
          ? html`<section class="session-card" data-testid="roadmap-existing-refinement-session">
              <header>
                <div>
                  <h3>Existing refinement session</h3>
                  <p class="muted">
                    This roadmap item already has a tmux runner. Continuing keeps the conversation
                    context.
                  </p>
                </div>
                <button
                  data-testid="roadmap-refine-continue-existing"
                  type="button"
                  ?disabled=${this._busy === 'refine-launch'}
                  @click=${() => this._continueExistingRefinementSession()}
                >
                  Continue
                </button>
              </header>
              <code>${existingSession.tmuxSession} · ${existingSession.tmuxTarget}</code>
            </section>`
          : loadingSession
            ? html`<p class="muted">Checking for an existing refinement session...</p>`
            : nothing}
        <div class="grid">
          <div class="full">
            ${this._renderRefinementChoice({
              label: 'Runner',
              defaultLabel: `Default (${DEFAULT_ROADMAP_REFINEMENT_RUNNER})`,
              testId: 'roadmap-refine-runner',
              value: this._refineRunner,
              options: this._refinementRunnerOptions,
              onChange: (runner) => {
                this._refineRunner = runner;
                this._refineModel = modelForRunnerChange(runner, this._refineModel, {
                  defaultRunner: DEFAULT_ROADMAP_REFINEMENT_RUNNER,
                });
              },
            })}
          </div>
          <div class="full">
            ${this._renderRefinementChoice({
              label: 'Model',
              defaultLabel: `Default (${this._refinementDefaultModelLabel})`,
              testId: 'roadmap-refine-model',
              value: this._refineModel,
              options: this._refinementModelOptions,
              onChange: (model) => {
                this._refineModel = model;
              },
            })}
          </div>
          <div class="field full">
            Permission mode
            ${renderChoiceButtons({
              options: [DEFAULT_REFINEMENT_CHOICE, ...SAFETY_TIERS],
              value: this._refineSafetyTier || DEFAULT_REFINEMENT_CHOICE,
              labels: {
                [DEFAULT_REFINEMENT_CHOICE]: 'Default',
                sandboxed: 'Sandboxed',
                'full-auto': 'Full auto',
                dangerous: 'Dangerous',
              },
              onSelect: (tier) => {
                this._refineSafetyTier = tier === DEFAULT_REFINEMENT_CHOICE ? '' : tier;
              },
              testId: 'roadmap-refine-safety-tier',
            })}
          </div>
          <label class="full"
            >Command template override
            <input
              data-testid="roadmap-refine-command"
              placeholder="project default; supports {{runner}}, {{model}}, {{prompt_path}}, {{item_file}}, {{safety_tier}}, {{safety_flags}}"
              .value=${this._refineCommand}
              @input=${(event: Event) =>
                (this._refineCommand = (event.target as HTMLInputElement).value)}
            />
          </label>
        </div>
        <footer>
          <p class="muted">
            Escape closes this dialog.
            ${existingSession
              ? 'This action continues the existing tmux session.'
              : 'Launch creates or attaches the tmux session.'}
          </p>
          <div class="actions">
            <button
              class="secondary"
              type="button"
              @click=${() => this._setRunnerPickerOpen(false)}
            >
              Cancel
            </button>
            <button
              data-testid="roadmap-refine-runner-launch"
              type="button"
              ?disabled=${this._busy === 'refine-launch' || loadingSession}
              @click=${() =>
                existingSession
                  ? this._continueExistingRefinementSession()
                  : this._refineSelected(true)}
            >
              ${existingSession ? 'Continue existing session' : 'Launch runner'}
            </button>
          </div>
        </footer>
      </section>
    </div>`;
  }

  private _renderCreateForm() {
    return html`<form @submit=${this._create}>
      <h2>Capture raw idea</h2>
      <div class="grid">
        <div class="full">
          ${this._renderProjectPicker(
            'Owner project',
            'roadmap-new-project',
            this._newProject,
            (project) => {
              this._newProject = project;
            },
          )}
        </div>
        <div class="full">
          ${this._renderTargetProjectPicker(
            'Target projects',
            'roadmap-new-target-projects',
            this._newTargetProjects,
            (projects) => {
              this._newTargetProjectsTouched = true;
              this._newTargetProjects = projects;
            },
          )}
        </div>
        <label class="full"
          >Title
          <input
            data-testid="roadmap-new-title"
            placeholder="Optional; first rough-idea line is used when blank"
            .value=${this._newTitle}
            @input=${(e: Event) => (this._newTitle = (e.target as HTMLInputElement).value)}
          />
        </label>
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
          class="idea"
          .value=${this._newBody}
          placeholder="Paste the rough task idea, links, constraints, and desired backlog splits here."
          @input=${(e: Event) => (this._newBody = (e.target as HTMLTextAreaElement).value)}
        ></textarea>
      </label>
      <div class="actions" style="margin-top: 10px;">
        <button
          data-testid="roadmap-create"
          ?disabled=${this._busy === 'create' || !this._newTitleForSubmit()}
        >
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
      <div class="field full">
        Project
        ${renderChoiceButtons({
          options: ['all', ...this._projects],
          value: this._filterProject,
          onSelect: (project) => {
            this._filterProject = project;
            void this._refresh();
          },
          labels: { all: 'All projects' },
          testId: 'roadmap-filter-project',
        })}
      </div>
      <div class="field full">
        Stage
        ${renderChoiceButtons({
          options: STAGES,
          value: this._filterStage,
          onSelect: (stage) => {
            this._filterStage = stage;
            void this._refresh();
          },
          testId: 'roadmap-filter-stage',
        })}
      </div>
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
      role="button"
      tabindex="0"
      @click=${() => this._selectItem(item)}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this._selectItem(item);
        }
      }}
    >
      ${renderPlanningBadge(item.stage, statusTone(item.stage))}
      <span data-testid="roadmap-project">${renderPlanningBadge(item.project)}</span>
      <span class="item-ref" title=${item.id}>${item.id}</span>
      <div class="title" title=${item.title}>${item.title}</div>
      ${item.promotion?.length
        ? renderPlanningBadge(
            `${item.promotion.length} backlog link${item.promotion.length === 1 ? '' : 's'}`,
            'positive',
          )
        : html`<span class="muted">—</span>`}
      <span class="updated-cell" title=${item.updatedAt}>${item.updatedAt.slice(0, 10)}</span>
    </div>`;
  }

  private _setSort(key: RoadmapSortKey) {
    if (this._sortKey === key) {
      this._sortDirection = this._sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this._sortKey = key;
      this._sortDirection = key === 'updated' || key === 'promotion' ? 'desc' : 'asc';
    }
    this._writeUrlState();
  }

  private _renderSortHeader(label: string, key: RoadmapSortKey) {
    const active = this._sortKey === key;
    const arrow = active ? (this._sortDirection === 'asc' ? ' ▲' : ' ▼') : '';
    return html`<button
      class=${active ? 'active' : ''}
      type="button"
      @click=${() => this._setSort(key)}
    >
      ${label}${arrow}
    </button>`;
  }

  private _renderTableHead() {
    return html`<div class="table-head" role="row">
      ${this._renderSortHeader('Stage', 'stage')} ${this._renderSortHeader('Project', 'project')}
      ${this._renderSortHeader('ID', 'id')} ${this._renderSortHeader('Title', 'title')}
      ${this._renderSortHeader('Backlog', 'promotion')}
      ${this._renderSortHeader('Updated', 'updated')}
    </div>`;
  }

  private _renderPromotionDraftCards(item: RoadmapItem) {
    const attachments = this._promotionAttachmentsForItem(item);
    return html`<div class="draft-card-grid" data-testid="roadmap-promotion-draft-cards">
      ${this._promotionDrafts.map((spec, index) => {
        const attachment = attachments[index];
        return html`<article class="draft-card">
          <div>
            <h3>${spec.title || `Draft ${index + 1}`}</h3>
            <p class="muted">${attachment?.virtualPath ?? `Draft ${index + 1}`}</p>
          </div>
          <div class="badges">
            ${renderPlanningBadge(spec.project || ROADMAP_UNASSIGNED_PROJECT)}
            ${renderPlanningBadge(`Draft ${index + 1}`)}
          </div>
          <div class="actions">
            <button
              type="button"
              data-testid=${`roadmap-promote-view-${index}`}
              @click=${() => this._openPromotionDraftModal(index, 'view')}
            >
              View
            </button>
            <button
              class="secondary"
              type="button"
              data-testid=${`roadmap-promote-edit-${index}`}
              @click=${() => this._openPromotionDraftModal(index, 'edit')}
            >
              Edit
            </button>
          </div>
        </article>`;
      })}
    </div>`;
  }

  private _renderPromotionEditor(item: RoadmapItem) {
    const parsedDraftCount = parsePromotionDraftsFromRoadmapBody(item.body).length;
    return html`<div class="card promotion-review">
      <div class="editor-head">
        <div>
          <h3>Review backlog drafts</h3>
          <p class="muted">
            Confirm these generated drafts, edit anything that is off, then promote them into real
            backlog items.
          </p>
          <div class="promotion-summary">
            ${renderPlanningBadge(
              `${this._promotionDrafts.length} draft${this._promotionDrafts.length === 1 ? '' : 's'}`,
              'positive',
            )}
            ${item.stage !== 'refined'
              ? renderPlanningBadge(`stage: ${item.stage}`, 'default')
              : nothing}
            ${parsedDraftCount ? renderPlanningBadge('from roadmap drafts', 'positive') : nothing}
            ${this._promotionDraftAttachments.length
              ? renderPlanningBadge('persisted attachments', 'positive')
              : nothing}
          </div>
        </div>
        <div class="actions">
          <button class="secondary" @click=${this._addPromotionSpec}>Add draft</button>
          <button class="secondary" @click=${() => this._setPromotionOpen(false)}>Close</button>
        </div>
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
      ${this._renderPromotionDraftCards(item)}
      <div class="actions" style="margin-top: 10px;">
        <button
          data-testid="roadmap-promote"
          ?disabled=${item.stage !== 'refined' || this._busy === 'promote'}
          @click=${this._promoteSelected}
        >
          Promote ${this._promotionDrafts.length}
          draft${this._promotionDrafts.length === 1 ? '' : 's'}
        </button>
      </div>
    </div>`;
  }

  private _renderEditorModeButtons() {
    return html`<button
      class="secondary"
      type="button"
      @click=${() => this._setEditorMode(this._editorMode === 'edit' ? 'view' : 'edit')}
    >
      ${this._editorMode === 'edit' ? 'Done' : 'Edit'}
    </button>`;
  }

  private _renderGraphComposer(item: RoadmapItem) {
    return item.promotion?.length
      ? html`<roadmap-graph-composer
          .item=${item}
          .backlogItems=${this._backlogItems}
          .workGraphs=${this._workGraphs}
          .tagsInput=${this._editTags}
          @roadmap-graph-message=${(event: CustomEvent<string>) => {
            this._message = event.detail;
            this._error = '';
          }}
          @roadmap-graph-error=${(event: CustomEvent<string>) => {
            this._error = event.detail;
            this._message = '';
          }}
        ></roadmap-graph-composer>`
      : nothing;
  }

  private _runsForRoadmapItem(item: RoadmapItem): Run[] {
    const seen = new Set<string>();
    const runs: Run[] = [];
    for (const entry of item.promotion ?? []) {
      const backlogItem = this._backlogItems.find(
        (candidate) => candidate.id === entry.backlogItemId,
      );
      if (!backlogItem) continue;
      const run = linkedRunForBacklogItem(this._runs, backlogItem);
      if (!run || seen.has(run.id)) continue;
      seen.add(run.id);
      runs.push(run);
    }
    return runs;
  }

  private _renderLinkedRuns(item: RoadmapItem) {
    const runs = this._runsForRoadmapItem(item);
    if (!runs.length) return nothing;
    return html`<div class="path-panel">
      <div class="editor-head">
        <div>
          <h3>Linked runs</h3>
          <p class="muted">Promoted backlog items with active or recent execution.</p>
        </div>
      </div>
      <div class="attachment-grid">
        ${runs.map(
          (run) =>
            html`<linked-run-summary .run=${run} label="Backlog run" compact>
            </linked-run-summary>`,
        )}
      </div>
    </div>`;
  }

  private _renderViewEditor(item: RoadmapItem) {
    return html`<div class="editor">
        <div class="editor-head">
          <div>
            <h2>${item.title}</h2>
            <p class="muted">${item.id} · ${item.filePath} · hash ${item.fileHash.slice(0, 8)}</p>
          </div>
          <div class="actions">
            ${this._renderEditorModeButtons()}
            <button
              class="secondary"
              data-testid="roadmap-prepare-prompt"
              title="Generate the refinement prompt file and mark this roadmap item as refining. This does not launch a runner."
              @click=${() => this._refineSelected(false)}
            >
              Prepare prompt
            </button>
            <button
              data-testid="roadmap-refine-runner"
              title="Choose a runner/model, then launch or attach the tmux refinement session for this roadmap item."
              @click=${() => this._openRunnerPicker()}
            >
              Refine with runner
            </button>
            ${item.stage === 'refined'
              ? html`<button
                  data-testid="roadmap-review-drafts"
                  title="Review the generated backlog draft attachments before promoting them into backlog items."
                  @click=${() => this._setPromotionOpen(true)}
                >
                  Review drafts
                </button>`
              : nothing}
          </div>
        </div>
        <div class="badges">
          ${renderPlanningBadge(
            item.stage,
            item.stage === 'refined' || item.stage === 'promoted' ? 'positive' : 'default',
          )}
          ${renderPlanningBadge(item.project)}
          ${(item.targetProjects ?? []).map((project) => renderPlanningBadge(project, 'positive'))}
          ${renderTagChips(item.tags)}
          ${item.promotion?.length
            ? renderPlanningBadge(
                `${item.promotion.length} backlog link${item.promotion.length === 1 ? '' : 's'}`,
                'positive',
              )
            : nothing}
          ${this._promotionDraftAttachments.length
            ? renderPlanningBadge(
                `${this._promotionDraftAttachments.length} draft attachment${this._promotionDraftAttachments.length === 1 ? '' : 's'}`,
                'positive',
              )
            : nothing}
        </div>
        ${this._renderLinkedRuns(item)} ${this._renderRefinementPromptPath(item)}
        ${this._renderDraftAttachmentSummary(item)}
        <pre class="body-view">${item.body || 'No roadmap body.'}</pre>
      </div>
      ${this._promotionOpen ? this._renderPromotionEditor(item) : nothing}
      ${this._renderGraphComposer(item)}`;
  }

  private _renderEditor() {
    const item = this._selected;
    if (!item) return html`<div class="card empty">Select or create a roadmap item.</div>`;
    if (this._editorMode === 'view') return this._renderViewEditor(item);
    return html`<div class="editor">
        <div class="editor-head">
          <div>
            <h2>Edit roadmap item</h2>
            <p class="muted">${item.id} · ${item.filePath} · hash ${item.fileHash.slice(0, 8)}</p>
          </div>
          <div class="actions">
            ${this._renderEditorModeButtons()}
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
              title="Generate the refinement prompt file and mark this roadmap item as refining. This does not launch a runner."
              @click=${() => this._refineSelected(false)}
            >
              Prepare prompt
            </button>
            <button
              data-testid="roadmap-refine-runner"
              title="Choose a runner/model, then launch or attach the tmux refinement session for this roadmap item."
              @click=${() => this._openRunnerPicker()}
            >
              Refine with runner
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
          <div class="full">
            ${this._renderProjectPicker(
              'Owner project',
              'roadmap-edit-project',
              this._editProject,
              (project) => {
                this._editProject = project;
              },
            )}
          </div>
          <div class="full">
            ${this._renderTargetProjectPicker(
              'Target projects',
              'roadmap-edit-target-projects',
              this._editTargetProjects,
              (projects) => {
                this._editTargetProjects = projects;
              },
            )}
          </div>
          <div class="field full">
            Stage
            ${renderChoiceButtons({
              options: ROADMAP_ITEM_STAGES,
              value: this._editStage,
              onSelect: (stage) => {
                this._editStage = stage;
              },
              testId: 'roadmap-edit-stage',
            })}
          </div>
          <label class="full"
            >Title
            <input
              data-testid="roadmap-edit-title"
              .value=${this._editTitle}
              @input=${(e: Event) => (this._editTitle = (e.target as HTMLInputElement).value)}
            />
          </label>
          <label
            >Tags
            <input
              data-testid="roadmap-edit-tags"
              .value=${this._editTags}
              @input=${(e: Event) => (this._editTags = (e.target as HTMLInputElement).value)}
            />
          </label>
        </div>
        ${this._renderRefinementPromptPath(item)}
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
      ${this._promotionOpen || item.stage === 'refined'
        ? this._renderPromotionEditor(item)
        : nothing}
      ${this._renderGraphComposer(item)}`;
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
      <div class="list-toolbar">
        <button
          type="button"
          @click=${() => {
            this._createPanelOpen = !this._createPanelOpen;
          }}
        >
          ${this._createPanelOpen ? 'Hide form' : 'New item'}
        </button>
      </div>
      ${this._createPanelOpen ? this._renderCreateForm() : nothing} ${this._renderFilters()}
      <div class="layout">
        <div class="card">
          <h2>Items (${this._items.length})</h2>
          <div class="rows">
            ${this._items.length === 0
              ? html`<div class="empty">No roadmap items match this view.</div>`
              : html`<div class="roadmap-table">
                  ${this._renderTableHead()} ${this._items.map((item) => this._renderRow(item))}
                </div>`}
          </div>
        </div>
        <div class="shell">${this._renderEditor()}</div>
      </div>
      ${this._renderRunnerPicker()} ${this._renderPromptViewer()}
      ${this._renderPromotionAttachmentViewer()}
      ${this._selected ? this._renderPromotionDraftModal(this._selected) : nothing}
    </section>`;
  }
}
