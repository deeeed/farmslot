import { html, nothing, type TemplateResult } from 'lit';

import type {
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '@farmslot/protocol';

import { formatTokenCount } from '../../utils/review-gate-display.js';

import {
  buildRunTokenSummary,
  familyTokenMetricLabel,
  type FamilyTokenScope,
  type FamilyTokenTrajectory,
  resolveFamilyTokenSummary,
} from './family-observability-token-model.js';
import { summarizeUsage, usageAccountingState } from './family-observability-usage-model.js';
import { renderFamilyUsageBody, usageCost } from './family-observability-usage-renderers.js';

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

function renderToggleGroup<T extends string>(
  label: string,
  value: T,
  options: Array<{ value: T; label: string }>,
  onChange: (next: T) => void,
): TemplateResult {
  return html`<div class="token-toggle-row">
    <span class="token-toggle-label">${label}</span>
    <div class="token-toggle-group">
      ${options.map(
        (option) =>
          html`<button
            class="token-toggle ${value === option.value ? 'active' : ''}"
            @click=${() => onChange(option.value)}
          >
            ${option.label}
          </button>`,
      )}
    </div>
  </div>`;
}

export function renderFamilyTokenPanel(options: FamilyTokenPanelOptions): TemplateResult {
  const summary = resolveFamilyTokenSummary(options.snapshot);
  const showingRun = options.scope === 'run';
  const usage = options.snapshot.usage;
  const scoped = usage && {
    sessions: usage.sessions.filter(
      (row) => !showingRun || row.runIds.includes(options.selectedRunId),
    ),
    contributions: usage.contributions.filter(
      (row) => !showingRun || row.runId === options.selectedRunId,
    ),
    rounds: usage.rounds.filter((row) => !showingRun || row.runId === options.selectedRunId),
    runCoverage: usage.runCoverage.filter(
      (row) => !showingRun || row.runId === options.selectedRunId,
    ),
  };
  const totals = scoped ? summarizeUsage(scoped.contributions.map((row) => row.usage)) : null;
  const coverage = scoped ? summarizeUsage(scoped.sessions.map((row) => row.usage)) : null;
  const missingRuns = scoped?.runCoverage.filter((row) => row.receipts === 0) ?? [];
  const noTokenRuns = scoped?.runCoverage.filter((row) => row.tokenCaptures === 0) ?? [];
  const noAttribution =
    showingRun &&
    scoped &&
    usageAccountingState(
      scoped.contributions,
      scoped.runCoverage.reduce((sum, row) => sum + row.receipts, 0),
    ) === 'no-attributed-measurement';
  const legacyRun =
    !usage && options.selectedRun ? buildRunTokenSummary(options.selectedRun) : null;
  const tokenLabel = totals
    ? noAttribution
      ? '—'
      : totals.tokens === null
        ? 'Not captured'
        : formatTokenCount(totals.tokens)
    : showingRun
      ? legacyRun?.hasData
        ? formatTokenCount(legacyRun.totalTokens)
        : 'Not captured'
      : familyTokenMetricLabel(summary);
  const cost = totals
    ? totals.cost
    : showingRun
      ? legacyRun?.costEstimate
      : summary.familyTotalCostEstimate;
  const costLabel = noAttribution
    ? '—'
    : cost != null
      ? usageCost(cost)
      : totals
        ? totals.measured
          ? 'Unpriced'
          : 'Not captured'
        : '—';
  const milestones =
    !showingRun && options.trajectory === 'pr-complete-milestones'
      ? new Set(
          options.snapshot.runs
            .filter(
              (run) =>
                run.runId === options.snapshot.familyId ||
                run.flowType === 'pr-complete' ||
                run.flowType === 'update-branch',
            )
            .map((run) => run.runId),
        )
      : undefined;
  return html`<section class="panel token-panel">
    <div class="token-head">
      <div>
        <div class="panel-title">Tokens and cost</div>
        <div class="token-subtitle">
          ${coverage
            ? html`<div>
                  ${scoped?.sessions.length} associated sessions · ${coverage.missing} without token
                  counts · ${coverage.unpriced} unpriced
                </div>
                <div>
                  Run coverage: ${missingRuns.length} without receipts · ${noTokenRuns.length}
                  without token receipts
                </div>
                ${noAttribution
                  ? html`<div>
                      No attributed measurement for this run. Session totals remain below.
                    </div>`
                  : nothing}`
            : 'Legacy aggregate. Per-session receipts have not been returned.'}
        </div>
      </div>
      <div class="token-totals">
        <div>
          <span class="token-total-label">${showingRun ? 'Run contribution' : 'Family tokens'}</span
          ><strong>${tokenLabel}</strong>
        </div>
        <div>
          <span class="token-total-label">${totals ? 'Known cost' : 'Est. cost'}</span
          ><strong>${costLabel}</strong>
        </div>
      </div>
    </div>
    <div class="token-controls">
      ${renderToggleGroup(
        'Scope',
        options.scope,
        [
          { value: 'family', label: 'Family' },
          { value: 'run', label: 'Selected run' },
        ],
        options.onScopeChange,
      )}
      ${showingRun
        ? nothing
        : renderToggleGroup(
            'Trajectory',
            options.trajectory,
            [
              { value: 'all-runs', label: 'Every run' },
              { value: 'pr-complete-milestones', label: 'After pr-complete' },
            ],
            options.onTrajectoryChange,
          )}
    </div>
    ${renderFamilyUsageBody(scoped, options.onSelectRun, milestones)}
  </section>`;
}

export {
  familyCostMetricLabel,
  familyTokenMetricLabel,
} from './family-observability-token-model.js';
