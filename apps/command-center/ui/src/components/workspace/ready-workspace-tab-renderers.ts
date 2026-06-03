import { html, nothing, type TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type { ArtifactRef, PublicationTarget, ReadyGatePayload } from '@farmslot/protocol';

import type { ReadyInputArtifact } from './ready-workspace-inputs.js';
import { renderReadyWorkspaceMarkdown } from './ready-workspace-markdown.js';
import { VIDEO_EXTS } from './workspace-artifacts.js';

export function renderReadyPrPreviewTab(input: {
  payload: ReadyGatePayload;
  publicationTarget: PublicationTarget;
  markdown: string;
  fallback: () => TemplateResult;
}) {
  const { payload } = input;
  if (!payload.prPackage) return input.fallback();
  return html`
    <div class="rdy-pr-preview">
      <div class="rdy-pr-preview-header">
        <div>
          <div class="rdy-pr-preview-eyebrow">
            ${input.publicationTarget === 'ready' ? 'Ready PR' : 'Draft PR'} description preview
          </div>
          <h3>${payload.prPackage.draftTitle}</h3>
        </div>
        <span class="rdy-review-pill"
          >${payload.publicationStatus ?? payload.prPackage.publicationStatus}</span
        >
      </div>
      <div class="rdy-pr-preview-body rdy-md-section">${unsafeHTML(input.markdown)}</div>
    </div>
  `;
}

export function renderReadyInputTab(input: {
  artifacts: ReadyInputArtifact[];
  openInputArtifact: (id: string) => void;
}) {
  if (input.artifacts.length === 0) return html`<div class="rdy-tab-empty">No input snapshot</div>`;
  return html`
    <div class="rdy-input-tab">
      <div class="rdy-input-artifact-grid">
        ${input.artifacts.map(
          (artifact) => html`
            <button
              class="rdy-input-artifact-card"
              @click=${() => input.openInputArtifact(artifact.id)}
              title=${`Open ${artifact.label}`}
            >
              <span>${artifact.kind}</span>
              <strong>${artifact.label}</strong>
              <small>${artifact.summary}</small>
              ${artifact.meta?.length
                ? html`
                    <div class="rdy-input-artifact-meta">
                      ${artifact.meta.map((item) => html`<code>${item}</code>`)}
                    </div>
                  `
                : nothing}
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

export function renderReadyRecipeTab(input: {
  payload: ReadyGatePayload;
  recipeView: 'graph' | 'json';
  runId: string;
  slotId: string;
  recovering: boolean;
  selectedArtifacts: TemplateResult | typeof nothing;
  setRecipeView: (view: 'graph' | 'json') => void;
}) {
  const { payload } = input;
  if (!payload.recipeJson) return html`<div class="rdy-tab-empty">No recipe</div>`;
  return html`
    <div class="rdy-recipe-view">
      <div class="rdy-recipe-toolbar">
        <button
          class="rdy-recipe-toggle ${input.recipeView === 'graph' ? 'active' : ''}"
          @click=${() => input.setRecipeView('graph')}
        >
          Graph
        </button>
        <button
          class="rdy-recipe-toggle ${input.recipeView === 'json' ? 'active' : ''}"
          @click=${() => input.setRecipeView('json')}
        >
          JSON
        </button>
      </div>
      <recipe-runner-controls
        runId=${input.runId}
        slotId=${input.slotId}
        runLabel="Run live"
        description="Runs this recipe on the warm ready workspace without covering the stream. Follow logs here, then inspect generated artifacts from the new attempt."
        .playbackSlowMs=${2000}
        showPlayback
        ?disabled=${input.recovering}
      ></recipe-runner-controls>
      ${input.selectedArtifacts}
      ${input.recipeView === 'graph'
        ? html`
            <div class="rdy-recipe-graph-wrap">
              <recipe-graph .recipe=${payload.recipeJson}></recipe-graph>
            </div>
          `
        : html`
            <pre class="rdy-recipe-pre"><code>${(() => {
              try {
                return JSON.stringify(JSON.parse(payload.recipeJson), null, 2);
              } catch {
                return payload.recipeJson;
              }
            })()}</code></pre>
          `}
    </div>
  `;
}

export function renderReadyEvidenceTab(input: {
  payload: ReadyGatePayload;
  artifacts: ArtifactRef[];
  selectionToolbar: TemplateResult | typeof nothing;
  artifactGroups: TemplateResult;
}) {
  if (input.artifacts.length === 0) return html`<div class="rdy-tab-empty">No evidence</div>`;
  return html`
    <div class="rdy-evidence-tab">
      ${input.payload.prPackage ? input.selectionToolbar : nothing} ${input.artifactGroups}
    </div>
  `;
}

export function renderReadyEvidenceSelectionToolbar(input: {
  publishEvidence: ArtifactRef[];
  selected: Set<string>;
  setAllEvidenceIncluded: (included: boolean) => void;
  excludeEvidenceVideos: () => void;
}) {
  if (!input.publishEvidence.length) return nothing;
  const selectedCount = input.publishEvidence.filter((artifact) =>
    input.selected.has(artifact.path),
  ).length;
  const videoCount = input.publishEvidence.filter((artifact) =>
    VIDEO_EXTS.test(artifact.path),
  ).length;
  const selectedVideoCount = input.publishEvidence.filter(
    (artifact) => VIDEO_EXTS.test(artifact.path) && input.selected.has(artifact.path),
  ).length;
  return html`
    <div class="rdy-evidence-selection">
      <div>
        <strong>Publish evidence</strong>
        <span
          >${selectedCount}/${input.publishEvidence.length}
          selected${videoCount ? ` · ${selectedVideoCount}/${videoCount} videos` : ''}</span
        >
      </div>
      <div class="rdy-evidence-selection-actions">
        ${videoCount
          ? html`
              <button
                class="rdy-artifact-filter"
                ?disabled=${selectedVideoCount === 0}
                @click=${input.excludeEvidenceVideos}
              >
                Exclude videos
              </button>
            `
          : nothing}
        <button class="rdy-artifact-filter" @click=${() => input.setAllEvidenceIncluded(true)}>
          Include all
        </button>
        <button class="rdy-artifact-filter" @click=${() => input.setAllEvidenceIncluded(false)}>
          Clear all
        </button>
      </div>
    </div>
  `;
}

export function renderReadyQualityTab(payload: ReadyGatePayload) {
  const quality = payload.recipeQualityArtifact;
  const report = payload.qualityReport;
  const acs = payload.acceptanceCriteria ?? [];
  if (!quality && !report && acs.length === 0)
    return html`<div class="rdy-tab-empty">No quality report</div>`;
  return html`
    <div class="rdy-quality-tab">
      ${quality
        ? html`
            <section class="rdy-quality-card">
              <div class="rdy-learnings-header">Recipe Quality · ${quality.compact.verdict}</div>
              <ul class="rdy-ac-list">
                ${quality.compact.reasons.map(
                  (reason) => html`<li class="rdy-ac-item">${reason}</li>`,
                )}
              </ul>
              ${quality.compact.better_version_guidance.length
                ? html`
                    <div class="rdy-quality-subtitle">Better version</div>
                    <ul class="rdy-ac-list">
                      ${quality.compact.better_version_guidance.map(
                        (item) => html`<li class="rdy-ac-item">${item}</li>`,
                      )}
                    </ul>
                  `
                : nothing}
            </section>
          `
        : nothing}
      ${report
        ? html`
            <section class="rdy-quality-card">
              <div class="rdy-learnings-header">Evidence Quality · ${report.overallScore}%</div>
              <ul class="rdy-ac-list">
                ${report.acVerdicts.map(
                  (verdict) => html`
                    <li class="rdy-ac-item">
                      <strong>${verdict.verdict}</strong> — ${verdict.ac}
                      <div class="rdy-review-card-meta">${verdict.reasoning}</div>
                    </li>
                  `,
                )}
              </ul>
            </section>
          `
        : nothing}
      ${acs.length
        ? html`
            <section class="rdy-quality-card">
              <div class="rdy-learnings-header">Acceptance Criteria</div>
              <ul class="rdy-ac-list">
                ${acs.map((ac) => html`<li class="rdy-ac-item">${ac}</li>`)}
              </ul>
            </section>
          `
        : nothing}
    </div>
  `;
}

export function renderReadyLearningsTab(payload: ReadyGatePayload) {
  if (!payload.workerLearnings) return html`<div class="rdy-tab-empty">No learnings</div>`;
  return html`
    <div class="rdy-learnings-tab rdy-md-section">
      ${unsafeHTML(renderReadyWorkspaceMarkdown(payload.workerLearnings))}
    </div>
  `;
}
