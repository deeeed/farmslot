#!/usr/bin/env node
// verify.mjs — `mm-harness verify --adapter <web-dapp adapter>`: read-only readiness of a
// web-dapp slot (checkout, deps, dev server, forced testnet, fixture,
// browser start probe, the extension signer's own checks, CDP port).
//
// Inputs: --target <checkout> [--cdp-port <port>] [--watcher-port <app port>]
//   [--signer extension|injected] [--signer-module <path>] [--account <name>] [--json]
// Outputs: readiness JSON (or a human summary) on stdout. Exit 0 ready; 1 not ready.
// Never launches the slot browser or the dev server.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { webDappReadiness } from './lib/readiness.mjs';
import { webDappPolicy } from './lib/runtime.mjs';
import { defaultSigner, loadSigners, SIGNER_MODULE_ENV } from './lib/signers.mjs';
import { resolveBrowser } from './launch.mjs';

const usage =
  'Usage: verify.mjs --target <checkout> [--cdp-port <port>] [--watcher-port <app port>] [--signer extension|injected] [--signer-module <path>] [--account <name>] [--json]';

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
  const num = (raw) => (raw && /^\d+$/u.test(raw) ? Number(raw) : undefined);
  const policy = webDappPolicy();
  const signerModule = value('--signer-module');
  const signers = await loadSigners({
    ...process.env,
    ...(signerModule ? { [SIGNER_MODULE_ENV]: signerModule } : {}),
  });
  const report = await webDappReadiness({
    policy,
    signers,
    target: path.resolve(value('--target') ?? process.cwd()),
    appPort: num(
      value('--watcher-port') ?? process.env.TERMINAL_APP_PORT ?? process.env.WATCHER_PORT,
    ),
    cdpPort: num(value('--cdp-port') ?? process.env.RECIPE_CDP_PORT ?? process.env.CDP_PORT),
    signer: value('--signer') ?? process.env.TERMINAL_SIGNER ?? defaultSigner(signerModule),
    account: value('--account') ?? process.env.TERMINAL_ACCOUNT ?? 'dev1',
    probeBrowser: resolveBrowser,
  });
  if (argv.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, command: 'verify', adapter: policy.adapterId, ...report }, null, 2)}\n`,
    );
  } else {
    for (const check of report.checks) {
      const mark =
        check.status === 'pass' ? '✓' : check.status === 'warn' || !check.required ? '·' : '✗';
      process.stdout.write(`${mark} ${check.id}: ${check.detail}\n`);
    }
    process.stdout.write(
      report.status === 'pass'
        ? `${policy.adapterId} slot ready\n`
        : `not ready: ${report.failed.join(', ')}\n`,
    );
  }
  process.exit(report.status === 'pass' ? 0 : 1);
}
