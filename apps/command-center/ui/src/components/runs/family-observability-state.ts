import { LitElement } from 'lit';
import { property, state } from 'lit/decorators.js';

import type {
  FamilyObservabilityArtifact,
  FamilyObservabilitySnapshot,
  FamilyReport,
  PRStatus,
  Run,
  RunStep,
  SlotStatus,
} from '@farmslot/protocol';

import type { MdFetchEntry } from '../../utils/markdown.js';
import { CopyFeedbackTimer } from '../shared/copy-feedback-model.js';
import type { LightboxPair } from '../shared/media-lightbox-types.js';

import type { CompareTab } from './family-observability-comparison-renderers.js';
import type { FamilyDiffModalState } from './family-observability-diff-modal.js';
import type { EvidenceMatrix } from './family-observability-evidence-matrix.js';
import type { FamilyEvidenceFilter } from './family-observability-evidence.js';
import type { GradeDraft } from './family-observability-grading.js';
import {
  FamilyImprovementProposalTracker,
  updateFamilyProposalError,
} from './family-observability-improvement-proposals.js';

export abstract class FamilyObservabilityState extends LitElement {
  abstract _applyDiffModalFromHash(): void;
  abstract _closeDiffModal(syncHash?: boolean): void;

  @property() familyId = '';
  @property() initialRunId = '';
  @property({ attribute: false }) snapshotOverride: FamilyObservabilitySnapshot | null = null;
  @property({ attribute: false }) fullRunOverrides: Run[] = [];
  @state() snapshot: FamilyObservabilitySnapshot | null = null;
  @state() report: FamilyReport | null = null;
  @state() selectedRunId = '';

  @state() loading = false;
  @state() reportLoading = false;
  @state() error = '';
  @state() brokenArtifacts: string[] = [];
  @state() _recipeView: 'graph' | 'json' = 'graph';
  @state() _lightboxOpen = false;
  @state() _lightboxIndex = 0;
  @state() _evidenceFilter: FamilyEvidenceFilter = 'all';
  // When step-artifact is clicked, scope the viewer to that step's artifacts
  // (instead of the family evidence subset). null = use the default scope.
  @state() _lightboxOverride: FamilyObservabilityArtifact[] | null = null;
  @state() _lightboxMode: 'single' | 'compare' = 'single';
  @state() _lightboxPairIndex = 0;
  // Cross-run evidence compare builds a pair that isn't part of the snapshot's
  // before/after pairs, so the override feeds it straight into compare mode.
  @state() _lightboxPairOverride: LightboxPair[] | null = null;
  @state() _compareTab: CompareTab = 'leaderboard';
  @state() _compareSortKey = 'score';
  @state() _fleetSlots: SlotStatus[] = [];
  @state() _prs: PRStatus[] = [];
  @state() _showRerunOutput = false;
  @state() _mdPreviewVersion = 0;
  @state() _editingRunId = '';
  @state() _gradeDraft: Map<string, GradeDraft> = new Map();
  @state() _submittingGradeFor = '';
  @state() _proposingFor: Set<string> = new Set();
  @state() _improvementModel = '';
  @state() _proposalElapsedTick = 0;
  @state() _gradeError = '';
  @state() _proposalError: Map<string, string> = new Map();
  @state() _copiedAction = '';
  @state() _selectedExperimentKey = '';
  /** Full {@link Run} payloads keyed by runId, lazy-loaded via `run.get` so the
   * retrospective view can render the same `<run-pipeline>` graph as `#run/...`. */
  @state() _fullRuns: Map<string, Run> = new Map();
  @state() _fullRunLoading: Set<string> = new Set();
  @state() _fullRunError: Map<string, string> = new Map();
  @state() _selectedStep: RunStep | null = null;
  @state() _diffModal: FamilyDiffModalState | null = null;
  _diffModalOpener: HTMLElement | null = null;
  @state() _replayingStep = false;
  @state() _replayError = '';
  _mdPreviewCache = new Map<string, MdFetchEntry<string>>();
  _pairsCache: {
    source: FamilyObservabilitySnapshot | null;
    pairs: LightboxPair[];
  } | null = null;
  _evidenceMatrixCache: {
    source: FamilyObservabilitySnapshot | null;
    matrix: EvidenceMatrix;
  } | null = null;
  _unsubState?: () => void;
  _unsubGateway?: () => void;
  _unsubDecisionEvent?: () => void;
  _unsubDecisionUpdated?: () => void;
  _unsubImprovementFail?: () => void;
  readonly _proposalTracker = new FamilyImprovementProposalTracker({
    getProposingFor: () => this._proposingFor,
    setProposingFor: (runIds) => {
      this._proposingFor = runIds;
    },
    setProposalError: (runId, message) => {
      this._proposalError = updateFamilyProposalError(this._proposalError, runId, message);
    },
    incrementElapsedTick: () => {
      this._proposalElapsedTick += 1;
    },
  });
  _suppressDiffHashSync = false;
  readonly _copyFeedback = new CopyFeedbackTimer({
    copiedKey: () => this._copiedAction,
    setCopiedKey: (key) => {
      this._copiedAction = key;
    },
  });
  _onModalKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this._diffModal) {
      // Stop the lightbox (rendered as a sibling) from also reacting to the
      // same Escape — without this both modals close on a single press.
      e.stopPropagation();
      this._closeDiffModal();
    }
  };
}
