// Resolve the web-dapp slot runtime: the venue policy, ports, runtime paths,
// browser state and wallet-fixture accounts. Key material is only ever
// returned as a viem account object; callers must never log or persist it.

import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { recipeRuntimeDir, walletFixturePath } from './paths.mjs';
import { POLICY_ENV, webDappAdapterId, webDappPolicy } from './policy.mjs';
import { defaultSigner } from './signers.mjs';
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

export function resolveSigner(raw, fallback = defaultSigner()) {
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
  return checkedEntry(entry);
}

function checkedEntry(entry) {
  if (entry.type !== 'mnemonic' && entry.type !== 'privateKey') {
    throw new Error(
      `wallet fixture account "${entry.name}" must be mnemonic or privateKey, got "${entry.type}".`,
    );
  }
  if (typeof entry.value !== 'string' || !entry.value.trim()) {
    throw new Error(`wallet fixture account "${entry.name}" has no value.`);
  }
  return entry;
}

// Mnemonics use BIP-44 m/44'/60'/0'/0/<addressIndex>, the MetaMask derivation
// the Extension fixture flow imports; index 0 is the wallet's first account.
export function viemAccountFromEntry(entry, projectRoot, addressIndex = 0) {
  const { mnemonicToAccount, privateKeyToAccount } = loadViemAccounts(projectRoot);
  if (entry.type === 'mnemonic') return mnemonicToAccount(entry.value.trim(), { addressIndex });
  const raw = entry.value.trim();
  const key = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/u.test(key)) {
    throw new Error(`wallet fixture privateKey account "${entry.name}" is not a 32-byte hex key.`);
  }
  return privateKeyToAccount(key);
}

// Named HD derivations of the fixture's mnemonic entries that the host adds,
// e.g. a team's shared test account at a higher index: JSON
// [{ "name", "secret": <mnemonic entry name>, "index", "address"? }]. Names and
// indexes only; the key stays in the fixture.
export const DERIVED_ACCOUNTS_ENV = 'RECIPE_WALLET_DERIVED_ACCOUNTS';

export function derivedAccounts(env = process.env) {
  const raw = env[DERIVED_ACCOUNTS_ENV];
  if (!raw) return [];
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${DERIVED_ACCOUNTS_ENV} is not JSON: ${error.message}`);
  }
  const valid = (item) =>
    item &&
    typeof item.name === 'string' &&
    item.name.trim() &&
    typeof item.secret === 'string' &&
    item.secret.trim() &&
    Number.isInteger(item.index) &&
    item.index >= 0 &&
    (item.address === undefined || /^0x[0-9a-fA-F]{40}$/u.test(item.address));
  if (!Array.isArray(value) || !value.every(valid)) {
    throw new Error(
      `${DERIVED_ACCOUNTS_ENV} must be an array of { name, secret, index, address? } (index a non-negative integer).`,
    );
  }
  return value;
}

function mnemonicCount(entry) {
  const count = Number(entry.count ?? entry.numberOfAccounts ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error(
      `wallet fixture account "${entry.name}" count must be an integer from 1 through 100.`,
    );
  }
  return count;
}

// names[index] when the entry gives one; a single account keeps the entry's
// name; otherwise dev1 with count 3 is dev1, dev2, dev3 (a name without a
// trailing number gets one appended).
function derivedName(entry, index, count) {
  const explicit = Array.isArray(entry.names) ? entry.names[index] : undefined;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  if (count === 1) return entry.name;
  const match = /^(.*?)(\d+)$/u.exec(entry.name);
  return match ? `${match[1]}${Number(match[2]) + index}` : `${entry.name}${index + 1}`;
}

/**
 * Every account the fixture offers: each mnemonic entry expanded to its count,
 * each private key, then the host's named derivations (DERIVED_ACCOUNTS_ENV)
 * of the secrets this fixture holds. `account` is the viem account holding the
 * key: sign with it, never log or persist it.
 */
export function walletAccounts(fixture, projectRoot, env = process.env) {
  const accounts = [];
  for (const entry of fixture.accounts) {
    if (entry?.type !== 'mnemonic' && entry?.type !== 'privateKey') continue;
    checkedEntry(entry);
    const count = entry.type === 'mnemonic' ? mnemonicCount(entry) : 1;
    for (let index = 0; index < count; index += 1) {
      const account = viemAccountFromEntry(entry, projectRoot, index);
      accounts.push({
        name: derivedName(entry, index, count),
        address: account.address,
        secret: entry.name,
        index,
        account,
      });
    }
  }
  for (const item of derivedAccounts(env)) {
    const entry = fixture.accounts.find(
      (candidate) => candidate?.type === 'mnemonic' && candidate.name === item.secret,
    );
    if (!entry) continue;
    const account = viemAccountFromEntry(checkedEntry(entry), projectRoot, item.index);
    if (item.address && item.address.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error(
        `wallet account "${item.name}" derives to ${account.address} from "${item.secret}" index ${item.index}, not the declared ${item.address}.`,
      );
    }
    // An index the fixture already lists is the same account: the host's name wins there.
    const listed = accounts.find(
      (candidate) => candidate.secret === item.secret && candidate.index === item.index,
    );
    if (listed) {
      listed.name = item.name;
      continue;
    }
    accounts.push({
      name: item.name,
      address: account.address,
      secret: item.secret,
      index: item.index,
      account,
    });
  }
  const byName = new Map();
  for (const account of accounts) {
    const other = byName.get(account.name);
    if (other) {
      throw new Error(
        `wallet fixture has two accounts named "${account.name}": "${other.secret}" index ${other.index} and "${account.secret}" index ${account.index}; rename one.`,
      );
    }
    byName.set(account.name, account);
  }
  return accounts;
}

// The fixture account a selector names: an account name, else an address.
export function walletAccount(fixture, selector, projectRoot, env = process.env) {
  const accounts = walletAccounts(fixture, projectRoot, env);
  const wanted = String(selector ?? '').trim();
  const found =
    accounts.find((account) => account.name === wanted) ??
    (/^0x[0-9a-fA-F]{40}$/u.test(wanted)
      ? accounts.find((account) => account.address.toLowerCase() === wanted.toLowerCase())
      : undefined);
  if (!found) {
    const names = accounts.map((account) => account.name).join(', ');
    throw new Error(`wallet fixture has no account named "${wanted}". Available: ${names}.`);
  }
  return found;
}

export async function fixtureAccount(projectRoot, name, env = process.env) {
  const { fixture } = await loadWalletFixture(projectRoot, env);
  return walletAccount(fixture, name, projectRoot, env).account;
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
