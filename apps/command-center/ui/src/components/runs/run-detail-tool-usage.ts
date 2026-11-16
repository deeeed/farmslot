// Tool calls, tokens and wall time per checklist step, from the run's agent-session receipts.
import { css, html, nothing, unsafeCSS } from 'lit';

import type { Run, RunnerSessionUsage, SessionToolUsageSegment } from '@farmslot/protocol';

import { colors, fonts } from '../../styles/theme-tokens.js';
import { renderCollapsiblePanel } from '../shared/collapsible-panel.js';

import type { RunDetailPanelId } from './run-detail-panels.js';
import { formatDuration } from './run-utils.js';

export interface ToolUsageSessionView {
  key: string;
  role: string;
  runner: string;
  toolCalls: number;
  toolCallsBeforeFirstMark: number | null;
  byName: string;
  steps: SessionToolUsageSegment[];
  stepsUnavailable?: string;
  /** Undefined on receipts from before compaction counts; null when the runner records none. */
  compactions?: number | null;
  compactionsUnavailable?: string;
}

function byNameLabel(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} ${n}`)
    .join(' · ');
}

/** Agent sessions that reported tool calls, in receipt order. */
export function toolUsageSessions(run: Run): ToolUsageSessionView[] {
  return (run.sessionUsage ?? []).flatMap((row: RunnerSessionUsage, index) =>
    row.toolUsage
      ? [
          {
            key: `${row.runnerSessionId ?? index}`,
            role: row.role ?? 'agent',
            runner: row.runner ?? 'runner',
            toolCalls: row.toolUsage.toolCalls,
            toolCallsBeforeFirstMark: row.toolUsage.toolCallsBeforeFirstMark,
            byName: byNameLabel(row.toolUsage.toolCallsByName),
            steps: row.toolUsage.steps,
            stepsUnavailable: row.toolUsage.stepsUnavailable,
            compactions: row.toolUsage.compactions,
            compactionsUnavailable: row.toolUsage.compactionsUnavailable,
          },
        ]
      : [],
  );
}

export function segmentLabel(step: SessionToolUsageSegment): string {
  if (step.segment === 'after-last-mark') return 'After last mark';
  return step.title ?? `Step ${step.stepNumber}`;
}

function compactionsLabel(session: ToolUsageSessionView) {
  if (session.compactions === undefined) return nothing;
  return session.compactions === null
    ? html` · <span title=${session.compactionsUnavailable ?? ''}>compactions not recorded</span>`
    : html` · ${session.compactions.toLocaleString()}
        compaction${session.compactions === 1 ? '' : 's'}`;
}

function renderSession(session: ToolUsageSessionView, showHeading: boolean) {
  const maxTools = Math.max(1, ...session.steps.map((step) => step.toolCalls));
  const showCompactions = session.compactions != null;
  return html`<div class="tool-usage-session" data-testid="run-tool-usage-${session.key}">
    ${showHeading
      ? html`<div class="tool-usage-heading">${session.role} · ${session.runner}</div>`
      : nothing}
    <div class="tool-usage-summary" title=${session.byName}>
      ${session.toolCalls.toLocaleString()} tool
      calls${session.toolCallsBeforeFirstMark != null
        ? html` · ${session.toolCallsBeforeFirstMark.toLocaleString()} before mark 1`
        : nothing}${compactionsLabel(session)}
      <span class="tool-usage-names">${session.byName}</span>
    </div>
    ${session.steps.length
      ? html`<div class="tool-usage-table-wrap">
          <table class="tool-usage-table">
            <thead>
              <tr>
                <th>Step</th>
                <th class="num">Tool calls</th>
                <th class="num">Tokens</th>
                <th class="num">Wall</th>
                ${showCompactions ? html`<th class="num">Compactions</th>` : nothing}
              </tr>
            </thead>
            <tbody>
              ${session.steps.map(
                (step) =>
                  html`<tr
                    data-segment=${step.segment}
                    data-step=${step.stepNumber ?? ''}
                    title=${byNameLabel(step.toolCallsByName)}
                  >
                    <td>${segmentLabel(step)}</td>
                    <td class="num">
                      <span
                        class="tool-usage-bar"
                        style="width:${Math.round((step.toolCalls / maxTools) * 48)}px"
                      ></span
                      >${step.toolCalls}
                    </td>
                    <td class="num">
                      ${step.totalTokens == null ? '–' : step.totalTokens.toLocaleString()}
                    </td>
                    <td class="num">${formatDuration(step.wallMs)}</td>
                    ${showCompactions
                      ? html`<td class="num" data-testid="tool-usage-step-compactions">
                          ${step.compactions ?? '–'}
                        </td>`
                      : nothing}
                  </tr>`,
              )}
            </tbody>
          </table>
        </div>`
      : html`<div class="tool-usage-empty">
          ${session.stepsUnavailable ?? 'No checklist marks in this session.'}
        </div>`}
  </div>`;
}

export const toolUsageStyles = css`
  .tool-usage-session {
    display: grid;
    gap: 6px;
    padding-block: 6px;
  }
  .tool-usage-heading {
    font-weight: 600;
  }
  .tool-usage-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
  }
  .tool-usage-names,
  .tool-usage-empty {
    color: ${unsafeCSS(colors.textMuted)};
  }
  .tool-usage-table-wrap {
    overflow-x: auto;
  }
  .tool-usage-table {
    border-collapse: collapse;
    font-size: 12px;
    min-width: 100%;
  }
  .tool-usage-table th,
  .tool-usage-table td {
    padding: 3px 8px;
    border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
    text-align: left;
  }
  .tool-usage-table .num {
    text-align: right;
    font-family: ${unsafeCSS(fonts.mono)};
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .tool-usage-bar {
    display: inline-block;
    height: 8px;
    margin-right: 6px;
    vertical-align: middle;
    background: ${unsafeCSS(colors.accent)};
    opacity: 0.6;
  }
`;

export function renderToolUsagePanel(
  run: Run,
  ctx: {
    panelOpen: (id: RunDetailPanelId) => boolean;
    togglePanel: (id: RunDetailPanelId) => void;
  },
) {
  const sessions = toolUsageSessions(run);
  if (!sessions.length) return nothing;
  const total = sessions.reduce((sum, session) => sum + session.toolCalls, 0);
  return renderCollapsiblePanel({
    id: 'run-step-cost',
    label: 'Cost per checklist step',
    summary: `${total.toLocaleString()} tool calls`,
    open: ctx.panelOpen('run-step-cost'),
    onToggle: () => ctx.togglePanel('run-step-cost'),
    body: () => html`${sessions.map((session) => renderSession(session, sessions.length > 1))}`,
  });
}
