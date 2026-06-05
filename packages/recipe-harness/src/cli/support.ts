import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  mergeRecipeValidationResults,
  type RecipeValidationResult,
  validateArtifactManifestDocument,
  validateRecipeArtifactPackage,
  validateRecipeDocument,
  validateRecipeWithManifest,
} from '@farmslot/protocol';

interface RecipeValidationInputOptions {
  recipePath: string;
  actionManifestPath?: string;
  artifactManifestPath?: string;
  artifactDir?: string;
  baseDir?: string;
}

export function recipeCliBaseDir(): string {
  return process.env.INIT_CWD ?? process.cwd();
}

export function resolveRecipeCliPath(filePath: string, baseDir = recipeCliBaseDir()): string {
  return path.resolve(baseDir, filePath);
}

export function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got ${JSON.stringify(value)}.`);
  }
  return parsed;
}

export async function readRecipeCliJsonFile(
  filePath: string,
  baseDir = recipeCliBaseDir(),
): Promise<unknown> {
  const resolvedPath = resolveRecipeCliPath(filePath, baseDir);
  let text: string;
  try {
    text = await readFile(resolvedPath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read JSON from ${filePath}: ${message}`);
  }
  return parseRecipeCliJsonText(filePath, text);
}

async function readOptionalRecipeCliJsonFile(
  filePath: string,
  baseDir = recipeCliBaseDir(),
): Promise<unknown | undefined> {
  const resolvedPath = resolveRecipeCliPath(filePath, baseDir);
  let text: string;
  try {
    text = await readFile(resolvedPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read JSON from ${filePath}: ${message}`);
  }
  return parseRecipeCliJsonText(filePath, text);
}

function parseRecipeCliJsonText(filePath: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON from ${filePath}: ${message}`);
  }
}

export async function validateRecipeCliInput({
  recipePath,
  actionManifestPath,
  artifactManifestPath,
  artifactDir,
  baseDir = recipeCliBaseDir(),
}: RecipeValidationInputOptions): Promise<RecipeValidationResult> {
  const recipe = await readRecipeCliJsonFile(recipePath, baseDir);
  const results: RecipeValidationResult[] = [];

  if (actionManifestPath) {
    const actionManifest = await readRecipeCliJsonFile(actionManifestPath, baseDir);
    results.push(validateRecipeWithManifest(recipe, actionManifest));
  } else {
    results.push(validateRecipeDocument(recipe));
  }

  const artifactPaths = artifactDir
    ? await listRelativeRecipeCliFiles(resolveRecipeCliPath(artifactDir, baseDir))
    : undefined;
  const manifestPath =
    artifactManifestPath ??
    (artifactDir ? path.join(artifactDir, 'artifact-manifest.json') : undefined);

  let manifest: unknown;
  if (manifestPath) {
    manifest = artifactManifestPath
      ? await readRecipeCliJsonFile(manifestPath, baseDir)
      : await readOptionalRecipeCliJsonFile(manifestPath, baseDir);
    if (manifest !== undefined && !artifactDir) {
      results.push(
        validateArtifactManifestDocument(manifest, {
          recipe,
          artifactPaths,
        }),
      );
    }
  }

  if (artifactDir) {
    results.push(validateRecipeArtifactPackage({ recipe, manifest, artifactPaths }));
  }

  return mergeRecipeValidationResults(results);
}

async function listRelativeRecipeCliFiles(root: string): Promise<string[]> {
  const output: string[] = [];

  async function visit(relativeDir: string): Promise<void> {
    const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await visit(relativePath);
      } else if (entry.isFile()) {
        output.push(relativePath.split(path.sep).join('/'));
      }
    }
  }

  await visit('');
  return output.sort();
}
