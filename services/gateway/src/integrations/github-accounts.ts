import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  assertPRSourceAccount,
  type ConfigGitHubAccountsResult,
  Methods,
} from '@farmslot/protocol';

import {
  GitHubAccountObservation,
  type GitHubAccountsReadInterest,
} from '../resources/github-account-observation.js';
import { resourceRevisions } from '../resources/revisions.js';

const execFileAsync = promisify(execFile);
let hasVisibleInterest = () => false;
let activeObservation: object | undefined;
const observation = new GitHubAccountObservation({
  sample: sampleGitHubAccounts,
  hasInterest: () => hasVisibleInterest(),
  changed: () =>
    resourceRevisions.advance({
      family: 'upstream',
      integration: 'github',
      queryId: `${Methods.CONFIG_GITHUB_ACCOUNTS}:{}`,
    }),
});

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
        // assertPRSourceAccount throws Error for malformed host/login data.
        // Skip that identity so independently valid accounts remain usable.
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

async function sampleGitHubAccounts(): Promise<ConfigGitHubAccountsResult> {
  const env = { ...process.env };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'])
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
  return value;
}

/** Legacy reads keep their TTL; managed observers share source work without renewing it. */
export function gatewayGitHubAccounts(
  refresh = false,
  interest?: GitHubAccountsReadInterest,
): Promise<ConfigGitHubAccountsResult> {
  return observation.read(refresh, interest);
}

export function forgetGitHubAccountsClientInterest(clientId: string): void {
  observation.forget(clientId);
}

export function wakeGitHubAccountsObservation(): Promise<void> {
  return observation.tick();
}

export function startGitHubAccountsObservation(options: {
  hasInterest(): boolean;
}): () => Promise<void> {
  if (activeObservation) throw new Error('GitHub account observation is already running');
  const owner = {};
  activeObservation = owner;
  hasVisibleInterest = options.hasInterest;
  observation.start();
  const timer = setInterval(() => void observation.tick(), 60_000);
  timer.unref();
  return async () => {
    if (activeObservation !== owner) return;
    clearInterval(timer);
    hasVisibleInterest = () => false;
    await observation.stop();
    if (activeObservation === owner) activeObservation = undefined;
  };
}
