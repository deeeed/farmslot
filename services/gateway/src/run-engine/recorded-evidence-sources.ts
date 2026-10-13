import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { readRecordedEvidencePackage } from '@farmslot/adapter-sdk';
import {
  type ArtifactRef,
  type ReadyGatePrPackage,
  type RecordedEvidencePackageInput,
  RecordedEvidenceReadError,
  type Run,
  sanitizeLatestValidRecipeRunPointer,
} from '@farmslot/protocol';

import {
  resolveSelectedEvidenceRef,
  verifyReadyGatePackageHash,
  verifyReadyGateSelectedEvidenceFiles,
} from '../run-completion/ready-gate-package.js';

export interface RecordedEvidenceSource {
  input: RecordedEvidencePackageInput;
  artifactPrefix: string;
}

/** Media belongs to its nearest retained execution root, not an unrelated prior attempt. */
export function recordedEvidenceRoots(
  inventory: readonly ArtifactRef[],
  selectedEvidenceKeys: readonly string[] = [],
): string[] {
  const roots = [
    ...new Set(
      inventory
        .filter((file) => path.posix.basename(file.path) === 'summary.json')
        .map((file) => path.posix.dirname(file.path)),
    ),
  ];
  if (!selectedEvidenceKeys.length) return roots;
  return [
    ...new Set(
      selectedEvidenceKeys.flatMap((key) => {
        const selected = resolveSelectedEvidenceRef(key, [...inventory]);
        const root =
          selected &&
          roots
            .filter((root) => selected.path.startsWith(`${root}/`))
            .sort((a, b) => b.length - a.length)[0];
        return root ? [root] : [];
      }),
    ),
  ];
}

/** The existing package inventory selects and binds the closure; no latest-path fallback. */
export async function readGateRecordedEvidenceSources(
  run: Run,
  preparedPackage: ReadyGatePrPackage | null,
): Promise<RecordedEvidenceSource[]> {
  if (!preparedPackage)
    throw new Error('A prepared evidence package is required. Refresh the gate package.');
  verifyReadyGatePackageHash(preparedPackage);
  const sources = await readFrozenPublicationRecipeSources(
    run,
    preparedPackage.evidenceManifest ?? [],
    preparedPackage.selectedEvidenceKeys ?? [],
  );
  if (!sources.length) throw new Error('The gate package has no retained recipe evidence closure.');
  return sources;
}

/** Publication preparation and consumption share the same frozen attempt selection. */
export async function readFrozenPublicationRecipeSources(
  run: Run,
  inventory: readonly ArtifactRef[],
  selectedKeys: readonly string[] = [],
): Promise<RecordedEvidenceSource[]> {
  const contractVersion = run.recordedEvidenceContractVersion ?? 0;
  if (contractVersion !== 0 && contractVersion !== 1)
    throw new RecordedEvidenceReadError(
      'evidence-contract-unsupported',
      'The recorded run evidence contract is unsupported.',
    );
  const pointerPath = 'artifacts/latest-valid-recipe-run.json';
  if (inventory.some((artifact) => artifact.path === pointerPath)) {
    await verifyReadyGateSelectedEvidenceFiles(run, { evidenceManifest: [...inventory] }, [
      pointerPath,
    ]);
    if (!run.taskFile) throw new Error('The frozen evidence has no retained task directory.');
    const pointer = sanitizeLatestValidRecipeRunPointer(
      JSON.parse(await readFile(path.join(path.dirname(run.taskFile), pointerPath), 'utf8')),
    );
    if (!pointer)
      throw new RecordedEvidenceReadError(
        'evidence-selection-invalid',
        'The frozen selected recipe attempt pointer is invalid.',
      );
    const prefix = `artifacts/${pointer.relativeArtifactRoot}/`;
    const roots = recordedEvidenceRoots(inventory);
    for (const key of selectedKeys) {
      const selected = resolveSelectedEvidenceRef(key, [...inventory]);
      if (
        selected &&
        roots.some((root) => selected.path.startsWith(`${root}/`)) &&
        !selected.path.startsWith(prefix)
      )
        throw new RecordedEvidenceReadError(
          'evidence-selection-invalid',
          'The publication selects evidence from another recipe attempt.',
        );
    }
    return readFrozenRecordedEvidenceSources(
      run,
      inventory.filter((artifact) => artifact.path.startsWith(prefix)),
    );
  }
  if (contractVersion === 1) {
    const sources = inventory.filter(
      (artifact) =>
        artifact.purpose === 'evidence-manifest-source' &&
        path.posix.basename(artifact.path) === 'evidence-manifest.json',
    );
    const root = sources.length === 1 ? path.posix.dirname(sources[0]!.path) : undefined;
    if (!root || !inventory.some((artifact) => artifact.path === `${root}/recipe-invocation.json`))
      throw new RecordedEvidenceReadError(
        'evidence-selection-missing',
        'The gate package has no frozen selected recipe attempt. Refresh the gate package or re-run the recipe.',
      );
    return readFrozenRecordedEvidenceSources(
      run,
      inventory.filter((artifact) => artifact.path.startsWith(`${root}/`)),
    );
  }
  if (!recordedEvidenceRoots(inventory, selectedKeys).length) return [];
  return readFrozenRecordedEvidenceSources(run, inventory, selectedKeys);
}

/** One closure reader for the existing publication inventory and QA output snapshot. */
export async function readFrozenRecordedEvidenceSources(
  run: Run,
  evidenceManifest: readonly ArtifactRef[],
  selectedEvidenceKeys: readonly string[] = [],
): Promise<RecordedEvidenceSource[]> {
  if (!run.taskFile) throw new Error('The frozen evidence has no retained task directory.');
  const taskDir = await realpath(path.dirname(run.taskFile));
  const inventory = new Map(evidenceManifest.map((artifact) => [artifact.path, artifact.sha256]));
  const roots = recordedEvidenceRoots(evidenceManifest, selectedEvidenceKeys);
  if (!roots.length) throw new Error('The gate package has no retained recipe evidence closure.');
  for (const key of selectedEvidenceKeys) {
    const selected = resolveSelectedEvidenceRef(key, [...evidenceManifest]);
    if (!selected || !roots.some((root) => selected.path.startsWith(`${root}/`)))
      throw new Error(`Selected evidence has no retained recipe closure: ${key}`);
  }

  const inputs: RecordedEvidenceSource[] = [];
  for (const root of roots) {
    const directory = await realpath(path.resolve(taskDir, root));
    const relative = path.relative(taskDir, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('The retained evidence closure escapes the task directory.');
    const result = await readRecordedEvidencePackage(directory);
    const failed = result.checks.filter((check) => check.status === 'fail');
    if (failed.length) throw new Error(failed.map((check) => check.message).join(' '));
    // Every file the owner reader consumed must match the inventory frozen at
    // preparation. A changed invocation, trace or judgment needs a package refresh.
    for (const file of result.input.artifactPaths ?? []) {
      const expected = inventory.get(path.posix.join(root, file));
      const actual = result.input.artifactDigests[file];
      if (!expected || expected.replace(/^sha256:/u, '') !== actual?.replace(/^sha256:/u, ''))
        throw new Error(
          `Evidence closure is missing or changed in the gate package: ${root}/${file}`,
        );
    }
    inputs.push({ input: result.input, artifactPrefix: `${root}/` });
  }
  return inputs;
}
