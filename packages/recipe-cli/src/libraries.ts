import { lstat } from 'node:fs/promises';
import path from 'node:path';

import {
  checkRecipeLibraryRequirements,
  digestRecipeLibrary,
  listLibraryFiles,
  listRecipeLibraryPlatforms,
  readRecipeLibraryManifest,
  type RecipeLibraryEnv,
  type RecipeLibraryManifest,
  type RecipeLibrarySource,
  type RecipePackageVersions,
  resolveRecipeLibrarySources,
} from '@farmslot/recipe-harness';

import type { DiscoveryActionManifestFile, DiscoveryLibrary } from './types.js';

const ACTION_MANIFEST_FILE = /^manifests\/([^/]+)\.action-manifest\.json$/u;

export const PRECEDENCE_RULES = [
  'Libraries are searched in rank order: --library entries, then RECIPE_LIBRARY_PATH, else the personal library.',
  'A --library entry replaces the RECIPE_LIBRARY_PATH entry with the same name.',
  'The first library that declares a recipe ref or an action wins; later ones are listed as shadows.',
  'Within one library, a platform variant wins over the generic recipe, and a platform action manifest over shared.',
  'A namespaced id <library>.<ref> selects that library’s recipe even when it is shadowed.',
];

export interface ResolvedDiscoveryLibrary {
  info: DiscoveryLibrary;
  source: RecipeLibrarySource;
  manifest: RecipeLibraryManifest | undefined;
}

export interface DiscoveryLibraryOptions {
  /** `--library` entries, `name=path` or `path`. */
  libraries?: readonly string[];
  env?: RecipeLibraryEnv;
  /** Package versions the host provides for checking each library's `requires`. */
  packageVersions?: RecipePackageVersions;
}

/** Resolve the ordered libraries with their manifests, digests and provenance. */
export async function resolveDiscoveryLibraries(
  options: DiscoveryLibraryOptions = {},
): Promise<ResolvedDiscoveryLibrary[]> {
  const sources = await resolveRecipeLibrarySources({
    cliEntries: [...(options.libraries ?? [])],
    ...(options.env ? { env: options.env } : {}),
  });
  return Promise.all(
    sources.map(async (source, index) => {
      const root = path.resolve(source.root);
      const name = source.name ?? path.basename(root);
      const manifest = await readRecipeLibraryManifest(root);
      const digest = await digestRecipeLibrary(root, manifest);
      const requires = checkRecipeLibraryRequirements(name, manifest, options.packageVersions);
      const info: DiscoveryLibrary = {
        rank: index + 1,
        name,
        root,
        origin: source.origin ?? 'flag',
        ...(source.overrides ? { overrides: source.overrides } : {}),
        digest,
        platforms: await presentPlatforms(root, manifest),
        adapters: manifest?.adapters ?? {},
        actionManifests: await actionManifestFiles(root, manifest),
        requires,
      };
      return {
        info,
        manifest,
        source: {
          ...source,
          name,
          root,
          provenance: {
            kind: 'library',
            trust: 'unknown',
            name,
            path: root,
            ...source.provenance,
            digest,
          },
        },
      };
    }),
  );
}

/**
 * Platforms the library actually uses: declared ones, plus built-in platforms that have a
 * recipes/<platform>/ folder or an action manifest.
 */
async function presentPlatforms(
  root: string,
  manifest: RecipeLibraryManifest | undefined,
): Promise<string[]> {
  const declared = new Set(manifest?.platforms ?? []);
  const scopes = new Set((await actionManifestFiles(root, manifest)).map((file) => file.scope));
  const present: string[] = [];
  for (const platform of await listRecipeLibraryPlatforms(root)) {
    if (
      declared.has(platform) ||
      scopes.has(platform) ||
      (await isDirectory(path.join(root, 'recipes', platform)))
    )
      present.push(platform);
  }
  return present;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    // lstat: a symlinked folder is not followed by the library walker either.
    return (await lstat(target)).isDirectory();
  } catch (error) {
    // An absent platform folder means the library has no recipes for that platform.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Action manifests a library declares: `actions` in recipe-library.json per scope, else
 * `manifests/<scope>.action-manifest.json` by convention.
 */
async function actionManifestFiles(
  root: string,
  manifest: RecipeLibraryManifest | undefined,
): Promise<DiscoveryActionManifestFile[]> {
  const files = new Map<string, string>();
  // The shared walker only returns regular files that stay inside the library root.
  for (const file of await listLibraryFiles(root, 'manifests')) {
    const match = ACTION_MANIFEST_FILE.exec(file);
    if (match) files.set(match[1]!, file);
  }
  for (const [scope, file] of Object.entries(manifest?.actions ?? {})) {
    files.set(scope, path.relative(root, path.resolve(root, file)).split(path.sep).join('/'));
  }
  return [...files.entries()]
    .map(([scope, file]) => ({ scope, file }))
    .sort((left, right) => left.scope.localeCompare(right.scope));
}
