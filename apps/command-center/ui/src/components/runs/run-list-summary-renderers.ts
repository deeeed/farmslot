import { html, nothing } from 'lit';

import type {
  RunCleanupResult,
  RunListSummaryMeta,
  RunProjectAnalyticsSummary,
} from '@farmslot/protocol';

import { elapsed, sortProjectAnalyticsForDisplay } from './run-utils.js';

export function renderRunListAnalyticsStrip(
  meta: RunListSummaryMeta | null,
  analytics: RunProjectAnalyticsSummary[],
) {
  if (!meta) return nothing;
  const projects = sortProjectAnalyticsForDisplay(analytics);
  if (projects.length === 0)
    return html`<div class="analytics-note">Run analytics unavailable for the current page.</div>`;
  return html`
    <div class="analytics-note">
      Analytics summarize the loaded run page; local filters below may narrow the visible run cards.
    </div>
    ${meta.isTruncated
      ? html`
          <div class="analytics-note">
            Analytics are page-scoped: ${meta.summaryRunCount} of ${meta.totalCount} matching runs
            summarized.
          </div>
        `
      : nothing}
    <div class="analytics-strip">
      ${projects.map(
        (project) => html`
          <div class="analytics-card">
            <div class="analytics-title">${project.project}</div>
            <div class="analytics-line">
              <span>${project.familyCount} families</span>
              <span>${project.runCount} runs</span>
              <span>${project.activeFamilyCount} active families</span>
              <span>${project.completedFamilyCount} complete families</span>
            </div>
            <div class="analytics-line">
              <span>${project.eligibleFamilyCount} eligible families</span>
              <span>${project.blockedFamilyCount} blocked families</span>
              <span>${project.unknownFamilyCount} unknown families</span>
              ${project.latestRunAt
                ? html`<span>latest ${elapsed(project.latestRunAt)}</span>`
                : nothing}
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

export interface CleanupPreviewHandlers {
  confirm: () => void | Promise<void>;
  dismiss: () => void;
}

export function renderRunCleanupPreview(
  preview: RunCleanupResult,
  actionInProgress: boolean,
  handlers: CleanupPreviewHandlers,
) {
  const syntheticRunsDeleted = preview.syntheticRunsDeleted ?? [];
  const total =
    preview.runsArchived.length + preview.taskDirsRemoved.length + syntheticRunsDeleted.length;
  if (total === 0) {
    return html`
      <div class="cleanup-preview">
        <h4>Cleanup Preview</h4>
        <p>Nothing to clean up.</p>
        <div class="cleanup-actions">
          <button class="cancel-btn" @click=${handlers.dismiss}>Dismiss</button>
        </div>
      </div>
    `;
  }
  return html`
    <div class="cleanup-preview">
      <h4>Cleanup Preview</h4>
      ${preview.runsArchived.length > 0
        ? html`
            <p>${preview.runsArchived.length} run(s) to archive (failed/cancelled, >7d):</p>
            <ul>
              ${preview.runsArchived.map((id) => html`<li>${id.slice(0, 8)}</li>`)}
            </ul>
          `
        : nothing}
      ${syntheticRunsDeleted.length > 0
        ? html`
            <p>${syntheticRunsDeleted.length} synthetic test run(s) to quarantine:</p>
            <ul>
              ${syntheticRunsDeleted.slice(0, 20).map((id) => html`<li>${id.slice(0, 8)}</li>`)}
            </ul>
            ${syntheticRunsDeleted.length > 20
              ? html`<p>...and ${syntheticRunsDeleted.length - 20} more</p>`
              : nothing}
          `
        : nothing}
      ${preview.taskDirsRemoved.length > 0
        ? html`
            <p>${preview.taskDirsRemoved.length} task dir(s) to remove:</p>
            <ul>
              ${preview.taskDirsRemoved.map((dir) => html`<li>${dir}</li>`)}
            </ul>
          `
        : nothing}
      <div class="cleanup-actions">
        <button class="confirm-btn" ?disabled=${actionInProgress} @click=${handlers.confirm}>
          Confirm Cleanup
        </button>
        <button class="cancel-btn" @click=${handlers.dismiss}>Cancel</button>
      </div>
    </div>
  `;
}
