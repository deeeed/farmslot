import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { readRecordedEvidencePackage } from '@farmslot/adapter-sdk';
import type {
  ArtifactRef,
  ReadyGatePrPackage,
  RecordedEvidencePackageInput,
  Run,
} from '@farmslot/protocol';

import {
  resolveSelectedEvidenceRef,
  verifyReadyGatePackageHash,
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
  return readFrozenRecordedEvidenceSources(
    run,
    preparedPackage.evidenceManifest ?? [],
    preparedPackage.selectedEvidenceKeys ?? [],
  );
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
