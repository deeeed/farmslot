import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { assertPRSourceAccount, type ConfigGitHubAccountsResult } from '@farmslot/protocol';

const execFileAsync = promisify(execFile);
const CACHE_MS = 5 * 60_000;
let cached: { value: ConfigGitHubAccountsResult; expiresAt: number } | undefined;
let pending: Promise<ConfigGitHubAccountsResult> | undefined;
let queuedRefresh: Promise<ConfigGitHubAccountsResult> | undefined;

/** Project only verified identity metadata. Never forward gh's token/error fields. */
export function parseGitHubAccounts(value: unknown): ConfigGitHubAccountsResult['accounts'] {
  if (
    !value ||
    typeof value !== 'object' ||
    !('hosts' in value) ||
    !value.hosts ||
    typeof value.hosts !== 'object' ||
    Array.isArray(value.hosts)
  )
    throw new Error('Invalid GitHub account inventory');
  const accounts: ConfigGitHubAccountsResult['accounts'] = [];
  for (const [host, entries] of Object.entries(value.hosts)) {
    if (!Array.isArray(entries)) throw new Error('Invalid GitHub account inventory');
    for (const entry of entries) {
      if (entry?.state !== 'success') continue;
      const account = { host: host.toLowerCase(), login: entry.login };
      try {
        assertPRSourceAccount(account);
      } catch {
        // A malformed CLI identity cannot be selected; independently valid accounts remain usable.
        continue;
      }
      if (
        !accounts.some(
          (item) =>
            item.host === account.host && item.login.toLowerCase() === account.login.toLowerCase(),
        )
      )
        accounts.push({ ...account, active: entry.active === true });
    }
  }
  return accounts;
}

/** gh verifies stored credentials once per cache period, not on each form edit. */
export function gatewayGitHubAccounts(refresh = false): Promise<ConfigGitHubAccountsResult> {
  if (pending) {
    if (!refresh) return pending;
    queuedRefresh ??= pending
      .then(() => gatewayGitHubAccounts(true))
      .finally(() => {
        queuedRefresh = undefined;
      });
    return queuedRefresh;
  }
  if (!refresh && cached && Date.now() < cached.expiresAt)
    return Promise.resolve(structuredClone(cached.value));
  pending = (async () => {
    const env = { ...process.env };
    for (const key of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GH_ENTERPRISE_TOKEN',
      'GITHUB_ENTERPRISE_TOKEN',
    ])
      delete env[key];
    let value: ConfigGitHubAccountsResult;
    try {
      const { stdout } = await execFileAsync('gh', ['auth', 'status', '--json', 'hosts'], {
        env,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      value = {
        accounts: parseGitHubAccounts(JSON.parse(stdout)),
        checkedAt: new Date().toISOString(),
      };
    } catch {
      // Process errors may contain token output. Surface an actionable fixed error instead.
      value = {
        accounts: [],
        checkedAt: new Date().toISOString(),
        error:
          'Cannot verify gateway GitHub accounts. Run gh auth status on the gateway machine, then refresh accounts.',
      };
    }
    cached = { value, expiresAt: Date.now() + CACHE_MS };
    return structuredClone(value);
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}
