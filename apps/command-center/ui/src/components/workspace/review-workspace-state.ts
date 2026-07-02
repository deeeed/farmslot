import { LitElement } from 'lit';
import { property, state } from 'lit/decorators.js';

import type { GitBranchDiffFile, RunDecision } from '@farmslot/protocol';

import { type RecoveryPhase } from '../../utils/reconnect.js';
import { ConfirmActionTimer } from '../shared/confirm-action-model.js';

import { VerticalSplitResizer } from './vertical-split-resizer.js';
import {
  parseReviewWorkspaceHashState,
  type ReviewWorkspaceTab,
  writeReviewWorkspaceHashState,
} from './workspace-url-state.js';

export abstract class ReviewWorkspaceState extends LitElement {
  // Light DOM so code-viewer (Monaco) and diff-review (diff2html) render correctly
  protected override createRenderRoot() {
    return this;
  }

  @property() runId = '';
  @property({ attribute: false }) decision!: RunDecision;
  @property() slotId = '';
  @property() branch = ''; // expected branch from the run
  @property() slotBranch = ''; // current slot branch (from slot-view's _liveGitData) — skips redundant git.status when provided

  @state() _includedComments = new Set<number>();
  @state() _selectedRecommendation = '';
  @state() _posting = false;
  @state() _refreshing = false;
  @state() _proposing = false;
  @state() _proposeError: string | null = null;
  @state() _pendingConfirm: string | null = null;
  readonly _confirmTimer = new ConfirmActionTimer({
    pendingConfirm: () => this._pendingConfirm,
    setPendingConfirm: (pending) => {
      this._pendingConfirm = pending;
    },
  });

  // Branch diff state
  @state() _diffFiles: GitBranchDiffFile[] = [];
  @state() _diffLoading = false;
  // Guards _beginRecovery against double-fire from willUpdate + updated.
  _recoveryInFlight = false;
  @state() _selectedFile = '';
  @state() _fileDiff = '';
  @state() _fileDiffLoading = false;
  @state() _selectedCommentIdx = -1;
  @state() _commentFileContent = '';
  @state() _commentFileLoading = false;
  @state() _revealLine = 0;
  @state() _recoveryPhase: RecoveryPhase = 'live';
  @state() _recoveryMessage = '';

  // Branch mismatch state
  @state() _slotBranch = '';
  @state() _branchMismatch = false;
  @state() _checkingOut = false;

  @state() _activeTab: ReviewWorkspaceTab = 'review';

  _syncTabToHash() {
    writeReviewWorkspaceHashState({ tab: this._activeTab });
  }

  _readTabFromHash() {
    const { tab } = parseReviewWorkspaceHashState();
    if (tab) this._activeTab = tab;
  }

  _setActiveTab(tab: ReviewWorkspaceTab) {
    this._activeTab = tab;
    this._syncTabToHash();
  }

  @state() _recipeView: 'graph' | 'json' = 'graph';
  @state() _recipeRunning = false;
  @state() _evidenceOverrides = new Map<string, string>();
  @state() _lightboxOpen = false;
  @state() _lightboxIndex = 0;
  @state() _diffModalOpen = false;
  @state() _diffModalTitle = 'Review input diff';
  @state() _diffModalUrl = '';
  @state() _splitPct = 50; // review takes this % of available height
  readonly _splitResizer = new VerticalSplitResizer({
    getSplitPct: () => this._splitPct,
    setSplitPct: (next) => {
      this._splitPct = next;
    },
    getContainer: () => this.querySelector('.rw-split') as HTMLElement | null,
  });

  _initialized = false;
  _recoveryEpoch = 0;
}
