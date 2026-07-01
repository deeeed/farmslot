import { html, nothing, type TemplateResult } from 'lit';

import type {
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
  PRStatus,
} from '@farmslot/protocol';
import { githubPullUrl, parseGitHubRef } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

import { familyOriginLabel, prStateColor } from './family-observability-display-model.js';
import { familyTicketUrl } from './family-observability-link-model.js';
import {
  familyCostMetricLabel,
  familyTokenMetricLabel,
  resolveFamilyTokenSummary,
} from './family-observability-token-model.js';

interface FamilyTopbarRenderOptions {
  snapshot: FamilyObservabilitySnapshot;
  selectedRun: FamilyObservabilityRunSummary | null;
  prs: PRStatus[];
  reportLoading: boolean;
  renderConvergedPill: () => TemplateResult | typeof nothing;
  onBackToRuns: () => void;
  onGenerateReport: () => void;
}

interface FamilyMetricsRenderOptions {
  snapshot: FamilyObservabilitySnapshot;
  renderFamilyDiffLink: (snapshot: FamilyObservabilitySnapshot) => TemplateResult | typeof nothing;
}

export function renderFamilyTopbar(options: FamilyTopbarRenderOptions): TemplateResult {
  const { snapshot, selectedRun } = options;
  const ticketUrl = familyTicketUrl(snapshot.familyRootTicketOrPr, snapshot.runs, selectedRun);
  const prNumber = snapshot.runs.find((run) => run.prNumber != null)?.prNumber ?? null;
  const pr = prNumber == null ? null : (options.prs.find((entry) => entry.pr === prNumber) ?? null);
  const repoFromTicket = snapshot.runs
    .map((run) => parseGitHubRef(run.ticketOrPr)?.repo)
    .find(Boolean);
  const repo = pr?.repo ?? repoFromTicket ?? null;
  const prUrl = prNumber != null && repo ? githubPullUrl({ repo, number: prNumber }) : null;
  const stateColor = pr ? prStateColor(pr.prState) : colors.textMuted;
  const stateLabel = pr ? pr.prState.toLowerCase() : 'unknown';

  return html`
    <div class="back" @click=${options.onBackToRuns}>&lt; Back to runs</div>
    <div class="topbar">
      <div>
        <div class="eyebrow">Retrospective</div>
        <h2>
          ${ticketUrl
            ? html`<a
                class="ticket-link"
                href=${ticketUrl}
                target="_blank"
                rel="noopener noreferrer"
                >${snapshot.familyRootTicketOrPr}</a
              >`
            : html`${snapshot.familyRootTicketOrPr}`}
          ${options.renderConvergedPill()}
        </h2>
        <div class="summary">${snapshot.summary}</div>
      </div>
      <div class="top-actions">
        ${prNumber == null
          ? nothing
          : html`
              <a
                class="action-link"
                href=${prUrl ?? '#'}
                target=${prUrl ? '_blank' : '_self'}
                rel=${prUrl ? 'noopener noreferrer' : ''}
                title=${pr?.mergeState ? `merge: ${pr.mergeState.replace(/_/g, ' ')}` : stateLabel}
              >
                PR #${prNumber}
                <span
                  class="badge status"
                  style=${`border-color:${stateColor}; color:${stateColor}; font-size:9px; padding:1px 5px; margin-left:4px`}
                  >${stateLabel}</span
                >
              </a>
            `}
        ${selectedRun && selectedRun.runId !== snapshot.latestRunId
          ? html`<a class="action-link" href=${`#run/${selectedRun.runId}`}
              >Open selected run · ${selectedRun.runId.slice(0, 8)}</a
            >`
          : html`<a class="action-link" href=${`#run/${snapshot.latestRunId}`}>Open latest run</a>`}
        <button
          class="action-btn"
          ?disabled=${options.reportLoading}
          @click=${options.onGenerateReport}
        >
          ${options.reportLoading ? 'Generating…' : 'Generate family report'}
        </button>
      </div>
    </div>
  `;
}

export function renderFamilyMetricsGrid(options: FamilyMetricsRenderOptions): TemplateResult {
  const { snapshot } = options;
  const tokenSummary = resolveFamilyTokenSummary(snapshot);
  return html`
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Family</div>
        <div class="metric-value">${snapshot.familyId.slice(0, 8)}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Origin</div>
        <div class="metric-value">${familyOriginLabel(snapshot)}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Family state</div>
        <div class="metric-value">${snapshot.workflowState}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Runs</div>
        <div class="metric-value">${snapshot.familyRunCount}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Active</div>
        <div class="metric-value">${snapshot.activeRunCount}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Diff</div>
        <div class="metric-value">${options.renderFamilyDiffLink(snapshot)}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Recipe quality</div>
        <div class="metric-value">
          ${snapshot.recipeQuality.semantic}${snapshot.recipeQuality.score != null
            ? ` · ${snapshot.recipeQuality.score}`
            : ''}
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Family tokens</div>
        <div class="metric-value">${familyTokenMetricLabel(tokenSummary)}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Est. cost</div>
        <div class="metric-value">${familyCostMetricLabel(tokenSummary)}</div>
      </div>
    </div>
  `;
}
