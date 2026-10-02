import { readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  digestRecipeLibrary,
  listRecipeLibraryPlatforms,
  readRecipeLibraryManifest,
  RECIPE_HARNESS_VERSION,
  type RecipeLibraryEnv,
  type RecipeLibraryManifest,
  type RecipeLibrarySource,
  resolveRecipeLibrarySources,
} from '@farmslot/recipe-harness';

import { DiscoveryError } from './discovery-error.js';
import type {
  DiscoveryActionManifestFile,
  DiscoveryLibrary,
  DiscoveryRequirement,
} from './types.js';
import { RECIPE_CLI_VERSION } from './version.js';

const require = createRequire(import.meta.url);
const semver = require('semver') as { satisfies(version: string, range: string): boolean };

const ACTION_MANIFEST_SUFFIX = '.action-manifest.json';
const MANIFESTS_DIR = 'manifests';

/** Package versions a library's `requires` can be checked against. */
const CHECKABLE_PACKAGES: Readonly<Record<string, string>> = {
  '@farmslot/recipe-cli': RECIPE_CLI_VERSION,
  '@farmslot/recipe-harness': RECIPE_HARNESS_VERSION,
};

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
      const requires = checkRequirements(name, manifest);
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
    return (await stat(target)).isDirectory();
  } catch (error) {
    // An absent platform folder means the library has no recipes for that platform.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function checkRequirements(
  library: string,
  manifest: RecipeLibraryManifest | undefined,
): DiscoveryRequirement[] {
  return Object.entries(manifest?.requires ?? {}).map(([name, range]) => {
    const installed = CHECKABLE_PACKAGES[name] ?? null;
    if (installed === null) return { package: name, range, installed, satisfied: null };
    const satisfied = semver.satisfies(installed, range);
    if (!satisfied) {
      throw new DiscoveryError(
        'LIBRARY_REQUIREMENT_UNSATISFIED',
        `Library ${library} requires ${name} ${range}; this CLI has ${installed}.`,
        `upgrade ${name} to a version matching ${range}, or pin an older ${library} library`,
      );
    }
    return { package: name, range, installed, satisfied };
  });
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
  let entries: string[] = [];
  try {
    entries = await readdir(path.join(root, MANIFESTS_DIR));
  } catch (error) {
    // manifests/ is optional; a recipe-only library declares no actions.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(ACTION_MANIFEST_SUFFIX)) continue;
    files.set(entry.slice(0, -ACTION_MANIFEST_SUFFIX.length), `${MANIFESTS_DIR}/${entry}`);
  }
  for (const [scope, file] of Object.entries(manifest?.actions ?? {})) {
    files.set(scope, path.relative(root, path.resolve(root, file)).split(path.sep).join('/'));
  }
  return [...files.entries()]
    .map(([scope, file]) => ({ scope, file }))
    .sort((left, right) => left.scope.localeCompare(right.scope));
}
