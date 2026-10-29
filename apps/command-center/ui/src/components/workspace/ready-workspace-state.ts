import { LitElement } from 'lit';
import { property, state } from 'lit/decorators.js';

import type {
  GitBranchDiffFile,
  PublicationTarget,
  RecipeRunArtifactGroup,
  ResourcePostureGateChoice,
  Run,
  RunDecision,
} from '@farmslot/protocol';
import { CriterionDraftModel, ReviewDispatchViewModel } from '@farmslot/review-dispatch';

import { type RecoveryPhase } from '../../utils/reconnect.js';
import { ConfirmActionTimer } from '../shared/confirm-action-model.js';
import type { EvidenceReviewerSelection } from '../shared/evidence-reviewer.js';

import {
  type RecipeRunnerUiOptions,
  recipeRunnerUiOptions,
} from './recipe-runner-options-model.js';
import { VerticalSplitResizer } from './vertical-split-resizer.js';
import type { ArtifactFilter, ArtifactTypeFilter } from './workspace-artifacts.js';
import type { ReadyWorkspaceTab } from './workspace-url-state.js';

type TabId = ReadyWorkspaceTab;

export abstract class ReadyWorkspaceState extends LitElement {
  abstract _closeReviewRequestModal(): void;
  abstract _closeDiffModal(): void;
  abstract _readViewStateFromHash(): void;

  // Light DOM so diff-review (diff2html) renders correctly inside shadow hosts
  protected override createRenderRoot() {
    return this;
  }

  @property() runId = '';
  @property({ type: Boolean }) actionsBlocked = false;
  @property() loadError = '';
  get _packagePending(): boolean {
    const payload = this.decision?.payload;
    return (
      payload?.kind === 'ready' &&
      !payload.prPackage &&
      Boolean(this.decision?.payloadTrimmed?.includes('prPackage'))
    );
  }
  @property({ attribute: false }) decision!: RunDecision;
  @property({ attribute: false }) run: Run | null = null;
  @property() slotId = '';
  @property() branch = '';
  @property() runner = '';
  @property({ type: Boolean, attribute: 'mock-data' }) mockData = false;
  @property({ type: Boolean }) hideRecipeTab = false;
  @property({ attribute: false }) recipeRuns: RecipeRunArtifactGroup[] = [];
  @property() selectedRecipeRunId = '';
  /**
   * Operator resource-posture choice for this wait (ADR-054), supplied by the
   * gate section that mounts this workspace. Sent as the typed
   * `resourcePosture` param so this client never invents a cleanup policy.
   */
  @property({ attribute: false }) resourcePosture: ResourcePostureGateChoice | null = null;
  /** Why the posture choice blocks resolution, or null. Disables resolve actions. */
  @property({ attribute: false }) postureBlockedReason: string | null = null;

  @state() _recipeRunnerUiOptions: RecipeRunnerUiOptions = recipeRunnerUiOptions(null);

  @state() _acting = false;
  @state() _pendingConfirm: string | null = null;
  @state() _evidenceAttestationReason = '';
  readonly _criterionDrafts = new CriterionDraftModel({
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
  });
  @state() _actionMessage = '';
  @state() _actionTone: 'success' | 'error' | '' = '';
  @state() _refreshingPackage = false;
  @state() _publicationTarget: PublicationTarget = 'ready';
  @state() _reviewModalOpen = false;
  _reviewPicker = new ReviewDispatchViewModel({
    context: { allowedActions: ['request-review'], allowSequence: true },
  });
  @state() _inputArtifactViewerOpen = false;
  @state() _selectedInputArtifactId = '';
  @state() _legacyTaskPromptText = '';
  @state() _legacyTaskPromptLoading = false;
  @state() _legacyTaskPromptError = '';
  @state() _packagePanelExpanded = false;
  @state() _recipePackageEvidenceCollapsed = false;
  @state() _defaultPackageTabSelected = false;
  @state() _artifactFilter: ArtifactFilter = 'all';
  @state() _artifactTypeFilter: ArtifactTypeFilter = 'all';
  @state() _lightboxOpen = false;
  /** The criterion evidence review open over the gate. */
  @state() _review: EvidenceReviewerSelection | null = null;
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
  /** Shown in place of a diff that could not be shown, such as one that failed verification. */
  @state() _diffModalNotice = '';
  @state() _diffModalArtifactPath = '';
  readonly _confirmTimer = new ConfirmActionTimer({
    pendingConfirm: () => this._pendingConfirm,
    setPendingConfirm: (pending) => {
      this._pendingConfirm = pending;
    },
  });
  hasOpenOverlay(): boolean {
    return (
      this._diffModalOpen ||
      this._reviewModalOpen ||
      this._lightboxOpen ||
      this._inputArtifactViewerOpen ||
      this._review !== null
    );
  }

  readonly _boundKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (this._diffModalOpen) {
      event.preventDefault();
      this._closeDiffModal();
    } else if (this._reviewModalOpen) {
      event.preventDefault();
      this._closeReviewRequestModal();
    }
  };

  // Tabs
  @state() _activeTab: TabId = 'diff';
  @state() _recipeView: 'graph' | 'json' = 'graph';

  // Diff state
  @state() _diffFiles: GitBranchDiffFile[] = [];
  /** Effective test-file globs from the last branch diff (Diff tab filter and diff modal). */
  @state() _diffTestPatterns: readonly string[] | null = null;
  @state() _branchDiffLoaded = false;
  @state() _diffLoading = false;
  @state() _selectedFile = '';
  @state() _fileDiff = '';
  @state() _fileDiffLoading = false;
  @state() _fileDiffError = '';
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
  // A pasted review link changes no tab state; the update still restores it.
  _boundHashChange = () => {
    this._readViewStateFromHash();
    this.requestUpdate();
  };
}
