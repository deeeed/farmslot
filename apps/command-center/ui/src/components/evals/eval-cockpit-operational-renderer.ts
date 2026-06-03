import { html, nothing } from 'lit';

import type { QueueItem } from '@farmslot/protocol';

import { formatDuration } from '../runs/run-utils.js';

import { type EvalLaunchCell, summarizeLaunchCells } from './eval-suite-launch-model.js';

export interface EvalCockpitOperationalSummaryRenderOptions {
  suiteCells: readonly EvalLaunchCell[];
  selectedCaseCount: number;
  enabledCandidateCount: number;
  busy: string;
  evalSlotCap: number;
  activeEvalCount: number;
  queuedEvalItems: readonly QueueItem[];
  launchLocalSuite: () => void;
  setEvalSlotCap: (value: number) => void;
}

export function renderEvalCockpitOperationalSummary(
  options: EvalCockpitOperationalSummaryRenderOptions,
) {
  const summary = summarizeLaunchCells(options.suiteCells);
  if (!options.suiteCells.length) {
    const trialCount = options.selectedCaseCount * options.enabledCandidateCount;
    const canLaunch = trialCount > 0 && !options.busy;
    return html`
      <section class="eval-panel launch-action-panel">
        <div class="eval-panel-head">
          <div>
            <div class="eval-panel-title">Launch replay trial${trialCount === 1 ? '' : 's'}</div>
            <div class="eval-muted">
              ${trialCount
                ? `${options.selectedCaseCount} Reference${options.selectedCaseCount === 1 ? '' : 's'} × ${options.enabledCandidateCount} enabled Candidate${options.enabledCandidateCount === 1 ? '' : 's'} = ${trialCount} artifact-only replay trial${trialCount === 1 ? '' : 's'}.`
                : 'Choose a Reference and enable at least one Candidate to launch an artifact-only replay.'}
            </div>
          </div>
          <button
            class="eval-button primary"
            ?disabled=${!canLaunch}
            @click=${() => options.launchLocalSuite()}
          >
            ${trialCount
              ? `Queue ${trialCount} replay trial${trialCount === 1 ? '' : 's'}`
              : 'Queue replay'}
          </button>
        </div>
        <div class="cap-row">
          <label
            >Slot cap
            <input
              type="number"
              min="1"
              .value=${String(options.evalSlotCap)}
              @change=${(event: Event) =>
                options.setEvalSlotCap(Number((event.target as HTMLInputElement).value))}
            />
          </label>
        </div>
        <div class="launch-note">
          Queues local artifact-only eval runs/packages only. No PR, push, merge, report export, or
          external scoring.
        </div>
      </section>
    `;
  }
  return html`
    <section class="eval-panel">
      <div class="eval-panel-title">Operational Launch Summary</div>
      <div class="eval-muted">
        Ephemeral launch telemetry only. Durable records remain the single-case experiments, result
        packages, and runs linked below.
      </div>
      <div class="cap-row live">
        <div class="active-cap">
          <strong>${options.activeEvalCount}/${summary.total}</strong><span>active cells</span>
        </div>
        <label
          >Slot cap
          <input
            type="number"
            min="1"
            .value=${String(options.evalSlotCap)}
            @change=${(event: Event) =>
              options.setEvalSlotCap(Number((event.target as HTMLInputElement).value))}
          />
        </label>
      </div>
      <div class="summary-grid">
        <div class="metric"><strong>${summary.total}</strong><span>cells</span></div>
        <div class="metric"><strong>${summary.counts.running}</strong><span>running</span></div>
        <div class="metric"><strong>${summary.counts.final}</strong><span>final</span></div>
        <div class="metric"><strong>${summary.counts.deduped}</strong><span>deduped</span></div>
        <div class="metric"><strong>${summary.errorCount}</strong><span>errors</span></div>
        <div class="metric">
          <strong>${summary.durationMs ? formatDuration(summary.durationMs) : '—'}</strong
          ><span>time estimate</span>
        </div>
        <div class="metric">
          <strong>${summary.costEstimate ? `$${summary.costEstimate.toFixed(2)}` : '—'}</strong
          ><span>cost estimate</span>
        </div>
        <div class="metric">
          <strong>${summary.validationEvidenceCount}/${summary.visualEvidenceCount}</strong
          ><span>validation/visual</span>
        </div>
      </div>
      <dispatch-queue-panel
        .items=${options.queuedEvalItems}
        .panelTitle=${'Eval Queue'}
      ></dispatch-queue-panel>
      <div class="launch-table">
        <div class="launch-row launch-head">
          <span>Case</span><span>Candidate</span><span>Status</span><span>Package</span
          ><span>Evidence</span><span>Time / cost</span><span>Links / errors</span>
        </div>
        ${options.suiteCells.map(
          (cell) => html`
            <div class="launch-row">
              <span
                ><strong>${cell.caseLabel}</strong><br /><small
                  >${cell.caseSelectionId}</small
                ></span
              >
              <span>${cell.candidateLabel}</span>
              <span
                ><span class=${`status-pill ${cell.status}`}>${cell.status}</span>${cell.deduped
                  ? html`<br /><small>idempotent reuse</small>`
                  : nothing}</span
              >
              <span
                >${cell.packageStatus ?? 'pending'}${cell.packageId
                  ? html`<br /><small>${cell.packageId.slice(0, 16)}</small>`
                  : nothing}</span
              >
              <span
                >${cell.validationEvidenceCount} validation · ${cell.visualEvidenceCount} visual ·
                ${cell.reviewEvidenceCount}
                review${cell.missingData.length
                  ? html`<br /><small>${cell.missingData.slice(0, 2).join(', ')}</small>`
                  : nothing}</span
              >
              <span
                >${cell.durationMs != null
                  ? formatDuration(cell.durationMs)
                  : 'pending'}${cell.costEstimate != null
                  ? html`<br /><small>$${cell.costEstimate.toFixed(2)}</small>`
                  : nothing}</span
              >
              <span>
                ${cell.runId
                  ? html`<a href=${`#run/${cell.runId}`}>run ${cell.runId.slice(0, 8)}</a><br />`
                  : nothing}
                ${cell.experimentManifestPath
                  ? html`<small>${cell.experimentManifestPath}</small><br />`
                  : nothing}
                ${cell.packagePath ? html`<small>${cell.packagePath}</small>` : nothing}
                ${cell.error ? html`<span class="warn-text">${cell.error}</span>` : nothing}
              </span>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}
