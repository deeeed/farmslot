import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import {
  createEvidenceReviewModel,
  type EvidenceReviewModel,
  readEvidenceReviewReport,
  runEvidencePending,
} from '@farmslot/adapter-sdk/evidence';
import type {
  DevInteractiveCompletionAction,
  FamilyObservabilityArtifact,
  PRStatus,
  PRStatusResult,
  ResourcePostureGateChoice,
  Run,
  RunDecision,
  RunGetResult,
  RunListResult,
  RunRecipeRunsForRunParams,
  RunRecipeRunsForRunResult,
  RunRereviewLatestHeadResult,
  RunResolveDecisionResult,
  RunSessionCommandResult,
  RuntimePosturePreviewResult,
  RuntimePostureStatusResult,
  SlotStatus,
  TaskProgressResult,
} from '@farmslot/protocol';
import { validVisualJudgmentReason } from '@farmslot/protocol';
import {
  buildRunResolveDecisionParams,
  cancelledRunSlotChoices,
  liveGateParkView,
  Methods,
  sortRunsForFamilyView,
} from '@farmslot/protocol';
import { resourceQuery, type ResourceQueryState } from '@farmslot/protocol/client-cache';
import { pendingOutputReview, type VisualJudgmentFeedback } from '@farmslot/review-dispatch';

import './native-worker-history.js';
import './failure-triage-panel.js';
import './decision-advice-panel.js';
import './step-inspector.js';
import './blocked-run-recovery.js';
import './run-pipeline-mini.js';
import './run-tag-editor.js';
import '../shared/evidence-reviewer.js';
import '../shared/media-lightbox.js';
import '../shared/step-artifacts.js';
import '../workspace/review-workspace.js';
import '../workspace/ready-workspace.js';
import '../terminal/terminal-view.js';
import '../shared/hydrating-placeholder.js';
import '../shared/source-status-panel.js';
import '../shared/slot-prepare-popover.js';
import '../interactive/interactive-operator-packets.js';

import { gateway } from '../../gateway-client.js';
import { getResourceWorkspaceKey } from '../../resource-cache.js';
import { type AppState, getState, subscribe } from '../../state.js';
import { copyTextToClipboard } from '../../utils/clipboard.js';
import { gatewayHttpFetch } from '../../utils/gateway-origin.js';
import { hashParams } from '../../utils/url-state.js';
import {
  type AcceptanceEvidenceOpen,
  runAcceptanceCriterionEvidence,
} from '../progress-tracker/acceptance-panel.js';
import {
  type EvidenceReviewerSelection,
  evidenceReviewerSelection,
} from '../shared/evidence-reviewer.js';
import {
  type EvidenceReviewerView,
  evidenceReviewerViewFromHash,
  evidenceReviewerViewKey,
  writeEvidenceReviewerHash,
} from '../shared/evidence-reviewer-url-state.js';
import type { LightboxItem } from '../shared/media-lightbox-types.js';
import { ResourceQueryController } from '../shared/resource-query-controller.js';
import type { RecipeCompleteDetail } from '../workspace/recipe-output-panel.js';
import { recipeRunArtifactUrl, runArtifactUrl } from '../workspace/workspace-artifacts.js';
import type { WorkspaceEvidenceComparison } from '../workspace/workspace-evidence-preview.js';

import { CIWatchPokeController } from './ci-watch-actions.js';
import {
  checkInteractiveHandoffSignal,
  confirmForceComplete,
  confirmRunDecision,
  confirmRunLifecycleAction,
  jumpToSuccessorWhenAvailable,
  rescueRunLinkage,
  resolveBranchNudgePick,
  resolveInteractiveDevAction,
  resolveSlotPick,
  resumeStoppedNativeWorker,
} from './run-detail-actions.js';
import { renderRunCiStatus } from './run-detail-ci-status-renderer.js';
import { renderRunGateSection, runMountsPublicationGate } from './run-detail-decision-renderers.js';
import {
  acceptanceEvidenceSelection,
  buildRerunAlongsideHref,
  buildRunDiagnosisPrompt,
  type EvidenceLightboxSelection,
  isLiveTimeoutPrStatusAllGreen,
  isRunWorking,
  pendingCITimeoutDecision,
  persistedCiStatusFromRun,
  readCiWatchOutputs,
  resolveEvidenceLightboxLink,
  runArtifactsWithOperationLogs,
  runDetailDesiredRecipeRunId,
  runFamilyPrStatus,
  runOutputEvidenceSelection,
  shouldShowRunCiStatus,
} from './run-detail-model.js';
import {
  canResolveWithPostureChoice,
  correlatedPostureTransition,
  isTerminalPostureOutcome,
  pendingDecisionKey,
  POSTURE_TRANSITION_POLL_INTERVAL_MS,
  POSTURE_TRANSITION_POLL_LIMIT,
  postureChoiceBecameInapplicable,
  postureChoiceForResolve,
  postureChoicesApply,
  postureChoiceWithheldReason,
  postureGateWithAdoptedTransition,
  postureGateWithSelection,
  postureResolveBlockReason,
  postureTransitionAttributed,
  postureTransitionBaseline,
  type PostureTransitionObservation,
  postureTransitionsOf,
  type RunPostureGateStateWithAvailability,
} from './run-detail-posture-gate-renderers.js';
import { renderRunPostureSummary } from './run-detail-posture-renderers.js';
import {
  renderInteractiveDevGate,
  renderRunDetailView,
  renderRunEvidence,
  renderRunGrade,
} from './run-detail-renderers.js';
import { openRunnerSessionOnHost } from './run-detail-session-open.js';
import {
  renderRunAgentSessions,
  runSessionCommandTextForKind,
  type RunSessionCopyKind,
  type RunSessionRow,
  runSessionRowStateFromResult,
} from './run-detail-session-renderers.js';
import { RunDetailState } from './run-detail-state.js';
import { runDetailStyles } from './run-detail-styles.js';
import {
  artifactSelectionFromRunDetailHash,
  GALLERY_ARTIFACT_VIEW,
  isRunDetailHashForRun,
  runDetailEvidenceArtifactHash,
  runDetailStepHash,
  runInventoryHashFromDetail,
  selectedStepNameFromRunDetailHash,
  STEP_ARTIFACT_VIEW,
} from './run-detail-url-state.js';
import { RunDisplayResolutions } from './run-display-resolutions.js';
import { publicationReviewStepForName } from './run-pipeline-model.js';
import { collectRunInteractivePacketArtifacts } from './run-utils.js';

@customElement('run-detail')
export class RunDetail extends RunDetailState {
  private readonly _displayResolutions = new RunDisplayResolutions();
  @state() private _runObservation: ResourceQueryState<RunGetResult> = { status: 'loading' };
  @state() private _recipeObservation: ResourceQueryState<RunRecipeRunsForRunResult> = {
    status: 'loading',
  };
  @state() private _progressObservation: ResourceQueryState<TaskProgressResult> = {
    status: 'loading',
  };
  @state() private _selectedProgressObservation: ResourceQueryState<TaskProgressResult> = {
    status: 'loading',
  };
  private _viewWorkspaceKey?: string;
  private _viewVersion = 0;
  private _viewConnectionId?: string | number;
  private _recipeRequestedId = '';
  private readonly detailQuery = new ResourceQueryController<RunGetResult>(this, (state) => {
    this._runObservation = state;
  });
  @state() private _snapshotObservation: ResourceQueryState<RunGetResult> = { status: 'loading' };
  private readonly snapshotQuery = new ResourceQueryController<RunGetResult>(this, (state) => {
    this._snapshotObservation = state;
  });
  private readonly recipeQuery = new ResourceQueryController<RunRecipeRunsForRunResult>(
    this,
    (state) => {
      this._recipeObservation = state;
    },
  );
  private readonly siblingQuery = new ResourceQueryController<RunListResult>(this, (state) => {
    this.siblings = sortRunsForFamilyView(
      (state.data?.runs ?? []).filter((run) => run.id !== this.runId),
    );
  });
  private readonly progressQuery = new ResourceQueryController<TaskProgressResult>(
    this,
    (state) => {
      this._progressObservation = state;
    },
  );
  private readonly selectedProgressQuery = new ResourceQueryController<TaskProgressResult>(
    this,
    (state) => {
      this._selectedProgressObservation = state;
    },
  );
  @state() evidenceModel: EvidenceReviewModel | null = null;
  @state() private _recordedEvidence: RunRecipeRunsForRunResult['recordedEvidence'] = undefined;
  @state() private _visualReviewReasons: Record<string, string> = {};
  @state() private _visualReviewBusy = false;
  @state() private _visualReviewFeedback?: VisualJudgmentFeedback;
  @state() private _visualReviewMessage = '';
  private _visualReviewScope = '';
  private _evidenceGroupId: string | null = null;
  private _evidenceTaskRelative = true;
  private _sharedPanelFocusKey = '';

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (
      ['runId', 'mockData', 'mockRun', '_runObservation', '_snapshotObservation'].some((key) =>
        changed.has(key),
      )
    ) {
      this.syncRun(getState());
    }
    if (changed.has('_recipeObservation')) this._acceptRecipeObservation(this._recipeObservation);
    if (changed.has('_progressObservation')) this._acceptProgressObservation();
    if (changed.has('_selectedProgressObservation')) this._acceptSelectedProgressObservation();
    if (
      [
        'run',
        '_runObservation',
        '_recipeObservation',
        '_recordedEvidence',
        'acceptanceStatus',
        'acceptanceCriteria',
        'acceptanceEvidenceLinks',
      ].some((key) => changed.has(key))
    ) {
      const output = pendingOutputReview(this.run);
      const scope = JSON.stringify([
        this.run?.id,
        this._recordedEvidence?.input?.claims?.recipeRunId,
        this._recordedEvidence?.visualReviewContext?.snapshotIdentity,
      ]);
      if (scope !== this._visualReviewScope) {
        this._visualReviewScope = scope;
        this._visualReviewReasons = {};
        this._visualReviewMessage = '';
        if (!this._visualReviewBusy) this._visualReviewFeedback = undefined;
      }
      this.evidenceModel = createEvidenceReviewModel({
        context: output ? 'gate' : 'run-detail',
        gateDecision: output,
        artifacts: this._recordedEvidence?.report?.artifactManifest,
        comparisonSnapshot: this._recordedEvidence?.comparisonSnapshot,
        criterionSourceUrl: this.run?.links?.find((link) => link.label === 'Jira')?.url,
        package: this._recordedEvidence?.input,
        contractVersion: this._recordedEvidence?.contractVersion,
        claimOverrideAuthority: this._recordedEvidence?.claimOverrideAuthority,
        visualReviewAuthority: this._recordedEvidence?.visualReviewAuthority,
        visualReviewContext: this._recordedEvidence?.visualReviewContext,
        readErrors: this._recordedEvidence?.errors,
        evidencePending: this.run ? runEvidencePending(this.run) : false,
        artifactPrefix: this._recordedEvidence?.artifactPrefix,
        packagePath: this._recordedEvidence?.packagePath,
        ledger: this.acceptanceStatus,
        criteria: this.acceptanceCriteria ?? undefined,
        evidenceLinks: this.acceptanceEvidenceLinks ?? undefined,
        report: this._recordedEvidence?.report,
        reportSnapshot: output?.payload?.kind === 'output-review' ? output.payload : undefined,
      });
    }
  }
  static styles = runDetailStyles;

  private readonly _ciPoke = new CIWatchPokeController((state) => {
    this._ciPoking = state.poking;
    this._ciPokeStatus = state.status;
  });

  connectedCallback() {
    super.connectedCallback();
    this._syncState(getState());
    window.addEventListener('hashchange', this._onHashChange);
    this.unsub = subscribe((s) => this._syncState(s));
    this._clock = setInterval(() => {
      this._now = Date.now();
      this._maybeRefreshLiveTimeoutPrStatus();
    }, 1000);
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (
      changed.has('_selectedRecipeRunId') &&
      this.run &&
      this._selectedRecipeRunId &&
      this._selectedRecipeRunId !== this._evidenceGroupId
    ) {
      this._recipeRequestedId = this._selectedRecipeRunId;
      this._bindRecipeRuns(this.run);
    }
    // The direct run.get snapshot may arrive after hashchange and after the
    // trimmed inventory snapshot. Apply the URL again when artifacts hydrate.
    if (
      changed.has('run') ||
      changed.has('taskProgress') ||
      changed.has('selectedStepProgress') ||
      changed.has('acceptanceStatus') ||
      changed.has('acceptanceCriteria') ||
      changed.has('acceptanceEvidenceLinks') ||
      changed.has('_taskProgressLoading')
    )
      this._applyEvidenceArtifactFromHash(true);
    // The CI watcher persists each poll on the run before announcing it; the shared run owns it.
    if (changed.has('run') && this.run) {
      const ciStep = this.run.steps.find((step) => step.name === 'ci-watch');
      const pollCount = readCiWatchOutputs(ciStep?.outputs)?.pollCount;
      this._ciPoke.observePoll(this.run.id, typeof pollCount === 'number' ? pollCount : null);
    }
    this._focusSharedPanel();
  }

  private _focusSharedPanel() {
    if (!this.run || !isRunDetailHashForRun(this.run.id)) return;
    const panel = hashParams().get('panel');
    if (panel !== 'timeline' && panel !== 'evidence') return;
    const key = `${this.run.id}:${panel}`;
    if (key === this._sharedPanelFocusKey) return;
    const target = this.renderRoot.querySelector(`[data-shared-run-panel="${panel}"]`);
    if (!(target instanceof HTMLElement) || !target.getBoundingClientRect().height) return;
    this._sharedPanelFocusKey = key;
    target.scrollIntoView({ block: 'start' });
    target.focus({ preventScroll: true });
  }

  disconnectedCallback() {
    this._viewVersion++;
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this._onHashChange);
    this.unsub?.();
    if (this._clock) clearInterval(this._clock);
    if (this._jumpTimer) clearTimeout(this._jumpTimer);
    this._ciPoke.dispose();
  }

  /** Fleet slots, so a released or reclaimed slot re-renders the run's slot choices. */
  @state() private _fleetSlots: readonly SlotStatus[] = [];

  private _syncState(s: AppState) {
    this._fleetSlots = s.fleet?.slots ?? [];
    this.syncRun(s);
  }

  private syncRun(s: AppState) {
    if (this.mockData && this.mockRun) {
      const prev = this.run;
      this.progressQuery.setQuery(undefined);
      this.selectedProgressQuery.setQuery(undefined);
      this._hydrating = false;
      this._bootstrapFailed = false;
      this._connectionStale = false;
      this._directRunUnavailable = false;
      this._directRunRefreshFailed = false;
      this._directRunRefreshing = false;
      this.run = this.mockRun;
      this.prStatus = runFamilyPrStatus(this.run, [this.run, ...s.runs], s.prs ?? []);
      if (prev?.id !== this.run.id) this._applySelectedStepFromHash();
      return;
    }
    const prev = this.run;
    const workspaceKey = getResourceWorkspaceKey();
    const viewChanged =
      this.runId !== this._lastRequestedRunId ||
      this._viewWorkspaceKey !== workspaceKey ||
      this._viewConnectionId !== gateway.resourceConnectionId;
    if (viewChanged) {
      this._viewConnectionId = gateway.resourceConnectionId;
      this._viewVersion++;
      this._viewWorkspaceKey = workspaceKey;
      this._visualReviewFeedback = undefined;
      this._lastRequestedRunId = this.runId;
      this.selectedStep = null;
      this._evidenceLightboxOpen = false;
      this._evidenceLightboxItems = [];
      this._evidenceArtifactUnavailable = null;
      this._evidenceGallery = false;
      this._publicationActions = {};
      this._visualReviewReasons = {};
      this._visualReviewMessage = '';
      this._outputError = '';
      this._closingOutput = false;
      this._refreshingOutput = false;
      this._visualReviewBusy = false;
      this._rereviewInFlight = false;
      this._showTerminal = false;
      this._liveTimeoutRequestSeq++;
      this._liveTimeoutKey = '';
      this.liveTimeoutPrStatus = null;
      this.liveTimeoutPrStatusRefreshing = false;
      this.liveTimeoutPrStatusFailed = false;
      this._autoResolvedTimeoutDecisionIds.clear();
      // Copied/error/liveness state belongs to the run it was fetched for.
      // Carrying it across would label the next run's contexts with the
      // previous run's liveness.
      this._sessionStates = {};
      this._sessionRequestSeq = {};
      this._terminalContextId = '';
      this._terminalRole = '';
      this._triageDecisionLink = null;
      this._decisionResolveError = null;
      this._ciPoke.reset();
      this._directRunRefreshFailed = false;
      this._directRunUnavailable = false;
      this._directRunRefreshing = false;
      this._taskProgressLoading = false;
      this.taskProgress = null;
      this.acceptanceStatus = null;
      this.acceptanceCriteria = null;
      this.acceptanceStatusError = null;
      this.acceptanceEvidenceLinks = null;
      this.acceptanceEvidenceLinksError = null;
      this.selectedStepProgress = null;
      this.siblings = [];
      this._resetRecipeRuns();
      this._handoffSignalCheckBusy = false;
      this._handoffSignalCheckError = null;
      // Posture belongs to the run it was read for; carrying it across would
      // describe the previous run's providers under this run's id.
      this._postureStatus = { status: 'idle' };
      this._resetPostureGate();
      this._postureStatusKey = '';
      this._postureStatusRequestSeq++;
    }
    this.detailQuery.setQuery(
      this.runId ? resourceQuery<RunGetResult>(Methods.RUN_GET, { runId: this.runId }) : undefined,
    );
    const observation: ResourceQueryState<RunGetResult> = this.detailQuery.belongsToWorkspace
      ? this.detailQuery.state
      : { status: 'loading' };
    this._hydrating = observation.status === 'loading' && !observation.data;
    this._bootstrapFailed = Boolean(observation.error);
    this._connectionStale = !this.detailQuery.ready;
    this._directRunRefreshing =
      gateway.connectionState === 'connected' &&
      (observation.status === 'loading' || (observation.status === 'stale' && !observation.error));
    this._directRunRefreshFailed = Boolean(observation.error);
    this._directRunUnavailable = observation.error?.code === 'RUN_NOT_FOUND';
    // Stored run facts render while run.get checks live gate prerequisites; only
    // the ordinary read is ready for actions (see _assertRunReady).
    this.snapshotQuery.setQuery(
      this.runId && !observation.data
        ? resourceQuery<RunGetResult>(Methods.RUN_GET, { runId: this.runId, view: 'snapshot' })
        : undefined,
    );
    const snapshotRun = this.snapshotQuery.belongsToWorkspace
      ? this.snapshotQuery.state.data?.run
      : undefined;
    const sharedRun = s.runs.find((run) => run.id === this.runId) ?? null;
    // Compact rows are placeholders while this query hydrates. Full detail and
    // its freshness belong solely to the authoritative run.get observation.
    const displayedRun =
      observation.data?.run ?? snapshotRun ?? (observation.status === 'loading' ? sharedRun : null);
    const decisions = this._displayResolutions.read(
      workspaceKey ? JSON.stringify([workspaceKey, this.runId]) : undefined,
      displayedRun?.decisions ?? [],
    );
    this.run =
      displayedRun && decisions !== displayedRun.decisions
        ? { ...displayedRun, decisions }
        : displayedRun;
    // Reset transient nudge-decision-card state when the bound run changes or when the
    // current `branch_affinity_nudge` decision has been resolved server-side. Without this,
    // _branchNudgeShowPicker / _selectedSlotId leak into the next decision render and the
    // operator clicks "Use <slot>" against a stale selection.
    const prevPendingNudge =
      prev?.decisions.find(
        (d) =>
          !d.resolvedAt &&
          (d.payload as { kind?: string } | undefined)?.kind === 'branch_affinity_nudge',
      ) ?? null;
    const currPendingNudge =
      this.run?.decisions.find(
        (d) =>
          !d.resolvedAt &&
          (d.payload as { kind?: string } | undefined)?.kind === 'branch_affinity_nudge',
      ) ?? null;
    const runChanged = prev?.id !== this.run?.id;
    const nudgeDecisionResolved =
      !!prevPendingNudge && (!currPendingNudge || currPendingNudge.id !== prevPendingNudge.id);
    if (runChanged || nudgeDecisionResolved) {
      this._branchNudgeShowPicker = false;
      this._selectedSlotId = null;
    }
    const runsForMeta = this.run
      ? [this.run, ...s.runs.filter((row) => row.id !== this.runId)]
      : s.runs;
    this.prStatus = this.run ? runFamilyPrStatus(this.run, runsForMeta, s.prs ?? []) : null;
    if (this.run && this.selectedStep) {
      this.selectedStep =
        this.run.steps.find((step) => step.name === this.selectedStep?.name) ??
        publicationReviewStepForName(this.run, this.selectedStep.name) ??
        this.selectedStep;
    }
    this._bindTaskProgress();
    // A saved/compact run can arrive before the full snapshot names the linked
    // step. Reapply the URL when that snapshot changes, even for the same run.
    if (this.run && (viewChanged || prev !== this.run)) {
      this._applySelectedStepFromHash();
    }
    this._loadSelectedStepProgress();
    if (this.run) {
      this.fetchSiblings(this.run);
      if (observation.data?.run) this._bindRecipeRuns(observation.data.run);
      else this.recipeQuery.setQuery(undefined);
    } else {
      this.siblingQuery.setQuery(undefined);
      this.recipeQuery.setQuery(undefined);
    }
    this._maybeRefreshLiveTimeoutPrStatus();
    this._maybeRefreshPostureStatus();
    this._maybeResetPostureGate();
    this._maybeClearInapplicablePostureChoice();
  }

  /**
   * The gate state plus the Gateway's persisted posture for this run, so the
   * choices are only offered where the Gateway would honour them. The posture
   * is read from `runtime.posture.status`, never inferred from run status.
   */
  private _postureGateStateForRender(): RunPostureGateStateWithAvailability {
    // Always set the key, even when unread. An absent property and an explicit
    // `undefined` mean the same thing to the guards, but only the explicit form
    // is enforceable, and the guards require it for exactly that reason.
    return { ...this._postureGate, runPosture: this._postureStatus.state?.posture };
  }

  /** Whether a preview response still belongs to the run and gate on screen. */
  private _previewStillCurrent(requestSeq: number, runId: string, gateKey: string): boolean {
    return (
      requestSeq === this._posturePreviewRequestSeq &&
      this.runId === runId &&
      this._postureGateKey === gateKey
    );
  }

  /**
   * Drop a held choice once the Gateway's posture leaves an operator wait.
   *
   * Without this the panel hides itself while the selection stays behind, and a
   * previously refused choice keeps `canResolveWithPostureChoice` false, so
   * Resolve silently does nothing with no control on screen to clear it.
   */
  private _maybeClearInapplicablePostureChoice(): void {
    if (!postureChoiceBecameInapplicable(this._postureGateStateForRender())) return;
    // Only the selection and its preview are stale; the resolution rides along.
    this._postureGate = postureGateWithSelection(this._postureGate, {
      choice: null,
      status: 'idle',
    });
    this._posturePreviewRequestSeq++;
  }

  /** Drop any in-flight or displayed preview; it belongs to the previous gate. */
  private _resetPostureGate(): void {
    this._postureGate = { choice: null, status: 'idle' };
    this._postureGateKey = '';
    this._posturePreviewRequestSeq++;
  }

  /**
   * A preview belongs to the exact set of decisions it was requested for. When
   * one is resolved elsewhere and another opens on the same run, the run id has
   * not changed, so without this the previous gate's plan renders beside the new
   * decision.
   */
  private _maybeResetPostureGate(): void {
    const key = pendingDecisionKey(this.run);
    if (key === this._postureGateKey) return;
    // The first observation of a gate is not a change to reset through.
    const hadKey = this._postureGateKey !== '';
    this._postureGateKey = key;
    if (hadKey) {
      // Only the selection and its preview belong to the old gate. A resolution
      // that already happened is not undone by a new decision opening; it ends
      // on a run change, which resets the whole gate.
      this._postureGate = postureGateWithSelection(this._postureGate, {
        choice: null,
        status: 'idle',
      });
      this._posturePreviewRequestSeq++;
    }
  }

  /**
   * Re-read `runtime.posture.status` whenever the run record changes. The run
   * carries the persisted desired policy, but only the RPC re-merges it with
   * what the providers are observed to be doing, so the panel must not be
   * rendered from `run.resourcePosture` alone.
   */
  private _maybeRefreshPostureStatus(): void {
    const run = this.run;
    if (!run) return;
    if (this.mockData) return;
    const key = `${run.id}:${run.updatedAt}`;
    if (key === this._postureStatusKey) return;
    this._postureStatusKey = key;
    void this._refreshPostureStatus(run.id);
  }

  private async _refreshPostureStatus(runId: string): Promise<void> {
    const current = this._captureView(runId);
    const requestSeq = ++this._postureStatusRequestSeq;
    const stillCurrent = () => current() && requestSeq === this._postureStatusRequestSeq;
    if (this._postureStatus.status === 'idle') {
      this._postureStatus = { status: 'loading' };
    }
    try {
      const result = await gateway.request<RuntimePostureStatusResult>(
        Methods.RUNTIME_POSTURE_STATUS,
        { runId },
      );
      if (!stillCurrent()) return;
      this._postureStatus = {
        status: 'ready',
        slotId: result.slotId,
        state: result.state,
      };
      // The clear in `updated()` runs before this lands, so a rejection selected
      // at a wait the run has since left would keep blocking until some other
      // shared-state update happened to re-render. Re-check against the posture
      // that just arrived.
      this._maybeClearInapplicablePostureChoice();
    } catch (err) {
      if (!stillCurrent()) return;
      // Never fall back to "no posture": an unreadable status is its own state.
      this._postureStatus = {
        status: 'error',
        message: `Posture status unavailable: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Ask the Gateway what the chosen gate choice would do. The plan shown to the
   * operator is the Gateway's, never one this client assembled.
   */
  private async _selectPostureGateChoice(
    runId: string,
    choice: ResourcePostureGateChoice | null,
  ): Promise<void> {
    const current = this._captureView(runId);
    const requestSeq = ++this._posturePreviewRequestSeq;
    if (!choice) {
      this._postureGate = postureGateWithSelection(this._postureGate, {
        choice: null,
        status: 'idle',
      });
      return;
    }
    // The Gateway only resolves a gate choice while the run is at an operator
    // wait; asking anywhere else would return a plan for a different posture
    // and read as the effect of this choice.
    if (!postureChoicesApply(this._postureStatus.state?.posture)) return;
    const gateKey = this._postureGateKey;
    this._postureGate = postureGateWithSelection(this._postureGate, {
      choice,
      status: 'loading',
    });
    try {
      const plan = await gateway.request<RuntimePosturePreviewResult>(
        Methods.RUNTIME_POSTURE_PREVIEW,
        { runId, gateChoice: choice },
      );
      // Guarded on the run and on the exact gate: a response that lands after
      // the operator moved on must not repopulate cleared state.
      if (!current() || !this._previewStillCurrent(requestSeq, runId, gateKey)) return;
      this._postureGate = postureGateWithSelection(this._postureGate, {
        choice,
        status: 'ready',
        plan,
      });
    } catch (err) {
      if (!current() || !this._previewStillCurrent(requestSeq, runId, gateKey)) return;
      this._postureGate = postureGateWithSelection(this._postureGate, {
        choice,
        status: 'error',
        message: `Posture preview failed: ${(err as Error).message}`,
      });
    }
  }

  private _shouldShowCiStatus(run: Run): boolean {
    return shouldShowRunCiStatus(run);
  }

  private _maybeRefreshLiveTimeoutPrStatus(): void {
    const run = this.run;
    if (!run?.prNumber || !pendingCITimeoutDecision(run)) {
      if (
        this.liveTimeoutPrStatus ||
        this.liveTimeoutPrStatusFailed ||
        this.liveTimeoutPrStatusRefreshing
      ) {
        this._liveTimeoutRequestSeq++;
      }
      this.liveTimeoutPrStatus = null;
      this.liveTimeoutPrStatusFailed = false;
      this.liveTimeoutPrStatusRefreshing = false;
      this._liveTimeoutKey = '';
      return;
    }

    const key = `${run.id}:${run.project}:${run.prNumber}`;
    if (key !== this._liveTimeoutKey) {
      this._liveTimeoutKey = key;
      this.liveTimeoutPrStatus = null;
      this.liveTimeoutPrStatusFailed = false;
      this._lastLiveTimeoutFetchAt = 0;
      this._liveTimeoutRequestSeq++;
    }

    if (this.liveTimeoutPrStatusRefreshing || this._connectionStale) return;
    if (Date.now() - this._lastLiveTimeoutFetchAt < 30_000) return;
    void this._fetchLiveTimeoutPrStatus(run);
  }

  private async _fetchLiveTimeoutPrStatus(run: Run): Promise<void> {
    const current = this._captureView(run.id);
    if (!run.prNumber) return;
    const requestSeq = ++this._liveTimeoutRequestSeq;
    const key = `${run.id}:${run.project}:${run.prNumber}`;
    this.liveTimeoutPrStatusRefreshing = true;
    this.liveTimeoutPrStatusFailed = false;
    this._lastLiveTimeoutFetchAt = Date.now();
    try {
      const res = await gateway.request<PRStatusResult>(
        Methods.PR_STATUS,
        { pr: run.prNumber, project: run.project, force: true },
        30_000,
      );
      if (!current() || requestSeq !== this._liveTimeoutRequestSeq || key !== this._liveTimeoutKey)
        return;
      this.liveTimeoutPrStatus = res.pr;
      void this._autoResolveRecoveredCITimeout(run, res.pr);
    } catch (err) {
      if (!current() || requestSeq !== this._liveTimeoutRequestSeq || key !== this._liveTimeoutKey)
        return;
      console.warn('Failed to refresh live CI status:', err);
      this.liveTimeoutPrStatusFailed = true;
    } finally {
      if (current() && requestSeq === this._liveTimeoutRequestSeq && key === this._liveTimeoutKey) {
        this.liveTimeoutPrStatusRefreshing = false;
      }
    }
  }

  private async _autoResolveRecoveredCITimeout(run: Run, pr: PRStatus): Promise<void> {
    if (!this.detailQuery.ready || this.runId !== run.id) return;
    const decision = pendingCITimeoutDecision(run);
    if (!decision) return;
    if (this._autoResolvedTimeoutDecisionIds.has(decision.id)) return;
    const summary = pr.checkSummary;
    // Skipped checks count toward total but must not block auto-resolve.
    if (!(summary.total > 0 && summary.passed > 0 && summary.failed === 0 && summary.pending === 0))
      return;

    this._autoResolvedTimeoutDecisionIds.add(decision.id);
    try {
      await gateway.request(
        Methods.RUN_RESOLVE_DECISION,
        buildRunResolveDecisionParams({
          runId: run.id,
          decision,
          actionId: 'continue',
        }),
        30_000,
      );
    } catch (err) {
      this._autoResolvedTimeoutDecisionIds.delete(decision.id);
      console.warn('Failed to auto-resolve recovered CI timeout:', err);
    }
  }

  private _runBootstrapBlocked(): boolean {
    return Boolean(
      this._runObservation.error &&
      !this._runObservation.data &&
      this._runObservation.error.code !== 'RUN_NOT_FOUND',
    );
  }

  /** Raw side reads and acknowledgements cannot outlive their displayed owner or connection. */
  private _captureView(runId = this.runId): () => boolean {
    const version = this._viewVersion;
    const key = getResourceWorkspaceKey();
    const connection = gateway.resourceConnectionId;
    return () =>
      this.isConnected &&
      this.runId === runId &&
      this._viewVersion === version &&
      getResourceWorkspaceKey() === key &&
      gateway.resourceConnectionId === connection &&
      this.detailQuery.belongsToWorkspace;
  }

  private _assertRunReady(runId: string): Run {
    const { run } = this.detailQuery.requireReady();
    if (run.id !== runId)
      throw new Error('The run changed. Review its current state before acting.');
    return run;
  }

  private _resetRecipeRuns(): void {
    this._recipeRequestedId = '';
    this._pendingRecipeRunSelectionId = '';
    this.recipeQuery.setQuery(undefined);
    this._recipeRuns = [];
    this.evidenceModel = null;
    this._recordedEvidence = undefined;
    this._evidenceTaskRelative = true;
    this._evidenceGroupId = null;
    this._selectedRecipeRunId = '';
  }

  private _bindRecipeRuns(run: Run): void {
    const outputDecision = pendingOutputReview(run);
    const recipeRunId = this._recipeRequestedId;
    const recordedRecipeRunId = this._recipeRuns.find(
      (group) => group.id === recipeRunId,
    )?.recipeRunId;
    const params: RunRecipeRunsForRunParams = {
      runId: run.id,
      includeRecordedEvidence: true,
      ...(recipeRunId ? { recipeRunId } : {}),
      ...(outputDecision
        ? {
            decisionId: outputDecision.id,
            ...(recordedRecipeRunId ? { recordedRecipeRunId } : {}),
            evidenceSnapshotHash: outputDecision.payload.manifestDigest,
          }
        : {}),
    };
    this.recipeQuery.setQuery(resourceQuery(Methods.RUN_RECIPE_RUNS_FOR_RUN, params));
  }

  private _acceptRecipeObservation(state: ResourceQueryState<RunRecipeRunsForRunResult>): void {
    const run = this.run;
    const result = this.recipeQuery.belongsToWorkspace ? state.data : undefined;
    if (!run || !result) {
      this._recipeRuns = [];
      this._recordedEvidence =
        run && state.error
          ? {
              artifactPrefix: 'artifacts/',
              contractVersion: run.recordedEvidenceContractVersion ?? 0,
              errors: [state.error.message],
            }
          : undefined;
      this._evidenceGroupId = null;
      this._evidenceTaskRelative = true;
      return;
    }
    this._recipeRuns = result.recipeRuns;
    const outputDecision = pendingOutputReview(run);
    if (
      !outputDecision &&
      this._recipeRequestedId &&
      result.selectedRecipeRunId &&
      this._recipeRequestedId !== result.selectedRecipeRunId
    ) {
      // A removed preference falls back through another canonical query, so its
      // hint error never replaces the retained package that remains readable.
      this._recipeRequestedId = result.selectedRecipeRunId;
      this._selectedRecipeRunId = result.selectedRecipeRunId;
      this._recordedEvidence = undefined;
      this._bindRecipeRuns(run);
      return;
    }
    this._recordedEvidence = result.recordedEvidence;
    this._evidenceGroupId = result.selectedRecipeRunId;
    this._evidenceTaskRelative = Boolean(outputDecision) || !result.recordedEvidence?.input;
    const desired = runDetailDesiredRecipeRunId({
      recipeRuns: result.recipeRuns,
      pendingRecipeRunId: this._pendingRecipeRunSelectionId,
      currentRecipeRunId: this._selectedRecipeRunId,
      gatewaySelectedRecipeRunId: result.selectedRecipeRunId,
    });
    this._selectedRecipeRunId = desired;
    if (desired === this._pendingRecipeRunSelectionId) this._pendingRecipeRunSelectionId = '';
    if (desired && desired !== result.selectedRecipeRunId) {
      this._recipeRequestedId = desired;
      this._bindRecipeRuns(run);
    }
  }

  private _handleRecipeRunArtifacts(run: Run, detail: RecipeCompleteDetail): void {
    if (detail.requestId) this._pendingRecipeRunSelectionId = `live-run:${detail.requestId}`;
    // Acquisition publishes the artifacts key. Keep the requested selection until
    // that query observes the new group instead of guessing a mirror delay.
    this._bindRecipeRuns(run);
  }

  private _actionsBlocked(): boolean {
    return this._closingOutput || (!this.mockData && !this.detailQuery.ready);
  }

  private fetchSiblings(run: Run): void {
    this.siblingQuery.setQuery(resourceQuery(Methods.RUN_LIST, { familyId: run.familyId }));
    this.siblings = sortRunsForFamilyView(
      (this.siblingQuery.state.data?.runs ?? []).filter((row) => row.id !== run.id),
    );
  }

  private _onHashChange = () => {
    if (isRunDetailHashForRun(this.runId)) {
      this._applySelectedStepFromHash();
      this._applyEvidenceArtifactFromHash();
      this._sharedPanelFocusKey = '';
      this.requestUpdate();
    }
  };

  private _applySelectedStepFromHash() {
    if (!this.run) return;
    const stepName = selectedStepNameFromRunDetailHash();
    if (!stepName) {
      this.selectedStep = null;
      this._loadSelectedStepProgress();
      return;
    }
    this.selectedStep =
      this.run.steps.find((s) => s.name === stepName) ??
      publicationReviewStepForName(this.run, stepName);
    this._loadSelectedStepProgress();
  }

  /**
   * Every artifact run detail can open: the run's evidence plus the worker command
   * logs from the live progress or, for a finished run, the selected step's
   * progress (the panel that rendered the link). One list for every opener, so a
   * link one of them writes always resolves on reload.
   */
  private _linkableRunArtifacts(run: Run): FamilyObservabilityArtifact[] {
    return runArtifactsWithOperationLogs(run, [
      ...(this.taskProgress?.operations ?? []),
      ...(this.selectedStepProgress?.operations ?? []),
    ]);
  }

  /** The one way the evidence lightbox opens: the Evidence tab, an `artifact=` link or an AC row. */
  private _openEvidenceLightbox(
    selection: EvidenceLightboxSelection,
    options: {
      /** False when the URL already names this file. */
      writeHash?: boolean;
      /** A criterion's file gallery, which stays in run detail rather than the gate's review. */
      gallery?: boolean;
    } = {},
  ): void {
    const { writeHash = true, gallery = false } = options;
    if (
      !gallery &&
      selection.criterionId &&
      this._openInGateReview(selection.criterionId, selection.items[selection.index])
    )
      return;
    this._evidenceLightboxItems = selection.items;
    this._evidenceLightboxIndex = selection.index;
    this._evidenceLightboxScope = selection.scope;
    this._evidenceLightboxCriterionId = selection.criterionId;
    this._evidenceGallery = gallery;
    this._evidenceArtifactUnavailable = null;
    this._evidenceLightboxOpen = true;
    if (writeHash) this._updateEvidenceArtifactHash(selection.items[selection.index] ?? null);
  }

  private _applyEvidenceArtifactFromHash(preserveCurrent = false): void {
    if (!this.run) return;
    if (this._applyReviewFromHash()) return;
    const { artifactRun, artifact, artifactView, artifactAc } =
      artifactSelectionFromRunDetailHash();
    if (!artifact || (artifactView === STEP_ARTIFACT_VIEW && this.selectedStep)) {
      // No artifact, or one the step inspector (showing) answers for.
      this._evidenceArtifactUnavailable = null;
      if (this._evidenceLightboxOpen) {
        this._evidenceLightboxOpen = false;
        this._evidenceLightboxItems = [];
        this._evidenceLightboxIndex = 0;
      }
      return;
    }
    if (artifactRun && artifactRun !== this.runId) return;
    if (
      preserveCurrent &&
      this._evidenceLightboxOpen &&
      this._evidenceLightboxItems[this._evidenceLightboxIndex]?.path === artifact &&
      this._evidenceLightboxCriterionId === artifactAc
    )
      return;
    // Re-applied when the run, worker progress or acceptance data updates, so a
    // link that arrives before they load still opens; until then, say so.
    const acceptanceRows = runAcceptanceCriterionEvidence(this);
    const selection = resolveEvidenceLightboxLink({
      path: artifact,
      criterionId: artifactAc,
      acceptanceRows,
      runId: this.runId,
      familyId: this.run.familyId,
      runArtifacts: this._linkableRunArtifacts(this.run),
      artifactUrl: this._artifactUrl,
      progress: {
        loaded: Boolean(this.taskProgress?.operations || this.selectedStepProgress?.operations),
        runActive: isRunWorking(this.run),
      },
      acceptancePending: this._taskProgressLoading,
    });
    // An AC link waits for the progress read that carries its criterion.
    if ('pending' in selection) return;
    if ('unavailable' in selection) {
      // Never leave a previous artifact showing under the notice.
      this._evidenceLightboxOpen = false;
      this._evidenceArtifactUnavailable = selection.unavailable;
      return;
    }
    const params = new URLSearchParams(location.hash.split('?')[1]);
    const traceIndex = params.get('artifactTrace');
    if (traceIndex && /^\d+$/.test(traceIndex) && Number.isSafeInteger(Number(traceIndex))) {
      selection.items[selection.index] = {
        ...selection.items[selection.index],
        initialTraceIndex: Number(traceIndex),
        initialTracePhase: params.get('artifactPhase') === 'start' ? 'start' : 'end',
      };
    }
    // The URL already names this artifact; rewriting it would drop the trace marker.
    this._openEvidenceLightbox(selection, {
      writeHash: false,
      gallery: artifactView === GALLERY_ARTIFACT_VIEW,
    });
  }

  private _syncSelectedStepToHash() {
    if (this._suppressHashSync) return;
    const stepName = this.selectedStep?.name;
    const next = runDetailStepHash(this.runId, stepName ?? null);
    if (location.hash !== next) {
      this._suppressHashSync = true;
      location.hash = next;
      queueMicrotask(() => {
        this._suppressHashSync = false;
      });
    }
  }

  @state() private _rereviewInFlight = false;
  private async _rereviewLatestHead(run: Run) {
    if (this._actionsBlocked() || this._rereviewInFlight) return;
    this._rereviewInFlight = true;
    const current = this._captureView(run.id);
    try {
      const result = await gateway.request<RunRereviewLatestHeadResult>(
        Methods.RUN_REREVIEW_LATEST_HEAD,
        { runId: run.id },
        30_000,
      );
      if (!current()) return;
      if (result.mode === 'warm-handoff' && result.runId) {
        // The follow-up went to the retained reviewer session; watch it there.
        location.hash = `runs?run=${result.runId}`;
        return;
      }
      const pr = result.submission?.request.pr;
      if (!pr) throw new Error('The gateway did not return a review round to follow');
      const params = new URLSearchParams({
        prSection: 'reviews',
        prScope: 'all',
        prPane: 'review',
        pr: String(pr.number),
        repo: pr.repo,
        view: 'detail',
      });
      // The round lives in the review queue; follow it there.
      location.hash = `prs?${params.toString()}`;
    } catch (err) {
      if (!current()) return;
      alert(`Re-review failed: ${(err as Error).message}`);
    } finally {
      if (current()) this._rereviewInFlight = false;
    }
  }
  private _requestCopilotRunDiagnosis(run: Run) {
    this.dispatchEvent(
      new CustomEvent('copilot-prompt-request', {
        detail: {
          prompt: buildRunDiagnosisPrompt(run),
          intent: 'diagnostic-readonly',
          runId: run.id,
          sourceSurface: 'run-detail',
          contextOverride: {
            selectedRunId: run.id,
            surfaceId: 'run-detail',
            affordances: ['failed-run-diagnosis', 'recovery-proposal'],
          },
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _bindTaskProgress(): void {
    const run = this.run;
    this.progressQuery.setQuery(
      run && (run.slotId || run.reviewWorkspace)
        ? resourceQuery<TaskProgressResult>(Methods.TASK_PROGRESS, {
            slotId: run.slotId ?? '',
            runId: run.id,
          })
        : undefined,
    );
    // An owner/connection reset may clear copied fields without changing the
    // canonical query id. Adopt its current state even when setQuery is a no-op.
    this._acceptProgressObservation();
  }

  private _acceptProgressObservation(): void {
    if (this.mockData) return;
    const observation = this.progressQuery.belongsToWorkspace
      ? this.progressQuery.state
      : undefined;
    const data = observation?.data;
    this.taskProgress = data?.structured ?? null;
    this.acceptanceStatus = data?.acceptanceStatus ?? null;
    this.acceptanceCriteria = data?.acceptanceCriteria ?? null;
    this.acceptanceStatusError = observation?.error?.message ?? data?.acceptanceStatusError ?? null;
    this.acceptanceEvidenceLinks = data?.acceptanceEvidenceLinks ?? null;
    this.acceptanceEvidenceLinksError = data?.acceptanceEvidenceLinksError ?? null;
    this._taskProgressLoading = Boolean(
      this.run &&
      (this.run.slotId || this.run.reviewWorkspace) &&
      !data &&
      !observation?.error &&
      (!observation || observation.status === 'loading' || observation.status === 'stale'),
    );
  }

  private _selectedProgressArtifactPath(): string | undefined {
    const path = this.selectedStep?.outputs?.taskProgressArtifactPath;
    return typeof path === 'string' && path.trim() ? path : undefined;
  }

  private _loadSelectedStepProgress(): void {
    const run = this.run;
    const taskFile = this._selectedProgressArtifactPath();
    this.selectedProgressQuery.setQuery(
      !this.mockData && run && (run.slotId || run.reviewWorkspace) && taskFile
        ? resourceQuery<TaskProgressResult>(Methods.TASK_PROGRESS, {
            slotId: run.slotId ?? '',
            runId: run.id,
            taskFile,
          })
        : undefined,
    );
    this._acceptSelectedProgressObservation();
  }

  private _acceptSelectedProgressObservation(): void {
    if (this.mockData) return;
    this.selectedStepProgress = this.selectedProgressQuery.belongsToWorkspace
      ? (this.selectedProgressQuery.state.data?.structured ?? null)
      : null;
  }

  private _artifactUrl = (artifact: FamilyObservabilityArtifact): string => {
    return runArtifactUrl(artifact.runId, artifact);
  };

  /**
   * Evidence link for the acceptance panel. The ledger records task-dir relative
   * paths, which is exactly what the run-artifact endpoint serves.
   */
  private _captureEvidenceResolver(): (path: string) => string {
    const runId = this.runId;
    const group = this._evidenceTaskRelative
      ? null
      : this._recipeRuns.find((group) => group.id === this._evidenceGroupId);
    return (path) =>
      group ? recipeRunArtifactUrl(runId, group, { path }) : runArtifactUrl(runId, { path });
  }

  private _acceptanceEvidenceHref = (evidencePath: string): string => {
    return this._captureEvidenceResolver()(evidencePath);
  };

  /**
   * An acceptance criterion's evidence file opens in the run's evidence lightbox,
   * stepping through that criterion's files, not a new browser window.
   */
  private _openAcceptanceEvidence = (open: AcceptanceEvidenceOpen) => {
    const selection = this._acceptanceEvidenceSelection(open);
    if (selection) this._openEvidenceLightbox(selection);
  };

  private _acceptanceEvidenceSelection({
    criterion,
    evidence,
    index,
    evidenceModel,
  }: AcceptanceEvidenceOpen): EvidenceLightboxSelection | null {
    if (!this.run) return null;
    const resolveArtifactUrl = this._captureEvidenceResolver();
    return acceptanceEvidenceSelection({
      runId: this.runId,
      familyId: this.run.familyId,
      criterion,
      evidence,
      index,
      runArtifacts: this._linkableRunArtifacts(this.run),
      artifactUrl: (artifact) => resolveArtifactUrl(artifact.path),
      evidenceModel,
    });
  }

  private async _recordVisualReview(claimId: string, verdict: 'confirmed' | 'rejected') {
    const model = this.evidenceModel;
    const run = this.run;
    if (!model || !run || this._visualReviewBusy) return;
    const current = this._captureView(run.id);
    this._visualReviewBusy = true;
    this._visualReviewMessage = '';
    this._visualReviewFeedback = { claimId, phase: 'saving' };
    try {
      this._assertRunReady(run.id);
      this.recipeQuery.requireReady();
      this.progressQuery.requireReady();
      const request = model.visualReviewRequest(
        claimId,
        gateway.authenticatedPrincipal,
        verdict,
        validVisualJudgmentReason(
          model.visualReviewKind(claimId, gateway.authenticatedPrincipal) ?? undefined,
          verdict,
        )
          ? undefined
          : this._visualReviewReasons[claimId],
      );
      if (request.runId !== run.id)
        throw new Error('The evidence selection changed. Refresh the run.');
      await gateway.request(Methods.RUN_REVIEW_VISUAL_CLAIM, request, { timeout: null });
      if (!current()) return;
      this._visualReviewMessage = 'Visual judgment recorded.';
      this._visualReviewFeedback = undefined;
    } catch (error) {
      if (!current()) return;
      this._visualReviewMessage = error instanceof Error ? error.message : String(error);
      this._visualReviewFeedback = { claimId, phase: 'error', message: this._visualReviewMessage };
    } finally {
      if (current()) this._visualReviewBusy = false;
    }
  }

  private _comparisonContext(): WorkspaceEvidenceComparison | undefined {
    const model = this.evidenceModel;
    if (!model) return undefined;
    const resolve = this._captureEvidenceResolver();
    const open = (video: boolean, mediaPath?: string) => {
      const clip = model.playback.clip;
      const path = video && clip ? model.artifactPath(clip.videoPath) : mediaPath;
      if (!path || !model.selection) return;
      this._openEvidenceLightbox({
        items: [
          {
            path,
            purpose: 'evidence',
            url: resolve(path),
            evidenceModel: model,
            fullscreen: video,
            ...(video && clip ? { initialTraceIndex: clip.traceIndex } : {}),
            caption: model.selection.caption,
            resolveArtifactUrl: resolve,
          },
        ],
        index: 0,
        scope: model.selection.caption,
        criterionId: model.selection.claimId ?? null,
      });
    };
    return {
      model,
      reviewer: gateway.authenticatedPrincipal,
      reviewing: this._visualReviewBusy,
      feedback: this._visualReviewFeedback,
      reviewReason: (id) => this._visualReviewReasons[id] ?? '',
      changeReviewReason: (id, reason) => {
        this._visualReviewReasons = { ...this._visualReviewReasons, [id]: reason };
      },
      recordReview:
        this.detailQuery.ready && this.recipeQuery.ready && this.progressQuery.ready
          ? (id, verdict) => this._recordVisualReview(id, verdict)
          : undefined,
      artifactUrl: resolve,
      changed: () => this.requestUpdate(),
      openMedia: (media, index) => {
        model.selectComparisonMedia(media.identity);
        if (index !== undefined) model.cueClip(index);
        open(index !== undefined, media.artifactPath);
      },
      openMoment: (id, index) => {
        model.selectClaim(id);
        model.cueClip(index);
        open(true);
      },
      openProofFile: (claimId, path) => {
        model.selectClaim(claimId, path);
        this._openEvidenceLightbox({
          items: [this._evidenceFileItem(path, model)],
          index: 0,
          scope: `${claimId} evidence`,
          criterionId: claimId,
        });
      },
    };
  }

  private _openOutputReport = async (): Promise<void> => {
    const run = this.run;
    const model = this.evidenceModel;
    if (!run || !model) return;
    const current = this._captureView(run.id);
    const resolveArtifactUrl = this._captureEvidenceResolver();
    try {
      const report = await readEvidenceReviewReport(model, async (path) => {
        const response = await gatewayHttpFetch(
          runArtifactUrl(
            run.id,
            model.report?.artifactManifest.find((file) => file.path === path) ?? { path },
          ),
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      });
      if (!current() || this.evidenceModel !== model) return;
      this._openEvidenceLightbox({
        items: [
          {
            path: report.path,
            purpose: 'report',
            url: runArtifactUrl(run.id, {
              path: report.path,
              bundleDigest: model.report?.artifactManifest.find((file) => file.path === report.path)
                ?.bundleDigest,
              sha256: model.report?.artifactManifest.find((file) => file.path === report.path)
                ?.sha256,
            }),
            verifiedText: report.body,
            caption: report.caption,
            evidenceModel: model,
            resolveArtifactUrl,
          },
        ],
        index: 0,
        scope: report.caption,
        criterionId: null,
      });
    } catch (error) {
      if (current())
        this._evidenceArtifactUnavailable = {
          path: model.report?.reportPath ?? 'report',
          reason: error instanceof Error ? error.message : String(error),
        };
    }
  };

  private _openRecipeProof = (traceIndex: number): void => {
    const model = this.evidenceModel;
    const selected = model?.selectOccurrence(traceIndex);
    if (!model || !selected) return;
    const path = selected.clips[0]
      ? model.artifactPath(selected.clips[0].videoPath)
      : selected.artifacts[0]?.artifactPath;
    if (!selected.artifacts.length) {
      this._evidenceArtifactUnavailable = {
        path: selected.caption,
        reason: selected.message ?? 'This step has no proof artifact.',
      };
      return;
    }
    const resolveArtifactUrl = this._captureEvidenceResolver();
    const items = selected.artifacts.map((file) => ({
      path: file.artifactPath,
      purpose: 'evidence',
      url: resolveArtifactUrl(file.artifactPath),
      caption: selected.caption,
      evidenceModel: model,
      resolveArtifactUrl,
    }));
    this._openEvidenceLightbox({
      items,
      index: Math.max(
        0,
        items.findIndex((item) => item.path === path),
      ),
      scope: selected.caption,
      criterionId: null,
    });
  };

  private _updateEvidenceArtifactHash(item: LightboxItem | null): void {
    const next = runDetailEvidenceArtifactHash(
      this.runId,
      item,
      location.hash,
      this._evidenceLightboxCriterionId,
      this._evidenceGallery,
    );
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  /**
   * On a run showing its publication gate, a criterion's review opens in the gate's
   * review, the one owner of review links; its link replaces this artifact link.
   */
  private _openInGateReview(claimId: string, opened: LightboxItem | undefined): boolean {
    if (!this.run || !runMountsPublicationGate(this.run)) return false;
    const gate = this.renderRoot.querySelector('ready-workspace');
    if (!gate?.openEvidenceReview(claimId, opened)) return false;
    // A saved gate sits in a collapsible section; its review shows only while it is open.
    const section = gate.closest('details');
    if (section) section.open = true;
    this._evidenceLightboxOpen = false;
    this._evidenceLightboxCriterionId = null;
    this._updateEvidenceArtifactHash(null);
    return true;
  }

  /** One criterion's evidence opens as the full-screen review, on the file the user chose. */
  private _evidenceReviewer(): EvidenceReviewerSelection | null {
    const claimId = this._evidenceLightboxCriterionId;
    const model = this.evidenceModel;
    if (!this._evidenceLightboxOpen || this._evidenceGallery || !claimId || !model) return null;
    return {
      ...evidenceReviewerSelection({
        model,
        claimId,
        resolveUrl: this._captureEvidenceResolver(),
        opened: this._evidenceLightboxItems[this._evidenceLightboxIndex],
      }),
      ...this._reviewLink,
    };
  }

  /** One evidence file of the run, served and reviewed through its evidence model. */
  private _evidenceFileItem(path: string, model: EvidenceReviewModel): LightboxItem {
    const resolve = this._captureEvidenceResolver();
    return {
      path,
      purpose: 'evidence',
      url: resolve(path),
      evidenceModel: model,
      resolveArtifactUrl: resolve,
    };
  }

  /** The link the review last applied: where it left the recording and the open step check. */
  private _reviewLink?: Pick<EvidenceReviewerSelection, 'atMs' | 'check' | 'link'>;
  /** The view the hash holds as applied or reported, so only a new link reapplies. */
  private _reviewLinkKey = '';

  /** The review reports its view; the link follows unless the gate owns review links. */
  private _onReviewerView(view: EvidenceReviewerView): void {
    if (this.run && runMountsPublicationGate(this.run)) return;
    this._reviewLinkKey = evidenceReviewerViewKey(view);
    writeEvidenceReviewerHash(view);
  }

  /**
   * A review link opens the review on its criterion, file, moment and step check,
   * also over a review already open. The publication gate owns review links
   * whenever run detail mounts it.
   */
  private _applyReviewFromHash(): boolean {
    const run = this.run;
    const model = this.evidenceModel;
    const view = evidenceReviewerViewFromHash();
    if (!view) this._reviewLinkKey = '';
    if (!run || !model || !view || runMountsPublicationGate(run)) return false;
    if (!model.claims.some((claim) => claim.id === view.claimId)) return false;
    const key = evidenceReviewerViewKey(view);
    if (this._evidenceLightboxOpen && key === this._reviewLinkKey) return true;
    this._reviewLinkKey = key;
    this._reviewLink = {
      atMs: view.atMs,
      check: view.check,
      link: (this._reviewLink?.link ?? 0) + 1,
    };
    this._openEvidenceLightbox(
      {
        items: view.path ? [this._evidenceFileItem(view.path, model)] : [],
        index: 0,
        scope: `${view.claimId} evidence`,
        criterionId: view.claimId,
      },
      { writeHash: false },
    );
    return true;
  }

  /** A criterion's files in the gallery, from the review. */
  private _openClaimFiles(claimId: string): void {
    const row = runAcceptanceCriterionEvidence(this).find((candidate) => candidate.id === claimId);
    const criterion = this.evidenceModel?.claims.find((claim) => claim.id === claimId);
    if (!row?.evidence.length || !criterion) return;
    const selection = this._acceptanceEvidenceSelection({
      criterion,
      evidence: row.evidence,
      index: 0,
      evidenceModel: this.evidenceModel ?? undefined,
    });
    if (!selection) return;
    // The gallery, with its file, replaces the review in the link.
    this._dropReviewLink();
    this._openEvidenceLightbox(selection, { gallery: true });
  }

  /**
   * A criterion chosen in the review becomes the link only when its own files list
   * the recording: the link resolver reopens exactly that pair, and nothing else.
   */
  private _selectEvidenceClaim(claimId: string): void {
    const recording = this._evidenceLightboxItems[this._evidenceLightboxIndex];
    const reopenable = runAcceptanceCriterionEvidence(this).some(
      (row) => row.id === claimId && Boolean(recording && row.evidence.includes(recording.path)),
    );
    if (!reopenable) return;
    this._evidenceLightboxCriterionId = claimId;
    this._updateEvidenceArtifactHash(recording ?? null);
  }

  /** Run detail's review leaves the link; the gate's own review keeps its link. */
  private _dropReviewLink(): void {
    if (evidenceReviewerViewFromHash() && !(this.run && runMountsPublicationGate(this.run)))
      writeEvidenceReviewerHash(null);
    this._reviewLink = undefined;
    this._reviewLinkKey = '';
  }

  private _closeEvidenceLightbox(): void {
    this._dropReviewLink();
    this._evidenceLightboxOpen = false;
    this._evidenceGallery = false;
    this._evidenceArtifactUnavailable = null;
    this._updateEvidenceArtifactHash(null);
  }

  private _navigateEvidenceLightbox(index: number): void {
    this._evidenceLightboxIndex = index;
    this._updateEvidenceArtifactHash(this._evidenceLightboxItems[index] ?? null);
  }

  private _onEvidenceArtifactClick(
    e: CustomEvent<{ artifacts: FamilyObservabilityArtifact[]; index: number }>,
  ): void {
    const { artifacts, index } = e.detail;
    this._openEvidenceLightbox(runOutputEvidenceSelection(artifacts, index, this._artifactUrl));
  }

  @state() private _refreshingOutput = false;
  @state() private _outputError = '';
  @state() private _closingOutput = false;

  private async _closeOutput(run: Run, decision: RunDecision): Promise<void> {
    if (this._closingOutput || this._actionsBlocked()) return;
    const current = this._captureView(run.id);
    this._closingOutput = true;
    this._outputError = '';
    try {
      this._assertRunReady(run.id);
      await gateway.request<RunResolveDecisionResult>(
        Methods.RUN_RESOLVE_DECISION,
        { runId: run.id, decisionId: decision.id, actionId: 'close-run' },
        120_000,
      );
    } catch (error) {
      if (!current()) return;
      this._outputError = error instanceof Error ? error.message : String(error);
    } finally {
      if (current()) this._closingOutput = false;
    }
  }

  private async _refreshOutput(run: Run): Promise<void> {
    if (this._refreshingOutput) return;
    const current = this._captureView(run.id);
    this._refreshingOutput = true;
    this._outputError = '';
    try {
      this._assertRunReady(run.id);
      const result = await gateway.request<{ ok: boolean; reason?: string }>(
        Methods.RUN_REFRESH_MIRROR,
        { runId: run.id },
        120_000,
      );
      if (!result.ok) throw new Error(result.reason ?? 'Could not retrieve worker output');
    } catch (error) {
      if (!current()) return;
      this._outputError = error instanceof Error ? error.message : String(error);
    } finally {
      if (current()) this._refreshingOutput = false;
    }
  }

  private _renderRunEvidence(run: Run) {
    return renderRunEvidence(run, {
      selectedSharedEvidence: hashParams().get('panel') === 'evidence',
      taskProgress: this.taskProgress,
      evidenceLightboxItems: this._evidenceLightboxItems,
      evidenceLightboxOpen: this._evidenceLightboxOpen,
      evidenceLightboxIndex: this._evidenceLightboxIndex,
      evidenceLightboxScope: this._evidenceLightboxScope,
      evidenceArtifactUnavailable: this._evidenceArtifactUnavailable,
      artifactUrl: this._artifactUrl,
      onEvidenceArtifactClick: (event) => this._onEvidenceArtifactClick(event),
      closeEvidenceLightbox: () => this._closeEvidenceLightbox(),
      reviewerView: (view) => this._onReviewerView(view),
      evidenceReviewer: this._evidenceReviewer(),
      showEvidenceGallery: (claimId) => this._openClaimFiles(claimId),
      reviewEvidence:
        this._evidenceLightboxCriterionId && this.evidenceModel
          ? () => {
              this._evidenceGallery = false;
              this._updateEvidenceArtifactHash(
                this._evidenceLightboxItems[this._evidenceLightboxIndex] ?? null,
              );
            }
          : undefined,
      selectEvidenceClaim: (claimId) => this._selectEvidenceClaim(claimId),
      navigateEvidenceLightbox: (index) => this._navigateEvidenceLightbox(index),
      replaceEvidenceLightbox: ({ items, index }) => {
        this._evidenceLightboxItems = items;
        this._navigateEvidenceLightbox(index);
      },
      refreshOutput: () => void this._refreshOutput(run),
      refreshingOutput: this._refreshingOutput,
      outputError: this._outputError,
      closingOutput: this._closingOutput,
      actionsBlocked: this._actionsBlocked(),
      closeOutput: (decision) => void this._closeOutput(run, decision),
    });
  }

  private _renderInteractivePackets(run: Run) {
    const artifacts = collectRunInteractivePacketArtifacts(run);
    if (artifacts.length === 0) return null;
    return html`
      <interactive-operator-packets
        .runId=${run.id}
        .slotId=${run.slotId}
        .decisions=${run.decisions}
        .artifacts=${artifacts}
        .artifactTextLoader=${this.mockData ? this.mockArtifactTextLoader : null}
      ></interactive-operator-packets>
    `;
  }

  render() {
    const view = renderRunDetailView({
      embedded: this.embedded,
      run: this.run,
      prStatus: this.prStatus,
      siblings: this.siblings,
      taskProgress: this.taskProgress,
      evidenceModel: this.evidenceModel,
      acceptanceStatus: this.acceptanceStatus,
      acceptanceCriteria: this.acceptanceCriteria,
      acceptanceStatusError: this.acceptanceStatusError,
      acceptanceEvidenceLinks: this.acceptanceEvidenceLinks,
      acceptanceEvidenceLinksError: this.acceptanceEvidenceLinksError,
      acceptanceEvidenceHref: this._acceptanceEvidenceHref,
      acceptanceEvidenceOpen: this._openAcceptanceEvidence,
      openRecipeProof: this._openRecipeProof,
      selectedStep: this.selectedStep,
      selectedStepProgress: this.selectedStepProgress,
      _hydrating: this._hydrating,
      _bootstrapFailed: this._runBootstrapBlocked(),
      _connectionStale: this._connectionStale,
      _directRunRefreshing: this._directRunRefreshing,
      _directRunRefreshFailed: this._directRunRefreshFailed,
      _directRunUnavailable: this._directRunUnavailable,
      _rescueInProgress: this._rescueInProgress,
      _pendingConfirm: this._pendingConfirm,
      linkedTriageAssessmentId:
        this._triageDecisionLink?.runId === this.runId &&
        this.run?.decisions.some(
          (d) => d.id === this._triageDecisionLink?.decisionId && !d.resolvedAt,
        )
          ? this._triageDecisionLink.assessmentId
          : '',
      onTriageDecisionLink: (runId, assessmentId) => {
        if (runId !== this.runId) return;
        const pending = this.run?.decisions.find((d) => !d.resolvedAt);
        this._triageDecisionLink =
          assessmentId && pending ? { runId, decisionId: pending.id, assessmentId } : null;
      },
      _showTerminal: this._showTerminal,
      _terminalContextId: this._terminalContextId,
      _terminalRole: this._terminalRole,
      _actionsBlocked: () => this._actionsBlocked(),
      _rescueLinkage: (runId) => this._rescueLinkage(runId),
      _confirmForceComplete: (run) => this._confirmForceComplete(run),
      _confirmLifecycleAction: (run, action) =>
        confirmRunLifecycleAction(run, action, {
          actionsBlocked: () => this._actionsBlocked(),
          pendingConfirm: () => this._pendingConfirm,
          setPendingConfirm: (pending) => {
            this._pendingConfirm = pending;
          },
          confirmTimer: () => this._confirmTimer,
          setConfirmTimer: (timer) => {
            this._confirmTimer = timer;
          },
          navigateToRuns: () => {
            location.hash = runInventoryHashFromDetail();
          },
        }).catch((err) => alert(`Run ${action} failed: ${(err as Error).message}`)),
      _requestCopilotRunDiagnosis: (run) => this._requestCopilotRunDiagnosis(run),
      _rereviewLatestHead: (run) => this._rereviewLatestHead(run),
      _rereviewInFlight: this._rereviewInFlight,
      _buildRerunAlongsideHref: buildRerunAlongsideHref,
      _slotBranchForRun: (run) =>
        getState().fleet?.slots.find((slot) => slot.slot === run.slotId)?.branch ?? '',
      _slotHealthForRun: (run) =>
        getState().fleet?.slots.find((slot) => slot.slot === run.slotId)?.health ?? null,
      _cancelledRunSlot: this.run ? cancelledRunSlotChoices(this.run, this._fleetSlots) : null,
      _setRunLinkedTickets: async (run, linkedTicketRefs) => {
        this._assertRunReady(run.id);
        await gateway.request(Methods.RUN_LINKED_TICKETS_SET, { runId: run.id, linkedTicketRefs });
      },
      _setRunTags: (run, raw) => this._setRunTags(run, raw),
      _publicationActions: this._publicationActions,
      _retryReviewPublication: (run) => this._retryReviewPublication(run),
      _renderInteractiveDevGate: (run) =>
        renderInteractiveDevGate(run, {
          busyAction: this._interactiveDevActionInProgress,
          actionsBlocked: this._actionsBlocked(),
          resolveInteractiveDev: (targetRun, action) =>
            this._resolveInteractiveDev(targetRun, action),
        }),
      _currentCiStatus: (run) => persistedCiStatusFromRun(run),
      _shouldShowCiStatus: (run) => this._shouldShowCiStatus(run),
      _renderCiStatus: (run) =>
        renderRunCiStatus(run, {
          ci: persistedCiStatusFromRun(run),
          timeoutDecision: pendingCITimeoutDecision(run),
          liveTimeoutPrStatus: this.liveTimeoutPrStatus,
          prStatus: this.prStatus,
          liveTimeoutPrStatusRefreshing: this.liveTimeoutPrStatusRefreshing,
          liveTimeoutPrStatusFailed: this.liveTimeoutPrStatusFailed,
          poking: this._ciPoking,
          pokeStatus: this._ciPokeStatus,
          onPokeNow: () => void this._pokeCIWatch(run.id),
          now: this._now,
        }),
      _renderRunEvidence: (run) => this._renderRunEvidence(run),
      // The gate disappears when the decision resolves, so the correlated result
      // and the pending notice live on the persistent summary instead.
      _renderPosture: (run) =>
        renderRunPostureSummary(
          this._postureStatus,
          {
            ...(this._postureGate.appliedTransition
              ? { appliedTransition: this._postureGate.appliedTransition }
              : {}),
            ...(this._postureGate.appliedTransitionAttributed !== undefined
              ? { appliedTransitionAttributed: this._postureGate.appliedTransitionAttributed }
              : {}),
            ...(this._postureGate.reconciliationPending !== undefined
              ? { reconciliationPending: this._postureGate.reconciliationPending }
              : {}),
            // The gate panel is hidden exactly when a choice is withheld, so the
            // persistent summary is the only place the operator can be told.
            withheldChoiceReason: postureChoiceWithheldReason(this._postureGateStateForRender()),
          },
          // The park record is the authority for where this run's slot went; the
          // posture read only says what the run is holding.
          liveGateParkView(run),
          run.slotId,
        ),
      _renderInteractivePackets: (run) => this._renderInteractivePackets(run),
      _renderAgentSessions: (run) =>
        renderRunAgentSessions(run, {
          actionsBlocked: this._actionsBlocked(),
          states: this._sessionStates,
          onCopy: (row, kind) => void this._copyRunnerSessionCommand(run, row, kind),
          onOpenOnHost: (row) => void this._openRunnerSessionOnHost(run, row),
        }),
      _onReplayStep: (stepName, skipPrepare, prepareProfile, freshDispatch) =>
        this._onReplayStep(stepName, skipPrepare, prepareProfile, freshDispatch),
      renderGateSection: (run) => this.renderGateSection(run),
      renderGrade: renderRunGrade,
      onStepSelect: (step) => {
        this.selectedStep = step;
        this._syncSelectedStepToHash();
        this._loadSelectedStepProgress();
      },
      onStepInspectorClose: () => {
        this.selectedStep = null;
        this._loadSelectedStepProgress();
        this._syncSelectedStepToHash();
      },
      toggleTerminal: () => {
        if (!this._showTerminal) {
          this._terminalContextId = '';
          this._terminalRole = '';
        }
        this._showTerminal = !this._showTerminal;
      },
    });
    return view;
  }

  /**
   * Recover this agent context on the slot's node when needed, then open the
   * run terminal on that exact pane. Copy stays available if the host refuses.
   */
  private async _openRunnerSessionOnHost(run: Run, row: RunSessionRow): Promise<void> {
    const current = this._captureView(run.id);
    if (!this.detailQuery.ready || this.runId !== run.id) {
      this._sessionStates = {
        ...this._sessionStates,
        [row.contextId]: {
          status: 'error',
          message: 'Wait for current run details before opening its session.',
        },
      };
      return;
    }
    const requestSeq = (this._sessionRequestSeq[row.contextId] ?? 0) + 1;
    this._sessionRequestSeq = { ...this._sessionRequestSeq, [row.contextId]: requestSeq };
    const requestStillCurrent = () =>
      current() && requestSeq === this._sessionRequestSeq[row.contextId];
    this._sessionStates = { ...this._sessionStates, [row.contextId]: { status: 'opening' } };
    const opened = await openRunnerSessionOnHost({
      runId: run.id,
      runStatus: run.status,
      row,
      isCurrent: requestStillCurrent,
    });
    if (!requestStillCurrent()) return;
    if (!opened.ok) {
      this._sessionStates = {
        ...this._sessionStates,
        [row.contextId]: {
          status: 'error',
          liveness: opened.liveness,
          command: opened.command,
          machine: opened.machine,
          slotId: opened.slotId ?? undefined,
          tmuxTarget: opened.tmuxTarget,
          ownership: opened.ownership,
          ownerRunId: opened.ownerRunId,
          message: opened.message,
        },
      };
      return;
    }
    this._terminalContextId = opened.contextId;
    this._terminalRole = opened.role;
    this._showTerminal = true;
    this._sessionStates = {
      ...this._sessionStates,
      [row.contextId]: {
        status: 'ready',
        liveness: opened.liveness,
        command: opened.command,
        machine: opened.machine,
        slotId: opened.slotId ?? undefined,
        tmuxTarget: opened.tmuxTarget,
        ownership: opened.ownership,
        ownerRunId: opened.ownerRunId,
        message: opened.message,
      },
    };
    await this.updateComplete;
    this.renderRoot.querySelector('terminal-view')?.scrollIntoView({ block: 'nearest' });
  }

  /**
   * Copy the gateway-built command for one agent context. The command is never
   * assembled here — `run.sessionCommand` owns the runner CLI syntax, and its
   * structured liveness is what labels the row.
   */
  private async _copyRunnerSessionCommand(
    run: Run,
    row: RunSessionRow,
    kind: RunSessionCopyKind,
  ): Promise<void> {
    const current = this._captureView(run.id);
    // Sequenced per context: one global counter meant a click on a second row
    // invalidated the first row's in-flight request, leaving it stuck on
    // "Loading…" forever.
    const requestSeq = (this._sessionRequestSeq[row.contextId] ?? 0) + 1;
    this._sessionRequestSeq = { ...this._sessionRequestSeq, [row.contextId]: requestSeq };
    // A response that lands after the operator moved to another run, or after a
    // newer click on this row, must not overwrite what is on screen now.
    const requestStillCurrent = () =>
      current() && requestSeq === this._sessionRequestSeq[row.contextId];
    this._sessionStates = { ...this._sessionStates, [row.contextId]: { status: 'loading' } };
    try {
      const result = await gateway.request<RunSessionCommandResult>(Methods.RUN_SESSION_COMMAND, {
        runId: run.id,
        // The exact context this row renders. Role alone would resolve to the
        // newest context sharing that role, which is the wrong reviewer.
        contextId: row.contextId,
        role: row.role,
      });
      if (!requestStillCurrent()) return;
      const command = runSessionCommandTextForKind(result, kind);
      let copyError: string | null = null;
      if (command) {
        // A refused clipboard must not hide the liveness the gateway proved,
        // and must never be reported as a successful copy.
        try {
          await copyTextToClipboard(command);
        } catch (err) {
          copyError = (err as Error).message;
        }
      }
      if (!requestStillCurrent()) return;
      this._sessionStates = {
        ...this._sessionStates,
        [row.contextId]: runSessionRowStateFromResult(result, kind, copyError),
      };
    } catch (err) {
      if (!requestStillCurrent()) return;
      this._sessionStates = {
        ...this._sessionStates,
        [row.contextId]: { status: 'error', message: (err as Error).message },
      };
    }
  }

  private async _retryReviewPublication(run: Run): Promise<void> {
    if (this._publicationActions[run.id]?.busy || this._actionsBlocked()) return;
    const current = this._captureView(run.id);
    this._publicationActions = { ...this._publicationActions, [run.id]: { busy: true } };
    try {
      await gateway.request(Methods.PR_REVIEW_PUBLISH, { runId: run.id }, 60_000);
      if (!current()) return;
      this._publicationActions = { ...this._publicationActions, [run.id]: { busy: false } };
    } catch (error) {
      if (!current()) return;
      this._publicationActions = {
        ...this._publicationActions,
        [run.id]: { busy: false, error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  private async _setRunTags(run: Run, tags: string[]) {
    this._assertRunReady(run.id);
    await gateway.request(Methods.RUN_TAGS_SET, { runId: run.id, tags });
  }

  private async _pokeCIWatch(runId: string): Promise<void> {
    if (!this.detailQuery.ready || this.runId !== runId) return;
    const ciStep = this.run?.steps.find((step) => step.name === 'ci-watch');
    const beforePoll = readCiWatchOutputs(ciStep?.outputs)?.pollCount;
    await this._ciPoke.poke(runId, typeof beforePoll === 'number' ? beforePoll : null);
  }

  private renderGateSection(run: Run) {
    return renderRunGateSection(run, {
      allRuns: getState().runs,
      pendingDecisions: getState().decisions,
      bootstrapFailed: this._runBootstrapBlocked(),
      directRunRefreshFailed: this._directRunRefreshFailed,
      actionsBlocked: this._actionsBlocked(),
      pendingConfirm: this._pendingConfirm,
      decisionResolveError:
        this._decisionResolveError?.runId === run.id &&
        this._decisionResolveError.decisionId === run.decisions.find((d) => !d.resolvedAt)?.id
          ? this._decisionResolveError.message
          : null,
      recipeRuns: this._recipeRuns,
      selectedRecipeRunId: this._selectedRecipeRunId,
      selectedSlotId: this._selectedSlotId,
      resetBranch: this._resetBranch,
      branchNudgeShowPicker: this._branchNudgeShowPicker,
      liveTimeoutPrStatus: this.liveTimeoutPrStatus,
      liveTimeoutPrStatusRefreshing: this.liveTimeoutPrStatusRefreshing,
      liveTimeoutPrStatusFailed: this.liveTimeoutPrStatusFailed,
      isLiveTimeoutAllGreen: () => isLiveTimeoutPrStatusAllGreen(this.liveTimeoutPrStatus),
      setSelectedSlot: (slotId, resetBranch) => {
        this._selectedSlotId = slotId;
        if (resetBranch !== undefined) this._resetBranch = resetBranch;
      },
      setResetBranch: (resetBranch) => {
        this._resetBranch = resetBranch;
      },
      setBranchNudgeShowPicker: (show) => {
        this._branchNudgeShowPicker = show;
      },
      openOutputReport: () => void this._openOutputReport(),
      evidenceModel: this.evidenceModel,
      comparison: this._comparisonContext(),
      visualReviewMessage: this._visualReviewMessage,
      openEvidence: this._openAcceptanceEvidence,
      confirmResolve: (runId, decision, actionId, reason) =>
        this._confirmResolve(runId, decision, actionId, reason),
      posture: this._postureGateStateForRender(),
      postureBlockedReason: postureResolveBlockReason(this._postureGateStateForRender()),
      selectPostureChoice: (choice) => void this._selectPostureGateChoice(run.id, choice),
      checkInteractiveHandoffSignal: (runId, decision) =>
        this._checkInteractiveHandoffSignal(runId, decision),
      resumeStoppedWorker: (runId, decision) =>
        this._checkInteractiveHandoffSignal(runId, decision, true),
      handoffSignalCheckBusy: this._handoffSignalCheckBusy,
      handoffSignalCheckError: this._handoffSignalCheckError,
      resolveSlotPick: (runId, decisionId) => this._resolveSlotPick(runId, decisionId),
      resolveBranchNudgePick: (runId, decisionId) =>
        this._resolveBranchNudgePick(runId, decisionId),
      handleRecipeRunArtifacts: (targetRun, detail) =>
        this._handleRecipeRunArtifacts(targetRun, detail),
    });
  }

  private async _rescueLinkage(runId: string) {
    await rescueRunLinkage(runId, {
      actionsBlocked: () => this._actionsBlocked(),
      rescueInProgress: () => this._rescueInProgress,
      setRescueInProgress: (inProgress) => {
        this._rescueInProgress = inProgress;
      },
    });
  }

  private async _resolveInteractiveDev(run: Run, action: DevInteractiveCompletionAction) {
    await resolveInteractiveDevAction(run, action, {
      actionsBlocked: () => this._actionsBlocked(),
      busyAction: () => this._interactiveDevActionInProgress,
      setBusyAction: (busyAction) => {
        this._interactiveDevActionInProgress = busyAction as DevInteractiveCompletionAction | null;
      },
    });
  }

  private _confirmForceComplete(run: Run) {
    confirmForceComplete(run, this._confirmTimerContext());
  }

  private _confirmResolve(runId: string, decision: RunDecision, actionId: string, reason?: string) {
    // A choice the Gateway already refused in preview must not be sent: the
    // decision would be consumed and the refusal repeated with nothing to undo.
    const outputReview = decision.payload?.kind === 'output-review';
    if (outputReview && actionId === 'close-run') {
      if (this.run?.id === runId) void this._closeOutput(this.run, decision);
      return;
    }
    if (!outputReview && !canResolveWithPostureChoice(this._postureGateStateForRender())) return;
    // Snapshot once: the request and the baseline must agree on what was sent.
    const forwardedChoice = outputReview
      ? null
      : (postureChoiceForResolve(this._postureGateStateForRender()) ?? null);
    const observation = this._postureTransitionObservation(forwardedChoice);
    confirmRunDecision(runId, decision, actionId, {
      ...this._confirmTimerContext(),
      ...(reason ? { reason } : {}),
      jumpToSuccessorWhenAvailable: (originRunId) =>
        this._jumpToSuccessorWhenAvailable(originRunId),
      // Only ever forwarded where the Gateway would honour it; a hidden panel
      // must not send a choice the operator cannot see or clear.
      resourcePosture: () => forwardedChoice,
      triageAssessmentId: () =>
        this._triageDecisionLink?.runId === runId &&
        this._triageDecisionLink.decisionId === decision.id
          ? this._triageDecisionLink.assessmentId
          : undefined,
      onDecisionAttempt: () => {
        if (this.runId === runId) this._decisionResolveError = null;
      },
      onDecisionError: (error) => {
        if (this.runId !== runId) return;
        const selectedAdvice =
          this._triageDecisionLink?.runId === runId &&
          this._triageDecisionLink.decisionId === decision.id;
        if (selectedAdvice) this._triageDecisionLink = null;
        this._decisionResolveError = {
          runId,
          decisionId: decision.id,
          message: `Decision was not saved: ${error.message} Review the error, then choose an action again.${selectedAdvice ? ' Advice selection was cleared.' : ''}`,
        };
      },
      onDecisionResolved: (run) => {
        // A response that lands after navigation must not clear another run's choice.
        if (this.runId !== run.id) return;
        if (
          this._triageDecisionLink?.decisionId === decision.id &&
          run.decisions.some((item) => item.id === decision.id && item.resolvedAt)
        )
          this._triageDecisionLink = null;
        // Output acknowledgement has no resource transition to wait for.
        if (!outputReview) this._adoptResolvedPostureTransition(run, observation);
      },
    });
  }

  /**
   * The transition the Gateway had recorded before a resolution was sent, so a
   * response carrying the same one is recognised as "not reconciled yet".
   */
  /**
   * The baseline must be built from the choice that is actually forwarded, not
   * the one still selected. When forwarding withholds a retained choice, the
   * Gateway reconciles under the run's own policy, and a baseline carrying the
   * retained choice rejects that record as another choice's and reports pending
   * forever.
   */
  private _postureTransitionObservation(
    forwardedChoice: ResourcePostureGateChoice | null,
  ): PostureTransitionObservation {
    return postureTransitionBaseline(this._postureStatus.state, forwardedChoice);
  }

  /**
   * Adopt the apply outcome only once it is demonstrably this resolution's.
   * Reconciliation is asynchronous, so the resolve response usually still
   * carries the previous transition; showing that would report an old rejection
   * as the answer to what the operator just did. The posture status refresh
   * below supplies the real one when it lands.
   */
  private _adoptResolvedPostureTransition(
    run: Run,
    observation: PostureTransitionObservation,
  ): void {
    const immediate = correlatedPostureTransition(
      observation,
      postureTransitionsOf(run.resourcePosture),
    );
    if (immediate && isTerminalPostureOutcome(immediate.outcome)) {
      this._postureGate = postureGateWithAdoptedTransition(
        this._postureGate,
        immediate,
        postureTransitionAttributed(observation, immediate),
      );
      this._postureStatusKey = '';
      void this._refreshPostureStatus(run.id);
      return;
    }
    // Reconciliation is asynchronous, so the resolve response usually carries
    // the previous transition or one still in progress. Observe until the
    // Gateway records a terminal outcome for THIS resolution.
    void this._observePostureTransition(run.id, observation);
  }

  /**
   * Poll `runtime.posture.status` until the Gateway records a terminal outcome
   * for this resolution, bounded.
   *
   * `in-progress` is not an answer: adopting it would report a reconciliation
   * that can still fail as the operator's result. On timeout the gate reports
   * the wait rather than the last thing seen, because "still reconciling" is the
   * truthful state and a stale record is not.
   */
  private async _observePostureTransition(
    runId: string,
    observation: PostureTransitionObservation,
  ): Promise<void> {
    const current = this._captureView(runId);
    for (let attempt = 0; attempt < POSTURE_TRANSITION_POLL_LIMIT; attempt += 1) {
      if (!current()) return;
      // One read per attempt. Clearing `_postureStatusKey` here let the refresh
      // in `updated()` fire a second, concurrent read whose sequence number
      // invalidated this loop's own request, doubling the RPCs and burning an
      // attempt. The key is only cleared once the wait is over.
      await this._refreshPostureStatus(runId);
      if (!current()) return;
      const observed = correlatedPostureTransition(
        observation,
        postureTransitionsOf(this._postureStatus.state),
      );
      if (observed && isTerminalPostureOutcome(observed.outcome)) {
        this._postureGate = postureGateWithAdoptedTransition(
          this._postureGate,
          observed,
          postureTransitionAttributed(observation, observed),
        );
        // The run record moved on; let the normal refresh path pick it up again.
        this._postureStatusKey = '';
        return;
      }
      this._postureGate = { ...this._postureGate, reconciliationPending: true };
      await new Promise((resolve) => setTimeout(resolve, POSTURE_TRANSITION_POLL_INTERVAL_MS));
    }
    if (!current()) return;
    // Bounded and honest: say the Gateway has not finished rather than showing
    // an outcome that is not this resolution's.
    this._postureGate = { ...this._postureGate, reconciliationPending: true };
  }

  private async _checkInteractiveHandoffSignal(
    runId: string,
    decision: RunDecision,
    resumeWorker = false,
  ) {
    const current = this._captureView(runId);
    // A refused posture choice blocks the resume for the same reason it blocks
    // any other resolution: the decision would be consumed by a refusal.
    if (!canResolveWithPostureChoice(this._postureGateStateForRender())) return;
    // Snapshot once: the request and the baseline must agree on what was sent.
    const forwardedChoice = postureChoiceForResolve(this._postureGateStateForRender()) ?? null;
    const observation = this._postureTransitionObservation(forwardedChoice);
    await (resumeWorker ? resumeStoppedNativeWorker : checkInteractiveHandoffSignal)(
      runId,
      decision,
      {
        actionsBlocked: () => !current() || this._actionsBlocked(),
        busy: () => this._handoffSignalCheckBusy,
        setBusy: (busy) => {
          if (current()) this._handoffSignalCheckBusy = busy;
        },
        setError: (error) => {
          if (current()) this._handoffSignalCheckError = error;
        },
        // Only ever forwarded where the Gateway would honour it; a hidden panel
        // must not send a choice the operator cannot see or clear.
        resourcePosture: () => forwardedChoice,
        onDecisionResolved: (run) => {
          if (!current() || this.runId !== run.id) return;
          this._adoptResolvedPostureTransition(run, observation);
        },
      },
    );
  }

  private _jumpToSuccessorWhenAvailable(originRunId: string): void {
    jumpToSuccessorWhenAvailable(originRunId, {
      jumpTimer: () => this._jumpTimer,
      setJumpTimer: (timer) => {
        this._jumpTimer = timer;
      },
      isConnected: () => this.isConnected,
      allRuns: () => getState().runs ?? [],
      navigateToRun: (runId) => {
        location.hash = `run/${runId}`;
      },
    });
  }

  private _confirmTimerContext() {
    return {
      actionsBlocked: () => this._actionsBlocked(),
      pendingConfirm: () => this._pendingConfirm,
      setPendingConfirm: (pending: string | null) => {
        this._pendingConfirm = pending;
      },
      confirmTimer: () => this._confirmTimer,
      setConfirmTimer: (timer: ReturnType<typeof setTimeout> | undefined) => {
        this._confirmTimer = timer;
      },
    };
  }

  private _resolveBranchNudgePick(runId: string, decisionId: string) {
    resolveBranchNudgePick(runId, decisionId, this._slotDecisionContext());
  }

  private _resolveSlotPick(runId: string, decisionId: string) {
    resolveSlotPick(runId, decisionId, this._slotDecisionContext());
  }

  private _slotDecisionContext() {
    return {
      actionsBlocked: () => this._actionsBlocked(),
      selectedSlotId: () => this._selectedSlotId,
      resetBranch: () => this._resetBranch,
      setSelectedSlotId: (slotId: string | null) => {
        this._selectedSlotId = slotId;
      },
      setResetBranch: (resetBranch: boolean) => {
        this._resetBranch = resetBranch;
      },
      setBranchNudgeShowPicker: (show: boolean) => {
        this._branchNudgeShowPicker = show;
      },
    };
  }

  private async _onReplayStep(
    stepName: string,
    skipPrepare?: boolean,
    prepareProfile?: string,
    freshDispatch?: boolean,
  ) {
    if (this._actionsBlocked()) return;
    if (!this.run) return;
    const current = this._captureView(this.run.id);
    if (
      freshDispatch &&
      !window.confirm('Abandon the ambiguous retained handoff, stop its runner, and launch fresh?')
    ) {
      return;
    }
    try {
      await gateway.request(Methods.RUN_REPLAY_STEP, {
        runId: this.run.id,
        stepName,
        skipPrepare: skipPrepare || undefined,
        prepareProfile: prepareProfile || undefined,
        freshDispatch: freshDispatch || undefined,
      });
      if (current()) this.selectedStep = null;
    } catch (err) {
      if (!current()) return;
      const msg = (err as Error)?.message ?? String(err);
      console.error('Replay step failed:', err);
      alert(`Retry from "${stepName}" failed: ${msg}`);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'run-detail': RunDetail;
  }
}
