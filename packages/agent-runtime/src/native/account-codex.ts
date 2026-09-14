import {
  accountObject,
  accountProtocolProbe,
  accountString,
  observeNativeAccount,
  signedOutAccount,
  unavailableAccount,
} from './account-common.js';
import type { NativeAccountProbeOptions, NativeAccountState } from './account-types.js';
import { JsonLineProcess } from './process.js';

export function codexAccountState(value: unknown): NativeAccountState {
  const result = accountObject(value);
  if (result.account === null)
    return result.requiresOpenaiAuth === true
      ? signedOutAccount()
      : { ...unavailableAccount(), reason: 'native-auth-unavailable' };
  const account = accountObject(result.account);
  if (account.type === 'apiKey')
    return { login: 'authenticated', mode: 'api', identityQuality: 'unavailable' };
  if (account.type === 'amazonBedrock')
    return { login: 'authenticated', mode: 'other', identityQuality: 'unavailable' };
  if (account.type !== 'chatgpt') return { ...unavailableAccount(), reason: 'malformed-status' };
  const email = accountString(account.email);
  return {
    login: 'authenticated',
    mode: 'subscription',
    ...(email ? { identity: { email } } : {}),
    identityQuality: email ? 'display-only' : 'unavailable',
  };
}
export function observeCodexAccount(options: NativeAccountProbeOptions) {
  return observeNativeAccount('codex', 'codex', options, async (context) => {
    let exited = false;
    let cleanupConfirmed = false;
    const child = new JsonLineProcess(
      context.executable,
      ['app-server'],
      context,
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
        await child.request('initialize', {
          clientInfo: { name: 'farmslot-account-status', version: '1' },
          capabilities: { experimentalApi: true },
        });
        child.write({ method: 'initialized', params: {} });
        return codexAccountState(await child.request('account/read', { refreshToken: false }));
      },
      () => exited && cleanupConfirmed,
    );
  });
}
