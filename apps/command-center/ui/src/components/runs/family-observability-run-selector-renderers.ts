import { html, nothing } from 'lit';

import type {
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

import { familyLedgerEntry } from './family-observability-diff-model.js';
import {
  hasModelDrift,
  hasUsageMetrics,
  runBadgeColor,
  terminalRunEmphasisClass,
} from './family-observability-display-model.js';
import { familyRunBadgeLabel } from './family-observability-evidence.js';
import {
  dispositionColor,
  dispositionLabel,
  familyLedgerTurnLabel,
  formatCreatedAt,
  runStatusColor,
} from './run-utils.js';

interface FamilyRunSelectorRenderOptions {
  snapshot: FamilyObservabilitySnapshot;
  selectedRun: FamilyObservabilityRunSummary | null;
  onSelectRun: (runId: string) => void;
  onOpenSlot: (slotId: string, event: Event) => void;
  renderRunDiffLink: (
    snapshot: FamilyObservabilitySnapshot,
    run: FamilyObservabilityRunSummary,
    compact: boolean,
  ) => unknown;
}

export function renderFamilyRunSelector(options: FamilyRunSelectorRenderOptions) {
  return html`
    <section class="panel timeline">
      <div class="panel-title">Run selector</div>
      ${options.snapshot.runs.map((run) => renderFamilyRunSelectorItem(options, run))}
    </section>
  `;
}

function renderFamilyRunSelectorItem(
  options: FamilyRunSelectorRenderOptions,
  run: FamilyObservabilityRunSummary,
) {
  const selected = options.selectedRun?.runId === run.runId;
  const flow = runBadgeColor(run);
  const status = runStatusColor(run.status);
  const entry = familyLedgerEntry(options.snapshot, run.runId);
  const usageMissing = !hasUsageMetrics(run);
  const modelDrift = hasModelDrift(run);
  const disposition = dispositionLabel(run.metrics?.disposition);
  return html`
    <button
      class="run-item ${selected ? 'selected' : ''} ${terminalRunEmphasisClass(run.status)}"
      style=${`--run-status-color:${status}; --run-status-bg:${status}18`}
      @click=${() => options.onSelectRun(run.runId)}
    >
      <div class="run-item-top">
        <span class="badge" style=${`background:${flow}; color:#000`}
          >${familyRunBadgeLabel(run)}</span
        >
        <span class="badge status" style=${`border-color:${status}; color:${status}`}
          >${run.status}</span
        >
        ${disposition
          ? html`<span
              class="badge status"
              style=${`border-color:${dispositionColor(run.metrics?.disposition)}; color:${dispositionColor(run.metrics?.disposition)}`}
              >${disposition}</span
            >`
          : nothing}
        ${run.slotId
          ? renderSlotBadge(run.slotId, options.onOpenSlot)
          : html`<span class="badge warn">Slot unknown</span>`}
        ${run.variant
          ? html`<span
              class="badge status"
              style=${`border-color:${colors.accent}; color:${colors.accent}`}
              >${run.variant}</span
            >`
          : nothing}
        ${entry ? html`<span class="badge ledger">${familyLedgerTurnLabel(entry)}</span>` : nothing}
        ${entry?.missingData.length
          ? html`<span class="badge warn">Evidence missing</span>`
          : nothing}
        ${usageMissing ? html`<span class="badge warn">Usage missing</span>` : nothing}
        ${modelDrift ? html`<span class="badge warn">Model drift</span>` : nothing}
      </div>
      <div class="run-item-title">${run.summary ?? run.ticketOrPr}</div>
      <div class="run-item-meta">
        ${run.runId.slice(0, 8)} · ${formatCreatedAt(run.createdAt)} ·
        ${run.slotId ? renderSlotInlineLink(run.slotId, options.onOpenSlot) : html`slot unknown`} ·
        ${run.branch ?? 'no branch'} ·
        ${options.renderRunDiffLink(options.snapshot, run, true)}${run.metrics
          ?.sessionTotalTokens != null
          ? html` · ${run.metrics.sessionTotalTokens.toLocaleString()} tokens`
          : nothing}${run.metrics?.costEstimate != null
          ? html` · $${run.metrics.costEstimate.toFixed(2)}`
          : nothing}
      </div>
    </button>
  `;
}

function renderSlotBadge(slotId: string, onOpenSlot: (slotId: string, event: Event) => void) {
  return html`<span
    class="badge slot slot-link"
    title=${`Open slot ${slotId}`}
    @click=${(event: Event) => onOpenSlot(slotId, event)}
    >slot ${slotId}</span
  >`;
}

function renderSlotInlineLink(slotId: string, onOpenSlot: (slotId: string, event: Event) => void) {
  return html`<span
    class="slot-link"
    title=${`Open slot ${slotId}`}
    @click=${(event: Event) => onOpenSlot(slotId, event)}
    >slot ${slotId}</span
  >`;
}
