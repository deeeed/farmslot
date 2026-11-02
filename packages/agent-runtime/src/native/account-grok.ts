import { accountObject, accountString, observeAcpAccount } from './account-common.js';
import type { NativeAccountProbeOptions, NativeAccountState } from './account-types.js';
import { grokAuthMethod } from './grok.js';

export function grokAccountState(value: unknown): NativeAccountState {
  const result = accountObject(value);
  const meta = accountObject(result._meta);
  const email = accountString(meta.email);
  const organizationId = accountString(meta.team_id);
  // Native authenticate succeeded. Current cached-token response has no stable subject ID.
  const mode =
    meta.auth_mode === 'Oidc' ? 'subscription' : meta.auth_mode === 'ApiKey' ? 'api' : 'unknown';
  return {
    login: 'authenticated',
    mode,
    ...(email || organizationId
      ? { identity: { ...(email ? { email } : {}), ...(organizationId ? { organizationId } : {}) } }
      : {}),
    identityQuality: email ? 'display-only' : 'unavailable',
  };
}
export function observeGrokAccount(options: NativeAccountProbeOptions) {
  return observeAcpAccount('grok', 'grok', options, {
    args: ['--no-auto-update', 'agent', '--no-leader', 'stdio'],
    authMethod: grokAuthMethod,
    state: grokAccountState,
  });
}
