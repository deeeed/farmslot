import {
  accountObject,
  AccountProbeError,
  accountProtocolProbe,
  observeNativeAccount,
  unavailableAccount,
} from './account-common.js';
import type { NativeAccountProbeOptions } from './account-types.js';
import { AcpRpc } from './acp-rpc.js';

/** OpenCode keeps its logins and sessions under `$XDG_DATA_HOME/opencode`. */
export const opencodeProfileEnvironment = (directory: string): Record<string, string> => ({
  XDG_DATA_HOME: directory,
});

/**
 * OpenCode signs in per provider and has no account status command. Its ACP login succeeds
 * whenever OpenCode can serve a model, and its own free models need no sign-in.
 */
export function observeOpenCodeAccount(options: NativeAccountProbeOptions) {
  return observeNativeAccount('opencode', 'opencode', options, async (context) => {
    let exited = false;
    let cleanupConfirmed = false;
    const child = new AcpRpc(
      { ...context, env: { ...context.env, OPENCODE_DISABLE_AUTOUPDATE: '1' } },
      ['acp'],
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
          !init.authMethods.map(accountObject).some((method) => method.id === 'opencode-login')
        )
          return { ...unavailableAccount(), reason: 'native-auth-unavailable' };
        await child.request('authenticate', {
          methodId: 'opencode-login',
          _meta: { headless: true },
        });
        return { login: 'authenticated', mode: 'unknown', identityQuality: 'unavailable' };
      },
      () => exited && cleanupConfirmed,
    );
  });
}
