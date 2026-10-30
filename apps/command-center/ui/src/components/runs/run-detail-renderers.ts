import { html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';

import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import type {
  AcceptanceCriterionRef,
  AcceptanceEvidenceLink,
  AcceptanceStatusLedger,
  CancelledRunSlotChoices,
  CiCheckUpdatedPayload,
  DevInteractiveCompletionAction,
  FamilyObservabilityArtifact,
  PRStatus,
  Run,
  RunDecision,
  RunGrade,
  TaskProgressStructured,
} from '@farmslot/protocol';
import {
  canActivateRunOnSlot,
  deriveRunLifecycleView,
  isHeldForResultDecision,
  isSettledBlockedRun,
  isSlotFreedByPark,
  isTerminalRunStatus,
  Methods,
  modeForFlow,
  modelsMatch,
  normalizeRunTags,
  observedReviewSessionContinuity,
  resolveRunSlotId,
  reviewChainForRun,
  reviewPublicationPolicyForRun,
  runOutputCloseUnavailableReason,
  runRecoveryHints,
} from '@farmslot/protocol';
import { runActivityView, runResultsSummary, runTerminalView } from '@farmslot/review-dispatch';

import '../slot-view/worker-session-history.js';
import './review-history-panel.js';
import '../shared/workspace-pin.js';
import '../shared/cancelled-run-slot-release.js';
import '../shared/hydrating-placeholder.js';

import { gateway } from '../../gateway-client.js';
import { isPrLinkageMissing } from '../../state.js';
import { colors, fonts, spacing } from '../../styles/theme-tokens.js';
import type { AcceptanceEvidenceOpen } from '../progress-tracker/acceptance-panel.js';
import { renderCollapsibleSectionHeader } from '../shared/collapsible-section-header.js';
import { decisionPayloadKind } from '../shared/decision-payload-model.js';
import type { EvidenceReviewerSelection } from '../shared/evidence-reviewer.js';
import type { EvidenceReviewerView } from '../shared/evidence-reviewer-url-state.js';
import type { LightboxItem, LightboxSelection } from '../shared/media-lightbox-types.js';
import { renderRunTitle } from '../shared/run-title.js';

import { isRecoverableBlockedWorkerRun } from './blocked-run-recovery-model.js';
import { runSourceLinks, ticketUrlForRun } from './family-observability-link-model.js';
import { familyRunHash } from './family-observability-url-state.js';
import type { RunLifecycleAction } from './run-detail-actions.js';
import { renderCancelledRunSlotChoices } from './run-detail-cancelled-slot-renderers.js';
import {
  canLaunchComparisonSibling,
  canReplayRunSteps,
  INTERACTIVE_DEV_ACTIONS,
  isActiveInteractiveDevRun,
  isInteractiveCompletionAwaitingOperator,
  reviewTerminalUnavailableReason,
  RUN_OUTPUT_SCOPE,
} from './run-detail-model.js';
import { runInventoryHashFromDetail } from './run-detail-url-state.js';
import { stepInspectorTaskProgress } from './run-pipeline-model.js';
import { renderReviewProcess, renderRunReviewResult } from './run-review-result-renderer.js';
import {
  collectRunEvidenceArtifacts,
  dispositionColor,
  dispositionLabel,
  formatDuration,
  GRADE_COLORS,
  isEvalCandidateRun,
  pickComparisonPartner,
  prLinkForRun,
  resolveRunEngine,
  routeForRun,
  runChainedModeDrift,
  runDisplayLabel,
  runDisplayTitle,
  runModeLabel,
  runStatusColor,
  runTemplateFileName,
  variantNamesOtherEngine,
} from './run-utils.js';

export interface RunDetailViewContext {
  embedded: boolean;
  run: Run | null;
  prStatus: PRStatus | null;
  siblings: Run[];
  taskProgress: TaskProgressStructured | null;
  /** The run's acceptance ledger (ADR-060), rendered beside the pipeline progress. */
  evidenceModel?: EvidenceReviewModel | null;
  acceptanceStatus: AcceptanceStatusLedger | null;
  /** Registered criteria from the task dir, including any still without a verdict. */
  acceptanceCriteria: AcceptanceCriterionRef[] | null;
  /** Why the ledger could not be read, when it could not. */
  acceptanceStatusError: string | null;
  /** Criteria are still expected: the task is unwritten or its progress read is loading. */
  acceptancePending: boolean;
  /** Manifest-linked criteria when the run has no ledger; never a verdict. */
  acceptanceEvidenceLinks: AcceptanceEvidenceLink[] | null;
  /** Why the evidence manifest behind that fallback could not be read. */
  acceptanceEvidenceLinksError: string | null;
  /** Link builder for a task-dir relative evidence path in the ledger panel. */
  acceptanceEvidenceHref: (evidencePath: string) => string;
  /** Opens a clicked acceptance evidence file in the evidence lightbox. */
  openRecipeProof?: (traceIndex: number) => void;
  acceptanceEvidenceOpen: (open: AcceptanceEvidenceOpen) => void;
  selectedStep: Run['steps'][number] | null;
  selectedStepProgress: TaskProgressStructured | null;
  _hydrating: boolean;
  _bootstrapFailed: boolean;
  _connectionStale: boolean;
  _directRunRefreshing: boolean;
  _directRunRefreshFailed: boolean;
  _directRunUnavailable: boolean;
  _rescueInProgress: boolean;
  _pendingConfirm: string | null;
  linkedTriageAssessmentId: string;
  onTriageDecisionLink: (runId: string, assessmentId: string | null) => void;
  _showTerminal: boolean;
  _terminalContextId: string;
  _terminalRole: string;
  _actionsBlocked: () => boolean;
  _publicationActions: Record<string, { busy: boolean; error?: string }>;
  _retryReviewPublication: (run: Run) => Promise<void>;
  _rescueLinkage: (runId: string) => void | Promise<void>;
  _confirmForceComplete: (run: Run) => void;
  _confirmLifecycleAction: (run: Run, action: RunLifecycleAction) => void | Promise<void>;
  _requestCopilotRunDiagnosis: (run: Run) => void;
  /** Blocked review-pr run whose review is stale: start a continuity round on the current head. */
  _rereviewLatestHead: (run: Run) => void | Promise<void>;
  _rereviewInFlight: boolean;
  _buildRerunAlongsideHref: (run: Run) => string;
  _slotBranchForRun: (run: Run) => string;
  _slotHealthForRun: (run: Run) => import('@farmslot/protocol').SlotHealth | null;
  /** The slot a cancelled run still holds for replay, with its two choices. */
  _cancelledRunSlot: CancelledRunSlotChoices | null;
  _setRunLinkedTickets: (run: Run, refs: string[]) => void | Promise<void>;
  _setRunTags: (run: Run, tags: string[]) => void | Promise<void>;
  _renderInteractiveDevGate: (run: Run) => unknown;
  _currentCiStatus: (run: Run) => CiCheckUpdatedPayload | null;
  _shouldShowCiStatus: (run: Run) => boolean;
  _renderCiStatus: (run: Run) => unknown;
  _renderRunEvidence: (run: Run) => unknown;
  /**
   * ADR-054 resource posture, rendered beside the pipeline phase. It takes no
   * run: the panel renders the posture status already fetched for the bound run.
   */
  _renderPosture: (run: Run) => unknown;
  _renderInteractivePackets: (run: Run) => unknown;
  _renderAgentSessions: (run: Run) => unknown;
  _onReplayStep: (
    stepName: string,
    skipPrepare?: boolean,
    prepareProfile?: string,
    freshDispatch?: boolean,
  ) => void | Promise<void>;
  renderGateSection: (run: Run) => unknown;
  renderGrade: (grade: RunGrade) => unknown;
  onStepSelect: (step: Run['steps'][number]) => void;
  onStepInspectorClose: () => void;
  toggleTerminal: () => void;
}

export interface InteractiveDevGateRenderContext {
  busyAction: string | null;
  actionsBlocked: boolean;
  resolveInteractiveDev: (run: Run, action: DevInteractiveCompletionAction) => void | Promise<void>;
}

export function renderInteractiveDevGate(run: Run, ctx: InteractiveDevGateRenderContext): unknown {
  if (!isActiveInteractiveDevRun(run)) return nothing;
  const button = (
    action: DevInteractiveCompletionAction,
    label: string,
    title: string,
    tone: 'primary' | 'muted' | 'danger' = 'muted',
  ) => html`
    <button
      class="gate-action-btn"
      style="border-color:${tone === 'primary'
        ? colors.accent
        : tone === 'danger'
          ? colors.statusFail
          : colors.textMuted}; color:${tone === 'primary'
        ? colors.accent
        : tone === 'danger'
          ? colors.statusFail
          : colors.textMuted}; padding:4px 10px; font-size:11px"
      title=${title}
      ?disabled=${ctx.actionsBlocked || !!ctx.busyAction}
      @click=${() => ctx.resolveInteractiveDev(run, action)}
    >
      ${ctx.busyAction === action ? 'Working…' : label}
    </button>
  `;
  return html`
    <div
      class="redirect-banner"
      style="margin:8px 0; padding:10px 14px; border:1px solid ${colors.accent}; border-radius:4px; background:${colors.accent}11; color:${colors.textPrimary}; font-size:${fonts.sizeSm}"
    >
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap">
        <strong>Interactive dev</strong>
        <span style="color:${colors.textMuted}"
          >${run.devInteractiveProfile ?? 'lightweight'} profile</span
        >
        ${isInteractiveCompletionAwaitingOperator(run)
          ? html`<strong style="color:${colors.statusWarn}"
              >Worker finished. Choose what happens next.</strong
            >`
          : nothing}
        ${INTERACTIVE_DEV_ACTIONS.map(({ action, label, title, tone }) =>
          button(action, label, title, tone),
        )}
      </div>
    </div>
  `;
}

export interface RunEvidenceRenderContext {
  selectedSharedEvidence?: boolean;
  taskProgress?: TaskProgressStructured | null;
  evidenceLightboxItems: LightboxItem[];
  evidenceLightboxOpen: boolean;
  evidenceLightboxIndex: number;
  /** Lightbox scope label; defaults to the run's output. */
  evidenceLightboxScope?: string;
  evidenceArtifactUnavailable?: { path: string; reason: string } | null;
  artifactUrl: (artifact: FamilyObservabilityArtifact) => string;
  onEvidenceArtifactClick: (
    event: CustomEvent<{ artifacts: FamilyObservabilityArtifact[]; index: number }>,
  ) => void;
  closeEvidenceLightbox: () => void;
  /** Set while one criterion's evidence is open in the full-screen review. */
  evidenceReviewer?: EvidenceReviewerSelection | null;
  /** The view the open review reports, for the link. */
  reviewerView?: (view: EvidenceReviewerView) => void;
  /** The files of the criterion the review shows, in the gallery. */
  showEvidenceGallery?: (claimId: string) => void;
  /** Set when the open gallery is one criterion's files: its recording can switch to the review. */
  reviewEvidence?: () => void;
  selectEvidenceClaim?: (claimId: string) => void;
  navigateEvidenceLightbox: (index: number) => void;
  replaceEvidenceLightbox: (selection: LightboxSelection) => void;
  refreshOutput?: () => void;
  refreshingOutput?: boolean;
  outputError?: string;
  closingOutput?: boolean;
  actionsBlocked?: boolean;
  closeOutput?: (decision: RunDecision) => void;
}

export function renderRunEvidence(run: Run, ctx: RunEvidenceRenderContext): unknown {
  return html`<section data-shared-run-panel="evidence" tabindex="-1">
    ${renderRunEvidenceContent(run, ctx)}
  </section>`;
}

function renderRunEvidenceContent(run: Run, ctx: RunEvidenceRenderContext): unknown {
  if (run.reviewWorkspaceTarget)
    return html`${renderReviewProcess(run, ctx)}${renderEvidenceLightbox(ctx)}`;
  const artifacts = collectRunEvidenceArtifacts(run);
  const evidence = runResultsSummary(run, artifacts.length);
  // A worker command log link opens here while the run is still active and has
  // no results card yet, so the lightbox renders either way.
  if (!evidence.shouldRender)
    return html`${ctx.selectedSharedEvidence
      ? html`<p>No saved evidence for this run.</p>`
      : nothing}${renderEvidenceLightbox(ctx)}`;
  const review = [...run.decisions]
    .reverse()
    .find(
      (decision) =>
        decision.payload?.kind === 'output-review' &&
        (decision.payload.manifestDigest === run.output?.manifestDigest ||
          (run.output?.closedAt && decision.resolvedAction === 'close-run')) &&
        decision.resolvedAction !== 'superseded',
    );
  const openArtifact = (file: string) => {
    const index = artifacts.findIndex((artifact) => artifact.path === file);
    if (index >= 0)
      ctx.onEvidenceArtifactClick(
        new CustomEvent('step-artifact-click', { detail: { artifacts, index } }),
      );
  };

  return html`
    <div class="evidence-card" data-testid="run-results">
      <div class="evidence-head">
        <div>
          <div class="evidence-title">${evidence.title}</div>
          <div class="evidence-copy">${evidence.copy}</div>
        </div>
        <span class="evidence-badge">${evidence.badge}</span>
      </div>
      ${run.error && !isHeldForResultDecision(run)
        ? html`<p role="status">${run.error}</p>`
        : nothing}
      <div class="evidence-actions">
        ${run.output?.reportPath
          ? html`<button
              class="evidence-link"
              @click=${() => openArtifact(run.output!.reportPath!)}
            >
              Read report
            </button>`
          : nothing}
        ${artifacts.find((artifact) => artifact.path === 'artifacts/retrospective.md')
          ? html`<button
              class="evidence-link"
              @click=${() => openArtifact('artifacts/retrospective.md')}
            >
              Read retrospective
            </button>`
          : nothing}
        ${ctx.refreshOutput
          ? html`<button
              class="evidence-link"
              ?disabled=${ctx.actionsBlocked || ctx.refreshingOutput || ctx.closingOutput}
              @click=${ctx.refreshOutput}
            >
              ${ctx.refreshingOutput ? 'Retrieving files…' : 'Refresh output'}
            </button>`
          : nothing}
        ${evidence.showEvalPackageHint
          ? html`
              <span class="evidence-empty"
                >Reference comparison lives in the eval family package panel.</span
              >
            `
          : nothing}
        <a class="evidence-link" href=${`#family/${run.familyId}?run=${encodeURIComponent(run.id)}`}
          >Open family evidence</a
        >
        ${evidence.completeStep && !run.output
          ? html`<a class="evidence-link" href=${`#run/${run.id}?step=complete`}
              >Open complete step</a
            >`
          : nothing}
      </div>
      ${ctx.outputError ? html`<p role="alert">${ctx.outputError}</p>` : nothing}
      ${run.output?.closeError
        ? html`<p role="alert">
            Execution is closed, but resource cleanup needs attention: ${run.output.closeError}
          </p>`
        : nothing}
      ${run.output?.cleanupPending
        ? html`<p role="status">Execution is closed; resource cleanup is pending.</p>`
        : nothing}
      ${review?.resolvedAt &&
      ctx.closeOutput &&
      (!run.output?.closedAt || run.output.closeError || run.output.cleanupPending)
        ? html`<button
            class="evidence-link"
            data-testid="close-run-output"
            title=${runOutputCloseUnavailableReason(run) ??
            'Keep the recorded verdict and close execution'}
            ?disabled=${ctx.actionsBlocked ||
            ctx.closingOutput ||
            Boolean(runOutputCloseUnavailableReason(run))}
            @click=${() => ctx.closeOutput!(review)}
          >
            ${ctx.closingOutput
              ? 'Closing…'
              : run.output?.closedAt
                ? 'Retry resource cleanup'
                : 'Close run'}
          </button>`
        : nothing}
      ${artifacts.length && run.output?.captureError
        ? html`<p role="alert">Could not retrieve worker files: ${run.output.captureError}</p>`
        : nothing}
      ${artifacts.length
        ? html`
            <details data-testid="run-output-files">
              <summary class="output-file-summary">Browse files (${artifacts.length})</summary>
              <step-artifacts
                stepName="Output files"
                status=${evidence.status}
                .durationMs=${evidence.completeStep?.durationMs}
                .artifacts=${artifacts}
                .artifactUrl=${ctx.artifactUrl}
                default-open
                @step-artifact-click=${(
                  event: CustomEvent<{ artifacts: FamilyObservabilityArtifact[]; index: number }>,
                ) => ctx.onEvidenceArtifactClick(event)}
              ></step-artifacts>
            </details>
          `
        : html`<div class="evidence-empty">${evidence.emptyMessage}</div>`}
      ${renderEvidenceLightbox(ctx)}
    </div>
  `;
}

function renderEvidenceLightbox(ctx: RunEvidenceRenderContext) {
  const unavailable = ctx.evidenceArtifactUnavailable;
  return html`${unavailable
      ? html`<div
          class="evidence-unavailable"
          role="alert"
          data-testid="evidence-artifact-unavailable"
        >
          <span>Cannot open <code>${unavailable.path}</code>: ${unavailable.reason}</span>
          <button type="button" @click=${() => ctx.closeEvidenceLightbox()}>Dismiss</button>
        </div>`
      : nothing}${ctx.evidenceReviewer
      ? html`<evidence-reviewer
          .selection=${ctx.evidenceReviewer}
          @reviewer-close=${() => ctx.closeEvidenceLightbox()}
          @reviewer-files=${(event: CustomEvent<{ claimId: string }>) =>
            ctx.showEvidenceGallery?.(event.detail.claimId)}
          @reviewer-view=${(event: CustomEvent<EvidenceReviewerView>) =>
            ctx.reviewerView?.(event.detail)}
          @reviewer-claim=${(event: CustomEvent<{ claimId: string }>) =>
            ctx.selectEvidenceClaim?.(event.detail.claimId)}
        ></evidence-reviewer>`
      : nothing}<media-lightbox
      .items=${ctx.evidenceLightboxItems}
      .open=${ctx.evidenceLightboxOpen && !ctx.evidenceReviewer}
      .reviewable=${Boolean(ctx.reviewEvidence)}
      @lightbox-review=${() => ctx.reviewEvidence?.()}
      .selectedIndex=${ctx.evidenceLightboxIndex}
      scopeLabel=${ctx.evidenceLightboxScope ?? RUN_OUTPUT_SCOPE}
      @lightbox-close=${() => ctx.closeEvidenceLightbox()}
      @lightbox-navigate=${(event: CustomEvent) => ctx.navigateEvidenceLightbox(event.detail.index)}
      @lightbox-items-change=${(event: CustomEvent<LightboxSelection>) =>
        ctx.replaceEvidenceLightbox(event.detail)}
    ></media-lightbox>`;
}

export function renderRunGrade(grade: RunGrade): unknown {
  const dc = GRADE_COLORS[grade.difficulty] ?? colors.textMuted;
  return html`
    <div class="grade-card">
      <span class="grade-difficulty" style="background:${dc}22; color:${dc}"
        >${grade.difficulty}</span
      >
      <span class="grade-rationale">${grade.rationale}</span>
      ${grade.modelRecommendation
        ? html`<span style="color:${colors.textMuted}">${grade.modelRecommendation}</span>`
        : nothing}
    </div>
  `;
}

export function renderReviewChain(run: Run): unknown {
  const chain = reviewChainForRun(run);
  if (chain.length === 0) return nothing;
  return html`
    <section class="review-chain" aria-label="Review chain">
      <div class="review-chain-title">Review chain · ${chain.length} generation(s)</div>
      <div class="review-chain-grid">
        ${chain.map((entry) => {
          const range = `${entry.baseSha?.slice(0, 8) ?? 'base'} → ${entry.headSha?.slice(0, 8) ?? 'pending'}`;
          const continuity = observedReviewSessionContinuity(entry);
          return html`
            <a class="review-chain-row" href=${`#run/${entry.runId}`}>
              <span class="review-chain-generation">G${entry.generation}</span>
              <span title=${`${entry.repository}#${entry.prNumber}`}>${range}</span>
              <span>${entry.mode.toUpperCase()} · ${entry.validationDepth}</span>
              <span
                >${entry.verdict} ·
                ${entry.unresolvedCount == null
                  ? 'unresolved pending'
                  : `${entry.unresolvedCount} unresolved`}</span
              >
              <span class="review-chain-session ${continuity}">${continuity}</span>
            </a>
          `;
        })}
      </div>
    </section>
  `;
}

export function renderRunDetailView(ctx: RunDetailViewContext) {
  const backToRuns = ctx.embedded
    ? nothing
    : html`<div
        class="back"
        @click=${() => {
          location.hash = runInventoryHashFromDetail();
        }}
      >
        &lt; Back to runs
      </div>`;
  if (!ctx.run) {
    if (ctx._hydrating) {
      return html` ${backToRuns} ${renderRunDetailSkeleton()} `;
    }
    if (ctx._bootstrapFailed) {
      return html` ${backToRuns} ${renderRunDetailSkeleton('Run unavailable')} `;
    }
    if (ctx._directRunUnavailable) {
      return html`
        ${backToRuns}
        <div class="empty">Run is no longer available</div>
      `;
    }
    if (ctx._directRunRefreshFailed) {
      return html` ${backToRuns} ${renderRunDetailSkeleton('Run unavailable')} `;
    }
    return html`<div class="empty">Run not found</div>`;
  }
  const r = ctx.run;
  const sc = runStatusColor(r.status);
  const activityLabel = runActivityView(r)?.label ?? deriveRunLifecycleView(r).activityLabel;
  const disposition = dispositionLabel(r.metrics.disposition);
  const suggestedComparePartner = pickComparisonPartner(r, ctx.siblings);
  // ctx.siblings excludes the current run, so add it back when it is itself a
  // comparison lane to get the family's full comparison-lane count.
  const comparisonLaneCount =
    ctx.siblings.filter((s) => s.lane === 'comparison').length + (r.lane === 'comparison' ? 1 : 0);
  const actionsBlocked = ctx._actionsBlocked();
  const publication = reviewPublicationPolicyForRun(r);
  const hasGatePanel = r.decisions.some(
    (decision) =>
      !decision.resolvedAt &&
      ((decision.type === 'engine_human_gate' && decision.payload?.kind === 'ready') ||
        (decision.type === 'engine_output_review' && decision.payload?.kind === 'output-review')),
  );
  const prLink = prLinkForRun(r);
  const sources = runSourceLinks(r);
  const ticketUrl = ticketUrlForRun(r.ticketOrPr, r, ctx.siblings);
  const familyRootUrl =
    r.familyRootTicketOrPr && r.familyRootTicketOrPr !== r.ticketOrPr
      ? ticketUrlForRun(r.familyRootTicketOrPr, r, ctx.siblings)
      : ticketUrl;
  const familyHref = familyRunHash(r.familyId, r.id);
  const familyRunScopeHref = familyRunHash(r.familyId, r.id, { tokens: 'run' });
  const isTerminal = isTerminalRunStatus(r.status);
  const engine = resolveRunEngine(r);
  const boundSlotId = resolveRunSlotId(r);
  const terminalUnavailable = reviewTerminalUnavailableReason(r);
  const terminal = runTerminalView(r, ctx._showTerminal ? ctx._terminalContextId : undefined);
  const terminalOpen = ctx._showTerminal && !terminal.disabledReason;
  const openReviewGate = r.decisions.some(
    (decision) => !decision.resolvedAt && decision.type === 'engine_review_posting',
  );
  const openPublicationGate = r.decisions.some(
    (decision) =>
      !decision.resolvedAt &&
      decision.type === 'engine_human_gate' &&
      decision.payload?.kind === 'ready',
  );
  // ADR-054 `free-slot`: while the park record holds the release, the slot row
  // belongs to dispatch, not to this run. `isSlotFreedByPark` ignores `phase`,
  // and cancel deliberately skips slot release for a park-freed run, so this
  // marker outlives the run: on a terminal run the badge is still TRUE and the
  // restore it used to promise can never happen. The claim is kept; the promise
  // is not. The run still names the slot — its
  // recovery handle and preserved branch key off it — so the badge keeps the
  // link and says what is actually true about occupancy instead of implying the
  // run is sitting in it.
  const slotFreedByPark = isSlotFreedByPark(r);
  const executionTemplate = r.executionTemplate ?? r.templateProvenance?.executionTemplate;
  const variantDrift = Boolean(r.variant && variantNamesOtherEngine(r.variant, engine));

  return html`
    ${backToRuns} ${openReviewGate ? ctx.renderGateSection(r) : nothing}
    <source-status-panel
      .context=${{ target: { scope: 'run', targetId: r.id }, actions: ['pin', 'unpin'] }}
    ></source-status-panel>
    <file-transfer-progress-banner inline run-id=${r.id}></file-transfer-progress-banner>
    <a
      class="context-read-link"
      href=${`#intelligence?tab=assessments&suggestion=copilot-context&run=${encodeURIComponent(r.id)}`}
      >Suggest a next context read</a
    >
    ${r.redirectedToRunId
      ? html`
          <div
            class="redirect-banner"
            style="margin:8px 0; padding:10px 14px; border:1px solid ${colors.accent}; border-radius:4px; background:${colors.accent}11; color:${colors.textPrimary}; font-size:${fonts.sizeSm}"
          >
            This run was forked into a comparison-lane successor.
            <a
              href="#run/${r.redirectedToRunId}"
              style="color:${colors.accent}; text-decoration:none; margin-left:6px"
              >Open successor ${r.redirectedToRunId.slice(0, 8)} →</a
            >
          </div>
        `
      : nothing}
    <div class="header">
      <h2>
        ${ticketUrl
          ? html`<a
              href=${ticketUrl}
              target="_blank"
              rel="noopener noreferrer"
              style="color:inherit; text-decoration:none"
              title="Open work item"
              >${r.ticketOrPr}</a
            >`
          : r.ticketOrPr}
      </h2>
      <span
        class="status-badge ${activityLabel ? 'run-activity-label' : ''}"
        style="border:1px solid ${sc}; color:${sc}"
        title=${activityLabel ?? nothing}
        >${activityLabel ?? r.status}</span
      >
      ${disposition
        ? html`<span
            class="status-badge"
            style="border:1px solid ${dispositionColor(
              r.metrics.disposition,
            )}; color:${dispositionColor(r.metrics.disposition)}"
            >${disposition}</span
          >`
        : nothing}
      ${isPrLinkageMissing(r)
        ? html`
            <button
              class="gate-action-btn"
              style="border-color:${colors.statusWarn}; color:${colors.statusWarn}; padding:4px 12px; font-size:11px"
              title="Run done but no PR linked on branch ${r.branch}. Re-runs findPRNumber and kicks CI watch."
              ?disabled=${actionsBlocked || ctx._rescueInProgress}
              @click=${() => ctx._rescueLinkage(r.id)}
            >
              ${ctx._rescueInProgress ? 'Linking…' : 'Rescue PR linkage'}
            </button>
          `
        : nothing}
      ${r.links?.length
        ? html`<span class="external-links"
            >${r.links.map(
              (l) =>
                html`<a class="ext-link" href=${l.url} target="_blank" rel="noopener noreferrer"
                  >${l.label}</a
                >`,
            )}</span
          >`
        : nothing}
      ${keyed(
        r.id,
        html`<run-tag-editor
          kind="tickets"
          .disabled=${actionsBlocked}
          .run=${r}
          .saveTags=${(refs: string[]) => ctx._setRunLinkedTickets(r, refs)}
        ></run-tag-editor>`,
      )}
      <run-tag-editor
        .tags=${normalizeRunTags(r.tags)}
        .disabled=${actionsBlocked}
        .saveTags=${(tags: string[]) => ctx._setRunTags(r, tags)}
        .filterTag=${(tag: string) => {
          location.hash = `runs?tag=${encodeURIComponent(tag)}`;
        }}
      ></run-tag-editor>
      ${r.status === 'ci-watching' || r.status === 'failed'
        ? html`
            <button
              class="gate-action-btn ${ctx._pendingConfirm === 'force-complete'
                ? 'gate-confirming'
                : ''}"
              style="${ctx._pendingConfirm === 'force-complete'
                ? ''
                : `border-color:${colors.textMuted}; color:${colors.textMuted}; padding:4px 12px; font-size:11px`}"
              ?disabled=${actionsBlocked}
              @click=${() => ctx._confirmForceComplete(r)}
            >
              ${ctx._pendingConfirm === 'force-complete'
                ? 'Confirm complete?'
                : 'Complete Manually'}
            </button>
          `
        : nothing}
      ${r.status === 'blocked'
        ? html`
            <button
              class="gate-action-btn ${ctx._pendingConfirm === `cancel:${r.id}`
                ? 'gate-confirming'
                : ''}"
              style="border-color:${colors.statusFail}; color:${colors.statusFail}; padding:4px 12px; font-size:11px"
              title="Stop this blocked run and release its slot (overwrites the blocked outcome; use Archive as blocked to keep it)"
              ?disabled=${actionsBlocked}
              @click=${() => ctx._confirmLifecycleAction(r, 'cancel')}
            >
              ${ctx._pendingConfirm === `cancel:${r.id}` ? 'Confirm cancel?' : 'Cancel run'}
            </button>
            ${isSettledBlockedRun(r)
              ? html`
                  <button
                    class="gate-action-btn ${ctx._pendingConfirm === `archive:${r.id}`
                      ? 'gate-confirming'
                      : ''}"
                    data-testid="run-archive-blocked"
                    style="border-color:${colors.textMuted}; color:${colors.textMuted}; padding:4px 12px; font-size:11px"
                    title="Nothing is left to advance. Keep the blocked outcome in history and remove the run from the active list (replay a step instead to retry)"
                    ?disabled=${actionsBlocked}
                    @click=${() => ctx._confirmLifecycleAction(r, 'archive')}
                  >
                    ${ctx._pendingConfirm === `archive:${r.id}`
                      ? 'Confirm archive?'
                      : 'Archive as blocked'}
                  </button>
                `
              : nothing}
          `
        : isTerminal
          ? html`
              <button
                class="gate-action-btn ${ctx._pendingConfirm === `delete:${r.id}`
                  ? 'gate-confirming'
                  : ''}"
                style="border-color:${colors.statusFail}; color:${colors.statusFail}; padding:4px 12px; font-size:11px"
                title="Permanently remove this terminal run from history"
                ?disabled=${actionsBlocked}
                @click=${() => ctx._confirmLifecycleAction(r, 'delete')}
              >
                ${ctx._pendingConfirm === `delete:${r.id}` ? 'Confirm delete?' : 'Delete run'}
              </button>
            `
          : nothing}
      ${canLaunchComparisonSibling(r.status)
        ? html`
            <a
              class="gate-action-btn"
              style="border:1px solid ${colors.accent}; color:${colors.accent}; padding:4px 12px; font-size:11px; text-decoration:none; border-radius:3px"
              title="Fork a comparison-lane sibling on a different runner/model (grok, codex, cursor, …). Opens dispatch with this run as baseline; pick runner and slot before dispatch."
              href=${ctx._buildRerunAlongsideHref(r)}
            >
              Launch comparison sibling →
            </a>
          `
        : nothing}
      ${boundSlotId && r.branch && canActivateRunOnSlot(r.status)
        ? html`
            <slot-prepare-popover
              slot-id=${boundSlotId}
              slot-branch=${ctx._slotBranchForRun(r)}
              project=${r.project}
              run-id=${r.id}
              run-branch=${r.branch}
              button-label="Load ${boundSlotId} with this run →"
              button-style="border:1px solid ${colors.textMuted}; color:${colors.textMuted}; padding:4px 12px; font-size:11px; border-radius:3px"
              .slotHealth=${ctx._slotHealthForRun(r)}
              ?disabled=${actionsBlocked}
            ></slot-prepare-popover>
          `
        : nothing}
      ${r.status === 'failed'
        ? html`
            <button
              class="gate-action-btn"
              style="border-color:${colors.statusFail}; color:${colors.statusFail}; padding:4px 12px; font-size:11px"
              title="Open Co-Pilot with a read-only failure diagnosis prompt"
              @click=${() => ctx._requestCopilotRunDiagnosis(r)}
            >
              Diagnose failure
            </button>
          `
        : nothing}
    </div>
    ${r.summary ? html`${renderRunTitle(r, 'header-summary')}` : nothing}
    ${openPublicationGate ? ctx.renderGateSection(r) : nothing}
    ${r.slotTeardownSkipped
      ? html`<p role="status" data-testid="run-slot-cleanup-hint">
          Workspace cleanup deferred: ${r.slotTeardownSkipped}
        </p>`
      : nothing}
    ${(hasGatePanel ? [] : runRecoveryHints(r)).map(
      (hint) => html`<p role="status" data-testid="run-recovery-hint">${hint}</p>`,
    )}
    ${r.flowType === 'review-pr' && publication
      ? html`<div class="review-publication" data-testid="run-review-publication">
          <strong
            >PR publication:
            ${r.reviewPublication?.receipt?.state === 'published'
              ? 'Published'
              : r.reviewPublication?.error
                ? 'Needs attention'
                : publication.enabled
                  ? 'Requested'
                  : 'Farmslot results only'}</strong
          >
          <span>
            ·
            ${publication.account
              ? `${publication.account.login} · `
              : ''}${publication.source}</span
          >
          ${r.reviewPublication?.receipt?.url
            ? html`<a
                class="ext-link"
                href=${r.reviewPublication.receipt.url}
                target="_blank"
                rel="noopener noreferrer"
                >View published review</a
              >`
            : nothing}
          ${r.reviewPublication?.error && !ctx._publicationActions[r.id]?.error
            ? html`<p role="alert">${r.reviewPublication.error}</p>`
            : nothing}
          ${ctx._publicationActions[r.id]?.error &&
          (r.reviewPublication?.receipt?.state !== 'published' || r.reviewPublication?.error)
            ? html`<p role="alert">${ctx._publicationActions[r.id].error}</p>`
            : nothing}
          ${publication.enabled &&
          r.status === 'done' &&
          r.reviewPublication?.receipt?.state !== 'published'
            ? html`
                <button
                  data-testid="run-review-publication-retry"
                  ?disabled=${actionsBlocked || ctx._publicationActions[r.id]?.busy}
                  @click=${() => ctx._retryReviewPublication(r)}
                >
                  ${ctx._publicationActions[r.id]?.busy
                    ? 'Checking publication…'
                    : r.reviewPublication?.error || r.reviewPublication?.receipt
                      ? 'Retry publication'
                      : 'Publish now'}
                </button>
              `
            : nothing}
        </div>`
      : nothing}
    ${r.qa
      ? html`<p data-testid="run-qa-profile">
          QA profile: <strong>${r.qa.profile.title}</strong> <code>${r.qa.profile.id}</code>
        </p>`
      : nothing}
    ${r.qaAfterReview
      ? html`<div class="redirect-banner" data-testid="run-automatic-qa">
          <strong>Automatic QA: ${r.qaAfterReview.selection.profile.title}</strong>
          <span> · ${r.qaAfterReview.state}</span>
          ${r.qaAfterReview.error ? html`<p>${r.qaAfterReview.error}</p>` : nothing}
        </div>`
      : nothing}
    ${ctx._renderInteractiveDevGate(r)}
    <div class="meta">
      <div class="meta-item">
        <div class="meta-label">ID</div>
        <div class="meta-value">${r.id.slice(0, 8)}</div>
      </div>
      ${sources.length
        ? html`<div class="meta-item" data-testid="run-source">
            <div class="meta-label">Source</div>
            <div class="meta-value">
              ${sources.map((source) =>
                source.url
                  ? html`<a
                      href=${source.url}
                      target=${source.url.startsWith('#') ? '_self' : '_blank'}
                      rel="noopener noreferrer"
                      title=${r.ticketData?.title ?? ''}
                      style="color:${colors.accent}; text-decoration:none; margin-right:8px"
                      >${source.label} ${source.text}${source.url.startsWith('#') ? '' : ' ↗'}</a
                    >`
                  : html`<span title="Link not resolved yet" style="margin-right:8px"
                      >${source.label} ${source.text}</span
                    >`,
              )}
            </div>
          </div>`
        : nothing}
      <div class="meta-item">
        <div class="meta-label">Family</div>
        <div class="meta-value">
          <a href=${familyHref} style="color:${colors.accent}; text-decoration:none"
            >${r.familyId.slice(0, 8)}</a
          >
        </div>
      </div>
      ${r.familyRootTicketOrPr && r.familyRootTicketOrPr !== r.ticketOrPr
        ? html`<div class="meta-item">
            <div class="meta-label">Family root</div>
            <div class="meta-value">
              ${familyRootUrl
                ? html`<a
                    href=${familyRootUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style="color:${colors.accent}; text-decoration:none"
                    >${r.familyRootTicketOrPr}</a
                  >`
                : r.familyRootTicketOrPr}
            </div>
          </div>`
        : nothing}
      ${prLink
        ? html`<div class="meta-item">
            <div class="meta-label">${prLink.label}</div>
            <div class="meta-value">
              <a
                href=${prLink.url}
                target="_blank"
                rel="noopener noreferrer"
                style="color:${colors.accent}; text-decoration:none"
                >${prLink.ref}</a
              >
            </div>
          </div>`
        : nothing}
      <div class="meta-item">
        <div class="meta-label">Type</div>
        <div class="meta-value" title=${runDisplayTitle(r)}>${runDisplayLabel(r)}</div>
      </div>
      ${runModeLabel(r)
        ? html`<div class="meta-item">
            <div class="meta-label">Mode</div>
            <div class="meta-value">${runModeLabel(r)}</div>
          </div>`
        : nothing}
      ${executionTemplate || runTemplateFileName(r)
        ? html`<div class="meta-item">
            <div class="meta-label">Template</div>
            <div class="meta-value">${executionTemplate?.id ?? runTemplateFileName(r)}</div>
          </div>`
        : nothing}
      ${executionTemplate
        ? html`
            <div class="meta-item">
              <div class="meta-label">Template source</div>
              <div class="meta-value">${executionTemplate.sourceId}</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Source digest</div>
              <div class="meta-value" title=${executionTemplate.sha256}>
                ${executionTemplate.sha256.slice(0, 12)}
              </div>
            </div>
          `
        : nothing}
      ${r.domain
        ? html`<div class="meta-item">
            <div class="meta-label">Domain</div>
            <div class="meta-value">${r.domain}</div>
          </div>`
        : nothing}
      ${runChainedModeDrift(r)
        ? html`<div class="meta-item" style="grid-column:1/-1">
            <div class="meta-label">Mode note</div>
            <div class="meta-value" style="color:${colors.statusWarn}">
              Chained ${r.flowType} run is ${r.mode}; flow baseline is ${modeForFlow(r.flowType)}.
            </div>
          </div>`
        : nothing}
      ${isEvalCandidateRun(r)
        ? html`<div class="meta-item">
            <div class="meta-label">Carrier</div>
            <div class="meta-value">${r.flowType}</div>
          </div>`
        : nothing}
      <div class="meta-item">
        <div class="meta-label">Lane</div>
        <div class="meta-value">${r.lane}</div>
      </div>
      ${r.startRef
        ? html`<div class="meta-item">
            <div class="meta-label">Replay</div>
            <div class="meta-value">start-ref · no PR publish</div>
          </div>`
        : nothing}
      ${r.startRef
        ? html`<div class="meta-item">
            <div class="meta-label">Start ref</div>
            <div class="meta-value" title=${r.startRef.requestedRef}>
              ${(r.startRef.resolvedSha ?? r.startRef.requestedRef).slice(0, 12)}
            </div>
          </div>`
        : nothing}
      ${r.variant
        ? html`<div class="meta-item">
            <div class="meta-label">Variant tag</div>
            <div class="meta-value">
              ${r.variant}${variantDrift
                ? html`
                    <span
                      class="model-drift"
                      title="Lane tag does not match dispatched engine ${engine.runner}/${engine.model}. Engine row is authoritative."
                    >
                      ⚠ engine mismatch</span
                    >
                  `
                : nothing}
            </div>
          </div>`
        : nothing}
      ${r.parentRunId
        ? html`<div class="meta-item">
            <div class="meta-label">Parent</div>
            <div class="meta-value">
              <a href="#run/${r.parentRunId}" style="color:${colors.accent}; text-decoration:none"
                >${r.parentRunId.slice(0, 8)}</a
              >
            </div>
          </div>`
        : nothing}
      <div class="meta-item">
        <div class="meta-label">Project</div>
        <div class="meta-value">${r.project}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">${r.reviewWorkspaceTarget ? 'Workspace' : 'Slot'}</div>
        <div class="meta-value">
          ${boundSlotId
            ? html`<a
                  href=${`#slot/${boundSlotId}?runId=${encodeURIComponent(r.id)}`}
                  style="color:${colors.accent}; text-decoration:none"
                  >${boundSlotId}</a
                >
                <workspace-pin .slotId=${boundSlotId}></workspace-pin>
                ${slotFreedByPark
                  ? html`<span
                      data-testid="run-slot-freed-by-park"
                      data-terminal=${isTerminal ? 'true' : 'false'}
                      style="margin-left:8px; color:${colors.statusWarn}; font-size:10px; font-family:${fonts.mono}"
                      title=${isTerminal
                        ? 'A free-slot park released this slot before the run reached its end state. No restore will happen.'
                        : 'A free-slot park released this slot; answering the gate restores the run into it.'}
                      >freed for dispatch</span
                    >`
                  : nothing}
                ${renderCancelledRunSlotChoices(r, {
                  choices: ctx._cancelledRunSlot,
                  replayAllowed: canReplayRunSteps(r, actionsBlocked),
                  onReplayStep: ctx._onReplayStep,
                })}`
            : r.reviewWorkspace
              ? html`<span
                    data-testid="run-workspace-location"
                    title=${r.reviewWorkspace.checkoutPath}
                    >${r.reviewWorkspace.machine} ·
                    ${r.reviewWorkspace.cleanedAt ? 'cleaned' : 'worktree'}</span
                  >
                  <workspace-pin .runId=${r.id} .label=${r.ticketOrPr}></workspace-pin>
                  ${!r.reviewWorkspace.cleanedAt
                    ? html`<a class="ext-link" href=${`#terminal?run=${encodeURIComponent(r.id)}`}
                        >Terminal</a
                      >`
                    : nothing}`
              : r.reviewWorkspaceTarget
                ? 'Allocating worktree…'
                : 'pending'}
        </div>
      </div>
      ${r.branch
        ? html`<div class="meta-item">
            <div class="meta-label">Branch</div>
            <div class="meta-value">${r.branch}</div>
          </div>`
        : nothing}
      ${engine.model
        ? html`<div class="meta-item">
            <div class="meta-label">Runner</div>
            <div class="meta-value">
              ${engine.runner ?? ''}/${engine.model}${r.metrics.actualModel &&
              r.metrics.model &&
              !modelsMatch(r.metrics.model, r.metrics.actualModel)
                ? html` <span
                    class="model-drift"
                    title="Dispatched '${r.metrics.model}' but session ran '${r.metrics
                      .actualModel}' — likely fast-mode or /model override. Cost may be much higher than expected."
                    >⚠ ran: ${r.metrics.actualModel}</span
                  >`
                : nothing}
            </div>
          </div>`
        : nothing}
      ${r.metrics.providerAccountLabel
        ? html`<div class="meta-item">
            <div class="meta-label">Provider account</div>
            <div
              class="meta-value"
              title="Operator subscription label that funded this run (after any failover). Label only."
            >
              ${r.metrics.providerAccountLabel}
            </div>
          </div>`
        : nothing}
      ${r.metrics.sessionTurns
        ? html`<div class="meta-item">
            <div class="meta-label">Turns</div>
            <div class="meta-value">${r.metrics.sessionTurns.toLocaleString()}</div>
          </div>`
        : nothing}
      ${r.metrics.costEstimate
        ? html`<div class="meta-item">
            <div class="meta-label">Cost</div>
            <div class="meta-value">$${r.metrics.costEstimate.toFixed(2)}</div>
          </div>`
        : nothing}
      ${r.metrics.sessionInputTokens || r.metrics.sessionOutputTokens
        ? html`<div class="meta-item">
            <div class="meta-label">Tokens</div>
            <div class="meta-value">
              in ${(r.metrics.sessionInputTokens ?? 0).toLocaleString()} · out
              ${(r.metrics.sessionOutputTokens ?? 0).toLocaleString()}${r.metrics.sessionCacheRead
                ? html` · cache-read ${r.metrics.sessionCacheRead.toLocaleString()}`
                : nothing}
            </div>
          </div>`
        : nothing}
      ${r.metrics.durationMs
        ? html`<div class="meta-item">
            <div class="meta-label">Duration</div>
            <div class="meta-value">${formatDuration(r.metrics.durationMs)}</div>
          </div>`
        : nothing}
      ${r.metrics.nudgeCount > 0
        ? html`<div class="meta-item">
            <div class="meta-label">Nudges</div>
            <div class="meta-value">${r.metrics.nudgeCount}</div>
          </div>`
        : nothing}
      ${ctx.siblings.length
        ? html`<div class="meta-item">
            <div class="meta-label">Siblings</div>
            <div class="meta-value">
              <a
                href="#runs?family=${encodeURIComponent(r.familyId)}"
                style="color:${colors.accent}; text-decoration:none"
                >${ctx.siblings.length}</a
              >
            </div>
          </div>`
        : nothing}
      <div class="meta-item">
        <div class="meta-label">${isTerminal ? 'Retrospective' : 'Family view'}</div>
        <div class="meta-value">
          <a href=${familyRunScopeHref} style="color:${colors.accent}; text-decoration:none"
            >open</a
          >
        </div>
      </div>
      ${ctx.prStatus
        ? html`<div class="meta-item">
            <div class="meta-label">Workflow milestone</div>
            <div class="meta-value">${ctx.prStatus.workflowState ?? '-'}</div>
          </div>`
        : nothing}
      ${ctx.prStatus
        ? html`<div class="meta-item">
            <div class="meta-label">Merge milestone</div>
            <div class="meta-value">${ctx.prStatus.mergeState?.replace(/_/g, ' ') ?? '-'}</div>
          </div>`
        : nothing}
      ${suggestedComparePartner
        ? html`
            <div class="meta-item">
              <div class="meta-label">Suggested compare</div>
              <div class="meta-value">
                <a
                  href="#runs/compare?a=${r.id}&b=${suggestedComparePartner.id}"
                  style="color:${colors.accent}; text-decoration:none"
                >
                  ${suggestedComparePartner.variant ?? suggestedComparePartner.ticketOrPr}
                </a>
              </div>
            </div>
          `
        : nothing}
    </div>
    ${r.reviewWorkspaceTarget || r.output || r.completionPolicy === 'artifact-only'
      ? ctx._renderRunEvidence(r)
      : nothing}
    ${r.output && !openReviewGate && !openPublicationGate ? ctx.renderGateSection(r) : nothing}
    ${!openReviewGate
      ? renderRunReviewResult(
          r,
          () => void ctx._onReplayStep('human-gate'),
          actionsBlocked || ctx._rereviewInFlight,
          () => void ctx._rereviewLatestHead(r),
        )
      : nothing}
    ${r.reviewWorkspace && !r.output && !openReviewGate && !openPublicationGate
      ? ctx.renderGateSection(r)
      : nothing}
    ${ctx._renderAgentSessions(r)} ${renderReviewChain(r)}
    ${ctx.siblings.length
      ? html`
          <div class="grade-card">
            <div class="grade-rationale">
              Family siblings:
              ${r.status === 'done'
                ? html`<a
                    href="#family/${r.familyId}?run=${encodeURIComponent(r.id)}"
                    style="color:${colors.accent}; text-decoration:none"
                    >retrospective</a
                  >`
                : nothing}${comparisonLaneCount >= 2
                ? html` ·
                    <a
                      href="#family/${r.familyId}?run=${encodeURIComponent(r.id)}"
                      style="color:${colors.accent}; text-decoration:none"
                      >compare ${comparisonLaneCount} lanes</a
                    >`
                : nothing}
              ${ctx.siblings.map(
                (s, i) =>
                  html`${i ? html` · ` : nothing}<a
                      href=${`#${routeForRun(s)}`}
                      style="color:${colors.accent}; text-decoration:none"
                      >${s.ticketOrPr}${s.variant ? `/${s.variant}` : ''}</a
                    >
                    <span style="color:${colors.textMuted}">[${s.lane}/${s.status}]</span
                    >${s.lane === 'comparison' || r.lane === 'comparison'
                      ? html` <a
                          href="#runs/compare?a=${r.id}&b=${s.id}"
                          style="color:${colors.textMuted}; text-decoration:none"
                          >(compare)</a
                        >`
                      : nothing}`,
              )}
            </div>
          </div>
        `
      : nothing}
    ${r.grade ? ctx.renderGrade(r.grade) : nothing} ${ctx._renderPosture(r)}
    ${r.flowType === 'dev' && r.steps.some((s) => s.status === 'failed')
      ? html`<failure-triage-panel
          .runId=${r.id}
          .canLinkDecision=${(() => {
            const pending = r.decisions.find((d) => !d.resolvedAt);
            const kind = decisionPayloadKind(pending?.payload);
            return Boolean(
              pending &&
              kind !== 'slot_picker' &&
              kind !== 'branch_affinity_nudge' &&
              kind !== 'retrospective' &&
              pending.type !== 'monitor_interactive_handoff' &&
              pending.type !== 'retrospective',
            );
          })()}
          .linkedAssessmentId=${ctx.linkedTriageAssessmentId}
          @triage-decision-link=${(
            e: CustomEvent<{ runId: string; assessmentId: string | null }>,
          ) => ctx.onTriageDecisionLink(e.detail.runId, e.detail.assessmentId)}
          .runVersion=${JSON.stringify([
            r.status,
            r.steps
              .filter((s) => s.status === 'failed')
              .map((s) => [s.name, s.startedAt, s.completedAt, s.detail]),
          ])}
        ></failure-triage-panel>`
      : nothing}
    <div class="pipeline-section" data-shared-run-panel="timeline" tabindex="-1">
      <run-pipeline
        reason-in-header
        .run=${r}
        .taskProgress=${ctx.taskProgress}
        .evidenceModel=${ctx.evidenceModel}
        .acceptanceStatus=${ctx.acceptanceStatus}
        .acceptanceCriteria=${ctx.acceptanceCriteria}
        .acceptanceStatusError=${ctx.acceptanceStatusError}
        .acceptancePending=${ctx.acceptancePending}
        .acceptanceEvidenceLinks=${ctx.acceptanceEvidenceLinks}
        .acceptanceEvidenceLinksError=${ctx.acceptanceEvidenceLinksError}
        .acceptanceEvidenceHref=${ctx.acceptanceEvidenceHref}
        .acceptanceEvidenceOpen=${ctx.acceptanceEvidenceOpen}
        .selectedStepName=${ctx.selectedStep?.name}
        @recipe-proof=${(event: CustomEvent<{ traceIndex: number }>) =>
          ctx.openRecipeProof?.(event.detail.traceIndex)}
        @step-select=${(e: CustomEvent) => ctx.onStepSelect(e.detail.step)}
      >
      </run-pipeline>
      <review-history-panel .run=${r}></review-history-panel>
      ${ctx.selectedStep
        ? html`
            <step-inspector
              .step=${ctx.selectedStep}
              .run=${ctx.run}
              .showReviewHistory=${false}
              .taskProgress=${stepInspectorTaskProgress({
                selectedStepName: ctx.selectedStep?.name,
                run: ctx.run ?? undefined,
                liveProgress: ctx.taskProgress,
                selectedStepProgress: ctx.selectedStepProgress,
              })}
              .allowReplay=${canReplayRunSteps(r, actionsBlocked)}
              @inspector-close=${() => ctx.onStepInspectorClose()}
              @step-replay=${(e: CustomEvent) =>
                ctx._onReplayStep(
                  e.detail.stepName,
                  e.detail.skipPrepare,
                  e.detail.prepareProfile,
                  e.detail.freshDispatch,
                )}
            >
            </step-inspector>
            ${ctx.selectedStep.name === 'ci-watch' && ctx._currentCiStatus(r)
              ? ctx._renderCiStatus(r)
              : ''}
          `
        : nothing}
      ${ctx._currentCiStatus(r) && ctx._shouldShowCiStatus(r) && !ctx.selectedStep
        ? ctx._renderCiStatus(r)
        : ''}
    </div>
    ${ctx._renderInteractivePackets(r)}
    ${r.reviewWorkspaceTarget || r.output || r.completionPolicy === 'artifact-only'
      ? nothing
      : ctx._renderRunEvidence(r)}
    ${!terminal.context?.nativeSession &&
    (boundSlotId || (r.reviewWorkspace && !terminalUnavailable))
      ? html`
          ${renderCollapsibleSectionHeader(
            boundSlotId
              ? `Terminal (${terminal.target?.slotId ?? boundSlotId})`
              : `${r.transport === 'native' ? 'Worktree shell' : 'Reviewer terminal'} (${r.reviewWorkspace!.machine})`,
            !terminalOpen,
            ctx.toggleTerminal,
            {
              testId: 'run-terminal-toggle',
              className: `terminal-toggle worker-panel-toggle ${terminalOpen ? 'active' : ''}`,
              disabled: Boolean(terminal.disabledReason),
              title: terminal.disabledReason ?? '',
            },
          )}
          ${terminal.disabledReason
            ? html`<span role="status">${terminal.disabledReason}</span>`
            : nothing}
          ${terminalOpen
            ? html`<div class="terminal-section">
                <terminal-view
                  .slotId=${terminal.target?.slotId ?? boundSlotId ?? ''}
                  .runId=${r.id}
                  .contextId=${terminal.target?.contextId ?? ctx._terminalContextId}
                  .role=${terminal.target?.role ?? ctx._terminalRole}
                ></terminal-view>
              </div>`
            : nothing}
        `
      : !terminal.context?.nativeSession && r.reviewWorkspace
        ? html`<p data-testid="review-terminal-unavailable">${terminalUnavailable}</p>`
        : nothing}
    ${r.reviewWorkspace || r.output || openPublicationGate ? nothing : ctx.renderGateSection(r)}
    ${isRecoverableBlockedWorkerRun(r)
      ? html`<details>
          <summary class="output-file-summary">Worker recovery (advanced)</summary>
          <p class="evidence-copy">
            Use this only to resume unfinished execution. It does not review the report or validate
            missing checks.
          </p>
          <blocked-run-recovery
            .run=${r}
            .disabled=${actionsBlocked}
            .resumeWorker=${async () => {
              await gateway.request(Methods.RUN_RESUME, { runId: r.id });
            }}
            .restartWorker=${() => ctx._onReplayStep('find-slot')}
          ></blocked-run-recovery>
        </details>`
      : nothing}
    ${r.error && !r.output
      ? html`
          <div class="error-box">
            <div>${r.error}</div>
            ${r.flowType === 'review-pr' &&
            !r.reviewWorkspace &&
            (r.status === 'blocked' || r.status === 'done' || r.status === 'failed') &&
            r.steps.some((step) => step.detail === 'stale-review')
              ? html`
                  <button
                    class="gate-action-btn"
                    data-testid="run-rereview-latest-head"
                    ?disabled=${ctx._rereviewInFlight}
                    style="margin-top:${spacing.sm}; padding:4px 12px; font-size:11px"
                    title="Start a new review round on the PR's current head, resuming this reviewer session when it is still available"
                    @click=${() => ctx._rereviewLatestHead(r)}
                  >
                    Re-review on latest head
                  </button>
                `
              : nothing}
            ${r.status === 'failed'
              ? html`
                  <button
                    class="gate-action-btn"
                    style="margin-top:${spacing.sm}; border-color:${colors.statusFail}; color:${colors.statusFail}; padding:4px 12px; font-size:11px"
                    @click=${() => ctx._requestCopilotRunDiagnosis(r)}
                  >
                    Ask Co-Pilot why
                  </button>
                `
              : nothing}
          </div>
        `
      : nothing}
  `;
}

export function renderRunDetailSkeleton(error = '') {
  return html`<farm-hydrating
    message="Run details"
    .error=${error}
    @retry=${() => location.reload()}
    ><div style="display:grid;gap:16px;min-height:520px">
      <farm-skeleton width="65%" height="32"></farm-skeleton>
      <div style="display:flex;gap:12px">
        <farm-skeleton kind="button" width="120px"></farm-skeleton
        ><farm-skeleton kind="button" width="144px"></farm-skeleton>
      </div>
      <farm-skeleton kind="block" height="120"></farm-skeleton
      ><farm-skeleton width="35%"></farm-skeleton>${Array.from(
        { length: 5 },
        () => html`<farm-skeleton kind="row"></farm-skeleton>`,
      )}
    </div></farm-hydrating
  >`;
}
