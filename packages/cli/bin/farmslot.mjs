#!/usr/bin/env node
// Load the CLI in this process so its signal handlers own the invoked PID.
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
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
function findPinHome(executable, canonical) {
  for (
    let directory = resolve(dirname(executable), '..');
    dirname(directory) !== directory;
    directory = dirname(directory)
  ) {
    const store = dirname(dirname(directory));
    if (basename(directory) !== 'cli' || basename(store) !== 'task-pins') continue;
    const pinCli = resolve(directory, 'packages/cli/bin/farmslot.mjs');
    if (!existsSync(pinCli) || realpathSync(pinCli) !== canonical) continue;
    let home = dirname(store);
    const marker = resolve(home, '../config/instance.json');
    if (basename(home) === 'state' && existsSync(marker)) {
      const config = JSON.parse(readFileSync(marker, 'utf8'));
      if (config.layout === 2) home = dirname(home);
    }
    return home;
  }
}

// Recover the retained installation's home before loading checkout env or state.
if (!process.env.FARMSLOT_HOME?.trim()) {
  const canonical = realpathSync(fileURLToPath(import.meta.url));
  let executable = resolve(process.argv[1]);
  let home = findPinHome(executable, canonical);
  if (!home) {
    // Follow file links first so directory links can retain the logical farm home.
    while (!home && executable !== canonical) {
      executable = lstatSync(executable).isSymbolicLink()
        ? resolve(realpathSync(dirname(executable)), readlinkSync(executable))
        : canonical;
      home = findPinHome(executable, canonical);
    }
  }
  if (home) process.env.FARMSLOT_HOME = home;
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
const prebuilt = prebuiltRevision();
if (prebuilt) {
  // An installed snapshot built its own sources at install time (build-prebuilt.mjs): load those
  // instead of transforming every module on each call. TSX stays registered for TypeScript from
  // outside the CLI, such as a project's own scripts.
  const hooks = pathToFileURL(resolve(root, 'bin/prebuilt-resolve.mjs'));
  const data = {
    root: resolve(root, '../..'),
    paths: prebuiltPaths(),
    commonjs: commonjsPackages(),
  };
  const { register, registerHooks } = await import('node:module');
  if (registerHooks) {
    const { initialize, resolveSync, loadSync } = await import(hooks.href);
    initialize(data);
    registerHooks({ resolve: resolveSync, load: loadSync });
  } else register(hooks, { data });
  await import(pathToFileURL(entry.replace(/\.ts$/, '.js')).href);
} else await import(pathToFileURL(entry).href);

/**
 * The deployed revision when this snapshot's prebuilt sources were built for it, otherwise
 * undefined. A checkout has no DEPLOYED-REVISION.json, so it always runs from source.
 */
function prebuiltRevision() {
  const deployed = resolve(root, '../../DEPLOYED-REVISION.json');
  const built = resolve(root, 'PREBUILT.json');
  if (process.env.FARMSLOT_CLI_FROM_SOURCE === '1' || !existsSync(deployed) || !existsSync(built))
    return undefined;
  const { sha } = JSON.parse(readFileSync(deployed, 'utf8'));
  const { revision } = JSON.parse(readFileSync(built, 'utf8'));
  return sha && sha === revision ? sha : undefined;
}

/** Workspace packages whose plain .js files Node reads as CommonJS (no `"type": "module"`). */
function commonjsPackages() {
  const packages = resolve(root, '..');
  return readdirSync(packages).filter((name) => {
    const manifest = resolve(packages, name, 'package.json');
    return existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).type !== 'module';
  });
}

/** The CLI tsconfig's `paths`, resolved to absolute targets, as TSX applies them. */
function prebuiltPaths() {
  const { compilerOptions } = JSON.parse(readFileSync(resolve(root, 'tsconfig.json'), 'utf8'));
  return Object.entries(compilerOptions.paths ?? {}).map(([pattern, [target]]) => ({
    pattern,
    target: resolve(root, target),
  }));
}
