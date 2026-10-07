#!/usr/bin/env node
// cleanup.mjs — `mm-harness cleanup --adapter <web-dapp adapter>`: stop the slot
// browser and wallet host, then remove the slot's runtime state and the installed
// wallet fixture. Browser profiles are kept unless --reset-profile.
//
// Inputs: --target <checkout> [--cdp-port <port>] [--reset-profile]
// Outputs: JSON summary on stdout. Exit 0 cleaned; 1 the CDP port stayed busy.
// Never touches: product source files, the Next.js dev server.

import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recipeHarnessPath, walletFixturePath } from './lib/paths.mjs';
import { stopConsoleCollector, stopWebDappBrowser } from './lib/processes.mjs';
import { webDappPolicy, webDappRuntimeDir } from './lib/runtime.mjs';

const usage = 'Usage: cleanup.mjs --target <checkout> [--cdp-port <port>] [--reset-profile]';

export async function cleanupWebDappRuntime({ target, cdpPort, resetProfile = false }) {
  const root = path.resolve(target);
  const stop = await stopWebDappBrowser(root, { cdpPort });
  await stopConsoleCollector(root);
  const runtime = webDappRuntimeDir(root);
  const removed = [];
  if (existsSync(runtime)) {
    for (const entry of readdirSync(runtime)) {
      if (entry.startsWith('profile-') && !resetProfile) continue;
      rmSync(path.join(runtime, entry), { recursive: true, force: true });
      removed.push(entry);
    }
  }
  const overlay = recipeHarnessPath(root, webDappPolicy().adapterId);
  if (existsSync(overlay)) {
    rmSync(overlay, { recursive: true, force: true });
    removed.push(path.relative(root, overlay));
  }
  const fixture = walletFixturePath(root);
  if (existsSync(fixture)) {
    rmSync(fixture, { force: true });
    removed.push(path.relative(root, fixture));
  }
  return {
    status: 'pass',
    target: root,
    stopped: stop.stopped,
    cdpPortFree: stop.cdpPortFree,
    removed,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  }
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const rawPort = value('--cdp-port') ?? process.env.RECIPE_CDP_PORT ?? process.env.CDP_PORT;
  try {
    const result = await cleanupWebDappRuntime({
      target: value('--target') ?? process.cwd(),
      cdpPort: rawPort ? Number(rawPort) : undefined,
      resetProfile: argv.includes('--reset-profile'),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'fail', error: error.message })}\n`);
    process.exit(1);
  }
}
