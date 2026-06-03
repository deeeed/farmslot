#!/usr/bin/env node
// farmslot CLI bootstrapper — registers tsx loader then runs entry.ts
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'src', 'entry.ts');

// Walk up to find tsx binary in node_modules/.bin (handles yarn hoisting)
function findBin(name) {
  let dir = root;
  while (true) {
    const bin = resolve(dir, 'node_modules', '.bin', name);
    if (existsSync(bin)) return bin;
    const parent = dirname(dir);
    if (parent === dir) return name; // fallback to PATH
    dir = parent;
  }
}

try {
  execFileSync(findBin('tsx'), [entry, ...process.argv.slice(2)], { stdio: 'inherit' });
} catch (e) {
  process.exit(e.status ?? 1);
}
