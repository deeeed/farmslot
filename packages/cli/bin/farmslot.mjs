#!/usr/bin/env node
// Load the CLI in this process so its signal handlers own the invoked PID.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
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
// A task invokes its retained installation directly, outside the original checkout.
// Recover that installation's home before the entry loads checkout env or state.
if (!process.env.FARMSLOT_HOME?.trim()) {
  for (let directory = root; dirname(directory) !== directory; directory = dirname(directory)) {
    const store = dirname(dirname(directory));
    if (basename(directory) !== 'cli' || basename(store) !== 'task-pins') continue;
    let home = dirname(store);
    const marker = resolve(home, '../config/instance.json');
    if (basename(home) === 'state' && existsSync(marker)) {
      const config = JSON.parse(readFileSync(marker, 'utf8'));
      if (config.layout === 2) home = dirname(home);
    }
    process.env.FARMSLOT_HOME = home;
    break;
  }
}
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
