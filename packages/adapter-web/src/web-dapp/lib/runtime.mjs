// Resolve the web-dapp slot runtime: the venue policy, ports, runtime paths,
// browser state and wallet-fixture accounts. Key material is only ever
// returned as a viem account object; callers must never log or persist it.

import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { recipeRuntimeDir, walletFixturePath } from './paths.mjs';
import { POLICY_ENV, webDappAdapterId, webDappPolicy } from './policy.mjs';
import { loadViemAccounts } from './viem.mjs';

export { POLICY_ENV, webDappAdapterId, webDappPolicy };

export const SIGNER_MODES = Object.freeze(['extension', 'injected']);
export const DEFAULT_ACCOUNT = 'dev1';

// The checkout's canonical path: a symlinked or /tmp-vs-/private/tmp spelling
// of the same slot must name the same runtime dir, profile and pid owners.
export function canonicalPath(target) {
  const resolved = path.resolve(target);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// <checkout>/<runtime>/<adapter id>, e.g. temp/recipe/runtime/terminal.
export function webDappRuntimeDir(projectRoot) {
  return path.join(canonicalPath(projectRoot), recipeRuntimeDir(), webDappPolicy().adapterId);
}

export function webDappRuntimePath(projectRoot, ...segments) {
  return path.join(webDappRuntimeDir(projectRoot), ...segments);
}

function portFrom(raw, label) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${label} must be a TCP port, got ${JSON.stringify(raw)}.`);
  }
  return port;
}

// The slot's Next.js dev server. Farmslot passes it as --watcher-port {{port}};
// TERMINAL_APP_PORT is the explicit override.
export function appPort(input = {}, env = process.env) {
  const port =
    portFrom(input.node?.app_port, 'app_port') ??
    portFrom(env.TERMINAL_APP_PORT, 'TERMINAL_APP_PORT') ??
    portFrom(env.RECIPE_WATCHER_PORT, 'RECIPE_WATCHER_PORT') ??
    portFrom(env.WATCHER_PORT, 'WATCHER_PORT');
  if (!port) {
    throw new Error(
      `${webDappPolicy().adapterId} adapter requires the slot dev-server port.\n` +
        'Next: pass --watcher-port <port> (Farmslot: {{port}}) or set TERMINAL_APP_PORT.',
    );
  }
  return port;
}

export function appOrigin(input = {}, env = process.env) {
  return `http://localhost:${appPort(input, env)}`;
}

export function cdpPort(input = {}, env = process.env) {
  const port =
    portFrom(input.node?.cdp_port, 'cdp_port') ??
    portFrom(env.RECIPE_CDP_PORT, 'RECIPE_CDP_PORT') ??
    portFrom(env.CDP_PORT, 'CDP_PORT');
  if (!port) {
    throw new Error(
      `${webDappPolicy().adapterId} adapter requires a per-slot browser CDP port.\n` +
        'Next: pass --cdp-port <port> (Farmslot: {{cdp_port}}).',
    );
  }
  return port;
}

export async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writePrivateJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function readBrowserState(projectRoot) {
  return readJsonFile(webDappRuntimePath(projectRoot, 'browser.json'));
}

export function resolveSigner(raw, fallback = 'extension') {
  const signer = raw == null || raw === '' ? fallback : String(raw);
  if (!SIGNER_MODES.includes(signer)) {
    throw new Error(
      `signer must be one of ${SIGNER_MODES.join(' | ')}, got ${JSON.stringify(raw)}.`,
    );
  }
  return signer;
}

// Account name precedence: node.account_name → node.account (when not an
// address) → the running browser's account → dev1.
export function accountName(input = {}, browserState = null) {
  const explicit = input.node?.account_name ?? input.node?.account;
  if (
    typeof explicit === 'string' &&
    explicit.trim() &&
    !/^0x[0-9a-fA-F]{40}$/u.test(explicit.trim())
  ) {
    return explicit.trim();
  }
  return browserState?.account?.name ?? DEFAULT_ACCOUNT;
}

export function fixturePath(projectRoot, env = process.env) {
  return env.RECIPE_WALLET_FIXTURE
    ? path.resolve(env.RECIPE_WALLET_FIXTURE)
    : walletFixturePath(projectRoot);
}

export async function loadWalletFixture(projectRoot, env = process.env) {
  const file = fixturePath(projectRoot, env);
  const fixture = await readJsonFile(file);
  if (!fixture) {
    throw new Error(
      `wallet fixture not found at ${file}.\n` +
        `Next: run the host's install command (--adapter ${webDappPolicy().adapterId} --target <checkout>) with RECIPE_WALLET_FIXTURE set, or copy the fixture there (0600).`,
    );
  }
  if (!Array.isArray(fixture.accounts) || fixture.accounts.length === 0) {
    throw new Error(`wallet fixture at ${file} has no accounts.`);
  }
  return { file, fixture };
}

export function fixtureEntry(fixture, name) {
  const entry = fixture.accounts.find((account) => account?.name === name);
  if (!entry) {
    const names = fixture.accounts
      .map((account) => account?.name)
      .filter(Boolean)
      .join(', ');
    throw new Error(`wallet fixture has no account named "${name}". Available: ${names}.`);
  }
  if (entry.type !== 'mnemonic' && entry.type !== 'privateKey') {
    throw new Error(
      `wallet fixture account "${name}" must be mnemonic or privateKey, got "${entry.type}".`,
    );
  }
  if (typeof entry.value !== 'string' || !entry.value.trim()) {
    throw new Error(`wallet fixture account "${name}" has no value.`);
  }
  return entry;
}

// Mnemonics use BIP-44 index 0, the MetaMask default and the derivation the
// Extension fixture flow imports.
export function viemAccountFromEntry(entry, projectRoot) {
  const { mnemonicToAccount, privateKeyToAccount } = loadViemAccounts(projectRoot);
  if (entry.type === 'mnemonic') return mnemonicToAccount(entry.value.trim(), { addressIndex: 0 });
  const raw = entry.value.trim();
  const key = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/u.test(key)) {
    throw new Error(`wallet fixture privateKey account "${entry.name}" is not a 32-byte hex key.`);
  }
  return privateKeyToAccount(key);
}

export async function fixtureAccount(projectRoot, name, env = process.env) {
  const { fixture } = await loadWalletFixture(projectRoot, env);
  return viemAccountFromEntry(fixtureEntry(fixture, name), projectRoot);
}

// Address-only view of the account a node targets: an explicit address wins
// (read-only use), otherwise the fixture account is derived.
export async function resolveAccountAddress(input, env = process.env) {
  const raw = input.node?.account;
  if (typeof raw === 'string' && /^0x[0-9a-fA-F]{40}$/u.test(raw.trim())) {
    return { name: null, address: raw.trim() };
  }
  const projectRoot = input.context?.projectRoot;
  const browserState = projectRoot ? await readBrowserState(projectRoot) : null;
  const name = accountName(input, browserState);
  const account = await fixtureAccount(projectRoot, name, env);
  return { name, address: account.address };
}
