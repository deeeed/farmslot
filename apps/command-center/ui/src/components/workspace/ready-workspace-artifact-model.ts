import type { ArtifactRef, ReadyGatePayload } from '@farmslot/protocol';

import { DIFF_EXTS, isWorkspaceEvidenceArtifact } from './workspace-artifacts.js';

export function readyWorkspaceReviewArtifacts(payload: ReadyGatePayload): ArtifactRef[] {
  return (payload.independentReviews ?? []).flatMap((review) =>
    (review.artifactPaths ?? []).map((path) => ({
      path,
      purpose: `review-loop-${review.loopNumber}`,
    })),
  );
}

export function dedupeReadyWorkspaceArtifacts(artifacts: ArtifactRef[]): ArtifactRef[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = `${artifact.path}::${artifact.purpose}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function readyWorkspaceAllArtifacts(payload: ReadyGatePayload): ArtifactRef[] {
  const packageArtifacts: ArtifactRef[] = [];
  if (payload.prPackage?.artifactPath) {
    packageArtifacts.push({ path: payload.prPackage.artifactPath, purpose: 'pr-package-json' });
    if (payload.prPackage.artifactPath.endsWith('.json')) {
      packageArtifacts.push({
        path: payload.prPackage.artifactPath.replace(/\.json$/, '.md'),
        purpose: 'pr-package-md',
      });
    }
  }
  if (payload.prPackage?.validationSummaryPath) {
    packageArtifacts.push({
      path: payload.prPackage.validationSummaryPath,
      purpose: 'validation-summary',
    });
  }
  return dedupeReadyWorkspaceArtifacts([
    ...(payload.artifactManifest ?? []),
    ...(payload.prPackage?.evidenceManifest ?? []),
    ...readyWorkspaceReviewArtifacts(payload),
    ...packageArtifacts,
  ]);
}

export function readyWorkspacePublishEvidenceArtifacts(payload: ReadyGatePayload): ArtifactRef[] {
  return dedupeReadyWorkspaceArtifacts(
    (payload.prPackage?.evidenceManifest?.length
      ? payload.prPackage.evidenceManifest
      : (payload.artifactManifest ?? [])
    ).filter(isWorkspaceEvidenceArtifact),
  );
}

export function readyWorkspaceEvidenceArtifacts(payload: ReadyGatePayload): ArtifactRef[] {
  const publishEvidence = readyWorkspacePublishEvidenceArtifacts(payload);
  if (publishEvidence.length > 0) return publishEvidence;
  // Evidence galleries are intentionally media-only: documents/diffs stay in
  // report/review sections so debug JSON or markdown does not inflate proof counts.
  return readyWorkspaceAllArtifacts(payload).filter(isWorkspaceEvidenceArtifact);
}

export function readyWorkspacePackagePreviewArtifact(
  payload: ReadyGatePayload,
): ArtifactRef | undefined {
  const packagePath = payload.prPackage?.artifactPath;
  if (!packagePath) return undefined;
  const mdPath = packagePath.endsWith('.json')
    ? packagePath.replace(/\.json$/, '.md')
    : packagePath;
  return { path: mdPath, purpose: 'pr-package-md' };
}

export function readyWorkspacePrimaryDiffArtifact(
  payload: ReadyGatePayload,
): ArtifactRef | undefined {
  return readyWorkspaceAllArtifacts(payload).find(
    (artifact) =>
      artifact.path === 'artifacts/diff.txt' ||
      artifact.path.endsWith('/diff.txt') ||
      DIFF_EXTS.test(artifact.path) ||
      artifact.purpose.includes('diff'),
  );
}
