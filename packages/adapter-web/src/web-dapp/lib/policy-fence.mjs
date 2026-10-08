// The venue policy module runs outside the plugin loader's import fence: the
// host and every web-dapp leaf process require it by path. So mm-harness checks
// it itself when it binds the adapter: the policy file and everything it
// imports must be files the plugin digest covers (the loader's
// libraryAdapterFiles, by real path), and imports must be literal relative
// paths or node built-ins. The digest of those files goes in
// RECIPE_WEB_DAPP_POLICY_DIGEST, and a process that loads the policy with it
// set refuses files that changed since.
//
// The source scan only lists the files to digest; it can miss an import (an
// aliased require, say, in a branch only a leaf takes). So a process that loads
// the policy also fences its imports at run time, as the plugin loader does: a
// resolve hook refuses any import from those files that resolves outside them,
// while the process runs. It fences imports, not code: it is no sandbox for
// code the plugin digest already covers.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import nodeModule, { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const POLICY_DIGEST_ENV = 'RECIPE_WEB_DAPP_POLICY_DIGEST';

export class PolicyFenceError extends Error {
  constructor(message) {
    super(message);
    this.code = 'ADAPTER_PLUGIN_INVALID';
    this.userAction =
      "keep the venue policy and every file it imports in the plugin module's directory (or the library's actions/), importing node built-ins and literal relative paths only";
  }
}

const STATIC_IMPORT = /(?:^|[\s;])(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/gu;
const BARE_IMPORT = /(?:^|[\s;])import\s*(['"])([^'"]+)\1/gu;
const LITERAL_CALL = /(?<![.\w$])(?:import|require)\s*\(\s*(['"])([^'"]+)\1\s*\)/gu;
const ANY_CALL = /(?<![.\w$])(?:import|require)\s*\(/gu;

// Whole-line comments may mention imports and are dropped. Nothing else is: a
// block or trailing comment that mentions an import is read as one and refused,
// so the scan errs on the side of refusing, never of missing an import.
function stripComments(source) {
  return source.replace(/^\s*\/\/.*$/gmu, '');
}

function specifiers(source, file) {
  const code = stripComments(source);
  const found = [];
  for (const pattern of [STATIC_IMPORT, BARE_IMPORT, LITERAL_CALL]) {
    for (const match of code.matchAll(pattern)) found.push(match[2]);
  }
  const literalCalls = [...code.matchAll(LITERAL_CALL)].length;
  if ([...code.matchAll(ANY_CALL)].length > literalCalls) {
    throw new PolicyFenceError(
      `web-dapp venue policy file ${file} imports or requires a computed specifier, which the host can't check.`,
    );
  }
  return found;
}

function realFile(file) {
  try {
    const real = fs.realpathSync(file);
    if (fs.statSync(real).isFile()) return real;
  } catch {
    // reported below
  }
  return undefined;
}

/**
 * The real paths of the policy module and every file it imports, in import
 * order. `allowed(real)` decides each file; relative specifiers resolve
 * against the importer's real path, as Node does.
 */
function policyClosure(file, allowed) {
  const start = realFile(path.resolve(file));
  if (!start) throw new PolicyFenceError(`web-dapp venue policy file ${file} does not exist.`);
  const seen = new Set();
  const visit = (real) => {
    if (seen.has(real)) return;
    allowed(real);
    seen.add(real);
    for (const specifier of specifiers(fs.readFileSync(real, 'utf8'), real)) {
      if (specifier.startsWith('node:') || isBuiltin(specifier)) continue;
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        throw new PolicyFenceError(
          `web-dapp venue policy file ${real} imports '${specifier}', which is neither a node built-in nor a relative path the plugin digest covers.`,
        );
      }
      const target = realFile(path.resolve(path.dirname(real), specifier));
      if (!target)
        throw new PolicyFenceError(
          `web-dapp venue policy file ${real} imports '${specifier}', which does not resolve to a file.`,
        );
      visit(target);
    }
  };
  visit(start);
  return [...seen];
}

function digestFiles(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    hash.update(file).update('\0').update(fs.readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}

/**
 * Check a policy module against `covered`, the real paths of the files the
 * plugin digest covers, and return the digest of the policy's files. Throws
 * PolicyFenceError when one of them is not covered.
 */
export function fencePolicy({ file, covered, scope }) {
  const allowed = (real) => {
    if (!covered.has(real)) {
      throw new PolicyFenceError(
        `web-dapp venue policy file ${real} is outside the files the plugin digest covers (${scope}).`,
      );
    }
  };
  return digestFiles(policyClosure(file, allowed));
}

/**
 * Refuse a policy whose files changed since mm-harness bound it (`digest`).
 * Returns the real paths of the files it digested.
 */
export function assertPolicyDigest(file, digest) {
  const files = policyClosure(file, () => {});
  if (digestFiles(files) !== digest) {
    throw new Error(
      `web-dapp venue policy ${file} or a file it imports changed since the host bound it.\n` +
        'Next: rerun the command, so it binds and checks the policy again.',
    );
  }
  return files;
}

// The real paths of the files of each policy this process loaded.
const fenced = [];
let hookInstalled = false;

/**
 * Before a process loads the policy at `file`: check its files against
 * `digest` when the host bound one, and refuse, from then on, any import from
 * those files that resolves outside them.
 */
export function fencePolicyImports(file, digest) {
  if (typeof nodeModule.registerHooks !== 'function') {
    throw new Error(
      `web-dapp needs Node.js 22.15 or later (module.registerHooks fences the venue policy's imports); this is ${process.version}.`,
    );
  }
  fenced.push(new Set(digest ? assertPolicyDigest(file, digest) : policyClosure(file, () => {})));
  if (hookInstalled) return;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = realPath(context.parentURL);
      const owners = parent === undefined ? [] : fenced.filter((files) => files.has(parent));
      if (owners.length === 0 || isBuiltin(specifier)) return nextResolve(specifier, context);
      const result = nextResolve(specifier, context);
      const target = realPath(result.url);
      if (target !== undefined && owners.some((files) => files.has(target))) return result;
      throw new PolicyFenceError(
        `web-dapp venue policy file ${parent} imports '${specifier}', which resolves to ${target ?? result.url}: outside the policy files the host digested.`,
      );
    },
  });
  hookInstalled = true;
}

// The real path behind a file: URL; undefined for another scheme or a missing file.
function realPath(url) {
  if (!url?.startsWith('file:')) return undefined;
  try {
    return fs.realpathSync(fileURLToPath(url));
  } catch {
    return undefined;
  }
}
