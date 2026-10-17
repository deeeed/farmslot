import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { assertMonitoredPRIdentity, type PRSourceAccount } from '@farmslot/protocol';

import { ghRequest, type GhRequestOpts } from '../integrations/github-client.js';
import { principalOwnerGeneration } from '../security/work-originator.js';

const execFileAsync = promisify(execFile);

/** Resolve the named keyring account without changing gh's globally active account. */
export async function resolvePRSourceAccount(
  account: PRSourceAccount,
  ownerId: string,
): Promise<NonNullable<GhRequestOpts['account']>> {
  return (await resolveAccount(ownerId, account)).binding;
}

/** Freeze the slot poster's existing default gh credential without switching accounts. */
export function resolveDefaultPublicationAccount(ownerId: string) {
  return resolveAccount(ownerId);
}

async function resolveAccount(ownerId: string, account?: PRSourceAccount) {
  if (account) {
    account = { ...account, host: account.host.toLowerCase(), login: account.login.toLowerCase() };
    assertMonitoredPRIdentity({ host: account.host, repo: 'validation/validation', number: 1 });
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(account.login))
      throw new Error('Invalid GitHub account login');
  }
  const host = account?.host ?? 'github.com';
  const signal = account ? undefined : AbortSignal.timeout(5000);
  const env = { ...process.env };
  delete env.GH_TOKEN;
  if (account) {
    delete env.GITHUB_TOKEN;
    delete env.GH_ENTERPRISE_TOKEN;
    delete env.GITHUB_ENTERPRISE_TOKEN;
  }
  let token: string;
  try {
    const result = await execFileAsync(
      'gh',
      ['auth', 'token', '--hostname', host, ...(account ? ['--user', account.login] : [])],
      { env, timeout: 15_000, maxBuffer: 64 * 1024, signal },
    );
    token = result.stdout.trim();
  } catch {
    // Child errors can contain credential output. Return a fixed actionable error instead.
    throw new Error(
      `GitHub account ${account?.login ?? 'default'}@${host} is unavailable in the gateway keyring`,
    );
  }
  if (!token) throw new Error('GitHub account has no credential');
  const binding = {
    host,
    token,
    scope: JSON.stringify([
      ownerId,
      principalOwnerGeneration(ownerId),
      account?.login ?? 'default-publication',
    ]),
  };
  const { stdout } = await ghRequest(['api', '--hostname', host, 'user'], {
    account: binding,
    force: account !== undefined,
    signal,
  });
  const identity: unknown = JSON.parse(stdout);
  if (
    !identity ||
    typeof identity !== 'object' ||
    !('login' in identity) ||
    typeof identity.login !== 'string' ||
    !/^[a-z0-9][a-z0-9-]*$/i.test(identity.login) ||
    (account && identity.login.toLowerCase() !== account.login.toLowerCase())
  ) {
    throw new Error('GitHub credential does not match the selected account');
  }
  return { binding, account: { host, login: identity.login.toLowerCase() } };
}

/** Account references can be edited offline; a new binding must resolve to a real gateway credential. */
export async function verifyPRSourceAccountChange(
  account: PRSourceAccount,
  ownerId: string,
  previous?: PRSourceAccount,
): Promise<void> {
  if (
    previous &&
    previous.host.toLowerCase() === account.host.toLowerCase() &&
    previous.login.toLowerCase() === account.login.toLowerCase()
  )
    return;
  await resolvePRSourceAccount(account, ownerId);
}
