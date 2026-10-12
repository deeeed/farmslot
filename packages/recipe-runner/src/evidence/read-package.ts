import { readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  isRecord,
  type RecordedEvidencePackageInput,
  resolvedRecipeArtifactPath,
} from '@farmslot/protocol';

import { readRecipeCliJsonFileWithinRoot } from '../cli/support.js';
import { digestFileWithinRoot } from '../file-digest.js';

export interface RecordedEvidencePackageReadCheck {
  id: string;
  status: 'pass' | 'fail';
  message: string;
}

export interface RecordedEvidencePackageReadResult {
  input: RecordedEvidencePackageInput;
  /** Consumers must refuse failed reads as well as invalid package validation. */
  checks: RecordedEvidencePackageReadCheck[];
}

function addReadCheck(
  checks: RecordedEvidencePackageReadCheck[],
  id: string,
  status: RecordedEvidencePackageReadCheck['status'],
  message: string,
): void {
  checks.push({ id, status, message });
}

/** Trusted host transport; names and digests must describe the same retained root. */
export interface RecordedEvidencePackageReadIO {
  listPaths(): Promise<string[]>;
  readJson(relativePath: string): Promise<unknown>;
  digestFile(relativePath: string): Promise<string>;
}

async function readArtifactJsonIfPresent(
  io: RecordedEvidencePackageReadIO,
  relativePath: string,
): Promise<{ value?: unknown; error?: string }> {
  try {
    return { value: await io.readJson(relativePath) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function listRelativeArtifactFiles(root: string): Promise<string[]> {
  const output: string[] = [];

  async function visit(relativeDir: string): Promise<void> {
    const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await visit(relativePath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        output.push(relativePath.split(path.sep).join('/'));
      }
    }
  }

  await visit('');
  return output.sort();
}

/** Read retained files and hash actual bytes before canonical package validation. */
export async function readRecordedEvidencePackage(
  artifactDir: string,
  io: RecordedEvidencePackageReadIO = {
    listPaths: () => listRelativeArtifactFiles(artifactDir),
    readJson: (relativePath) => readRecipeCliJsonFileWithinRoot(artifactDir, relativePath),
    digestFile: (relativePath) => digestFileWithinRoot(artifactDir, relativePath),
  },
): Promise<RecordedEvidencePackageReadResult> {
  const checks: RecordedEvidencePackageReadCheck[] = [];
  const availablePaths = await io.listPaths();
  const artifactPathSet = new Set(availablePaths);
  const consumedPaths = new Set(['artifact-manifest.json']);
  const reads = {
    summary: await readArtifactJsonIfPresent(io, 'summary.json'),
    trace: await readArtifactJsonIfPresent(io, 'trace.json'),
    manifest: await readArtifactJsonIfPresent(io, 'artifact-manifest.json'),
    recipe: artifactPathSet.has('recipe.json')
      ? await readArtifactJsonIfPresent(io, 'recipe.json')
      : { value: undefined },
    invocation: artifactPathSet.has('recipe-invocation.json')
      ? await readArtifactJsonIfPresent(io, 'recipe-invocation.json')
      : { value: undefined },
    claims: artifactPathSet.has('acceptance-status.json')
      ? await readArtifactJsonIfPresent(io, 'acceptance-status.json')
      : { value: undefined },
    recipeResolution: artifactPathSet.has('recipe-resolution.json')
      ? await readArtifactJsonIfPresent(io, 'recipe-resolution.json')
      : { value: undefined },
  };

  for (const [requiredPath, read] of [
    ['summary.json', reads.summary],
    ['trace.json', reads.trace],
    ['artifact-manifest.json', reads.manifest],
  ] as const) {
    consumedPaths.add(requiredPath);
    addReadCheck(
      checks,
      `file.${requiredPath}`,
      artifactPathSet.has(requiredPath) && !read.error ? 'pass' : 'fail',
      !artifactPathSet.has(requiredPath)
        ? `Missing required Recipe v1 artifact ${requiredPath}.`
        : read.error
          ? read.error
          : `${requiredPath} exists.`,
    );
  }

  // These files are optional only when the package omits recipe.json. A present but
  // unreadable file always fails.
  for (const optionalPath of ['recipe.json', 'recipe-resolution.json'] as const) {
    consumedPaths.add(optionalPath);
    if (!artifactPathSet.has(optionalPath)) continue;
    const read = optionalPath === 'recipe.json' ? reads.recipe : reads.recipeResolution;
    addReadCheck(
      checks,
      `file.${optionalPath}`,
      read.error ? 'fail' : 'pass',
      read.error ?? `${optionalPath} is readable.`,
    );
  }

  for (const [file, read] of [
    ['recipe-invocation.json', reads.invocation],
    ['acceptance-status.json', reads.claims],
  ] as const) {
    consumedPaths.add(file);
    if (artifactPathSet.has(file))
      addReadCheck(
        checks,
        `file.${file}`,
        read.error ? 'fail' : 'pass',
        read.error ?? `${file} is readable.`,
      );
  }

  const summary = reads.summary.value;
  const trace = reads.trace.value;
  const manifest = reads.manifest.value;
  const recipe = reads.recipe.value;
  const recipeResolution = reads.recipeResolution.value;
  const resolvedRecipes: Record<string, unknown> = {};
  if (isRecord(recipeResolution) && Array.isArray(recipeResolution.dependencies)) {
    for (const dependency of recipeResolution.dependencies) {
      if (!isRecord(dependency)) continue;
      const artifact = resolvedRecipeArtifactPath(dependency.digest);
      if (!artifact) continue;
      consumedPaths.add(artifact);
      const read = await readArtifactJsonIfPresent(io, artifact);
      if (read.value !== undefined) resolvedRecipes[String(dependency.digest)] = read.value;
      if (read.error) {
        addReadCheck(checks, `file.${artifact}`, 'fail', read.error);
      }
    }
  }
  const timelines: Record<string, unknown> = {};
  const declaredTimelines = new Set<string>();
  const indexed = isRecord(manifest) && Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const claims = reads.claims.value;
  if (artifactPathSet.has('acceptance-status.json') && !isRecord(claims)) {
    addReadCheck(
      checks,
      'claims.shape',
      'fail',
      'The retained claim package must be a JSON object.',
    );
  }
  const segments =
    isRecord(claims) && isRecord(claims.recording) && Array.isArray(claims.recording.segments)
      ? claims.recording.segments
      : [];
  for (const entry of [...indexed, ...segments]) {
    if (isRecord(entry) && typeof entry.path === 'string') consumedPaths.add(entry.path);
    if (isRecord(entry) && typeof entry.timelinePath === 'string')
      declaredTimelines.add(entry.timelinePath);
  }
  for (const file of declaredTimelines) {
    consumedPaths.add(file);
    const read = await readArtifactJsonIfPresent(io, file);
    if (read.value !== undefined) timelines[file] = read.value;
    addReadCheck(
      checks,
      `file.${file}`,
      read.error || read.value === undefined ? 'fail' : 'pass',
      read.error ??
        (read.value === undefined ? `Missing declared timeline ${file}.` : `${file} is readable.`),
    );
  }
  // A task-bound execution may share artifacts/ with gateway reports/packages.
  // Its manifest and consumed metadata, not every sibling file, own its closure.
  const artifactPaths = availablePaths.filter((file) => consumedPaths.has(file));
  const artifactDigests: Record<string, string> = {};
  await Promise.all(
    artifactPaths.map(async (file) => {
      try {
        artifactDigests[file] = await io.digestFile(file);
      } catch (error) {
        addReadCheck(
          checks,
          `digest.${file}`,
          'fail',
          error instanceof Error ? error.message : String(error),
        );
      }
    }),
  );
  return {
    input: {
      recipe,
      trace,
      summary,
      manifest,
      artifactPaths,
      recipeResolution,
      resolvedRecipes,
      invocation: reads.invocation.value,
      claims: claims as RecordedEvidencePackageInput['claims'],
      timelines: timelines as RecordedEvidencePackageInput['timelines'],
      artifactDigests,
    },
    checks,
  };
}
