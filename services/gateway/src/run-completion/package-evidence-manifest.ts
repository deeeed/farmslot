// run-completion/package-evidence-manifest.ts — build immutable publishable evidence manifest entries.

import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  type ArtifactRef,
  isInternalRunArtifactPath,
  isPublishEvidenceArtifact,
} from '@farmslot/protocol';

import { isGatewayOwnedArtifactPath } from '../core/artifact-copy-policy.js';

import {
  isEvidenceManifestReferencedArtifact,
  mergeEvidenceManifestArtifactRefs,
} from './draft-pr.js';
import type { EvidenceManifest } from './evidence-manifest.js';
import { evidenceKeyVariants } from './evidence-paths.js';
import { sha256File, sortArtifactRefsForComparison } from './ready-gate-package.js';

const PACKAGE_OUTPUT_ARTIFACT_PATHS = new Set([
  'artifacts/pr-package.json',
  'artifacts/pr-package.md',
]);

function evidenceManifestOmitSet(manifest: EvidenceManifest | null | undefined): Set<string> {
  const omitted = new Set<string>();
  for (const entry of manifest?.omit ?? []) {
    const key = typeof entry === 'string' ? entry : entry.file;
    if (typeof key !== 'string' || !key.trim()) continue;
    for (const variant of evidenceKeyVariants(key.trim())) omitted.add(variant);
  }
  return omitted;
}

function evidenceManifestExplicitPublishEvidenceSet(
  manifest: EvidenceManifest | null | undefined,
): Set<string> | null {
  const explicit = new Set<string>();
  let screenshotRefCount = 0;
  const add = (key: string | undefined) => {
    if (typeof key !== 'string' || !key.trim()) return;
    screenshotRefCount += 1;
    for (const variant of evidenceKeyVariants(key.trim())) explicit.add(variant);
  };

  for (const pair of manifest?.before_after_pairs ?? []) {
    add(pair.before);
    add(pair.after);
  }
  for (const entry of manifest?.standalone ?? []) {
    add(entry.file);
  }

  const videoRefs = [manifest?.videos?.before, manifest?.videos?.after].filter(
    (key): key is string => typeof key === 'string' && key.trim().length > 0,
  );
  const includeVideos =
    videoRefs.length > 0 &&
    (manifest?.preferred_mode === 'video' ||
      manifest?.videos?.preferred === true ||
      screenshotRefCount === 0);
  if (includeVideos) {
    for (const key of videoRefs) {
      for (const variant of evidenceKeyVariants(key.trim())) explicit.add(variant);
    }
  }

  return explicit.size > 0 ? explicit : null;
}

function artifactPathOmitted(artifactPath: string, omitted: Set<string>): boolean {
  return evidenceKeyVariants(artifactPath).some((variant) => omitted.has(variant));
}

function artifactPathMatchesEvidenceSet(artifactPath: string, evidenceSet: Set<string>): boolean {
  return evidenceKeyVariants(artifactPath).some((variant) => evidenceSet.has(variant));
}

export async function buildPackageEvidenceManifest(
  taskDir: string | null,
  artifacts: ArtifactRef[],
  evidenceManifest: EvidenceManifest | null | undefined,
): Promise<ArtifactRef[]> {
  const omittedEvidenceKeys = evidenceManifestOmitSet(evidenceManifest);
  const explicitPublishEvidenceKeys = evidenceManifestExplicitPublishEvidenceSet(evidenceManifest);
  const trustedArtifacts = mergeEvidenceManifestArtifactRefs(artifacts, evidenceManifest);
  const entries: ArtifactRef[] = [];
  for (const artifact of trustedArtifacts) {
    const manifestReferenced = isEvidenceManifestReferencedArtifact(
      artifact.path,
      evidenceManifest,
    );
    if (
      PACKAGE_OUTPUT_ARTIFACT_PATHS.has(artifact.path) ||
      isGatewayOwnedArtifactPath(artifact.path) ||
      isInternalRunArtifactPath(artifact.path) ||
      artifactPathOmitted(artifact.path, omittedEvidenceKeys)
    )
      continue;
    const publishableEvidence = isPublishEvidenceArtifact(artifact) || manifestReferenced;
    if (!publishableEvidence) continue;
    if (
      explicitPublishEvidenceKeys &&
      !manifestReferenced &&
      !artifactPathMatchesEvidenceSet(artifact.path, explicitPublishEvidenceKeys)
    ) {
      continue;
    }
    let digest: string | undefined;
    if (taskDir) {
      const artifactPath = path.resolve(taskDir, artifact.path);
      const relative = path.relative(taskDir, artifactPath);
      if (!relative.startsWith('..') && !path.isAbsolute(relative) && existsSync(artifactPath)) {
        digest = await sha256File(artifactPath);
      }
    }
    entries.push({
      path: artifact.path,
      purpose: artifact.purpose,
      sizeBytes: artifact.sizeBytes,
      ...(digest ? { sha256: digest } : {}),
    });
  }
  return sortArtifactRefsForComparison(entries);
}
