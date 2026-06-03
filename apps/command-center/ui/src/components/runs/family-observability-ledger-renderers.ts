import { html, nothing } from 'lit';

import type {
  FamilyChangeLedgerEntry,
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '@farmslot/protocol';

import { formatBytes } from '../../utils/format.js';

import { familyBucketSummary } from './family-observability-artifact-model.js';
import { familyLedgerEntry } from './family-observability-diff-model.js';
import { familyLedgerTurnLabel, flowColor, flowLabel } from './run-utils.js';

interface FamilyLedgerRenderContext {
  artifactFromPath: (
    runId: string,
    familyId: string,
    path: string | undefined,
    purpose: string,
    source: FamilyObservabilityArtifact['source'],
  ) => FamilyObservabilityArtifact | null;
  renderRunDiffLink: (
    snapshot: FamilyObservabilitySnapshot,
    run: FamilyObservabilityRunSummary,
  ) => unknown;
  renderDiffModalLink: (label: string, artifact: FamilyObservabilityArtifact | null) => unknown;
  renderArtifactTextLink: (label: string, artifact: FamilyObservabilityArtifact | null) => unknown;
  renderContributionDeltaLink: (snapshot: FamilyObservabilitySnapshot) => unknown;
  renderLedgerDiffLink: (entry: FamilyChangeLedgerEntry) => unknown;
  renderLedgerArtifactPath: (
    entry: FamilyChangeLedgerEntry,
    diff: FamilyChangeLedgerEntry['contributionDiff'],
    purpose: string,
    source: FamilyObservabilityArtifact['source'],
  ) => unknown;
}

export function renderFamilyLedgerDiffDetail(
  snapshot: FamilyObservabilitySnapshot | null,
  run: FamilyObservabilityRunSummary,
  context: FamilyLedgerRenderContext,
) {
  if (!snapshot) return nothing;
  const entry = familyLedgerEntry(snapshot, run.runId);
  if (!entry) {
    return html`
      <div class="detail-section">
        <div class="detail-title">Diff summary</div>
        <div>
          ${run.diffStat.available
            ? context.renderRunDiffLink(snapshot, run)
            : 'No persisted diff summary for this run.'}
        </div>
      </div>
    `;
  }

  const producedArtifact = context.artifactFromPath(
    entry.runId,
    entry.familyId,
    entry.contributionDiff.artifactPath,
    'diff',
    'task-artifact',
  );
  const reviewedArtifact = context.artifactFromPath(
    entry.runId,
    entry.familyId,
    entry.inputDiff?.artifactPath,
    'input-diff',
    'task-input',
  );
  const commitArtifact = entry.inputCommit
    ? context.artifactFromPath(
        entry.runId,
        entry.familyId,
        'inputs/commit.json',
        'input-commit',
        'task-input',
      )
    : null;

  return html`
    <div class="detail-section diff-detail-grid">
      <div class="diff-detail-card">
        <div class="detail-title">Produced code</div>
        ${entry.contributionDiff.available
          ? html`<div>
              ${context.renderDiffModalLink(
                `${entry.contributionDiff.files} files changed, +${entry.contributionDiff.additions} -${entry.contributionDiff.deletions}`,
                producedArtifact,
              )}
            </div>`
          : entry.contributionDiff.partialStat
            ? html`<div>
                ${entry.contributionDiff.partialStat.files} files changed,
                +${entry.contributionDiff.partialStat.additions}
                -${entry.contributionDiff.partialStat.deletions} partial
              </div>`
            : html`<div class="muted">No code change produced by this run.</div>`}
        <div class="detail-actions">
          ${context.renderDiffModalLink('Open produced diff', producedArtifact)}
        </div>
      </div>
      <div class="diff-detail-card">
        <div class="detail-title">Reviewed PR diff</div>
        ${entry.inputDiff
          ? entry.inputDiff.available
            ? html`<div>
                ${context.renderDiffModalLink(
                  `${entry.inputDiff.files} files reviewed, +${entry.inputDiff.additions} -${entry.inputDiff.deletions}`,
                  reviewedArtifact,
                )}
              </div>`
            : html`<div class="muted">
                ${entry.inputDiff.missingReason === 'no-source-diff'
                  ? 'Reviewed input had no source-code diff.'
                  : `Reviewed input unavailable: ${entry.inputDiff.missingReason ?? 'unknown'}`}
              </div>`
          : html`<div class="muted">No reviewed-input snapshot for this run.</div>`}
        <div class="detail-actions">
          ${context.renderDiffModalLink('Open reviewed input', reviewedArtifact)}
          ${context.renderArtifactTextLink('Open commit metadata', commitArtifact)}
        </div>
      </div>
    </div>
  `;
}

export function renderFamilyChangeLedger(
  snapshot: FamilyObservabilitySnapshot,
  context: FamilyLedgerRenderContext,
) {
  const ledger = snapshot.familyChangeLedger;
  if (!ledger) return nothing;
  const summary = ledger.summary;
  const missing = ledger.entries.filter((entry) => entry.missingData.length > 0);
  return html`
    <section class="panel change-ledger">
      <div class="panel-title">
        Ledger details <span class="panel-hint">· durable diff and review signals</span>
      </div>
      <div class="ledger-metrics">
        <div>
          <span class="muted">Produced-code diffs</span
          ><strong>${summary.runsWithContributionDiff}/${ledger.entries.length}</strong>
        </div>
        <div>
          <span class="muted">Reviewed input diffs</span
          ><strong>${summary.runsWithReviewInputDiff}/${ledger.entries.length}</strong>
        </div>
        <div>
          <span class="muted">Empty reviewed inputs</span
          ><strong>${summary.runsWithEmptyReviewInputDiff}</strong>
        </div>
        <div>
          <span class="muted">Unavailable reviewed inputs</span
          ><strong>${summary.runsWithUnavailableReviewInputDiff}</strong>
        </div>
        <div>
          <span class="muted">Contribution delta</span
          ><strong>${context.renderContributionDeltaLink(snapshot)}</strong>
        </div>
        <div>
          <span class="muted">Artifact data</span
          ><strong
            >${summary.artifactFootprint.count} files ·
            ${formatBytes(summary.artifactFootprint.bytes)}</strong
          >
        </div>
        <div>
          <span class="muted">Artifact types</span
          ><strong>${familyBucketSummary(summary.artifactFootprint.byPurpose)}</strong>
        </div>
        <div>
          <span class="muted">File types</span
          ><strong>${familyBucketSummary(summary.artifactFootprint.byExtension)}</strong>
        </div>
        <div>
          <span class="muted">Bugbots addressed</span
          ><strong>${summary.bugbotFindingsAddressed}</strong>
        </div>
        <div>
          <span class="muted">Human reviewers requesting changes</span
          ><strong>${summary.humanReviewersRequestingChanges}</strong>
        </div>
        <div>
          <span class="muted">Human comments addressed</span
          ><strong>${summary.humanCommentsAddressed}</strong>
        </div>
        <div><span class="muted">Missing data</span><strong>${missing.length}</strong></div>
      </div>
      <div class="ledger-entries">
        ${ledger.entries.map(
          (entry) => html`
            <div class="ledger-entry">
              <div class="ledger-entry-main">
                <span class="badge" style=${`background:${flowColor(entry.flowType)}; color:#000`}
                  >${flowLabel(entry.flowType)}</span
                >
                <strong>${entry.runId.slice(0, 8)}</strong>
                <span class="muted">${familyLedgerTurnLabel(entry)}</span>
                <span>${context.renderLedgerDiffLink(entry)}</span>
              </div>
              <div class="ledger-entry-meta">
                ${entry.reviewSignals
                  ? html`
                      <span>bot fixed ${entry.reviewSignals.botAddressed}</span>
                      <span
                        >human reviewers
                        ${entry.reviewSignals.humanReviewersRequestingChanges}</span
                      >
                      <span>human fixed ${entry.reviewSignals.humanCommentsAddressed}</span>
                    `
                  : nothing}
                ${context.renderLedgerArtifactPath(
                  entry,
                  entry.contributionDiff,
                  'diff',
                  'task-artifact',
                )}
                ${entry.inputDiff
                  ? context.renderLedgerArtifactPath(
                      entry,
                      entry.inputDiff,
                      'input-diff',
                      'task-input',
                    )
                  : nothing}
                ${entry.legacyDiffFallback
                  ? context.renderLedgerArtifactPath(
                      entry,
                      entry.legacyDiffFallback,
                      'legacy-diff',
                      'step-output',
                    )
                  : nothing}
                <span
                  >data ${entry.artifactFootprint.count} files ·
                  ${formatBytes(entry.artifactFootprint.bytes)}</span
                >
                ${entry.missingData.length
                  ? html`<span class="warn">missing: ${entry.missingData.join(', ')}</span>`
                  : nothing}
              </div>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}
