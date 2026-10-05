// The import fence for adapter plugins. A plugin's digest covers the files
// `libraryAdapterFiles` lists (its module's directory and the library's
// actions/), so a plugin may import only those from disk: a module resolve hook
// refuses any import from plugin code that resolves, after symlinks, to another
// file. Bare package specifiers that resolve outside the library (the host's
// install, e.g. @farmslot/adapter-sdk) and `node:` builtins stay allowed. The
// hook stays installed, so imports the plugin makes later, while it runs, are
// fenced too.
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
  /** Real paths of the files its digest covers. */
  files: ReadonlySet<string>;
}

const scopes: PluginImportScope[] = [];
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
      const result = nextResolve(specifier, context);
      assertFenced(specifier, context.parentURL, result.url);
      return result;
    },
  });
  installed = true;
}

function assertFenced(specifier: string, parentURL: string | undefined, url: string): void {
  if (!parentURL?.startsWith('file:') || !url.startsWith('file:')) return;
  const parent = realpath(fileURLToPath(parentURL));
  const owners = scopes.filter((scope) => parent !== undefined && scope.files.has(parent));
  if (owners.length === 0) return;
  const target = realpath(fileURLToPath(url));
  // A file that doesn't exist fails to import on its own.
  if (target === undefined || owners.some((scope) => scope.files.has(target))) return;
  if (isBareSpecifier(specifier) && owners.every((scope) => !isWithin(scope.root, target))) return;
  const owner = owners[0]!;
  throw new RecipeTrustError({
    code: 'RECIPE_SOURCE_INVALID',
    message: `adapter '${owner.id}' (library ${owner.library}) imports ${specifier}, which resolves to ${target}: outside the files its digest covers (its module's directory and the library's actions/).`,
    userAction:
      "keep the plugin's code under its module's directory or the library's actions/, or import a package the host installs",
    reason: 'invalid-source',
  });
}

function isBareSpecifier(specifier: string): boolean {
  return !/^(?:\.{1,2}\/|\/|file:|#)/u.test(specifier) && !path.isAbsolute(specifier);
}

function isWithin(root: string, file: string): boolean {
  return file === root || file.startsWith(`${root}${path.sep}`);
}

function realpath(file: string): string | undefined {
  try {
    return fs.realpathSync(file);
  } catch {
    // A missing file: resolution or the import reports it.
    return undefined;
  }
}
