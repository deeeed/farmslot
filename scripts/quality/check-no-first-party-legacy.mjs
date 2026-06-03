#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const roots = ['packages', 'apps/command-center/ui/src', 'scripts'];
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
const violations = [];

function hasSourceExtension(path) {
  return [...sourceExtensions].some((extension) => path.endsWith(extension));
}

function isFirstPartySourcePath(path) {
  const normalized = path.split(sep).join('/');
  return (
    normalized.startsWith('scripts/') ||
    normalized.startsWith('packages/') ||
    normalized.startsWith('apps/command-center/ui/src/') ||
    /^packages\/[^/]+\/src\//.test(normalized)
  );
}

function walk(absDir) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const absPath = join(absDir, entry.name);
    const relPath = relative(repoRoot, absPath);
    const normalizedRelPath = relPath.split(sep).join('/');

    if (entry.isDirectory()) {
      walk(absPath);
      continue;
    }
    if (!entry.isFile()) continue;

    if (
      normalizedRelPath !== 'scripts/quality/check-no-first-party-legacy.mjs' &&
      isFirstPartySourcePath(relPath) &&
      /(^|[/_-])legacy([._/-]|$)/i.test(normalizedRelPath)
    ) {
      violations.push(`${normalizedRelPath}: first-party source path contains "legacy"`);
    }

    if (!hasSourceExtension(entry.name) || !isFirstPartySourcePath(relPath)) continue;
    const source = readFileSync(absPath, 'utf8');
    const importPattern = /(?:from\s+|import\s*\(\s*)['"]([^'"]*legacy[^'"]*)['"]/gi;
    for (const match of source.matchAll(importPattern)) {
      violations.push(`${normalizedRelPath}: import path contains "legacy" (${match[1]})`);
    }
  }
}

for (const root of roots) {
  const absRoot = join(repoRoot, root);
  try {
    if (statSync(absRoot).isDirectory()) walk(absRoot);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

if (violations.length > 0) {
  console.error('First-party legacy path/import guard failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log('First-party legacy path/import guard passed.');
