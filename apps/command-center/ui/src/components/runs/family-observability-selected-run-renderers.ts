import { html, nothing } from 'lit';

import type {
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
  PRStatus,
  Run,
  RunDecision,
  RunStep,
} from '@farmslot/protocol';

import '../shared/step-artifacts.js';
import '../workspace/ready-workspace.js';
import './run-pipeline.js';
import './step-inspector.js';

import {
  familyPublishGateMaximizeLabel,
  familyPublishGateReopenLabel,
  familyReadyGateDecision,
} from './family-observability-gate-model.js';
import { pendingRetrospectiveDecision } from './family-observability-retrospective-model.js';
import { renderPendingRetrospectiveDecision } from './family-observability-retrospective-renderers.js';
import {
  renderFamilyLearnings,
  renderFamilyRunSummaryGrid,
  renderFamilySummarySteps,
} from './family-observability-run-detail-renderers.js';
import { canReplayRunSteps } from './run-detail-model.js';

interface FamilySelectedRunDetailRenderOptions {
  run: FamilyObservabilityRunSummary;
  runs: readonly FamilyObservabilityRunSummary[];
  prs: readonly PRStatus[];
  fullRun: Run | null;
  fullRunLoading: boolean;
  fullRunError: string | undefined;
  selectedStep: RunStep | null;
  replayingStep: boolean;
  replayError: string;
  onResolveRetrospective: (
    run: FamilyObservabilityRunSummary,
    decision: RunDecision,
    actionId: string,
  ) => void;
  onOpenStepArtifact: (
    artifacts: FamilyObservabilityArtifact[],
    index: number,
    event: CustomEvent<{ artifacts: FamilyObservabilityArtifact[]; index: number }>,
  ) => void;
  onSelectStep: (step: RunStep) => void;
  onCloseStepInspector: () => void;
  onReplayStep: (
    stepName: string,
    skipPrepare?: boolean,
    prepareProfile?: string,
    freshDispatch?: boolean,
  ) => void;
  renderLedgerDiffDetail: (run: FamilyObservabilityRunSummary) => unknown;
  gateOpen: boolean;
  gateMaximized: boolean;
  onTogglePublishGate: () => void;
  onTogglePublishGateMaximize: () => void;
}

export function renderFamilySelectedRunDetail(options: FamilySelectedRunDetailRenderOptions) {
  const retrospective = pendingRetrospectiveDecision(options.run);
  return html`
    ${renderPendingRetrospectiveDecision({
      run: options.run,
      decision: retrospective,
      onResolve: options.onResolveRetrospective,
    })}
    ${renderFamilyPublishGateReopen(options)}
    ${renderFamilyRunSummaryGrid({ run: options.run, runs: options.runs, prs: options.prs })}
    ${renderFamilyRunPipelineDetail(options)} ${options.renderLedgerDiffDetail(options.run)}
    ${renderFamilyRecipeQualityDetail(options.run)} ${renderFamilyRecipeProvenance(options.run)}
    ${renderFamilyLearnings(options.run)} ${renderFamilyMissingData(options.run)}
  `;
}

function renderFamilyPublishGateReopen(options: FamilySelectedRunDetailRenderOptions) {
  const decision = familyReadyGateDecision(options.fullRun) ?? familyReadyGateDecision(options.run);
  if (!decision) return nothing;
  const resolvedLabel = decision.resolvedAt
    ? `Resolved · ${decision.resolvedAction ?? 'done'}`
    : 'Pending';
  const maximized = options.gateOpen && options.gateMaximized;
  return html`
    <div
      class="detail-section publish-gate-reopen ${maximized ? 'maximized' : ''}"
      data-testid="family-publish-gate"
      data-gate-open=${options.gateOpen ? 'true' : 'false'}
      data-gate-max=${maximized ? 'true' : 'false'}
      data-resolved-action=${decision.resolvedAction ?? ''}
    >
      <div class="publish-gate-reopen-head">
        <div class="detail-title">Publish gate</div>
        <span class="muted">${resolvedLabel}</span>
        <span class="publish-gate-reopen-actions">
          ${options.gateOpen
            ? html`
                <button
                  class="action-btn small"
                  type="button"
                  data-testid="family-maximize-publish-gate"
                  @click=${options.onTogglePublishGateMaximize}
                >
                  ${familyPublishGateMaximizeLabel(maximized)}
                </button>
              `
            : nothing}
          <button
            class="action-btn small"
            type="button"
            data-testid="family-reopen-publish-gate"
            @click=${options.onTogglePublishGate}
          >
            ${familyPublishGateReopenLabel({ decision, gateOpen: options.gateOpen })}
          </button>
        </span>
      </div>
      ${options.gateOpen
        ? options.fullRun
          ? html`
              <div class="publish-gate-host">
                <ready-workspace
                  .runId=${options.fullRun.id}
                  .decision=${decision}
                  .run=${options.fullRun}
                  slotId=${options.fullRun.slotId ?? ''}
                  branch=${options.fullRun.branch ?? ''}
                  runner=${options.fullRun.metrics.runner ?? ''}
                  .postureBlockedReason=${decision.resolvedAt
                    ? null
                    : 'Resolve this gate from Run Detail so resource posture can be chosen.'}
                ></ready-workspace>
              </div>
            `
          : html`<div class="muted">
              ${options.fullRunLoading
                ? 'Loading publish gate…'
                : options.fullRunError
                  ? `Publish gate unavailable: ${options.fullRunError}`
                  : 'Publish gate run payload unavailable.'}
            </div>`
        : nothing}
    </div>
  `;
}

function renderFamilyRunPipelineDetail(options: FamilySelectedRunDetailRenderOptions) {
  const summaryStepFallback = renderFamilySummarySteps({
    run: options.run,
    onOpenStepArtifact: options.onOpenStepArtifact,
  });
  if (!options.fullRun) {
    if (options.fullRunLoading) {
      return html`
        <div class="detail-section pipeline-host muted">Loading pipeline graph…</div>
        ${summaryStepFallback}
      `;
    }
    if (options.fullRunError) {
      return html`
        <div class="detail-section pipeline-host diff-error">
          Pipeline graph unavailable: ${options.fullRunError}
        </div>
        ${summaryStepFallback}
      `;
    }
    return summaryStepFallback;
  }
  return html`
    <div class="detail-section pipeline-host">
      <run-pipeline
        .run=${options.fullRun}
        @step-select=${(event: CustomEvent<{ step: RunStep }>) => {
          options.onSelectStep(event.detail.step);
        }}
      >
      </run-pipeline>
      ${options.selectedStep
        ? html`
            <step-inspector
              .step=${options.selectedStep}
              .run=${options.fullRun}
              .allowReplay=${isFamilyStepReplayAllowed(options.fullRun, options.replayingStep)}
              @inspector-close=${() => options.onCloseStepInspector()}
              @step-replay=${(
                event: CustomEvent<{
                  stepName: string;
                  skipPrepare?: boolean;
                  prepareProfile?: string;
                  freshDispatch?: boolean;
                }>,
              ) =>
                options.onReplayStep(
                  event.detail.stepName,
                  event.detail.skipPrepare,
                  event.detail.prepareProfile,
                  event.detail.freshDispatch,
                )}
            >
            </step-inspector>
            ${options.replayError
              ? html`<div class="replay-error">Replay failed: ${options.replayError}</div>`
              : nothing}
          `
        : nothing}
    </div>
  `;
}

function isFamilyStepReplayAllowed(run: Run, replayingStep: boolean): boolean {
  return canReplayRunSteps(run, replayingStep);
}

function renderFamilyRecipeQualityDetail(run: FamilyObservabilityRunSummary) {
  const artifact = run.recipeQualityArtifact;
  if (!artifact) return nothing;
  return html`
    <div class="detail-section">
      <div class="detail-title">Recipe quality</div>
      <div><strong>${artifact.compact.verdict}</strong></div>
      ${artifact.compact.reasons.length
        ? html`<ul>
            ${artifact.compact.reasons.map((reason) => html`<li>${reason}</li>`)}
          </ul>`
        : html`<div class="muted">No recipe-quality reasons recorded.</div>`}
      ${artifact.compact.better_version_guidance.length
        ? html`
            <div class="detail-title" style="margin-top:8px;">Better version</div>
            <ul>
              ${artifact.compact.better_version_guidance.map((item) => html`<li>${item}</li>`)}
            </ul>
          `
        : nothing}
    </div>
  `;
}

function renderFamilyRecipeProvenance(run: FamilyObservabilityRunSummary) {
  const provenance = run.recipeProvenance;
  if (!provenance) return nothing;
  return html`
    <div class="detail-section">
      <div class="detail-title">Recipe provenance</div>
      <div>
        ${provenance.status === 'resolved'
          ? html`Recovered from run
              <strong>${provenance.sourceRunId?.slice(0, 8) ?? 'unknown'}</strong
              >${provenance.sourceSlotId
                ? html` on <strong>${provenance.sourceSlotId}</strong>`
                : nothing}.`
          : html`Ambiguous historical recipe candidates:
            ${(provenance.candidateRunIds ?? []).map((id) => id.slice(0, 8)).join(', ') || 'none'}.`}
      </div>
      <div class="muted" style="margin-top:4px;">${provenance.reason}</div>
    </div>
  `;
}

function renderFamilyMissingData(run: FamilyObservabilityRunSummary) {
  if (run.missingData.length === 0) return nothing;
  return html`<div class="detail-section">
    <div class="detail-title">Missing data</div>
    <ul>
      ${run.missingData.map((item) => html`<li>${item}</li>`)}
    </ul>
  </div>`;
}
