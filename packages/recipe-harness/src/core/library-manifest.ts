import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { RECIPE_HARNESS_VERSION } from '../version.js';

import { isRecord } from './json.js';
import { isPathWithin } from './path.js';
import { RecipeResolutionError } from './resolution-error.js';
import { invalidRecipeSource } from './trust-error.js';

const require = createRequire(import.meta.url);
const semver = require('semver') as {
  validRange(range: string): string | null;
  satisfies(version: string, range: string): boolean;
};

export const RECIPE_LIBRARY_MANIFEST_FILE = 'recipe-library.json';
/** Recipe folder scope that applies to every platform. */
export const SHARED_RECIPE_SCOPE = 'shared';

const PLATFORM_ID = /^[a-z][a-z0-9-]*$/u;
/** Library folders that discovery and runs read; the digest covers exactly these plus declared files. */
export const RECIPE_LIBRARY_DIRECTORIES = ['recipes', 'manifests', 'actions'] as const;

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

/** Installed package versions a host provides for checking `requires`. */
export type RecipePackageVersions = Readonly<Record<string, string>>;

export interface RecipeLibraryRequirement {
  package: string;
  range: string;
  installed: string;
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
  const invalid = (detail: string) =>
    new RecipeResolutionError(
      'RECIPE_LIBRARY_MANIFEST_INVALID',
      `${file} is invalid: ${detail}`,
      `fix ${RECIPE_LIBRARY_MANIFEST_FILE} in ${root}`,
    );
  if (!(await stat(manifestReal)).isFile()) throw invalid('it is not a regular file.');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestReal, 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw invalid(`not valid JSON (${error.message}).`);
  }
  if (!isRecord(value)) throw invalid('it must contain a JSON object.');
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
      throw invalid('platforms must be an array of platform ids.');
    manifest.platforms = [...(value.platforms as string[])];
  }

  if (value.adapters !== undefined) {
    if (!isRecord(value.adapters)) throw invalid('adapters must be an object.');
    manifest.adapters = {};
    for (const [id, entry] of Object.entries(value.adapters)) {
      if (!PLATFORM_ID.test(id)) throw invalid(`adapter id ${id} is not a platform id.`);
      if (!isRecord(entry) || typeof entry.module !== 'string' || !entry.module.trim())
        throw invalid(`adapters.${id}.module must be a path.`);
      for (const key of ['export', 'extends'] as const) {
        if (entry[key] !== undefined && (typeof entry[key] !== 'string' || !entry[key].trim()))
          throw invalid(`adapters.${id}.${key} must be a non-empty string.`);
      }
      await declaredLibraryFile(rootReal, root, entry.module, `adapters.${id}.module`, invalid);
      manifest.adapters[id] = {
        module: entry.module,
        ...(typeof entry.export === 'string' ? { export: entry.export } : {}),
        ...(typeof entry.extends === 'string' ? { extends: entry.extends } : {}),
      };
    }
  }

  if (value.actions !== undefined) {
    if (!isRecord(value.actions)) throw invalid('actions must be an object.');
    manifest.actions = {};
    for (const [scope, manifestPath] of Object.entries(value.actions)) {
      if (!PLATFORM_ID.test(scope))
        throw invalid(`actions key ${scope} must be a platform id or shared.`);
      if (typeof manifestPath !== 'string' || !manifestPath.trim())
        throw invalid(`actions.${scope} must be a path.`);
      await declaredLibraryFile(rootReal, root, manifestPath, `actions.${scope}`, invalid);
      manifest.actions[scope] = manifestPath;
    }
  }

  if (value.requires !== undefined) {
    if (!isRecord(value.requires)) throw invalid('requires must be an object.');
    manifest.requires = {};
    for (const [name, range] of Object.entries(value.requires)) {
      if (typeof range !== 'string' || semver.validRange(range) === null)
        throw invalid(`requires.${name} must be a semver range.`);
      manifest.requires[name] = range;
    }
  }
  return manifest;
}

/**
 * Check a library's `requires` against the versions the host provides. Fails closed: a package
 * the host cannot vouch for is as unsatisfied as an out-of-range version.
 */
export function checkRecipeLibraryRequirements(
  library: string,
  manifest: RecipeLibraryManifest | undefined,
  packageVersions: RecipePackageVersions = {},
): RecipeLibraryRequirement[] {
  const installed: RecipePackageVersions = {
    '@farmslot/recipe-harness': RECIPE_HARNESS_VERSION,
    ...packageVersions,
  };
  return Object.entries(manifest?.requires ?? {}).map(([name, range]) => {
    const version = installed[name];
    if (version === undefined) {
      throw new RecipeResolutionError(
        'RECIPE_LIBRARY_REQUIREMENT_UNSATISFIED',
        `Library ${library} requires ${name} ${range}, which this host cannot provide or check.`,
        `use a CLI that provides ${name}, or remove ${name} from the requires of ${library}`,
      );
    }
    if (!semver.satisfies(version, range)) {
      throw new RecipeResolutionError(
        'RECIPE_LIBRARY_REQUIREMENT_UNSATISFIED',
        `Library ${library} requires ${name} ${range}; this host has ${version}.`,
        `upgrade ${name} to a version matching ${range}, or pin an older ${library} library`,
      );
    }
    return { package: name, range, installed: version };
  });
}

/** Resolve a path declared by recipe-library.json; it must be a regular file inside the library. */
async function declaredLibraryFile(
  rootReal: string,
  root: string,
  relativePath: string,
  key: string,
  invalid: (detail: string) => RecipeResolutionError,
): Promise<string> {
  if (path.isAbsolute(relativePath))
    throw invalidRecipeSource(
      `${RECIPE_LIBRARY_MANIFEST_FILE} ${key} must be relative to the library root.`,
      `make ${key} a path inside ${root}`,
    );
  let fileReal: string;
  try {
    fileReal = await realpath(path.resolve(root, relativePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw invalid(`${key} names ${relativePath}, which does not exist.`);
  }
  if (!isPathWithin(rootReal, fileReal))
    throw invalidRecipeSource(
      `${RECIPE_LIBRARY_MANIFEST_FILE} ${key} resolves outside its library root.`,
      `move ${relativePath} inside ${root}`,
    );
  if (!(await stat(fileReal)).isFile())
    throw invalid(`${key} names ${relativePath}, which is not a regular file.`);
  return fileReal;
}

/**
 * Regular files under `<root>/<directory>`, as sorted `/`-separated paths relative to the root.
 * The one walker for loading and digesting: it skips dot-entries, `node_modules` and symlinked
 * directories, and rejects any file that resolves outside the library root.
 */
export async function listLibraryFiles(root: string, directory: string): Promise<string[]> {
  const rootReal = await realpath(root);
  const visit = async (relativeDir: string): Promise<string[]> => {
    let entries;
    try {
      entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
    } catch (error) {
      // Every library folder is optional.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && relativeDir === directory)
        return [];
      throw error;
    }
    // Entries are checked concurrently: discovery walks a library several times per command.
    const nested = await Promise.all(
      entries.map(async (entry): Promise<string[]> => {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') return [];
        const relativePath = path.join(relativeDir, entry.name);
        if (entry.isDirectory()) return visit(relativePath);
        if (!entry.isFile() && !entry.isSymbolicLink()) return [];
        const portable = relativePath.split(path.sep).join('/');
        let fileReal: string;
        try {
          fileReal = await realpath(path.join(root, relativePath));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          throw invalidRecipeSource(
            `Library file ${portable} is a broken symlink.`,
            'remove the symlink or restore its target inside the library root',
          );
        }
        // Symlinked directories are not followed, so a link cannot pull another tree in.
        if (entry.isSymbolicLink() && !(await stat(fileReal)).isFile()) return [];
        if (!isPathWithin(rootReal, fileReal)) {
          throw invalidRecipeSource(
            `Library file ${portable} resolves outside its library root.`,
            'move the file inside the library root or remove the escaping symlink',
          );
        }
        return [portable];
      }),
    );
    return nested.flat();
  };
  return (await visit(directory)).sort();
}

const fileDigests = new Map<string, { mtimeMs: number; size: number; digest: string }>();

/**
 * Content digest of what a library contributes to discovery and runs: recipe-library.json,
 * recipes/, manifests/, actions/, and the files it declares. Text files hash with LF line
 * endings, so a CRLF checkout of the same content has the same digest.
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
  const rootReal = await realpath(root);
  for (const file of declared) {
    const relative = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
    // Declared files are checked here too, so the digest never covers content outside the library.
    const fileReal = await existingRealpath(path.join(root, relative));
    if (!fileReal) continue;
    if (!isPathWithin(rootReal, fileReal))
      throw invalidRecipeSource(
        `Library file ${relative} resolves outside its library root.`,
        'move the file inside the library root or remove the escaping symlink',
      );
    if ((await stat(fileReal)).isFile()) files.add(relative);
  }
  for (const directory of RECIPE_LIBRARY_DIRECTORIES) {
    for (const file of await listLibraryFiles(root, directory)) files.add(file);
  }
  const sorted = [...files].sort();
  const digests = await Promise.all(sorted.map((file) => fileDigest(path.join(root, file))));
  const hash = createHash('sha256');
  sorted.forEach((file, index) => hash.update(`${file}\0${digests[index]}\n`));
  return `sha256:${hash.digest('hex')}`;
}

/** Per-file content hash, cached per process while size and mtime are unchanged. */
async function fileDigest(file: string): Promise<string> {
  const info = await stat(file);
  const cached = fileDigests.get(file);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.digest;
  const content = await readFile(file);
  // Binary files hash byte-exact; text files hash with normalized line endings.
  const normalized = content.includes(0)
    ? content
    : Buffer.from(content.toString('utf8').replaceAll('\r\n', '\n'), 'utf8');
  const digest = createHash('sha256').update(normalized).digest('hex');
  fileDigests.set(file, { mtimeMs: info.mtimeMs, size: info.size, digest });
  return digest;
}

async function existingRealpath(file: string): Promise<string | undefined> {
  try {
    return await realpath(file);
  } catch (error) {
    // recipe-library.json is optional; a missing declared file was already rejected by the reader.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
