// The import fence for adapter plugins. A plugin's digest covers the files
// `libraryAdapterFiles` lists (its module's directory and the library's
// actions/), so a plugin may import only those from disk: a module resolve hook
// refuses any import from plugin code that resolves, after symlinks, to another
// file. Plugin code is the module's directory plus the actions/ files it reaches
// through its own imports; an actions/ file the host imports by itself is not.
// A bare package specifier resolves from the host's install, never from the
// library's location, and `node:` builtins stay allowed. The hook stays
// installed, so imports the plugin makes later, while it runs, are fenced too.
import fs from 'node:fs';
import nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RecipeTrustError } from '@farmslot/recipe-runner';

/** What one loaded plugin may import: the real paths of its digested files. */
export interface PluginImportScope {
  id: string;
  library: string;
  /** Real path of the library root. */
  root: string;
  /** Real paths of the files under the module's directory (or the module alone at the root). */
  moduleFiles: ReadonlySet<string>;
  /** Real paths of every file its digest covers: `moduleFiles` plus the library's actions/. */
  files: ReadonlySet<string>;
  /** A file URL inside the host's install that bare package specifiers resolve from. */
  hostURL: string;
}

const scopes: PluginImportScope[] = [];
/** actions/ files plugin code imported, by real path, and the plugins that reached them. */
const reached = new Map<string, Set<PluginImportScope>>();
let installed = false;

/**
 * Whether this Node.js can fence plugin imports: `module.registerHooks`
 * (Node.js 22.15 / 23.5 and later). Without it a host must not load plugins.
 */
export function canFencePluginImports(): boolean {
  return typeof nodeModule.registerHooks === 'function';
}

/** Fence the imports `scope`'s code makes; installs the hook on first use. */
export function fencePluginImports(scope: PluginImportScope): void {
  scopes.push(scope);
  if (installed) return;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const owners = ownersOf(context.parentURL);
      if (owners.length === 0 || nodeModule.isBuiltin(specifier)) {
        return nextResolve(specifier, context);
      }
      const owner = owners[0]!;
      if (isBareSpecifier(specifier)) {
        // A package comes from the host's install, not whatever node_modules sits
        // beside or above the library, which no digest covers.
        let result;
        try {
          result = nextResolve(specifier, { ...context, parentURL: owner.hostURL });
        } catch {
          throw refusal(owner, specifier, "which the host's install does not provide");
        }
        const target = filePath(result.url);
        if (target !== undefined && owners.some((scope) => inOrAboveLibrary(scope, target)))
          throw refusal(
            owner,
            specifier,
            `which resolves to ${target}, beside or above the library`,
          );
        return result;
      }
      const result = nextResolve(specifier, context);
      const target = filePath(result.url);
      // A file that doesn't exist fails to import on its own.
      if (target === undefined) return result;
      const covering = owners.filter((scope) => scope.files.has(target));
      if (covering.length === 0)
        throw refusal(
          owner,
          specifier,
          `which resolves to ${target}: outside the files its digest covers (its module's directory and the library's actions/)`,
        );
      for (const scope of covering) {
        if (!scope.moduleFiles.has(target)) markReached(target, scope);
      }
      return result;
    },
  });
  installed = true;
}

/** The plugins whose code `parentURL` is: their module directory, or an actions/ file they reached. */
function ownersOf(parentURL: string | undefined): PluginImportScope[] {
  const parent = parentURL === undefined ? undefined : filePath(parentURL);
  if (parent === undefined) return [];
  const viaActions = reached.get(parent);
  return scopes.filter((scope) => scope.moduleFiles.has(parent) || viaActions?.has(scope));
}

function markReached(file: string, scope: PluginImportScope): void {
  let owners = reached.get(file);
  if (!owners) reached.set(file, (owners = new Set()));
  owners.add(scope);
}

// Inside the library, or in a node_modules whose parent directory holds the library.
function inOrAboveLibrary(scope: PluginImportScope, file: string): boolean {
  if (isWithin(scope.root, file)) return true;
  const parts = file.split(path.sep);
  return parts.some(
    (part, index) =>
      part === 'node_modules' &&
      isWithin(parts.slice(0, index).join(path.sep) || path.sep, scope.root),
  );
}

function refusal(scope: PluginImportScope, specifier: string, reason: string): RecipeTrustError {
  return new RecipeTrustError({
    code: 'RECIPE_SOURCE_INVALID',
    message: `adapter '${scope.id}' (library ${scope.library}) imports ${specifier}, ${reason}.`,
    userAction:
      "keep the plugin's code under its module's directory or the library's actions/, or import a package the host installs",
    reason: 'invalid-source',
  });
}

function isBareSpecifier(specifier: string): boolean {
  return !/^(?:\.{1,2}\/|\/|file:|#|data:)/u.test(specifier) && !path.isAbsolute(specifier);
}

function isWithin(root: string, file: string): boolean {
  return file === root || file.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

// The real path behind a file: URL; undefined for another scheme or a missing file.
function filePath(url: string): string | undefined {
  if (!url.startsWith('file:')) return undefined;
  try {
    return fs.realpathSync(fileURLToPath(url));
  } catch {
    // A missing file: resolution or the import reports it.
    return undefined;
  }
}
