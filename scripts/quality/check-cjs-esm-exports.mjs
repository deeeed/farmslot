#!/usr/bin/env node
// Every CommonJS library subpath a package exports must give an ESM importer the same
// names `require()` returns. Node finds CommonJS named exports statically
// (cjs-module-lexer): an export literal it cannot read, such as a member expression
// (`name: other.name`) or a computed `require(path)`, silently drops names, so an ESM
// consumer that compiles against the declarations fails at load with "Named export
// ... not found".
//
// Usage: node scripts/quality/check-cjs-esm-exports.mjs [packageDir...]
// (default: every packages/* workspace). Exit 1 lists each problem.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { isMainModule } from './lib/step-timing.mjs';

// Process entry points (forked children, CLIs): loading one runs it, so they are only
// resolved. Keyed by package name; a listed subpath that no longer resolves to a
// CommonJS file fails.
export const ENTRY_ONLY_EXPORTS = Object.freeze({
  '@farmslot/adapter-web': ['./validation-launch-supervisor'],
  '@farmslot/agent-runtime': ['./scripts/mark-checklist-step.cjs'],
  '@farmslot/skills': ['./scripts/mark-checklist-step.cjs'],
});

// Every string target a subpath can resolve to, across conditions and fallback arrays.
function targetStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(targetStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(targetStrings);
  return [];
}

// Node's format for a resolved file: .cjs, or .js under the nearest package.json without
// `"type": "module"`.
function isCommonJsFile(file) {
  if (file.endsWith('.cjs')) return true;
  if (!file.endsWith('.js')) return false;
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, 'utf8')).type !== 'module';
    if (path.dirname(dir) === dir) return true;
  }
}

// The package's public subpaths: exports keys ("." for string, array or condition sugar),
// or "." from `main` when there is no exports map.
function exportedSubpaths(pkg, packageDir) {
  if (pkg.exports === undefined) {
    if (pkg.main) return [{ subpath: '.', value: pkg.main }];
    // A bin-only package without main or index.js has no library entry.
    return existsSync(path.join(packageDir, 'index.js'))
      ? [{ subpath: '.', value: './index.js' }]
      : [];
  }
  if (typeof pkg.exports !== 'object' || Array.isArray(pkg.exports))
    return [{ subpath: '.', value: pkg.exports }];
  const keys = Object.keys(pkg.exports);
  if (!keys.some((key) => key.startsWith('.'))) return [{ subpath: '.', value: pkg.exports }];
  return keys.map((subpath) => ({ subpath, value: pkg.exports[subpath] }));
}

// The CommonJS subpaths a consumer can `require()`, resolved the way Node resolves them
// (self-reference through the package's own name), plus the problems found on the way.
export function cjsExportTargets(packageDir, entryOnlyExports = ENTRY_ONLY_EXPORTS) {
  const manifest = path.join(packageDir, 'package.json');
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  const entryOnly = new Set(entryOnlyExports[pkg.name] ?? []);
  const requireFromPackage = createRequire(manifest);
  const targets = [];
  const problems = [];
  for (const { subpath, value } of exportedSubpaths(pkg, packageDir)) {
    if (subpath.endsWith('.json')) continue;
    if (subpath.includes('*')) {
      const commonJs = targetStrings(value).some((target) =>
        isCommonJsFile(path.resolve(packageDir, target.replaceAll('*', 'x'))),
      );
      if (commonJs)
        problems.push(
          `${pkg.name}: ${subpath} is a CommonJS wildcard export; list its subpaths so each can be checked`,
        );
      continue;
    }
    const specifier =
      pkg.exports === undefined
        ? path.resolve(packageDir, value)
        : `${pkg.name}${subpath.slice(1)}`;
    let file;
    try {
      file = requireFromPackage.resolve(specifier);
    } catch (error) {
      // An ESM-only subpath has no require() target; it cannot hide CommonJS names.
      if (error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') continue;
      problems.push(`${pkg.name}: ${subpath} does not resolve: ${error.message.split('\n')[0]}`);
      continue;
    }
    if (!isCommonJsFile(file)) continue;
    targets.push({ subpath, specifier, file, entryOnly: entryOnly.has(subpath) });
  }
  const resolved = new Set(targets.map((target) => target.subpath));
  for (const subpath of entryOnly) {
    if (!resolved.has(subpath))
      problems.push(`${pkg.name}: entry-only ${subpath} is not a CommonJS export any more`);
  }
  return { name: pkg.name, targets, problems };
}

const RESULT_MARK = '@@cjs-esm-exports@@';

// Loads one subpath in a plain node process (no loaders from NODE_OPTIONS), from inside
// the package so the specifier self-references it, and prints the require() keys the
// import() namespace lacks on a marked line. The run must also exit 0.
const PROBE = `
const { createRequire } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const [specifier, packageDir] = process.argv.slice(1);
const required = createRequire(path.join(packageDir, 'package.json'))(specifier);
const importable = path.isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier;
import(importable).then(
  (namespace) => Object.keys(required).filter((key) => !(key in namespace)),
  // A require-only subpath is not offered to ESM importers, so it hides nothing from them.
  (error) => {
    if (error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return [];
    throw error;
  },
).then((missing) => {
  process.stdout.write('\\n${RESULT_MARK}' + JSON.stringify(missing) + '\\n');
});
`;

function probe(specifier, packageDir) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, ['-e', PROBE, specifier, packageDir], {
    cwd: packageDir,
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
  const marked = (result.stdout ?? '').split('\n').findLast((line) => line.startsWith(RESULT_MARK));
  if (result.status === 0 && marked)
    return { missing: JSON.parse(marked.slice(RESULT_MARK.length)) };
  const detail = (result.stderr || '').trim();
  const message = detail.match(/^\w*Error(?: \[\w+\])?: (.*)$/mu)?.[1] ?? detail.split('\n')[0];
  return { error: message || `exit ${result.status ?? result.signal}` };
}

export function checkCjsEsmExports(packageDir, { entryOnlyExports = ENTRY_ONLY_EXPORTS } = {}) {
  const { name, targets, problems } = cjsExportTargets(packageDir, entryOnlyExports);
  for (const { subpath, specifier, entryOnly } of targets) {
    if (entryOnly) continue;
    const { missing, error } = probe(specifier, packageDir);
    if (error) problems.push(`${name}: ${subpath} does not load: ${error}`);
    else if (missing.length > 0)
      problems.push(
        `${name}: ${subpath} hides ${missing.length} require() export(s) from ESM import: ${missing.join(', ')}`,
      );
  }
  return problems;
}

function workspacePackageDirs(repoRoot) {
  const root = path.join(repoRoot, 'packages');
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(path.join(root, entry.name, 'package.json')),
    )
    .map((entry) => path.join(root, entry.name))
    .sort();
}

if (isMainModule(import.meta.url)) {
  const dirs = process.argv.slice(2);
  const packageDirs =
    dirs.length > 0 ? dirs.map((dir) => path.resolve(dir)) : workspacePackageDirs(process.cwd());
  const problems = packageDirs.flatMap((dir) => checkCjsEsmExports(dir));
  if (problems.length > 0) {
    console.error('CommonJS exports are not all visible to ESM importers:');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log(`CommonJS/ESM export check passed (${packageDirs.length} package(s)).`);
}
