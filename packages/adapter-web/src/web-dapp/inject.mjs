#!/usr/bin/env node
// inject.mjs — `mm-harness install --adapter <web-dapp adapter>`: prepare the slot
// runtime directory and install the wallet fixture the web-dapp actions read.
//
// Inputs: --target <checkout> [--fixture <wallet-fixture.json>] [--force]
//   env RECIPE_WALLET_FIXTURE (fixture source when --fixture is absent)
// Outputs: <target>/<harness root>/<adapter id>/install.json (overlay marker),
//   <target>/<runtime>/<adapter id>/ (0700), <runtime>/wallet-fixture.json (0600);
//   JSON summary on stdout (account names only). Exit 0 installed; 1 failure; 2 usage.
// Never touches: product source files; never prints key material.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recipeHarnessPath, recipeRuntimeDir, walletFixturePath } from './lib/paths.mjs';
import { webDappPolicy, webDappRuntimeDir } from './lib/runtime.mjs';

const usage = 'Usage: inject.mjs --target <checkout> [--fixture <wallet-fixture.json>] [--force]';

export function installWebDappRuntime({ target, fixture, force = false }) {
  const root = path.resolve(target);
  const { adapterId, checkout } = webDappPolicy();
  if (!checkout.matches(root))
    throw new Error(`${root} is not a ${checkout.name} checkout (needs ${checkout.needs}).`);
  mkdirSync(path.join(root, recipeRuntimeDir()), { recursive: true, mode: 0o700 });
  mkdirSync(webDappRuntimeDir(root), { recursive: true, mode: 0o700 });
  const destination = walletFixturePath(root);
  let fixtureAction = 'kept';
  if (fixture && (force || !existsSync(destination))) {
    const parsed = JSON.parse(readFileSync(fixture, 'utf8'));
    if (!Array.isArray(parsed.accounts) || parsed.accounts.length === 0)
      throw new Error(`${fixture} has no accounts.`);
    copyFileSync(fixture, destination);
    chmodSync(destination, 0o600);
    fixtureAction = 'installed';
  } else if (!existsSync(destination)) {
    fixtureAction = 'missing';
  }
  const accounts = existsSync(destination)
    ? JSON.parse(readFileSync(destination, 'utf8'))
        .accounts.map((account) => account?.name)
        .filter(Boolean)
    : [];
  const marker = {
    schemaVersion: 1,
    adapter: adapterId,
    installedAt: new Date().toISOString(),
    fixture: fixtureAction,
  };
  // The overlay directory is the install marker run/call auto-ensure checks.
  const overlay = recipeHarnessPath(root, adapterId);
  mkdirSync(overlay, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(overlay, 'install.json'), `${JSON.stringify(marker, null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    status: fixtureAction === 'missing' ? 'fail' : 'pass',
    target: root,
    fixture: fixtureAction,
    fixturePath: destination,
    accounts,
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
  try {
    const result = installWebDappRuntime({
      target: value('--target') ?? process.cwd(),
      fixture: value('--fixture') ?? process.env.RECIPE_WALLET_FIXTURE,
      force: argv.includes('--force'),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'pass') {
      process.stderr.write(
        'No wallet fixture installed. Next: set RECIPE_WALLET_FIXTURE or pass --fixture <wallet-fixture.json>.\n',
      );
      process.exit(1);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
