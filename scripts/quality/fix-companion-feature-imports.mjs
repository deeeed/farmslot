#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FEATURES_ROOT = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../apps/companion/src/features',
);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(full);
  }
  return files;
}

function depthToSrc(file) {
  const rel = path.relative(FEATURES_ROOT, file);
  const segments = rel.split(path.sep);
  // features/<feature>/... -> src is ../../.. from components, ../.. from screen root
  const depth = segments.length; // e.g. diff/components/x.tsx => 3 segments
  return '../'.repeat(depth);
}

for (const file of walk(FEATURES_ROOT)) {
  const prefix = depthToSrc(file);
  let content = readFileSync(file, 'utf8');
  const normalized = content.replace(
    /from '(?:\.\.\/)+(components|lib|store)/g,
    `from '${prefix}$1`,
  );
  if (normalized !== content) {
    writeFileSync(file, normalized);
    console.log('fixed', path.relative(FEATURES_ROOT, file), '->', prefix);
  }
}
