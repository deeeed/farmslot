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
import path from 'node:path';

import { isMainModule } from './lib/step-timing.mjs';

// Process entry points (forked children, CLIs): loading one runs it, so they are only
// resolved. Keyed by package name; a listed subpath the package no longer exports fails.
export const ENTRY_ONLY_EXPORTS = Object.freeze({
  '@farmslot/adapter-web': ['./validation-launch-supervisor'],
  '@farmslot/agent-runtime': ['./scripts/mark-checklist-step.cjs'],
  '@farmslot/skills': ['./scripts/mark-checklist-step.cjs'],
});

function exportTarget(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  return exportTarget(value.require ?? value.node ?? value.default);
}

function isCommonJsFile(file, packageType) {
  if (file.endsWith('.cjs')) return true;
  return file.endsWith('.js') && packageType !== 'module';
}

// The CommonJS subpaths of a package's exports map.
export function cjsExportTargets(packageDir, entryOnlyExports = ENTRY_ONLY_EXPORTS) {
  const pkg = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const exportsMap =
    typeof pkg.exports === 'string' || Array.isArray(pkg.exports)
      ? { '.': pkg.exports }
      : (pkg.exports ?? {});
  const entryOnly = new Set(entryOnlyExports[pkg.name] ?? []);
  const targets = [];
  for (const [subpath, value] of Object.entries(exportsMap)) {
    const target = exportTarget(value);
    if (!target || !isCommonJsFile(target, pkg.type)) continue;
    targets.push({
      subpath,
      file: path.resolve(packageDir, target),
      wildcard: subpath.includes('*'),
      entryOnly: entryOnly.has(subpath),
    });
  }
  return { name: pkg.name, targets, entryOnly: [...entryOnly] };
}

// Loads one library subpath in a plain node process (no loaders from NODE_OPTIONS) and
// prints the require() keys the import() namespace lacks, as JSON.
const PROBE = `
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const file = process.argv[1];
const required = createRequire(file)(file);
import(pathToFileURL(file).href).then((namespace) => {
  process.stdout.write(JSON.stringify(Object.keys(required).filter((key) => !(key in namespace))));
});
`;

function probe(file, cwd) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, ['-e', PROBE, file], {
    cwd,
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
  try {
    return { missing: JSON.parse(result.stdout) };
  } catch {
    const detail = (result.stderr || result.stdout || '').trim();
    const message = detail.match(/^\w*Error: (.*)$/mu)?.[1] ?? detail.split('\n')[0];
    return { error: message || `exit ${result.status ?? result.signal}` };
  }
}

export function checkCjsEsmExports(packageDir, { entryOnlyExports = ENTRY_ONLY_EXPORTS } = {}) {
  const { name, targets, entryOnly } = cjsExportTargets(packageDir, entryOnlyExports);
  const problems = [];
  const exported = new Set(targets.map((target) => target.subpath));
  for (const subpath of entryOnly) {
    if (!exported.has(subpath))
      problems.push(`${name}: entry-only ${subpath} is not a CommonJS export any more`);
  }
  const library = [];
  for (const target of targets) {
    if (target.wildcard) {
      problems.push(
        `${name}: ${target.subpath} is a CommonJS wildcard export; list its subpaths so each can be checked`,
      );
    } else if (!existsSync(target.file)) {
      problems.push(`${name}: ${target.subpath} points at a missing file`);
    } else if (!target.entryOnly) {
      library.push(target);
    }
  }
  for (const { subpath, file } of library) {
    const { missing, error } = probe(file, packageDir);
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
