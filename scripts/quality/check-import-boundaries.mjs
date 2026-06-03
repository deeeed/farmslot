#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const violations = [];
const servicePackages = new Set(['@farmslot/gateway', '@farmslot/node']);
const importPattern =
  /(?:from\s*['"]([^'"]+)['"]|import\s+(?:type\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"])/g;

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot });
  return output.toString('utf8').split('\0').filter(Boolean);
}

function isSourceFile(relativePath) {
  return /\.(?:cjs|js|jsx|mjs|ts|tsx)$/i.test(relativePath);
}

function isIgnored(relativePath) {
  return (
    relativePath.includes('/node_modules/') ||
    relativePath.includes('/dist/') ||
    relativePath.includes('/build/') ||
    relativePath.includes('/coverage/') ||
    relativePath.startsWith('apps/docs/build/')
  );
}

function resolveSpecifierOwner(fromFile, specifier) {
  for (const servicePackage of servicePackages) {
    if (specifier === servicePackage || specifier.startsWith(`${servicePackage}/`)) {
      return servicePackage;
    }
  }
  if (specifier.startsWith('apps/')) return 'apps';
  if (specifier.startsWith('services/')) return 'services';
  if (specifier.startsWith('packages/')) return 'packages';
  if (!specifier.startsWith('.')) return null;

  const resolved = path
    .normalize(path.join(path.dirname(fromFile), specifier))
    .split(path.sep)
    .join('/');
  if (resolved.startsWith('../')) return null;
  if (resolved.startsWith('apps/')) return 'apps';
  if (resolved.startsWith('services/')) return 'services';
  if (resolved.startsWith('packages/')) return 'packages';
  return null;
}

function sourceLayer(relativePath) {
  if (/^packages\/[^/]+\/src\//.test(relativePath)) return 'package';
  if (/^services\/[^/]+\/src\//.test(relativePath)) return 'service';
  if (/^apps\/[^/]+\/(?:src|ui\/src)\//.test(relativePath)) return 'app';
  return null;
}

function checkImport(relativePath, specifier) {
  const layer = sourceLayer(relativePath);
  if (!layer) return;
  const owner = resolveSpecifierOwner(relativePath, specifier);

  if (
    layer === 'package' &&
    (owner === 'apps' || owner === 'services' || servicePackages.has(owner))
  ) {
    violations.push(`${relativePath}: package source must not import ${specifier}`);
  }
  if (layer === 'service' && owner === 'apps') {
    violations.push(`${relativePath}: service source must not import app code via ${specifier}`);
  }
  if (layer === 'app' && (owner === 'services' || servicePackages.has(owner))) {
    violations.push(
      `${relativePath}: app source must use shared packages/protocols, not service internals via ${specifier}`,
    );
  }
}

for (const relativePath of trackedFiles()) {
  if (!isSourceFile(relativePath) || isIgnored(relativePath)) continue;
  const source = readFileSync(path.join(repoRoot, relativePath), 'utf8');
  for (const match of source.matchAll(importPattern)) {
    checkImport(relativePath, match[1] ?? match[2] ?? match[3] ?? match[4]);
  }
}

if (violations.length > 0) {
  console.error('Import boundary guard failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log('Import boundary guard passed.');
