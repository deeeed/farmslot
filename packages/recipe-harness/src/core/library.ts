import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  digestRecipeDocument,
  type RecipeSourceProvenance,
  validateRecipeDocument,
} from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { isRecord } from './json.js';
import {
  checkRecipeLibraryRequirements,
  listLibraryFiles,
  readRecipeLibraryManifest,
  type RecipeLibraryManifest,
  type RecipePackageVersions,
} from './library-manifest.js';
import { isPathWithin } from './path.js';
import { RecipeResolutionError } from './resolution-error.js';
import { invalidRecipeSource } from './trust-error.js';
import type { LoadedRecipeLibrarySource, RecipeLibrarySource, RecipeLogger } from './types.js';

const LIBRARY_RECIPES_DIR = 'recipes';
const RECIPE_FILE_SUFFIX = '.recipe.json';

/** Platforms whose variant folders every library recognizes without declaring them. */
export const BUILT_IN_RECIPE_PLATFORMS: readonly string[] = ['core', 'extension', 'mobile'];

/** Platform variant folders a library recognizes: the built-in set plus its declared platforms. */
export async function listRecipeLibraryPlatforms(root: string): Promise<string[]> {
  const manifest = await readRecipeLibraryManifest(root);
  return [...new Set([...BUILT_IN_RECIPE_PLATFORMS, ...(manifest?.platforms ?? [])])].sort();
}

function libraryAdapters(
  manifest: RecipeLibraryManifest | undefined,
  active?: string,
): Set<string> {
  const adapters = new Set([...BUILT_IN_RECIPE_PLATFORMS, ...(manifest?.platforms ?? [])]);
  if (active) adapters.add(active);
  return adapters;
}

export interface RecipeLibraryLoadOptions {
  /** Active platform: selects platform variants. */
  adapter?: string;
  logger?: RecipeLogger;
  /** Package versions the host provides for checking each library's `requires`. */
  packageVersions?: RecipePackageVersions;
}

const BUILT_IN_PLATFORM_SET: ReadonlySet<string> = new Set(BUILT_IN_RECIPE_PLATFORMS);

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
  /** Qualified compatibility reference; excluded from catalogs. */
  aliasFor?: string;
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
        throw new RecipeResolutionError(
          'RECIPE_LIBRARY_PATH_INVALID',
          `Recipe library entry ${JSON.stringify(entry)} must be name=path or path.`,
          'pass --library name=path (or a bare path), and check RECIPE_LIBRARY_PATH entries',
        );
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

/**
 * Ordered library sources: --library entries, then RECIPE_LIBRARY_PATH, or the personal
 * library when neither is set. A --library entry replaces the RECIPE_LIBRARY_PATH entry
 * with the same name instead of conflicting with it.
 */
export async function resolveRecipeLibrarySources(options?: {
  cliEntries?: string[];
  env?: RecipeLibraryEnv;
  recipePath?: string;
}): Promise<RecipeLibrarySource[]> {
  const env = options?.env ?? process.env;
  const flagged = (options?.cliEntries ?? [])
    .flatMap((entry) => parseRecipeLibraryPath(entry))
    .map((source) => ({ ...source, origin: 'flag' as const }));
  const flaggedByName = new Map(flagged.map((source) => [librarySourceName(source), source]));
  const environment = env.RECIPE_LIBRARY_PATH
    ? parseRecipeLibraryPath(env.RECIPE_LIBRARY_PATH).flatMap((source) => {
        const override = flaggedByName.get(librarySourceName(source));
        if (!override) return [{ ...source, origin: 'env' as const }];
        override.overrides = source.root;
        return [];
      })
    : [];
  const explicit = [...flagged, ...environment];
  const configured =
    explicit.length > 0
      ? explicit
      : (await defaultRecipeLibrarySources(env)).map((source) => ({
          ...source,
          origin: 'default' as const,
        }));
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
      origin: 'task',
      provenance: { kind: 'task', trust: 'unknown', name: 'task-local' },
    },
    ...configured,
  ];
}

function librarySourceName(source: RecipeLibrarySource): string {
  return source.name ?? path.basename(path.resolve(source.root));
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
  options?: RecipeLibraryLoadOptions,
): Promise<RecipeLibraryResolution> {
  const loadedSources: LoadedRecipeLibrarySource[] = [];
  const recipes = new Map<string, ResolvedLibraryRecipe>();
  const qualified = new Map<string, ResolvedLibraryRecipe>();
  const seenNames = new Set<string>();

  for (const source of sources) {
    const root = path.resolve(expandTilde(source.root));
    const rootReal = await realpath(root);
    const name = librarySourceName(source);
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
    const manifest = await readRecipeLibraryManifest(root);
    checkRecipeLibraryRequirements(name, manifest, options?.packageVersions);

    const selected = new Map<string, ResolvedLibraryRecipe>();
    const adapters = libraryAdapters(manifest, options?.adapter);
    // Read concurrently, then select in sorted file order so precedence stays deterministic.
    const files = await Promise.all(
      (await listRecipeFiles(root)).map(async (relativeFile) => {
        const identity = recipeIdentity(relativeFile, options?.adapter, adapters);
        if (!identity) return undefined;
        const absolutePath = path.join(root, LIBRARY_RECIPES_DIR, relativeFile);
        const fileReal = await realpath(absolutePath);
        if (!isPathWithin(rootReal, fileReal)) {
          throw invalidRecipeSource(
            `Library recipe ${path.join(LIBRARY_RECIPES_DIR, relativeFile)} resolves outside its library root.`,
            'move the recipe inside the library root or remove the escaping symlink',
          );
        }
        return { relativeFile, identity, fileReal, document: await readLibraryRecipe(fileReal) };
      }),
    );
    for (const file of files) {
      if (!file) continue;
      const { relativeFile, identity, fileReal, document } = file;
      const previous = selected.get(identity.ref);
      const currentFile = path.join(LIBRARY_RECIPES_DIR, relativeFile).split(path.sep).join('/');
      if (previous && previous.adapter === identity.adapter) {
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
        file: currentFile,
        path: fileReal,
        ...(identity.adapter ? { adapter: identity.adapter } : {}),
        provenance: { ...sourceProvenance, path: fileReal, digest },
        shadows: [],
      });
    }
    loadedSources.push({ name, root, recipeCount: selected.size, provenance: sourceProvenance });

    for (const [ref, resolved] of selected) {
      if (resolved.adapter && !BUILT_IN_PLATFORM_SET.has(resolved.adapter)) {
        const alias = `${resolved.adapter}.${ref}`;
        if (!qualified.has(alias)) qualified.set(alias, { ...resolved, ref: alias, aliasFor: ref });
      }
      const winner = recipes.get(ref);
      if (winner) winner.shadows.push(name);
      else recipes.set(ref, resolved);
    }
  }

  // Custom directories previously formed qualified generic IDs. Preserve those
  // references as aliases while offering the same logical ID as built-in adapters.
  for (const [alias, recipe] of qualified) if (!recipes.has(alias)) recipes.set(alias, recipe);

  const resolution = { sources: loadedSources, recipes };
  if (options?.logger) logRecipeLibraryResolution(options.logger, resolution);
  return resolution;
}

export interface LibraryRecipeMatch {
  recipe: ResolvedLibraryRecipe;
  /**
   * `ref`: the precedence winner; `alias`: a qualified platform alias such as `web.greet`;
   * `id`: a namespaced `<library>.<ref>` that selects that library's recipe even when shadowed.
   */
  resolvedBy: 'ref' | 'alias' | 'id';
}

/**
 * Resolve a recipe name the way `run` and discovery both do: a ref or alias in the resolution
 * first, then a namespaced `<library>.<ref>` id against that one library.
 */
export async function findLibraryRecipe(
  name: string,
  sources: readonly RecipeLibrarySource[],
  resolution: RecipeLibraryResolution,
  options?: RecipeLibraryLoadOptions & {
    /** Loader for a single library, so callers can reuse loads they already made. */
    load?: (source: RecipeLibrarySource) => Promise<RecipeLibraryResolution>;
  },
): Promise<LibraryRecipeMatch | undefined> {
  const direct = resolution.recipes.get(name);
  if (direct) return { recipe: direct, resolvedBy: direct.aliasFor ? 'alias' : 'ref' };
  for (const source of sources) {
    const prefix = `${librarySourceName(source)}.`;
    if (!name.startsWith(prefix) || name.length === prefix.length) continue;
    const own = options?.load
      ? await options.load(source)
      : await loadRecipeLibraries([source], {
          ...(options?.adapter ? { adapter: options.adapter } : {}),
          ...(options?.packageVersions ? { packageVersions: options.packageVersions } : {}),
        });
    const recipe = own.recipes.get(name.slice(prefix.length));
    if (recipe && !recipe.aliasFor) return { recipe, resolvedBy: 'id' };
  }
  return undefined;
}

/** Recipe files under recipes/, relative to it, from the shared library walker. */
export async function listRecipeFiles(root: string): Promise<string[]> {
  const prefix = `${LIBRARY_RECIPES_DIR}/`;
  return (await listLibraryFiles(root, LIBRARY_RECIPES_DIR))
    .filter((file) => file.endsWith(RECIPE_FILE_SUFFIX))
    .map((file) => file.slice(prefix.length));
}

const validatedRecipes = new Map<
  string,
  { mtimeMs: number; size: number; document: Record<string, unknown> }
>();

/** Read and validate one library recipe; validation is cached per process while the file is unchanged. */
async function readLibraryRecipe(fileReal: string): Promise<Record<string, unknown>> {
  const info = await stat(fileReal);
  const cached = validatedRecipes.get(fileReal);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size)
    return structuredClone(cached.document);
  let document: unknown;
  try {
    document = JSON.parse(await readFile(fileReal, 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new RecipeResolutionError(
      'RECIPE_LIBRARY_RECIPE_INVALID',
      `Library recipe ${fileReal} is not valid JSON: ${error.message}.`,
      `fix ${fileReal} so it validates as Recipe v1`,
    );
  }
  if (!isRecord(document))
    throw new RecipeResolutionError(
      'RECIPE_LIBRARY_RECIPE_INVALID',
      `Library recipe ${fileReal} must contain a recipe object.`,
      `fix ${fileReal} so it validates as Recipe v1`,
    );
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
  validatedRecipes.set(fileReal, { mtimeMs: info.mtimeMs, size: info.size, document });
  return structuredClone(document);
}

function recipeIdentity(
  relativeFile: string,
  adapter: string | undefined,
  adapters: ReadonlySet<string>,
): { ref: string; adapter?: string } | undefined {
  const portable = relativeFile.split(path.sep).join('/');
  if (!portable.endsWith(RECIPE_FILE_SUFFIX)) return undefined;
  const libraryFile = `${LIBRARY_RECIPES_DIR}/${portable}`;
  const base = portable.slice(0, -RECIPE_FILE_SUFFIX.length);
  const firstSeparator = base.indexOf('/');
  const firstDirectory = firstSeparator < 0 ? undefined : base.slice(0, firstSeparator);
  const directoryAdapter =
    firstDirectory && adapters.has(firstDirectory) ? firstDirectory : undefined;
  const directoryScope = firstDirectory === 'shared' ? firstDirectory : directoryAdapter;
  const suffix = base.slice(base.lastIndexOf('.') + 1);
  const filenameAdapter = BUILT_IN_PLATFORM_SET.has(suffix) ? suffix : undefined;
  if (directoryScope && filenameAdapter) {
    throw new RecipeResolutionError(
      'RECIPE_LIBRARY_ADAPTER_DECLARATION_CONFLICT',
      `Library recipe ${libraryFile} declares ${directoryScope} scope in its directory and ${filenameAdapter} adapter in its filename.`,
      'declare the adapter once using recipes/<adapter>/.../*.recipe.json, or use recipes/shared/.../*.recipe.json without an adapter suffix',
    );
  }
  const declaredAdapter = directoryAdapter ?? filenameAdapter;
  const idPath = directoryScope
    ? base.slice(directoryScope.length + 1)
    : filenameAdapter
      ? base.slice(0, -(filenameAdapter.length + 1))
      : base;
  if ((directoryScope || declaredAdapter) && !idPath.trim()) {
    throw new RecipeResolutionError(
      'RECIPE_LIBRARY_RECIPE_INVALID',
      `Library recipe ${libraryFile} declares ${declaredAdapter ? `adapter ${declaredAdapter}` : 'shared scope'} but has no recipe id.`,
      `move it to recipes/${directoryScope ?? declaredAdapter}/<name>.recipe.json`,
    );
  }
  if (declaredAdapter && declaredAdapter !== adapter) return undefined;
  const ref = idPath.replaceAll('/', '.').trim();
  return ref ? { ref, ...(declaredAdapter ? { adapter: declaredAdapter } : {}) } : undefined;
}

/**
 * Log the resolved sources and shadowed recipes. With `refs`, only shadows among those refs are
 * reported, so a run does not warn about a winner it never executes.
 */
export function logRecipeLibraryResolution(
  logger: RecipeLogger,
  resolution: RecipeLibraryResolution,
  refs?: ReadonlySet<string>,
): void {
  const summary = resolution.sources
    .map((source) => `${source.name}=${source.root} (${source.recipeCount} recipes)`)
    .join(', ');
  logger.info(`Recipe libraries: ${summary || 'none'}`);
  for (const recipe of resolution.recipes.values()) {
    if (recipe.aliasFor || (refs && !refs.has(recipe.ref))) continue;
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
