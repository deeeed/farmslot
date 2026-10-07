#!/usr/bin/env node
// stop.mjs — stop the web-dapp slot browser, wallet host and console collector, verify the CDP port
// is free. Idempotent: nothing running is success.
//
// Inputs: --target <checkout> [--cdp-port <port>] [--json]
// Outputs: JSON summary on stdout. Exit 0 stopped/nothing to stop; 1 port still owned.
// Never touches: the Next.js dev server (Farmslot owns it), browser profiles.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stopConsoleCollector, stopWebDappBrowser } from './lib/processes.mjs';
import { webDappPolicy } from './lib/runtime.mjs';

const usage = 'Usage: stop.mjs --target <checkout> [--cdp-port <port>] [--json]';

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
  const target = value('--target') ?? process.cwd();
  const rawPort = value('--cdp-port') ?? process.env.RECIPE_CDP_PORT ?? process.env.CDP_PORT;
  try {
    const log = (message) =>
      process.stderr.write(`[${webDappPolicy().adapterId}/stop] ${message}\n`);
    const result = await stopWebDappBrowser(target, {
      cdpPort: rawPort ? Number(rawPort) : undefined,
      log,
    });
    const collector = await stopConsoleCollector(target, { log });
    process.stdout.write(
      `${JSON.stringify({ status: 'pass', ...result, consoleCollector: collector })}\n`,
    );
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'fail', error: error.message })}\n`);
    process.exit(1);
  }
}
