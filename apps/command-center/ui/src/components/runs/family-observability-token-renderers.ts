import { html, nothing, type TemplateResult } from 'lit';

import type {
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';
import { formatTokenCount } from '../../utils/review-gate-display.js';

import { formatCompactNumber } from './family-observability-compare-model.js';
import {
  buildRunTokenSummary,
  type FamilyObservabilityTokenModelBreakdown,
  type FamilyObservabilityTokenRunPoint,
  type FamilyTokenScope,
  type FamilyTokenTrajectory,
  filterPointsForTrajectory,
  resolveFamilyTokenSummary,
} from './family-observability-token-model.js';

interface FamilyTokenPanelOptions {
  snapshot: FamilyObservabilitySnapshot;
  selectedRun: FamilyObservabilityRunSummary | null;
  selectedRunId: string;
  scope: FamilyTokenScope;
  trajectory: FamilyTokenTrajectory;
  onScopeChange: (scope: FamilyTokenScope) => void;
  onTrajectoryChange: (trajectory: FamilyTokenTrajectory) => void;
  onSelectRun: (runId: string) => void;
}

function formatCost(value: number | null | undefined): string {
  if (value == null) return '—';
  return `$${value.toFixed(2)}`;
}

function modelBarColor(index: number): string {
  const palette = ['#6366f1', '#22c55e', '#f59e0b', '#06b6d4', '#ec4899', '#a78bfa'];
  return palette[index % palette.length] ?? colors.accent;
}

function renderToggleGroup<T extends string>(
  label: string,
  value: T,
  options: Array<{ value: T; label: string }>,
  onChange: (next: T) => void,
): TemplateResult {
  return html`
    <div class="token-toggle-row">
      <span class="token-toggle-label">${label}</span>
      <div class="token-toggle-group">
        ${options.map(
          (option) => html`
            <button
              class="token-toggle ${value === option.value ? 'active' : ''}"
              @click=${() => onChange(option.value)}
            >
              ${option.label}
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

function yAxisLabels(maxValue: number): string[] {
  if (maxValue <= 0) return ['0'];
  const steps = 4;
  return Array.from({ length: steps + 1 }, (_, index) => {
    const value = Math.round((maxValue / steps) * (steps - index));
    return formatCompactNumber(value);
  });
}

function renderEvolutionChart(
  points: FamilyObservabilityTokenRunPoint[],
  selectedRunId: string,
  onSelectRun: (runId: string) => void,
  emptyMessage: string,
): TemplateResult {
  const chartPoints = points.filter((point) => point.hasMetrics);
  if (chartPoints.length === 0) {
    return html`<div class="token-empty">${emptyMessage}</div>`;
  }

  const maxCumulative = Math.max(...chartPoints.map((point) => point.cumulativeTokens), 1);
  const width = 640;
  const height = 180;
  const padLeft = 48;
  const padRight = 28;
  const padY = 18;
  const chartW = width - padLeft - padRight;
  const chartH = height - padY * 2;
  const xStep = chartPoints.length > 1 ? chartW / (chartPoints.length - 1) : 0;
  const yLabels = yAxisLabels(maxCumulative);

  const linePoints = chartPoints
    .map((point, index) => {
      const x = padLeft + (chartPoints.length === 1 ? chartW / 2 : index * xStep);
      const y = padY + chartH - (point.cumulativeTokens / maxCumulative) * chartH;
      return `${x},${y}`;
    })
    .join(' ');

  return html`
    <div class="token-chart-wrap">
      <svg
        class="token-chart"
        viewBox="0 0 ${width} ${height}"
        role="img"
        aria-label="Token evolution"
      >
        ${yLabels.map((label, index) => {
          const y = padY + (chartH / (yLabels.length - 1)) * index;
          return html`
            <line x1=${padLeft} y1=${y} x2=${width - padRight} y2=${y} class="token-grid-line" />
            <text x=${padLeft - 6} y=${y + 3} class="token-axis-label" text-anchor="end"
              >${label}</text
            >
          `;
        })}
        <polyline points=${linePoints} class="token-line" />
        ${chartPoints.map((point, index) => {
          const x = padLeft + (chartPoints.length === 1 ? chartW / 2 : index * xStep);
          const y = padY + chartH - (point.cumulativeTokens / maxCumulative) * chartH;
          const selected = point.runId === selectedRunId;
          return html`
            <g
              class="token-point ${selected ? 'selected' : ''}"
              @click=${() => onSelectRun(point.runId)}
            >
              <circle cx=${x} cy=${y} r=${selected ? 6 : 4.5} />
              <title>
                ${point.label} · +${formatCompactNumber(point.deltaTokens)} · cum
                ${formatCompactNumber(point.cumulativeTokens)}${point.model
                  ? ` · ${point.model}`
                  : ''}
              </title>
            </g>
          `;
        })}
      </svg>
      <div class="token-chart-legend">
        ${chartPoints.map(
          (point) => html`
            <button
              class="token-legend-item ${point.runId === selectedRunId ? 'selected' : ''}"
              @click=${() => onSelectRun(point.runId)}
            >
              <span>${point.label}</span>
              <span>+${formatCompactNumber(point.deltaTokens)}</span>
              <span class="token-legend-cum"
                >${formatCompactNumber(point.cumulativeTokens)} cum</span
              >
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

function renderRunContributionBars(
  points: FamilyObservabilityTokenRunPoint[],
  maxRunTotal: number,
  selectedRunId: string,
  onSelectRun: (runId: string) => void,
): TemplateResult {
  return html`
    <div class="token-run-bars">
      ${points.map((point) => {
        const widthPct = maxRunTotal > 0 ? (point.stepTokens / maxRunTotal) * 100 : 0;
        const inputPct =
          point.stepTokens > 0 ? (point.inputTokens / point.stepTokens) * widthPct : 0;
        const outputPct =
          point.stepTokens > 0 ? (point.outputTokens / point.stepTokens) * widthPct : 0;
        const cachePct = Math.max(0, widthPct - inputPct - outputPct);
        return html`
          <button
            class="token-run-row ${point.runId === selectedRunId
              ? 'selected'
              : ''} ${point.hasMetrics ? '' : 'missing'}"
            ?disabled=${!point.hasMetrics}
            @click=${() => onSelectRun(point.runId)}
          >
            <span class="token-run-label"
              >${point.label}${point.model ? html` · ${point.model}` : nothing}</span
            >
            <div class="token-run-track">
              <div class="token-seg input" style="width:${inputPct}%"></div>
              <div class="token-seg output" style="width:${outputPct}%"></div>
              <div class="token-seg cache" style="width:${cachePct}%"></div>
            </div>
            <span class="token-run-value">+${formatCompactNumber(point.deltaTokens)}</span>
          </button>
        `;
      })}
    </div>
  `;
}

function renderMissingRuns(
  missingRunIds: string[],
  runs: readonly FamilyObservabilityRunSummary[],
) {
  if (missingRunIds.length === 0) return nothing;
  const labels = missingRunIds.map((runId) => {
    const run = runs.find((entry) => entry.runId === runId);
    return run ? `${run.flowType} · ${runId.slice(0, 8)}` : runId.slice(0, 8);
  });
  return html`
    <div class="token-missing-runs">
      Missing metrics for ${missingRunIds.length} run${missingRunIds.length === 1 ? '' : 's'}:
      ${labels.join(', ')}
    </div>
  `;
}

function renderModelBreakdown(byModel: FamilyObservabilityTokenModelBreakdown[]): TemplateResult {
  if (byModel.length === 0) {
    return html`<div class="token-empty">No per-model breakdown yet.</div>`;
  }
  const maxTotal = Math.max(...byModel.map((entry) => entry.total), 1);
  return html`
    <table class="token-model-table">
      <thead>
        <tr>
          <th>Model</th>
          <th class="num">Runs</th>
          <th class="num">Input</th>
          <th class="num">Output</th>
          <th class="num">Cache</th>
          <th class="num">Total</th>
          <th class="num">Cost</th>
          <th>Share</th>
        </tr>
      </thead>
      <tbody>
        ${byModel.map((entry, index) => {
          const share = (entry.total / maxTotal) * 100;
          return html`
            <tr>
              <td>${entry.model}</td>
              <td class="num">${entry.runCount}</td>
              <td class="num">${formatTokenCount(entry.input)}</td>
              <td class="num">${formatTokenCount(entry.output)}</td>
              <td class="num">${formatTokenCount(entry.cacheRead + entry.cacheCreation)}</td>
              <td class="num">${formatTokenCount(entry.total)}</td>
              <td class="num">${formatCost(entry.costEstimate)}</td>
              <td>
                <div class="token-share-track">
                  <div
                    class="token-share-fill"
                    style="width:${share}%; background:${modelBarColor(index)}"
                  ></div>
                </div>
              </td>
            </tr>
          `;
        })}
      </tbody>
    </table>
  `;
}

function renderRoleBreakdown(
  roles: ReturnType<typeof buildRunTokenSummary>['roles'],
): TemplateResult {
  if (roles.length === 0) {
    return html`<div class="token-empty">No token roles captured for this run yet.</div>`;
  }
  const maxTotal = Math.max(...roles.map((role) => role.total), 1);
  return html`
    <div class="token-run-bars">
      ${roles.map((role) => {
        const widthPct = (role.total / maxTotal) * 100;
        const inputPct = role.total > 0 ? (role.input / role.total) * widthPct : 0;
        const outputPct = role.total > 0 ? (role.output / role.total) * widthPct : 0;
        const cachePct = Math.max(0, widthPct - inputPct - outputPct);
        return html`
          <div class="token-run-row">
            <span class="token-run-label">${role.label}</span>
            <div class="token-run-track">
              <div class="token-seg input" style="width:${inputPct}%"></div>
              <div class="token-seg output" style="width:${outputPct}%"></div>
              <div class="token-seg cache" style="width:${cachePct}%"></div>
            </div>
            <span class="token-run-value">${formatCompactNumber(role.total)}</span>
          </div>
        `;
      })}
    </div>
  `;
}

function renderFamilyTokenBody(
  summary: ReturnType<typeof resolveFamilyTokenSummary>,
  trajectoryPoints: FamilyObservabilityTokenRunPoint[],
  trajectory: FamilyTokenTrajectory,
  runs: readonly FamilyObservabilityRunSummary[],
  selectedRunId: string,
  onSelectRun: (runId: string) => void,
): TemplateResult {
  const maxRunTotal = Math.max(...trajectoryPoints.map((point) => point.stepTokens), 1);
  const trajectoryHint =
    trajectory === 'pr-complete-milestones'
      ? 'Cumulative family total after each pr-complete / merge-main step (plus family root).'
      : 'Every family run in chronological order.';

  return html`
    ${renderMissingRuns(summary.missingRunIds, runs)}
    <div class="token-grid">
      <div class="token-section">
        <div class="token-section-title">Cumulative growth</div>
        <div class="token-section-hint">${trajectoryHint}</div>
        ${renderEvolutionChart(
          trajectoryPoints,
          selectedRunId,
          onSelectRun,
          'No token metrics captured for this family yet.',
        )}
      </div>
      <div class="token-section">
        <div class="token-section-title">Step delta</div>
        <div class="token-legend-inline">
          <span><i class="swatch input"></i> input</span>
          <span><i class="swatch output"></i> output</span>
          <span><i class="swatch cache"></i> cache</span>
        </div>
        ${renderRunContributionBars(trajectoryPoints, maxRunTotal, selectedRunId, onSelectRun)}
      </div>
    </div>
    <div class="token-section">
      <div class="token-section-title">Breakdown by model</div>
      ${renderModelBreakdown(summary.byModel)}
    </div>
  `;
}

function renderRunTokenBody(
  runSummary: ReturnType<typeof buildRunTokenSummary>,
  selectedRun: FamilyObservabilityRunSummary,
): TemplateResult {
  return html`
    <div class="token-grid token-grid-run">
      <div class="token-section">
        <div class="token-section-title">Role breakdown</div>
        <div class="token-section-hint">
          ${runSummary.usesGateSummary
            ? 'Worker, independent reviews, and chained pr-complete loops from the gate summary.'
            : 'Worker session metrics for this run.'}
        </div>
        ${renderRoleBreakdown(runSummary.roles)}
      </div>
      <div class="token-section">
        <div class="token-section-title">Run context</div>
        <div class="token-context-grid">
          <div><span class="muted">Flow</span><strong>${selectedRun.flowType}</strong></div>
          <div><span class="muted">Lane</span><strong>${selectedRun.lane}</strong></div>
          <div><span class="muted">Status</span><strong>${selectedRun.status}</strong></div>
          <div>
            <span class="muted">Runner / model</span
            ><strong
              >${selectedRun.metrics?.runner ?? '—'} ·
              ${selectedRun.metrics?.actualModel ?? selectedRun.metrics?.model ?? '—'}</strong
            >
          </div>
        </div>
      </div>
    </div>
    <div class="token-section">
      <div class="token-section-title">Breakdown by model</div>
      ${renderModelBreakdown(runSummary.byModel)}
    </div>
  `;
}

export function renderFamilyTokenPanel(options: FamilyTokenPanelOptions): TemplateResult {
  const summary = resolveFamilyTokenSummary(options.snapshot);
  const trajectoryPoints = filterPointsForTrajectory(
    summary.runPoints,
    options.trajectory,
    options.snapshot.familyId,
    summary.milestoneRunPoints,
  );
  const runSummary = options.selectedRun ? buildRunTokenSummary(options.selectedRun) : null;
  const showingRun = options.scope === 'run';

  return html`
    <section class="panel token-panel">
      <div class="token-head">
        <div>
          <div class="panel-title">Token usage</div>
          <div class="token-subtitle">
            ${showingRun
              ? options.selectedRun
                ? html`Selected run · ${options.selectedRun.runId.slice(0, 8)} ·
                  ${options.selectedRun.flowType}`
                : 'Select a run to inspect its token model.'
              : html`Family-wide usage across ${options.snapshot.familyRunCount}
                run${options.snapshot.familyRunCount === 1 ? '' : 's'} · ${summary.runsWithMetrics}
                with
                metrics${summary.runsMissingMetrics
                  ? html` · ${summary.runsMissingMetrics} missing`
                  : nothing}${options.snapshot.tokenSummary ? nothing : html` · client estimate`}`}
          </div>
        </div>
        <div class="token-totals">
          <div>
            <span class="token-total-label">${showingRun ? 'Run tokens' : 'Family tokens'}</span>
            <strong
              >${formatTokenCount(
                showingRun ? (runSummary?.totalTokens ?? 0) : summary.familyTotalTokens,
              )}</strong
            >
          </div>
          <div>
            <span class="token-total-label">Est. cost</span>
            <strong
              >${formatCost(
                showingRun ? (runSummary?.costEstimate ?? null) : summary.familyTotalCostEstimate,
              )}</strong
            >
          </div>
        </div>
      </div>

      <div class="token-controls">
        ${renderToggleGroup<FamilyTokenScope>(
          'Scope',
          options.scope,
          [
            { value: 'family', label: 'Family' },
            { value: 'run', label: 'Selected run' },
          ],
          options.onScopeChange,
        )}
        ${options.scope === 'family'
          ? renderToggleGroup<FamilyTokenTrajectory>(
              'Trajectory',
              options.trajectory,
              [
                { value: 'all-runs', label: 'Every run' },
                { value: 'pr-complete-milestones', label: 'After pr-complete' },
              ],
              options.onTrajectoryChange,
            )
          : nothing}
      </div>

      ${showingRun
        ? options.selectedRun && runSummary
          ? runSummary.hasData
            ? renderRunTokenBody(runSummary, options.selectedRun)
            : html`<div class="token-empty">No token metrics captured for this run yet.</div>`
          : html`<div class="token-empty">
              Select a run in the selector to inspect its token model.
            </div>`
        : renderFamilyTokenBody(
            summary,
            trajectoryPoints,
            options.trajectory,
            options.snapshot.runs,
            options.selectedRunId,
            options.onSelectRun,
          )}
    </section>
  `;
}

export {
  familyCostMetricLabel,
  familyTokenMetricLabel,
} from './family-observability-token-model.js';
