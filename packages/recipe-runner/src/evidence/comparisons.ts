import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  isRecord,
  type RecipeComparisonDependency,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
} from '@farmslot/protocol';

import { copyFileWithinRoots, statFileWithinRoot } from '../core/path.js';

import { validateRecordedEvidencePackage } from './package.js';
import { readRecordedEvidencePackage } from './read-package.js';

const execute = promisify(execFile);

/** Observe the checkout, never a SHA supplied in recipe parameters. */
export async function observeRecipeCaptureSource(projectRoot: string): Promise<{
  sourceCommit?: string;
  sourceDirty?: boolean;
}> {
  try {
    const head = await execute('git', ['rev-parse', 'HEAD'], { cwd: projectRoot });
    const status = await execute(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=none'],
      { cwd: projectRoot },
    );
    return { sourceCommit: head.stdout.trim(), sourceDirty: Boolean(status.stdout.trim()) };
  } catch (error) {
    // Standalone captures outside a checkout remain viewable with unknown source.
    if (isRecord(error) && error.code === 128) return {};
    throw error;
  }
}

/** Copy checked closure bytes once; original executions and claims never change. */
export async function retainRecipeComparisons(
  roots: readonly string[],
  artifactsDir: string,
  headRecipeRunId: string,
  maxBytes: number,
): Promise<{
  references: RecipeComparisonDependency[];
  inputs: RecordedEvidencePackageInput['comparisonDependencies'];
  retainedBytes: number;
}> {
  let retainedBytes = 0;
  const references: RecipeComparisonDependency[] = [];
  const inputs: { artifactRoot: string; input: RecordedEvidencePackageInput }[] = [];
  for (const root of roots) {
    const read = await readRecordedEvidencePackage(root);
    const validation = validateRecordedEvidencePackage(read.input);
    if (
      read.checks.some(({ status }) => status === 'fail') ||
      validation.status !== 'valid' ||
      !read.input.claims
    )
      throw new Error('Comparison dependency is unreadable or invalid.');
    const recipeRunId = read.input.claims.recipeRunId;
    if (
      recipeRunId === headRecipeRunId ||
      !/^[A-Za-z0-9._-]+$/u.test(recipeRunId) ||
      ['.', '..'].includes(recipeRunId)
    )
      throw new Error('Comparison dependency has an invalid or cyclic execution identity.');
    const closureIdentity = recordedEvidenceClosureIdentity(read.input);
    const previous = references.find((entry) => entry.recipeRunId === recipeRunId);
    if (previous) {
      if (previous.closureIdentity !== closureIdentity)
        throw new Error('Comparison copies of the same execution have different bytes.');
      continue;
    }
    const containsHead = (input: RecordedEvidencePackageInput): boolean =>
      input.claims?.recipeRunId === headRecipeRunId ||
      (input.comparisonDependencies ?? []).some((child) => containsHead(child.input));
    if (containsHead(read.input))
      throw new Error('Comparison dependency contains the selected execution.');
    const artifactRoot = `comparison-dependencies/${recipeRunId}`;
    for (const file of read.input.artifactPaths ?? []) {
      retainedBytes += (await statFileWithinRoot(root, file)).size;
      if (retainedBytes >= maxBytes)
        throw new Error('Comparison dependencies exceed the execution byte budget.');
      await copyFileWithinRoots(root, file, artifactsDir, `${artifactRoot}/${file}`);
    }
    const copied = await readRecordedEvidencePackage(`${artifactsDir}/${artifactRoot}`);
    if (
      copied.checks.some(({ status }) => status === 'fail') ||
      recordedEvidenceClosureIdentity(copied.input) !== closureIdentity
    )
      throw new Error('Comparison dependency changed during retention.');
    references.push({ artifactRoot, recipeRunId, closureIdentity });
    inputs.push({ artifactRoot, input: copied.input });
  }
  return { references, inputs, retainedBytes };
}

export async function refreshRetainedComparisons(
  references: readonly RecipeComparisonDependency[],
  artifactsDir: string,
): Promise<NonNullable<RecordedEvidencePackageInput['comparisonDependencies']>> {
  const inputs: NonNullable<RecordedEvidencePackageInput['comparisonDependencies']>[number][] = [];
  for (const reference of references) {
    const read = await readRecordedEvidencePackage(`${artifactsDir}/${reference.artifactRoot}`);
    if (
      read.checks.some((check) => check.status === 'fail') ||
      validateRecordedEvidencePackage(read.input).status !== 'valid' ||
      recordedEvidenceClosureIdentity(read.input) !== reference.closureIdentity
    )
      throw new Error('A retained comparison dependency changed before finalization.');
    inputs.push({ artifactRoot: reference.artifactRoot, input: read.input });
  }
  return inputs;
}
