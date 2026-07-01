import { html, nothing } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type {
  FamilyLearningEntry,
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
  PRStatus,
} from '@farmslot/protocol';

import { renderMarkdown } from '../../utils/markdown.js';

import { familyArtifactUrl } from './family-observability-artifact-model.js';
import { prStateColor } from './family-observability-display-model.js';
import { familyPrUrl } from './family-observability-link-model.js';
import { formatCreatedAt } from './run-utils.js';

interface FamilyRunSummaryGridOptions {
  run: FamilyObservabilityRunSummary;
  runs: readonly FamilyObservabilityRunSummary[];
  prs: readonly PRStatus[];
}

interface FamilySummaryStepsOptions {
  run: FamilyObservabilityRunSummary;
  onOpenStepArtifact: (
    artifacts: FamilyObservabilityArtifact[],
    index: number,
    event: CustomEvent<{ artifacts: FamilyObservabilityArtifact[]; index: number }>,
  ) => void;
}

export function renderFamilyRunSummaryGrid(options: FamilyRunSummaryGridOptions) {
  const { run } = options;
  const prUrl = familyPrUrl(run, options.runs);
  return html`
    <div class="run-summary-grid">
      <div><span class="muted">Project</span><strong>${run.project}</strong></div>
      <div>
        <span class="muted">PR</span>
        ${run.prNumber == null
          ? html`<strong>—</strong>`
          : html`
              <strong style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                ${prUrl
                  ? html`<a
                      class="ticket-link"
                      href=${prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      >#${run.prNumber}</a
                    >`
                  : html`<span>#${run.prNumber}</span>`}
                ${renderPrStatusBadge(run.prNumber, options.prs)}
              </strong>
            `}
      </div>
      <div>
        <span class="muted">Slot</span>${run.slotId
          ? html`<strong
              ><a class="slot-link" href=${`#slot/${run.slotId}`} title=${`Open slot ${run.slotId}`}
                >${run.slotId}</a
              ></strong
            >`
          : html`<strong>unknown</strong>`}
      </div>
      <div><span class="muted">Branch</span><strong>${run.branch ?? '—'}</strong></div>
      <div>
        <span class="muted">Created</span><strong>${formatCreatedAt(run.createdAt)}</strong>
      </div>
      <div><span class="muted">Recipe</span><strong>${run.recipeQuality.semantic}</strong></div>
    </div>
  `;
}

function renderPrStatusBadge(prNumber: number, prs: readonly PRStatus[]) {
  const pr = prs.find((candidate) => candidate.pr === prNumber);
  if (!pr) return nothing;
  const color = prStateColor(pr.prState);
  return html`<span
    class="badge status"
    style=${`border-color:${color}; color:${color}; font-size:9px; padding:1px 5px`}
    title=${pr.mergeState ? `merge: ${pr.mergeState.replace(/_/g, ' ')}` : pr.prState.toLowerCase()}
    >${pr.prState.toLowerCase()}</span
  >`;
}

export function renderFamilySummarySteps(options: FamilySummaryStepsOptions) {
  return html`
    <div class="detail-section">
      <div class="detail-title">Steps</div>
      <div class="step-list">
        ${options.run.steps.map(
          (step) => html`
            <step-artifacts
              .stepName=${step.stepName}
              .status=${step.status}
              .durationMs=${step.durationMs}
              .detail=${step.detail}
              .artifacts=${step.artifacts ?? []}
              .learnings=${step.learnings ?? []}
              .missingData=${step.missingData ?? []}
              .artifactUrl=${(artifact: FamilyObservabilityArtifact) => familyArtifactUrl(artifact)}
              @step-artifact-click=${(
                event: CustomEvent<{
                  artifacts: FamilyObservabilityArtifact[];
                  index: number;
                }>,
              ) => options.onOpenStepArtifact(event.detail.artifacts, event.detail.index, event)}
            ></step-artifacts>
          `,
        )}
      </div>
    </div>
  `;
}

export function renderFamilyLearnings(run: Pick<FamilyObservabilityRunSummary, 'learnings'>) {
  return html`
    <div class="detail-section">
      <div class="detail-title">Learnings · ${run.learnings.length}</div>
      ${run.learnings.length === 0
        ? html`<div class="muted">No learnings recorded for this run.</div>`
        : html`<div class="learning-list">
            ${run.learnings.map((entry) => renderFamilyLearningCard(entry))}
          </div>`}
    </div>
  `;
}

function renderFamilyLearningCard(entry: FamilyLearningEntry) {
  const sevClass = `learning-sev-${entry.severity}`;
  return html`
    <div class="learning-card ${sevClass}">
      <div class="learning-head">
        <span class="learning-sev-dot ${sevClass}"></span>
        <span class="learning-title">${entry.title}</span>
        <span class="learning-source">${entry.source}</span>
      </div>
      <div class="learning-body">${entry.summary}</div>
      ${entry.detail
        ? html`<details class="learning-detail">
            <summary>Detail</summary>
            <div class="learning-detail-body">${unsafeHTML(renderMarkdown(entry.detail))}</div>
          </details>`
        : nothing}
      <div class="learning-foot">
        ${entry.stepName ? html`<span>step: <strong>${entry.stepName}</strong></span>` : nothing}
        <span>${familyLearningTimeAgo(entry.createdAt)}</span>
      </div>
    </div>
  `;
}

export function familyLearningTimeAgo(iso: string, nowMs = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Math.max(0, nowMs - then);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
