import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  digestRecipeDocument,
  type RecipeSourceProvenance,
  validateRecipeDocument,
} from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { isRecord, readJsonFile } from './json.js';
import { isPathWithin } from './path.js';
import { RecipeResolutionError } from './resolution-error.js';
import { invalidRecipeSource } from './trust-error.js';
import type { LoadedRecipeLibrarySource, RecipeLibrarySource, RecipeLogger } from './types.js';

const LIBRARY_RECIPES_DIR = 'recipes';
const RECIPE_FILE_SUFFIX = '.recipe.json';
const RECIPE_ADAPTERS = new Set(['core', 'extension', 'mobile']);

export type RecipeLibraryEnv = Record<string, string | undefined>;

export interface ResolvedLibraryRecipe {
  ref: string;
  document: Record<string, unknown>;
  source: string;
  /** Recipe file path relative to the library root. */
  file: string;
  path: string;
  adapter?: string;
  provenance: RecipeSourceProvenance;
  /** Source names that also declare this ref at lower precedence. */
  shadows: string[];
}

export interface RecipeLibraryResolution {
  sources: LoadedRecipeLibrarySource[];
  recipes: ReadonlyMap<string, ResolvedLibraryRecipe>;
}

export function parseRecipeLibraryPath(value: string): RecipeLibrarySource[] {
  return value
    .split(':')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('=');
      if (separator < 0) return { root: expandTilde(entry) };
      const name = entry.slice(0, separator).trim();
      const root = entry.slice(separator + 1).trim();
      if (!name || !root) {
        throw new Error(`Recipe library entry ${JSON.stringify(entry)} must be name=path or path.`);
      }
      return { name, root: expandTilde(root) };
    });
}

export function personalRecipeLibraryRoot(env: RecipeLibraryEnv = process.env): string {
  return path.join(farmslotHome(env), 'recipe-library');
}

export async function defaultRecipeLibrarySources(
  env: RecipeLibraryEnv = process.env,
): Promise<RecipeLibrarySource[]> {
  const personalRoot = personalRecipeLibraryRoot(env);
  if (!(await isDirectory(personalRoot))) return [];
  return [{ name: 'personal', root: personalRoot }];
}

export async function resolveRecipeLibrarySources(options?: {
  cliEntries?: string[];
  env?: RecipeLibraryEnv;
  recipePath?: string;
}): Promise<RecipeLibrarySource[]> {
  const env = options?.env ?? process.env;
  const explicit = [
    ...(options?.cliEntries ?? []).flatMap((entry) => parseRecipeLibraryPath(entry)),
    ...(env.RECIPE_LIBRARY_PATH ? parseRecipeLibraryPath(env.RECIPE_LIBRARY_PATH) : []),
  ];
  const configured = explicit.length > 0 ? explicit : await defaultRecipeLibrarySources(env);
  if (!options?.recipePath) return configured;

  const recipeDir = path.dirname(path.resolve(options.recipePath));
  const taskDir =
    path.basename(recipeDir) === 'resolved-recipes' ? path.dirname(recipeDir) : recipeDir;
  const taskRoot = path.join(taskDir, 'recipe-library');
  if (!(await isDirectory(taskRoot))) return configured;
  if (configured.some((source) => path.resolve(source.root) === taskRoot)) return configured;
  return [
    {
      name: 'task-local',
      root: taskRoot,
      provenance: { kind: 'task', trust: 'unknown', name: 'task-local' },
    },
    ...configured,
  ];
}

export function applyTaskLocalInvocationTrust(
  sources: readonly RecipeLibrarySource[],
  invocationTrust: RecipeSourceProvenance['trust'],
): RecipeLibrarySource[] {
  return sources.map((source) =>
    source.name === 'task-local'
      ? {
          ...source,
          provenance: { ...source.provenance, kind: 'task', trust: invocationTrust },
        }
      : source,
  );
}

/**
 * Load ordered library sources into one recipe index. The first source wins;
 * within one source an exact adapter variant wins over the generic recipe.
 */
export async function loadRecipeLibraries(
  sources: readonly RecipeLibrarySource[],
  options?: { adapter?: string; logger?: RecipeLogger },
): Promise<RecipeLibraryResolution> {
  const loadedSources: LoadedRecipeLibrarySource[] = [];
  const recipes = new Map<string, ResolvedLibraryRecipe>();
  const seenNames = new Set<string>();

  for (const source of sources) {
    const root = path.resolve(expandTilde(source.root));
    const rootReal = await realpath(root);
    const name = source.name ?? path.basename(root);
    const sourceProvenance: RecipeSourceProvenance = source.provenance ?? {
      kind: 'library',
      trust: 'unknown',
      name,
      path: root,
    };
    if (seenNames.has(name)) {
      throw new RecipeResolutionError(
        'RECIPE_LIBRARY_DUPLICATE_SOURCE',
        `Recipe library source ${name} is configured more than once.`,
        `assign distinct name=/path aliases or remove one ${name} source`,
      );
    }
    seenNames.add(name);

    const selected = new Map<string, ResolvedLibraryRecipe>();
    for (const relativeFile of await listRecipeFiles(root)) {
      const identity = recipeIdentity(relativeFile, options?.adapter);
      if (!identity) continue;
      const absolutePath = path.join(root, LIBRARY_RECIPES_DIR, relativeFile);
      const fileReal = await realpath(absolutePath);
      if (!isPathWithin(rootReal, fileReal)) {
        throw invalidRecipeSource(
          `Library recipe ${path.join(LIBRARY_RECIPES_DIR, relativeFile)} resolves outside its library root.`,
          'move the recipe inside the library root or remove the escaping symlink',
        );
      }
      const document = await readJsonFile(fileReal);
      if (!isRecord(document)) throw new Error(`${fileReal} must contain a recipe object.`);
      const validation = validateRecipeDocument(document, { skipRecipeCallResolution: true });
      if (validation.status === 'invalid') {
        throw new RecipeResolutionError(
          'RECIPE_LIBRARY_RECIPE_INVALID',
          `Library recipe ${fileReal} is invalid: ${validation.findings
            .map((finding) => `${finding.code} ${finding.path}`)
            .join(', ')}.`,
          `fix ${fileReal} so it validates as Recipe v1`,
        );
      }
      const previous = selected.get(identity.ref);
      if (previous && previous.adapter === identity.adapter) {
        const currentFile = path.join(LIBRARY_RECIPES_DIR, relativeFile).split(path.sep).join('/');
        throw new RecipeResolutionError(
          'RECIPE_LIBRARY_DUPLICATE_RECIPE',
          `Recipe ${identity.ref} is declared more than once in library ${name}: ${previous.file} and ${currentFile}.`,
          `keep one ${identity.ref} recipe per adapter in library ${name}; remove or rename one of the listed files`,
        );
      }
      if (previous && previous.adapter && !identity.adapter) continue;
      const digest = digestRecipeDocument(document);
      selected.set(identity.ref, {
        ref: identity.ref,
        document,
        source: name,
        file: path.join(LIBRARY_RECIPES_DIR, relativeFile).split(path.sep).join('/'),
        path: fileReal,
        ...(identity.adapter ? { adapter: identity.adapter } : {}),
        provenance: { ...sourceProvenance, path: fileReal, digest },
        shadows: [],
      });
    }
    loadedSources.push({ name, root, recipeCount: selected.size, provenance: sourceProvenance });

    for (const [ref, resolved] of selected) {
      const winner = recipes.get(ref);
      if (winner) winner.shadows.push(name);
      else recipes.set(ref, resolved);
    }
  }

  const resolution = { sources: loadedSources, recipes };
  if (options?.logger) logResolution(options.logger, resolution);
  return resolution;
}

export async function listRecipeFiles(root: string): Promise<string[]> {
  const recipesRoot = path.join(root, LIBRARY_RECIPES_DIR);
  const files: string[] = [];
  async function visit(relativeDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(path.join(recipesRoot, relativeDir), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' && relativeDir === '') return;
      throw error;
    }
    for (const entry of entries) {
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) await visit(relativePath);
      else if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        entry.name.endsWith(RECIPE_FILE_SUFFIX)
      ) {
        files.push(relativePath);
      }
    }
  }
  await visit('');
  return files.sort();
}

function recipeIdentity(
  relativeFile: string,
  adapter: string | undefined,
): { ref: string; adapter?: string } | undefined {
  const portable = relativeFile.split(path.sep).join('/');
  if (!portable.endsWith(RECIPE_FILE_SUFFIX)) return undefined;
  const base = portable.slice(0, -RECIPE_FILE_SUFFIX.length);
  const firstSeparator = base.indexOf('/');
  const firstDirectory = firstSeparator < 0 ? undefined : base.slice(0, firstSeparator);
  const directoryAdapter =
    firstDirectory && RECIPE_ADAPTERS.has(firstDirectory) ? firstDirectory : undefined;
  const suffix = base.slice(base.lastIndexOf('.') + 1);
  const filenameAdapter = RECIPE_ADAPTERS.has(suffix) ? suffix : undefined;
  if (directoryAdapter && filenameAdapter) {
    throw new RecipeResolutionError(
      'RECIPE_LIBRARY_ADAPTER_DECLARATION_CONFLICT',
      `Library recipe ${path.join(LIBRARY_RECIPES_DIR, relativeFile)} declares adapter ${directoryAdapter} in its directory and ${filenameAdapter} in its filename.`,
      'declare the adapter once using recipes/<adapter>/.../*.recipe.json or keep the legacy *.<adapter>.recipe.json path',
    );
  }
  const declaredAdapter = directoryAdapter ?? filenameAdapter;
  const idPath = directoryAdapter
    ? base.slice(directoryAdapter.length + 1)
    : filenameAdapter
      ? base.slice(0, -(filenameAdapter.length + 1))
      : base;
  if (declaredAdapter && !idPath.trim()) {
    throw new RecipeResolutionError(
      'RECIPE_LIBRARY_RECIPE_INVALID',
      `Library recipe ${path.join(LIBRARY_RECIPES_DIR, relativeFile)} declares adapter ${declaredAdapter} but has no recipe id.`,
      `move it to recipes/${declaredAdapter}/<name>.recipe.json or rename it to <name>.${declaredAdapter}.recipe.json`,
    );
  }
  if (declaredAdapter && declaredAdapter !== adapter) return undefined;
  const ref = idPath.replaceAll('/', '.').trim();
  return ref ? { ref, ...(declaredAdapter ? { adapter: declaredAdapter } : {}) } : undefined;
}

function logResolution(logger: RecipeLogger, resolution: RecipeLibraryResolution): void {
  const summary = resolution.sources
    .map((source) => `${source.name}=${source.root} (${source.recipeCount} recipes)`)
    .join(', ');
  logger.info(`Recipe libraries: ${summary || 'none'}`);
  for (const recipe of resolution.recipes.values()) {
    if (recipe.shadows.length > 0) {
      logger.warn(
        `Recipe ${recipe.ref} resolves from ${recipe.source} and shadows ${recipe.shadows.join(', ')}.`,
      );
    }
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

function expandTilde(value: string): string {
  return value === '~' || value.startsWith('~/') ? path.join(homedir(), value.slice(1)) : value;
}
