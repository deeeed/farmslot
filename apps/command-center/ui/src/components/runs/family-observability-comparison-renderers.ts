import { html, nothing } from 'lit';

import type {
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
  GateSummary,
} from '@farmslot/protocol';

import '../reviews/gate-summary-panel.js';

import {
  buildComparisonLeaderboard,
  COMPARE_SORT_SCORE,
  type CompareLeaderboard,
  comparisonRuns,
  familyRunLabel,
} from './family-observability-compare-model.js';
import { terminalRunEmphasisClass } from './family-observability-display-model.js';
import {
  type EvidenceMatrix,
  type EvidenceMatrixRow,
  evidenceRowArtifacts,
  type EvidenceUncomparedRun,
} from './family-observability-evidence-matrix.js';
import { familyPrUrl } from './family-observability-link-model.js';
import { evidenceSummary } from './family-observability-output-model.js';
import { runStatusColor } from './run-utils.js';

export type CompareTab = 'leaderboard' | 'matrix' | 'evidence' | 'cards';

interface FamilyComparisonPanelRenderOptions {
  snapshot: FamilyObservabilitySnapshot;
  selectedRunId: string;
  copiedPrompt: boolean;
  compareTab: CompareTab;
  compareSortKey: string;
  evidenceMatrix: EvidenceMatrix;
  onAskCopilot: (snapshot: FamilyObservabilitySnapshot) => void;
  onCopyPrompt: (snapshot: FamilyObservabilitySnapshot) => void;
  onSelectRun: (runId: string) => void;
  onSelectCompareTab: (tab: CompareTab) => void;
  onSortCompare: (sortKey: string) => void;
  onOpenEvidenceCell: (artifacts: FamilyObservabilityArtifact[], index: number) => void;
  onCompareEvidencePair: (a: FamilyObservabilityArtifact, b: FamilyObservabilityArtifact) => void;
  evidenceThumbUrl: (artifact: FamilyObservabilityArtifact) => string;
  renderRunDiffLink: (
    snapshot: FamilyObservabilitySnapshot,
    run: FamilyObservabilityRunSummary,
    compact: boolean,
  ) => unknown;
}

export function renderFamilyComparisonPanel(options: FamilyComparisonPanelRenderOptions) {
  const runs = comparisonRuns(options.snapshot);
  if (runs.length < 2) return nothing;
  const evidence = options.evidenceMatrix;
  const evidenceCount =
    evidence.rows.length + evidence.uncompared.reduce((n, u) => n + u.artifacts.length, 0);
  const hasEvidence = evidenceCount > 0;
  const tab: CompareTab =
    options.compareTab === 'evidence' && !hasEvidence ? 'leaderboard' : options.compareTab;
  // Only the leaderboard and matrix tabs need the (cheap) leaderboard model;
  // skip the work entirely on the evidence and cards tabs.
  const leaderboard =
    tab === 'leaderboard' || tab === 'matrix'
      ? buildComparisonLeaderboard(runs, options.compareSortKey)
      : null;
  return html`
    <section class="panel comparison-panel">
      <div class="comparison-head">
        <div>
          <div class="panel-title">Compare ${runs.length} runs</div>
          <div class="comparison-subtitle">
            Rank candidates by efficiency, diff their metrics side-by-side, and compare output
            evidence visually across this family's comparison lanes.
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
      <div class="compare-tabs" role="tablist">
        ${renderCompareTab(options, tab, 'leaderboard', 'Leaderboard')}
        ${renderCompareTab(options, tab, 'matrix', 'Matrix')}
        ${hasEvidence
          ? renderCompareTab(options, tab, 'evidence', `Evidence · ${evidenceCount}`)
          : nothing}
        ${renderCompareTab(options, tab, 'cards', 'Cards')}
      </div>
      <div role="tabpanel" id="compare-panel-${tab}" aria-labelledby="compare-tab-${tab}">
        ${tab === 'leaderboard' && leaderboard
          ? renderCompareLeaderboard(options, leaderboard)
          : nothing}
        ${tab === 'matrix' && leaderboard ? renderCompareMatrix(options, leaderboard) : nothing}
        ${tab === 'evidence' ? renderCompareEvidence(options) : nothing}
        ${tab === 'cards'
          ? html`<div class="comparison-grid">
              ${runs.map((run) => renderFamilyComparisonCard(options, run))}
            </div>`
          : nothing}
      </div>
    </section>
  `;
}

function renderCompareTab(
  options: FamilyComparisonPanelRenderOptions,
  active: CompareTab,
  tab: CompareTab,
  label: string,
) {
  return html`
    <button
      class="compare-tab ${active === tab ? 'active' : ''}"
      role="tab"
      id="compare-tab-${tab}"
      aria-selected=${active === tab}
      aria-controls="compare-panel-${tab}"
      @click=${() => options.onSelectCompareTab(tab)}
    >
      ${label}
    </button>
  `;
}

function renderCompareLeaderboard(
  options: FamilyComparisonPanelRenderOptions,
  leaderboard: CompareLeaderboard,
) {
  const sortIndicator = (key: string) =>
    leaderboard.sortKey === key ? html`<span class="sort-caret">▾</span>` : nothing;
  return html`
    <div class="compare-table-scroll">
      <table class="compare-leaderboard">
        <thead>
          <tr>
            <th class="num">#</th>
            <th
              class="sortable ${leaderboard.sortKey === COMPARE_SORT_SCORE ? 'sorted' : ''}"
              @click=${() => options.onSortCompare(COMPARE_SORT_SCORE)}
            >
              Lane / score ${sortIndicator(COMPARE_SORT_SCORE)}
            </th>
            ${leaderboard.columns.map((column) => {
              // 'none'-direction columns (diff size) have no best-first order,
              // so they are not sortable.
              const sortable = column.direction !== 'none';
              return html`
                <th
                  class="num ${sortable ? 'sortable' : ''} ${leaderboard.sortKey === column.key
                    ? 'sorted'
                    : ''}"
                  @click=${sortable ? () => options.onSortCompare(column.key) : undefined}
                >
                  ${column.label} ${sortIndicator(column.key)}
                </th>
              `;
            })}
          </tr>
        </thead>
        <tbody>
          ${leaderboard.rows.map(
            (row) => html`
              <tr
                class="${options.selectedRunId === row.runId ? 'selected' : ''}"
                @click=${() => options.onSelectRun(row.runId)}
              >
                <td class="num rank">${row.rank}</td>
                <td>
                  <div class="lane-label">${row.label}</div>
                  <div class="lane-sub">
                    ${row.run.metrics?.runner ?? 'runner'}/${row.run.metrics?.model ?? 'model'} ·
                    ${row.score == null ? '—' : `${Math.round(row.score * 100)}%`}
                  </div>
                </td>
                ${row.cells.map(
                  (cell) => html`
                    <td class="num ${cell.winner ? 'winner' : ''}">
                      ${cell.display}${cell.winner ? html`<span class="winner-dot">●</span>` : ''}
                    </td>
                  `,
                )}
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

/** Pull the run's gate-summary (worker/self-review/sub-agent per-model breakdown) off its decisions. */
function runGateSummary(run: FamilyObservabilityRunSummary): GateSummary | undefined {
  return run.decisions
    ?.map((decision) =>
      decision.payload?.kind === 'ready' || decision.payload?.kind === 'retrospective'
        ? decision.payload.gateSummary
        : undefined,
    )
    .find((summary): summary is GateSummary => Boolean(summary));
}

function renderCompareMatrix(
  options: FamilyComparisonPanelRenderOptions,
  leaderboard: CompareLeaderboard,
) {
  const gateSummaries = leaderboard.rows.map((row) => ({ row, summary: runGateSummary(row.run) }));
  const hasGateSummaries = gateSummaries.some((entry) => entry.summary);
  // Transpose the leaderboard: metric rows × run columns. Run columns keep the
  // leaderboard's sort order so the most efficient lane stays leftmost.
  return html`
    <div class="compare-table-scroll">
      <table class="compare-matrix">
        <thead>
          <tr>
            <th class="metric-head">Metric</th>
            ${leaderboard.rows.map(
              (row) => html`
                <th
                  class="run-head ${options.selectedRunId === row.runId ? 'selected' : ''}"
                  @click=${() => options.onSelectRun(row.runId)}
                >
                  <div class="lane-label">${row.label}</div>
                  <div class="lane-sub">#${row.rank}</div>
                </th>
              `,
            )}
          </tr>
        </thead>
        <tbody>
          ${leaderboard.columns.map(
            (column, columnIndex) => html`
              <tr>
                <td class="metric-head">${column.label}</td>
                ${leaderboard.rows.map((row) => {
                  const cell = row.cells[columnIndex];
                  return html`
                    <td class="num ${cell.winner ? 'winner' : ''}">
                      ${cell.display}${cell.winner ? html`<span class="winner-dot">●</span>` : ''}
                    </td>
                  `;
                })}
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
    ${hasGateSummaries
      ? html`
          <div class="compare-section-label">
            Per-model breakdown (worker · self-review · sub-agents)
          </div>
          <div class="compare-gate-grid">
            ${gateSummaries.map(
              ({ row, summary }) => html`
                <div
                  class="compare-gate-col ${options.selectedRunId === row.runId ? 'selected' : ''}"
                >
                  <div class="lane-label">${row.label}</div>
                  ${summary
                    ? html`<gate-summary-panel .summary=${summary}></gate-summary-panel>`
                    : html`<div class="muted">No gate summary</div>`}
                </div>
              `,
            )}
          </div>
        `
      : nothing}
  `;
}

function renderCompareEvidence(options: FamilyComparisonPanelRenderOptions) {
  const matrix = options.evidenceMatrix;
  return html`
    <div class="compare-evidence-hint">
      Each row is one screen; click a cell to step across runs, or overlay two lanes with a
      before/after slider.
    </div>
    ${matrix.rows.length
      ? html`<div class="compare-table-scroll">
          <table class="compare-evidence">
            <thead>
              <tr>
                <th class="metric-head">Target</th>
                ${matrix.runs.map((run) => html`<th class="run-head">${run.label}</th>`)}
                <th class="overlay-head"></th>
              </tr>
            </thead>
            <tbody>
              ${matrix.rows.map((row) => renderEvidenceRow(options, row))}
            </tbody>
          </table>
        </div>`
      : nothing}
    ${matrix.uncompared.length ? renderUncomparedEvidence(options, matrix.uncompared) : nothing}
  `;
}

function renderEvidenceThumb(
  options: FamilyComparisonPanelRenderOptions,
  artifact: FamilyObservabilityArtifact,
  kind: 'image' | 'video' | null,
  label: string,
  onClick: () => void,
) {
  return html`
    <button class="evidence-thumb" title=${artifact.path} @click=${onClick}>
      ${kind === 'video'
        ? html`<span class="evidence-video">▶</span>`
        : html`<img src=${options.evidenceThumbUrl(artifact)} alt=${label} loading="lazy" />`}
    </button>
  `;
}

function renderEvidenceRow(options: FamilyComparisonPanelRenderOptions, row: EvidenceMatrixRow) {
  const rowArtifacts = evidenceRowArtifacts(row);
  let coveredIndex = -1;
  return html`
    <tr>
      <td class="metric-head">
        <div class="evidence-target">${row.label}</div>
        <div class="lane-sub">${row.coverage}/${row.cells.length} runs</div>
      </td>
      ${row.cells.map((cell) => {
        if (!cell.artifact) {
          return html`<td class="evidence-cell empty">—</td>`;
        }
        coveredIndex += 1;
        const index = coveredIndex;
        const artifact = cell.artifact;
        return html`
          <td class="evidence-cell">
            ${renderEvidenceThumb(options, artifact, cell.kind, row.label, () =>
              options.onOpenEvidenceCell(rowArtifacts, index),
            )}
          </td>
        `;
      })}
      <td class="overlay-cell">
        ${rowArtifacts.length >= 2
          ? html`<button
              class="action-btn small"
              title="Overlay the two best-covered lanes with a before/after slider"
              @click=${() => options.onCompareEvidencePair(rowArtifacts[0], rowArtifacts[1])}
            >
              Overlay
            </button>`
          : nothing}
      </td>
    </tr>
  `;
}

function renderUncomparedEvidence(
  options: FamilyComparisonPanelRenderOptions,
  uncompared: EvidenceUncomparedRun[],
) {
  return html`
    <div class="uncompared-evidence">
      <div class="uncompared-title">Uncompared evidence</div>
      <div class="compare-evidence-hint">
        Screens captured by a single run — no cross-run counterpart to line them up against.
      </div>
      ${uncompared.map(
        (run) => html`
          <div class="uncompared-run">
            <div class="lane-label">${run.label}</div>
            <div class="uncompared-thumbs">
              ${run.artifacts.map((item) =>
                renderEvidenceThumb(options, item.artifact, item.kind, run.label, () =>
                  options.onOpenEvidenceCell([item.artifact], 0),
                ),
              )}
            </div>
          </div>
        `,
      )}
    </div>
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
