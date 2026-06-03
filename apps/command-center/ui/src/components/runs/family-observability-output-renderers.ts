import { html, nothing } from 'lit';

import type {
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '@farmslot/protocol';

import { formatBytes } from '../../utils/format.js';

import {
  findOutputComparisonPair,
  type OutputRunSummary,
  outputSummaryForRun,
} from './family-observability-output-model.js';

interface FamilyOutputComparisonRenderOptions {
  snapshot: FamilyObservabilitySnapshot;
  selectedRun: FamilyObservabilityRunSummary | null;
  runLabel: (run: FamilyObservabilityRunSummary) => string;
  runBadgeLabel: (run: FamilyObservabilityRunSummary) => string;
  renderRunDiffLink: (
    snapshot: FamilyObservabilitySnapshot,
    run: FamilyObservabilityRunSummary,
  ) => unknown;
}

function renderOutputMetric(label: string, value: unknown, hint?: string) {
  return html`
    <div class="output-metric">
      <span>${label}</span>
      <strong>${value}</strong>
      ${hint ? html`<small>${hint}</small>` : nothing}
    </div>
  `;
}

function renderOutputRunCard(
  options: FamilyOutputComparisonRenderOptions,
  title: string,
  summary: OutputRunSummary<FamilyObservabilityRunSummary>,
) {
  const run = summary.run;
  return html`
    <div class="output-run-card">
      <div class="output-run-title">
        <span>${title}</span>
        <a class="ticket-link" href=${`#run/${run.runId}`}>${run.runId.slice(0, 8)}</a>
      </div>
      <div class="output-run-subtitle">
        ${options.runLabel(run)} · ${options.runBadgeLabel(run)} ·
        ${run.lane}${run.variant ? `/${run.variant}` : ''}
      </div>
      <div class="output-metrics">
        ${renderOutputMetric(
          'Artifact/data files',
          `${summary.artifactCount}`,
          formatBytes(summary.artifactBytes),
        )}
        ${renderOutputMetric('Previewable evidence', `${summary.evidenceCount}`, 'shown below')}
        ${renderOutputMetric('Code diff', options.renderRunDiffLink(options.snapshot, run))}
      </div>
    </div>
  `;
}

export function renderFamilyRunOutputComparisonSummary(
  options: FamilyOutputComparisonRenderOptions,
) {
  const pair = findOutputComparisonPair(options.snapshot, options.selectedRun);
  if (!pair) return nothing;
  const baseline = outputSummaryForRun(options.snapshot, pair.baseline);
  const replay = outputSummaryForRun(options.snapshot, pair.replay);
  const fileDelta = replay.artifactCount - baseline.artifactCount;
  const byteDelta = replay.artifactBytes - baseline.artifactBytes;
  const evidenceDelta = replay.evidenceCount - baseline.evidenceCount;
  const formatSigned = (value: number) => (value > 0 ? `+${value}` : `${value}`);
  const compareHref = `#runs/compare?a=${encodeURIComponent(pair.baseline.runId)}&b=${encodeURIComponent(pair.replay.runId)}`;
  return html`
    <section class="panel output-compare-panel">
      <div class="comparison-head">
        <div>
          <div class="panel-title">Parent vs candidate output</div>
          <div class="comparison-subtitle">
            This is the operator summary for a same-family parent→candidate relationship:
            artifact/data files on each run, previewable evidence shown below, and source-code diff
            availability.
          </div>
        </div>
        <div class="comparison-head-actions">
          <a class="action-link" href=${compareHref}>Open run comparison</a>
        </div>
      </div>
      <div class="output-compare-grid">
        ${renderOutputRunCard(options, 'Parent run', baseline)}
        <div class="output-delta-card">
          <div class="output-run-title">Candidate delta</div>
          <div class="output-metrics">
            ${renderOutputMetric(
              'Artifact/data files',
              formatSigned(fileDelta),
              `${baseline.artifactCount} → ${replay.artifactCount}`,
            )}
            ${renderOutputMetric(
              'Artifact/data bytes',
              `${byteDelta >= 0 ? '+' : '-'}${formatBytes(Math.abs(byteDelta))}`,
              `${formatBytes(baseline.artifactBytes)} → ${formatBytes(replay.artifactBytes)}`,
            )}
            ${renderOutputMetric(
              'Evidence previews',
              formatSigned(evidenceDelta),
              `${baseline.evidenceCount} → ${replay.evidenceCount}`,
            )}
          </div>
          <div class="output-note">
            “No code diff” means no source-code delta was captured for that run. Artifact/data
            counts include output artifacts plus captured provenance such as task inputs.
          </div>
        </div>
        ${renderOutputRunCard(options, 'Candidate run', replay)}
      </div>
    </section>
  `;
}
