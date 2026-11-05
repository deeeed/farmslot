import { html, nothing, svg, type TemplateResult } from 'lit';

import type {
  FamilyObservabilityUsage,
  FamilyUsageInterval,
  FamilyUsageSession,
} from '@farmslot/protocol';

import { formatDurationMs, formatTokenCount } from '../../utils/review-gate-display.js';

import {
  buildUsageAttribution,
  roundUsageTotals,
  summarizeUsage,
  type UsageAttributionPoint,
  type UsageBreakdown,
  usageBreakdown,
  usageIntervalSummary,
} from './family-observability-usage-model.js';

export function usageCost(value: number | null | undefined): string {
  if (value == null) return 'Unpriced';
  return `$${value.toFixed(value !== 0 && value < 1 ? 4 : 2)}`;
}

function tokens(value: number | null | undefined): string {
  return value == null ? 'Not captured' : formatTokenCount(value);
}

function elapsed(value: number | null | undefined): string {
  return value == null ? 'Not captured' : formatDurationMs(value);
}

function runLabel(point: UsageAttributionPoint | undefined): string {
  return point ? point.runIds.map((id) => id.slice(0, 8)).join(', ') : '';
}

function intervalLabel(intervals: readonly FamilyUsageInterval[]): string {
  const summary = usageIntervalSummary(intervals);
  return `${elapsed(summary.durationMs)}${summary.incomplete ? `${summary.durationMs !== null ? ' completed' : ''} · ${summary.incomplete} incomplete` : ''}`;
}

function growthChart(points: UsageAttributionPoint[], metric: 'tokens' | 'cost'): TemplateResult {
  const captured = points.filter((point) => point[metric] != null);
  const width = 640,
    height = 200,
    left = 62,
    right = 20,
    top = 20,
    bottom = 34;
  const first = captured[0]?.index ?? 0;
  const last = captured.at(-1)?.index ?? first;
  const max = Math.max(
    ...captured.map((point) => point[metric] ?? 0),
    metric === 'cost' ? 0.01 : 1,
  );
  const x = (point: UsageAttributionPoint) =>
    left +
    (last === first
      ? (width - left - right) / 2
      : ((point.index - first) / (last - first)) * (width - left - right));
  const y = (point: UsageAttributionPoint) =>
    top + (1 - (point[metric] ?? 0) / max) * (height - top - bottom);
  const path = captured
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'H'}${x(point)}${index === 0 ? ',' : ' V'}${y(point)}`,
    )
    .join(' ');
  return html`
    <div class="token-section">
      <div class="token-section-title">
        Cumulative ${metric === 'tokens' ? 'attributed tokens' : 'known cost'}
      </div>
      <div class="token-growth-frame">
        <svg
          class="token-chart"
          viewBox="0 0 640 200"
          role="img"
          aria-label="Cumulative ${metric} by run attribution order"
        >
          ${[0, 0.5, 1].map(
            (ratio) => svg`
            <line class="token-grid-line" x1=${left} x2=${width - right}
              y1=${top + ratio * (height - top - bottom)} y2=${top + ratio * (height - top - bottom)} />
            <text class="token-axis-label" text-anchor="end" x=${left - 8}
              y=${top + ratio * (height - top - bottom) + 4}>
              ${metric === 'tokens' ? formatTokenCount(max * (1 - ratio)) : usageCost(max * (1 - ratio))}
            </text>
          `,
          )}
          <path class="token-line" d=${path} />
          ${captured.map(
            (point) => svg`
            <circle class="token-usage-point" cx=${x(point)} cy=${y(point)} r="4">
              <title>${runLabel(point)} · ${metric === 'tokens' ? tokens(point.tokens) : usageCost(point.cost)}${point.unpriced ? ' · partial cost' : ''}</title>
            </circle>
          `,
          )}
          ${captured.length
            ? svg`
            <text class="token-axis-label" x=${left} y=${height - 8}>${runLabel(captured[0])}</text>
            ${last !== first ? svg`<text class="token-axis-label" text-anchor="end" x=${width - right} y=${height - 8}>${runLabel(captured.at(-1))}</text>` : nothing}
          `
            : nothing}
        </svg>
        ${captured.length
          ? nothing
          : html`<div class="token-growth-empty">
              ${metric === 'cost'
                ? 'No priced measurements captured.'
                : 'No usage measurements captured.'}
            </div>`}
      </div>
    </div>
  `;
}

function breakdown(title: string, rows: UsageBreakdown[]): TemplateResult {
  return html`<div class="token-section">
    <div class="token-section-title">By ${title}</div>
    <div class="token-table-frame token-breakdown-frame">
      <table class="token-model-table">
        <thead>
          <tr>
            <th>${title}</th>
            <th class="num">Tokens</th>
            <th class="num">Known cost</th>
            <th>Coverage</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (row) =>
              html`<tr>
                <td>${row.label}</td>
                <td class="num">${tokens(row.tokens)}</td>
                <td class="num">${usageCost(row.cost)}</td>
                <td>${row.missing} missing · ${row.unpriced} unpriced</td>
              </tr>`,
          )}
        </tbody>
      </table>
      ${rows.length
        ? nothing
        : html`<div class="token-empty">No session measurements captured.</div>`}
    </div>
  </div>`;
}

function sessionRows(
  sessions: readonly FamilyUsageSession[],
  onSelectRun: (runId: string) => void,
): TemplateResult {
  return html`<div class="token-section">
    <div class="token-section-title">Every session</div>
    <div class="token-section-hint">
      Shared provider identities count once. Totals use recorded runner accounting; cache counts are
      separate.
    </div>
    <div class="token-table-frame token-session-frame">
      <table class="token-model-table token-session-table" aria-label="Family session usage">
        <thead>
          <tr>
            <th>Session / roles</th>
            <th>Runner / model</th>
            <th>Runs</th>
            <th class="num">Session span</th>
            <th class="num">Tokens</th>
            <th class="num">Cost</th>
            <th>Capture</th>
          </tr>
        </thead>
        <tbody>
          ${sessions.map((session) => {
            const usage = session.usage;
            const total = summarizeUsage([usage]);
            const gaps = [
              ...new Set(
                [...(usage.captureGaps ?? []), usage.error, usage.costReason].filter(Boolean),
              ),
            ];
            return html`<tr data-session-id=${session.id}>
              <td title=${usage.runnerSessionId ?? session.id}>
                <div>
                  ${(usage.runnerSessionId ?? usage.requestId ?? 'Pending identity').slice(0, 12)}
                </div>
                <span class="token-section-hint"
                  >${[...new Set(session.participations.flatMap((part) => part.roles))].join(
                    ', ',
                  ) || 'Role not recorded'}</span
                >
              </td>
              <td>
                <div>${usage.runner ?? 'Not reported'}</div>
                <div>
                  ${usage.actualModel ?? usage.model ?? 'Model not reported'}${!usage.actualModel &&
                  usage.model
                    ? ' · configured'
                    : ''}
                </div>
              </td>
              <td>
                ${session.runIds.map(
                  (id) =>
                    html`<button class="token-session-link" @click=${() => onSelectRun(id)}>
                      ${id.slice(0, 8)}
                    </button>`,
                )}
              </td>
              <td class="num">${elapsed(usage.durationMs)}</td>
              <td class="num">
                ${tokens(total.tokens)}
                <div class="token-section-hint">
                  ${tokens(usage.inputTokens)} in · ${tokens(usage.outputTokens)} out
                </div>
                <div class="token-section-hint">
                  ${tokens(usage.cacheRead)} cache read · ${tokens(usage.cacheCreation)} created
                </div>
              </td>
              <td class="num">
                ${total.cost != null || total.measured ? usageCost(total.cost) : 'Not captured'}
              </td>
              <td title=${gaps.join('; ')}>${gaps.length ? gaps.join(' · ') : usage.source}</td>
            </tr>`;
          })}
        </tbody>
      </table>
      ${sessions.length
        ? nothing
        : html`<div class="token-empty">No session receipts captured.</div>`}
    </div>
  </div>`;
}

export function renderFamilyUsageBody(
  data: FamilyObservabilityUsage | undefined,
  onSelectRun: (runId: string) => void,
  milestoneRunIds?: ReadonlySet<string>,
): TemplateResult {
  const usage: FamilyObservabilityUsage = data ?? {
    sessions: [],
    contributions: [],
    rounds: [],
    runCoverage: [],
  };
  const contributions = usage.contributions.map((row) => row.usage);
  const inventory = usage.sessions.map((row) => row.usage);
  const points = buildUsageAttribution(usage.contributions).filter(
    (point) => !milestoneRunIds || point.runIds.some((id) => milestoneRunIds.has(id)),
  );
  return html`
    <div class="token-section-hint token-data-hint">
      ${data
        ? 'Historical token/cost samples were not captured. Charts show per-run accounting. Known cost excludes unpriced receipts.'
        : 'Per-session receipt data has not been returned. Legacy aggregate totals remain above.'}
    </div>
    <div class="token-grid">${growthChart(points, 'tokens')}${growthChart(points, 'cost')}</div>
    <div class="token-grid">
      ${breakdown('model', usageBreakdown(contributions, 'model', inventory))}${breakdown(
        'runner',
        usageBreakdown(contributions, 'runner', inventory),
      )}
    </div>
    ${sessionRows(usage.sessions, onSelectRun)}
    <div class="token-section">
      <div class="token-section-title">Review rounds and their fixes</div>
      <div class="token-section-hint">
        Review and fix wall time, excluding gate waits. Shared-session cost needs round
        measurements.
      </div>
      <div class="token-section-hint">
        Completed wall time with parallel work counted once:
        ${intervalLabel(usage.rounds.flatMap((round) => [round.review, ...round.fixes]))}
      </div>
      <div class="token-table-frame token-round-frame">
        <table class="token-model-table" aria-label="Review round usage">
          <thead>
            <tr>
              <th>Run / round</th>
              <th>Runner / model</th>
              <th class="num">Review time</th>
              <th class="num">Fix time</th>
              <th class="num">Added wall time</th>
              <th class="num">Captured session tokens</th>
              <th class="num">Captured session cost</th>
              <th class="num">Added cost</th>
            </tr>
          </thead>
          <tbody>
            ${usage.rounds.map(
              (round) =>
                html`<tr data-round-id=${round.id}>
                  <td>
                    <button class="token-session-link" @click=${() => onSelectRun(round.runId)}>
                      ${round.runId.slice(0, 8)} · round ${round.roundNumber}
                    </button>
                  </td>
                  <td>
                    ${round.runner} / ${round.model}
                    <div class="token-section-hint">
                      ${round.usageOrigin === 'associated-session'
                        ? 'Latest associated session'
                        : 'Recorded session total'}${round.costScope === 'shared-session'
                        ? ' · shared'
                        : ''}
                    </div>
                  </td>
                  <td class="num">${intervalLabel([round.review])}</td>
                  <td class="num">
                    ${round.fixes.length ? intervalLabel(round.fixes) : 'No fix recorded'}
                  </td>
                  <td class="num">${intervalLabel([round.review, ...round.fixes])}</td>
                  <td class="num">${tokens(roundUsageTotals(round).tokens)}</td>
                  <td class="num">
                    ${roundUsageTotals(round).reviewCost != null
                      ? usageCost(roundUsageTotals(round).reviewCost)
                      : roundUsageTotals(round).tokens != null
                        ? 'Unpriced'
                        : 'Not captured'}
                  </td>
                  <td class="num">
                    ${roundUsageTotals(round).addedCost == null
                      ? 'Not captured'
                      : usageCost(roundUsageTotals(round).addedCost)}
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>
        ${usage.rounds.length
          ? nothing
          : html`<div class="token-empty">No review rounds recorded.</div>`}
      </div>
    </div>
  `;
}
