import { assertMonitoredPRIdentity, type PRSourceAccount } from '@farmslot/protocol';

import { type GhRequestOpts, github } from '../integrations/github-client.js';
import { resolveGitHubToken } from '../integrations/github-transport.js';
import { principalOwnerGeneration } from '../security/work-originator.js';

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
  // Read from the keyring once per host/account; a 401 drops the cached token.
  const token = await resolveGitHubToken(host, account?.login);
  const binding = {
    host,
    token,
    scope: JSON.stringify([
      ownerId,
      principalOwnerGeneration(ownerId),
      account?.login ?? 'default-publication',
    ]),
  };
  const identity = await github.rest<unknown>('GET', 'user', {
    host,
    account: binding,
    force: account !== undefined,
    signal,
  });
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
