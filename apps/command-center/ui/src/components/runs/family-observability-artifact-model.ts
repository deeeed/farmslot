import type {
  FamilyArtifactBucketSummary,
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
} from '@farmslot/protocol';

import { artifactKind } from '../../utils/artifact-kind.js';
import { formatBytes } from '../../utils/format.js';
import type { LightboxItem } from '../shared/media-lightbox-types.js';
import { runArtifactFetchUrl, runArtifactUrl } from '../workspace/workspace-artifacts.js';

export function familyArtifactUrl(artifact: FamilyObservabilityArtifact): string {
  return runArtifactUrl(artifact.runId, artifact);
}

export function familyArtifactFetchUrl(artifact: FamilyObservabilityArtifact): string {
  return runArtifactFetchUrl(artifact.runId, artifact);
}

export function familyArtifactKey(
  artifact: Pick<FamilyObservabilityArtifact, 'path' | 'runId'>,
): string {
  return `${artifact.runId}:${artifact.path}`;
}

export function familyArtifactCaption(artifact: FamilyObservabilityArtifact): string {
  const parts = [`Run ${artifact.runId.slice(0, 8)}`, artifact.source.replace(/-/g, ' ')];
  if (typeof artifact.sizeBytes === 'number') {
    parts.push(formatBytes(artifact.sizeBytes));
  }
  return parts.join(' · ');
}

export function familyBucketSummary(buckets: FamilyArtifactBucketSummary[], limit = 3): string {
  return (
    buckets
      .slice(0, limit)
      .map((bucket) => `${bucket.key} ${bucket.count}/${formatBytes(bucket.bytes)}`)
      .join(' · ') || 'none'
  );
}

export function familyArtifactKind(
  artifact: Pick<FamilyObservabilityArtifact, 'path' | 'purpose'>,
): 'before' | 'after' | 'setup' {
  return artifactKind(artifact.path, artifact.purpose);
}

export function familyArtifactProvenance(
  artifact: FamilyObservabilityArtifact,
  run: Pick<FamilyObservabilityRunSummary, 'branch'> | null,
): string | undefined {
  const kind = familyArtifactKind(artifact);
  if (kind === 'setup') return undefined;
  if (kind === 'before') return 'baseline @ main';
  return run?.branch ? `fix @ ${run.branch}` : 'fix';
}

export function familyLightboxItem(
  artifact: FamilyObservabilityArtifact,
  run: Pick<FamilyObservabilityRunSummary, 'branch'> | null,
): LightboxItem {
  return {
    url: familyArtifactUrl(artifact),
    path: artifact.path,
    purpose: artifact.purpose,
    caption: familyArtifactCaption(artifact),
    provenance: familyArtifactProvenance(artifact, run),
    ...(artifact.maxFps != null ? { frameRate: artifact.maxFps } : {}),
  };
}
