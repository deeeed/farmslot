#!/usr/bin/env node
// Load the CLI in this process so its signal handlers own the invoked PID.
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(
  root,
  'src',
  process.argv[2] === 'scripted-runner' ? 'scripted-runner-entry.ts' : 'entry.ts',
);

// Ignore a parent runner's relative tsconfig and use this checkout's source mappings.
process.env.TSX_TSCONFIG_PATH = resolve(root, 'tsconfig.json');
// Keep startup cost independent of the accumulated shared transform cache.
process.env.TSX_DISABLE_CACHE = '1';
await import('tsx');
await import(pathToFileURL(entry).href);
