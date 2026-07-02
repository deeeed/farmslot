import { html, nothing } from 'lit';

import type {
  FamilyChangeLedgerEntry,
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '@farmslot/protocol';

import { familyArtifactUrl } from './family-observability-artifact-model.js';
import {
  artifactFromPath,
  diffArtifactFromProvenance,
  familyContributionDeltaLabel,
  familyDiffArtifact,
  familyDiffLabel,
  ledgerDiffArtifact,
  ledgerDiffLabel,
  runDiffArtifact,
  runDiffLabel,
} from './family-observability-diff-model.js';

type LedgerDiff =
  | FamilyChangeLedgerEntry['contributionDiff']
  | NonNullable<FamilyChangeLedgerEntry['inputDiff']>
  | NonNullable<FamilyChangeLedgerEntry['legacyDiffFallback']>;

interface DiffLinkRenderersInput {
  snapshot: FamilyObservabilitySnapshot | null;
  onOpenDiff: (
    label: string,
    artifact: FamilyObservabilityArtifact,
    opener: HTMLElement | null,
  ) => void;
}

export function createFamilyDiffLinkRenderers(options: DiffLinkRenderersInput) {
  const artifactLookupSnapshot = () => ({
    runs: options.snapshot?.runs ?? [],
    evidence: options.snapshot?.evidence ?? [],
  });

  const renderDiffModalLink = (label: string, artifact: FamilyObservabilityArtifact | null) => {
    if (!artifact) return nothing;
    return html`<button
      class="detail-link"
      type="button"
      @click=${(event: Event) => {
        const opener = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
        options.onOpenDiff(label, artifact, opener);
      }}
    >
      ${label}
    </button>`;
  };

  const renderDiffModalInlineLink = (
    label: string,
    artifact: FamilyObservabilityArtifact | null,
  ) => {
    if (!artifact) return nothing;
    return html`<span
      class="detail-link inline-diff-link"
      @click=${(event: Event) => {
        event.stopPropagation();
        const opener = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
        options.onOpenDiff(label, artifact, opener);
      }}
      >${label}</span
    >`;
  };

  const renderRunDiffLink = (
    snapshot: FamilyObservabilitySnapshot,
    run: FamilyObservabilityRunSummary,
    inline = false,
  ) => {
    const label = runDiffLabel(snapshot, run);
    const artifact = runDiffArtifact(snapshot, run);
    if (!artifact) return html`${label}`;
    return inline
      ? renderDiffModalInlineLink(label, artifact)
      : renderDiffModalLink(label, artifact);
  };

  return {
    artifactFromPath: (
      runId: string,
      familyId: string,
      path: string | undefined,
      purpose: string,
      source: FamilyObservabilityArtifact['source'],
    ) => artifactFromPath(artifactLookupSnapshot(), runId, familyId, path, purpose, source),
    renderArtifactTextLink: (label: string, artifact: FamilyObservabilityArtifact | null) => {
      if (!artifact) return nothing;
      return html`<a
        class="detail-link"
        href=${familyArtifactUrl(artifact)}
        target="_blank"
        rel="noopener noreferrer"
        >${label}</a
      >`;
    },
    renderContributionDeltaLink: (snapshot: FamilyObservabilitySnapshot) => {
      if (!snapshot.familyChangeLedger) return nothing;
      const artifact = familyDiffArtifact(snapshot);
      const label = familyContributionDeltaLabel(snapshot);
      return artifact ? renderDiffModalLink(label, artifact) : html`${label}`;
    },
    renderDiffModalInlineLink,
    renderDiffModalLink,
    renderFamilyDiffLink: (snapshot: FamilyObservabilitySnapshot) => {
      const label = familyDiffLabel(snapshot);
      const artifact = familyDiffArtifact(snapshot);
      return artifact ? renderDiffModalLink(label, artifact) : html`${label}`;
    },
    renderLedgerArtifactPath: (
      entry: FamilyChangeLedgerEntry,
      diff: LedgerDiff,
      purpose: string,
      source: FamilyObservabilityArtifact['source'],
    ) => {
      if (!diff.artifactPath) return nothing;
      const artifact = diffArtifactFromProvenance(
        artifactLookupSnapshot(),
        entry.runId,
        entry.familyId,
        diff,
        purpose,
        source,
      );
      return artifact
        ? renderDiffModalLink(diff.artifactPath, artifact)
        : html`<span>${diff.artifactPath}</span>`;
    },
    renderLedgerDiffLink: (entry: FamilyChangeLedgerEntry) => {
      const label = ledgerDiffLabel(entry);
      const artifact = ledgerDiffArtifact(artifactLookupSnapshot(), entry);
      return artifact ? renderDiffModalLink(label, artifact) : html`${label}`;
    },
    renderRunDiffLink,
  };
}
