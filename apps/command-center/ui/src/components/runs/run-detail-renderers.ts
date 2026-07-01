import { html, nothing } from 'lit';

import type {
  CiCheckUpdatedPayload,
  DevInteractiveCompletionAction,
  FamilyObservabilityArtifact,
  PRStatus,
  Run,
  RunGrade,
} from '@farmslot/protocol';
import {
  canActivateRunOnSlot,
  modeForFlow,
  modelsMatch,
  normalizeRunTags,
} from '@farmslot/protocol';

import { isPrLinkageMissing } from '../../state.js';
import { colors, fonts, spacing } from '../../styles/theme-tokens.js';
import { isSlotPinned } from '../../utils/pinned-slots.js';
import type { LightboxItem } from '../shared/media-lightbox-types.js';

import { ticketUrlForRun } from './family-observability-link-model.js';
import { familyRunHash } from './family-observability-url-state.js';
import {
  canReplayRunSteps,
  INTERACTIVE_DEV_ACTIONS,
  isActiveInteractiveDevRun,
  runEvidenceSummary,
} from './run-detail-model.js';
import {
  collectRunEvidenceArtifacts,
  dispositionColor,
  dispositionLabel,
  formatDuration,
  GRADE_COLORS,
  isEvalCandidateRun,
  pickComparisonPartner,
  prLinkForRun,
  routeForRun,
  runChainedModeDrift,
  runDisplayLabel,
  runDisplayTitle,
  runModeLabel,
  runStatusColor,
  runTemplateFileName,
} from './run-utils.js';

export interface RunDetailViewContext {
  run: Run | null;
  prStatus: PRStatus | null;
  siblings: Run[];
  taskProgress: unknown;
  selectedStep: Run['steps'][number] | null;
  selectedStepProgress: unknown;
  _hydrating: boolean;
  _bootstrapFailed: boolean;
  _connectionStale: boolean;
  _directRunRefreshing: boolean;
  _directRunRefreshFailed: boolean;
  _directRunUnavailable: boolean;
  _rescueInProgress: boolean;
  _pendingConfirm: string | null;
  _showTerminal: boolean;
  _actionsBlocked: () => boolean;
  _rescueLinkage: (runId: string) => void | Promise<void>;
  _confirmForceComplete: (runId: string) => void;
  _requestCopilotRunDiagnosis: (run: Run) => void;
  _buildRerunAlongsideHref: (run: Run) => string;
  _slotBranchForRun: (run: Run) => string;
  _slotHealthForRun: (run: Run) => import('@farmslot/protocol').SlotHealth | null;
  _setRunTags: (run: Run, tags: string[]) => void | Promise<void>;
  _togglePinnedSlot: (slotId: string) => void;
  _renderInteractiveDevGate: (run: Run) => unknown;
  _currentCiStatus: (run: Run) => CiCheckUpdatedPayload | null;
  _shouldShowCiStatus: (run: Run) => boolean;
  _renderCiStatus: (run: Run) => unknown;
  _renderRunEvidence: (run: Run) => unknown;
  _onReplayStep: (
    stepName: string,
    skipPrepare?: boolean,
    prepareProfile?: string,
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
        ${INTERACTIVE_DEV_ACTIONS.map(({ action, label, title, tone }) =>
          button(action, label, title, tone),
        )}
      </div>
    </div>
  `;
}

export interface RunEvidenceRenderContext {
  evidenceLightboxItems: LightboxItem[];
  evidenceLightboxOpen: boolean;
  evidenceLightboxIndex: number;
  artifactUrl: (artifact: FamilyObservabilityArtifact) => string;
  onEvidenceArtifactClick: (
    event: CustomEvent<{ artifacts: FamilyObservabilityArtifact[]; index: number }>,
  ) => void;
  closeEvidenceLightbox: () => void;
  navigateEvidenceLightbox: (index: number) => void;
}

export function renderRunEvidence(run: Run, ctx: RunEvidenceRenderContext): unknown {
  const artifacts = collectRunEvidenceArtifacts(run);
  const evidence = runEvidenceSummary(run, artifacts);
  if (!evidence.shouldRender) return nothing;

  return html`
    <div class="evidence-card">
      <div class="evidence-head">
        <div>
          <div class="evidence-title">${evidence.title}</div>
          <div class="evidence-copy">${evidence.copy}</div>
        </div>
        <span class="evidence-badge">${evidence.badge}</span>
      </div>
      <div class="evidence-actions">
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
        ${evidence.completeStep
          ? html`<a class="evidence-link" href=${`#run/${run.id}?step=complete`}
              >Open complete step</a
            >`
          : nothing}
      </div>
      ${artifacts.length
        ? html`
            <step-artifacts
              stepName="run evidence"
              status=${evidence.status}
              .durationMs=${evidence.completeStep?.durationMs}
              .artifacts=${artifacts}
              .artifactUrl=${ctx.artifactUrl}
              default-open
              @step-artifact-click=${(
                event: CustomEvent<{ artifacts: FamilyObservabilityArtifact[]; index: number }>,
              ) => ctx.onEvidenceArtifactClick(event)}
            ></step-artifacts>
          `
        : html`<div class="evidence-empty">${evidence.emptyMessage}</div>`}
      <media-lightbox
        .items=${ctx.evidenceLightboxItems}
        .open=${ctx.evidenceLightboxOpen}
        .selectedIndex=${ctx.evidenceLightboxIndex}
        scopeLabel="Replay evidence"
        @lightbox-close=${() => ctx.closeEvidenceLightbox()}
        @lightbox-navigate=${(event: CustomEvent) =>
          ctx.navigateEvidenceLightbox(event.detail.index)}
      ></media-lightbox>
    </div>
  `;
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

export function renderRunDetailView(ctx: RunDetailViewContext) {
  if (!ctx.run) {
    if (ctx._hydrating) {
      return html`
        <div
          class="back"
          @click=${() => {
            location.hash = 'runs';
          }}
        >
          &lt; Back to runs
        </div>
        <farm-hydrating message="Loading runs…"></farm-hydrating>
      `;
    }
    if (ctx._bootstrapFailed) {
      return html`
        <div
          class="back"
          @click=${() => {
            location.hash = 'runs';
          }}
        >
          &lt; Back to runs
        </div>
        <div class="empty">Run data refresh failed during reconnect</div>
      `;
    }
    if (ctx._directRunUnavailable) {
      return html`
        <div
          class="back"
          @click=${() => {
            location.hash = 'runs';
          }}
        >
          &lt; Back to runs
        </div>
        <div class="empty">Run is no longer available</div>
      `;
    }
    if (ctx._directRunRefreshFailed) {
      return html`
        <div
          class="back"
          @click=${() => {
            location.hash = 'runs';
          }}
        >
          &lt; Back to runs
        </div>
        <div class="empty">Run data refresh failed during reconnect</div>
      `;
    }
    return html`<div class="empty">Run not found</div>`;
  }
  const r = ctx.run;
  const sc = runStatusColor(r.status);
  const disposition = dispositionLabel(r.metrics.disposition);
  const suggestedComparePartner = pickComparisonPartner(r, ctx.siblings);
  // ctx.siblings excludes the current run, so add it back when it is itself a
  // comparison lane to get the family's full comparison-lane count.
  const comparisonLaneCount =
    ctx.siblings.filter((s) => s.lane === 'comparison').length + (r.lane === 'comparison' ? 1 : 0);
  const actionsBlocked = ctx._actionsBlocked();
  const prLink = prLinkForRun(r);
  const ticketUrl = ticketUrlForRun(r.ticketOrPr, r, ctx.siblings);
  const familyRootUrl =
    r.familyRootTicketOrPr && r.familyRootTicketOrPr !== r.ticketOrPr
      ? ticketUrlForRun(r.familyRootTicketOrPr, r, ctx.siblings)
      : ticketUrl;
  const familyHref = familyRunHash(r.familyId, r.id);
  const familyRunScopeHref = familyRunHash(r.familyId, r.id, { tokens: 'run' });
  const isTerminal = r.status === 'done' || r.status === 'failed' || r.status === 'cancelled';

  return html`
    <div
      class="back"
      @click=${() => {
        location.hash = 'runs';
      }}
    >
      &lt; Back to runs
    </div>
    ${ctx._bootstrapFailed
      ? html`<div class="rehydrating-banner">
          Run refresh failed… showing cached data and pausing actions
        </div>`
      : ctx._connectionStale
        ? html`<div class="rehydrating-banner">
            Gateway disconnected… showing cached data and pausing actions
          </div>`
        : ctx._directRunRefreshFailed
          ? html`<div class="rehydrating-banner">
              Run refresh failed… showing cached data and pausing actions
            </div>`
          : ctx._directRunRefreshing
            ? html`<div class="rehydrating-banner">Refreshing run details… actions are paused</div>`
            : ctx._hydrating
              ? html`<div class="rehydrating-banner">
                  Reconnecting… showing last snapshot and pausing actions
                </div>`
              : nothing}
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
      <span class="status-badge" style="border:1px solid ${sc}; color:${sc}">${r.status}</span>
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
      <run-tag-editor
        .tags=${normalizeRunTags(r.tags)}
        .disabled=${actionsBlocked}
        .saveTags=${(tags: string[]) => ctx._setRunTags(r, tags)}
        .filterTag=${(tag: string) => {
          location.hash = `runs?tag=${encodeURIComponent(tag)}`;
        }}
      ></run-tag-editor>
      ${r.status === 'ci-watching'
        ? html`
            <button
              class="gate-action-btn ${ctx._pendingConfirm === 'force-complete'
                ? 'gate-confirming'
                : ''}"
              style="${ctx._pendingConfirm === 'force-complete'
                ? ''
                : `border-color:${colors.textMuted}; color:${colors.textMuted}; padding:4px 12px; font-size:11px`}"
              ?disabled=${actionsBlocked}
              @click=${() => ctx._confirmForceComplete(r.id)}
            >
              ${ctx._pendingConfirm === 'force-complete'
                ? 'Confirm complete?'
                : 'Complete Manually'}
            </button>
          `
        : nothing}
      ${r.status === 'done' || r.status === 'failed' || r.status === 'cancelled'
        ? html`
            <a
              class="gate-action-btn"
              style="border:1px solid ${colors.accent}; color:${colors.accent}; padding:4px 12px; font-size:11px; text-decoration:none; border-radius:3px"
              title="Fork a new comparison run from this one (own slot + worker) so you can compare runners/models side by side. Opens the dispatch wizard prefilled; the original run is untouched."
              href=${ctx._buildRerunAlongsideHref(r)}
            >
              Re-run alongside →
            </a>
          `
        : nothing}
      ${r.slotId && r.branch && canActivateRunOnSlot(r.status)
        ? html`
            <slot-prepare-popover
              slot-id=${r.slotId}
              slot-branch=${ctx._slotBranchForRun(r)}
              project=${r.project}
              run-id=${r.id}
              run-branch=${r.branch}
              button-label="Load ${r.slotId} with this run →"
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
    ${r.summary ? html`<div class="header-summary">${r.summary}</div>` : nothing}
    ${ctx._renderInteractiveDevGate(r)}
    <div class="meta">
      <div class="meta-item">
        <div class="meta-label">ID</div>
        <div class="meta-value">${r.id.slice(0, 8)}</div>
      </div>
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
      ${runTemplateFileName(r)
        ? html`<div class="meta-item">
            <div class="meta-label">Template</div>
            <div class="meta-value">${runTemplateFileName(r)}</div>
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
            <div class="meta-label">Variant</div>
            <div class="meta-value">${r.variant}</div>
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
        <div class="meta-label">Slot</div>
        <div class="meta-value">
          ${r.slotId
            ? html`<a
                  href=${`#slot/${r.slotId}?runId=${encodeURIComponent(r.id)}`}
                  style="color:${colors.accent}; text-decoration:none"
                  >${r.slotId}</a
                >
                <button
                  style="margin-left:8px; border:1px solid ${isSlotPinned(r.slotId)
                    ? colors.accent
                    : colors.bgCardHover}; color:${isSlotPinned(r.slotId)
                    ? colors.accent
                    : colors.textMuted}; background:transparent; border-radius:4px; font-size:10px; font-family:${fonts.mono}; cursor:pointer"
                  @click=${() => ctx._togglePinnedSlot(r.slotId!)}
                  title="Toggle this run's slot in pinned slots"
                >
                  ${isSlotPinned(r.slotId) ? 'pinned' : 'pin'}
                </button>`
            : 'pending'}
        </div>
      </div>
      ${r.branch
        ? html`<div class="meta-item">
            <div class="meta-label">Branch</div>
            <div class="meta-value">${r.branch}</div>
          </div>`
        : nothing}
      ${r.metrics.model
        ? html`<div class="meta-item">
            <div class="meta-label">Runner</div>
            <div class="meta-value">
              ${r.metrics.runner ?? ''}/${r.metrics.model}${r.metrics.actualModel &&
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
    ${r.grade ? ctx.renderGrade(r.grade) : nothing}
    <div class="pipeline-section">
      <run-pipeline
        .run=${r}
        .taskProgress=${ctx.taskProgress}
        @step-select=${(e: CustomEvent) => ctx.onStepSelect(e.detail.step)}
      >
      </run-pipeline>
      ${ctx.selectedStep
        ? html`
            <step-inspector
              .step=${ctx.selectedStep}
              .run=${ctx.run}
              .taskProgress=${ctx.selectedStepProgress}
              .allowReplay=${canReplayRunSteps(r, actionsBlocked)}
              @inspector-close=${() => ctx.onStepInspectorClose()}
              @step-replay=${(e: CustomEvent) =>
                ctx._onReplayStep(e.detail.stepName, e.detail.skipPrepare, e.detail.prepareProfile)}
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
    ${ctx._renderRunEvidence(r)}
    ${r.slotId
      ? html`
          <button
            class="terminal-toggle ${ctx._showTerminal ? 'active' : ''}"
            @click=${() => {
              ctx.toggleTerminal();
            }}
          >
            ${ctx._showTerminal ? '- Hide' : '+ Show'} Terminal (${r.slotId})
          </button>
          ${ctx._showTerminal
            ? html`
                <div class="terminal-section">
                  <terminal-view .slotId=${r.slotId} .runId=${r.id}></terminal-view>
                </div>
              `
            : nothing}
        `
      : nothing}
    ${ctx.renderGateSection(r)}
    ${r.error
      ? html`
          <div class="error-box">
            <div>${r.error}</div>
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
