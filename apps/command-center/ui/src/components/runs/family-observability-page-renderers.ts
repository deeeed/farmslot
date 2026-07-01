import { html, nothing, type TemplateResult } from 'lit';

import type {
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
  FamilyReport,
  PRStatus,
} from '@farmslot/protocol';

import type { LightboxItem, LightboxPair } from '../shared/media-lightbox-types.js';

import {
  type CompareTab,
  renderFamilyComparisonPanel,
} from './family-observability-comparison-renderers.js';
import { renderFamilyEvalPackagePanel } from './family-observability-eval-package-renderers.js';
import type { EvidenceMatrix } from './family-observability-evidence-matrix.js';
import { renderRelatedByTicket } from './family-observability-renderers.js';
import { renderFamilyReportPanel } from './family-observability-report-renderers.js';
import { renderFamilyRunSelector } from './family-observability-run-selector-renderers.js';
import {
  renderFamilyMetricsGrid,
  renderFamilyTopbar,
} from './family-observability-shell-renderers.js';
import { renderFamilyTokenPanel } from './family-observability-token-renderers.js';

type RenderResult = TemplateResult | typeof nothing;

export interface FamilyObservabilityPageInput {
  snapshot: FamilyObservabilitySnapshot;
  selectedRun: FamilyObservabilityRunSummary | null;
  selectedRunId: string;
  prs: PRStatus[];
  report: FamilyReport | null;
  reportLoading: boolean;
  selectedExperimentKey: string;
  copiedPrompt: boolean;
  compareTab: CompareTab;
  compareSortKey: string;
  evidenceMatrix: EvidenceMatrix;
  pairCount: number;
  lightboxItems: LightboxItem[];
  lightboxPairs: LightboxPair[];
  lightboxOpen: boolean;
  lightboxIndex: number;
  lightboxPairIndex: number;
  lightboxMode: 'single' | 'compare';
  renderConvergedPill: () => RenderResult;
  renderFamilyDiffLink: (snapshot: FamilyObservabilitySnapshot) => RenderResult;
  renderRunDiffLink: (
    snapshot: FamilyObservabilitySnapshot,
    run: FamilyObservabilityRunSummary,
    compact?: boolean,
  ) => unknown;
  renderDiffModalLink: (label: string, artifact: FamilyObservabilityArtifact | null) => unknown;
  renderChangeLedger: (snapshot: FamilyObservabilitySnapshot) => unknown;
  renderRunOutputComparisonSummary: (
    snapshot: FamilyObservabilitySnapshot,
    selectedRun: FamilyObservabilityRunSummary | null,
  ) => unknown;
  renderEvidence: (snapshot: FamilyObservabilitySnapshot) => unknown;
  renderRecipePanel: (selectedRun: FamilyObservabilityRunSummary | null) => unknown;
  renderRunDetail: (run: FamilyObservabilityRunSummary) => unknown;
  renderDiffModal: () => unknown;
  onBackToRuns: () => void;
  onGenerateReport: () => void;
  onSelectExperiment: (experimentKey: string) => void;
  onAskCopilot: (snapshot: FamilyObservabilitySnapshot) => void;
  onCopyPrompt: (snapshot: FamilyObservabilitySnapshot) => void;
  onSelectRun: (runId: string) => void;
  onSelectCompareTab: (tab: CompareTab) => void;
  onSortCompare: (sortKey: string) => void;
  onOpenEvidenceCell: (artifacts: FamilyObservabilityArtifact[], index: number) => void;
  onCompareEvidencePair: (a: FamilyObservabilityArtifact, b: FamilyObservabilityArtifact) => void;
  evidenceThumbUrl: (artifact: FamilyObservabilityArtifact) => string;
  onOpenSlot: (slotId: string, event: Event) => void;
  onLightboxClose: () => void;
  onLightboxNavigate: (index: number) => void;
  onLightboxPairNavigate: (index: number) => void;
  onLightboxModeChange: (mode: 'single' | 'compare') => void;
  tokenScope: import('./family-observability-token-model.js').FamilyTokenScope;
  tokenTrajectory: import('./family-observability-token-model.js').FamilyTokenTrajectory;
  onTokenScopeChange: (
    scope: import('./family-observability-token-model.js').FamilyTokenScope,
  ) => void;
  onTokenTrajectoryChange: (
    trajectory: import('./family-observability-token-model.js').FamilyTokenTrajectory,
  ) => void;
}

export function renderFamilyObservabilityPage(input: FamilyObservabilityPageInput): TemplateResult {
  const { snapshot, selectedRun } = input;
  return html`
    ${renderFamilyTopbar({
      snapshot,
      selectedRun,
      prs: input.prs,
      reportLoading: input.reportLoading,
      renderConvergedPill: input.renderConvergedPill,
      onBackToRuns: input.onBackToRuns,
      onGenerateReport: input.onGenerateReport,
    })}
    ${renderFamilyMetricsGrid({
      snapshot,
      renderFamilyDiffLink: input.renderFamilyDiffLink,
    })}
    ${renderFamilyTokenPanel({
      snapshot,
      selectedRun,
      selectedRunId: input.selectedRunId,
      scope: input.tokenScope,
      trajectory: input.tokenTrajectory,
      onScopeChange: input.onTokenScopeChange,
      onTrajectoryChange: input.onTokenTrajectoryChange,
      onSelectRun: input.onSelectRun,
    })}
    <div class="content-grid family-run-focus">
      ${renderFamilyRunSelector({
        snapshot,
        selectedRun,
        onSelectRun: input.onSelectRun,
        onOpenSlot: input.onOpenSlot,
        renderRunDiffLink: input.renderRunDiffLink,
      })}

      <section class="panel detail selected-run-focus">
        <div class="panel-title">
          ${selectedRun ? `Selected run · ${selectedRun.runId.slice(0, 8)}` : 'Run detail'}
        </div>
        ${selectedRun
          ? input.renderRunDetail(selectedRun)
          : html`<div class="muted">Select a run.</div>`}
      </section>
    </div>

    ${input.renderRunOutputComparisonSummary(snapshot, selectedRun)}
    ${input.renderChangeLedger(snapshot)}
    ${renderFamilyEvalPackagePanel({
      snapshot,
      selectedExperimentKey: input.selectedExperimentKey,
      onSelectExperiment: input.onSelectExperiment,
      renderDiffModalLink: input.renderDiffModalLink,
    })}
    ${renderFamilyComparisonPanel({
      snapshot,
      selectedRunId: input.selectedRunId,
      copiedPrompt: input.copiedPrompt,
      compareTab: input.compareTab,
      compareSortKey: input.compareSortKey,
      evidenceMatrix: input.evidenceMatrix,
      onAskCopilot: input.onAskCopilot,
      onCopyPrompt: input.onCopyPrompt,
      onSelectRun: input.onSelectRun,
      onSelectCompareTab: input.onSelectCompareTab,
      onSortCompare: input.onSortCompare,
      onOpenEvidenceCell: input.onOpenEvidenceCell,
      onCompareEvidencePair: input.onCompareEvidencePair,
      evidenceThumbUrl: input.evidenceThumbUrl,
      renderRunDiffLink: input.renderRunDiffLink,
    })}

    <div class="content-grid">
      <section class="panel">
        <div class="panel-title">
          Evidence${input.pairCount > 0
            ? html` <span class="panel-hint"
                >· ${input.pairCount} pair${input.pairCount > 1 ? 's' : ''}</span
              >`
            : ''}
        </div>
        ${input.renderEvidence(snapshot)}
      </section>

      <section class="panel">
        <div class="panel-title">Recipe</div>
        ${input.renderRecipePanel(selectedRun)}
      </section>
    </div>

    ${renderRelatedByTicket(snapshot.relatedByTicket, input.prs)}
    ${renderFamilyReportPanel(input.report)} ${input.renderDiffModal()}

    <media-lightbox
      .items=${input.lightboxItems}
      .pairs=${input.lightboxPairs}
      .open=${input.lightboxOpen}
      .selectedIndex=${input.lightboxIndex}
      .pairIndex=${input.lightboxPairIndex}
      .mode=${input.lightboxMode}
      @lightbox-close=${input.onLightboxClose}
      @lightbox-navigate=${(event: CustomEvent) => {
        input.onLightboxNavigate(event.detail.index);
      }}
      @lightbox-pair-navigate=${(event: CustomEvent) => {
        input.onLightboxPairNavigate(event.detail.index);
      }}
      @lightbox-mode-change=${(event: CustomEvent) => {
        input.onLightboxModeChange(event.detail.mode);
      }}
    ></media-lightbox>
  `;
}
