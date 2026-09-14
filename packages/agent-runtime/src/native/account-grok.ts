import {
  accountObject,
  AccountProbeError,
  accountProtocolProbe,
  accountString,
  observeNativeAccount,
  unavailableAccount,
} from './account-common.js';
import type { NativeAccountProbeOptions, NativeAccountState } from './account-types.js';
import { AcpRpc } from './acp-rpc.js';

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
  return observeNativeAccount('grok', 'grok', options, async (context) => {
    let exited = false;
    let cleanupConfirmed = false;
    const child = new AcpRpc(
      context,
      ['--no-auto-update', 'agent', '--no-leader', 'stdio'],
      (message) => {
        if (message.id !== undefined && message.method)
          child.write({
            id: message.id,
            error: {
              code: -32601,
              message: 'Account observation does not implement client operations',
            },
          });
      },
      (_error, stopped) => {
        exited = true;
        cleanupConfirmed = stopped;
      },
    );
    return accountProtocolProbe(
      child,
      async () => {
        const init = accountObject(
          await child.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: 'farmslot-account-status', version: '1' },
          }),
        );
        if (init.protocolVersion !== 1) throw new AccountProbeError('malformed-status');
        if (
          !Array.isArray(init.authMethods) ||
          !init.authMethods.map(accountObject).some((method) => method.id === 'cached_token')
        )
          return { ...unavailableAccount(), reason: 'native-auth-unavailable' };
        // Never select grok.com interactive login or an API-key fallback during observation.
        return grokAccountState(
          await child.request('authenticate', {
            methodId: 'cached_token',
            _meta: { headless: true },
          }),
        );
      },
      () => exited && cleanupConfirmed,
    );
  });
}
