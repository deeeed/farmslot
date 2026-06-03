import { html, nothing } from 'lit';

import type {
  DevInteractiveProfile,
  DispatchCandidatesResult,
  FlowType,
  QueueItem,
  ReviewRunnerId,
  ReviewValidationDepth,
  Run,
  SlotStatus,
  WorkerTemplateOption,
} from '@farmslot/protocol';

import '../queue/dispatch-queue-panel.js';
import '../shared/hydrating-placeholder.js';

import type { EffortLevel } from '../../utils/runner-options.js';

import {
  renderComparisonModeIndicator,
  renderPriorRunsBanner,
  renderReplayEntryPoint,
  renderVariantInput,
} from './dispatch-wizard-banners-renderer.js';
import { renderDispatchCandidateSelection } from './dispatch-wizard-candidates-renderer.js';
import type { PublicationReviewLoopDraft } from './dispatch-wizard-draft.js';
import { renderDispatchWizardPrimaryControls } from './dispatch-wizard-primary-controls-renderer.js';
import {
  type PublicationReviewPlanItem,
  renderPublicationReviewConfig,
} from './dispatch-wizard-publication-review-renderer.js';

interface DispatchWizardViewContext {
  hydrating: boolean;
  bootstrapFailed: boolean;
  connectionStale: boolean;
  availableProjects: readonly string[];
  ticketId: string;
  matchingProject: boolean;
  issueType: string;
  autoFlowType: boolean;
  flowType: FlowType | null;
  autoProject: string;
  project: string;
  selectedSlotOverride: string;
  projectApps: readonly string[];
  selectedDispatchApp: string | undefined;
  templateOptions: readonly WorkerTemplateOption[];
  templateOptionsLoading: boolean;
  templateOptionsError: string;
  selectedTaskTemplateFileName: string;
  runner: string;
  model: string;
  effort: EffortLevel;
  reviewTier: '' | 'light' | 'standard' | 'full';
  skipPrepare: boolean;
  mode: 'interactive' | 'autonomous';
  devInteractiveProfile: DevInteractiveProfile;
  comparisonLane: boolean;
  comparisonFamilyId: string;
  comparisonParentRunId: string;
  variantPreview: string;
  priorRuns: readonly Run[];
  variantCollision: boolean;
  variantInput: string;
  publicationReviewsEnabled: boolean;
  publicationReviewLoops: readonly PublicationReviewLoopDraft[];
  publicationReviewPlan: readonly PublicationReviewPlanItem[];
  runnerOptions: readonly string[];
  loadingCandidates: boolean;
  candidates: readonly DispatchCandidatesResult['candidates'][number][];
  dispatchableCandidates: readonly DispatchCandidatesResult['candidates'][number][];
  nudgeIntents: ReadonlyMap<string, 'nudge' | 'fresh'>;
  nudgeIntentVersion: number;
  sameTaskSlot: SlotStatus | null;
  dispatching: boolean;
  activeRunConflict: { id: string; status: string } | null;
  error: string;
  candidateRefreshFailed: boolean;
  queueItems: readonly QueueItem[];
  appLabel: (app: string) => string;
  setTicket: (value: string) => void;
  submitTicket: () => void;
  selectFlowType: (flowType: FlowType) => void;
  selectProject: (project: string) => void;
  setApp: (app: string) => void;
  setTaskTemplateFileName: (fileName: string) => void;
  setRunner: (runner: string) => void;
  setModel: (model: string) => void;
  setEffort: (effort: EffortLevel) => void;
  setReviewTier: (reviewTier: '' | 'light' | 'standard' | 'full') => void;
  setSkipPrepare: (skipPrepare: boolean) => void;
  setMode: (mode: 'interactive' | 'autonomous') => void;
  setDevInteractiveProfile: (profile: DevInteractiveProfile) => void;
  openEvals: () => void;
  forkFromPriorRun: (run: Run) => void;
  exitComparisonMode: () => void;
  setVariantInput: (value: string) => void;
  setPublicationReviewRunner: (id: number, runner: ReviewRunnerId) => void;
  setPublicationReviewDepth: (id: number, validationDepth: ReviewValidationDepth) => void;
  removePublicationReviewLoop: (id: number) => void;
  addWorkerReviewLoop: () => void;
  addExternalReviewLoop: () => void;
  candidateDispatchable: (candidate: DispatchCandidatesResult['candidates'][number]) => boolean;
  slotSummaryLabel: (slotId: string) => string;
  selectSlot: (slotId: string) => void;
  setNudgeIntent: (slotId: string, intent: 'nudge' | 'fresh') => void;
  dispatchBlocked: () => boolean;
  dispatchBlockedReason: () => string | null;
  queueBlocked: () => boolean;
  queueBlockedReason: () => string | null;
  canDispatch: () => boolean;
  validationHint: () => string;
  dispatch: () => void | Promise<void>;
  addToQueue: () => void | Promise<void>;
  cancelConflictingRun: () => void | Promise<void>;
}

export function renderDispatchWizardView(ctx: DispatchWizardViewContext) {
  if (ctx.hydrating && ctx.availableProjects.length === 0) {
    return html`<farm-hydrating message="Loading dispatch options…"></farm-hydrating>`;
  }
  return html`
    <div class="header">
      <span class="header-title">Dispatch</span>
    </div>
    ${renderRehydratingBanner(ctx)}
    <div
      class="body ${ctx.hydrating || ctx.bootstrapFailed || ctx.connectionStale
        ? 'rehydrating'
        : ''}"
    >
      ${renderDispatchWizardPrimaryControls({
        ticketId: ctx.ticketId,
        matchingProject: ctx.matchingProject,
        issueType: ctx.issueType,
        autoFlowType: ctx.autoFlowType,
        flowType: ctx.flowType,
        autoProject: ctx.autoProject,
        availableProjects: ctx.availableProjects,
        project: ctx.project,
        projectApps: ctx.projectApps,
        selectedDispatchApp: ctx.selectedDispatchApp,
        interstitialContent: html`
          ${renderReplayEntryPoint({ flowType: ctx.flowType, openEvals: ctx.openEvals })}
          ${renderPriorRunsBanner({
            comparisonLane: ctx.comparisonLane,
            priorRuns: ctx.priorRuns,
            ticketId: ctx.ticketId,
            forkFromPriorRun: ctx.forkFromPriorRun,
          })}
          ${renderComparisonModeIndicator({
            comparisonLane: ctx.comparisonLane,
            familyId: ctx.comparisonFamilyId,
            parentRunId: ctx.comparisonParentRunId,
            variantPreview: ctx.variantPreview,
            exitComparisonMode: ctx.exitComparisonMode,
          })}
        `,
        taskTemplateSelector: renderTaskTemplateSelector(ctx),
        runner: ctx.runner,
        model: ctx.model,
        effort: ctx.effort,
        reviewTier: ctx.reviewTier,
        skipPrepare: ctx.skipPrepare,
        mode: ctx.mode,
        devInteractiveProfile: ctx.devInteractiveProfile,
        appLabel: ctx.appLabel,
        setTicket: ctx.setTicket,
        submitTicket: ctx.submitTicket,
        selectFlowType: ctx.selectFlowType,
        selectProject: ctx.selectProject,
        setApp: ctx.setApp,
        setRunner: ctx.setRunner,
        setModel: ctx.setModel,
        setEffort: ctx.setEffort,
        setReviewTier: ctx.setReviewTier,
        setSkipPrepare: ctx.setSkipPrepare,
        setMode: ctx.setMode,
        setDevInteractiveProfile: ctx.setDevInteractiveProfile,
      })}
      ${renderVariantInput({
        comparisonLane: ctx.comparisonLane,
        variantCollision: ctx.variantCollision,
        variantInput: ctx.variantInput,
        setVariantInput: ctx.setVariantInput,
      })}
      ${renderPublicationReviewConfig({
        enabled: ctx.publicationReviewsEnabled,
        flowType: ctx.flowType,
        runner: ctx.runner,
        mode: ctx.mode,
        loops: ctx.publicationReviewLoops,
        plan: ctx.publicationReviewPlan,
        runnerOptions: ctx.runnerOptions,
        setRunner: ctx.setPublicationReviewRunner,
        setDepth: ctx.setPublicationReviewDepth,
        removeLoop: ctx.removePublicationReviewLoop,
        addWorkerReviewLoop: ctx.addWorkerReviewLoop,
        addExternalReviewLoop: ctx.addExternalReviewLoop,
      })}
      ${renderDispatchCandidateSelection({
        project: ctx.project,
        slotOverride: ctx.selectedSlotOverride,
        loadingCandidates: ctx.loadingCandidates,
        candidates: ctx.candidates,
        dispatchableCandidates: ctx.dispatchableCandidates,
        nudgeIntents: ctx.nudgeIntents,
        nudgeIntentVersion: ctx.nudgeIntentVersion,
        sameTaskSlot: ctx.sameTaskSlot,
        candidateDispatchable: ctx.candidateDispatchable,
        slotSummaryLabel: ctx.slotSummaryLabel,
        selectSlot: ctx.selectSlot,
        setNudgeIntent: ctx.setNudgeIntent,
      })}
      ${renderActionFooter(ctx)}
      <dispatch-queue-panel
        .items=${ctx.queueItems}
        .panelTitle=${'Dispatch Queue'}
      ></dispatch-queue-panel>
    </div>
  `;
}

function renderRehydratingBanner(ctx: DispatchWizardViewContext) {
  return ctx.bootstrapFailed
    ? html`<div class="rehydrating-banner">
        Fleet refresh failed… cached slot availability is shown, dispatch stays paused
      </div>`
    : ctx.connectionStale
      ? html`<div class="rehydrating-banner">
          Gateway disconnected… cached slot availability is shown, dispatch stays paused
        </div>`
      : ctx.hydrating
        ? html`<div class="rehydrating-banner">
            Reconnecting… refreshing slot availability before dispatch resumes
          </div>`
        : nothing;
}

function renderTaskTemplateSelector(ctx: DispatchWizardViewContext) {
  if (!ctx.project || !ctx.flowType) return nothing;
  if (ctx.templateOptionsLoading) {
    return html`<div class="config-group">
      <div class="section-label">Task template</div>
      <div class="section-help">Loading template versions...</div>
    </div>`;
  }
  if (ctx.templateOptionsError) {
    return html`<div class="config-group">
      <div class="section-label">Task template</div>
      <div class="error-inline">${ctx.templateOptionsError}</div>
    </div>`;
  }
  if (ctx.templateOptions.length <= 1) return nothing;
  return html`
    <div class="config-group">
      <div class="section-label">Task template</div>
      <div class="pill-row">
        ${ctx.templateOptions.map(
          (option) => html`
            <button
              class="pill ${ctx.selectedTaskTemplateFileName === option.fileName ? 'selected' : ''}"
              title=${option.fileName}
              @click=${() => ctx.setTaskTemplateFileName(option.fileName)}
            >
              ${option.isDefault ? 'default' : option.label}
            </button>
          `,
        )}
      </div>
      <div class="section-help">Render-only for this run; project templates are not modified.</div>
    </div>
  `;
}

function renderActionFooter(ctx: DispatchWizardViewContext) {
  return html`
    <div class="actions">
      <button
        class="btn primary"
        ?disabled=${ctx.dispatchBlocked()}
        title=${ctx.dispatchBlockedReason() ?? ''}
        @click=${() => ctx.dispatch()}
      >
        ${ctx.dispatching ? 'Dispatching...' : 'Dispatch'}
      </button>
      <button
        class="btn"
        ?disabled=${ctx.queueBlocked()}
        title=${ctx.queueBlockedReason() ?? ''}
        @click=${() => ctx.addToQueue()}
      >
        Queue
      </button>
      <span class="spacer"></span>
      ${renderActionMessage(ctx)}
    </div>
  `;
}

function renderActionMessage(ctx: DispatchWizardViewContext) {
  return ctx.activeRunConflict
    ? html`<span class="error-msg"
        >Active run for ${ctx.ticketId}: ${ctx.activeRunConflict.id.slice(0, 8)}
        (${ctx.activeRunConflict.status}).
        <a class="error-action" href="#run/${ctx.activeRunConflict.id}">Go to run</a>
        <a class="error-action" @click=${() => ctx.cancelConflictingRun()}>Cancel it</a>
      </span>`
    : ctx.error
      ? html`<span class="error-msg">${ctx.error}</span>`
      : ctx.candidateRefreshFailed
        ? html`<span class="error-msg"
            >Slot candidates failed to refresh. Select the project again or wait for
            reconnect.</span
          >`
        : !ctx.canDispatch()
          ? html`<span class="validation-hint">${ctx.validationHint()}</span>`
          : nothing;
}
