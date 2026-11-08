import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  type EvalBlindTrial,
  type FamilyObservabilityArtifact,
  isEvalProofInput,
  isRecord,
  type Run,
  type RunArtifactBundleRef,
} from '@farmslot/protocol';
import { readRetainedRunBundle } from '@farmslot/run-bundle';

import { sha256File } from '../core/file-hash.js';
import { runBundleStore } from '../run-completion/retained-artifacts.js';
import { atomicWriteTextFile } from '../run-engine/diff-artifact-utils.js';

import { MAX_RESULT_PACKAGE_ARTIFACT_SCAN_FILES, sha256Text } from './package-store.js';

type ProofPackage = NonNullable<NonNullable<EvalBlindTrial['firstOutput']>['proofPackage']>;

/** Reuse the captured inventory, including media retained outside the worker mirror. */
async function proofInventory(run: Run) {
  const ref = run.output?.artifactBundle ?? run.artifactBundle;
  if (!ref) {
    const { scanResultPackageArtifacts } = await import('./package-store.js');
    return {
      artifacts: await scanResultPackageArtifacts(path.dirname(run.taskFile!), run, true),
      missing: [],
    };
  }
  const bundle = await readRetainedRunBundle(await runBundleStore(), ref, run.id);
  const prefix = `tasks/${ref.taskKey}/artifacts/`;
  const artifacts: FamilyObservabilityArtifact[] = Object.entries(bundle.manifest.entries)
    .filter(([file]) => file.startsWith(prefix))
    .map(([file, entry]) => ({
      runId: run.id,
      familyId: run.familyId,
      path: file.slice(`tasks/${ref.taskKey}/`.length),
      purpose: 'proof-output',
      source: 'task-artifact',
      sha256: entry.sha256,
      sizeBytes: entry.bytes,
    }));
  if (artifacts.length > MAX_RESULT_PACKAGE_ARTIFACT_SCAN_FILES)
    throw new Error('Proof artifact inventory exceeds its bounded manifest');
  return { artifacts, bundle: ref, missing: bundle.manifest.missingData ?? [] };
}

/** The product diff can be empty: the bounded, hashed task evidence is the output. */
export async function freezeProofOutput(run: Run): Promise<ProofPackage | undefined> {
  const link = run.engineState?.evalExperiment;
  const proof = link?.blind?.proof;
  if (!proof || !run.taskFile) return undefined;
  const inventory = await proofInventory(run);
  const text = JSON.stringify({
    version: 1,
    runId: run.id,
    proof,
    ...inventory,
    missing: [
      ...inventory.missing,
      ...(inventory.artifacts.some(({ path: file }) => file === 'artifacts/qa-result.json')
        ? []
        : ['artifacts/qa-result.json']),
    ],
  });
  const file = path.join(path.dirname(link.packagePath), 'first-output.proof.json');
  try {
    if ((await readFile(file, 'utf8')) !== text)
      throw new Error('Frozen proof output already exists with different evidence');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    await atomicWriteTextFile(file, text);
  }
  return { path: file, sha256: sha256Text(text) };
}

function bundleRef(value: unknown): RunArtifactBundleRef {
  if (
    !isRecord(value) ||
    typeof value.storeId !== 'string' ||
    typeof value.bundleDigest !== 'string' ||
    typeof value.taskKey !== 'string' ||
    typeof value.manifestDigest !== 'string'
  )
    throw new Error('Frozen proof bundle reference is invalid');
  return {
    storeId: value.storeId,
    bundleDigest: value.bundleDigest,
    taskKey: value.taskKey,
    manifestDigest: value.manifestDigest,
  };
}

export async function readProofOutput(
  run: Run,
  frozen = run.engineState?.evalExperiment?.blind?.firstOutput?.proofPackage,
): Promise<string | undefined> {
  const proof = run.engineState?.evalExperiment?.blind?.proof;
  if (!proof) return undefined;
  if (!frozen || !run.taskFile) throw new Error('Frozen proof output is missing');
  const text = await readFile(frozen.path, 'utf8');
  const value: unknown = JSON.parse(text);
  if (
    sha256Text(text) !== frozen.sha256 ||
    !isRecord(value) ||
    value.version !== 1 ||
    value.runId !== run.id ||
    !isEvalProofInput(value.proof) ||
    !isDeepStrictEqual(value.proof, proof) ||
    !Array.isArray(value.artifacts)
  )
    throw new Error('Frozen proof package or implementation identity changed');
  const bundle =
    value.bundle === undefined
      ? undefined
      : await readRetainedRunBundle(await runBundleStore(), bundleRef(value.bundle), run.id);
  const root = await realpath(path.dirname(run.taskFile));
  // Verify exactly the frozen inventory. Later judge files are not worker output.
  for (const expected of value.artifacts) {
    if (
      !isRecord(expected) ||
      typeof expected.path !== 'string' ||
      !expected.path.startsWith('artifacts/') ||
      expected.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      expected.path.includes('\\')
    )
      throw new Error('Invalid proof artifact reference');
    const full = bundle
      ? (await bundle.resolveEntry(expected.path)).path
      : path.join(root, expected.path);
    const info = await lstat(full);
    if (
      !info.isFile() ||
      info.size !== expected.sizeBytes ||
      (!bundle && (await realpath(full)) !== full) ||
      (await sha256File(full)) !== expected.sha256
    )
      throw new Error(`Frozen proof artifact changed: ${expected.path}`);
  }
  return text;
}
