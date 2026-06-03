import { html, type TemplateResult } from 'lit';

import type { FamilyReport } from '@farmslot/protocol';

export function renderFamilyReportPanel(report: FamilyReport | null): TemplateResult {
  return html`<section class="panel report-panel">
    <div class="panel-title">Family report</div>
    ${report
      ? html`
          <div class="report-status ${report.status}">
            ${report.status}${report.error ? ` · ${report.error}` : ''}
          </div>
          ${renderFamilyReportSection('Summary', report.content.summary)}
          ${renderFamilyReportList('Evidence highlights', report.content.evidenceHighlights)}
          ${renderFamilyReportSection('Recipe assessment', report.content.recipeAssessment)}
          ${renderFamilyReportList('Learnings', report.content.learnings)}
          ${renderFamilyReportList('Gaps', report.content.unresolvedGaps)}
        `
      : html`<div class="muted">
          Generate an on-demand family report from the normalized snapshot.
        </div>`}
  </section>`;
}

function renderFamilyReportSection(label: string, body: string): TemplateResult {
  return html`<div class="report-block">
    <div class="report-label">${label}</div>
    <div>${body}</div>
  </div>`;
}

function renderFamilyReportList(label: string, items: string[]): TemplateResult {
  return html`<div class="report-block">
    <div class="report-label">${label}</div>
    ${items.length
      ? html`<ul>
          ${items.map((item) => html`<li>${item}</li>`)}
        </ul>`
      : html`<div class="muted">None</div>`}
  </div>`;
}
