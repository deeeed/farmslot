import type { RunnerAccountInventory, RunnerProviderAccount } from '@farmslot/protocol';

import type { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { withMachineEnv } from '../core/project-env.js';
import { shellExpressionForRemotePath } from '../core/remote-paths.js';
import { shellQuote } from '../core/tmux.js';

export interface CredentialStoreSpec {
  binary: string;
  directoryEnv: string;
  defaultDirectory: string[];
  suffix: string[];
  contentEnv?: string;
  apiKeyType: string;
}

/** Executed on the owning node: only allowlisted metadata crosses the wire. */
export const INVENTORY_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const spec = JSON.parse(process.argv[1]);
const binary = process.argv[2];
const result = {status: 'available', scope: 'host-default', accounts: []};
const output = () => console.log(JSON.stringify(result));
const candidates = binary.includes('/') ? [binary] : (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, binary));
const installed = candidates.some(file => {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); }
  catch (error) { if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) return false; throw error; }
});
if (!installed) { result.status = 'unavailable'; result.error = 'Runner executable unavailable'; output(); process.exit(0); }
const directory = process.env[spec.directoryEnv] || path.join(os.homedir(), ...spec.defaultDirectory);
let data;
try {
  const content = spec.contentEnv && process.env[spec.contentEnv];
  data = JSON.parse(content || fs.readFileSync(path.join(directory, ...spec.suffix, 'auth.json'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') { result.status = 'unavailable'; result.error = 'Credential inventory unreadable'; }
  output(); process.exit(0);
}
if (!data || typeof data !== 'object' || Array.isArray(data)) {
  result.status = 'unavailable'; result.error = 'Invalid credential inventory'; output(); process.exit(0);
}
for (const [provider, value] of Object.entries(data)) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(provider)) continue;
  const type = value && typeof value === 'object' ? value.type : null;
  const authType = type === 'oauth' ? 'oauth' : type === spec.apiKeyType ? 'api_key' : 'unknown';
  result.accounts.push({id: provider, provider, authType, status: authType === 'unknown' ? 'unknown' : 'configured', source: 'credential-store'});
}
result.accounts.sort((a, b) => a.id.localeCompare(b.id));
output();
`;

export async function probeCredentialStore(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  spec: CredentialStoreSpec,
): Promise<RunnerAccountInventory> {
  try {
    const command = `node -e ${shellQuote(INVENTORY_SCRIPT)} ${shellQuote(JSON.stringify(spec))} ${shellExpressionForRemotePath(spec.binary)}`;
    const result = await execOnSlot(vars, withMachineEnv(command, vars), {
      cwd: '/',
      timeout: 10000,
    });
    if (result.exitCode !== 0) throw new Error('Inventory probe failed');
    return JSON.parse(result.stdout) as RunnerAccountInventory;
  } catch {
    // Optional status failure remains visible; never include raw credential
    // parser errors, runner output or transport errors in the public snapshot.
    return {
      status: 'unavailable',
      scope: 'host-default',
      accounts: [],
      error: 'Account inventory unavailable',
    };
  }
}

export function parsePiAuthCheck(
  raw: string,
  account: RunnerProviderAccount,
): RunnerProviderAccount {
  const row: unknown = JSON.parse(raw);
  if (
    !row ||
    typeof row !== 'object' ||
    !('provider' in row) ||
    row.provider !== account.provider ||
    !('status' in row) ||
    !['ready', 'not_ready', 'invalid'].includes(String(row.status))
  )
    throw new Error('Invalid Pi auth check');
  const authType = 'authType' in row ? row.authType : undefined;
  if (row.status === 'ready' && authType !== 'oauth' && authType !== 'api_key')
    throw new Error('Invalid Pi auth type');
  return {
    ...account,
    status: row.status as RunnerProviderAccount['status'],
    authType: authType === 'oauth' || authType === 'api_key' ? authType : account.authType,
    source: 'native-status',
  };
}

export async function probePiAccounts(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
): Promise<RunnerAccountInventory> {
  const binary = vars.piPath?.trim() || 'pi';
  const inventory = await probeCredentialStore(vars, {
    binary,
    directoryEnv: 'PI_CODING_AGENT_DIR',
    defaultDirectory: ['.pi', 'agent'],
    suffix: [],
    apiKeyType: 'api_key',
  });
  inventory.accounts = await Promise.all(
    inventory.accounts.map(async (account) => {
      try {
        const command = `${shellExpressionForRemotePath(binary)} auth check --provider ${shellQuote(account.provider)} --json --no-refresh </dev/null`;
        const result = await execOnSlot(vars, withMachineEnv(command, vars), {
          cwd: '/',
          timeout: 10000,
        });
        if (![0, 1].includes(result.exitCode)) throw new Error('Pi auth check unavailable');
        return parsePiAuthCheck(result.stdout, account);
      } catch {
        // Keep the configured entry visible, but do not claim readiness on failure.
        return { ...account, status: 'unknown' as const };
      }
    }),
  );
  return inventory;
}

export function probeOpenCodeAccounts(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
): Promise<RunnerAccountInventory> {
  return probeCredentialStore(vars, {
    binary: vars.opencodePath?.trim() || 'opencode',
    directoryEnv: 'XDG_DATA_HOME',
    defaultDirectory: ['.local', 'share'],
    suffix: ['opencode'],
    contentEnv: 'OPENCODE_AUTH_CONTENT',
    apiKeyType: 'api',
  });
}
