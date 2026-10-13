// run-completion/package-evidence-manifest.ts — build immutable publishable evidence manifest entries.

import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  type ArtifactRef,
  isInternalRunArtifactPath,
  isPublishEvidenceArtifact,
  type Run,
} from '@farmslot/protocol';

import { isGatewayOwnedArtifactPath } from '../core/artifact-copy-policy.js';

import {
  isEvidenceManifestReferencedArtifact,
  mergeEvidenceManifestArtifactRefs,
} from './draft-pr.js';
import type { EvidenceManifest } from './evidence-manifest.js';
import { exactEvidenceKeys, isUploadableMediaPath } from './evidence-paths.js';
import { sha256File, sortArtifactRefsForComparison } from './ready-gate-package.js';
import { recordedPublicationDependencies } from './recorded-publication-evidence.js';

const PACKAGE_OUTPUT_ARTIFACT_PATHS = new Set([
  'artifacts/pr-package.json',
  'artifacts/pr-package.md',
]);

function evidenceManifestOmitSet(manifest: EvidenceManifest | null | undefined): Set<string> {
  const omitted = new Set<string>();
  for (const entry of manifest?.omit ?? []) {
    const key = typeof entry === 'string' ? entry : entry.file;
    if (typeof key !== 'string' || !key.trim()) continue;
    for (const variant of exactEvidenceKeys(key.trim())) omitted.add(variant);
  }
  return omitted;
}

function artifactPathOmitted(artifactPath: string, omitted: Set<string>): boolean {
  return exactEvidenceKeys(artifactPath).some((variant) => omitted.has(variant));
}

export async function buildPackageEvidenceManifest(
  taskDir: string | null,
  artifacts: ArtifactRef[],
  evidenceManifest: EvidenceManifest | null | undefined,
  contractVersion = 1,
): Promise<ArtifactRef[]> {
  const omittedEvidenceKeys = evidenceManifestOmitSet(evidenceManifest);
  const hasDeclaredEvidence =
    evidenceManifest?.standalone !== undefined ||
    evidenceManifest?.before_after_pairs !== undefined ||
    evidenceManifest?.videos !== undefined;
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
    if (!(hasDeclaredEvidence ? manifestReferenced : isPublishEvidenceArtifact(artifact))) continue;
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
  const dependencies = taskDir
    ? await recordedPublicationDependencies(
        taskDir,
        artifacts,
        entries.filter((entry) => isUploadableMediaPath(entry.path)),
        evidenceManifest,
        contractVersion,
      )
    : [];
  return sortArtifactRefsForComparison([
    ...new Map([...entries, ...dependencies].map((entry) => [entry.path, entry])).values(),
  ]);
}

export interface CurrentPackageEvidence {
  artifacts: ArtifactRef[];
  manifest: EvidenceManifest | null;
  inventory: ArtifactRef[];
}

export async function readCurrentPackageEvidence(run: Run): Promise<CurrentPackageEvidence> {
  if (!run.taskFile) throw new Error('Publication evidence requires a task directory');
  const taskDir = path.dirname(run.taskFile);
  const { scanArtifacts, readEvidenceManifest } = await import('./publication-artifacts.js');
  const artifacts = await scanArtifacts(taskDir);
  const manifest = await readEvidenceManifest(run);
  return {
    artifacts,
    manifest,
    inventory: await buildPackageEvidenceManifest(
      taskDir,
      artifacts,
      manifest,
      run.recordedEvidenceContractVersion ?? 0,
    ),
  };
}
