import { html, nothing } from 'lit';

import type {
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '@farmslot/protocol';

import { comparisonRuns, familyRunLabel } from './family-observability-compare-model.js';
import { terminalRunEmphasisClass } from './family-observability-display-model.js';
import { familyPrUrl } from './family-observability-link-model.js';
import { evidenceSummary } from './family-observability-output-model.js';
import { runStatusColor } from './run-utils.js';

interface FamilyComparisonPanelRenderOptions {
  snapshot: FamilyObservabilitySnapshot;
  selectedRunId: string;
  copiedPrompt: boolean;
  onAskCopilot: (snapshot: FamilyObservabilitySnapshot) => void;
  onCopyPrompt: (snapshot: FamilyObservabilitySnapshot) => void;
  onSelectRun: (runId: string) => void;
  renderRunDiffLink: (
    snapshot: FamilyObservabilitySnapshot,
    run: FamilyObservabilityRunSummary,
    compact: boolean,
  ) => unknown;
}

export function renderFamilyComparisonPanel(options: FamilyComparisonPanelRenderOptions) {
  const runs = comparisonRuns(options.snapshot);
  if (runs.length < 2) return nothing;
  return html`
    <section class="panel comparison-panel">
      <div class="comparison-head">
        <div>
          <div class="panel-title">Comparison lanes</div>
          <div class="comparison-subtitle">
            Side-by-side candidate output and evidence provenance. Select a lane to inspect its
            recipe, artifacts, steps, and learnings below.
          </div>
        </div>
        <div class="comparison-head-actions">
          <button class="action-btn primary" @click=${() => options.onAskCopilot(options.snapshot)}>
            Ask Co-Pilot to compare
          </button>
          <button class="action-btn" @click=${() => options.onCopyPrompt(options.snapshot)}>
            ${options.copiedPrompt ? 'Prompt copied' : 'Copy prompt'}
          </button>
        </div>
      </div>
      <div class="comparison-grid">
        ${runs.map((run) => renderFamilyComparisonCard(options, run))}
      </div>
    </section>
  `;
}

function renderFamilyComparisonCard(
  options: FamilyComparisonPanelRenderOptions,
  run: FamilyObservabilityRunSummary,
) {
  const selected = options.selectedRunId === run.runId;
  const status = runStatusColor(run.status);
  const evidence = evidenceSummary(options.snapshot, run);
  const reportPreview =
    (run.workerReport ?? run.workerLearnings ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? '';
  return html`
    <button
      class="comparison-card ${selected ? 'selected' : ''} ${terminalRunEmphasisClass(run.status)}"
      style=${`--run-status-color:${status}; --run-status-bg:${status}18`}
      @click=${() => options.onSelectRun(run.runId)}
    >
      <div class="comparison-card-top">
        <span class="comparison-label">${familyRunLabel(run)}</span>
        <span class="badge status" style=${`border-color:${status}; color:${status}`}
          >${run.status}</span
        >
      </div>
      <div class="comparison-meta">
        ${run.metrics?.runner ?? 'runner'} / ${run.metrics?.model ?? 'model'} ·
        ${run.slotId
          ? html`<a
              class="slot-link"
              href=${`#slot/${run.slotId}`}
              title=${`Open slot ${run.slotId}`}
              @click=${(event: Event) => event.stopPropagation()}
              >${run.slotId}</a
            >`
          : html`slot unknown`}
        · ${run.runId.slice(0, 8)}
      </div>
      <div class="comparison-output">${run.summary ?? run.ticketOrPr}</div>
      <div class="comparison-facts">
        ${renderFamilyComparisonPrLink(run, options.snapshot.runs)}
        <span>${options.renderRunDiffLink(options.snapshot, run, true)}</span>
        <span>recipe ${run.recipeQuality.semantic}</span>
        <span>${evidence}</span>
        <span>self-review ${run.selfReview.verdict ?? '—'}</span>
        ${run.metrics?.costEstimate != null
          ? html`<span>$${run.metrics.costEstimate.toFixed(2)}</span>`
          : nothing}
      </div>
      ${reportPreview
        ? html`<div class="comparison-preview">
            ${reportPreview.slice(0, 180)}${reportPreview.length > 180 ? '…' : ''}
          </div>`
        : nothing}
      <div class="comparison-actions">
        <a href=${`#run/${run.runId}`} @click=${(event: Event) => event.stopPropagation()}
          >open run</a
        >
        <span>select lane</span>
      </div>
    </button>
  `;
}

function renderFamilyComparisonPrLink(
  run: FamilyObservabilityRunSummary,
  runs: readonly FamilyObservabilityRunSummary[],
) {
  if (run.prNumber == null) return html`<span>PR —</span>`;
  const prUrl = familyPrUrl(run, runs);
  return html`<span
    >PR
    ${prUrl
      ? html`<a
          class="ticket-link"
          href=${prUrl}
          target="_blank"
          rel="noopener noreferrer"
          @click=${(event: Event) => event.stopPropagation()}
          >#${run.prNumber}</a
        >`
      : html`#${run.prNumber}`}</span
  >`;
}
