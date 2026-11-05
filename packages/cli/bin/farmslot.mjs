#!/usr/bin/env node
// Load the CLI in this process so its signal handlers own the invoked PID.
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Agent tool shells can restore a different PATH than the worker launch. Honor
// the machine's configured runtime before loading TSX or opening any connection.
const configuredNodeBin = process.env.FARMSLOT_NODE22_BIN?.trim();
if (configuredNodeBin) {
  const node = realpathSync(
    resolve(configuredNodeBin, process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  if (realpathSync(process.execPath) !== node) {
    if (process.platform === 'win32' || typeof process.execve !== 'function') {
      throw new Error(`Invoke the CLI with its configured Node runtime: ${node}`);
    }
    // Replace this process so PID-only cancellation still reaches the CLI.
    process.execve(node, [node, ...process.execArgv, ...process.argv.slice(1)], process.env);
  }
}

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
