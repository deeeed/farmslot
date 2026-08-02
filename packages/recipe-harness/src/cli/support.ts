import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  applyRecipeParamDefaults,
  digestRecipeDocument,
  isRecord,
  mergeRecipeValidationResults,
  type RecipeValidationResult,
  resolvedRecipeArtifactPath,
  validateArtifactManifestDocument,
  validateRecipeArtifactPackage,
  validateRecipeDocument,
  validateRecipeParams,
  validateRecipeWithManifest,
} from '@farmslot/protocol';

import {
  resolveRecipeDependencies,
  rootResolutionRef,
  validateRecipeDependencyParams,
} from '../core/compose.js';
import { loadRecipeLibraries } from '../core/library.js';
import { readFileWithinRoot } from '../core/path.js';
import { RecipeResolutionError } from '../core/resolution-error.js';
import type { RecipeLibrarySource, RecordingTarget } from '../core/types.js';

interface RecipeValidationInputOptions {
  recipePath: string;
  actionManifestPath?: string;
  adapter?: string;
  artifactManifestPath?: string;
  artifactDir?: string;
  baseDir?: string;
  /** Library sources whose recipe refs count as resolvable, mirroring run resolution. */
  librarySources?: RecipeLibrarySource[];
  params?: Record<string, unknown>;
}

interface RecipeCliRecordingTargetOptions {
  recordAppName?: string;
  recordWindowName?: string;
  recordWindowId?: string;
  recordPid?: string;
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

export function parseRecipeParamAssignments(values: readonly string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Recipe parameter ${JSON.stringify(value)} must use key=value.`);
    }
    const key = value.slice(0, separator).trim();
    if (!key || Object.hasOwn(params, key)) {
      throw new Error(
        Object.hasOwn(params, key)
          ? `Recipe parameter ${key} was provided more than once.`
          : `Recipe parameter ${JSON.stringify(value)} has an empty key.`,
      );
    }
    const raw = value.slice(separator + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    Object.defineProperty(params, key, {
      value: parsed,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return params;
}

export function parseRecordingTarget(
  options: RecipeCliRecordingTargetOptions,
): RecordingTarget | undefined {
  if (options.recordPid) return { kind: 'pid', pid: parsePositiveInteger(options.recordPid) };
  if (options.recordWindowId) return { kind: 'window-id', windowId: options.recordWindowId };
  if (options.recordAppName || options.recordWindowName) {
    if (!options.recordAppName || !options.recordWindowName) {
      throw new Error('--record-app-name and --record-window-name must be provided together.');
    }
    return {
      kind: 'app-window',
      appName: options.recordAppName,
      windowName: options.recordWindowName,
    };
  }
  return undefined;
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

export async function readRecipeCliJsonFileWithinRoot(
  root: string,
  relativePath: string,
): Promise<unknown> {
  let text: string;
  try {
    text = (await readFileWithinRoot(root, relativePath)).toString('utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read JSON from ${relativePath}: ${message}`, { cause: error });
  }
  return parseRecipeCliJsonText(relativePath, text);
}

async function readOptionalRecipeCliJsonFileWithinRoot(
  root: string,
  relativePath: string,
): Promise<unknown | undefined> {
  try {
    return await readRecipeCliJsonFileWithinRoot(root, relativePath);
  } catch (error) {
    if ((error as { cause?: NodeJS.ErrnoException })?.cause?.code === 'ENOENT') return undefined;
    throw error;
  }
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
  adapter,
  artifactManifestPath,
  artifactDir,
  baseDir = recipeCliBaseDir(),
  librarySources,
  params = {},
}: RecipeValidationInputOptions): Promise<RecipeValidationResult> {
  const recipe = await readRecipeCliJsonFile(recipePath, baseDir);
  const results: RecipeValidationResult[] = [];
  const effectiveParams = isRecord(recipe)
    ? applyRecipeParamDefaults(params, recipe.paramsSchema)
    : params;
  if (isRecord(recipe)) results.push(validateRecipeParams(effectiveParams, recipe.paramsSchema));

  const artifactRoot = artifactDir ? resolveRecipeCliPath(artifactDir, baseDir) : undefined;
  const artifactPaths = artifactRoot ? await listRelativeRecipeCliFiles(artifactRoot) : undefined;
  const recipeResolution = artifactRoot
    ? await readOptionalRecipeCliJsonFileWithinRoot(artifactRoot, 'recipe-resolution.json')
    : undefined;
  const trace = artifactRoot
    ? await readOptionalRecipeCliJsonFileWithinRoot(artifactRoot, 'trace.json')
    : undefined;
  const summary = artifactRoot
    ? await readOptionalRecipeCliJsonFileWithinRoot(artifactRoot, 'summary.json')
    : undefined;
  const resolvedRecipes: Record<string, unknown> = {};
  if (artifactRoot && isRecord(recipeResolution) && Array.isArray(recipeResolution.dependencies)) {
    for (const dependency of recipeResolution.dependencies) {
      if (!isRecord(dependency)) continue;
      const artifact = resolvedRecipeArtifactPath(dependency.digest);
      if (!artifact) continue;
      const document = await readOptionalRecipeCliJsonFileWithinRoot(artifactRoot, artifact);
      if (document !== undefined) resolvedRecipes[String(dependency.digest)] = document;
    }
  }

  const libraryResolution =
    librarySources && librarySources.length > 0
      ? await loadRecipeLibraries(librarySources)
      : undefined;
  const externalRecipeIds = new Set(libraryResolution?.recipes.keys() ?? []);
  if (isRecord(recipeResolution) && Array.isArray(recipeResolution.dependencies)) {
    for (const dependency of recipeResolution.dependencies) {
      if (isRecord(dependency) && typeof dependency.ref === 'string') {
        externalRecipeIds.add(dependency.ref);
      }
    }
  }
  const validationOptions =
    externalRecipeIds.size > 0 || adapter ? { externalRecipeIds, adapter } : undefined;
  if (actionManifestPath) {
    const actionManifest = await readRecipeCliJsonFile(actionManifestPath, baseDir);
    results.push(validateRecipeWithManifest(recipe, actionManifest, validationOptions));
  } else {
    results.push(validateRecipeDocument(recipe, validationOptions));
  }

  if (
    !artifactDir &&
    libraryResolution &&
    isRecord(recipe) &&
    results.every((result) => result.status === 'valid')
  ) {
    try {
      const rootDigest = digestRecipeDocument(recipe);
      resolveRecipeDependencies({
        rootRef: rootResolutionRef(rootDigest),
        root: recipe,
        rootSource: {
          kind: 'operator',
          trust: 'unknown',
          path: resolveRecipeCliPath(recipePath, baseDir),
          digest: rootDigest,
        },
        recipes: libraryResolution.recipes,
      });
      validateRecipeDependencyParams({
        root: recipe,
        params: effectiveParams,
        recipes: libraryResolution.recipes,
      });
    } catch (error) {
      results.push({
        status: 'invalid',
        findings: [
          {
            severity: 'error',
            code:
              error instanceof RecipeResolutionError
                ? error.code.toLowerCase()
                : 'recipe.unresolved_dependency_graph',
            path: 'workflow',
            message:
              error instanceof RecipeResolutionError
                ? `${error.message} Next: ${error.userAction}.`
                : error instanceof Error
                  ? error.message
                  : String(error),
          },
        ],
        summary: { errors: 1, warnings: 0 },
      });
    }
  }

  const manifestPath =
    artifactManifestPath ??
    (artifactDir ? path.join(artifactDir, 'artifact-manifest.json') : undefined);

  let manifest: unknown;
  if (manifestPath) {
    manifest = artifactManifestPath
      ? await readRecipeCliJsonFile(manifestPath, baseDir)
      : await readOptionalRecipeCliJsonFileWithinRoot(artifactRoot!, 'artifact-manifest.json');
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
    results.push(
      validateRecipeArtifactPackage({
        recipe,
        manifest,
        trace,
        summary,
        artifactPaths,
        resolvedRecipes,
        recipeResolution,
      }),
    );
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
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        output.push(relativePath.split(path.sep).join('/'));
      }
    }
  }

  await visit('');
  return output.sort();
}
