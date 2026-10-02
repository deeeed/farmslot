import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { isRecord, readJsonFile } from './json.js';
import { isPathWithin } from './path.js';
import { invalidRecipeSource } from './trust-error.js';

const require = createRequire(import.meta.url);
const semver = require('semver') as { validRange(range: string): string | null };

export const RECIPE_LIBRARY_MANIFEST_FILE = 'recipe-library.json';
/** Recipe folder scope that applies to every platform. */
export const SHARED_RECIPE_SCOPE = 'shared';

const PLATFORM_ID = /^[a-z][a-z0-9-]*$/u;
const DIGESTED_DIRECTORIES = ['recipes', 'manifests', 'actions'];

export interface RecipeLibraryAdapterDeclaration {
  /** Module path relative to the library root. */
  module: string;
  /** Named export holding the adapter; defaults to the module's default export. */
  export?: string;
  /** Platform adapter id this adapter extends. */
  extends?: string;
}

/** `recipe-library.json`. Every key is optional; unknown keys are ignored for forward compatibility. */
export interface RecipeLibraryManifest {
  /** Platform variant folders under recipes/, in addition to the built-in platforms. */
  platforms?: string[];
  /** Platform adapter plugins this library ships. Declared and digested; not loaded yet. */
  adapters?: Record<string, RecipeLibraryAdapterDeclaration>;
  /** Action manifest files keyed by platform or `shared`, relative to the library root. */
  actions?: Record<string, string>;
  /** Package version ranges this library needs, e.g. `{ "@farmslot/recipe-cli": ">=0.1.0" }`. */
  requires?: Record<string, string>;
}

/** Read and validate a library's recipe-library.json; undefined when the library has none. */
export async function readRecipeLibraryManifest(
  root: string,
): Promise<RecipeLibraryManifest | undefined> {
  const rootReal = await realpath(root);
  const file = path.join(root, RECIPE_LIBRARY_MANIFEST_FILE);
  let manifestReal: string;
  try {
    manifestReal = await realpath(file);
  } catch (error) {
    // A library without recipe-library.json uses the folder conventions only.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!isPathWithin(rootReal, manifestReal))
    throw invalidRecipeSource(
      'Recipe library manifest resolves outside its root.',
      'move recipe-library.json inside its library root',
    );
  const value = await readJsonFile(manifestReal);
  if (!isRecord(value)) throw new Error(`${file} must contain a JSON object.`);
  const manifest: RecipeLibraryManifest = {};

  if (value.platforms !== undefined) {
    if (
      !Array.isArray(value.platforms) ||
      value.platforms.some(
        (platform) =>
          typeof platform !== 'string' ||
          !PLATFORM_ID.test(platform) ||
          platform === SHARED_RECIPE_SCOPE,
      )
    )
      throw new Error(`${file} must declare platforms as adapter names.`);
    manifest.platforms = [...(value.platforms as string[])];
  }

  if (value.adapters !== undefined) {
    if (!isRecord(value.adapters)) throw new Error(`${file} adapters must be an object.`);
    manifest.adapters = {};
    for (const [id, entry] of Object.entries(value.adapters)) {
      if (!PLATFORM_ID.test(id)) throw new Error(`${file} adapter id ${id} is invalid.`);
      if (!isRecord(entry) || typeof entry.module !== 'string' || !entry.module.trim())
        throw new Error(`${file} adapters.${id}.module must be a path.`);
      for (const key of ['export', 'extends'] as const) {
        if (entry[key] !== undefined && (typeof entry[key] !== 'string' || !entry[key].trim()))
          throw new Error(`${file} adapters.${id}.${key} must be a non-empty string.`);
      }
      await libraryFile(rootReal, root, entry.module, `adapters.${id}.module`);
      manifest.adapters[id] = {
        module: entry.module,
        ...(typeof entry.export === 'string' ? { export: entry.export } : {}),
        ...(typeof entry.extends === 'string' ? { extends: entry.extends } : {}),
      };
    }
  }

  if (value.actions !== undefined) {
    if (!isRecord(value.actions)) throw new Error(`${file} actions must be an object.`);
    manifest.actions = {};
    for (const [scope, manifestPath] of Object.entries(value.actions)) {
      if (!PLATFORM_ID.test(scope))
        throw new Error(`${file} actions key ${scope} must be a platform or shared.`);
      if (typeof manifestPath !== 'string' || !manifestPath.trim())
        throw new Error(`${file} actions.${scope} must be a path.`);
      await libraryFile(rootReal, root, manifestPath, `actions.${scope}`);
      manifest.actions[scope] = manifestPath;
    }
  }

  if (value.requires !== undefined) {
    if (!isRecord(value.requires)) throw new Error(`${file} requires must be an object.`);
    manifest.requires = {};
    for (const [name, range] of Object.entries(value.requires)) {
      if (typeof range !== 'string' || semver.validRange(range) === null)
        throw new Error(`${file} requires.${name} must be a semver range.`);
      manifest.requires[name] = range;
    }
  }
  return manifest;
}

/** Resolve a path declared by recipe-library.json; it must exist inside the library root. */
async function libraryFile(
  rootReal: string,
  root: string,
  relativePath: string,
  key: string,
): Promise<string> {
  if (path.isAbsolute(relativePath))
    throw invalidRecipeSource(
      `${RECIPE_LIBRARY_MANIFEST_FILE} ${key} must be relative to the library root.`,
      `make ${key} a path inside ${root}`,
    );
  const fileReal = await realpath(path.resolve(root, relativePath));
  if (!isPathWithin(rootReal, fileReal))
    throw invalidRecipeSource(
      `${RECIPE_LIBRARY_MANIFEST_FILE} ${key} resolves outside its library root.`,
      `move ${relativePath} inside ${root}`,
    );
  return fileReal;
}

/**
 * Content digest of what a library contributes to discovery and runs:
 * recipe-library.json, recipes/, manifests/, actions/, and the files it declares.
 */
export async function digestRecipeLibrary(
  root: string,
  manifest?: RecipeLibraryManifest,
): Promise<string> {
  const files = new Set<string>();
  const declared = [
    RECIPE_LIBRARY_MANIFEST_FILE,
    ...Object.values(manifest?.actions ?? {}),
    ...Object.values(manifest?.adapters ?? {}).map((adapter) => adapter.module),
  ];
  for (const file of declared) {
    const relative = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
    if (await isReadableFile(path.join(root, relative))) files.add(relative);
  }
  for (const directory of DIGESTED_DIRECTORIES) {
    for (const file of await listLibraryFiles(root, directory)) files.add(file);
  }
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    const content = await readFile(path.join(root, file));
    hash.update(`${file}\0${createHash('sha256').update(content).digest('hex')}\n`);
  }
  return `sha256:${hash.digest('hex')}`;
}

async function listLibraryFiles(root: string, directory: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (relativeDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
    } catch (error) {
      // The top-level folders are all optional.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && relativeDir === directory) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) await visit(relativePath);
      else if (entry.isFile() || entry.isSymbolicLink())
        files.push(relativePath.split(path.sep).join('/'));
    }
  };
  await visit(directory);
  return files;
}

async function isReadableFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    // recipe-library.json is optional; declared files were already checked by the reader.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
