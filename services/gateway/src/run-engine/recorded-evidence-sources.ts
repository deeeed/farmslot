import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { validateRecordedEvidencePackage } from '@farmslot/adapter-sdk/evidence';
import {
  type ArtifactRef,
  digestRecipeDocument,
  isRecord,
  type ReadyGatePrPackage,
  type RecordedEvidencePackageInput,
  RecordedEvidenceReadError,
  type Run,
  type RunArtifactBundleRef,
  sanitizeLatestValidRecipeRunPointer,
} from '@farmslot/protocol';

import { parseQaResult } from '../qa/completion.js';
import {
  resolveSelectedEvidenceRef,
  verifyReadyGatePackageHash,
  verifyReadyGateSelectedEvidenceFiles,
} from '../run-completion/ready-gate-package.js';
import {
  readRetainedEvidencePackage,
  readRetainedRunText,
  retainedRunBundleRef,
  retainedRunTaskDirectory,
} from '../run-completion/retained-artifacts.js';

export interface RecordedEvidenceSource {
  input: RecordedEvidencePackageInput;
  artifactPrefix: string;
}

export interface RecordedVisualReviewSource {
  snapshotIdentity: string;
  decisionId?: string;
  sources: RecordedEvidenceSource[];
}

function visualReviewDecision(run: Run, decisionId?: string) {
  return decisionId
    ? run.decisions.find(({ id }) => id === decisionId)
    : run.decisions
        .slice()
        .reverse()
        .find((candidate) =>
          candidate.payload?.kind === 'ready' && candidate.payload.prPackage
            ? candidate.payload.prPackage.packageHash === run.engineState?.publishGate?.packageHash
            : candidate.payload?.kind === 'output-review' &&
              candidate.payload.manifestDigest === run.output?.manifestDigest,
        );
}

/** Pure metadata fence, usable inside the serialized write after all async reads. */
export function visualReviewSnapshotIdentity(run: Run, decisionId?: string): string {
  const decision = visualReviewDecision(run, decisionId);
  const captured =
    decision?.payload?.kind === 'ready'
      ? decision.payload.prPackage?.packageHash
      : run.output?.manifestDigest;
  if (!captured || (decisionId && !decision))
    throw new Error('The selected captured evidence review is unavailable.');
  return digestRecipeDocument({
    captured,
    decisionId: decision?.id,
    taskFile: run.taskFile,
    ...(decision?.payload?.kind === 'ready'
      ? {}
      : {
          reportPath: run.output?.reportPath,
          ...(run.output?.artifactBundle
            ? { bundleDigest: run.output.artifactBundle.bundleDigest }
            : {}),
          inventory: run.output?.artifactManifest,
          captureError: run.output?.captureError,
        }),
    judgments: run.visualJudgmentReceipts?.map(({ id }) => id) ?? [],
  });
}

/** Human meaning is bound to an existing captured selection, including retained output. */
export async function readVisualReviewSource(
  run: Run,
  decisionId?: string,
): Promise<RecordedVisualReviewSource> {
  const decision = visualReviewDecision(run, decisionId);
  const snapshotIdentity = visualReviewSnapshotIdentity(run, decisionId);
  let sources: RecordedEvidenceSource[];
  if (decision?.payload?.kind === 'ready' && decision.payload.prPackage) {
    sources = await readGateRecordedEvidenceSources(run, decision.payload.prPackage);
  } else {
    const output = run.output;
    if (!output || output.captureError || !run.taskFile)
      throw new Error('A captured evidence selection is required for visual review.');
    if (decisionId && (!decision || decision.payload?.kind !== 'output-review'))
      throw new Error('The selected captured output review is unavailable.');
    if (
      decision?.payload?.kind === 'output-review' &&
      (decision.payload.manifestDigest !== output.manifestDigest ||
        decision.payload.reportPath !== output.reportPath)
    )
      throw new Error('The captured output review changed.');
    let inventory = output.artifactManifest;
    if (run.flowType === 'qa') {
      const indexPath = 'artifacts/qa-result.json';
      await verifyReadyGateSelectedEvidenceFiles(
        run,
        { evidenceManifest: inventory, artifactBundle: output.artifactBundle },
        [indexPath],
      );
      const value: unknown = JSON.parse(
        await readRetainedRunText(run, indexPath, output.artifactBundle),
      );
      const head =
        run.qaSource?.headSha ??
        run.prWork?.headSha ??
        (isRecord(value) && isRecord(value.source) && typeof value.source.headSha === 'string'
          ? value.source.headSha
          : '');
      const result = parseQaResult(value, run, head);
      inventory = inventory.filter((file) =>
        Object.values(result.packages).some((root) => file.path.startsWith(`artifacts/${root}/`)),
      );
    }
    sources = await readFrozenRecordedEvidenceSources(run, inventory, [], output.artifactBundle);
  }
  if (snapshotIdentity !== visualReviewSnapshotIdentity(run, decisionId))
    throw new Error('Captured visual review changed while its evidence was read.');
  return {
    snapshotIdentity,
    decisionId: decision?.id,
    sources,
  };
}

/** Media belongs to its nearest retained execution root, not an unrelated prior attempt. */
export function recordedEvidenceRoots(
  inventory: readonly ArtifactRef[],
  selectedEvidenceKeys: readonly string[] = [],
): string[] {
  const roots = [
    ...new Set(
      inventory
        .filter(
          (file) =>
            path.posix.basename(file.path) === 'summary.json' &&
            !file.path.split('/').includes('comparison-dependencies'),
        )
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
    preparedPackage.artifactBundle,
    preparedPackage.headSha ?? null,
  );
  if (!sources.length) throw new Error('The gate package has no retained recipe evidence closure.');
  for (const source of sources) {
    const mismatch = validateRecordedEvidencePackage(
      source.input,
      preparedPackage.reviewSnapshot,
    ).findings.find((finding) => finding.code === 'comparison-source-mismatch');
    if (mismatch)
      throw new Error(
        `comparison-source-mismatch: ${mismatch.path}: ${mismatch.message}. Refresh the gate package or select another capture.`,
      );
  }
  return sources;
}

/** Publication preparation and consumption share the same frozen attempt selection. */
export async function readFrozenPublicationRecipeSources(
  run: Run,
  inventory: readonly ArtifactRef[],
  selectedKeys: readonly string[] = [],
  bundleRef?: RunArtifactBundleRef,
  headSha?: string | null,
): Promise<RecordedEvidenceSource[]> {
  const contractVersion = run.recordedEvidenceContractVersion ?? 0;
  if (contractVersion !== 0 && contractVersion !== 1)
    throw new RecordedEvidenceReadError(
      'evidence-contract-unsupported',
      'The recorded run evidence contract is unsupported.',
    );
  const pointerPath = 'artifacts/latest-valid-recipe-run.json';
  if (inventory.some((artifact) => artifact.path === pointerPath)) {
    await verifyReadyGateSelectedEvidenceFiles(
      run,
      { evidenceManifest: [...inventory], artifactBundle: bundleRef },
      [pointerPath],
    );
    if (!run.taskFile) throw new Error('The frozen evidence has no retained task directory.');
    const pointer = sanitizeLatestValidRecipeRunPointer(
      JSON.parse(await readRetainedRunText(run, pointerPath, bundleRef)),
    );
    if (!pointer)
      throw new RecordedEvidenceReadError(
        'evidence-selection-invalid',
        'The frozen selected recipe attempt pointer is invalid.',
      );
    const prefix = `artifacts/${pointer.relativeArtifactRoot}/`;
    const roots = recordedEvidenceRoots(inventory);
    const external: string[] = [];
    for (const key of selectedKeys) {
      const selected = resolveSelectedEvidenceRef(key, [...inventory]);
      if (
        selected &&
        roots.some((root) => selected.path.startsWith(`${root}/`)) &&
        !selected.path.startsWith(prefix)
      )
        external.push(selected.path);
    }
    if (external.length) {
      const { readFrozenPublicationManifest } =
        await import('../run-completion/recorded-publication-evidence.js');
      const {
        assertPublicationManifestOwnership,
        filterEvidenceManifestBySelection,
        publicationBaselineContext,
      } = await import('../run-completion/publication-artifacts.js');
      const manifest = await readFrozenPublicationManifest(run, inventory, bundleRef);
      if (!manifest)
        throw new RecordedEvidenceReadError(
          'evidence-selection-invalid',
          'The publication has no frozen additional-evidence declaration.',
        );
      const additionalRoots = await assertPublicationManifestOwnership(
        filterEvidenceManifestBySelection(manifest, external),
        pointer.relativeArtifactRoot,
        path.join(await retainedRunTaskDirectory(run, bundleRef), 'artifacts'),
        undefined,
        { ...publicationBaselineContext(run, [...inventory]), headSha },
      );
      if (
        external.some(
          (file) => !additionalRoots.some((root) => file.startsWith(`artifacts/${root}/`)),
        )
      )
        throw new RecordedEvidenceReadError(
          'evidence-selection-invalid',
          'The publication selects an undeclared recipe attempt.',
        );
      const additional = await readFrozenRecordedEvidenceSources(
        run,
        inventory,
        external,
        bundleRef,
      );
      for (const source of additional) {
        if (validateRecordedEvidencePackage(source.input).status !== 'valid')
          throw new RecordedEvidenceReadError(
            'evidence-package-unverifiable',
            'The frozen additional-evidence package is invalid.',
          );
      }
    }
    return readFrozenRecordedEvidenceSources(
      run,
      inventory.filter((artifact) => artifact.path.startsWith(prefix)),
      [],
      bundleRef,
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
      [],
      bundleRef,
    );
  }
  if (!recordedEvidenceRoots(inventory, selectedKeys).length) return [];
  return readFrozenRecordedEvidenceSources(run, inventory, selectedKeys, bundleRef);
}

/** One closure reader for the existing publication inventory and QA output snapshot. */
export async function readFrozenRecordedEvidenceSources(
  run: Run,
  evidenceManifest: readonly ArtifactRef[],
  selectedEvidenceKeys: readonly string[] = [],
  bundleRef?: RunArtifactBundleRef,
): Promise<RecordedEvidenceSource[]> {
  if (!run.taskFile) throw new Error('The frozen evidence has no retained task directory.');
  const ref = bundleRef ?? retainedRunBundleRef(run);
  const taskDir = await retainedRunTaskDirectory(run, ref);
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
    const result = await readRetainedEvidencePackage(run, root, ref);
    const failed = result.checks.filter((check) => check.status === 'fail');
    if (failed.length) throw new Error(failed.map((check) => check.message).join(' '));
    // Every file the owner reader consumed must match the inventory frozen at
    // preparation. A changed invocation, trace or judgment needs a package refresh.
    const mismatch = recordedEvidenceInventoryMismatch(result.input, root, inventory);
    if (mismatch)
      throw new Error(`Evidence closure is missing or changed in the gate package: ${mismatch}`);
    inputs.push({ input: result.input, artifactPrefix: `${root}/` });
  }
  return inputs;
}

/** Shared byte qualification for a reader result and its retained comparison revision. */
export function recordedEvidenceInventoryMismatch(
  input: RecordedEvidencePackageInput,
  root: string,
  inventory: ReadonlyMap<string, string | undefined>,
): string | undefined {
  for (const file of input.artifactPaths ?? []) {
    const key = path.posix.join(root, file);
    const expected = inventory.get(key);
    const actual = input.artifactDigests[file];
    if (!expected || expected.replace(/^sha256:/u, '') !== actual?.replace(/^sha256:/u, ''))
      return key;
  }
  return undefined;
}
