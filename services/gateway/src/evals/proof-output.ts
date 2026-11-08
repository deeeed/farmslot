import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { type EvalBlindTrial, isEvalProofInput, isRecord, type Run } from '@farmslot/protocol';

import { atomicWriteTextFile } from '../run-engine/diff-artifact-utils.js';

import { sha256Text } from './package-store.js';

type ProofPackage = NonNullable<NonNullable<EvalBlindTrial['firstOutput']>['proofPackage']>;

/** The product diff can be empty: the bounded, hashed task evidence is the output. */
export async function freezeProofOutput(run: Run): Promise<ProofPackage | undefined> {
  const link = run.engineState?.evalExperiment;
  const proof = link?.blind?.proof;
  if (!proof || !run.taskFile) return undefined;
  const { scanResultPackageArtifacts } = await import('./package-store.js');
  const artifacts = await scanResultPackageArtifacts(path.dirname(run.taskFile), run, true);
  const text = JSON.stringify({
    version: 1,
    runId: run.id,
    proof,
    artifacts,
    missing: artifacts.some(({ path: file }) => file === 'artifacts/qa-result.json')
      ? []
      : ['artifacts/qa-result.json'],
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
  const { scanResultPackageArtifacts } = await import('./package-store.js');
  const artifacts = await scanResultPackageArtifacts(path.dirname(run.taskFile), run, true);
  for (const expected of value.artifacts) {
    if (!isRecord(expected) || typeof expected.path !== 'string')
      throw new Error('Invalid proof artifact reference');
    const actual = artifacts.find(({ path: file }) => file === expected.path);
    if (!actual || actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes)
      throw new Error(`Frozen proof artifact changed: ${expected.path}`);
  }
  return text;
}
