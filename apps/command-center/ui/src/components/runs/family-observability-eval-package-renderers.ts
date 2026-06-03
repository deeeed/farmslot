import { html, nothing } from 'lit';

import type {
  FamilyObservabilityArtifact,
  FamilyObservabilitySnapshot,
  ResultPackageProjection,
} from '@farmslot/protocol';

import {
  resultPackageAxisLabel,
  resultPackageDiffArtifact,
  resultPackageDiffLabel,
  resultPackageEvidenceLabel,
  resultPackageSourceLabel,
  selectedFamilyEvalExperiment,
} from './family-observability-output-model.js';
import { formatDuration } from './run-utils.js';

interface FamilyEvalPackagePanelRenderOptions {
  snapshot: FamilyObservabilitySnapshot;
  selectedExperimentKey: string;
  onSelectExperiment: (experimentKey: string) => void;
  renderDiffModalLink: (label: string, artifact: FamilyObservabilityArtifact | null) => unknown;
}

export function renderFamilyEvalPackagePanel(options: FamilyEvalPackagePanelRenderOptions) {
  const experiments = options.snapshot.experiments ?? [];
  if (experiments.length === 0) return nothing;
  const selected = selectedFamilyEvalExperiment(options.snapshot, options.selectedExperimentKey);
  if (!selected) return nothing;
  const packages = selected.packages ?? [];
  return html`
    <section class="panel comparison-panel">
      <div class="comparison-head">
        <div>
          <div class="panel-title">Reference vs Candidate packages</div>
          <div class="comparison-subtitle">
            The Reference package is the original prior run/PR/commit/package. Candidate packages
            are artifact-only trials in this eval family.
          </div>
        </div>
        <div class="comparison-head-actions">
          ${experiments.length > 1
            ? html`
                <select
                  class="eval-select"
                  .value=${selected.experimentKey}
                  @change=${(event: Event) => {
                    options.onSelectExperiment((event.target as HTMLSelectElement).value);
                  }}
                >
                  ${experiments.map(
                    (entry) =>
                      html`<option value=${entry.experimentKey}>
                        ${entry.experimentId} · ${entry.taskProfile}
                      </option>`,
                  )}
                </select>
              `
            : nothing}
          <a class="action-link" href="#evals">Open eval cockpit</a>
        </div>
      </div>
      <div class="comparison-facts">
        <span>${selected.experimentId}</span>
        <span>${selected.taskProfile}</span>
        <span
          >${selected.candidateStrategies.length} candidate
          ${selected.candidateStrategies.length === 1 ? 'strategy' : 'strategies'}</span
        >
        <span
          >${selected.trials.length} artifact-only
          trial${selected.trials.length === 1 ? '' : 's'}</span
        >
        <span>${selected.rubricId}@${selected.rubricVersion}</span>
        <span>${packages.length} package${packages.length === 1 ? '' : 's'}</span>
        ${selected.missingData.map((item) => html`<span>${item}</span>`)}
      </div>
      <div class="eval-package-table" style="margin-top:12px">
        <div class="eval-package-row eval-package-head">
          <span>Package</span><span>Source / axes</span><span>Status</span><span>Diff</span
          ><span>Evidence</span><span>Time / cost</span><span>Run</span>
        </div>
        ${packages.map((pkg) => renderFamilyEvalPackageRow(options, pkg))}
      </div>
    </section>
  `;
}

function renderFamilyEvalPackageRow(
  options: FamilyEvalPackagePanelRenderOptions,
  pkg: ResultPackageProjection,
) {
  return html`
    <div class="eval-package-row">
      <span
        ><strong
          >${pkg.role === 'reference' ? 'Reference' : 'Candidate'} ·
          ${pkg.label ?? pkg.strategyId ?? pkg.caseId ?? pkg.packageId}</strong
        ><small>${pkg.packageId.slice(0, 12)} · ${pkg.packageHash.slice(0, 12)}</small></span
      >
      <span
        >${pkg.role === 'reference'
          ? resultPackageSourceLabel(pkg)
          : resultPackageAxisLabel(pkg)}${renderFamilyEvalPackageSourceLinks(
          pkg,
        )}${pkg.candidateStrategyFingerprint
          ? html`<small>${pkg.candidateStrategyFingerprint.slice(0, 12)}</small>`
          : nothing}</span
      >
      <span
        >${pkg.status}${pkg.missingData.length
          ? html`<small>${pkg.missingData.slice(0, 2).join(', ')}</small>`
          : nothing}</span
      >
      <span>${renderFamilyEvalPackageDiff(options, pkg)}</span>
      <span>${resultPackageEvidenceLabel(pkg)}</span>
      <span
        >${pkg.metrics?.durationMs != null
          ? formatDuration(pkg.metrics.durationMs)
          : 'pending'}${pkg.metrics?.costEstimate != null
          ? html`<small>$${pkg.metrics.costEstimate.toFixed(2)}</small>`
          : nothing}</span
      >
      <span
        >${pkg.runId
          ? html`<a class="ticket-link" href=${`#run/${pkg.runId}`}>${pkg.runId.slice(0, 8)}</a>`
          : '—'}</span
      >
    </div>
  `;
}

function renderFamilyEvalPackageDiff(
  options: FamilyEvalPackagePanelRenderOptions,
  pkg: ResultPackageProjection,
) {
  const label = resultPackageDiffLabel(pkg);
  const artifact = resultPackageDiffArtifact(options.snapshot, pkg);
  if (!artifact) return html`${label}`;
  return options.renderDiffModalLink(label, artifact);
}

function renderFamilyEvalPackageSourceLinks(pkg: ResultPackageProjection) {
  const links = pkg.sourceBacklinks ?? [];
  if (links.length === 0) return nothing;
  return html`<small
    >${links.map((link, index) => {
      const sep = index === 0 ? '' : ' · ';
      if (link.kind === 'run')
        return html`${sep}<a class="ticket-link" href=${`#run/${link.runId}`}>source run</a>`;
      if (link.kind === 'family')
        return html`${sep}<a class="ticket-link" href=${`#family/${link.familyId}`}
            >source family</a
          >`;
      if (link.kind === 'github-pr') {
        const href = link.url ?? `https://github.com/${link.repo}/pull/${link.prNumber}`;
        return html`${sep}<a
            class="ticket-link"
            href=${href}
            target="_blank"
            rel="noopener noreferrer"
            >source PR</a
          >`;
      }
      if (link.kind === 'package')
        return html`${sep}<span>source package ${link.packageId.slice(0, 8)}</span>`;
      return html`${sep}<span>source ref ${link.ref}</span>`;
    })}</small
  >`;
}
