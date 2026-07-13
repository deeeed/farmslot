#!/usr/bin/env node
// farmslot CLI bootstrapper — registers tsx loader then runs entry.ts
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(
  root,
  'src',
  process.argv[2] === 'scripted-runner' ? 'scripted-runner-entry.ts' : 'entry.ts',
);

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

// A parent tsx process (test runners, scripts run via run-tsx-tests.mjs)
// exports TSX_TSCONFIG_PATH relative to ITS cwd; inheriting it makes the CLI
// resolve a tsconfig that does not exist here. Always use our own resolution.
const env = { ...process.env };
delete env.TSX_TSCONFIG_PATH;

try {
  // Pin our tsconfig: its paths map @farmslot/* to workspace src, so the CLI
  // runs without built dist artifacts (fresh checkouts, CI jobs).
  const tsconfig = resolve(root, 'tsconfig.json');
  execFileSync(findBin('tsx'), ['--tsconfig', tsconfig, entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
  });
} catch (e) {
  process.exit(e.status ?? 1);
}
