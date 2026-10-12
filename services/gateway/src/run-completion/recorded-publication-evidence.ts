import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { readRecordedEvidencePackage } from '@farmslot/adapter-sdk';
import { validateRecordedEvidencePackage } from '@farmslot/adapter-sdk/evidence';
import type { ArtifactRef, Run } from '@farmslot/protocol';

import { isGatewayOwnedArtifactPath } from '../core/artifact-copy-policy.js';
import {
  readFrozenRecordedEvidenceSources,
  recordedEvidenceRoots,
} from '../run-engine/recorded-evidence-sources.js';

import { type EvidenceManifest, validateEvidenceManifest } from './evidence-manifest.js';
import { isUploadableMediaPath } from './evidence-paths.js';
import {
  resolveSelectedEvidenceRef,
  sha256Text,
  verifyReadyGateSelectedEvidenceFiles,
} from './ready-gate-package.js';

const SELECTION_MANIFEST_PATH = 'artifacts/evidence-manifest.json';

/** Freeze input bytes without making dependency files selectable publication media. */
export async function recordedPublicationDependencies(
  taskDir: string,
  artifacts: readonly ArtifactRef[],
  media: readonly ArtifactRef[],
  expectedManifest: EvidenceManifest | null | undefined,
): Promise<ArtifactRef[]> {
  const taskRoot = await realpath(taskDir);
  const entries = new Map<string, ArtifactRef>();
  const byPath = new Map(media.map((artifact) => [artifact.path, artifact]));
  for (const root of recordedEvidenceRoots(
    artifacts,
    media.map((artifact) => artifact.path),
  )) {
    const directory = await realpath(path.resolve(taskRoot, root));
    const relative = path.relative(taskRoot, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Publication recipe closure escapes the task directory.');
    const { input, checks } = await readRecordedEvidencePackage(directory);
    const issues = [
      ...checks.filter((check) => check.status === 'fail').map((check) => check.message),
      ...validateRecordedEvidencePackage(input)
        .findings.filter((finding) => finding.severity === 'error')
        .map((finding) => finding.message),
    ];
    if (issues.length)
      throw new Error(`Publication recipe closure is invalid (${root}): ${issues.join('; ')}`);
    for (const file of input.artifactPaths ?? []) {
      const artifactPath = path.posix.join(root, file);
      if (isGatewayOwnedArtifactPath(artifactPath))
        throw new Error(`Publication recipe closure includes gateway-owned data: ${artifactPath}`);
      const existing = byPath.get(artifactPath);
      entries.set(artifactPath, {
        path: artifactPath,
        purpose: existing?.purpose ?? 'evidence-dependency',
        ...(existing?.sizeBytes !== undefined ? { sizeBytes: existing.sizeBytes } : {}),
        sha256: input.artifactDigests[file]!.replace(/^sha256:/u, ''),
      });
    }
  }
  const selectionPath = path.join(taskRoot, SELECTION_MANIFEST_PATH);
  if (media.length && existsSync(selectionPath)) {
    const relative = path.relative(taskRoot, await realpath(selectionPath));
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Publication selection manifest escapes the task directory.');
    const text = await readFile(selectionPath, 'utf8');
    const value: unknown = JSON.parse(text);
    const issues = validateEvidenceManifest(value);
    if (!isDeepStrictEqual(value, expectedManifest))
      throw new Error('Publication selection changed while preparing its frozen package.');
    if (issues.length)
      throw new Error(`Publication selection manifest is invalid: ${issues.join('; ')}`);
    entries.set(SELECTION_MANIFEST_PATH, {
      path: SELECTION_MANIFEST_PATH,
      purpose: 'evidence-manifest',
      sizeBytes: Buffer.byteLength(text),
      sha256: sha256Text(text),
    });
  }
  return [...entries.values()];
}

/** A missing historical selection cannot be reconstructed from today's mutable manifest. */
export async function readFrozenPublicationManifest(
  run: Run,
  inventory: readonly ArtifactRef[],
): Promise<EvidenceManifest | null> {
  const manifest = inventory.find((artifact) => artifact.path === SELECTION_MANIFEST_PATH);
  if (!manifest) return null;
  if (!run.taskFile || !manifest.sha256)
    throw new Error('The frozen publication selection manifest has no retained byte identity.');
  await verifyReadyGateSelectedEvidenceFiles(run, { evidenceManifest: [...inventory] }, [
    manifest.path,
  ]);
  const text = await readFile(path.resolve(path.dirname(run.taskFile), manifest.path), 'utf8');
  if (sha256Text(text) !== manifest.sha256.replace(/^sha256:/u, ''))
    throw new Error('The frozen publication selection manifest bytes changed.');
  const value: unknown = JSON.parse(text);
  const issues = validateEvidenceManifest(value);
  if (issues.length)
    throw new Error(`The frozen publication manifest is invalid: ${issues.join('; ')}`);
  return value as EvidenceManifest;
}

/** Refuse changed trace/claims/timeline bytes before any selected media is uploaded. */
export async function verifyFrozenPublicationEvidence(
  run: Run,
  inventory: readonly ArtifactRef[],
  selectedEvidenceKeys: readonly string[],
): Promise<void> {
  await verifyReadyGateSelectedEvidenceFiles(run, { evidenceManifest: [...inventory] }, [
    ...selectedEvidenceKeys,
  ]);
  await readFrozenPublicationManifest(run, inventory);
  const media = selectedEvidenceKeys.filter(isUploadableMediaPath).flatMap((key) => {
    const selected = resolveSelectedEvidenceRef(key, [...inventory]);
    return selected ? [selected.path] : [];
  });
  if (!media.length) return;
  const roots = recordedEvidenceRoots(inventory, media);
  if (!roots.length) return; // Legacy media stays untimed, without invented execution identity.
  const selectedRecordedMedia = media.filter((key) =>
    roots.some((root) => key.startsWith(`${root}/`)),
  );
  const sources = await readFrozenRecordedEvidenceSources(run, inventory, selectedRecordedMedia);
  for (const source of sources) {
    const issues = validateRecordedEvidencePackage(source.input).findings.filter(
      (finding) => finding.severity === 'error',
    );
    if (issues.length)
      throw new Error(
        `Frozen publication recipe is invalid: ${issues.map((issue) => issue.message).join('; ')}`,
      );
  }
}
