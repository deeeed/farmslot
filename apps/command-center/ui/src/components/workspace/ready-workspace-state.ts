import { LitElement } from 'lit';
import { property, state } from 'lit/decorators.js';

import type {
  GitBranchDiffFile,
  PublicationTarget,
  RecipeRunArtifactGroup,
  Run,
  RunDecision,
} from '@farmslot/protocol';

import { type RecoveryPhase } from '../../utils/reconnect.js';
import { ConfirmActionTimer } from '../shared/confirm-action-model.js';

import type { ReviewLoopDraft } from './ready-workspace-modal-renderers.js';
import { VerticalSplitResizer } from './vertical-split-resizer.js';
import type { ArtifactFilter, ArtifactTypeFilter } from './workspace-artifacts.js';
import {
  recipeRunnerUiOptions,
  type RecipeRunnerUiOptions,
} from './recipe-runner-options-model.js';
import type { ReadyWorkspaceTab } from './workspace-url-state.js';

type TabId = ReadyWorkspaceTab;

export abstract class ReadyWorkspaceState extends LitElement {
  abstract _closeReviewRequestModal(): void;
  abstract _readViewStateFromHash(): void;

  // Light DOM so diff-review (diff2html) renders correctly inside shadow hosts
  protected override createRenderRoot() {
    return this;
  }

  @property() runId = '';
  @property({ attribute: false }) decision!: RunDecision;
  @property({ attribute: false }) run: Run | null = null;
  @property() slotId = '';
  @property() branch = '';
  @property() runner = '';
  @property({ type: Boolean, attribute: 'mock-data' }) mockData = false;
  @property({ type: Boolean }) hideRecipeTab = false;
  @property({ attribute: false }) recipeRuns: RecipeRunArtifactGroup[] = [];
  @property() selectedRecipeRunId = '';

  @state() _recipeRunnerUiOptions: RecipeRunnerUiOptions = recipeRunnerUiOptions(null);

  @state() _acting = false;
  @state() _pendingConfirm: string | null = null;
  @state() _actionMessage = '';
  @state() _actionTone: 'success' | 'error' | '' = '';
  @state() _refreshingPackage = false;
  @state() _publicationTarget: PublicationTarget = 'ready';
  @state() _reviewModalOpen = false;
  @state() _reviewLoops: ReviewLoopDraft[] = [{ id: 1, runner: '' }];
  @state() _inputArtifactViewerOpen = false;
  @state() _selectedInputArtifactId = '';
  @state() _legacyTaskPromptText = '';
  @state() _legacyTaskPromptLoading = false;
  @state() _legacyTaskPromptError = '';
  _nextReviewLoopId = 2;
  @state() _packagePanelExpanded = false;
  @state() _recipePackageEvidenceCollapsed = false;
  @state() _defaultPackageTabSelected = false;
  @state() _artifactFilter: ArtifactFilter = 'all';
  @state() _artifactTypeFilter: ArtifactTypeFilter = 'all';
  @state() _lightboxOpen = false;
  @state() _lightboxIndex = 0;
  @state() _lightboxMode: 'single' | 'compare' = 'single';
  @state() _lightboxPairIndex = 0;
  @state() _lightboxScopePaths: string[] | null = null;
  @state() _lightboxScopeLabel = '';
  @state() _lightboxRecipeRunId: string | null = null;
  @state() _diffModalOpen = false;
  @state() _diffModalTitle = 'Diff';
  @state() _diffModalText = '';
  @state() _diffModalUrl = '';
  @state() _diffModalArtifactPath = '';
  readonly _confirmTimer = new ConfirmActionTimer({
    pendingConfirm: () => this._pendingConfirm,
    setPendingConfirm: (pending) => {
      this._pendingConfirm = pending;
    },
  });
  readonly _boundKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (this._reviewModalOpen) {
      event.preventDefault();
      this._closeReviewRequestModal();
    }
  };

  // Tabs
  @state() _activeTab: TabId = 'diff';
  @state() _recipeView: 'graph' | 'json' = 'graph';

  // Diff state
  @state() _diffFiles: GitBranchDiffFile[] = [];
  @state() _diffLoading = false;
  @state() _selectedFile = '';
  @state() _fileDiff = '';
  @state() _fileDiffLoading = false;
  @state() _diffError = '';
  @state() _recoveryPhase: RecoveryPhase = 'live';
  @state() _recoveryMessage = '';

  // Resize
  @state() _splitPct = 35;
  readonly _splitResizer = new VerticalSplitResizer({
    getSplitPct: () => this._splitPct,
    setSplitPct: (next) => {
      this._splitPct = next;
    },
    getContainer: () => this.querySelector('.rdy-split') as HTMLElement | null,
  });

  _initialized = false;
  _recoveryEpoch = 0;
  _unsubConn?: () => void;
  _publicationTargetKey = '';
  _evidenceSelectionKey = '';
  @state() _selectedEvidenceKeys: string[] | null = null;
  _decisionActionStateKey = '';
  _hashTabRequested = false;
  _suppressHashSync = false;
  _boundHashChange = () => this._readViewStateFromHash();
}
