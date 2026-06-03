import { html, nothing } from 'lit';

import { formatDuration } from '../runs/run-utils.js';

import type { PackageRow } from './eval-cockpit-model.js';

export function renderEvalCockpitPackageMatrix(rows: readonly PackageRow[]) {
  if (!rows.length)
    return html`<div class="eval-muted">
      Launch a local suite or load mock results to see package comparison rows.
    </div>`;
  return html`
    <section class="eval-panel">
      <div class="eval-panel-title">Package comparison</div>
      <div class="eval-muted">
        Rows compare result packages, not live runs. A run link is only the trial that produced the
        package.
      </div>
      <div class="package-table">
        <div class="package-row package-head">
          <span>Package</span><span>Axes</span><span>Status</span><span>Diff</span
          ><span>Evidence</span><span>Time / cost</span><span>Run</span>
        </div>
        ${rows.map(
          (row) => html`
            <div class="package-row">
              <span
                ><strong>${row.label ?? row.strategyId ?? row.caseId ?? row.packageId}</strong
                ><br /><small>${row.role} · ${row.packageId.slice(0, 12)}</small></span
              >
              <span
                >${row.axes?.template?.hash || row.axes?.template?.path || 'template —'}<br /><small
                  >${row.axes?.runner?.name ?? 'runner —'} /
                  ${row.axes?.model?.name ?? 'model —'}</small
                ></span
              >
              <span
                >${row.status}${row.missingData.length
                  ? html`<br /><small>${row.missingData.slice(0, 2).join(', ')}</small>`
                  : nothing}</span
              >
              <span
                >${row.diff.available
                  ? `${row.diff.files} files · +${row.diff.additions} -${row.diff.deletions}`
                  : (row.diff.missingReason ?? 'pending')}</span
              >
              <span
                >${row.validationEvidenceCount} validation · ${row.visualEvidenceCount} visual ·
                ${row.reviewEvidenceCount} review</span
              >
              <span
                >${row.metrics?.durationMs != null
                  ? formatDuration(row.metrics.durationMs)
                  : 'pending'}${row.metrics?.costEstimate != null
                  ? html`<br /><small>$${row.metrics.costEstimate.toFixed(2)}</small>`
                  : nothing}</span
              >
              <span
                >${row.runId
                  ? html`<a href=${`#run/${row.runId}`}>${row.runId.slice(0, 8)}</a>`
                  : '—'}</span
              >
            </div>
          `,
        )}
      </div>
    </section>
  `;
}
