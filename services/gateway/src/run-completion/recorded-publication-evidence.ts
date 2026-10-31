import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { readRecordedEvidencePackage } from '@farmslot/adapter-sdk';
import { validateRecordedEvidencePackage } from '@farmslot/adapter-sdk/evidence';
import type { ArtifactRef, Run, RunArtifactBundleRef } from '@farmslot/protocol';

import {
  isGatewayOwnedArtifactPath,
  PUBLICATION_SELECTION_DIR,
} from '../core/artifact-copy-policy.js';
import {
  readFrozenPublicationRecipeSources,
  recordedEvidenceRoots,
} from '../run-engine/recorded-evidence-sources.js';

import { type EvidenceManifest, validateEvidenceManifest } from './evidence-manifest.js';
import { isUploadableMediaPath } from './evidence-paths.js';
import {
  type PublicationBaselineContext,
  resolvePublicationManifest,
} from './publication-artifacts.js';
import { assertPublicationTextSafe } from './publication-secrets.js';
import {
  resolveSelectedEvidenceRef,
  sha256Text,
  verifyReadyGateSelectedEvidenceFiles,
} from './ready-gate-package.js';
import { readRetainedRunText } from './retained-artifacts.js';

const SELECTION_MANIFEST_PATH = 'artifacts/evidence-manifest.json';

export type PublicationSelectionSource = 'capture' | 'retained';

function publicationSelection(manifest: EvidenceManifest): { text: string; artifact: ArtifactRef } {
  const text = JSON.stringify(manifest);
  const sha256 = sha256Text(text);
  return {
    text,
    artifact: {
      path: path.posix.join('artifacts', PUBLICATION_SELECTION_DIR, `${sha256}.json`),
      purpose: 'evidence-manifest',
      sizeBytes: Buffer.byteLength(text),
      sha256,
    },
  };
}

/** The capture writer registers this gateway-owned file before retaining the output. */
export async function writePublicationSelectionSnapshot(
  taskDir: string,
  manifest: EvidenceManifest,
): Promise<ArtifactRef> {
  const { text, artifact } = publicationSelection(manifest);
  const filename = path.join(taskDir, artifact.path);
  await mkdir(path.dirname(filename), { recursive: true });
  if (existsSync(filename)) {
    if ((await readFile(filename, 'utf8')) !== text)
      throw new Error('Frozen publication selection bytes changed.');
  } else {
    await writeFile(filename, text, { flag: 'wx' });
  }
  return artifact;
}

/** Freeze input bytes without making dependency files selectable publication media. */
export async function recordedPublicationDependencies(
  taskDir: string,
  artifacts: readonly ArtifactRef[],
  media: readonly ArtifactRef[],
  expectedManifest: EvidenceManifest | null | undefined,
  contractVersion = 1,
  baseline?: PublicationBaselineContext,
  selectionSource: PublicationSelectionSource = 'capture',
): Promise<ArtifactRef[]> {
  const source = await resolvePublicationManifest(
    taskDir,
    undefined,
    undefined,
    contractVersion,
    baseline,
  );
  const sourceRoot = source ? path.posix.dirname(source.sourcePath) : undefined;
  const selectedRoot = source?.selectedArtifactRoot
    ? `artifacts/${source.selectedArtifactRoot}`
    : sourceRoot &&
        artifacts.some((artifact) => artifact.path === `${sourceRoot}/recipe-invocation.json`)
      ? sourceRoot
      : undefined;
  if (!media.length && !selectedRoot) return [];
  const taskRoot = await realpath(taskDir);
  const entries = new Map<string, ArtifactRef>();
  const byPath = new Map(media.map((artifact) => [artifact.path, artifact]));
  const roots = selectedRoot
    ? [selectedRoot, ...(source?.additionalArtifactRoots ?? []).map((root) => `artifacts/${root}`)]
    : recordedEvidenceRoots(
        artifacts,
        media.map((artifact) => artifact.path),
      );
  for (const root of roots) {
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
    const isAdditional = source?.additionalArtifactRoots?.some(
      (entry) => root === `artifacts/${entry}`,
    );
    for (const file of input.artifactPaths ?? []) {
      const artifactPath = path.posix.join(root, file);
      if (
        isAdditional &&
        baseline?.inventory
          ?.find((entry) => entry.path === artifactPath)
          ?.sha256?.replace(/^sha256:/u, '') !==
          input.artifactDigests[file]?.replace(/^sha256:/u, '')
      )
        throw new Error(
          `Captured recipe closure is missing or changed in the run capture: ${artifactPath}`,
        );
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
  if (!source && expectedManifest)
    throw new Error('Publication selection changed while preparing its frozen package.');
  if (source) {
    if (!isDeepStrictEqual(source.manifest, expectedManifest))
      throw new Error('Publication selection changed while preparing its frozen package.');
    const sourceFiles = [
      { file: source.sourcePath, bytes: source.sourceBytes },
      ...(source.declarationSources ?? []),
    ];
    if (source.pointerPath && source.pointerBytes !== undefined)
      sourceFiles.push({ file: source.pointerPath, bytes: source.pointerBytes });
    for (const { file, bytes } of sourceFiles) {
      const filename = await realpath(path.resolve(taskRoot, file));
      const relative = path.relative(taskRoot, filename);
      if (relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error('Publication selection manifest escapes the task directory.');
      if ((await readFile(filename, 'utf8')) !== bytes)
        throw new Error('Publication selection changed while preparing its frozen package.');
      entries.set(file, {
        path: file,
        purpose: 'evidence-manifest-source',
        sha256: sha256Text(bytes),
        sizeBytes: Buffer.byteLength(bytes),
      });
    }
    const snapshot =
      selectionSource === 'capture'
        ? await writePublicationSelectionSnapshot(taskRoot, source.manifest)
        : publicationSelection(source.manifest).artifact;
    if (
      selectionSource === 'retained' &&
      !artifacts.some(
        (artifact) => artifact.path === snapshot.path && artifact.sha256 === snapshot.sha256,
      )
    )
      throw new Error(`Publication selection is not in the captured inventory: ${snapshot.path}`);
    entries.set(snapshot.path, snapshot);
  }
  return [...entries.values()];
}

/** A missing historical selection cannot be reconstructed from today's mutable manifest. */
export async function readFrozenPublicationManifest(
  run: Run,
  inventory: readonly ArtifactRef[],
  bundleRef?: RunArtifactBundleRef,
): Promise<EvidenceManifest | null> {
  const manifest =
    inventory.find(
      (artifact) =>
        artifact.path.startsWith(`artifacts/${PUBLICATION_SELECTION_DIR}/`) &&
        artifact.purpose === 'evidence-manifest',
    ) ?? inventory.find((artifact) => artifact.path === SELECTION_MANIFEST_PATH);
  if (!manifest) return null;
  if (!run.taskFile || !manifest.sha256)
    throw new Error('The frozen publication selection manifest has no retained byte identity.');
  await verifyReadyGateSelectedEvidenceFiles(
    run,
    { evidenceManifest: [...inventory], artifactBundle: bundleRef },
    [
      manifest.path,
      ...inventory
        .filter((artifact) => artifact.purpose === 'evidence-manifest-source')
        .map((artifact) => artifact.path),
    ],
  );
  const text = await readRetainedRunText(run, manifest.path, bundleRef);
  if (sha256Text(text) !== manifest.sha256.replace(/^sha256:/u, ''))
    throw new Error('The frozen publication selection manifest bytes changed.');
  const value: unknown = JSON.parse(text);
  const issues = validateEvidenceManifest(value);
  if (issues.length)
    throw new Error(`The frozen publication manifest is invalid: ${issues.join('; ')}`);
  return value as EvidenceManifest;
}

/** The selected evidence, after publication's secret scan of the selection itself. */
function scannedFrozenSelection(
  inventory: readonly ArtifactRef[],
  selectedEvidenceKeys: readonly string[],
): ArtifactRef[] {
  assertPublicationTextSafe(JSON.stringify(selectedEvidenceKeys));
  const selected = selectedEvidenceKeys.flatMap((key) => {
    const artifact = resolveSelectedEvidenceRef(key, [...inventory]);
    return artifact ? [artifact] : [];
  });
  assertPublicationTextSafe(JSON.stringify(selected));
  return selected;
}

interface FrozenPublicationTextClosure {
  sources: Awaited<ReturnType<typeof readFrozenPublicationRecipeSources>>;
  textEntries: ArtifactRef[];
}

/** The recipe sources of the selected recordings and the text publication carries with them. */
async function frozenPublicationTextClosure(
  run: Run,
  inventory: readonly ArtifactRef[],
  selected: readonly ArtifactRef[],
  bundleRef?: RunArtifactBundleRef,
  headSha?: string | null,
): Promise<FrozenPublicationTextClosure> {
  const media = selected
    .filter((artifact) => isUploadableMediaPath(artifact.path))
    .map(({ path }) => path);
  const roots = recordedEvidenceRoots(inventory, media);
  const selectedRecordedMedia = media.filter((key) =>
    roots.some((root) => key.startsWith(`${root}/`)),
  );
  const sources = await readFrozenPublicationRecipeSources(
    run,
    inventory,
    selectedRecordedMedia,
    bundleRef,
    headSha ?? null,
  );
  // This inventory is the frozen publication closure, not the task's historical
  // artifacts. Media pixels retain their existing visual-review requirements.
  // Additional recipe roots were validated above even though only the selected ledger
  // is returned as verdict authority.
  const textPrefixes = [
    ...new Set([
      ...sources.map(({ artifactPrefix }) => artifactPrefix),
      ...roots.map((root) => `${root}/`),
    ]),
  ];
  const textEntries = inventory.filter(
    (artifact) =>
      !isUploadableMediaPath(artifact.path) &&
      (artifact.purpose === 'evidence-manifest' ||
        artifact.purpose === 'evidence-manifest-source' ||
        artifact.path === SELECTION_MANIFEST_PATH ||
        textPrefixes.some((prefix) => artifact.path.startsWith(prefix))),
  );
  return { sources, textEntries };
}

async function scanFrozenPublicationText(
  run: Run,
  textEntries: readonly ArtifactRef[],
  bundleRef?: RunArtifactBundleRef,
): Promise<void> {
  // The canonical closure above and retained reader check the byte identities.
  // Its valid empty logs must not inherit the selected-media non-empty rule.
  for (const artifact of textEntries) {
    assertPublicationTextSafe(await readRetainedRunText(run, artifact.path, bundleRef));
  }
}

/**
 * Publication's secret scan of the frozen evidence it publishes, without its
 * byte verification. The publication gate runs it on the prepared package
 * (ADR-065 Amendment 9), so a package publication would refuse is never offered.
 */
export async function scanFrozenPublicationEvidence(
  run: Run,
  inventory: readonly ArtifactRef[],
  selectedEvidenceKeys: readonly string[],
  bundleRef?: RunArtifactBundleRef,
  headSha?: string,
): Promise<void> {
  if (!inventory.length && !selectedEvidenceKeys.length) return;
  const selected = scannedFrozenSelection(inventory, selectedEvidenceKeys);
  const { textEntries } = await frozenPublicationTextClosure(
    run,
    inventory,
    selected,
    bundleRef,
    headSha,
  );
  await scanFrozenPublicationText(run, textEntries, bundleRef);
}

/** Refuse changed trace/claims/timeline bytes before any selected media is uploaded. */
export async function verifyFrozenPublicationEvidence(
  run: Run,
  inventory: readonly ArtifactRef[],
  selectedEvidenceKeys: readonly string[],
  bundleRef?: RunArtifactBundleRef,
  headSha?: string,
): Promise<void> {
  if (!inventory.length && !selectedEvidenceKeys.length) return;
  const selected = scannedFrozenSelection(inventory, selectedEvidenceKeys);
  await verifyReadyGateSelectedEvidenceFiles(
    run,
    { evidenceManifest: [...inventory], artifactBundle: bundleRef },
    [...selectedEvidenceKeys],
  );
  await readFrozenPublicationManifest(run, inventory, bundleRef);
  const { sources, textEntries } = await frozenPublicationTextClosure(
    run,
    inventory,
    selected,
    bundleRef,
    headSha,
  );
  for (const source of sources) {
    const issues = validateRecordedEvidencePackage(source.input).findings.filter(
      (finding) => finding.severity === 'error',
    );
    if (issues.length)
      throw new Error(
        `Frozen publication recipe is invalid: ${issues.map((issue) => issue.message).join('; ')}`,
      );
  }
  await scanFrozenPublicationText(run, textEntries, bundleRef);
}
